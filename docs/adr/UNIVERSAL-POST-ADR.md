# ADR: Universal Post model, feed assembly, and full-view rendering

**Status:** Proposed
**Supersedes:** the node-identity and thread-rendering portions of `UNIVERSAL-FEED-ADR.md` and `CARD-BEHAVIOUR-ADR`; the chronological-only following feed and the HN-gravity score (§5); consolidates the workspace full-view spec.
**Ships:** the constructed external-author profile (CARD-BEHAVIOUR-ADR §VI.3), previously deferred — see §4.4 — **scoped to tiers with a stable author handle (A/B)**; tier-C RSS/email authors stay plain text until a reliable identity key exists. **This flips the CLAUDE.md byline-routing rule** for tier A/B external bylines (they gain an internal profile surface).
**Scope:** ingestion identity, feed assembly + ordering, the single thread engine, and the full-view card rendering matrix.

---

## 0. Resolved decisions

Decisions taken to make this plan spade-ready. Each is expanded in the section noted; recorded here so an implementer needs no out-of-band context.

1. **PostId home (§2.3, Phase 0a).** The canonical `PostId` is a **deterministic column on `feed_items`** (migration 053's denormalised timeline table), derived from `(protocol, stableOriginHandle)` at dual-write — *not* the existing random `feed_items.id`, a new identity table, or a column on each source table. Source tables are untouched; `RepostEdge.targetPostId`, `inReplyTo`, and `quotes` all resolve at `feed_items`. Cross-source dedup for external content already collapses to one row upstream via `UNIQUE(protocol, source_item_uri)` on `external_items`, so one row per external THING already exists for the column to key off.
2. **Repost ingestion is greenfield (§5, Phase 0c).** Every adapter writes `is_repost = false` today — detection was never built. Phase 0c is therefore **build repost/boost detection per-adapter** (nostr kind-6/16, atproto reposts, activitypub `Announce`; RSS has none) **plus** the edge table, not "promote existing reposts." §5 ordering only has input data once this lands.
3. **One addressable reader environment (§3.1, Phase R).** Today native articles render at a route page (`/article/[dTag]`, addressable) while external articles open an ephemeral, non-addressable modal (`ReaderPane.tsx`). These unify into a **single overlay backed by a real URL** (shallow/intercepting route), so feed-overlay and direct-URL land in one addressable environment. This is its own migration phase (Phase R).
4. **External-author profile scoped to stable handles (§4.4, Phase 0b).** VI.3 ships, but `author.id` is minted **only for tiers with a stable handle (A/B)** — nostr pubkey, atproto DID, activitypub actor URI. Tier-C RSS/email (null/inconsistent `author_uri`) stays plain text until a reliable key exists; tier D has none by definition.
5. **Assembly window = the pagination page (§5).** Dedup-to-one fires **within each feed page as it is assembled** (per cursor fetch) — stateless, no tuned time constant. A THING re-boosted after the viewer has paged past it legitimately reappears lower; that is the §5 "surfaces twice" behaviour, not a bug.

---

## 1. Context

The workspace feed currently carries the same underlying object — a post — in four incompatible shapes, each with its own id space: `WorkspaceFeedApiItem` (`feedItemId`), `ConversationNode` (nostr `eventId`), `ExternalThreadEntry` (source-platform id), and `ParentItem`. Threads are served by **three** mechanisms (`useConversation`, `useExternalThread`, `useNeighbourhood`) that behave differently, each with its own fetch/cache/re-root semantics. The native conversation read (`/conversation`) returns *reduced* nodes (author + content only — no media, quote, or counts), so native parents/replies cannot render as full cards; the external read carries counts but diverges from the native shape entirely. Two id-spaces and three divergent mechanisms are why re-root, freshness, and "fully-featured parent/reply" don't reconcile.

**Decision in one line:** there is exactly one node type — a **Post** (the THING). Every surface renders a Post at a *level*. Relationships are *edges* between Posts. One stable identity per THING, minted at ingestion.

---

## 2. The Post model

### 2.1 Governing principle

**Mint identity eagerly, bind value lazily.** A canonical id is minted for every Post (and every author) at ingestion, so everything is addressable immediately. The richer bindings — the all.haus reaction scoresheet, the link to an all.haus account — are created/filled on first use.

### 2.2 Types

```ts
type PostId = string;   // opaque, internal, minted at INGESTION. Never an origin string.

interface Post {
  id: PostId;                  // stable across versions (identity, not scoresheet)
  version: string;             // the specific publishing event; new version supplants under same id

  origin: {
    protocol: "nostr" | "atproto" | "activitypub" | "rss" | "email";
    uri: string;               // canonical permalink / at:// / status id — the per-protocol stable handle
    sourceName: string | null; // origin-site name shown in the tag
  };

  author: {
    id: string | null;         // identity handle record (DID/pubkey/acct). Non-null for native + tier A/B; NULL for tier C/D (no stable handle ⇒ no profile, plain-text byline). See §0.4 / §4.4.
    accountId: string | null;  // lazy: links to a real all.haus account if/when claimed
    displayName: string | null;
    handle: string | null;     // handle on origin
    handleUri: string | null;  // link to profile on origin
    avatar: string | null;
    pubkey: string | null;     // native only
    pipStatus: PipStatus;      // trust pip (display only; see §9 for trust-weighting deferral)
  };

  type: "article" | "note";    // discriminator: articles route to the reader pane (§3), notes expand inline
  accessMode: "free" | "gated" | "unlocked"; // gated articles open locked in the reader pane; unlock economics stay in the gate-pass service (§3.1)

  body: {                      // the body individuates a THING; no body ⇒ not a Post (it's a repost edge)
    text: string | null;
    html: string | null;
    title: string | null;      // articles
    summary: string | null;
    media: MediaItem[];
    contentWarning: string | null;
    poll: Poll | null;
  };

  inReplyTo: PostId | null;     // content relationships are pointers to other Posts
  quotes: PostId | null;       // render depth-1; deeper quotes become a stub link

  originCounts: { like: number; reply: number; repost: number } | null; // EXTERNAL only; null for native (see §6)
  scoresheet: { up: number; down: number; reposts: number };            // row from ingestion, filled on first reaction

  biddabilityTier: "A" | "B" | "C" | "D";  // capability gate; see §7. Persisted on the Post (today it is render-time-derived; Phase 0a persists it)
  publishedAt: number;

  isContextOnly: boolean;       // hydrated for thread context only; never surfaces as a feed card
  isDeleted: boolean;           // render a tombstone in threads; never a card
  isMuted: boolean;             // viewer-muted author; collapsed by default
}

// Bare reposts have no body, so they are NOT Posts. They are edges, grouped by target.
interface RepostEdge {
  targetPostId: PostId;
  actorId: string;
  trustWeight: number;   // bracketed: hard-coded 1 until the trust graph lands (§9)
  timestamp: number;     // drives recency + re-float; never the original's publish time
  originUri: string | null; // the boost object's own origin id — kept HERE, never minted as a node
}
```

### 2.3 Identity derivation

`id` is opaque and internal. The **dedup key** is `(protocol, stableOriginHandle)`, deterministic so the same origin THING always maps to the same `PostId` — this is what makes dedup-to-one (§5) fire regardless of who surfaced it. **Physically, `PostId` is a deterministic column on `feed_items`** (resolved decision §0.1), derived from the dedup key at dual-write — not the existing random `feed_items.id`. `inReplyTo`, `quotes`, and `RepostEdge.targetPostId` all resolve there.

| protocol | stableOriginHandle | version |
|---|---|---|
| nostr (replaceable, e.g. articles) | `naddr` address `(pubkey, kind, d-tag)` | the event id |
| nostr (kind-1 note, immutable) | event id | = id (no edits) |
| atproto | AT-URI `at://did/coll/rkey` | record CID, else computed hash |
| activitypub | object URI | `updated` ts, else computed hash |
| rss / atom | `<guid>` / `<id>`, else canonical link | **computed content hash** |
| email | `Message-ID` | = id (no edits) |

**Version is an edit detector, nothing more.** Same `id` + different `version` ⇒ edit ⇒ supplant. Same `id` + same `version` ⇒ idempotent re-ingest ⇒ no-op. Where the protocol hands us a content-addressed token (nostr event id, atproto CID) we use it; where it does not (RSS reliably gives nothing), we compute a **canonical content hash** (§2.4). The protocol's *operation* token (the nostr event id needed to like/reply/delete) lives in `author.pubkey`/native fields, **not** in `version` — never conflate the two.

### 2.4 Content-hash canonicalisation

To detect an edit we fingerprint the post's *content*. The fingerprint must be stable: identical content must always produce an identical hash, and incidental noise (the fetch timestamp, the origin's HTML wrapper, tracking params, live counts) must not change it. Recipe:

1. Take `body.text` (prefer text; if only HTML, sanitise to text first).
2. Normalise: strip leading/trailing whitespace, normalise line endings to `\n`, strip trailing spaces per line. Do **not** collapse internal structure.
3. Assemble a canonical object with stable key order: `{ text, title, mediaUris: media.map(m => m.uri), pollOptions }`.
4. `version = sha256(JSON.stringify(canonical))`.

Excluded from the hash: fetch time, origin counts, served wrapper markup, source-injected query params.

---

## 3. Rendering: levels

A Post is rendered at exactly one **level**. The level governs *size, indent, gap, and affordance set* — never which fields exist. Every Post always carries everything; the level decides what shows.

`level = focal | feed | thread-parent | thread-reply | quoted | condensed`

### 3.1 Articles are the principled exception to inline focal

Notes and external posts expand to an inline **focal** card in place (§4.1). **Articles do not.** A `type === "article"` Post has no inline focal level: clicking it opens the **reader pane** — a reading environment that overlays the workspace — and that pane is **addressable at the article's own URL** (deep-linkable, shareable, openable in a new tab). One canonical reading environment, two ways in (overlay from the feed, direct URL from elsewhere).

**This unifies two environments that exist separately today** (resolved decision §0.3): native articles currently render at a route page (`/article/[dTag]`, already addressable) while external articles open an ephemeral, non-addressable modal (`web/src/components/workspace/ReaderPane.tsx`). Both collapse into a single overlay **backed by a real URL** (a shallow/intercepting route), so the overlay-from-feed and direct-URL paths share one addressable surface for native and external alike. Delivered as **Phase R** in the migration sequence (§10).

Consequently:

- In `feed | thread-parent | thread-reply | quoted | condensed`, an article renders as a **card/preview** exactly like any other Post (title + summary + the matrix-permitted affordances). Its **click action is "open reader pane," not "expand → focal"** — this overrides the `expand → focal` cell in §4 for articles.
- **Gating lives in the reader pane, not the Post.** `accessMode` is a display discriminator only: it tells the card which CTA to show (`Read` vs `Unlock for £X`) and tells the pane to render the locked below-the-gate state. The actual unlock economics stay in the existing gate-pass service (`gateway/src/services/article-access/`) and `POST /articles/:id/gate-pass`. The Post model carries **no payment logic and no locked body** — a gated article never renders its protected content in a card, so there is nothing to leak.
- Notes/external keep the §4.1 inline expand-to-focal behaviour unchanged.

---

## 4. The capability matrix (the centrepiece)

Affordance columns are subject to the biddability gate in §7 (e.g. "origin counters" only shows where the tier permits). The matrix below is the *maximum* per level; §7 subtracts.

| | focal | feed | thread-parent | thread-reply | quoted | condensed |
|---|---|---|---|---|---|---|
| **text size** | base (100%) | 100% | 90% | 90% | 85% | 85% |
| **indent** | 0 | 0 | +1 step | +1 step | inside host | 0 |
| **gap below** | — | feed gap | tight | tight | — | tight |
| **byline + pip** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **origin tag** (handle@site → origin) | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| **body text** | full | full | full | full | full | 1 line, truncated |
| **media** | full-width, proportionate | sized, unexpanded | sized, unexpanded | sized, unexpanded | single thumbnail | none |
| **video** | autoplay muted + unmute | no autoplay | no autoplay | no autoplay | none | none |
| **all.haus actions** (vote/repost/save) | ✓ | ✓ | ✓ | ✓ | ✗ | numerals only |
| **report** (native only) | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| **origin counters** (like/reply/repost) | ✓ (fresh on expand) | ✗ | ✓ | ✓ | ✗ | inline numerals |
| **quote-embed** | full child card (feed-level) | quoted-level mini | quoted-level mini | quoted-level mini | ✗ → stub link | ✗ → stub link |
| **click action** | collapse | expand → focal | re-root → focal | re-root → focal | re-root → focal | expand → focal |

Notes:
- **Articles override the `click action` row.** For `type === "article"` the click action is **"open reader pane"** (§3.1), never inline `expand → focal`. Every other cell applies; only the click target differs.
- **Quoted** is deliberately minimal — **byline + body only** (text, plus one media thumbnail since that is body content). No origin tag, no actions, no counters, no nested quote. The whole card remains clickable to re-root into it.
- **Parent and reply are identical in capability**; they differ only in position (above vs below the focal) and re-root behaviour is the same.
- **condensed** is provisional — the condensed-feed mode was never fully specified. The row above is a sensible minimum (byline + one-line body + inline numerals + expand-on-click) pending its own spec.
- **Context-only / deleted / muted Posts** (the §2.2 flags) never appear as feed cards: `isContextOnly` Posts surface only inside a thread walk, `isDeleted` renders a tombstone entry in threads (never a card), and `isMuted` collapses by default with a reveal affordance.

### 4.1 Expansion behaviour (feed → focal)

- All body text becomes visible; media expands to feed width at proportionate depth.
- Embedded video autoplays **muted** with a visible unmute control.
- The quoted post promotes from quoted-level mini to a **full child card at feed-level affordances**; if *that* card itself quotes something, the inner quote is a **stub link** ("quoted a post →"), not a third level of nesting.
- Origin counters are pulled fresh on expand (external only — see §6) and rendered as live numerals.

### 4.2 Counter-click behaviour

- **like / repost count** → modal listing the actors (lazily fetched; from the local scoresheet for native, from the origin reactor endpoint for external where the protocol exposes it).
- **reply count** → scroll to the first already-expanded reply (no fetch; the replies are in the thread already).

### 4.3 Thread layout and motion

- Ancestors render above the focal, oldest-first, walking to the true root; replies below, flattened chronologically. Each on its own card, right-indented one step, tighter gaps than the feed.
- **Scroll centres the focal** on expand and on every re-root. (This replaces the current expand-time scroll-*preservation* anchor in `ExternalCard`, which only prevents jump; centring is a superset.)
- When ancestors or replies extend past the viewport, **discreet arrows appear in the indentation gutter**, persisting until the user reaches the first/last entry or changes state (re-root/collapse).
- **Re-root leaves no residue.** Clicking any parent/reply makes it the focal at full width with full affordances; the former focal demotes to parent/reply with no visual trace of its prior status. (Pure client-side re-root over the loaded thread; see §8.)

### 4.4 Byline hover modal + profile page

- **Hover** over any byline (native or external, focal/parent/reply/quoted) opens a modal with whatever bio + stats the author's origin exposes, plus buttons: add-as-source / remove-source, and follow/unfollow-on-origin (only when a linked account with interact-back exists — tier A/B).
- **Debounce + per-author cache** (plain terms): do **not** fire the bio fetch the instant the cursor touches a byline — wait until the cursor has rested ~300 ms, so sweeping the mouse across a feed of bylines doesn't trigger dozens of fetches. Once an author's bio is fetched, keep it for the session so re-hovering the same person doesn't refetch.
- **No stats available ⇒ show no stats** (RSS/email anonymous, etc.). No placeholders.
- **Click** the byline → an all.haus-generated profile page: the modal's info + affordances, plus a chronological log of that author's posts rendered as full-view cards (paginated).

**This ADR ships the constructed external-author profile (CARD-BEHAVIOUR-ADR §VI.3), previously deferred — scoped to tiers with a stable author handle (A/B)** (resolved decision §0.4). The clickable profile applies to **every author that carries an identity record** — native authors and **tier-A/B external authors alike** (nostr pubkey, atproto DID, activitypub actor URI) — not only those with a linked all.haus account. It is the explicit consumer of the external-author identity records minted in **Phase 0b** (§2.2 `author.id`): the profile log is assembled by aggregating that author's Posts across all sources that carry the same `author.id`. **Tier-C RSS/email authors are excluded** for now — their `author_uri` is null or inconsistent across items, so there is no reliable key to aggregate on; they remain plain text until one exists. Tier D (anonymous) has no author at all.

**Standing-rule change to record in CLAUDE.md.** The current byline-routing rule states that arbitrary external authors render as **plain text with no internal surface until §VI.3 ships**, and that the only route out to the origin is the source-attribution line. Because this ADR ships §VI.3 **for tier A/B**, that rule **flips for those tiers only**: tier-A/B external bylines route to a constructed internal `/author/:authorId` profile; **tier-C and tier-D bylines remain plain text** (no stable identity record to aggregate). The CLAUDE.md "Feed card chassis → Byline routing" and the CARD-BEHAVIOUR-ADR addendum byline notes must be updated when this lands.

---

## 5. Feed assembly and ordering

**What the score is *for*.** The hotness score is **not** a general engagement re-ranking of the whole feed. Its job is narrow and specific: **govern how a re-surfaced (reposted) THING is placed**, so social proof has real lift without one popular repost gumming up the feed for everything else. The feed is fundamentally **recency**; boosts are a controlled, decaying, saturating perturbation on top. The single sortable number below is just the arithmetic that merges those two regimes — direct-publish recency and bounded boost lift — into one ordering.

- **Unit = the THING.** The assembler gathers candidate edges (direct-publish surfacings + `RepostEdge`s), groups them by `targetPostId`, and emits **one card per Post per feed**. This dedup-to-one is the load-bearing anti-clutter mechanism and is independent of the score: ten boosts of one article → **one** card, never ten.
- **Dedup is per-feed, within the assembly window. The window is the pagination page** (resolved decision §0.5) — dedup-to-one fires within each page as it is assembled (per cursor fetch), statelessly, with no tuned time constant. A THING re-boosted after the viewer has paged past it falls in a later page and legitimately surfaces twice — correct, not a bug.
- **The ordering number:**
  `score = recencySeed(publishedAt | firstAppearance) + Σ_over_boosts saturate( trustWeight × timeDecay(now − edge.timestamp) )`
  - **recencySeed** is the base. A directly-published post from a followed author has **no boost terms**, so its score is purely its own recency — this *is* the chronological feed, intact, and it is why direct-follow content is never simply dropped.
  - **timeDecay** (half-life is a config knob, tuned against live traffic — §9) makes a THING "hot only while live": a new boost recomputes the score up (**re-float**); as boosts age and stop, it sinks.
  - **saturate** (diminishing returns) is the anti-clique guard: the tenth boost lifts far less than the second, so a small clique can't pin one THING to the top.
  - **trustWeight is hard-coded to 1 for now** (§9).
  - **A reposted *old* THING has no recency floor by design.** Its `recencySeed` is computed from its (ancient) `publishedAt`, so it lives or dies *entirely* on boost mass — a boost of a 3-year-old essay surfaces it now via `edge.timestamp`, and once the boosts stop it sinks immediately. Saturation + decay are the only things keeping a boosted-then-abandoned old item from lingering. This is intended: pure social proof, no recency credit.

- **Decision (placement ceiling): boosts CAN outrank fresh direct-follow content.** A sufficiently saturated boost pile may sort **above** a friend's brand-new direct post — "everyone's talking about this" can win the top slot. There is *no* hard invariant that direct content under some age always sorts first. This is a deliberate product choice favouring discovery/social-proof over a strictly chronological following feed.
  - **Knowingly-accepted consequence (state it here, not only in §11).** With `trustWeight = 1` until the trust graph lands (§9, §11), **saturation is the *only* guard** between a sockpuppet clique and the top slot — and the ceiling decision above means that guard now caps *how high* a coordinated ring floats a THING, not *whether* it can outrank your follows. Until trust weighting ships, a coordinated boost ring can land a THING above fresh direct-follow content. Saturation bounds the magnitude; it does not prevent the displacement. Revisit the ceiling when trust lands.

- **Supersession.** §5 **replaces** the current chronological-only following feed (`timeline.ts`, `ORDER BY published_at DESC` for `reach=following`) **and** the existing HN-gravity score (`feed-ingest/src/tasks/feed-scores-refresh.ts`, 48-hour window). Both are retired in favour of this model. (If the planned user-configurable *feed rules* land later, "chronological vs hotness" may become a per-user rule; that is out of scope here — this ADR sets the default behaviour.)
- **Attribution line** (the social-proof surface that drives word-of-mouth sales): most-recent booster named → "S and 2 others" → a bare count past a threshold ("boosted by 14"). At scale, the number is the proof.

---

## 6. Native vs external counts

There is no widely-broken "wild-west" problem to crowbar around: Nostr has well-adopted conventions — **NIP-25** reactions (kind 7, `+`/`-`), **NIP-18** reposts (kind 6/16, quote via `q` tag), **NIP-10** threading (kind 1 e-tags), **NIP-57** zaps. The cleaner consequence:

- **For native Posts, all.haus IS the origin, and the scoresheet is canonical.** `originCounts = null` for native. We do **not** run live relay COUNT queries to display native counts — that would be slow, incomplete, and would double-count, because an all.haus up-vote/repost *is* a NIP-25/NIP-18 event. The scoresheet is the single display source.
- **For external Posts, `originCounts` carries the origin platform's tallies** (Mastodon favourites, Bluesky likes, etc.), refreshed on expand; the all.haus scoresheet sits alongside as the additive native reaction layer.
- **Federation note (deferred):** backing the scoresheet with published NIP-25/18/57 events so native reactions federate outward is a later phase; display never depends on relay reads.

So native content already "wears all.haus clothing" by construction. No alternative count vocabulary is needed.

---

## 7. Biddability tier → capability map

`biddabilityTier` already exists and keys on how much relational/interactive fidelity the protocol affords. It gates **origin-derived and interact-back** capabilities only — the all.haus reaction layer (vote/repost/save via the scoresheet) is available at **every** tier, because the scoresheet is minted for every THING.

| capability | A (native, nostr_external, atproto) | B (activitypub) | C (rss/email, author known) | D (rss/email, anonymous) |
|---|---|---|---|---|
| body + media | ✓ | ✓ | ✓ | ✓ |
| origin tag / source name | ✓ | ✓ | ✓ | source name only |
| byline → profile + hover modal | ✓ | ✓ | ✓ (author known) | ✗ (no author) |
| all.haus actions (vote/repost/save) | ✓ | ✓ | ✓ | ✓ |
| report | ✓ (native) | n/a | n/a | n/a |
| origin counters | ✓ | ✓ | ✗ (none) | ✗ (none) |
| parents/replies (thread) | ✓ | ✓ | ✗ (none) | ✗ (none) |
| interact-back (reply/like/repost to origin) | ✓ | ✓ (where linked account allows) | ✗ | ✗ |

---

## 8. Thread engine (one, replacing three)

- **One read, then client-side re-root.** A conversation is fetched once as `Post[]` + `RepostEdge[]`. Re-rooting onto any loaded node is pure client-side (no refetch). This unifies the native (`useConversation`) and external (`useExternalThread`/`useNeighbourhood`) behaviours.
- **Bounds:** ancestors are fetched **all the way to the root**; descendants are **lazy** — load the first few replies (initial N = 5 in flattened order) with a cursor, and a "show more replies" affordance when `totalDescendants` exceeds what's loaded. Re-rooting onto a node whose subtree is already loaded is client-side; onto an unloaded subtree, it fetches.

---

## 9. Endpoint contracts

```
GET /thread/:postId?replyLimit=5&replyCursor=<c>
  → { focalId, posts: Post[], repostEdges: RepostEdge[], replyCursor?, totalDescendants }
    posts = ancestors-to-root + focal + first N descendants. Load-more merges by replyCursor.

GET /feed/:feedId?cursor=<c>
  → { items: Post[], attribution: Record<PostId, RepostEdge[]>, nextCursor }
    items are hydrated, server-scored (§5), and deduped to one per Post.

GET /post/:postId/reactors?type=like|repost&cursor=<c>   // GREENFIELD — no equivalent today (vote_tallies is counts-only; external getLikes/favourited_by not yet consumed)
  → { actors: Author[], nextCursor }      // counter-click modal (§4.2)

GET /author/:authorId/profile
  → { author: Author, bio, stats | null } // hover modal + profile header (§4.4)

GET /author/:authorId/posts?cursor=<c>
  → { items: Post[], nextCursor }         // chronological profile log, full-view styling

POST /post/:postId/react   { kind: "up"|"down"|"repost" }   // all.haus scoresheet (all tiers)
```

External origin-count refresh on expand reuses the existing `/external-items/:id/engagement` endpoint.

---

## 10. Migration sequence

Phased so each step is independently shippable and reviewable. **Do not hand the whole refactor to the agent as one change** — it will thrash into something unreviewable.

**Phase 0 — Schema + ingestion identity.** This is **not** a one-line schema add. It is three new subsystems and must ship as three independently-reviewable steps; the Accept criteria below are split accordingly. *No UI change across all of Phase 0.* (Nothing here exists today: `feed_items.id` is a per-source-row UUID, not a per-THING identity; there is no `version`/content-hash, no external-author identity table, and reposts are a boolean flag (`external_items.is_repost`) / kind-6 note, not an edge.)

**Phase 0a — Post identity + version.** Mint opaque `PostId` at ingestion on the `(protocol, stableOriginHandle)` dedup key (§2.3); compute + store `version` via the §2.4 content-hash recipe; persist `biddabilityTier` (today render-time-derived). Backfill `PostId`/`version` for existing rows. Adapters touched: `atproto`, `activitypub`, `rss`, `email`.
- **Accept:** every existing item resolves to a stable `PostId`; re-ingesting unchanged content is a no-op; an edit supplants (same id, new `version`); the operation token (nostr event id, etc.) is kept in native fields, never conflated with `version`.
- **Implemented (migration `098_feed_items_post_identity.sql`, 2026-05-31).** Done as a single `BEFORE INSERT/UPDATE` trigger on `feed_items` (`feed_items_post_identity()`), **not** per-adapter as the bullet above envisioned. Rationale: ~10 scattered `INSERT INTO feed_items` sites (gateway article/note routes + every feed-ingest adapter + reconcile crons) all funnel through this one trigger, so derivation + backfill share one definition with no TS↔SQL duplication; later phases only *read* `post_id`/`version`/`biddability_tier`, so this is forward-compatible. `post_id` = `sha256(protocol␟handle)` via `feed_items_derive_post_id()` (article→naddr coord `30023:pubkey:dtag`, note→event id, external→`source_item_uri`); native `version` = `nostr_event_id`, external `version` = content hash via `feed_items_content_version()`; `version`/`biddability_tier` recompute is gated so hot `score`/author-only updates skip the hash. Validated against the live dev DB: 1844 rows backfilled, 0 nulls, 0 duplicate `post_id`; full insert/edit-supplant/tier matrix passes. Schema mirrored into `schema.sql`.

**Phase 0b — External-author identity records (tier A/B only).** Introduce the external-author handle-record table keyed on `(protocol, stableHandle)`; mint `author.id` at ingestion **for tiers with a stable handle — A/B only** (nostr pubkey, atproto DID, activitypub actor URI); leave `author.accountId` null until claimed. Tier-C RSS/email authors get no record (no reliable key, resolved decision §0.4); tier D has no author. Backfill from existing `external_items` author fields for the A/B subset. *(Load-bearing for the §4.4 / §VI.3 profile, which aggregates a single author's Posts across sources by `author.id`.)*
- **Accept:** every tier-A/B Post has a non-null `author.id`; tier-C/D Posts have `author.id = null` and render plain-text bylines; the same external author seen via two A/B sources resolves to one `author.id`; claiming an all.haus account fills `accountId` without changing `author.id`.

**Phase 0c — Repost detection + RepostEdge + cross-source dedup.** This is **greenfield, not a promotion** (resolved decision §0.2): every adapter writes `is_repost = false` today, so there is effectively no existing repost set to lift. The work is two-fold:
1. **Build repost/boost detection per-adapter** at ingestion, capturing the boost's own origin id and actor: nostr **kind-6/16** reposts, atproto **reposts**, activitypub **`Announce`**. RSS/email have no repost concept — skip. Each detected boost yields a `RepostEdge` (§2.2) carrying `targetPostId`, `actorId`, `timestamp`, `originUri`; the boost is **not** minted as a Post (no body ⇒ not a THING).
2. **Introduce the `RepostEdge` table** and make the assembler group edges by `targetPostId`, so two sources boosting one external THING resolve to **one** `PostId` with two edges.
- **Accept:** a bare repost from each detecting adapter produces an edge, not a Post; two sources boosting one external THING resolve to one `PostId`; the attribution set (§5) lists both boosters; RSS/email produce no edges. §5 ordering has live boost input once this lands.

**Phase 1 — Unified read endpoints.** Build `GET /thread` and `GET /feed` over the new model, with server-side hotness scoring + dedup. Keep old endpoints live.
- **Accept:** `/feed` returns deduped, scored cards; `/thread` returns ancestors-to-root + first N replies + cursor. **Parity is of the content *set*, not ordering** — §5 deliberately replaces the old chronological order (`timeline.ts`, `ORDER BY published_at DESC`) with hotness scoring, so the new `/feed` *will not* match the old sequence and must not be tested against it. Verify the same candidate Posts appear (no items dropped or duplicated), then verify the new ordering matches §5.

**Phase 2 — One `PostCard` with `level` + the matrix.** Render a Post at any level per §4 and §7; quoted = byline+body; counter-click modals. Behind a flag in the workspace feed.
- **Accept:** a Post renders identically across levels except the matrix-defined deltas; biddability tiers gate correctly; quoted shows byline+body only.

**Phase R — Unified addressable reader pane.** Build the single article reading environment of §3.1 (resolved decision §0.3): an overlay backed by a real URL (shallow/intercepting route) that serves both the feed-overlay open and the direct-URL open, for native and external articles alike. Replaces the split between the native route page (`/article/[dTag]`) and the ephemeral external modal (`ReaderPane.tsx`). The article `PostCard` (Phase 2) click action targets this pane. Gating stays in the existing gate-pass service (§3.1) — the pane renders the locked below-the-gate state; the Post carries no protected body. Can land in parallel with Phase 3.
- **Accept:** opening an article from the feed and visiting its URL directly land in the same pane; the URL is shareable and opens in a new tab; a gated article shows the locked state via gate-pass with no protected content in the card or pre-unlock pane; native and external articles use one component.

**Phase 3 — Thread on `PostCard`.** Replace `ConversationView` + external rails with one walk over `Post[]`+edges: ancestors above, replies below, client-side re-root, scroll-centre focal, gutter overflow arrows, indent/gap/text-step.
- **Accept:** re-root leaves no residue; focal centres on expand and re-root; replies paginate; native and external threads are visually indistinguishable.

**Phase 4 — Hover modal + profile.** Debounced, cached hover modal; profile page with chronological Post log in full-view styling.
- **Accept:** hover fires once per rested author and caches; profile log paginates; no-stats authors show no stats.

**Phase 5 — Cut over + delete.** Flip the flag; retire `useConversation`, `useExternalThread`, `useNeighbourhood`, `ConversationNode`, `ExternalThreadEntry`, `ParentItem`, the scattered `quoted*` fields (on `WorkspaceFeedApiNote` / `NoteEvent`), and the legacy global-feed components now superseded by the workspace surface: `web/src/components/feed/ExternalCard.tsx` and `web/src/components/feed/FeedView.tsx` (there is a single `ExternalCard` in `components/feed/`, not a duplicated file — the workspace equivalent is `VesselCard`, which survives); and the old split reader — the ephemeral external modal `web/src/components/workspace/ReaderPane.tsx`, now superseded by the Phase R addressable pane (the native `/article/[dTag]` route is folded into Phase R's addressable surface, not deleted).
- **Accept:** old types/endpoints/components removed; no dangling references; feed + thread + reader + profile all run on the unified model.

---

## 11. Out of scope / deferred

- **Trust-weighting** (`trustWeight = 1` everywhere). The trust graph is bracketed until the foundational model is built. **Consequence to accept knowingly:** with weighting off, the "everyone's talking about this" honesty guard rests on saturation alone — a clique can still add saturated-but-positive lift via sockpuppets. Saturation caps how *much*, not *whether*. **Compounded by the §5 ceiling decision** (boosts may outrank fresh direct-follow content): until trust lands, a coordinated ring can displace direct content from the top, bounded only in magnitude. Revisit the ceiling and the weighting together when trust lands.
- **Decay half-life** — a config knob tuned against live traffic, not a value to guess now.
- **Federating all.haus reactions outward** (publishing NIP-25/18/57) — later phase.
- **Condensed-feed full spec** — the §4 condensed row is provisional.
- **Paid-downvote economics.**

## 12. Open questions

- Condensed-feed precise spec.
- Whether tier-B (activitypub) interact-back is full or partial against real linked accounts.
- Reactor-list availability per external protocol (Mastodon `favourited_by` has privacy limits; Bluesky `getLikes` is open).

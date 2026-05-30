# CARD-BEHAVIOUR-ADR: Feed Card Interaction & Conversational Expansion

**all.haus Architectural Decision Record**
**Status:** Phases 1–3 shipped (May 2026), audit fix-up 2026-05-27. Phase 4 (spec-conformance gaps from the 2026-05-29 verification audit — see §X) complete 2026-05-30: #1 done 2026-05-29; #2/#3/#4/#5 done 2026-05-30. The constructed external author profile (§VI.3) remains explicitly deferred to its own ADR.
**Author:** Ed Lake / Claude (design partner)
**Depends on:** UNIVERSAL-FEED-ADR, UI-DESIGN-SPEC
**Affects:** `web/src/components/feed/*`, `gateway/src/routes/`, `feed-ingest/src/lib/*`, `schema.sql`, `migrations/`

> **Note to Claude Code.** This is a design-decisions document, not a line-level
> implementation spec. It fixes the _what_ and the _why_; you own the _how_.
> Where it names a file, endpoint, column, or constant, treat that as the
> intended shape unless you find a concrete reason it cannot work — in which
> case stop and flag it rather than improvising a divergent design. Phasing is
> in §X; do not start Phase 2 before Phase 1 is green.

---

## I. Problem statement

The feed renders four card types — `ArticleCard`, `NoteCard`, `ExternalCard`,
`QuoteCard` — and they do not share an interaction model. Concretely:

1. **Inconsistent click semantics.** `ArticleCard` and `NoteCard` navigate on
   whole-body click; `ExternalCard` does not navigate at all — its body click
   does nothing and "View original" is a footer link. A reader cannot predict
   what clicking a card does.

2. **Replies are invisible as replies.** A great many external items — the
   Mastodon example that prompted this ADR is typical — are replies to a parent
   the reader cannot see. The card gives no signal that a parent exists and no
   route to it. The conversation is amputated at both ends: parent above is
   absent, replies below are absent (`ArticleCard` and `ExternalCard` render no
   reply thread inline; only `NoteCard` does).

3. **Attribution furniture is inert.** The block-caps source line
   (`VIA ACTIVITYPUB · GARGRON@MASTODON.SOCIAL`) is not clickable. The author
   byline is sometimes a link, sometimes not, depending on whether the adapter
   captured an `author_uri`. There is no single, predictable route from a card
   to its origin.

4. **No author affordance.** Hovering a byline does nothing. There is no
   lightweight way to see who someone is or to follow them without leaving the
   feed.

The ambition: **one interaction language for all four card types**, in which
every affordance is present on every card and _degrades predictably_ when the
source platform cannot supply the data behind it. The reader should never meet
four broken UIs wearing a trench coat; they should meet one UI that is
sometimes quieter than other times.

---

## II. Design principles

1. **One gesture, one job.** Every clickable region of a card has exactly one
   unambiguous purpose, identical across all four card types.

2. **Graceful degradation, never disappearance.** An affordance does not vanish
   because the source is sparse. It downgrades to its best available form and
   says so. Absence of a feature reads as a property of the _source_, not a bug
   in all.haus.

3. **The conversation is one object.** A reader interested in a post wants the
   _whole_ conversational neighbourhood — what it replies to, and what replies
   to it — in a single move, not two separate expansions.

4. **Provenance is sacred, and singular.** Every card shows where it came from
   and offers exactly one route back to the original. (Carried over from
   UNIVERSAL-FEED-ADR §II.2.)

5. **Resting density is low.** Secondary controls are quiet until the reader
   reaches for them. This serves the brightness/density attentional axes
   (UI-DESIGN-SPEC) and keeps the feed calm.

6. **Touch is a first-class idiom, not a degraded desktop.** The hover/click
   split maps to a principled touch equivalent. Nothing on touch is "the
   desktop UI with hover removed."

---

## III. Source biddability tiers

The single most important concept in this ADR. Every card declares a
**biddability tier** — how much the originating platform lets us do with it.
The UI is written once against these tiers; it is _not_ written four times
against four protocols.

| Tier                           | Sources                                                                  | Parent resolvable?                                      | Author profilable?                         | Interaction counts |
| ------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------ | ------------------ |
| **A — Threaded & resolvable**  | Native (tier 1), external Nostr (tier 2), Bluesky (tier 3)               | Yes — parent fetchable on demand                        | Yes — real profile + post history          | Real               |
| **B — Threaded, best-effort**  | Mastodon / ActivityPub (tier 3)                                          | Maybe — instance may or may not serve the parent object | Partial — webfinger + actor, may fail      | Partial            |
| **C — Standalone, attributed** | RSS/Atom (tier 4) _with_ an author URI                                   | No — RSS has no reply concept                           | Source-level only (the feed, not a person) | None               |
| **D — Standalone, sparse**     | RSS (tier 4) without author URI; any item missing author/origin metadata | No                                                      | No — author is a bare string               | None               |

Mapping rules (deterministic, computed at ingest — see §VII):

- Tier is **not** the same as `content_tier`. `content_tier` is a provenance
  enum; biddability tier is a UI-capability classification. A tier-3 Mastodon
  item and a tier-3 Bluesky item have the _same_ `content_tier` but **different**
  biddability tiers (B vs A). Keep the two concepts separate in code and naming.
- An item is **A** if it is native, external-Nostr, or Bluesky.
- An item is **B** if it is ActivityPub.
- An item is **C** if it is RSS _and_ `external_items.author_uri IS NOT NULL`.
- An item is **D** if it is RSS with no `author_uri`, **or** any item of any
  protocol whose required metadata failed to capture (defensive catch-all).

The biddability tier is the contract between back-end reality and front-end
behaviour. Everything in §IV–§VI is written in terms of it.

---

## IV. The card region map

One map. All four card types. Every region does the same thing on every card.

| Region                                                        | Action                                               | Notes                                                                                                                                                                     |
| ------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Headline / first line of content**                          | Navigate to the item's all.haus view                 | Native article → `/article/{dTag}`. Note → its permalink. External → the constructed external-item permalink (out of scope detail; for now, route is reserved — see §IX). |
| **Card body** (the inert space between byline and action row) | **Expand the conversational neighbourhood** — see §V | This is the headline behaviour of this ADR. Toggles.                                                                                                                      |
| **Byline name**                                               | Navigate to the author surface                       | See §VI. Hover → author modal.                                                                                                                                            |
| **Byline avatar / TrustPip**                                  | Same as byline name                                  | Whole byline cluster is one navigation target.                                                                                                                            |
| **Reply provenance line** (`↳ REPLYING TO …`)                 | None — pure signalling                               | Tells the reader a parent exists; the parent appears when the body is expanded. Not itself a trigger. See §V.2.                                                           |
| **Source attribution** (`VIA BLUESKY · handle`)               | The single route to the original, opens in new tab   | Both the protocol word and the handle are one clickable target. See §VI.4.                                                                                                |
| **Action controls** (vote, reply, quote, bookmark, share)     | Their own action                                     | `stopPropagation` so they never trigger body-expand. As today.                                                                                                            |

**What changes from current code:**

- `ArticleCard` / `NoteCard`: whole-body click **stops navigating**. Navigation
  moves to the headline only. Body click now expands the neighbourhood.
- `ExternalCard`: gains body-click expansion; the dead "click body does nothing"
  state is retired. "View original" stops being the only route out and becomes
  one consistent piece of furniture (the source attribution line).
- All cards: the source attribution line and byline become reliably,
  identically clickable.

---

## V. Conversational neighbourhood expansion

The core interaction. **One body click expands the whole neighbourhood in one
move; a second click collapses it.**

### V.1 The expanded state

When a reader clicks the body of a card ("the anchor card"):

```
   ┌─ parent card ────────────────┐   ← inset: indented, dimmed,
   │  (full affordances, quieter) │     no zone-break margin above
   └──────────────────────────────┘
 ┌─ ANCHOR CARD ───────────────────┐  ← stays put, full brightness,
 │  (the card the reader clicked)  │     visually the centre of gravity
 └──────────────────────────────────┘
   ┌─ reply ──────────────────────┐   ← inset: indented, dimmed
   ┌─ reply ──────────────────────┐
   └──────────────────────────────┘
```

- The anchor card **does not move** and does not change. It is the fixed
  reference point; everything else grows around it. (This matters: if the
  anchor jumps, the reader loses their place.)
- The **parent** renders above, inset — indented by one step, left bar dimmed
  one shade, no 40/72px zone-break margin (it reads as "attached to", not "a
  separate feed item").
- **Replies** render below, inset the same way.
- Parent and replies are **real cards** with full affordances — votable,
  replyable, their own bylines hoverable. They are quieter (reduced brightness)
  but not crippled. A reader can act on the parent exactly as on the anchor.
- Second body click on the anchor collapses parent + replies together.

### V.2 The provenance line

When a card _is_ a reply, render a thin mono-caps line **above the byline**:

```
↳ REPLYING TO @jaredwhite
```

- It is **signalling only** — it is not clickable, it is not the trigger. Its
  job is to set the reader's expectation: "there is a parent; expand the body
  and you'll see it."
- Copy degrades by tier:
  - **A / B** with resolvable parent author: `↳ REPLYING TO @handle`
  - **B** where the parent author is not yet known: `↳ REPLYING TO A POST`
  - **C / D**: the line is never rendered (these tiers have no parent concept).
- Rendering the line requires the feed list to know "is this a reply" _without_
  a join — see §VII.1.

### V.3 Walking the thread

A reply's parent may itself be a reply. **Do not auto-fetch the whole
ancestry** — that is N uncontrolled outbound requests per expansion. Instead:

- First body-click hydrates **one hop up** (the immediate parent) and the
  immediate replies down.
- If the parent is itself a reply, the expanded parent card carries its own
  `↳ SHOW PARENT` control. Clicking it hydrates one further hop.
- Same downward: replies are fetched one page at a time with a `SHOW MORE
REPLIES` control if the count exceeds the first page.
- This keeps every fetch reader-initiated and bounded.

### V.4 Hydration — the gateway proxy

Parent and reply hydration for external items is an **outbound fetch to the
source platform**, and it is proxied by the gateway. It is **not** fetched
directly from the browser. Rationale:

- A shared server-side cache: a popular parent is fetched once, not once per
  reader.
- One rate-limit budget we control, keyed by us — not per-reader-IP.
- Mastodon (tier B) frequently requires signed fetches and almost always blocks
  cross-origin browser requests; only a server-side fetch can do tier B at all.
  Browser-direct hydration would silently make tier B un-expandable and
  reintroduce the four-broken-UIs problem.
- One place to normalise four protocols into one response shape.

New endpoint (shape; name negotiable):

```
GET /api/v1/external/thread?uri={source_item_uri}&direction={up|down}&cursor={opaque}
```

- `requireAuth`, rate-limited (follow the `resolve.ts` precedent:
  `config: { rateLimit: { max: 30, timeWindow: '1 minute' } }`).
- Returns a normalised payload: `{ parent?: NormalisedCard, replies?: NormalisedCard[], cursor?, partial: boolean }`.
- `partial: true` signals tier-B best-effort failure (see §V.5).
- Short-TTL cache (Postgres table or in-process LRU — implementer's call;
  Postgres keeps it consistent with the no-Redis principle in
  UNIVERSAL-FEED-ADR §II.5). Suggested TTL: a few minutes. Outbound calls get a
  hard timeout (~5s) so a slow instance cannot stall the endpoint.
- The endpoint already has the per-protocol resolution logic available in the
  ingest adapters (`atproto.ts` resolves `getPostThread`-style data;
  `activitypub.ts` handles actor/object fetches). Reuse, do not reimplement.

### V.5 Failure and empty states (tier-driven)

Expansion must treat failure as an ordinary, designed state — never an error
banner.

- **Tier A, parent resolves:** parent renders. Normal.
- **Tier A/B, fetch in flight:** the parent slot shows a skeleton at the inset
  position. (On-demand hydration was chosen over pre-fetch; the skeleton is the
  honest cost of that choice. If it feels crummy in practice, revisit — but not
  in this ADR.)
- **Tier B, fetch fails or returns partial:** the parent slot shows a quiet,
  non-alarming inset stub — `↳ PARENT POST · COULDN'T REACH MASTODON.SOCIAL` —
  with the source-attribution route to view it on the origin instance still
  live. The reader is informed, not blocked, and the failure is correctly
  attributed to the instance, not to all.haus.
- **Tier C/D:** the body is still clickable and still expands — but only the
  _replies_ side, and only for native all.haus replies to the item (an all.haus
  user may have replied to an RSS item; that reply is a native Nostr event we
  own). There is no parent and no `↳` line. If there are also no replies, the
  body click expands to a single quiet line: `NO CONVERSATION YET — BE THE
FIRST TO REPLY`, which doubles as a reply affordance.

The principle: **body click always does something coherent on every tier.** It
is never dead (the current `ExternalCard` failing) and never misleading.

---

## VI. Author affordances

### VI.1 The author modal (hover)

Hovering a byline opens a lightweight modal — minimal bio, relevant
platform-appropriate stats, and an **instant Follow control** that works from
the modal surface itself (no navigation required).

- ~300ms hover-intent delay before it appears; dismiss on mouse-leave.
- Content degrades by tier:
  - **A:** avatar, display name, handle, short bio, follower/following or
    equivalent counts, Follow button.
  - **B:** whatever webfinger + actor returned; missing fields are simply
    omitted (no empty rows). Follow button present.
  - **C:** there is no person — the modal describes the _source_ (the feed):
    feed name, feed description if the channel provided one, a Follow control
    that follows the feed. Framed as a source, not a face.
  - **D:** the modal shows the bare author string and a single line —
    `LIMITED INFO FROM THIS SOURCE`. The Follow control follows whatever
    subscribable entity exists (the source); if nothing is subscribable, the
    control is omitted rather than shown disabled.
- The modal's data comes from a gateway endpoint; reuse the existing author /
  source metadata paths where they exist (`source-metadata-refresh` task
  already maintains source display data; `useWriterName` already resolves
  native authors). Do not add a fourth author-resolution path — consolidate.

### VI.2 Byline click

Clicking the byline navigates to the **author surface**.

- **Native authors:** the existing writer profile page (`/{username}`). No
  change.
- **External authors / sources:** for now, byline click routes to the **source
  surface** — the feed/publication/source page — **not** a per-person
  constructed profile.

### VI.3 ⚠️ DEFERRED — the constructed external author profile

> **Claude Code: action required.** A full all.haus-constructed author profile
> page for _external_ authors — assembled from API-available personal info at
> the originating platform, showing a unified chronological feed of that
> author's posts across all linked platforms — **is explicitly desired and
> explicitly out of scope for this ADR.** It is deferred to its own ADR.
>
> **Before you implement anything in this document, add a tracked item to
> whichever progress-tracking / backlog markdown the project is currently using
> (e.g. `AUDIT-BACKLOG.md`, `feature-debt.md`, or the active programme doc).**
> The item: _"Constructed external author profile pages — unified
> cross-platform post history. Deferred from CARD-BEHAVIOUR-ADR §VI.3. Needs its
> own ADR."_ Do not let this fall on the floor.

Because the constructed profile is deferred, byline click for external authors
degrades to the source surface (§VI.2). The byline-click _contract_ — "clicking
a byline takes you to that author's home on all.haus" — is fixed now; the richer
destination lands later without changing the contract.

### VI.4 Source attribution — the one route out

The block-caps source line is the **single, canonical route to the original**.

- The whole line (`VIA {PROTOCOL} · {handle}`) is one clickable target,
  opening the original in a new tab.
- This **replaces** the footer "View original" link and the absent body-click
  route. One route, predictably placed, on every external card.
- Native cards (tier 1) have no external origin and therefore no attribution
  line — correct and expected.
- Tier D where even the origin URL is missing: the line renders un-clickable as
  plain provenance text (`VIA RSS · {feed name}`). This is the one acceptable
  non-interactive instance, and it is still _informative_.

---

## VII. Back-end changes required

This ADR is front-end-led but cannot ship without the following. They are small
and additive (consistent with UNIVERSAL-FEED-ADR §II.4).

### VII.1 `feed_items.is_reply` — migration

The feed list query must know "is this card a reply" to render the `↳` line,
**without joining `external_items`**.

- Add `is_reply BOOLEAN NOT NULL DEFAULT FALSE` to `feed_items`.
- **Do not** put the reply _URI_ on `feed_items`. `feed_items` is the
  denormalised read-model; it should carry the minimum the list render needs,
  which is the boolean. The canonical `source_reply_uri` stays on
  `external_items` and is read only at hydration time (§V.4). Duplicating the
  URI would create a second source of truth needing backfill on every adapter
  change.
- Populate on write:
  - External path: `is_reply = (source_reply_uri IS NOT NULL)` in the
    `insertAtprotoItem` / `insertActivityPubItem` `feed_items` INSERT.
  - Native notes: a note is a reply if its kind-1 event carries an `e`-tag.
    Set `is_reply` accordingly in the note → `feed_items` projection. **Do not
    forget the native path** — native notes can be replies too; this is not an
    external-only column.
  - Articles: always `false`.
- Backfill migration for existing rows: external from `external_items`, notes
  from their tags.

### VII.2 Biddability tier — derived, not stored (preferred)

The §III tier is a pure function of data already present (`item_type`,
`source_protocol`, `external_items.author_uri`). Prefer computing it in the feed
projection / API response rather than adding a column — it has no independent
lifecycle and a stored copy would drift. Expose it on the feed API item shape
as e.g. `biddabilityTier: 'A' | 'B' | 'C' | 'D'` so the client gets it without
its own logic. If profiling later shows the per-row computation is hot, a
generated column is the fallback — but do not start there.

### VII.3 Thread hydration endpoint

`GET /api/v1/external/thread` per §V.4. New route file under
`gateway/src/routes/` (e.g. `external-thread.ts`), registered alongside the
existing external-feed routes. Reuse adapter resolution logic from
`feed-ingest/src/adapters/`; if that code is not cleanly importable from the
gateway, extract the shared resolution helpers into `shared/` rather than
copy-pasting.

### VII.4 Author/source metadata endpoint for the modal

An endpoint serving the §VI.1 modal payload, tier-shaped. Consolidate with
existing author/source resolution (`useWriterName`, `source-metadata-refresh`,
external-feeds routes) — **one resolution path, four output shapes**, not a new
parallel path.

### VII.5 Known back-end obstacles (design has accounted for these)

- **RSS has no author identity** — `rss.ts` hardcodes `authorHandle` and
  `authorUri` to `null`. This is why tiers C/D exist and why the constructed
  author profile (§VI.3) cannot apply to RSS at all. Not a bug to fix; a
  property to design around.
- **Mastodon outbox polling is best-effort** — already flagged BETA in
  `ExternalCard`. Parent hydration for tier B _will_ sometimes fail. §V.5
  designs for this as a normal state.
- **A reply's parent is usually not in our DB** — ingest only stores posts
  authored by _followed_ sources; a parent by a non-followed account is absent.
  This is _why_ hydration is an on-demand outbound fetch and not a local join.
- **Bluesky AppView is rate-limited and unauthenticated** — fine for
  server-side proxied, cached fetches; would be fragile browser-side. Confirms
  the §V.4 gateway-proxy decision.
- **`feed_items` is a denormalised dual-write table** — any new column (VII.1)
  must be written in _both_ the external ingest path and the native
  projection, and backfilled. Consistent with the dual-write discipline already
  in `UNIVERSAL-FEED-ADR` and the reconciliation job in
  `feed-items-reconcile.ts`.

---

## VIII. Touch / mobile

The desktop hover/click split maps cleanly; it is not "desktop minus hover."

| Desktop                                                      | Touch                                                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Body click → expand neighbourhood                            | Body tap → expand neighbourhood (identical)                                                                                    |
| Primary actions always visible                               | Primary actions always visible (identical)                                                                                     |
| Secondary actions (quote, bookmark, share) revealed on hover | Secondary actions behind one explicit `⋯` control → small action sheet                                                         |
| Byline hover → author modal                                  | **No modal.** Byline tap → straight through to author surface (§VI.2). The modal is a hover artefact; it has no touch meaning. |
| `↳` provenance line: signalling only                         | Identical                                                                                                                      |
| Source attribution: click → original                         | Tap → original (identical)                                                                                                     |

The `⋯` action sheet is the _correct_ touch idiom on a narrow viewport, and it
serves the density axis better than cramming five controls inline — it is not a
compromise. Keyboard parity: secondary actions are also revealed on card
keyboard-focus, so the hover-gated cluster is reachable without a pointer.

---

## IX. Out of scope

- **Constructed external author profile pages** (§VI.3) — deferred to its own
  ADR; tracked-item instruction is in §VI.3, do not skip it.
- **The external-item permalink page** — §IV reserves the headline → external
  item route, but the constructed external-item _view_ is not specified here.
  Until it exists, headline click on an external card may route to the source
  attribution target (same as §VI.4) as an interim; flag this as interim in the
  code so it is not mistaken for the final design.
- **Pre-fetching parents at ingest** — considered and rejected for now in favour
  of on-demand hydration (§V.4). Revisit only if the §V.5 skeleton proves
  annoying in real use.
- **Cross-posting / outbound reply routing** — already covered by
  UNIVERSAL-FEED-ADR; unchanged by this ADR.
- **Vote/bookmark/quote mechanics** — unchanged; this ADR only relocates _when_
  the controls appear (hover/`⋯`), not what they do.

---

## X. Phasing

**Phase 1 — region map + back-end foundation.** The unambiguous click map (§IV),
`is_reply` migration + dual-path population + backfill (§VII.1), biddability
tier on the feed API (§VII.2). No expansion yet. Ship: predictable clicks,
correct `↳` signalling line, source attribution as the one route out. This is
shippable on its own and removes the worst current confusion.

**Phase 2 — neighbourhood expansion.** The thread hydration endpoint (§VII.3),
body-click expansion with inset parent/replies (§V), tier-driven failure states
(§V.5), thread-walking controls (§V.3).

**Phase 3 — author affordances.** The modal (§VI.1), the metadata endpoint
(§VII.4), byline-click routing to the source surface (§VI.2), touch `⋯` sheet
and action-sheet (§VIII).

**Phase 4 — spec-conformance gaps.** A section-by-section verification of the
shipped Phase 1–3 code against this ADR (2026-05-29) found five divergences. They
are tracked in `feature-debt.md` ("Card behaviour — verified-against-spec gaps")
and collected here in priority order:

1. ~~**Neighbourhood expansion is ExternalCard-only (§V.1, §V.3) — substantive.**~~
   **DONE (2026-05-29).** `NoteCard` is now kind-aware and hydrates its parent above
   the anchor on expand (`useNativeParent` → `GET /content/resolve`) with the same
   scroll-pinning as `ExternalCard`; new `NativeParentCard` shares the dimmed-bar
   inset grammar. The profile Replies surface (`SocialTab`) now flows through
   `NoteCard`, retiring the bespoke `ReplyCard`. `ArticleCard` is unchanged by design
   (articles are always `is_reply = false`, so there is no parent-above and the
   downward `ReplySection` never moves the anchor). Known limit: a reply nested under
   another comment anchors its parent-above at the thread root, since
   `/content/resolve` does not resolve comments.
2. ~~**Thread hydration endpoint shape (§V.4, §VII.3).**~~ **DONE (2026-05-30).** The
   capability still rides the `/external-items/:id/thread` + `/parent` pair (name/shape
   was always negotiable), but the three concrete sub-specs are now met: both routes
   carry a per-route rate limit (`{ max: 30, timeWindow: "1 minute" }`); the outbound
   source fetches for the essential data (parent, quote, and thread helpers for
   Bluesky + Mastodon) pass `timeout: NEIGHBOURHOOD_FETCH_TIMEOUT_MS` (8s — headroom
   for a cold SSRF-pinned fetch that pays a full DNS+TLS handshake) instead of the
   shared client's 10s default, while the optional grandparent-tag fetch runs on a
   tighter `GRANDPARENT_FETCH_TIMEOUT_MS` (2.5s) so a slow secondary call can never
   extend or jeopardise the parent response; and `partial` is now a server-signalled field on
   both `ThreadResponse` and `ParentContextResponse` (true when a source fetch
   fails/times out for a reply that expects content). `useNeighbourhood` prefers the
   server flag over inferring `partial` from a rejected promise.
3. ~~**External byline routing (§VI.2).**~~ **DONE (2026-05-30).** Built the minimal
   internal source surface and pointed the byline at it. Gateway: `GET /api/v1/sources/:id`
   (`gateway/src/routes/sources.ts`) returns source metadata + a chronological,
   cursor-paginated page of that source's external items, reusing timeline's
   now-exported `FEED_SELECT` / `FEED_JOINS` / `feedItemToResponse` / `parseCursor`.
   `timeline.ts` now also returns `externalSourceId` (feeds.ts already did). Frontend:
   new `/source/[id]` route (`SourceSurface` client component — source header + the
   source's `ExternalCard` list with SHOW MORE paging). `ExternalCard`'s byline now
   links via `next/link` to `/source/{externalSourceId}` instead of the origin
   platform (the origin link stays on the §VI.4 source-attribution line — the one
   route out); the byline degrades to a non-link span when no source id is present.
   The richer constructed author profile (§VI.3) still lands later without changing
   this contract.
4. ~~**NoteCard headline navigation (§IV).**~~ **DONE (2026-05-30).** The body-expand
   region in `NoteCard.tsx` now carries an INTERIM comment (mirroring `ExternalCard`'s
   headline marker) noting that notes have no permalink region and the body click
   expands until a note permalink page exists.
5. ~~**Empty-state reply affordance (§V.5) — minor.**~~ **DONE (2026-05-30).**
   `NeighbourhoodEmptyState` now takes an optional `onReply` handler; when present it
   renders as a button (`hover:text-black`) that opens the composer, falling back to
   the inert label when no handler is wired. `ExternalCard` passes its `handleReply`.

**Phase 5 — workspace vessel-card conformance (2026-05-30).** Phases 1–4 landed
on the `web/src/components/feed/` cards (`ExternalCard`, `NoteCard`,
`ArticleCard`). The parallel **workspace** card family
(`web/src/components/workspace/VesselCard.tsx`), built during the workspace
experiment, had diverged from this ADR and is now the surface that matters — the
main feed is being retired. The vessel cards were brought in line:

- **Body click expands the conversational neighbourhood (§V).** Expanding a card
  now reveals its replies (and parent) in one gesture — the `ExternalCardThread`
  playscript (parent ancestors + replies) for atproto/activitypub, and the
  native `CardThread` for articles/notes — gated on `expanded || threadExpanded`.
  The separate "Thread / Hide thread" toggle is deleted; `onToggleThread` is
  removed from `VesselCard` and `WorkspaceView`. (`threadExpanded` survives only
  as the composer's auto-reveal hook for a freshly-posted reply.) When the
  playscript thread renders, the standalone `ParentContextTile` is suppressed to
  avoid a duplicate parent.
- **Source attribution is the one route out (§VI.4).** The crimson
  `Open original →` button is deleted. The bottom `VIA {PROTOCOL} · {handle}`
  line is now the single clickable route to the origin (RSS/email → reader pane,
  others → new tab) and renders in standard density too, not just full. It
  degrades to inert provenance text when no origin URL exists (tier D).
- **Byline routes to the source surface (§VI.2).** The external byline name now
  links via `next/link` to `/source/{externalSourceId}`, matching the feed card;
  degrades to a plain span when no source id is present.

Do not begin a phase before the previous one is green. Phase 1 carries the
riskiest schema change (a dual-write column) deliberately first and alone, per
the discipline in RELAY-OUTBOX-ADR §D2.

---

## XI. Acceptance criteria

- Every clickable region of every card type does the §IV-mapped thing, and
  only that thing.
- A reply card shows the `↳` line; a non-reply card does not; this is correct
  for native notes as well as external items.
- One body click on any card on any tier produces a coherent result: tier A/B →
  parent + replies; tier C/D → replies-or-empty-state. The body click is never
  inert and never misleading.
- Tier B parent-hydration failure renders the quiet inset stub, not an error
  banner, and still offers the route to the origin.
- The anchor card does not move when the neighbourhood expands.
- Byline hover (desktop) shows the tier-appropriate modal with a working Follow
  control; byline tap (touch) navigates through with no modal.
- The source attribution line is the single route to the original on every
  external card.
- A tracked backlog item for §VI.3 (constructed author profiles) exists in the
  project's progress-tracking markdown.

## Addendum — Byline routing is canonical (2026-05-30)

Author bylines never link to the origin platform's native profile. This holds for the card byline _and_ for every author byline inside the expanded conversational neighbourhood (parent context tiles and playscript thread entries):

- **Native authors** → their all.haus writer profile (`/{username}`).
- **External authors** → the item's source surface (`/source/:id`, §VI.2). Because thread/parent payloads carry no per-entry source id, external neighbourhood bylines resolve to the _expanded item's_ source surface; a participant who differs from the subscribed source therefore lands on that source's page rather than a page for them specifically. A true per-author external profile remains the deferred §VI.3 work.
- The single route out to the origin platform stays the source-attribution line (§VI.4).

Implemented via a `sourceHref` prop threaded from the card in `web/src/components/workspace/{ExternalPlayscriptEntry,ExternalPlayscriptThread,ParentContextTile,VesselCard}.tsx`.

## Addendum — Rich embeds render in our idiom (2026-05-30)

When an external post embeds rich media — quotes another post, or previews an outside link — the workspace card replicates that embedding in its own idiom rather than dropping it or linking out. Scope: Bluesky + Mastodon (Nostr/RSS deferred). Two embed kinds:

- **Quoted posts.** A quote post (Bluesky `app.bsky.embed.record[WithMedia]`; Mastodon/FEP-044f `quote` / Fedibird `quoteUrl` / Misskey `_misskey_quote`) renders as a nested mini-card via `QuotedPostTile` — `↱ QUOTING author · time`, the quoted text, and the quoted post's **own** media (image / link card). It deliberately does not recurse into a quote-of-quote. Hydration mirrors the parent-context pattern exactly: the quote URI is stored on `external_items.source_quote_uri`; `external_parent_prefetch` eagerly hydrates the quoted post as a context-only row; and `GET /external-items/:id/quote` (same rate-limit / cache / `partial`-flag contract as `/parent`, §V.4–V.5) lazily fetches on a cold miss via `fetchBlueskyQuote` / `fetchMastodonQuote`. The quoted author byline is **plain text** — never a route out to the origin platform, and not a fabricated `/source/:id` link either (the quoted author often isn't the subscribed source), consistent with the byline-routing addendum above.
- **Link preview cards.** An external link previewed with title/description/thumbnail (Bluesky `app.bsky.embed.external` → `media[]` `{type:"link"}`; Mastodon's `card`, which lives only in the Mastodon REST API and is captured by the existing `external_engagement_refresh` `/statuses/:id` fetch) renders through `MediaBlock`'s `LinkPreviewCard`, so a previewed link looks identical regardless of source.

Implemented in `web/src/components/workspace/{VesselCard,QuotedPostTile}.tsx`, `gateway/src/routes/external-items.ts`, `feed-ingest/src/adapters/activitypub.ts`, and `feed-ingest/src/tasks/{external-parent-prefetch,external-engagement-refresh}.ts`.

## Addendum — Self-thread suppression & refresh collapse (2026-05-30)

Two refinements to neighbourhood behaviour on the workspace surface:

- **Self-thread parent suppression.** When a reply's parent shares the host card's author (a self-thread — e.g. someone replying to their own post), the inline `ParentContextTile` is suppressed: the parent already stands as its own feed item, so showing it inline merely reads as one merged card divided by a hairline. `ParentContextTile` takes an optional `selfAuthor` and `return null`s on a handle match (or a case-insensitive name match when neither side has a handle). Cross-author reply context is unchanged — showing what a post replies to is still wanted; only same-author redundancy goes. `ReplyGroupCard`'s once-rendered parent tile is likewise untouched.
- **Refresh collapses expansions.** Refreshing a vessel (pull-to-refresh, drag-drop reload, or `refreshAll`) returns its cards to the collapsed state: `loadVesselItems` strips that vessel's item keys (`id` and `feedItemId`) from both `expandedCards` and `expandedThreads` before reloading; `refreshAll` clears both sets. A reload is a fresh read of the feed, not a continuation of a reading session, so stale expanded context is dropped rather than stranded above changed content.

Implemented in `web/src/components/workspace/{ParentContextTile,VesselCard,WorkspaceView}.tsx`.

## Addendum — Media expansion, clickable external pip, unified body text & shared byline (2026-05-30)

Workspace vessel-card refinements shipped alongside the appearance-controls relocation (see WORKSPACE-FULL-VIEW-SPEC.md):

- **Media expands with the card.** Collapsed cards keep the neat cropped 16:9 hero thumbnail; expanding a card renders its hero (and any additional image/video items, stacked full-width) at natural aspect ratio bounded by the container width — the `+N` overflow pill is suppressed in the expanded state. `MediaBlock` branches its container/img style on `expanded`, now passed by all three card types.
- **External pip opens the author bio.** The trust route keys on a platform user id external authors lack, so the external card's pip is a clickable trigger that opens the minimal `AuthorModal` (keyed on the external item id, `type="external"`) anchored to the pip, rather than the native `PipPanel`. `AuthorModal` closes on Escape / outside-pointerdown (the anchor is excluded so the trigger toggles) and exposes `dismissOnMouseLeave` so the hover-driven `/feed` usage is unchanged. This is the click-only form; hover-to-open is parked. Native note/article pips still open `PipPanel`.
- **One body text size, one byline.** A per-feed text-size step (`TextSize` 1–5, default 3 = today's 13.5px) flows through `CardContext.bodyPx` and governs **all** reading prose in lockstep — main body, expanded external HTML, parent tile, and playscript dialogue — while meta rows and bylines (mono `label-ui`) stay fixed. The playscript bold-`Name:` speaker line is retired in favour of a shared `Byline` component (pip · name · time, with an optional `→ NAME` non-adjacent-parent prefix) used by main cards, `ParentContextTile`, and `ExternalPlayscriptEntry`, so a reply or parent byline reads identically to a main-card byline; the entry timestamp moves into the byline and the action row keeps only `Reply`. (This unification applies to the **workspace** `ExternalPlayscriptEntry`; the native `/feed` `PlayscriptReply` in `web/src/components/replies/` is unchanged.)

Implemented in `web/src/components/workspace/{VesselCard,Byline,ParentContextTile,ExternalPlayscriptEntry,ExternalPlayscriptThread,ReplyGroupCard,tokens}.tsx` + `web/src/components/feed/AuthorModal.tsx`.

## Addendum — Parents-above + in-place re-focus (2026-05-30)

When a card's neighbourhood is expanded, the conversation reads strictly top-down — a **focal node** sits in the middle, its **ancestor chain renders above it** (indented `ml-8`, flat per the playscript rule — never a deepening nested cascade), and its descendants render below. **Clicking any ancestor or descendant re-roots the view on that node in place**, re-deriving the ancestors-above / descendants-below around the new focal. The chain walks up until it reaches a node with no parent (the start of the conversation).

- **Native (notes/comments) — full focal model.** New `GET /conversation/:eventId` (gateway `replies.ts`) resolves the conversation root from *any* node (a note/article event id, or a comment's `target_event_id`) and returns the **whole conversation** as a flat list of normalised nodes, each with a uniform `parentEventId` (null for the root; the root's event id for top-level comments; the parent comment's event id otherwise). Because every comment in a thread shares one `target_event_id`, one fetch covers the whole tree — re-focus is **pure client-side re-rooting, no refetch**. `useConversation` (caches by resolved root) feeds `ConversationView`, which owns the local `focalId`, walks ancestors up the `parentEventId` chain, flattens the focal's descendant subtree to a chronological playscript, and renders entries with the shared `Byline` + `VoteControls` + `Reply` + own-content `Delete`. The host note card stays pinned as the conversation root above `ConversationView`; intermediate ancestors of a re-focused reply render between the host and the highlighted focal anchor, and `↑ Full conversation` resets the focal to the root. Wired into `NoteVesselCard` in place of the old downward-only `CardThread`.
- **External (Bluesky/Mastodon) — parents-above (full chain) + in-place re-focus.** `GET /external-items/:id/thread` returns the full `ancestors`/`descendants` and now accepts an optional `?focus=<sourceId>` query param that re-roots the returned thread on a clicked node (the gateway derives a synthetic item on the same source — see `deriveFocusItem`). `ExternalVesselCard` fetches the thread once (`useExternalThread(external.id, showThread, focusEntry?.id)`) and renders the **full ancestor chain above the card content** via `ExternalAncestorRail` (replacing the single immediate-parent `ParentContextTile` in the expanded state), with descendants below via `ExternalCardThread` (descendant-only, taking the shared fetch as props). **In-place re-focus now ships**: `ExternalVesselCard` holds a `focusEntry` state; clicking any ancestor/descendant entry (`ExternalPlayscriptEntry`'s body — the Reply control and the byline link keep their own behaviour via `stopPropagation`) re-roots via the `?focus=` param. Because each `ExternalThreadEntry.id` is a source URI / numeric status id, that id is exactly what's passed as `focus`. The focal node is rendered from the clicked `ExternalThreadEntry` itself (the refetched rail/thread payloads exclude the focal node) with a left-border focal treatment matching native's `opts.focal`; `↑ Full conversation` resets to the original card item. While re-rooted onto a lightweight entry the rich card body (content/media/polls/quotes/engagement/actions) is not shown — matching native focal entries, which are also lightweight. The collapsed-state single-parent `ParentContextTile` preview is unchanged.

Implemented in `gateway/src/routes/replies.ts`, `gateway/src/routes/external-items.ts` (the `?focus=` param + `deriveFocusItem`), `web/src/lib/api/feed.ts`, `web/src/lib/api/feeds.ts` (`externalItems.thread(id, focus?)`), `web/src/hooks/useConversation.ts`, `web/src/hooks/useExternalThread.ts` (per-`(item, focus)` cache), and `web/src/components/workspace/{ConversationView,ExternalAncestorRail,ExternalPlayscriptThread,ExternalPlayscriptEntry,VesselCard}.tsx`.

---

## Addendum — focal-conversation robustness hardening (2026-05-30)

Follow-up to the focal-conversation / external-refocus addendum above, addressing the
review findings logged in `FEED-CHANGES-BUILD-PLAN.md`. No behavioural change to the
documented model; these are correctness/robustness guarantees around it.

- **Cycle-safe client thread walks.** `ConversationView`'s ancestor walk and descendant
  DFS now carry a visited `Set`, so a corrupt `parentEventId` cycle (or self-parent) can
  no longer loop forever and hang the tab. The external rail/thread render flat
  server-provided lists (no recursion), so they instead **dedupe entries by id** to keep
  React `key`s unique if a malformed chain repeats a node.
- **Bounded caches.** The server thread cache (`gateway/src/routes/external-items.ts`)
  embeds the attacker-controlled `focus` query param in its key, so it now writes through
  `setThreadCache()` — a 1000-entry cap that sweeps expired entries first, then evicts
  oldest insertions. The two client neighbourhood caches (`useConversation`,
  `useExternalThread`) gained a 60s TTL + 200-entry cap; `useConversation` also deletes the
  stale entry **before** a `refreshKey` refetch so a concurrent mount can't read pre-reply
  nodes mid-refresh.
- **Focal-node lifecycle.** A `refreshKey` bump (publishing a reply) no longer yanks a
  re-rooted reader back to the conversation root — the reset effect keys on `hostEventId`
  only. If a refetch drops the focal node (deleted upstream / stale id), the view falls
  back to the root instead of rendering ancestors above an empty gap.
- **`AuthorModal` dismiss.** Clicking the card to dismiss the author popover no longer also
  toggles the card's expand handler: the outside-`pointerdown` handler registers a one-shot
  capture-phase click swallower (0ms cleanup so only this gesture is caught). The pip
  trigger still toggles normally (anchor case returns early).
- **`focus` scoping note (atproto).** The thread-route comment no longer claims "ownership
  scoping" for atproto: `focus` is an unverified `at://` URI, i.e. an authed read-proxy for
  any public Bluesky thread on the pinned AppView host — no SSRF (host is fixed), and the
  data is already public.
- **Media affordance.** A poster-less video in expanded media renders a "▶ Watch video"
  link rather than vanishing silently.

Still open (tracked in the build plan): cosmetic non-adjacent-parent arrow ordering between
native (DFS) and external (chronological) descendants; unbounded `GET /conversation/:eventId`
comment fetch (inherited from `/replies`); and backend test coverage for
`/conversation/:eventId` + `deriveFocusItem`.

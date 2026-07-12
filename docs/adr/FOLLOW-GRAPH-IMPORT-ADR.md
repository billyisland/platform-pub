# Follow-Graph Import — onboarding your existing reading life from any network

**Status:** Accepted in design discussion (2026-07-12). **Nothing built.** This document records the model, the per-source scoping, and the phasing. Feasibility survey done against source 2026-07-12 (file refs below verified at that date).

**Scope:** When a user arrives at all.haus already following people elsewhere — Bluesky, Mastodon, Nostr, an RSS reader — give them a way to bring that follow graph in as a feed. Covers all current ingestible source protocols (`atproto`, `activitypub`, `nostr_external`, `rss`) plus the explicit non-case (`email`). Out of scope: pushing all.haus feed edits *back* to any network as follows/unfollows (§4 D3 forbids it), Lemmy/threadiverse community subscriptions (§5.5 stub), continuous background sync (deferred, §8 Phase 4 trigger).

---

## 1. Thesis

Linking a satellite account today (NETWORK-CONCIERGE-ADR) gives the user **outbound** reach — they can post to Bluesky or Mastodon from all.haus. But the **inbound** half of their existing life on that network — the people they follow, curated over years — is stranded. There is currently no surface anywhere in the product where those relationships appear.

The fix is not a new concept. In all.haus, *following an external author already is feed membership*: the `external_subscriptions` row is a projection of "this source sits in ≥1 of my feeds", maintained solely by `addSource`/`removeSource` (the feed-derived invariant, CLAUDE.md / UNIVERSAL-FEED-ADR). So "import my Mastodon follows" translates exactly to "create a feed and add each followed account as a source." The import feature is a *translation layer*, not a parallel follow system.

This is also the missing half of an existing symmetry: we already publish the user's all.haus external follows **outward** as a Nostr kind-3 list (`markFollowListDirty` → discovery sweep). Import is the same graph flowing **inward**. And it is the reader-side twin of the writer-side import tooling (Substack → NIP-23, CONSOLIDATED-TODO §3.5): both attack switching cost, which is the launch-cohort problem.

Per the omnivorous-input commitment ("all means all"): whatever identity artifact the user arrives holding — an OAuth grant, a public handle, an npub, an OPML file — we can rebuild their reading life from it. Import must therefore not be gated on account linking where the graph is public (atproto, Nostr, most ActivityPub); linking is *one trigger*, not the mechanism.

---

## 2. Current-state baseline (verified 2026-07-12)

| Capability | State | Evidence |
|---|---|---|
| Global deduped source rows | ✅ | `external_sources` unique on `(protocol, source_uri)`; per-user linkage is `external_subscriptions` + `feed_sources` (schema.sql `unique_source` / `unique_subscription`) |
| Single-source add path | ✅ | `addSource` (`gateway/src/routes/feeds/sources.ts`): accepts `(protocol, sourceUri)`, normalises + **synchronous liveness probe** per source (`gateway/src/lib/source-liveness.ts`, resolver-audit F1), per-owner advisory lock `feed_sub:<ownerId>`, enqueues subscribe-time ingest job |
| Bulk add path | ❌ | `POST /feeds/:id/sources` is one source per request; no batch endpoint, no async import job |
| Read Bluesky follows | ✅ trivially | `app.bsky.graph.getFollows` on the public AppView needs only the DID — already stored in `network_presences.external_id`; no token, no scope |
| Read Mastodon follows | ✅ scope already granted | `MASTODON_SCOPES = "read:accounts write:statuses"` (`gateway/src/routes/linked-accounts.ts`) covers `GET /api/v1/accounts/:id/following` with the stored token |
| Read Nostr follows | ✅ public | kind-3 contact list on relays; needs only an npub — no link flow exists for external Nostr and none is needed |
| Read RSS "follows" | ✅ as a file | OPML export is the standard artifact from every feed reader |
| Post-link hook points | ✅ | the two `network_presences` upsert sites in `linked-accounts.ts` (Mastodon callback, Bluesky callback) |
| Atproto ingest at scale | ✅ | Jetstream listener flips to wildcard firehose + client-side filtering above `WILDCARD_DID_THRESHOLD = 150` DIDs; no hard cap (`feed-ingest/src/jetstream/listener.ts`) |
| ActivityPub ingest at scale | ⚠️ the real cost | per-source outbox polling from a **global** budget: 100 due sources/60s tick, max 2/host/tick (`feed-ingest/src/tasks/feed-ingest-poll.ts`) — no per-user fairness; one 500-follow import can starve the queue |
| Caps | none | no sources-per-feed or feeds-per-user limit exists; import is the first thing that stresses that assumption |
| Prior art | none | no code or ADR discusses importing/syncing a follow graph *from* a satellite; the kind-3 machinery is the export direction |

---

## 3. The user-visible model

**Link (or paste a handle), get offered a feed.** On completing an account link — or on submitting any resolvable identity in the import surface — all.haus offers: *"Import the N accounts you follow on Bluesky as a new feed?"* Accepting creates one new feed (named for the origin: "Bluesky follows", "Mastodon follows", …) and populates it, one source per followed account, as a background job with visible progress. Declining does nothing and the offer remains reachable later (Network panel, FeedComposer).

**Thereafter it is an ordinary feed.** Retune volumes, mute sources, move sources to other feeds, dump the lot into another feed and delete the original — all existing affordances, no special casing. The feed-derived invariant handles source lifecycle for free (a source leaving the user's last feed drops the subscription and orphans the shared row).

**It remembers where it came from.** The feed carries an origin binding (protocol + remote identity + `last_synced_at`). A **"Sync now"** action re-reads the remote graph, shows the diff (*+12 newly followed, −3 unfollowed*), and applies it on confirmation. Local removals are recorded as **exclusions**: re-sync never resurrects a source the user deliberately removed here. Volume/mute edits are per-feed display settings, orthogonal to membership — they never interact with sync. Deleting the feed deletes the binding and its exclusions.

**Sync is strictly one-way: network → all.haus.** Removing a source from a feed never unfollows anyone on the origin network. (Silently unfollowing a real person on another platform because a user reorganised a feed would be destructive and unforgivable.)

---

## 4. Decisions

- **D1 — Import materialises as one new feed per import run.** Never scattered into existing feeds by default; the user redistributes afterward with existing tools. (v1 offers no "merge into existing feed" option — see §9.)
- **D2 — Import flows through the `addSource` core.** The feed-derived invariant says only `addSource`/`removeSource` write `external_subscriptions`; a bulk import that re-implements the write is how that invariant dies. The import engine calls the same in-process function, batched, with the liveness policy of D6.
- **D3 — One-way sync only** (network → all.haus). No write-back of follows/unfollows to any origin network, ever. (The inverse flow — all.haus follows published outward — already exists for Nostr as the kind-3 list and stays as-is.)
- **D4 — Exclusion-aware re-sync, no mode fork.** The origin binding is not broken by local edits. Membership removals append to an exclusion list; re-sync = (remote graph − exclusions) diffed against current membership. This gives "keep it synced *and* tinker" without a synced/detached mode the user has to understand.
- **D5 — Snapshot first, manual "Sync now" second, continuous sync deferred** (possibly forever — §8 Phase 4 states the build trigger). The snapshot is ~90% of the value; the diff-preview re-sync is cheap once the snapshot engine exists; a background job that mutates the user's feeds without them watching is the part most likely to surprise, so it earns its way in last.
- **D6 — Graph membership is liveness evidence.** An account appearing in the user's (authenticated or public) follow list is strong evidence it exists; the import path **skips the synchronous per-source liveness probe** (500 serial probes at link time is a non-starter) and relies on the poller's existing failure handling to mark the stragglers dead. **Exception: OPML** — reader exports rot; those URLs get probed (async, tolerant), and dead entries are reported in the import summary rather than silently dropped.
- **D7 — Opt-in, never automatic.** Someone linking Mastodon for outbound cross-posting must not wake up to 800 ingesting sources. The post-link prompt, the onboarding step, and the Network-panel affordance all require an explicit yes.
- **D8 — Not gated on linking where the graph is public.** atproto (any handle), Nostr (any npub/NIP-05), and non-hidden ActivityPub accounts import from a pasted identity via the universal resolver; the OAuth link is required only where the graph is private (a Mastodon account with hidden follows → prompt to link).

---

## 5. Per-source scoping (the "all means all" matrix)

| Protocol | Graph artifact | Read path | Auth | Ingest cost | Phase |
|---|---|---|---|---|---|
| `atproto` | follows | `app.bsky.graph.getFollows`, public AppView, paginated (~100/page) | none — DID only (from link **or** resolved pasted handle) | low — Jetstream wildcard mode scales | 1a |
| `nostr_external` | kind-3 contact list | relay query, public | none — npub/NIP-05 only | low — relay subscriptions | 1b |
| `activitypub` (Mastodon-API) | following list | authed `GET /api/v1/accounts/:id/following` (linked token, always works for self) **or** the public endpoint for a pasted handle (fails if follows hidden → offer link) | `read:accounts` already granted on link | **high — the real work**: per-source outbox polling; needs poller fairness (§6.4) | 1c |
| `rss` | OPML file | file upload, parse outlines | none | medium — each outline is a polled source; OPML **folders map to one feed per folder**, the only import that naturally yields several feeds | 1d |
| `activitypub` (Lemmy/threadiverse) | subscribed communities | Lemmy API, needs its own auth (no OAuth link exists) | n/a today | — | deferred stub (§5.5) |
| `email` | none | — | — | — | N/A (§5.6) |

### 5.1 atproto (Bluesky) — cheapest, first

DID from the `network_presences` row (linked/assisted) or resolved from a pasted handle (`atproto-resolve.ts` already reads the public AppView). Page through `getFollows`; each follow → `addSource(protocol: 'atproto', sourceUri: <did>)`. Ingestion is the well-behaved path: the Jetstream listener already crosses into wildcard-firehose mode above 150 tracked DIDs with client-side filtering — hundreds of imported DIDs is bandwidth, not a wall. Subscribe-time backfill jobs must be staggered (§6.4).

### 5.2 Nostr — the paste-an-npub path

There is no "link Nostr" flow (the canonical identity is the custodial root, NETWORK-CONCIERGE-ADR §1) and none is needed: a kind-3 contact list is public. The user pastes their pre-existing npub / NIP-05 into the import surface; we fetch kind 3 from relays; each `p` tag → `addSource(protocol: 'nostr_external', sourceUri: <canonical npub>)`.

Invariants bite here, deliberately:
- **Relay-free identity** (CLAUDE.md): the source identity is the bare npub/hex pubkey, never relay-hinted. A kind-3 tag's optional relay hint may seed `relay_urls` (connection metadata `addSource` already accepts) but never the identity.
- **The published kind-3 loop closes**: imported `nostr_external` adds fire `markFollowListDirty` like any other, so — for an opted-in account — the user's all.haus root identity republishes a kind 3 that now *includes their old identity's graph*. This is a feature (graph migration from the old npub to the custodial root), not a side effect; it rides the existing `DISCOVERY_PUBLISH_ENABLED` × `discovery_enabled` × `publish_follow_graph` gates unchanged.
- **Scale warning**: kind-3 lists run to thousands. The per-import cap (§6.5) matters most here; truncation is surfaced, never silent.

### 5.3 ActivityPub (Mastodon-API instances) — the engineering center of gravity

Reading the graph is easy (token already scoped; public fallback for pasted handles unless follows are hidden; Mastodon paginates at 40–80/page via Link headers). **Ingesting it is the cost**: every followed account becomes a polled outbox source competing in a global 100/tick, 2/host/tick budget — and imports concentrate on big instances (500 mastodon.social follows at 2/tick ≈ hours to first-poll them all, while starving every other user's AP sources). Phase 1c is therefore gated on the §6.4 fairness work, not just the import engine. All fetches through the hardened SSRF client (`shared/src/lib/http-client.ts`) — non-negotiable, these are user-supplied remote hosts.

### 5.4 RSS — OPML upload

No social graph; the artifact is the OPML file every reader (Feedbin, Inoreader, NetNewsWire, …) exports. Parse outlines → `addSource(protocol: 'rss', sourceUri: <feed url>)`. Two deltas from the graph protocols: OPML **folders** map to one feed per folder (the user's own curation, already in feed-shaped form — honor it, with a per-import feed cap to stop a 40-folder file minting 40 feeds without confirmation), and D6's liveness exception applies (probe, tolerate, report dead entries in the summary). No sync semantics — OPML is a snapshot by nature; "Sync now" doesn't apply (re-import = new run).

### 5.5 Lemmy / threadiverse — named stub, deferred

The analogue is subscribed *communities*, not followed people; reading them needs Lemmy's own auth (JWT — no OAuth link flow exists) and community-as-source has its own product questions. Deferred until a Lemmy link flow exists; recorded here so the omission is a decision, not an oversight.

### 5.6 Email — explicitly N/A

Newsletter subscriptions live in the *sender's* list, not anywhere the user can export a graph from. The onboarding story for email is the existing ingest address (subscribe your newsletters to it). Mining a Gmail inbox to detect newsletters is technically possible and **out of scope** (privacy posture completely different from reading a public follow list).

---

## 6. Mechanics (shared machinery — Phase 0)

### 6.1 The import engine lives in the gateway

The `addSource` core is gateway code, and D2 forbids re-implementing its writes. The import engine is an in-gateway async processor (the existing gateway-scheduler sweep pattern — cf. `runDiscoverySweep` — advisory-locked, processing pending imports in batches), calling `addSource` directly in-process. **Not** a feed-ingest graphile task (that would mean either an HTTP self-call per source or duplicating the invariant-bearing write path).

Batching: ~25 sources per batch, each batch under the existing per-owner `feed_sub:<ownerId>` advisory lock — never one lock held across the whole import (it would starve the user's interactive adds for minutes).

### 6.2 `follow_imports` job table

One row per import run: `id, account_id, protocol, origin_identity, feed_id, status (pending|running|done|failed), total, imported, skipped, failed, created_at, finished_at`. Progress is polled by the client and surfaced on the created feed (FeedComposer / vessel) — an import of hundreds of sources takes real time and must look alive, not hung. Failure of individual sources never fails the run; the summary reports them.

### 6.3 Origin binding + exclusions (recorded from Phase 1, consumed from Phase 2)

`feed_import_bindings` (`feed_id` PK/FK-cascade, `protocol`, `origin_identity`, `last_synced_at`) and `feed_import_exclusions` (`feed_id`, `protocol`, canonical remote identity; unique per pair). Phase 1 **writes** the binding at import time even though nothing reads it yet, so feeds imported before Phase 2 ships are sync-capable retroactively. `removeSource` on a bound feed appends the removed source's canonical identity to exclusions (the one hook Phase 1 adds outside the import path itself). Deleting the feed cascades both tables.

"Sync now" (Phase 2): fetch remote graph → canonical set minus exclusions → diff against current feed membership → present `+N / −M` → on confirm, apply via `addSource`/`removeSource`. Idempotent, restartable, same engine as the initial snapshot with a non-empty starting set.

### 6.4 Poller fairness (co-requisite for Phase 1c)

`feed-ingest-poll.ts` gains per-subscriber fairness so one import cannot monopolise the global AP budget: round-robin the due-source selection across subscribers (or cap any one subscriber's share of the 100/tick budget), keeping the existing 2/host/tick throttle. Additionally the import engine **staggers** initial `fetch_interval` / first-due times with jitter, and dribbles the subscribe-time ingest jobs rather than enqueueing hundreds at once (the existing `feed_ingest_backfill_<id>` / `feed_ingest_<id>` distinct-job-key discipline is unchanged).

### 6.5 Caps and volume defaults

- **Per-import cap** (v1: 1000, most-recently-followed first). Truncation is stated in the offer and the summary — never silent (the no-silent-caps rule).
- **Volume default**: an imported feed above ~50 sources defaults to sampled volume (the existing RANDOM/TOP per-feed-source machinery) with a one-line explanation; a 500-source feed at full volume is unreadable and would read as a bug.
- **OPML**: per-import feed cap (folders beyond it fold into one feed) with confirmation.

### 6.6 Flags

`FOLLOW_IMPORT_ENABLED` operator master switch, dark-shippable per house pattern. Per-protocol sub-flags only if a specific protocol needs an independent brake (likely `activitypub`, pending the fairness work proving out).

---

## 7. Surfaces

1. **Post-link prompt** (Phase 1): on the two OAuth-callback completions in `linked-accounts.ts`, the success redirect carries the offer; the client renders *"Import the N accounts you follow…?"*. Requires a cheap follow-count read at callback time (or lazily on prompt render).
2. **Network panel** (Phase 1): `NetworkReachPanel` gains an "Import follows" affordance per linked presence, plus the paste-an-identity path for unlinked-but-public graphs (D8).
3. **FeedComposer** (Phase 1): the "Add a source" field's resolver already classifies handles/npubs; an input that resolves to an *account with a readable graph* additionally offers "…or import everyone they follow" — note this also enables importing **someone else's** public follow graph (a curated starter pack, e.g. "seed a feed from this person's follows"), which falls out of D8 for free and is deliberately allowed for public graphs.
4. **Onboarding — "Bring your world"** (Phase 3): a signup-flow step presenting the omnivorous input (paste any handle / npub / @user@instance / feed URL, or upload OPML) → resolver classifies (new `import` context for `POST /api/resolve`) → offers the feed. Lands alongside the writer-onboarding wizard work (CONSOLIDATED-TODO §3.3) — the reader-side half of the same first-session problem.

---

## 8. Phasing

- **Phase 0 — engine + safety rails** (no user-visible import): gateway import engine reusing the `addSource` core with D6 liveness policy; `follow_imports` + binding/exclusion tables (one migration); poller fairness + stagger (§6.4); caps + volume defaults (§6.5); `FOLLOW_IMPORT_ENABLED`.
- **Phase 1 — snapshot imports**, in cost order:
  - **1a atproto**: post-link prompt + pasted-handle path. Cheapest, no token, ingestion already scales — the proving ground for the engine.
  - **1b Nostr**: pasted npub/NIP-05 → kind-3 import. Exercises the relay-free identity discipline and the kind-3 republish loop.
  - **1c ActivityPub**: post-link prompt (stored token) + public fallback. Gated on §6.4 fairness having shipped and been observed under 1a/1b load.
  - **1d OPML**: upload, folder→feed mapping, probe-and-report liveness.
- **Phase 2 — "Sync now"** for the three graph protocols: diff preview, exclusion-aware apply, `last_synced_at`. (Bindings already recorded since Phase 1.)
- **Phase 3 — onboarding integration**: the "Bring your world" signup step + `import` resolver context; coordinate with the onboarding-wizard build (CONSOLIDATED-TODO §3.3).
- **Phase 4 — deferred, each with a stated trigger**: continuous background sync (trigger: demonstrated organic "Sync now" usage — do not build speculatively); Lemmy/threadiverse community import (trigger: a Lemmy link flow existing); anything email-derived (trigger: none foreseen — see §5.6).

---

## 9. Open questions (decide before the relevant phase, not now)

1. **Per-import cap value** (§6.5, v1 proposal 1000) and the sampled-volume threshold (~50) — tune against real imports in Phase 1a.
2. **Merge-into-existing-feed** at import time — v1 says no (D1); revisit if users demonstrably create-then-merge by hand.
3. **AP public fallback** (D8) — worth keeping if the hidden-follows failure rate is low; if most pasted Mastodon handles fail, demote to link-only and simplify.
4. **Someone-else's-graph imports** (§7.3) — allowed by design for public graphs; confirm no abuse vector emerges (it creates sources/load attributable to the importing user, within their own caps, so the exposure is bounded by the same rails as self-import).
5. **Import prompt count accuracy** — showing "N accounts" needs a graph read before consent; decide whether to read eagerly at callback time or show a countless offer that resolves N after opt-in.

---

## 10. Invariants upheld (checklist against CLAUDE.md)

- **Feed-derived external subscriptions** — import writes only through `addSource`; exclusion bookkeeping hooks `removeSource`; no standalone subscription surface is (re)introduced.
- **Relay-free Nostr identity** — kind-3 relay hints go to `relay_urls` metadata only, never into source identity.
- **SSRF hardening** — every graph/OPML/outbox fetch through `shared/src/lib/http-client.ts`.
- **Omnivorous input** — the import surface accepts any identity artifact and routes through the universal resolver (new `import` context).
- **No silent caps** — truncation, skips, and dead OPML entries are all surfaced in the offer/summary.
- **New invariants this ADR introduces** (add to CLAUDE.md when Phase 1 ships): follow-graph sync is one-way inbound (never write follows back to an origin network); imports are opt-in per run (no automatic graph materialisation on link).

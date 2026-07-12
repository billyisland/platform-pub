# Follow-Graph Import — onboarding your existing reading life from any network

**Status:** Accepted in design discussion (2026-07-12). This document records the model, the per-source scoping, and the phasing. Feasibility survey done against source 2026-07-12 (file refs below verified at that date). **Scoped for implementation 2026-07-12** (§11): every §2 claim was re-verified against source; §§2–9 carry same-date *[Scoping amendment]* notes where the code sharpened or corrected the design, and §11 holds the concrete build plan (prerequisite refactors, migration contents, per-phase file lists). **Phase 0 + the 1a/1b backend BUILT 2026-07-12** (dark behind `FOLLOW_IMPORT_ENABLED`): the §11.1 refactors, migration 153, the engine + sweep + `POST/GET /follow-imports` routes, both §6.4 stampede fixes, and the atproto/Nostr graph readers — FIX-PROGRAMME 2026-07-12. **Phase 1a/1b web surfaces BUILT 2026-07-12** (same flag, second entry in FIX-PROGRAMME same date): the three §7 surfaces (post-link offer riding `&follows=` on the Bluesky callback redirect → `PostLinkImportOffer`; NetworkReachPanel per-presence "Import follows" + the paste-an-identity `FollowImportSection`; FeedComposer "…or import everyone they follow"), the `followImportProtocols` capabilities gate, `useFollowImportRun` + `FollowImportStatus` progress polling, and live-workspace feed adoption (`useFeedArrivals`). The §10 invariants are now in CLAUDE.md. **Phase 1d OPML BUILT 2026-07-12** (same flag, third entry in FIX-PROGRAMME same date): jsdom-based parser/planner (`gateway/src/lib/opml.ts` — folder→feed mapping, `OPML_MAX_FEEDS` 10 with overflow folded into the base feed, invalid entries counted, 1000-cap in plan order), `POST /follow-imports/opml` (one run per planned feed, **no sync binding** per §5.4), the engine's rss probe-on policy (D6 exception — dead entries → `failed`), the `followImportOpml` capability, and the `FollowImportSection` upload block (preview/confirm → multi-run progress via `useOpmlImport`). Remaining: 1c ActivityPub (live scope check first; gated on §6.4 soak), Phase 2 "Sync now", Phase 3 onboarding.

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
| Single-source add path | ✅ but not yet a seam | `addSource` (`gateway/src/routes/feeds/sources.ts:228`): accepts `(protocol, sourceUri)`, normalises + **synchronous liveness probe** per source (`gateway/src/lib/source-liveness.ts`, resolver-audit F1), per-owner advisory lock `feed_sub:<ownerId>`, enqueues subscribe-time ingest job. *[Scoping amendment]* `addSource` is **module-private** (only its route handler calls it) and there is **no `removeSource` function at all** — the teardown lives inline in the DELETE handler (`sources.ts:656-743`). Phase 0 exports the former and extracts the latter (§11.1) |
| Bulk add path | ❌ | `POST /feeds/:id/sources` is one source per request; no batch endpoint, no async import job |
| Read Bluesky follows | ✅ trivially | `app.bsky.graph.getFollows` on the public AppView needs only the DID — already stored in `network_presences.external_id`; no token, no scope |
| Read Mastodon follows | ✅ likely — verify live | `MASTODON_SCOPES = "read:accounts write:statuses"` (`gateway/src/routes/linked-accounts.ts:39`); Mastodon's following-accounts controller authorises `:read, :'read:accounts'`, so the granted scope should cover `GET /api/v1/accounts/:id/following`. *[Scoping amendment]* Verify against a live instance **before building any 1c UI**: if the scope is insufficient, every existing link needs a re-consent flow to gain a new scope — a user-facing cost this ADR otherwise doesn't budget for |
| Read Nostr follows | ✅ public | kind-3 contact list on relays; needs only an npub — no link flow exists for external Nostr and none is needed |
| Read RSS "follows" | ✅ as a file | OPML export is the standard artifact from every feed reader |
| Post-link hook points | ✅ | the two `network_presences` upsert sites in `linked-accounts.ts` (Mastodon callback, Bluesky callback) |
| Atproto ingest at scale | ✅ | Jetstream listener flips to wildcard firehose + client-side filtering above `WILDCARD_DID_THRESHOLD = 150` DIDs; no hard cap (`feed-ingest/src/jetstream/listener.ts`) |
| ActivityPub ingest at scale | ⚠️ worse than first surveyed | per-source outbox polling from a **global** budget: 100 due sources/60s tick, max 2/host/tick (`feed-ingest/src/tasks/feed-ingest-poll.ts`). *[Scoping amendment]* The starvation is total, not AP-scoped: the due-source query is `ORDER BY last_fetched_at ASC NULLS FIRST LIMIT 100` and the per-host cap is applied **after** selection, in JS — so a 500-source single-host import fills the whole 100-row selection window with its own never-fetched rows every tick, the host cap passes 2 of them, and the tick enqueues **2 jobs system-wide** (all protocols, all users) until the backlog drains (~4h). Fix is cheaper than feared — §6.4 |
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
- **D6 — Graph membership is liveness evidence.** An account appearing in the user's (authenticated or public) follow list is strong evidence it exists; the import path **skips the synchronous per-source liveness probe** (500 serial probes at link time is a non-starter) and relies on the poller's existing failure handling to mark the stragglers dead. **Exception: OPML** — reader exports rot; those URLs get probed (async, tolerant), and dead entries are reported in the import summary rather than silently dropped. *[Scoping amendment]* Three mechanics the code adds to this decision: (1) the only probe-skip today is the process-wide env `SOURCE_LIVENESS_ENFORCED=0` (`source-liveness.ts:64`) — Phase 0 adds a per-call `skipProbe` option to `addSource` instead; (2) skipping the probe is only free where the graph read already yields the canonical stored form — true for atproto (`getFollows` returns DIDs) and Nostr (kind-3 `p` tags are hex pubkeys), **not for ActivityPub**, whose stored form is the actor URI while Mastodon's following list returns `acct`/`url` — each AP import costs ~1 WebFinger GET for canonicalisation (`resolveWebFinger`, `activitypub-resolve.ts:33`; batched + per-host-throttled in the engine; check at build time whether newer Mastodon includes an actor `uri` on the Account entity); (3) with the probe gone, nothing backfills display labels — the engine must pass the graph read's handle/displayName/avatar through `addSource`'s existing `displayName`/`avatarUrl` fields, or atproto sources land labelled `did:plc:…`. Nostr kind-3 carries no metadata; labels self-heal via the ingest kind-0 fetch within minutes (say so in the summary UI).
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
- **Scale warning**: kind-3 lists run to thousands. The per-import cap (§6.5) matters most here; truncation is surfaced, never silent. *[Scoping amendment]* kind-3 `p` tags are append-ordered (oldest first), so "most-recently-followed first" means taking the **tail** N tags, not the head. The gateway already has the fetch machinery: `fetchNostrEvents(relays, filters)` (`gateway/src/lib/nostr-relay.ts:29`) takes arbitrary filters — a kind-3 helper is a few lines (newest event wins across the fallback-relay race, `p` tags deduped).

### 5.3 ActivityPub (Mastodon-API instances) — the engineering center of gravity

Reading the graph is easy (token already scoped — pending the §2 live scope check; public fallback for pasted handles unless follows are hidden; Mastodon paginates at 40–80/page via Link headers). **Ingesting it is the cost**: every followed account becomes a polled outbox source competing in a global 100/tick, 2/host/tick budget — and imports concentrate on big instances; per the amended §2 row, a 500-follow single-host import throttles the **entire poller** (all protocols) to ~2 jobs/min, not just other AP users. Phase 1c is therefore gated on the §6.4 fairness work, not just the import engine. All fetches through the hardened SSRF client (`shared/src/lib/http-client.ts`) — non-negotiable, these are user-supplied remote hosts.

*[Scoping amendments]* Three build facts: (1) **canonicalisation** — the following list yields `acct`/`url`, the stored form is the actor URI, so each account costs ~1 WebFinger GET in the engine (D6 amendment); (2) **hidden-follows detection is free** — the public endpoint returns an *empty list*, not an error, when `hide_collections` is set, so detect "0 results but actor `following_count` > 0" (`activitypub-resolve.ts:119`) and surface the link-to-import prompt, else D8's public fallback silently imports nothing; (3) the authed-call pattern to copy is `fetchMastodonProfile` (`linked-accounts.ts:923-937` — bearer token via `safeFetch`), with the token decrypted from `network_presences.credentials_enc`.

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

Batching: ~25 sources per batch. *[Scoping amendment]* The lock discipline falls out of the existing code for free: `addSource` takes its own short per-call `pg_advisory_xact_lock('feed_sub:<ownerId>')` inside its own transaction (`sources.ts:293/:378`), which already gives the never-hold-long property — "batch" is progress-update granularity, not lock granularity. The sweep must loop batches **within one invocation** (advisory try-lock prevents overlap): at one batch per 60s tick, a 1000-source import would take ~40 minutes.

### 6.2 `follow_imports` job table

One row per import run: `id, account_id, protocol, origin_identity, feed_id, status (pending|running|done|failed), total, imported, skipped, failed, created_at, finished_at` — *[Scoping amendment]* **plus `identities jsonb` and `cursor int`**. The counter columns alone don't make the sweep restartable: if the gateway restarts mid-run, re-reading the remote graph is slow and non-deterministic (it may have changed under the run). `POST /follow-imports` reads the graph once, caps it, and persists the resolved identity list (with display metadata — bigger rows, but resume and summary rendering become self-contained) on the row; the sweep resumes deterministically from `cursor`, and idempotency comes free from `feed_sources`' partial uniques + the subscription upsert (`DUPLICATE` → `skipped++`). Progress is polled by the client and surfaced on the created feed (FeedComposer / vessel) — an import of hundreds of sources takes real time and must look alive, not hung. Failure of individual sources never fails the run; the summary reports them.

### 6.3 Origin binding + exclusions (recorded from Phase 1, consumed from Phase 2)

`feed_import_bindings` (`feed_id` PK/FK-cascade, `protocol`, `origin_identity`, `last_synced_at`) and `feed_import_exclusions` (`feed_id`, `protocol`, canonical remote identity; unique per triple). Phase 1 **writes** the binding at import time even though nothing reads it yet, so feeds imported before Phase 2 ships are sync-capable retroactively. `removeSource` on a bound feed appends the removed source's canonical identity to exclusions (the one hook Phase 1 adds outside the import path itself). Deleting the feed cascades both tables.

*[Scoping amendment — the move endpoint is a third membership mutation.]* `POST /feeds/:id/sources/:sourceId/move` (`sources.ts:752`) relocates a source out of a feed without touching subscriptions. Moving a source *out of a bound feed* must also append the exclusion — otherwise re-sync re-adds it to the import feed, duplicating it across two feeds against the user's evident intent (the user who wants it back re-adds it or clears the exclusion). The hook needs one extra SELECT for the source's `(protocol, source_uri)` + a binding-existence check inside the existing transaction/lock, in both the delete and move paths.

"Sync now" (Phase 2): fetch remote graph → canonical set minus exclusions → diff against current feed membership → present `+N / −M` → on confirm, apply via `addSource`/`removeSource`. Idempotent, restartable, same engine as the initial snapshot with a non-empty starting set.

### 6.4 Poller fairness (co-requisite for Phase 1c)

*[Rewritten at scoping, 2026-07-12 — the code showed both a worse failure mode and a cheaper fix than the original subscriber-round-robin sketch.]*

Two distinct stampedes, each with a targeted fix:

**(a) The selection-window starvation** (amended §2 row): `feed-ingest-poll.ts:49-63` selects `ORDER BY last_fetched_at ASC NULLS FIRST LIMIT 100` and applies the per-host cap **afterwards**, in JS — so a large single-host import's never-fetched rows fill the whole window and the tick enqueues ~2 jobs system-wide. Fix, three parts: (1) **over-select** — raise the SELECT LIMIT well above the enqueue budget (or cap per host in SQL with a window function) so one host cannot monopolise the window before the host cap runs; (2) the import engine seeds a **synthetic `last_fetched_at`** (`now() + jitter − fetch_interval`) instead of NULL, staggering first-due times with zero schema change; (3) the existing 2/host + 100/tick caps stay unchanged. Per-subscriber round-robin is not needed for v1: sources are globally deduped and multi-subscriber, so "subscriber fairness" is ill-defined at the source level — host fairness covers the real concentration (big instances).

**(b) The subscribe-time job flood** — independent of the poll scheduler: `addSource` enqueues an **immediate** ingest job per source inside its transaction (`sources.ts:437-453`). A 500-source AP import means 500 immediate `feed_ingest_activitypub` jobs (each up to 1 actor + 20 page fetches, against graphile concurrency 10); atproto similarly enqueues 500 backfills (5 AppView pages each). `graphile_worker.add_job` supports `run_at` — thread an optional enqueue-delay/jitter through the new `addSource` options. The existing `feed_ingest_backfill_<id>` / `feed_ingest_<id>` distinct-job-key discipline is unchanged.

### 6.5 Caps and volume defaults

- **Per-import cap** (v1: 1000, most-recently-followed first). Truncation is stated in the offer and the summary — never silent (the no-silent-caps rule).
- **Volume default**: an imported feed above ~50 sources defaults to sampled volume (the existing RANDOM/TOP per-feed-source machinery) with a one-line explanation; a 500-source feed at full volume is unreadable and would read as a bug. *[Scoping amendment]* Mechanics: the default `feed_sources.weight` is 4.0 = step 5 = "show everything" (migration 082) and `insertSource` doesn't take a weight — the sampled default is a post-import bulk `UPDATE feed_sources SET weight/sampling_mode` on the new feed at run completion, not a per-insert flag.
- **OPML**: per-import feed cap (folders beyond it fold into one feed) with confirmation.

### 6.6 Flags

`FOLLOW_IMPORT_ENABLED` operator master switch, dark-shippable per house pattern. Per-protocol sub-flags only if a specific protocol needs an independent brake (likely `activitypub`, pending the fairness work proving out).

---

## 7. Surfaces

1. **Post-link prompt** (Phase 1): on the two OAuth-callback completions in `linked-accounts.ts` (the `network_presences` upserts at `:495-524` Mastodon / `:762-781` Bluesky), the success redirect carries the offer; the client renders *"Import the N accounts you follow…?"*. *[Scoping amendment]* The count is free (§9.5 closed): the Mastodon callback already calls `verify_credentials` (`fetchMastodonProfile`, `:923`) whose response includes `following_count`; atproto `getProfile` returns `followsCount` (`atproto-resolve.ts:176`). The delivery channel already exists too — both callbacks redirect to `${APP_URL}/settings?linked=<flag>`, which the settings shim forwards into the overlay and `SettingsPanel.bannerFor` consumes; the offer rides the same channel.
2. **Network panel** (Phase 1): `NetworkReachPanel` gains an "Import follows" affordance per linked presence, plus the paste-an-identity path for unlinked-but-public graphs (D8).
3. **FeedComposer** (Phase 1): the "Add a source" field's resolver already classifies handles/npubs; an input that resolves to an *account with a readable graph* additionally offers "…or import everyone they follow" — note this also enables importing **someone else's** public follow graph (a curated starter pack, e.g. "seed a feed from this person's follows"), which falls out of D8 for free and is deliberately allowed for public graphs.
4. **Onboarding — "Bring your world"** (Phase 3): a signup-flow step presenting the omnivorous input (paste any handle / npub / @user@instance / feed URL, or upload OPML) → resolver classifies (new `import` context for `POST /api/resolve`) → offers the feed. Lands alongside the writer-onboarding wizard work (CONSOLIDATED-TODO §3.3) — the reader-side half of the same first-session problem.

---

## 8. Phasing

- **Phase 0 — engine + safety rails** (no user-visible import): gateway import engine reusing the `addSource` core with D6 liveness policy; `follow_imports` + binding/exclusion tables (one migration); poller fairness + stagger, both stampedes (§6.4); caps + volume defaults (§6.5); `FOLLOW_IMPORT_ENABLED`. *[Scoping amendment]* Phase 0 also carries the **prerequisite refactors** the design assumed already existed: export `addSource` + give it an options bag (`skipProbe`, `enqueueRunAt`, display metadata), extract `removeSource` from the DELETE handler, extract a `createFeedForOwner` from the inline `POST /feeds` INSERT, and hook exclusions into delete **and move**. Full file-by-file plan: §11.
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
3. **AP public fallback** (D8) — worth keeping if the hidden-follows failure rate is low; if most pasted Mastodon handles fail, demote to link-only and simplify. *[Scoping note]* Detection is settled either way: empty list + nonzero `following_count` = hidden follows (§5.3 amendment); the open part is only the demote-or-keep call after real usage.
4. **Someone-else's-graph imports** (§7.3) — allowed by design for public graphs; confirm no abuse vector emerges (it creates sources/load attributable to the importing user, within their own caps, so the exposure is bounded by the same rails as self-import).
5. **Import prompt count accuracy** — **closed at scoping (2026-07-12): eager, it's free.** Mastodon's callback-time `verify_credentials` carries `following_count`, atproto `getProfile` carries `followsCount`, AP actor docs carry `following_count`, and for Nostr the kind-3 fetch *is* the count (§7.1 amendment). No lazy-count machinery.

---

## 10. Invariants upheld (checklist against CLAUDE.md)

- **Feed-derived external subscriptions** — import writes only through `addSource`; exclusion bookkeeping hooks `removeSource`; no standalone subscription surface is (re)introduced.
- **Relay-free Nostr identity** — kind-3 relay hints go to `relay_urls` metadata only, never into source identity.
- **SSRF hardening** — every graph/OPML/outbox fetch through `shared/src/lib/http-client.ts`.
- **Omnivorous input** — the import surface accepts any identity artifact and routes through the universal resolver (new `import` context).
- **No silent caps** — truncation, skips, and dead OPML entries are all surfaced in the offer/summary.
- **New invariants this ADR introduces** (add to CLAUDE.md when Phase 1 ships): follow-graph sync is one-way inbound (never write follows back to an origin network); imports are opt-in per run (no automatic graph materialisation on link).

---

## 11. Implementation scope (code-verified 2026-07-12)

Every §2 claim re-verified against source at this date; the *[Scoping amendment]* notes above carry the corrections. This section is the build plan. Migration numbering: latest applied is `152`, so this work starts at **`153`**.

### 11.1 Prerequisite refactors (Phase 0, before the engine)

The design talks about `addSource`/`removeSource` as callable seams; today neither is:

- **Export `addSource`** (`gateway/src/routes/feeds/sources.ts:228` — currently module-private, only its route handler calls it) and add an options bag: `skipProbe` (per-call D6 skip; the env `SOURCE_LIVENESS_ENFORCED=0` is process-wide and not usable per-request), `enqueueRunAt` (jitter for the subscribe-time job, §6.4b), and pass-through display metadata (D6 amendment — the schema already accepts `displayName`/`avatarUrl`).
- **Extract `removeSource(feedId, ownerId, sourceId)`** from the DELETE handler (`sources.ts:656-743` — last-feed teardown, subscription drop, orphaning, kind-3 retraction all live in the route closure). Both the route and the Phase 2 sync engine call it.
- **Exclusion hooks** in `removeSource` **and** the move handler (`sources.ts:752`): one extra SELECT for `(protocol, source_uri)` + binding check inside the existing transaction/`feed_sub:<ownerId>` lock (§6.3 amendment).
- **Extract `createFeedForOwner`** from the inline INSERT in `POST /feeds` (`gateway/src/routes/feeds/crud.ts:229-234`, `sort_rank = MAX+1`).

### 11.2 Migration `153_follow_imports.sql`

- `follow_imports`: `id, account_id FK→accounts, protocol, origin_identity, feed_id FK→feeds, status (pending|running|done|failed), total, imported, skipped, failed, identities jsonb, cursor int, error, created_at, finished_at` (§6.2 amendment: `identities`+`cursor` make the sweep restartable).
- `feed_import_bindings`: `feed_id PK/FK-cascade, protocol, origin_identity, last_synced_at`.
- `feed_import_exclusions`: `feed_id FK-cascade, protocol, identity`, UNIQUE on the triple.
- House drill: pg_dump-regen `schema.sql` + re-seed `_migrations` in one step, then `scripts/check-schema-drift.sh`.

### 11.3 Phase 0 — engine + rails (the big slice)

- New `gateway/src/lib/follow-import.ts`: `runFollowImportSweep` — claims pending/running rows, loops ~25-identity batches **within one invocation** (§6.1 amendment), calls `addSource` per identity (per-call short lock is already correct), updates counters, applies the >50-source volume default at completion (post-import bulk `UPDATE`, §6.5 amendment).
- New `gateway/src/routes/follow-imports.ts`: `POST /follow-imports` (validate origin → read graph → cap 1000 → persist run row + binding + `createFeedForOwner`), `GET /follow-imports/:id` (progress poll — copy the resolver's requestId-poll shape, `web/src/hooks/useResolverInput.ts`).
- `shared/src/lib/advisory-locks.ts`: `FOLLOW_IMPORT: 100007` (next free; 100003 stays skipped). Register the sweep in `gateway/src/index.ts` on the 1-minute `setInterval` + startup block via `withAdvisoryLock`, gated on `FOLLOW_IMPORT_ENABLED`.
- `feed-ingest/src/tasks/feed-ingest-poll.ts`: the over-select fairness fix (§6.4a); the engine-side stagger (synthetic `last_fetched_at`) needs no ingest change.
- Vitest coverage: engine batching/resume (kill mid-run, re-sweep), exclusion hooks (delete + move), idempotent re-import (`DUPLICATE` → skipped).

### 11.4 Phase 1 — per-protocol readers + surfaces

- **1a atproto (S/M)**: paginated `getFollows` sibling of `getProfile` in `gateway/src/lib/atproto-resolve.ts` (public AppView, `safeFetch`, ~100/page); post-link offer riding the `?linked=` → `SettingsPanel.bannerFor` channel; `NetworkReachPanel` "Import follows" + paste-a-handle path; FeedComposer "…or import everyone they follow" on resolver results (the resolver already returns canonical `sourceUri` per protocol in the shape `addSource` consumes); web `followImports` API client + progress hook.
- **1b Nostr (S)**: kind-3 helper in `gateway/src/lib/nostr-relay.ts` (`fetchNostrEvents` with `{kinds:[3], authors:[hex]}`; newest event wins; dedupe `p` tags; take the **tail** N under the cap — §5.2 amendment; tag relay-hints → `relayUrls` metadata only). Paste surface from 1a already classifies npub/NIP-05.
- **1c ActivityPub (M, gated on §6.4 having soaked under 1a/1b)**: **live scope check first** (§2 amendment — re-consent risk); following-list reader in `gateway/src/lib/activitypub-resolve.ts` (bearer pattern from `fetchMastodonProfile`, Link-header pagination, per-account WebFinger canonicalisation with per-host throttle, hidden-follows detection via empty-list + `following_count` > 0).
- **1d OPML (S/M)**: new XML dep (no OPML/XML parser exists anywhere; only `rss-parser`) — e.g. `fast-xml-parser` or a minimal outline parser; text-body upload endpoint feeding the same engine with the probe **on** but tolerant (async, dead entries in summary); folder→feed mapping with the per-import feed cap. *[Built 2026-07-12 — one correction: no new dep was needed; `jsdom` (already a gateway dependency) parses OPML in strict-XML mode (`gateway/src/lib/opml.ts`).]*

### 11.5 Phase 2 — Sync now (M)

A `sync` run kind in the same engine: fetch graph → subtract exclusions → diff against membership → `+N/−M` preview → apply via `addSource`/`removeSource` on confirm; stamp `last_synced_at`.

### 11.6 Ship-time bookkeeping

CLAUDE.md gains the two §10 invariants when Phase 1 ships; FIX-PROGRAMME log entry; CONSOLIDATED-TODO §3 item 6 amended per phase. House checks per change: root eslint at 0 errors, `next build` preflight before web commits, hairline tripwire on touched web files, schema drift guard after the migration.

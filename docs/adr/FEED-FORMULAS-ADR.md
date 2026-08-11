# Feed Formulas — a feed as a transmissible object

**Status:** Accepted in design discussion (2026-08-11). **Unbuilt.** This document records the model, the decisions, and the phasing; no code exists yet. Six decisions were settled with the operator in the design conversation (§4 D1/D2/D6/D7/D8/D9); the rest are derived from existing invariants and were not open questions.

**Hard dependency:** `CONSOLIDATED-TODO.md` §9.16 (retire the `reach` source kind) must land first. That item already names this feature as its justification — a `reach` row is deictic, resolving against `$1`, the caller, which is precisely what makes a feed containing one mean something different for everyone else. §9.16 is decided and pre-checked against prod but unbuilt (`gateway/src/routes/feeds/sources.ts:91` still accepts `sourceType: "reach"`).

**Scope:** Publishing a feed's *composition* as a transmissible artifact, and redeeming that artifact into a new working feed on another account. Covers the four portable source types (`account`, `publication`, `external_source`, `tag`), the explicit non-case (`email`-protocol external sources), and the absorption of the operator's starter-template mechanism. Out of scope: live-synced feeds (§4 D1 forbids it), merging a formula into an existing feed (§9), a public directory of formulas (§8 Phase 3), workspace sharing, and any write-back to an origin network.

---

## 1. Thesis

A feed is the only editorial claim this platform makes. `PRINCIPLES.md` puts it plainly — *the launch feed is the editorial position made operational* — and the product is built so that composing one is the central act. Yet a feed is today the least transmissible object in the system: every read is `WHERE owner_id = $1`, there is no share path, no export, and the one clone path that exists (`cloneFeedForOwner`, `gateway/src/routes/feeds/crud.ts:116`) is reachable only by a hand-set database flag.

So the platform's most considered artifact is also its most private. A member who spends a month assembling forty sources into something genuinely good cannot hand it to anyone. That is a strange place for a publishing platform to be, and it is not a deliberate stance — the design docs record it as deferred (`WORKSPACE-DESIGN-SPEC.md:214`), not as a principle.

**A formula is a feed's composition, published.** Not the feed, not its contents — the list of things it is made of, frozen at a moment, given a link, and redeemable by anyone with an account into an ordinary feed of their own. The clone engine that does this already exists and already crosses an owner boundary; what is missing is an object to clone *from* that is not itself somebody's live feed.

That last clause is the whole design. §0l has fired twice — the flagged template dragged into a merge (2026-07-22), then its hidden replacement deleted as a stray duplicate (inside 08-10 → 08-11) — and both times for one reason: **the shared thing was a `feeds` row, so it looked like a feed, so somebody tidied it away.** A formula is a different object in a different table with no rendering on the floor. The failure mode is designed out rather than guarded against, and the two hand-written delete guards retire with it.

---

## 2. Current-state baseline (verified 2026-08-11)

| Capability | State | Evidence |
|---|---|---|
| Feed clone engine | ✅ exists, operator-only | `cloneFeedForOwner(client, templateId, ownerId, sortRank)` (`crud.ts:116`) — copies name/appearance, every `feed_sources` row verbatim, upserts `external_subscriptions`, revives orphaned sources |
| Its only caller | ⚠️ hand-flagged | `seedStarterFeeds` (`crud.ts:190`), clones every `feeds.is_starter_template = true` for an owner with zero feeds. No UI sets the flag; the operator runs an `UPDATE` |
| Provenance columns | ✅ | `feeds.cloned_from_feed_id`, `feeds.is_starter_template` (schema.sql) |
| Provenance on the wire | ✅ | `from_starter` computed in `loadFeed`/`listFeedsForOwner`, shipped as `fromStarter` by `feedRowToResponse` (`feeds/shared.ts`), consumed by `ExplainOverlay.tsx:323` to fork the first-run copy |
| Cross-owner feed read | ❌ | every feed query is owner-scoped; `loadFeed(feedId, ownerId)` filters `WHERE f.id = $1 AND f.owner_id = $2` |
| Programmatic add seam | ✅ **already built** | `addSource` exported (`sources.ts:242`) with `AddSourceOptions` (`:131`) — `skipProbe`, `enqueueRunAt`; takes the `feed_sub:<ownerId>` advisory lock, upserts the subscription, revives orphans, enqueues the fetch job, fires `markFollowListDirty` for `nostr_external`, clears import exclusions. `removeSource` exported at `:628`. Both extracted by FOLLOW-GRAPH-IMPORT §11.1 |
| Add by existing id *or* by identity | ✅ both | `addSource` branches on `externalSourceId` vs `(protocol, sourceUri)`; the latter upserts `external_sources` and skips the liveness probe for a pair already held healthy |
| Bulk-add stampede brake | ✅ soaked | fetch jobs keyed per source (`externalFetchJobKey`) so concurrent adds coalesce, plus `enqueueRunAt` jitter (FOLLOW-GRAPH-IMPORT §6.4b) |
| Token-share prior art | ✅ | `gift_links` (article-level): token, `max_redemptions`, creator-scoped listing (`gateway/src/routes/gift-links.ts`) |
| Portable-artifact prior art | ✅ | OPML in (`gateway/src/lib/opml.ts` — `parseOpml`, `planOpmlImport`, `OPML_MAX_FEEDS`), behind `FOLLOW_IMPORT_ENABLED` |
| Public page chassis | ✅ | `components/public/` + the one nav row (LOGGED-OUT-REGISTER-ADR §IX) |
| Deictic source kind | ⚠️ blocker | `reach:following` / `reach:explore` resolve against the caller — §9.16 retires both |
| Per-subscriber secret on a source | ⚠️ hazard | `external_sources.ingest_address`, routed on by `gateway/src/routes/inbound-mail.ts:76` — see D5 |
| Caps | none | no sources-per-feed or feeds-per-account limit exists |

---

## 3. The user-visible model

**Publish.** From a feed's composer, *Publish as a formula*. A preview shows exactly what a recipient would receive — every source by name, the tuning, the colour scheme — and names anything that cannot travel. Confirming freezes that composition and returns a link.

**Send.** The link goes wherever the member wants it to go: a DM, an email, a post. There is no directory in v1 and no notification — the link travels out of band, which is why v1 needs no in-app sharing surface at all.

**Preview.** Opening the link shows the formula on the public chassis: name, description, who made it, the source list. A logged-out visitor sees the same page and the waitlist CTA. Nobody's items are shown — a formula is a composition, not a feed of content.

**Add.** *Add to my workspace* mints a new feed, fully owned and immediately editable, with every source resolved and subscribed. It sits at the end of the member's feed order like any other feed. It says, quietly, where it came from.

**Thereafter it is an ordinary feed.** Retune, mute, remove, merge, delete. The formula that produced it is frozen and unrelated; the author's later edits never reach it, and revoking the link never reaches it either.

---

## 4. Decisions

- **D1 — A formula is an immutable snapshot, and a redeemed feed is fully owned.** No live link, no background sync, no upstream that can reach into somebody's workspace. Publishing again mints a *new* formula rather than mutating the old one. Rationale: this is the §0l lesson generalised, and it matches the standing philosophy that local intent wins (FOLLOW-GRAPH-IMPORT D4/§11.5 — a deliberate local removal is never resurrected).
- **D2 — Token link only in v1.** One unguessable token per formula, one public preview page, no directory and no ranking. A curatorial object with a public popularity surface becomes a thing to game; `visibility` is a column so Phase 3 is a value, not a rewrite.
- **D3 — Redemption flows through the `addSource` core.** The feed-derived-subscription invariant says only `addSource`/`removeSource` write `external_subscriptions`; a bulk redeem that re-implements that write is how the invariant dies. **This is the one place `cloneFeedForOwner` must not be reused.** Its two documented departures from `addSource` — no `feed_sub` advisory lock, no fetch job — are licensed *entirely* by the zero-feeds precondition, and a member redeeming a formula has neither: they hold existing feeds, so a concurrent `removeSource` teardown can race the subscription upsert, and the formula may name sources that do not exist locally at all. Redemption is a sibling of the clone path, not a parameter on it.
- **D4 — Sources are stored by portable identity, never by local row id.** `cloneFeedForOwner` copies `external_source_id` — safe only because template and clone are minted in the same instant on the same instance. A formula is redeemed weeks later, may name a source the GC has since culled, and must one day serialise off-platform. So a formula source stores `(protocol, canonical uri)` / npub / publication id / tag string, and redemption *resolves* it through `addSource`'s `(protocol, sourceUri)` branch, which creates-or-finds the row. Slower per source; correct.
- **D5 — `email`-protocol sources never travel, and their absence is stated.** `external_sources.ingest_address` is a per-subscriber secret alias (`inbound-mail.ts:76`). Copying the row hands a recipient the author's private address; resolving it by identity would mint a new alias and subscribe them to a newsletter in the author's name. Both are unacceptable, so email sources are excluded at freeze time — **with a visible count on both the publish preview and the formula page** ("3 email sources can't be shared"). Silent omission is the wrong failure: an author would believe they had published their whole feed.
- **D6 — The starter template becomes a formula, and `feeds.is_starter_template` is retired.** The operator designates a formula as the default seed; `seedStarterFeeds` redeems it for an owner with zero feeds. This kills the twice-realised failure at the root: a formula has no `feeds` row to delete, no duplicate-looking twin on the floor, and its `source_feed_id` back-reference is `ON DELETE SET NULL`, so deleting the feed it was cut from leaves the formula whole. The merge and delete guards (409 `starter_template_source`) retire with the flag.
- **D7 — Attribution travels; counts do not.** A redeemed feed records and displays its origin ("from Billy Island's Long Reads"). The author is told nothing about uptake — no add count, private or public. An adoption metric on a curatorial object is an engagement surface by another name, and the platform's whole position is that there isn't one.
- **D8 — The serialisation format is committed now, the Nostr publish is built later.** Each formula source is stored as a NIP-51-set-shaped triple — tag kind, value, optional hint — so that publishing a formula as a signed replaceable event (via key-custody and the relay outbox, like every other outbound event) is a later phase and not a re-cut. The mapping is mechanical: native account and external-nostr → pubkey tag, hashtag source → hashtag tag, RSS/atproto/AP source → URL tag, publication → addressable-event tag. **The exact kind is deliberately unpinned** — a follow-set vs curation-set vs custom addressable kind is a question for the session that builds it, and nothing in the storage shape depends on the answer.
- **D9 — Redemption mints one new feed, never merges into an existing one.** The member redistributes afterwards with the existing merge and move tools. Same reasoning as FOLLOW-GRAPH-IMPORT D1.
- **D10 — Revoking cannot un-add.** `revoked_at` stops future redemptions and nothing else; no feed anywhere is touched. Stated here explicitly because "revoke" reads as though it ought to reach into people's workspaces, and a future reader will otherwise try to make it do that.

---

## 5. What travels, and what does not

| Element | Travels? | Why |
|---|---|---|
| `account` source | ✅ as pubkey identity | a native member is the same member for everyone |
| `publication` source | ✅ | same |
| `tag` source | ✅ verbatim | a string means the same thing to everyone |
| `external_source`, protocols `rss` / `nostr_external` / `atproto` / `activitypub` | ✅ as `(protocol, canonical uri)` | resolved at redeem via `addSource` (D4) |
| `external_source`, protocol `email` | ❌ **excluded, counted, stated** | per-subscriber secret alias (D5) |
| `reach` source | ❌ **unrepresentable** | deictic; §9.16 removes the kind entirely — this ADR does not carry a fallback, because the dependency is hard |
| `weight`, `sampling_mode`, `exclude_replies` | ✅ | composition — the tuning *is* the formula |
| `feeds.appearance` (colour scheme) | ✅, overridable at redeem | the look is part of the curatorial claim (`web/CLAUDE.md` per-feed schemes) |
| `feed_sources.muted_at` | ❌ | personal noise-management, not composition; sources arrive unmuted |
| `hidden`, `sort_rank` | ❌ | workspace-local placement, meaningless to a recipient |
| Items, saves, read state | ❌ | a formula is a composition, never content |

---

## 6. Risks and rails

- **Poller load.** Redemption resolves N sources through `addSource`. The rails already exist and are soaked: fetch jobs are keyed per source so concurrent redemptions coalesce rather than multiply, and bulk callers pass jittered `enqueueRunAt` (FOLLOW-GRAPH-IMPORT §6.4b). Redemption passes `skipProbe: false` for genuinely new identities (a formula can be months old and its URLs can rot — the OPML precedent, D6 of that ADR) and inherits the existing known-healthy short-circuit for everything already held. Cap a publishable formula's source count; there is no per-feed cap today and this is the first thing that stresses that.
- **Redemption is not atomic and should not pretend to be.** N sources means N `addSource` calls, each with its own transaction and advisory lock. A partial redeem must leave a real feed holding the sources that resolved, and report the ones that did not — the same summary shape as an import run. Do not wrap the loop in one transaction: it would hold the per-owner lock across every source and serialise the whole account.
- **The seed path and the share path share a mechanism but must not share a brake.** Once D6 lands, `seedStarterFeeds` redeems a formula. If that path is gated on `FEED_FORMULAS_ENABLED`, turning the flag off silently ends new-account seeding — the §0l outage again, from the opposite direction. The brake gates *publish and redeem-by-token*; the default-seed redemption is unbraked.
- **Privacy of the act, not just the data.** Publishing exposes a follow graph. Consent is present (publishing is an explicit act on a named feed), but the preview must show the recipient's-eye view *before* the freeze, so nobody publishes something whose legibility they had not considered.
- **Abuse.** A formula is a content-recommendation vector. Token-only distribution keeps this small — a link nobody shares reaches nobody — which is most of why D2 defers the directory. A formula needs a report affordance before Phase 3, not before Phase 1.
- **No notification type in v1.** The link travels out of band, so nothing needs to be inserted into `notifications`. Worth stating because the moment an in-app "X shared a feed with you" is added, the dedup invariant applies in full: a new linkable type needs a reference column, the insert must bind it, and it must join `idx_notifications_dedup` — or two different shares collapse into one and the second is silently dropped.

---

## 7. Surfaces

| Surface | Route / component | Notes |
|---|---|---|
| Publish + preview | FeedComposer action → confirm sheet | shows the recipient's-eye source list and the excluded-email count |
| Formula page | `web/src/app/f/[token]/page.tsx` | `components/public/` chassis; logged-out sees preview + waitlist CTA |
| Redeem | button on that page | `requireAuth`; mints the feed and lands the member on it |
| My formulas | settings or composer | list, copy link, revoke |
| Default-seed designation | `/admin/*` | replaces the hand-run `UPDATE`; one designated formula, changeable |

Gateway routes: `POST /feeds/:id/formula` (freeze + publish), `GET /formulas/:token` (`optionalAuth`, public projection), `POST /formulas/:token/redeem` (`requireAuth`), `GET /my/formulas`, `DELETE /formulas/:id` (sets `revoked_at`), plus the admin designation endpoint on `admin-dashboard.ts`.

---

## 8. Phases

- **Phase 0 — §9.16.** Not this ADR's work. Retire `reach`; materialise following into `account` sources. **Pre-check before starting:** confirm the currently-flagged template (`c1a4965a-2785-483a-918d-ccad67fce19c`) carries no `reach` row. The 2026-08-10 prod survey found reach rows only in two test feeds and returned zero for the flagged-feed arm — but that survey ran *before* `c1a4965a` was flagged on 08-11, so it does not answer this. One query.
- **Phase 1 — the object and the loop.** Migration (§11), freeze/preview/redeem, the formula page, the composer action. Dark behind `FEED_FORMULAS_ENABLED`.
- **Phase 2 — absorb the starter template.** Cut the live template into a designated default-seed formula, repoint `seedStarterFeeds`, verify seeding end-to-end on a fresh account, *then* drop `is_starter_template` and its two guards in a following migration. Never in one step: the flag is the only thing keeping seeding alive until the formula replaces it.
- **Phase 3 — public visibility.** `visibility = 'public'`, a browsable register, a report affordance. Gated on the beta opening.
- **Phase 4 — Nostr serialisation.** Publish a formula as a signed replaceable event through key-custody + `relay_outbox`, under the discovery opt-in rules (`DISCOVERY_PUBLISH_ENABLED` + `accounts.discovery_enabled`). Storage needs no change (D8).

---

## 9. Out of scope, deliberately

Live-synced formulas (D1). Merging a formula into an existing feed (D9). Formula versioning and "the author added 3 sources" offers — a coherent Phase 5 built on FOLLOW-GRAPH-IMPORT's exclusion machinery, deliberately not v1. Workspace sharing (multiple feeds as one artifact). OPML export of a formula — cheap, and worth revisiting once the freeze path exists, but not a v1 claim. Any write-back to an origin network.

---

## 10. Invariants this feature is bound by

Existing, unchanged: feed-derived external subscriptions (only `addSource`/`removeSource` write `external_subscriptions`); one-way inbound follow-graph flow; relay-outbox enqueue for any signed event (Phase 4); the dark-ship brake at the narrowest server-side choke point; `platform_config` for any tuned value (a formula source cap is a dial, seeded in `config-defaults.sql`, never in a migration).

Proposed additions for `CLAUDE.md` once Phase 1 ships:

- **A formula is frozen, and redemption goes through `addSource`.** A published formula is an immutable composition stored by portable identity; redeeming it resolves each source through the `addSource` core, never by copying `external_source_id` and never through `cloneFeedForOwner` (whose lock-free, job-free shortcuts are licensed only by the zero-feeds precondition a redeemer does not have).
- **The default seed is a formula, not a feed.** What every new account receives is an operator-designated `feed_formulas` row. It has no presence on the workspace floor and survives the deletion of the feed it was cut from. Never reintroduce a flag on `feeds` that makes an ordinary-looking feed load-bearing for every future signup.
- **Email sources never enter a formula, and their exclusion is reported.** `external_sources.ingest_address` is a per-subscriber secret.

---

## 11. Build plan

**Migration** (one file, no `platform_config` INSERTs, no `CONCURRENTLY`):

```sql
CREATE TABLE feed_formulas (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_feed_id uuid REFERENCES feeds(id) ON DELETE SET NULL,  -- provenance only; never read at redeem
  name           text NOT NULL,
  description    text,
  appearance     jsonb NOT NULL DEFAULT '{}'::jsonb,
  token          text NOT NULL UNIQUE,
  visibility     text NOT NULL DEFAULT 'token' CHECK (visibility IN ('token','public')),
  is_default_seed boolean NOT NULL DEFAULT false,
  source_count   integer NOT NULL,
  excluded_count integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz
);

CREATE TABLE feed_formula_sources (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  formula_id  uuid NOT NULL REFERENCES feed_formulas(id) ON DELETE CASCADE,
  position    integer NOT NULL,
  -- wire form (D8): NIP-51-set-shaped, so Phase 4 is a mapping and not a re-cut
  tag_kind    text NOT NULL CHECK (tag_kind IN ('p','t','r','a')),
  tag_value   text NOT NULL,
  tag_hint    text,
  -- local form: what addSource is handed at redeem
  source_type text NOT NULL CHECK (source_type IN ('account','publication','external_source','tag')),
  protocol    external_protocol,
  display_name text,
  avatar_url  text,
  weight      numeric NOT NULL DEFAULT 4.0,
  sampling_mode text NOT NULL DEFAULT 'chronological',
  exclude_replies boolean NOT NULL DEFAULT false
);

ALTER TABLE feeds ADD COLUMN from_formula_id uuid REFERENCES feed_formulas(id) ON DELETE SET NULL;
```

Both `tag_*` and `source_type`/`protocol` are stored though each is derivable from the other: the first is what serialises outward, the second is what `addSource` consumes, and writing the mapping down once at freeze time is cheaper than re-deriving it at both ends. `feeds.cloned_from_feed_id` is **retained and no longer written** — it is the only provenance already-seeded members have.

**`from_starter` must survive the move.** It is on the wire and forks live Explain copy (`ExplainOverlay.tsx:323`). Re-derive it as `EXISTS (SELECT 1 FROM feed_formulas ff WHERE ff.id = f.from_formula_id AND ff.is_default_seed)`, in the same three `FeedRow` SELECTs that compute it today (`feeds/shared.ts` `loadFeed`, `listFeedsForOwner`, `createFeedForOwner`). Add an optional `origin: { formulaName, authorName }` beside it for D7 attribution — two different questions that today share one field.

**Files:** new `gateway/src/routes/feeds/formulas.ts` (freeze + redeem engine, registered from `feeds/index.ts`); `feeds/shared.ts` (the `from_starter` re-derivation + `origin`); `feeds/crud.ts` (`seedStarterFeeds` repointed in Phase 2; `cloneFeedForOwner` and the two starter guards deleted with the flag); `gateway/src/routes/admin-dashboard.ts` (designation); `web/src/app/f/[token]/page.tsx`; `web/src/components/workspace/FeedComposer.tsx` (publish action); `docker-compose.yml` + `DEPLOYMENT.md` (`FEED_FORMULAS_ENABLED`, default 0).

**Tests.** DB-backed (`skipIf(!DB_URL)`) is the only honest level for most of this, since what must hold spans `feed_formulas` → `feed_sources` → `external_subscriptions` → `external_sources`: redeeming produces a feed whose external sources all carry subscriptions (the GC-orphan property `feed-clone-subscriptions.test.ts` already pins for the clone path); an email source is excluded and counted; a redeem racing a concurrent `removeSource` teardown of the same source leaves the subscription intact (this is what the advisory lock is for, and per the concurrency-test rule it must **force** the interleaving — hold both reads open until they have arrived, or the event loop serialises them and the test passes against a lock-free route); a partial redeem leaves a usable feed and reports the failures; revoking blocks redemption and touches no existing feed. Mutate each before believing it.

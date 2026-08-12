# Feed Formulas — a feed as a transmissible object

**Status:** Accepted 2026-08-11. **Phase 1 SHIPPED the same day, both halves; Phase 2 step 1 SHIPPED 2026-08-12** (§14 — the seed is now a designated formula, with the flagged template retained as the fallback until it is designated on prod). §12 is the Phase 1 server as-built (and the three places it departed from this text), §13 the web as-built (and the one route §8 had always asked for and the server half had not built: the pre-freeze preview). Phases 2–4 outstanding. This document records the model, the decisions, and the phasing. Six decisions were settled with the operator in the design conversation (§4 D1/D2/D6/D7/D8/D9); the rest are derived from existing invariants and were not open questions. A same-day review against the codebase settled four more (operator, 2026-08-11): the default seed is undeletable and unrevocable (D11), a publication travels by its public key rather than its row id (D4 as amended), a redeemed feed arrives in the author's colour scheme with no choice at add time (§5), and the formula page lists sources in the author's composer order (§11).

**Hard dependency — DISCHARGED 2026-08-11:** `CONSOLIDATED-TODO.md` §9.16 (retire the `reach` source kind) shipped as migration 177, hours before Phase 1. A `reach` row was deictic, resolving against `$1`, the caller, which is precisely what would have made a feed containing one mean something different for everyone else; every source in every feed is now a concrete named target. **Its §8 pre-check also fell out for free**: 177 deletes every `reach` row on every database, so the "does the flagged template `c1a4965a-…` carry one" query is answered by the migration itself, not by a survey.

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
- **D4 — Sources are stored by portable identity, never by local row id.** `cloneFeedForOwner` copies `external_source_id` — safe only because template and clone are minted in the same instant on the same instance. A formula is redeemed weeks later, may name a source the GC has since culled, and must one day serialise off-platform. So a formula source stores `(protocol, canonical uri)` / npub / publication pubkey / tag string, and redemption *resolves* it through `addSource`'s `(protocol, sourceUri)` branch, which creates-or-finds the row. Slower per source; correct. **A publication's portable identity is its `publications.nostr_pubkey`** (operator, 2026-08-11 — unique, `publications_nostr_pubkey_key`), never its row id: the row id is exactly the local FK this decision forbids for external sources, and it is meaningless the day a formula serialises off-platform. Redeem resolves pubkey → publication through that unique key; the precise wire tag it rides in (`a` coordinate vs `p`) travels with D8's deliberately-unpinned kind question.
- **D5 — `email`-protocol sources never travel, and their absence is stated.** `external_sources.ingest_address` is a per-subscriber secret alias (`inbound-mail.ts:76`). Copying the row hands a recipient the author's private address; resolving it by identity would mint a new alias and subscribe them to a newsletter in the author's name. Both are unacceptable, so email sources are excluded at freeze time — **with a visible count on both the publish preview and the formula page** ("3 email sources can't be shared"). Silent omission is the wrong failure: an author would believe they had published their whole feed. **The freeze fails closed by allow-list, not by naming email**: anything outside the four portable protocols (`rss`/`nostr_external`/`atproto`/`activitypub`) is excluded and counted — the `external_protocol` enum already carries `farcaster`/`matrix`/`telegram` with no composer path today, and a future protocol addition must not leak into formulas by default.
- **D6 — The starter template becomes a formula, and `feeds.is_starter_template` is retired.** The operator designates a formula as the default seed; `seedStarterFeeds` redeems it for an owner with zero feeds. This kills the twice-realised failure at the root: a formula has no `feeds` row to delete, no duplicate-looking twin on the floor, and its `source_feed_id` back-reference is `ON DELETE SET NULL`, so deleting the feed it was cut from leaves the formula whole. The merge and delete guards (409 `starter_template_source`) retire with the flag.
- **D7 — Attribution travels; counts do not.** A redeemed feed records and displays its origin ("from Billy Island's Long Reads"). The author is told nothing about uptake — no add count, private or public. An adoption metric on a curatorial object is an engagement surface by another name, and the platform's whole position is that there isn't one.
- **D8 — The serialisation format is committed now, the Nostr publish is built later.** Each formula source is stored as a NIP-51-set-shaped triple — tag kind, value, optional hint — so that publishing a formula as a signed replaceable event (via key-custody and the relay outbox, like every other outbound event) is a later phase and not a re-cut. The mapping is mechanical: native account and external-nostr → pubkey tag, hashtag source → hashtag tag, RSS/atproto/AP source → URL tag, publication → addressable-event tag. **The exact kind is deliberately unpinned** — a follow-set vs curation-set vs custom addressable kind is a question for the session that builds it, and nothing in the storage shape depends on the answer.
- **D9 — Redemption mints one new feed, never merges into an existing one.** The member redistributes afterwards with the existing merge and move tools. Same reasoning as FOLLOW-GRAPH-IMPORT D1.
- **D10 — Revoking cannot un-add.** `revoked_at` stops future redemptions and nothing else; no feed anywhere is touched. Stated here explicitly because "revoke" reads as though it ought to reach into people's workspaces, and a future reader will otherwise try to make it do that.
- **D11 — The designated default seed is undeletable and unrevocable** (operator, 2026-08-11). D6 removes the *feed-shaped* death of new-account seeding but the formula reintroduces three quieter ones — the author account's `ON DELETE CASCADE` sweeping the formula away, a revoke landing on the designated row, and nothing enforcing that exactly one row is designated — each of which is the §0l outage again: global, delayed, invisible from the act that caused it. So the guarantees move into the schema, where a route rebuild cannot un-deploy them (the §0l lesson that "a guard on master is not a guard"): a partial unique index caps designation at one (`WHERE is_default_seed`); a row CHECK forbids `is_default_seed AND revoked_at IS NOT NULL`; and a `BEFORE DELETE` trigger refuses to delete a designated row — which is what turns the author-account CASCADE into a refused account deletion rather than a silently dead seed path. Undesignating is therefore only possible by designating a replacement (the admin endpoint swaps both rows in one transaction) — never by removal. The zero-designated state exists only before Phase 2 cuts over, while `is_starter_template` still carries seeding.

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
| `feeds.appearance` (colour scheme) | ✅ verbatim | the look is part of the curatorial claim (`web/CLAUDE.md` per-feed schemes); the feed *arrives* styled and the recipient restyles it afterwards like any feed — no choice at add time (operator, 2026-08-11) |
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

Gateway routes: `GET /workspace/feeds/:id/formula/preview` (owner-scoped, the pre-freeze recipient's-eye view — §13), `POST /feeds/:id/formula` (freeze + publish), `GET /formulas/:token` (`optionalAuth`, public projection), `POST /formulas/:token/redeem` (`requireAuth`), `GET /my/formulas`, `DELETE /formulas/:id` (sets `revoked_at`; 409 on the designated default seed, per D11 — the schema CHECK backs the refusal), plus the admin designation endpoint on `admin-dashboard.ts` (swaps designation to a replacement in one transaction; never merely clears it).

---

## 8. Phases

- **Phase 0 — §9.16.** Not this ADR's work. Retire `reach`; materialise following into `account` sources. **Pre-check before starting:** confirm the currently-flagged template (`c1a4965a-2785-483a-918d-ccad67fce19c`) carries no `reach` row. The 2026-08-10 prod survey found reach rows only in two test feeds and returned zero for the flagged-feed arm — but that survey ran *before* `c1a4965a` was flagged on 08-11, so it does not answer this. One query.
- **Phase 1 — the object and the loop.** Migration (§11), freeze/preview/redeem, the formula page, the composer action. Dark behind `FEED_FORMULAS_ENABLED`. **COMPLETE 2026-08-11** — server half in §12, web half plus the pre-freeze preview route in §13. The only thing outstanding is the flag flip itself, which now has a surface to reach.
- **Phase 2 — absorb the starter template. COMPLETE: step 1 shipped 2026-08-12 (§14), step 2 the same day (§15, migration 179).** Cut the live template into a designated default-seed formula, repoint `seedStarterFeeds`, verify seeding end-to-end on a fresh account, *then* drop `is_starter_template` and its two guards in a following migration. Never in one step: the flag was the only thing keeping seeding alive until the formula replaced it, so step 2 waited on a formula being designated on **prod** and a real signup having been seeded from it (operator confirmed, 2026-08-12).
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
- **The default seed is a formula, not a feed — and the designated formula is undeletable and unrevocable.** What every new account receives is an operator-designated `feed_formulas` row. It has no presence on the workspace floor, survives the deletion of the feed it was cut from, and is schema-guarded against the quiet deaths (D11): at most one designated, never revoked while designated, never deletable — including via the author account's CASCADE. Undesignating happens only by designating a replacement. Never reintroduce a flag on `feeds` that makes an ordinary-looking feed load-bearing for every future signup.
- **Email sources never enter a formula, and their exclusion is reported.** `external_sources.ingest_address` is a per-subscriber secret.

---

## 11. Build plan

**Migration** (one file, no `platform_config` INSERTs, no `CONCURRENTLY`):

```sql
CREATE TABLE feed_formulas (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_feed_id uuid REFERENCES feeds(id) ON DELETE SET NULL,  -- provenance only; never read at redeem
  name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),  -- feeds_name_length; redeem copies it into feeds.name
  description    text,
  appearance     jsonb NOT NULL DEFAULT '{}'::jsonb,
  token          text NOT NULL UNIQUE,
  visibility     text NOT NULL DEFAULT 'token' CHECK (visibility IN ('token','public')),
  is_default_seed boolean NOT NULL DEFAULT false,
  source_count   integer NOT NULL,
  excluded_count integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  CONSTRAINT feed_formulas_seed_never_revoked CHECK (NOT is_default_seed OR revoked_at IS NULL)  -- D11
);

-- D11: at most one designated seed, and it cannot be deleted (the trigger is
-- what turns the author-account CASCADE into a refused account deletion).
CREATE UNIQUE INDEX uq_feed_formulas_default_seed ON feed_formulas (is_default_seed) WHERE is_default_seed;
-- + BEFORE DELETE trigger refusing WHEN (OLD.is_default_seed)

CREATE TABLE feed_formula_sources (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  formula_id  uuid NOT NULL REFERENCES feed_formulas(id) ON DELETE CASCADE,
  -- composer order (operator, 2026-08-11): feed_sources has no ordering column,
  -- so freeze assigns position from the author's composer order — created_at,
  -- id as tiebreak — and the formula page renders it.
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
  sampling_mode text NOT NULL DEFAULT 'chronological'
    CHECK (sampling_mode IN ('chronological','scored','random')),  -- mirror feed_sources_sampling_mode_check
  exclude_replies boolean NOT NULL DEFAULT false,
  UNIQUE (formula_id, position)
);

ALTER TABLE feeds ADD COLUMN from_formula_id uuid REFERENCES feed_formulas(id) ON DELETE SET NULL;
```

Both `tag_*` and `source_type`/`protocol` are stored though each is derivable from the other: the first is what serialises outward, the second is what `addSource` consumes, and writing the mapping down once at freeze time is cheaper than re-deriving it at both ends. `feeds.cloned_from_feed_id` is **retained and no longer written** — it is the only provenance already-seeded members have.

**`from_starter` must survive the move.** It is on the wire and forks live Explain copy (`ExplainOverlay.tsx:323`). Re-derive it as `EXISTS (SELECT 1 FROM feed_formulas ff WHERE ff.id = f.from_formula_id AND ff.is_default_seed)` at every site that computes it today — **grep for `from_starter` rather than trusting a list: there are five sites, not three** (`feeds/shared.ts` `loadFeed`; `crud.ts` `listFeedsForOwner`, two inline SELECTs inside `registerFeedCrudRoutes`'s handlers, and `createFeedForOwner`'s literal `false AS from_starter`, which stays a literal). Add an optional `origin: { formulaName, authorName }` beside it for D7 attribution — two different questions that today share one field.

**Files:** new `gateway/src/routes/feeds/formulas.ts` (freeze + redeem engine, registered from `feeds/index.ts`); `feeds/shared.ts` (the `from_starter` re-derivation + `origin`); `feeds/crud.ts` (`seedStarterFeeds` repointed in Phase 2; `cloneFeedForOwner` and the two starter guards deleted with the flag); `gateway/src/routes/admin-dashboard.ts` (designation); `web/src/app/f/[token]/page.tsx`; `web/src/components/workspace/FeedComposer.tsx` (publish action); `docker-compose.yml` + `DEPLOYMENT.md` (`FEED_FORMULAS_ENABLED`, default 0).

**Tests.** DB-backed (`skipIf(!DB_URL)`) is the only honest level for most of this, since what must hold spans `feed_formulas` → `feed_sources` → `external_subscriptions` → `external_sources`: redeeming produces a feed whose external sources all carry subscriptions (the GC-orphan property `feed-clone-subscriptions.test.ts` already pins for the clone path); an email source is excluded and counted; a redeem racing a concurrent `removeSource` teardown of the same source leaves the subscription intact (this is what the advisory lock is for, and per the concurrency-test rule it must **force** the interleaving — hold both reads open until they have arrived, or the event loop serialises them and the test passes against a lock-free route); a partial redeem leaves a usable feed and reports the failures; revoking blocks redemption and touches no existing feed. Mutate each before believing it.

---

## 12. As built — Phase 1 server half (2026-08-11)

Migration **178** plus `gateway/src/routes/feeds/formulas.ts`. The schema landed as §11 specifies it. Everything below is either a departure from this document or a fact a future reader would otherwise have to re-derive.

**Routes, and why they are split across two prefixes.** Freeze is `POST /workspace/feeds/:id/formula` (registered from `feeds/index.ts` — genuinely feed-scoped, and `/api/v1/feeds` is already owned by `external-feeds.ts`). The other four are mounted at `/api/v1` from `index.ts`: `GET /formulas/:token` (`optionalAuth`), `POST /formulas/:token/redeem`, `GET /my/formulas`, `DELETE /formulas/:id`. §7 wrote them all as bare paths; a formula page is a **public** page, so serving it from a path called `workspace` would have been a lie about who it is for. The engine is still one file.

**Two exported cores, for the same reason `cloneFeedForOwner` is exported.** `freezeFeedIntoFormula(client, params)` is client-threaded so the DB-backed test drives it inside a transaction it rolls back. `redeemFormulaForOwner(formulaId, ownerId)` **cannot** be, and that is a property of the design rather than a shortcut: §6 forbids wrapping the redeem loop in one transaction, so `addSource` opens its own transactions on the shared pool and cannot see an uncommitted fixture — that half of the test commits and cleans up after itself.

**Three departures from this document.**

1. **The revoked gate lives in the redeem CORE, not the route.** §7 implies the route checks it. A core that mints feeds from a shared artifact has to enforce its own precondition, or the next caller is the one that forgets — and Phase 2 adds exactly such a caller. The test asserts both halves: the refusal, *and* that no feed is minted, since a gate placed after `createFeedForOwner` would leave an empty feed behind on every attempt.
2. **Freeze refuses an empty composition** (400 `formula_empty`), which §3 does not mention. A formula with no portable sources would redeem into a sourceless feed, and a sourceless feed auto-serves `placeholderExploreItems` — so the recipient would open what they believe is a stranger's curation and be shown the platform stream. That is §2.7's placeholder becoming a correctness problem in a surface it was never considered against.
3. **`from_starter` was NOT re-derived.** §11 says to, but that is Phase 2's job: `is_starter_template` still carries seeding, so a formula-derived `from_starter` would be false for every seeded member today. What DID land is the §11 refactor's real value — the provenance projection is now **one function**, `feedProvenanceSql(alias)` in `feeds/shared.ts`, instead of the five hand-copies whose existence is why §11 has to tell a reader to *grep* rather than trust a list. Phase 2 re-derives it by editing one body. `origin: {formulaName, authorName}` ships beside it now.

**Details worth not re-deriving.** A publication rides a `'p'` tag on its own `nostr_pubkey` and `source_type` is what tells it from an account at redeem; `'a'` is permitted by the CHECK but unemitted. `tag_hint` carries a nostr relay hint and nothing else — `tag_value` stays the bare pubkey, so the relay-free-identity invariant holds. Redeem does **not** pass `skipProbe` (a formula can be months old and its URLs rot), inheriting `addSource`'s known-healthy short-circuit instead, and it rides the same `ENQUEUE_SPACING_MS` stampede brake as follow-import — now one constant in `feeds/shared.ts` rather than two. A formula naming the same target twice is idempotent, **not** a reported failure. The source cap is the dial `feed_formula_max_sources` (200), sized by redeem latency rather than storage, with a fallback-parity test.

**Evidence.** 17 new tests (gateway 552 → 572 with the parity additions), five mutations run and all five caught: email made portable, composer order reversed, frozen tuning not applied at redeem, the revoked gate removed, the relay hint attached to every protocol. The D11 guards were probed in psql — including the one that matters, an author-account delete refused *through the CASCADE*, with a no-formula control proving the refusal was the trigger and not some unrelated FK. The whole loop was then driven live against a rebuilt gateway (compose → source → freeze → logged-out public page → redeem as a second account → revoke → 410), and with the flag off all five routes 404 while an ordinary feeds route still 200s.

---

## 13. As built — Phase 1 web half (2026-08-11, same day)

The two surfaces §7 names, plus the one route the server half turned out not to have.

**The pre-freeze preview did not exist, and §8's Phase 1 line had always asked for it.** What shipped in the morning was freeze / public-page / redeem / revoke; `GET /formulas/:token` is the preview a RECIPIENT gets, which is a different object from the one §6 requires — "the preview must show the recipient's-eye view *before* the freeze, so nobody publishes something whose legibility they had not considered". D5 is the sharper half: the excluded count has to be on the **publish** preview, or an author with three email sources learns they published two-thirds of a feed by opening their own link and counting. So `GET /workspace/feeds/:id/formula/preview` (owner-scoped, flag-gated, read-only) runs the real `freezeSource` over the real query and returns the projection the public page uses, plus the refusal the freeze *would* raise (`empty` / `too_large`) so the sheet can say why the button is unavailable instead of letting an author press it and read a 400.

**The freeze query is now one body, `loadFeedSourcesForFreeze`, and that is the point rather than tidiness.** Preview and freeze must agree about the row set AND the ORDER BY, and a drifted preview fails in the reassuring direction — it shows the author MORE than travels. The DB-backed tests assert agreement rather than plausibility: every preview assertion compares against what the freeze then writes.

**Nothing about portability is derived client-side.** `WorkspaceFeedSource` carries no `protocol`, so the web literally cannot tell an email source from an RSS one — but the deeper reason is that deriving it would put a second copy of the D5 allow-list in the browser, to drift the first time a protocol joins the enum. The web asks the server what travels.

**The brake needed a web-visible answer, and it is a probe rather than a twin.** `FEED_FORMULAS_ENABLED` stays the only flag. The composer's action is the layout case the brake rule carves out (an action that 404s on press is worse than one that is absent), so `formulasAvailable()` probes `GET /my/formulas` once per session — 200 ⇒ live, 404 ⇒ dark, anything else ⇒ dark for that render and cached as nothing, the same terminal-vs-ambiguous split as the Stripe classifiers and the internal-parity probe. Reaching the route IS the proof, so there is no second value to keep in sync.

**A revoked formula's page shows the refusal and NOT the composition.** The route still returns the sources (revocation is a flag, not a delete — D10), but rendering a retracted source list publishes exactly what the author withdrew, so the page returns early above the list. It also says in words what D10 means, because "revoke" reads as though it ought to reach into workspaces: *anyone who already added the feed keeps it.*

**Scope note — "My formulas" shipped with the publish action rather than after it.** §7 lists it as a Phase 1 surface and the day's brief named only the publish action; building the action alone would have meant a link that exists for exactly as long as the sheet stays open, since nothing else in the app can retrieve one. It is the same component, on `GET /my/formulas`, listing live formulas only (a revoked one is a link that no longer works, and listing it invites sending it). The withdraw control is hidden on `is_default_seed` — the server refuses it 409 and the schema backs that refusal (D11); hiding it only avoids offering an action that cannot work.

**Files.** `web/src/app/f/[token]/page.tsx` (public chassis), `web/src/components/workspace/FeedFormulaSection.tsx` (composer section — inline state, never a nested Glasshouse, since panes do not stack), `web/src/lib/api/formulas.ts` (types, calls, the probe, and `formulaSourceKind` as the one home for the kind label both surfaces render), `FeedComposer.tsx` (mounts the section below Appearance, so the author sets the look they are handing over before being offered the chance to hand it over — the scheme travels, §5).

**Evidence.** Gateway 572 → 576; four mutations run and all four caught (preview blind to the excluded count, preview in reverse composer order, preview never reporting a refusal, preview writing a row). Loop driven end to end against the rebuilt dev stack on a four-source feed whose fourth is a real `email` row: preview excludes and counts it and writes nothing, publish returns the link, the logged-out public projection carries no `in.all.haus` alias anywhere, redeem as a second account mints a feed with `from_formula_id` set and an `external_subscriptions` row for its one external source, revoke 204s, a second redeem 410s, the page still resolves flagged `revoked`, and the already-redeemed feed is untouched. With the flag off all six routes 404 while `GET /workspace/feeds` still 200s. **The browser look was the one gap and it is closed** — no browser was available in the session that built these, so both surfaces were held back from the push until the developer opened them; confirmed good 2026-08-11, and only then pushed. Recorded because the gap was real for the length of a session, and because it is the check that found four chassis defects on the landing page that compiling, linting and reading had not.

---

## 14. As built — Phase 2 step 1 (2026-08-12)

`seedStarterFeeds` now redeems the designated formula, and the operator has a surface to designate one. **No migration** — 178 already carried the schema. What is left of Phase 2 is the drop, and its precondition is a *designated formula on prod*, not a passing test.

**Both mechanisms are live at once, deliberately.** `seedStarterFeeds` prefers the designated formula and falls back to the `is_starter_template` clone loop. That fallback is not tidiness — this code deploys to a database where nothing is designated yet, so on the day it ships the flag is still the only thing seeding anyone. Removing the fallback and the flag in one step re-opens the outage the phase exists to close, which is why §8 phrases the ordering as the item. Both paths are pinned by tests, including the precedence between them.

**The brake, tested rather than asserted.** The seed path is not gated on `FEED_FORMULAS_ENABLED` (§6), and the test **deletes the variable** before seeding rather than trusting the absence of a call — the failure mode is a future edit adding one. The live drive was done the same way, against a gateway brought up dark (`printenv` = `0`), which is also the honest answer to "does the operator have to flip the flag to cut over?" — no, because of the `{feedId}` branch below.

**Designation is `POST /admin/dashboard/seed-formula`, and it takes two bodies.** `{formulaId}` designates a formula that already exists; `{feedId}` freezes one of the admin's own feeds into a new formula and designates it **in the same transaction**. The second exists because the composer's publish action is behind the brake, and §6 says the seed path must not share it: without it, an operator with the flag off cannot mint the thing every new account depends on. Three properties are load-bearing and each is mutation-checked: the swap **clears then sets in one transaction** and there is no way to clear alone (D11 — undesignate only by designating a replacement); a revoked formula is refused 409 rather than left to the schema CHECK as a 500; and the `{feedId}` branch is **owner-scoped**, because freeze writes `author_id` from the caller and a designated formula's author cannot delete their account — making somebody else's account undeletable must not be reachable by typing a uuid. A formula with no sources is refused too: a sourceless seed feed auto-serves the explore placeholder, so every new member would open what they believe the platform composed for them and be shown the platform stream (§12's departure #2, one level up).

**The panel reports what is load-bearing, not just what is settable** (`web/src/components/admin/SeedFormulaPanel.tsx`, on `/admin/config`). It names the designated formula, and — while the move is in flight — the still-flagged legacy feeds, and says plainly when *neither* exists and a signup would land on an empty feed. The flagged template was destroyed twice by an operator who could not tell it from an ordinary feed; a designation surface that showed only its own state would have kept exactly that blindness. It also warns when the seed's author is not the admin, because their account can no longer be deleted.

**`from_starter` was re-derived, and the spelling changed more than §11 asked for.** It is now `cloned_from_feed_id IS NOT NULL OR <redeemed from the designated seed>` — **not** an `EXISTS` over `is_starter_template`. The old spelling meant merely *unflagging* the template retroactively unmade the provenance of every member ever seeded from it; provenance is a fact about the member's feed, not about what the operator still keeps flagged. It also means the following migration's `DROP COLUMN` needs no further edit here. The known limit is pinned by a test: **deleting** the template still erases the legacy arm, because `feeds_cloned_from_feed_id_fkey` is `ON DELETE SET NULL` — beyond any SQL spelling, and the sharpest argument for D6, since a formula has no `feeds` row for anyone to delete. `origin_*` now excludes the default seed, so the two questions are disjoint: without that, every new member's first feed would carry "from *the operator*'s Starter" as though they had chosen it.

**One structural move.** `createFeedForOwner` went from `feeds/crud.ts` to `feeds/shared.ts`. Phase 2 makes crud a caller of the redeem core, and formulas was already a caller of that helper, so leaving it put the two modules in a cycle — one that hoisting would have survived today and broken on the first module-init read.

**Evidence.** Gateway 576 → 589; **eight mutations run and all eight caught** (brake gating the seed, template beating the formula, origin unsuppressed for the seed, the legacy provenance arm dropped, designation setting without clearing, the revoked check removed, the feed-ownership scope removed, an empty formula accepted). Then driven live against the rebuilt dev stack with the brake **off**: compose a three-source feed (account + tag + RSS) → cut & designate in one call → a brand-new account's first workspace load returns exactly one feed, named from the formula, `fromStarter: true`, `origin: null`, three sources resolved **by identity** (the account arrived as the right member, not a copied row id) and a real `external_subscriptions` row for the new member. `cloned_from_feed_id` null — the clone path did not run.

**What is NOT done, and its gate.** Dropping `feeds.is_starter_template` with the merge and delete guards and the clone path. The gate is a designated formula **on prod** — until then the fallback is what seeds real signups. *(Met and done the same day — §15.)*

---

## 15. As built — Phase 2 step 2 (2026-08-12), migration 179

The drop. `feeds.is_starter_template` is gone, and with it `cloneFeedForOwner`, `seedStarterFeeds`'s fallback arm, the merge 409, the delete 409 and its fail-closed backstop. What seeds a new account is now one thing.

**The gate was prod state and it was met, not waived.** The operator designated a formula on production and a real signup was seeded from it before this was written. That ordering was the whole reason step 1 and step 2 were separate ships rather than one: on the day step 1 deployed nothing was designated anywhere, so the flag was still carrying every real signup, and dropping it in the same commit would have re-opened the outage the phase exists to close. The precondition is a fact about the live database, and no passing test could stand in for it.

**Step 1 pre-paid for this, and that is why the drop is one statement.** `from_starter` had already been re-derived off `cloned_from_feed_id` rather than an `EXISTS` over the flag, so the `DROP COLUMN` needed no edit to the provenance projection — under the old spelling it would have silently unmade the provenance of every member seeded before the cutover, all at once. The legacy arm therefore survives the flag on purpose: nothing writes `cloned_from_feed_id` any more (its sole writer was the clone path), but it is the only provenance pre-cutover members have. It is read-only history, and the test that pins it now builds a clone row by hand.

**The guards go because the object does, not because the risk went away.** Merge and delete were each made to refuse a flagged feed after an incident (2026-07-22 merge, 2026-08-10 delete) — a deletable row that must never be deleted, narrowed twice and closed neither time. The replacement is not a better guard, it is a different object: a formula is frozen, and undeletable and unrevocable while designated, in the schema. Which is the §0l lesson stated once more — a guard on master is not a guard, a constraint is.

**Deploy ordering is the REVERSE of the usual, and of migration 177's.** Old code names the dropped column in four places (the merge lock read, both delete guards, the admin panel query), so it is deploy-then-migrate: new code against an unmigrated DB is fine, old code against a migrated one 500s the workspace feed list. The migration header says so twice.

**Coverage.** Three test files retired with their subject; two were rewritten rather than deleted, because they held behaviour that had nothing to do with the flag and would otherwise have gone unheld on two destructive routes — `feed-delete.test.ts` (only-feed refusal · removeSource teardown *before* the row goes, H6 · 404) and `feed-merge.test.ts` (direction: the SOURCE feed is deleted · deterministic lock order · the two ownership arms · self-merge). `feed-clone-subscriptions.test.ts` went outright with the function it drove. `feed-seed-formula.test.ts` gained the state that now matters most: **nothing designated seeds nothing at all**, silently and without half-writing, which since the fallback's removal is the entire behaviour of an undesignated database.

**Evidence.** Gateway 593 tests green (50 files); **eight mutations run, eight caught** — seeding claiming a feed it did not create, the legacy provenance arm dropped, the only-feed refusal removed, merge deleting the target instead of the source, the merge lock order dropped, the panel inventing a designation, the seed path gated on `FEED_FORMULAS_ENABLED`, and the delete's teardown moved after the row delete. `schema.sql` regenerated from a throwaway migrated DB (the diff is the dropped column, the seed line and pg_dump's own nonce — nothing else), drift guard 8/8. Then driven live on dev with the brake **off**: a real waitlist join → admit → first workspace load returned one feed named from the designated formula, three sources, `fromStarter: true`, `origin: null`; then DELETE on that seeded feed returned **204** where it would have been a 409 the day before, a merge returned 200, and the only-feed refusal still returned 409.

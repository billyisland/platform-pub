# ADR: Architectural Audit Outcomes — 2026-06-15

**Status:** Accepted — per-decision status recorded on each item below (they span a
trivial helper to two one-way doors; they are not all the same risk)
**Date:** 2026-06-15
**Scope:** `billyisland/platform-pub` (all.haus) monorepo
**Supersedes context in:** README (stale — claims 18 tables / 4 migrations; actual is ~90 tables / 117 migrations)

---

## Summary

A full-tree audit (not README-based) produced eight accepted decisions and two
findings withdrawn on inspection. Decisions are recorded below in the standard
context / decision / consequences form, followed by a suggested execution order.

The README describes a materially smaller, earlier system than the one in the
repo. That documentation gap is itself a hazard for onboarding and should be
corrected alongside this work, but is out of scope for the decisions here.

---

## 1. Schema source of truth → schema.sql stays canonical, guard hardened

**Status:** Accepted — original "migrations canonical" decision reversed after the
premise was corrected on inspection. **1a shipped 2026-06-16** (Check 3 object
presence added to the drift guard; surfaced + fixed one real latent drift —
migration 022's `idx_read_events_reader_article` was seeded-applied but absent
from `schema.sql`). **1b (genesis extraction) remains deferred.**

**Context.** Two representations of the schema exist: `schema.sql` (a `pg_dump`
snapshot a fresh dev/prod DB boots from) and 117 ordered migrations replayed on
top of it. **They are already checked against each other** — `scripts/check-schema-drift.sh`
runs three checks (seed completeness, no-op migrate on a schema.sql DB, canonical
round-trip) and is CI-enforced via the `schema` job. The earlier "nothing asserts
they agree" framing was wrong.

What that guard *cannot* check is a full "build from empty" replay — and not by
oversight. **There is no genesis migration.** Migration `001` opens with
`ALTER TABLE accounts …` against a table only `schema.sql` ever creates, so the
chain has no beginning and cannot be replayed from an empty database. The chain
also carries fix-on-fix history (019 fixes 014; 044 redoes 042; 116 drops a column
094 added), but that is ordinary forward history, not the blocker — the missing
genesis is.

**Decision.** Keep `schema.sql` canonical (it is the load-bearing genesis the
system already boots from) and *strengthen the existing drift guard* rather than
invert the model. Inverting it — making migrations the sole source so `schema.sql`
becomes generated output — is achievable but is **not** a cleanup: it first
requires extracting a `000_base.sql` genesis migration from today's `schema.sql`,
after which `001+` replay on top and `schema.sql` can be regenerated and a true
from-empty CI replay becomes possible. That genesis extraction is **recorded here
as a deferred option** for the federation/self-host story, not adopted now.

**Consequences.** The schema-changing items below (2, 3, 6) are already protected
by the existing CI drift check — they do **not** wait on new tooling, contrary to
the original draft. If/when self-host requires from-empty reconstruction, schedule
the genesis extraction as its own scoped task; only then can the from-zero replay
test be added.

---

## 2. Finish UNIVERSAL-POST

**Status:** Accepted.

**Context.** `feed_items` is mid-migration. It still carries the old three-way
polymorphism (`article_id` / `note_id` / `external_item_id` plus a
`CONSTRAINT exactly_one_source`) *and* the new unified `post_id` / `version` /
`biddability_tier` columns. Both models are live; every read/write maintains both,
and the cleaner unified model delivers none of its benefit while the polymorphic
version remains load-bearing.

**Decision.** Complete the UNIVERSAL-POST migration and drop the polymorphic
columns and `exactly_one_source`. One content identity, not two.

**Consequences.** Removes the dual-maintenance cost and the denormalisation
hazard. Read/write paths that branch on "which source slot is set" can collapse to
a single post identity. Requires care that no remaining query depends on the
dropped columns.

---

## 3. Unified append-only ledger

**Status:** Accepted — keystone; design it anticipating the item-4 tension (below).

**Context.** Design philosophy: money's influence on discourse should be naked and
obvious — work rewarded, bad behaviour taxed, little mystery about how each form
of life on the site earns a living. The implementation contradicts this. There is
no ledger. `reading_tabs` is a bare running balance (`reader_id`, `balance_pence`)
with no line items. `tab_settlements` records Stripe charges; `writer_payouts` /
`publication_payouts` / `publication_payout_splits` handle outbound; and
`vote_charges`, `pledges`, `dm_pricing` are separate islands that don't flow
through the tab or any shared entries table. "How does writer X make a living
here?" is answerable only by hand-unioning **eight** differently-shaped surfaces
(`reading_tabs`, `tab_settlements`, `writer_payouts`, `publication_payouts`,
`publication_payout_splits`, `vote_charges`, `pledges`, `dm_pricing`) — the exact
mystery the design exists to abolish, sitting in the plumbing.

**Decision.** Introduce one append-only ledger:
`(account_id, counterparty_id, amount_pence, currency, trigger_type, ref_id, created_at)`.
Every money path emits an entry with its own `trigger_type` pointing at the
originating record. `reading_tabs.balance_pence`, writer earnings, publication
splits, and "tax generated by bad behaviour" all become **views over one table**.
The plural *triggers* survive untouched; they stop being plural *ledgers*.

**Consequences.** The keystone change — it is what makes the transparency thesis
real for both users and operator. Discipline required: the ledger is strictly
append-only; corrections are reversing entries, never updates, or it stops being
trustworthy. Balances become `SUM()` views; settlement and payout read from the
same spine. Largest single piece of work in this audit.

**Tension with item 4.** A single shared ledger table is trivial inside one
deployable but becomes a cross-service distributed-write problem the moment the
money paths live in different services. Design the ledger assuming a possible later
split — keep every money write on one side of any future seam, or accept that the
ledger write becomes a transactional boundary. This is one reason item 4 is now
scoped to module boundaries, not real services (below).

---

## 4. Gateway → module boundaries first, services only on demonstrated need

**Status:** Accepted — scope narrowed from "real services" to modules-first after
weighing the audit's own cost analysis.

**Context.** The gateway is a 28k-LOC monolith with 44 route files and two
god-files (`external-items.ts` ≈ 2,769 lines, `feeds.ts` ≈ 2,064). Meanwhile the
two tiny key services pay full service tax — so the decomposition is uneven. The
audit's original complaint was **placement of the service tax, not "monolith
bad."** By its own estimate, module boundaries inside one deployable capture ~80%
of the readability benefit at ~10% of the cost of real services.

**Decision.** Introduce real **module boundaries inside the single deployable
first** — split the two god-files and define internal domain seams. Promote a
module to its own service **only where independent deploy / scale / blast-radius is
demonstrably needed**, never as a blanket move. The expensive, one-way "real
services" door stays closed until a concrete need forces it open.

**Consequences.** Cheap, reversible, and aligned with the audit's own math. Avoids
prematurely taking on distributed transactions, network failure modes, and
inter-service version skew. Interacts directly with item 3: a unified ledger is
easiest while the money paths share one deployable, so keeping the split to module
boundaries (not services) for now also keeps the ledger simple. If a real service
is later split out, the ledger's transactional boundary (item 3 tension) must be
resolved as part of that move.

---

## 5. Outbound delivery → shared retry helper, two tables

**Status:** Accepted — low risk.

**Context.** Investigation corrected the original "three queues for one job" claim.
The Jetstream listener is *inbound* (Bluesky firehose → `external_items`); its
"poll loop" is a 60s re-subscription check, not delivery. The two outbound tables
are genuinely distinct: `relay_outbox` pushes native events to Nostr relays (10
attempts, advisory locks, partial-success rule, discovery-event special-casing);
`outbound_posts` mirrors user actions to foreign protocols (ActivityPub/AT-Proto,
3 retries). `graphile_worker` is the executor for both, deliberately scheduled
with `max_attempts := 1` so Graphile's retry doesn't race the domain tables' own
retry columns. The only real overlap is duplicated claim/backoff/dedup *machinery*.

**Decision.** Keep both tables (their retry semantics legitimately diverge).
Extract one shared helper parameterised by max-attempts, backoff, and
success-rule.

**Consequences.** Removes duplicated plumbing without forcing the two paths'
semantics to converge. Low risk.

---

## 6. DM reactions

**Status:** Accepted — cheap; do while the table is empty.

**Context.** DMs carry a full sub-product (conversations, members, messages,
replies, likes, and `dm_pricing`). Paid DMs are a deliberate acquisition wedge
(convert a writer's worst inbox problem into income or sport) and are kept. `dm_likes`
is reaction etiquette; a single like is an awkward half-measure if reactions are
wanted at all.

**Decision.** Migrate `dm_likes` → a reactions table with a `reaction_type` column
and a unique constraint per `(message, user, reaction)`. DM-scoped (not unified
app-wide). Do it now, while the table is effectively empty.

**Consequences.** Cheap now, annoying to retrofit later once the table is full of
like-rows. Note: paid DMs bring refund/chargeback handling, fee treatment on
sender-block, and minors-and-payments care as surface to handle (flagged, not a
blocker).

---

## 7. Park trust

**Status:** Accepted — fully clean (read paths unaffected). **Shipped 2026-06-16**
behind `TRUST_SYSTEM_ENABLED` / `NEXT_PUBLIC_TRUST_ENABLED` (both default OFF); see
the implementation plan's item-7 header for the outcome.

**Context.** The trust subsystem is least-developed and not launch-critical.
`trust_layer1` (objective computed signals) is wired across 8 files; `vouches` +
`trust_profiles` + `trust_epochs` form a coherent decaying-attestation mechanism
(`epochs_since_reaffirm` ages vouches unless reaffirmed — `trust_epochs` is the
clock that drives decay). `trust_polls` is an underdeveloped outlier. Critically,
all launch-critical consumers read trust via `LEFT JOIN trust_layer1` and surface
`pip_status` / `trust_weight` for **display only** — ordering is by `published_at`
(`replies.ts`, thread in `post-thread.ts`), `boosted_at` (reposts), or a
precomputed `fi.score` (`feed-sql.ts`). Trust affects ordering by zero.

**Decision.** Park the entire trust infrastructure. Flag off the UI surfaces
(network page, `PipPanel`, vouch/poll components); disable the `trust-layer1-refresh`
and `trust-epoch-aggregate` background tasks; leave the tables and the `LEFT JOIN`s
in place. Retain in repo pending a focused future effort.

**Consequences.** Fully clean. The `LEFT JOIN`s degrade to NULL against empty/stale
tables, so read paths need no change and ordering is unaffected (trust was
display-only). Saves the compute spent recomputing signals nobody is viewing.

---

## 8. Park traffology

**Status:** Accepted — no hard dependency breaks. **Shipped 2026-06-16** (containers
commented out, nginx `/ingest/` → 404, client beacon behind
`NEXT_PUBLIC_TRAFFOLOGY_ENABLED`, default OFF); see the implementation plan's item-8
header for the outcome.

**Context.** Traffology has its own `traffology` schema (~12 tables), two
*separately deployed* containers (`traffology-ingest` on :3005 receiving page
beacons; `traffology-worker` rolling up), and a gateway route — powering 3 UI
pages. Its data source (beacon telemetry) is independent of the main feed
pipeline. The gateway route is mostly direct table reads (serve stale fine); only
two `/concurrent/*` endpoints live-`fetch()` the ingest service, and those are
already wrapped in try/catch that degrades. The sole hard coupling is nginx
(`depends_on: traffology-ingest` and an `/ingest/*` proxy).

**Decision.** Park it. Stop/remove both containers; drop `traffology-ingest` from
nginx `depends_on` and let `/ingest/*` 404; gate the client-side beacon off at
source so readers' browsers don't fire at a dead endpoint; leave the schema and
both npm workspaces in the repo. Gateway needs no change (stale reads work,
live-count endpoints already fail soft). Retain pending a future focused effort.

**Consequences.** Stops the compute and operational attention for an unused
subsystem. Slightly more involved than parking trust (two real containers + one
nginx edit + a client-side flag) but no hard dependency breaks.

---

## Findings withdrawn on inspection

Recorded for honesty and to prevent re-litigation:

- **Two key services are *not* duplicated crypto.** Both `key-service` and
  `key-custody` import `nip44` from `nostr-tools`; the "duplication" is ~10 lines
  of wrapper each over the same audited library. More importantly, `key-custody`'s
  isolation of `ACCOUNT_KEY_HEX` (every user's private key) in a minimal, rarely-
  changed process is the **strongest service boundary in the repo** and should be
  kept, even hardened. `key-service` does straddle payment-entitlement (it reads
  `article_unlocks` directly) and crypto, but disturbing that straddle was judged
  not worth it. No change.

- **Outbound paths are *not* redundant.** See item 5 — native-to-relay and
  action-to-foreign-protocol are distinct purposes with divergent retry semantics,
  and the shared executor is a coherent choice. Original "three concepts for one
  job" framing was wrong; the Jetstream listener is inbound.

---

## Suggested execution order

```
1a (harden the existing drift guard)       ── small; anytime (NOT a prerequisite —
                                              existing CI drift check already covers 2/3/6)
7, 8  (park trust, park traffology)        ── anytime; shrink surface early
2  (finish UNIVERSAL-POST)                 ── schema change; existing drift guard covers it
3  (unified ledger)                        ── keystone; design for a possible later split
6  (DM reactions)                          ── cheap, do while table is empty
5  (outbound retry helper)                 ── low risk
4  (gateway module boundaries)             ── reversible; split god-files, promote to a real
                                              service only on demonstrated deploy/scale need
1b (extract 000_base.sql genesis)          ── DEFERRED; only if/when self-host needs a true
                                              from-empty replay. Unlocks "migrations canonical".
```

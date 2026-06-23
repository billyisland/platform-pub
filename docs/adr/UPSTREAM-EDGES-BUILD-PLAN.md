# Upstream Edges — Build Plan

**Companion to:** `UPSTREAM-EDGES-ADR.md` (Accepted, rewrite 2026-06-22). The ADR is the *what/why*; this is the *what-to-build, in order*. Where the ADR left a schema note open ("the build plan fixes…"), this resolves it.

**Status:** Phase 1 **complete** — backend + read-side rendering (2026-06-22), authoring UI + inline-prose citation marker (2026-06-23). **Phase 2 complete** — tribute authoring + contact, shipped dark behind `TRIBUTES_ENABLED` (2026-06-23); see *Phase 2 — as built* below. Phases 3–4 outstanding; Phase 3 still gated on the third-party-funds compliance question.

## Phase 1 — as built (2026-06-22)

Shipped in migration `125_upstream_edges.sql` + `gateway/src/routes/upstream-edges.ts` + the `UpstreamEdges` reader apparatus. Concrete decisions taken during the build (where the plan left a value open):

- **Addressable event kinds:** citations = **30100**, disputes = **30101** (app-specific NIP-33 range, alongside the pledge-drive kind 30078). Signed by the citing/disputing author, `p`-tagging the cited party; corrected in place via `d` = edge id. Withdrawal publishes a kind-5 retraction. New relay-outbox entity types: `citation`, `dispute`.
- **Dispute stake:** `DISPUTE_STAKE_PENCE = 500` (£5). Tab UPSERT (drive-by accounts have no tab row) + `recordLedger('dispute_stake', −500)`; withdrawal refunds idempotently via a conditional `withdrawn_at` claim + `recordLedger('dispute_stake_refund', +500)`. No clamp (negative balances permitted).
- **Omnivorous targets:** `POST /credits` / `POST /citations` resolve the source through the universal resolver's **synchronous Phase-A matches only** (no `initiatorId` ⇒ no async network chains, so the route stays synchronous). An identifier that resolves to nothing concrete becomes an unaddressable native credit (display-name label = the raw string).
- **Guards wired:** `upstream-edges.ts::2` registered in `check-ledger-adjacency.sh`; `ledger_reader_balance` widened (migration); reconcile A7 (stake↔dispute_edges) + A8 (stake↔refund pairing) + A6 orphan branch added.
- **Frontend — shipped:** the credit/citation piece-foot **apparatus** (`web/src/components/article/UpstreamEdges.tsx`, mounted in `ArticleReader`): credits with disclaimers adjacent; citations with pinned excerpt, cited-author dispute inline, third-party disputes as a count-on-expansion (never a glance-level badge). Reads `articleDbId` (the internal `articles.id` UUID, not the nostr event id).
- **Frontend — authoring UI (shipped 2026-06-23):** the `UpstreamEdges` apparatus now owns creation + dispute, so Phase 1 is exercisable end-to-end. The piece author gets inline `+ Add credit` / `+ Add citation` composers (omnivorous target/source field with a debounced universal-resolver preview — "→ member / external / feed / plain label"); any signed-in reader gets `Dispute`/`Reject this attribution` per edge, with the £5-stake notice shown to non-cited parties and suppressed for the cited/credited party. The apparatus renders for the author even with zero edges (so they can attach the first). Withdraw is durable across reloads: both GET endpoints now return the viewer's own non-withdrawn dispute as `disputes.mine` / `credit.mine` (`{id, counterCharacterisation, byCitedAuthor, staked}`), gated on `optionalAuth`; the apparatus dedupes that against the public disclaimer/cited-author render so it shows once. Backend GETs gained the `mine` projection only — no schema/ledger change.
- **Frontend — inline-prose citation marker (shipped 2026-06-23):** anchored citations now draw a numbered superscript marker in the body at `char_start`, jumping to the matching foot entry (crimson when the cited author has disputed). Injection is imperative into the `dangerouslySetInnerHTML` body via the shared offset util `web/src/lib/citation-anchor.ts` (plain-text-offset basis shared by capture + placement; markers removed/re-injected when the rendered body or citation set changes). Authoring captures the offset from the author's text selection: `QuoteSelector` gains an author-only **Cite** action that records `{excerpt, charStart, charEnd}` into the `citationDraft` store (`web/src/stores/citationDraft.ts`); the foot `CitationComposer` opens prefilled and carries the offsets through to `POST /citations` (dropped if the author edits the excerpt away from the selection). Backend already accepted/returned `char_start`/`char_end` (migration 125 + the GET projection), so this was frontend-only — no schema/route change. Scope: the free body only (paid-span anchoring remains the ADR's known hole). Unanchored citations (manual `+ Add citation`, no selection) still list at the foot without a marker.

**Status:** Draft 2026-06-22.

## Decisions resolved here (baked into the plan)

These were open in the ADR; settled for v1:

- **D1 — Publication × tribute: disallow.** A tributed piece may **not** be inside a publication, and a publication article may not be tributed. Enforced by validation in `POST /tributes` (reject when `articles.publication_id IS NOT NULL`) and in the publication article-add path (reject when a live/proposed tribute exists). This sidesteps the double-splitter (publications split `read_events` revenue at payout; tribute carves it at settlement — composing them means teaching `reservePublicationPayout` to subtract accruals). Composition is deferred to Phase 4. *(ADR Edge cases › Publication interaction.)*
- **D2 — Dispute stake is a real tab charge.** Modelled as a `−amount` debit on the disputant's `reading_tabs.balance_pence` (same shape as `vote_charge`), collected at their next settlement, refunded as a `+amount` tab credit on withdrawal. "Never forfeited" = always reclaimable by withdrawing; an un-withdrawn stake stays held (charged + parked), never lost. No new escrow primitive. *(ADR Decision 11.)*
  - **Collectibility caveat (known soft edge):** the stake is only ever *collected* when the disputant next settles a tab, which requires a Stripe payment method. A disputant with no payment instrument — who never reads paid content — never settles, so the debit sits on a (now-permitted) negative balance and is never realised. The anti-spam friction is therefore real for paying readers and **soft for drive-by accounts** (exactly the spam population). v1 accepts this; **require a payment method on file to file a *staked* (third-party) dispute** as the cheap hardening if abuse appears. The no-stake cited-author/credited-party path is unaffected.

## Grounding (verified against the codebase 2026-06-22)

The plan depends on these facts; if they change, revisit:

- **Per-read writer net is computed at *payout*, not stored** — `amount_pence − FLOOR(amount_pence * platformFeeBps / 10000)`, floored **per row** (`payout.ts` `runPayoutCycle`/`getWriterEarnings`; `platformFeeBps` default 800, `shared/src/db/client.ts:91`). Settlement computes the platform fee on the **tab aggregate** only (`reserveSettlement`, `settlement.ts:196`), and `confirmSettlement` (`settlement.ts:356`) bulk-advances many `read_events` to `platform_settled`. ⇒ Apportioning "at settlement" is a genuinely new step: compute per-read net at `confirmSettlement` for tributed reads. **Factor the per-read-net formula into one shared helper.** This formula is currently *hand-duplicated across ~12 sites in three files* — `payout.ts` (runPayoutCycle, getWriterEarnings, …), `gateway/src/routes/publications/revenue.ts`, `gateway/src/routes/my-account.ts` — with no central wrapper. The helper must back **both** the money paths (`confirmSettlement` + payout cycle) **and** the read-side display paths (Phase 3 author-display carve-out), or conservation and the author's dashboard drift apart.
- **Un-onboarded earnings hold implicitly** — there is no holding table; `platform_settled` reads with `writer_payout_id IS NULL` simply wait, because the payout eligibility query filters `stripe_connect_kyc_complete = TRUE AND stripe_connect_id IS NOT NULL`. ⇒ A released tribute accrual must be payable **even when the author never onboards**, so the inspirer payout is a **dedicated sweep** keyed on `tribute_accruals.state='released'`, not a rider on the author's read sweep.
- **Resolver** — `POST /resolve` (`gateway/src/routes/resolve.ts`, logic `gateway/src/lib/resolver.ts`) with `context:'invite'` (native-only, `skipExternal`) returns a `native_account` match carrying `account.id` for members, `external_source`/`rss_feed` otherwise. This is the inspirer-identification call.
- **Co-earner analog** — `computePublicationSplits` (`payout.ts:56-111`) + `publication_payout_splits`/`publication_article_shares` (`migrations/038_publications.sql`) is the existing multi-party split, but it runs at **payout** on a publication's aggregated pool and only ever pays resolved member accounts. Tribute's per-read-at-settlement + held-for-a-non-account is different enough that `tribute_accruals` is its own side-table (ADR Decision 3). General per-read co-earner attribution stays **deferred**.
- **Notifications** — no central helper; raw `INSERT INTO notifications (recipient_id, actor_id, type)`. Template: `gateway/src/routes/publications/members.ts:97`. Dedup is via partial unique indexes (`migrations/014`,`019`); a new `type` needs its own index to dedup.
- **Ledger funnel** — every money movement posts through `shared/src/lib/ledger.ts::recordLedger(client, …)` in the caller's txn. Append-only is DB-enforced (migration 119 row guard, 124 TRUNCATE guard). `reading_tabs.balance_pence` may go negative (migration 124) — **never re-introduce a clamp**.
- **Next migration number: 125.**

## CI guard checklist (the ledger tripwires WILL reject omissions)

Every money-touching slice below must, in the *same* PR, satisfy these. Sourced from `scripts/check-ledger-adjacency.sh`, `migrations/120_ledger_views.sql`, `scripts/reconcile-ledger.sql`.

1. **`LedgerTriggerType`** (`shared/src/lib/ledger.ts`) — add `dispute_stake`, `dispute_stake_refund` (Phase 1), `tribute_payout` (Phase 3).
2. **Adjacency `MARKERS` regex** (`check-ledger-adjacency.sh`) — currently matches `balance_pence = balance_pence [-+]`, `GREATEST(0, balance_pence`, and `INSERT INTO {vote_charges,writer_payouts,publication_payout_splits}` only. It will **not** see `tribute_accruals` inserts ⇒ **add `INSERT INTO tribute_accruals`** (Phase 3). The dispute stake writes `balance_pence = balance_pence -` ⇒ already matched ⇒ its file fails the guard until registered.
3. **Adjacency `REGISTRY`** — add the disputes route file (Phase 1) and bump `settlement.ts`'s `recordLedger` floor if its count rises (Phase 3) to the new minimum.
4. **`ledger_reader_balance` view** — add `dispute_stake`, `dispute_stake_refund` to its `trigger_type IN (...)`. **Mandatory:** these move the disputant's tab, so omitting them breaks the keystone invariant `−SUM(ledger) == reading_tabs.balance_pence` (reconcile B1). *(The ADR's ledger section omits this — do not.)*
5. **`ledger_writer_earnings` view** — add `tribute_payout` (Phase 3) so the inspirer's income counts as earnings. The author's reduced `writer_payout` already reflects the carve-out.
6. **`reconcile-ledger.sql`** — new assertions: stake↔refund pairing (every withdrawn dispute with a stake has a paired refund) [Phase 1]; per-read conservation `author-share + Σ accruals == read net` and `Σ(tribute paid accruals) == tribute_payout total`, plus "no `held` accrual has a ledger entry" [Phase 3]; A-section orphan branches for the new trigger/table pairs.
7. **Never `INSERT INTO ledger_entries` directly** — only via `recordLedger`. The held accrual deliberately lives in `tribute_accruals`, *outside* the ledger, until it reaches a real account.
8. **Schema round-trip** — after each migration, regenerate `schema.sql` via `pg_dump` from a fully-migrated DB, re-append the `_migrations` seed in the same step, run `scripts/check-schema-drift.sh`. Run `scripts/check-hairlines.sh <touched>` before any frontend ship.

## Phase 1 — Edges (credit, citation, dispute). No compliance gate.

Money-free except the disputant's own stake (D2), so it ships independently of the tribute compliance question. Establishes the ledger-guard wiring early.

**Schema (migration 125):**
- `credit_edges`, `citation_edges`, `dispute_edges` per the ADR sketch, with these fixes:
  - Drop `target_kind`; adopt the `citation_edges` convention (NULL `target_protocol` = native, non-NULL = that external protocol). Add a CHECK tying `target_protocol`/`resolved_account_id`/`target_external_id` consistency.
  - `dispute_edges`: keep the single-target CHECK `((citation_edge_id IS NULL) <> (credit_edge_id IS NULL))`.
  - Indexes: `(article_id)` on each edge table; `(citation_edge_id)`/`(credit_edge_id)` on disputes; for dispute-privilege lookup, `(source_author_pubkey)` on citations **and** `(resolved_account_id)` on credits (the credit-disclaimer match, `POST /disputes` below).
- Add `dispute_stake`, `dispute_stake_refund` to `LedgerTriggerType`; add both to `ledger_reader_balance` (guard #4) in the same migration.

**Gateway routes:**
- `POST /credits` — author; piece-level.
- `POST /citations` — author; store `excerpt` + `excerpt_sha256` (the real integrity anchor). v1 span source restricted to `content_free` + the viewer's own decrypted copy (paid-span hole, ADR Edge cases).
- `POST /disputes` — the no-stake privilege (`is_by_cited_author`) is computed per target:
  - **Citation target** → pubkey match: `disputant_pubkey == citation_edges.source_author_pubkey`.
  - **Credit target (disclaimer)** → `credit_edges` carries no `source_author_pubkey`, so match the credited party two ways (either qualifies): `disputant_account_id == credit_edges.resolved_account_id`, **or** `disputant_pubkey == credit_edges.target_external_id` when that field holds an npub (i.e. `target_protocol` is NULL/`nostr_external`). Add the privilege-lookup index `(resolved_account_id)` on `credit_edges` alongside `(source_author_pubkey)` on `citation_edges`.
  - Match ⇒ no stake. Otherwise: `recordLedger(dispute_stake)` debiting their tab, store `stake_ledger_entry_id`.
- `DELETE /disputes/:id` — disputant only; `recordLedger(dispute_stake_refund)` if a stake was held; set `withdrawn_at`.
- `GET /articles/:id/credits`, `GET /articles/:id/citations`.

**Signed events (per the relay-outbox invariant):** native/Nostr citations + disputes are addressable kind events enqueued through `enqueueRelayPublish` in the route's txn (correct-in-place, `p`-tag notify). ATProto/ActivityPub/RSS/email targets are Postgres-only.

**Guards this phase:** register the disputes route in `REGISTRY`; `ledger_reader_balance` += stake/refund; reconcile stake↔refund pairing.

**Frontend:** credit endnote block at piece foot (disclaimers adjacent); citation-point marker (cited-author dispute = one inline marker max; third-party disputes on expansion only); dispute/disclaimer expansion (characterisation, pinned excerpt expandable to context, counter-claims cited-author-first). Floating-✕ dismiss, no hairlines, tokens not raw hex.

## Phase 2 — as built (2026-06-23)

Shipped dark behind `TRIBUTES_ENABLED` (gateway, `shared/src/lib/env.ts::tributesEnabled`) + `NEXT_PUBLIC_TRIBUTES_ENABLED` (web, `lib/api/tributes.ts::tributesEnabled`). No money moves; `tribute_accruals` stays empty until Phase 3. Concrete decisions where the plan left a value open:

- **Migration 126** (`126_tributes.sql`): `tributes` + `tribute_accruals` per the plan — `target_kind` dropped (NULL-protocol-means-native, one grammar with the edges), `tribute_accruals.beneficiary_account_id` dropped (resolved through the parent `tributes.resolved_account_id`). Added `tributes.invite_token_hash` (the external-email claim token's SHA-256; see contact below) + `reminder_sent_at` (the 30d-reminder marker). **Cross-row ceiling = 9000 bps** (the author keeps ≥10%), enforced by the `tributes_validate_write` BEFORE trigger, which **also** enforces **D1 forward** (reject a tribute on a piece already in a publication); **D1 reverse** (a piece gaining a publication while a live/proposed tribute exists) is a second BEFORE-UPDATE trigger on `articles` — publication assignment is scattered across draft/publish paths, so a path-independent DB trigger is the only complete guard. The route also takes a per-article `pg_advisory_xact_lock` so concurrent adds can't race the ceiling. **No new notification dedup index** — the global `idx_notifications_dedup` already keys on `(recipient, actor, type, article)`, so a `tribute_offer_received` offer de-dups by construction. Drift guard green (schema.sql regenerated, 301 objects).
- **Resolver:** reuses Phase 1's `resolveTarget` (general context, synchronous Phase-A matches only) rather than `context:'invite'` — invite-context is native-only and would discard the external descriptor, but the render line needs it ("X% goes to @alice.bsky.social"). Membership is detected by the presence of `accountId` on the resolved target; that's the in-app vs email branch.
- **Oracle-close:** `inviteEmail` is **optional** in the schema but the FeedComposer field is **always shown**, and `POST /tributes` returns a uniform `{id, status:'proposed'}` regardless of branch — no account-existence oracle. An identifier that resolves to a member ignores the email (in-app); a non-member with an email gets the claim email; an unaddressable target with no email is proposed-but-unreachable (held, lapses → swept to author; `first_contact_at` stays NULL, the window still runs from creation).
- **Published-required:** a tribute can only be added to a **published** piece — the inspirer is sent to `/article/:dTag` to read it before deciding, and that route only serves `published_at IS NOT NULL`.
- **Routes** (`gateway/src/routes/tributes.ts`, registered `/api/v1`, every handler 404s while dark): `POST /tributes`, `POST /tributes/:id/consent` (proposed→live, flips held accruals→released — no-op in P2; Connect-onboarding is gated at the P3 payout, not here), `POST /tributes/:id/decline` (→declined, held→swept), `POST /tributes/claim` (binds an external invitee's now-authenticated account via the token, grants the comp read, returns the article d-tag), `DELETE /tributes/:id` (author withdraws a *proposed* tribute only), `GET /articles/:id/tributes` (the render line; invite email never exposed), `GET /tributes/mine` (the viewer's incoming offers).
- **Contact pipeline:** in-app (member) = a `tribute_offer_received` notification + an `author_grant` `article_unlocks` comp read (the gift-links precedent; `checkArticleAccess` grants on any unlock row). External = a sober claim email carrying `${APP_URL}/tribute/claim?token=…`, with a token-**redacted** reference copy CC'd to the author. Both email sends run **after** the txn commits. The claim **avoids touching core auth**: the token is only stored hashed, the email links to a landing page that stashes it in `sessionStorage` and (if needed) sends the user to sign up; a headless `TributeClaimResumer` (mounted in `LayoutShell`) redeems the stash the moment auth resolves — so the claim survives the signup round-trip — then routes them to the piece.
- **Lifecycle worker** (`gateway/src/lib/tribute-sweep.ts::runTributeSweep`): the **hourly** gateway worker cadence, advisory-locked `ADVISORY_LOCKS.TRIBUTES` (100006), only scheduled when `tributesEnabled()`. The 30d reminder **rotates the claim token** and re-emails the link for an unclaimed external invite (only the hash is stored, so the original link can't be reproduced — a fresh token is the honest remind); in-app/claimed offers just stamp `reminder_sent_at`. The 60d lapse flips `proposed→lapsed` and sweeps `held→swept` atomically (state only; the money return is realised in P3's payout cycle).
- **Frontend:** the `UpstreamEdges` apparatus gains a **Tributes** section (gated on `tributesEnabled()`): the render line ("X% of this piece's earnings goes to Y · honest status"), the author's `+ Add tribute` composer (omnivorous source + %-share + always-email + note, resolver preview), the author's Withdraw on a proposed tribute, and — for the resolved inspirer viewing the piece — inline **Accept / Decline**. Plus the `/tribute/claim` page, the `TributeClaimResumer`, and the `tribute_offer_received` notification (label + opens `/article/:slug`).
- **Guards:** Phase 2 writes **no** `ledger_entries`/`reading_tabs` — the ledger adjacency guard is untripped (verified). Hairline tripwire + `next build` + root promise-safety lint all green.

**Compliance gate still open:** Phase 3 (settlement apportionment + payout) must not be enabled until the third-party-funds question (ADR Edge cases › Holding third-party funds) is resolved.

## Phase 2 — Tribute authoring + contact (accrual writes dark).

No money moves yet; this builds identification, consent, and the contact pipeline. **The compliance question (ADR Edge cases › Holding third-party funds) must be resolved before Phase 3 is enabled** — Phase 2 can build behind a dark flag while that's in flight.

**Schema (migration 126):**
- `tributes`, `tribute_accruals` per the ADR sketch. Add:
  - Cross-row ceiling: a constraint/trigger ensuring Σ live+proposed `percentage_bps` per article leaves the author a meaningful share (no per-row CHECK can express it).
  - D1 enforcement: reject creation when `articles.publication_id IS NOT NULL`.
  - `tribute_accruals.state` ∈ `held|released|paid|swept`; one row per (live tribute, settled read).
  - **Drop `target_kind` from `tributes` too** — same fix as the Phase-1 edges: adopt the NULL-`target_protocol`-means-native convention, one consistent target grammar across all three edge tables. (The ADR sketch still shows `target_kind` on `tributes`; it goes.)
  - **Drop `tribute_accruals.beneficiary_account_id`** (the ADR sketch carries it, NULL-while-held). It's redundant with `tributes.resolved_account_id` — the inspirer-payout sweep already joins `tributes` for the account, and a second copy is a drift hazard. The accrual's `state` alone tracks lifecycle; resolve the account through the parent tribute.

**Gateway routes:**
- `POST /tributes` — resolve inspirer via `POST /resolve` (`context:'invite'`). Native match → `proposed` + in-app offer. No match → author supplies `invite_email` → onboarding mail.
  - **Oracle decision (resolved):** the divergent UX (member ⇒ instant in-app offer; non-member ⇒ *ask for email*) is itself the account-existence oracle — asking-for-email-or-not leaks membership. v1 closes it by **always collecting a contact field up front** in a single request: the author submits both the identifier *and* a fallback email in one form, and the response is uniform ("we'll reach them") regardless of match. When the identifier resolves to a member, the in-app offer fires server-side and the supplied email is ignored; when it doesn't, the email branch runs — but the author can't distinguish the two from the response. No second round-trip, no "is this a member?" signal. (This is a deliberate small UX tax — the author always types an email even for a known member — accepted as the price of not shipping an enumeration endpoint.)
- `POST /tributes/:id/consent` / `/decline` — inspirer. Consent + Connect onboarding → `live`, set `resolved_account_id`/`consent_at`, flip `held` accruals → `released`. Decline → `declined`, accruals `swept`.

**Contact pipeline:**
- In-app: `type='tribute_offer_received'` notification (raw insert, `members.ts:99` template) + a new partial unique index for its dedup. **Grant comp read access to the piece** by inserting an `article_unlocks` row with `unlocked_via='author_grant'` — `checkArticleAccess` (`gateway/src/services/article-access/access-check.ts:49`) grants on *any* unlock row, so this is sufficient. Reuse the existing gift-links precedent (`gateway/src/routes/gift-links.ts:178`), which inserts the same `author_grant` unlock. **Not** `read_events.on_free_allowance` — that is a billing-allowance flag on charge rows, not an access grant. The grant is kept on decline (ADR: don't claw back a courtesy read).
- External email: magic-link binding new signup → this tribute (+ comp read); author CC'd a token-redacted reference copy. Window 60d from `first_contact_at`, reminder at 30d, → `lapsed` on no response; held share swept to author. No social-DM fallback.

**Tribute lifecycle worker (build it here, name it now):** the window/reminder/lapse transitions need an owner — a scheduled sweep, not an implicit wait. Model it on the gateway scheduler's `runDiscoverySweep` (advisory-locked periodic sweep) or a Graphile Worker job in `feed-ingest/`: on each tick, send the 30d reminder for `proposed` tributes past `first_contact_at + 30d` with no reminder sent, and flip `proposed → lapsed` past `window_expires_at`. The held→`swept`→author return is *posted by the lapse* but **realised in the next payout cycle** (Phase 3 `runPayoutCycle` returns `swept` accruals) — the worker only flips state; it moves no money. Pick the home (gateway scheduler vs feed-ingest) when wiring; both already exist.

**No accrual writes yet** — `tribute_accruals` stays empty until Phase 3 flips settlement apportionment on.

## Phase 3 — Money live (gated on compliance sign-off).

**Compliance gate — position drafted (`UPSTREAM-EDGES-TRIBUTE-COMPLIANCE.md`, 2026-06-23).** The held-funds question is resolved to a defensible structure: because the platform runs Stripe Connect *separate charges and transfers* (settlement charges to the platform's own balance; payout is a later separate transfer — verified in `settlement.ts`/`payout.ts`), the tribute hold is the same float the platform already holds for every unpaid writer earning, and the held share is **the author's deferred earnings under a revocable redirect instruction** until the inspirer consents — not third-party client money. This holds *only* if Phase 3 ships the framing conditions in the memo (author terms; **inspirer contact = a conditional offer, never "funds held in your name"**; no ring-fenced account; "reserved, pending redirect" display). The Phase-2 email/render **copy audit is done (2026-06-23)** — every contact/render surface now uses the conditional-offer wording (memo condition #2). **The sole remaining gate before enabling the money flag:** the compliance owner must sign the memo's residual checklist — chiefly point #1, the platform's *pre-existing* baseline reliance on Stripe as the regulated PI/EMI (a platform-wide question tributes inherit, not create). Fallbacks if needed: Dial A (consent-gated accrual) or Dial B (Stripe funds segregation).

**`LedgerTriggerType` += `tribute_payout`; add to `ledger_writer_earnings` (guard #5).**

**Settlement apportionment** (`payment-service/src/services/settlement.ts`, `confirmSettlement`):
- For each read advanced to `platform_settled` on a `live` (or `proposed`-and-accruing) tributed article, compute per-read net via the **shared helper** (Grounding), partition among author + live tributes, insert frozen `tribute_accruals` rows (`state='held'`, `amount_pence` frozen at the moment's bps; the inspirer account is resolved through the parent `tributes.resolved_account_id`, not denormalised onto the accrual).
- Conservation: `author-share + Σ accruals == read net`, no clamp, dust per the existing per-row floor rule.
- Guards: `MARKERS` += `INSERT INTO tribute_accruals`; bump `settlement.ts` `REGISTRY` floor.

**Author payout** (`runPayoutCycle`): author paid net of `held|released|paid` accruals carved off their reads, **plus** `swept` accruals returned. Never the full pre-tribute net alongside a separate debit (double-subtract). `writer_payouts.amount_pence` stays == the Stripe transfer (reconcile A4 holds).

**Author *display* must carve too (don't ship the gap):** `runPayoutCycle` nets accruals, but the author-facing earnings figures are computed by the *same per-read-net formula on `read_events`* without touching the accruals side-table — so they over-report a tributed author's earnings (the read still has `writer_id = author`). The pre-tribute gross would be shown while the cheque is smaller. The duplicated net formula lives in **`payout.ts:getWriterEarnings`, `gateway/src/routes/publications/revenue.ts`, and `gateway/src/routes/my-account.ts`** (verified: ~12 sites across the three). When factoring the shared per-read-net helper (Grounding), **route these display paths through it too and subtract live (`held|released|paid`) accruals** for tributed reads — the helper's job is conservation everywhere the net is read, not only at `confirmSettlement`/payout. (Note these dashboards are the `getWriterEarnings` "earned-incl-pending" quantity, deliberately *not* cut over to `ledger_writer_earnings` per the money-ledger invariant — so the ledger views don't cover this; the source-query carve-out is the only fix.)

**Inspirer payout — dedicated sweep:** select `tribute_accruals.state='released'` for tributes whose `resolved_account_id` is Connect-onboarded; transfer via Connect; flip accruals → `paid`; post one `tribute_payout` (`+share`, `counterparty_id = author`). No mirrored debit. Idempotency key per (tribute, cycle).

**Refund/chargeback:** a reversed read must unwind the author's credit *and* its tribute accruals. `held|released` accruals on the reversed read are voided in place (no money has left). An already-**`paid`** accrual is the hard case: the money has already transferred to the inspirer via Connect, so recovery is **not** in scope here — post a reversing `tribute_payout` entry (never an edit) and let the inspirer's balance go negative, **inheriting the platform's existing writer-payout chargeback posture** (a clawed-back writer payout already leaves a writer owing the platform; the inspirer is the same case, not a new one). Do not pretend the funds are recoverable synchronously.

**Reconcile:** per-read conservation; `Σ(tribute paid accruals) == tribute_payout total`; no `held` accrual has a ledger entry; orphan branches.

## Phase 4 — Composition.

- Wire `tributes.citation_edge_id` UX (a tribute that points at a specific citation).
- (Optional) revisit D1 — publication × tribute composition (tribute off net first, publication splits remainder), if demand warrants the `reservePublicationPayout` change.

## Deferred (from the ADR, unchanged)

- Standing-record author-profile view (corrected/defended/ignored, no score).
- Byte-stable native citation (`article_event_versions` persisting signed bytes at publish) — until then native citations rely on `excerpt` + `excerpt_sha256`.
- General per-read co-earner attribution layer (would also let net be stored per read instead of recomputed).

## Build order summary

1. **Phase 1** — edges + dispute stake. ✅ **Shipped 2026-06-22** (backend + read-side rendering); **authoring UI shipped 2026-06-23** (create credit/citation, file/withdraw dispute, resolver preview); **inline-prose citation marker shipped 2026-06-23** (selection→Cite captures `char_start`/`char_end`; numbered superscript marker injected into the body, jumps to the foot entry) — see *Phase 1 — as built* above. **Phase 1 is now complete.** Established the ledger-guard wiring.
2. **Phase 2** — tribute authoring + contact, accrual dark. ✅ **Shipped 2026-06-23** behind `TRIBUTES_ENABLED` / `NEXT_PUBLIC_TRIBUTES_ENABLED` — see *Phase 2 — as built* above (migration 126, `tributes.ts` routes + contact pipeline, `tribute-sweep.ts` lifecycle worker, the `UpstreamEdges` Tributes section + `/tribute/claim`). Resolve compliance in parallel before Phase 3.
3. **Phase 3** — settlement apportionment + author/inspirer payout. Gated on compliance sign-off.
4. **Phase 4** — citation-tribute composition.

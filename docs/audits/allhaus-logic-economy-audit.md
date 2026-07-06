# platform-pub — Logic & Economy Audit

**Date:** 2026-07-05 · **Scope:** money paths end to end (accrual → settlement → payout → chargeback), ledger discipline, subscriptions, publications, tributes, voting, gate-pass, Stripe integration, plus a targeted logic sweep of auth and concurrency patterns. ~588 TS files; the payment-service and gateway article-access/subscription code was read in full; the rest was swept by pattern.

**Headline:** the read-money core (accrual → tab settlement → writer payout → chargeback) is unusually well engineered — three-phase Stripe durability, stable idempotency keys, append-only ledger with mirror-entry discipline, reconcile sweeps for missed webhooks, a pure chargeback planner with telescoping conservation. The serious problems are all at the *seams*: subscriptions, publications, and the Stripe transfer-event model each diverge from what the read-money core assumes. Three findings are P0-grade in the sense that real money either never moves or moves to the wrong party.

**Revision note (2026-07-05):** a code-grounded re-verification pass confirmed findings 1–8, 10–12, 14 and the P3 notes against the actual source (payment-service and gateway article-access/subscription/payout paths read directly). **Finding 13 is retracted** (both claims were already handled in the code) and **finding 9 was corrected** (the int4-overflow and "voting is retired" assertions were wrong). Calibration notes were added to findings 4, 7, and 11 where the original overstated impact. Inline corrections are marked with the date. A fix implementation plan follows the findings.

**Decisions locked (2026-07-05, post-verification review):** an independent re-verification (five targeted passes over payment-service + gateway article-access/subscription/payout) reconfirmed findings 1–12 and 14 against source with no surviving false positives. The owner then settled the open product/architecture questions:

- **F3 (unlock posture) → hard gate.** Refuse the gate pass once `free_allowance_remaining_pence − amount < 0` (configurable `FREE_ALLOWANCE_FLOOR_PENCE`), and make provisional `article_unlocks` non-permanent until settlement.
- **F9 (paid voting) → remove entirely.** Strip the `vote_charges` money path from accrual/settlement/payout/chargeback and the frontend paid-vote path; leave the `votes`/`vote_charges` tables and their historical ledger entries inert (the ledger is append-only). This shrinks F5 and dissolves the `vote_charges` half of F6.
- **F1 (subscription writer leg) → fold into the per-read payout base** (not a parallel pool). Requires a `writer_payout_id` (or link table) on `subscription_events` so folded earnings are claimed exactly once; subscription income then counts toward the KYC/£20 threshold like reads.
- **F10 (`revenue_share_bps`) → fixed share-of-revenue.** Enforce `SUM(bps) ≤ 10000` at write time; platform retains any unallocated remainder (stop the normalized-weight renormalisation).
- **F12 (post-chargeback re-collection) → hold flag on reversal** (reuse `card_action_required_at` or a dedicated `dispute_hold_at`); keep the debt restore, gate only collection.
- **F4 (dead webhook branches) → verify, then delete.** Confirm against live Stripe (a test-mode platform→connected transfer / the account's API-version event log) that `transfer.paid`/`transfer.failed` genuinely don't fire *before* deleting the branches; add the `transfer.reversed` handler and key completion off the `transfers.create` response regardless.

**Path correction (2026-07-05):** several findings and fix-plan items below cite `accrual.ts` / `payout.ts` / `recordGatePass` bare or under `gateway/`. The authoritative locations are **`payment-service/src/services/accrual.ts`** (`classifyRead`, `recordGatePass`, `convertProvisionalReads`), **`payment-service/src/services/payout.ts`** (`reserveWriterPayout`, both payout cycles, `computePublicationSplits`), and **`payment-service/src/routes/payment.ts`** (the gate-pass route). Line numbers are accurate; the service prefix is corrected inline where it would mislead an implementer.

---

## P0 — money does not move, or moves to the wrong party

### 1. Subscription revenue is never collected and never paid out

Every subscription charge path — create (`gateway/src/routes/subscriptions/writer.ts:150, 214`), the publication equivalent, and auto-renewal (`gateway/src/workers/subscription-expiry.ts:148`) — "charges" the reader by decrementing `accounts.free_allowance_remaining_pence`. The comments and `docs/audits/SUBSCRIPTIONS-GAP-ANALYSIS.md` call this "the reading tab" and assert it "accrues negative — settled via Stripe later." It is not the tab. Stripe settlement (`payment-service/src/services/settlement.ts`) operates exclusively on `reading_tabs.balance_pence`; no code path anywhere reads a negative `free_allowance_remaining_pence` and converts it into a settleable balance. `convertProvisionalReads` converts `read_events` and `vote_charges` only. So a subscribing reader's allowance column drifts arbitrarily negative and the platform never collects a penny.

The other leg is equally dead: `logSubscriptionCharge` (`routes/subscriptions/shared.ts`) writes a `subscription_events` credit for the writer, but the payout eligibility base in `payout.ts` sums only `read_events` and `vote_charges`. Subscription earnings never enter a payout, and no `recordLedger` call is made anywhere in the subscription paths — the entire product is outside the ledger whose stated discipline is "every money path posts through the single funnel."

The system is internally consistent (nobody charged, nobody paid), which is why the 48-test payment suite and the renewal live-verification both pass — they verify the column decrements, not collection. But as shipped, subscriptions are a bookkeeping fiction. Fix direction: subscription charges should debit `reading_tabs.balance_pence` (with the mirror `recordLedger` entry, a new trigger type), which makes them collectable by the existing settlement machinery; the writer credit needs a decision about whether it flows through the payout base or a parallel settled-subscription pool.

### 2. The individual writer payout cycle strips publication revenue before the publication cycle runs

`PUBLICATIONS-SPEC.md` §1.6: publication-article revenue is pooled and split by standing shares and per-article overrides, "cleanly isolated from the existing individual writer payout flow." The code does not isolate it. The writer cycle's eligibility base (`payout.ts:348`), the locked recompute in `reserveWriterPayout` (~line 490), and its claiming `UPDATE read_events … WHERE writer_id = $2 AND state = 'platform_settled' AND writer_payout_id IS NULL` (~line 545) contain no `articles.publication_id IS NULL` filter. Publication articles carry the human author's `writer_id` on their `read_events` (set from `article.writer_id` in `gate-pass.ts:148`).

The worker (`payment-service/src/workers/payout.ts`) runs `runPayoutCycle()` *before* `runPublicationPayoutCycle()`. So any publication-article read whose author is individually payable (KYC complete, combined net ≥ £20) is claimed under a personal `writer_payout` and transferred to the author in full; the publication cycle, which selects the same `writer_payout_id IS NULL` rows, finds nothing. Standing members, flat fees, and article revenue shares are all bypassed. Compounding it, `confirmSettlement` posts the full `writer_accrual` to the author for publication reads, and `getWriterEarnings`/`getPerArticleEarnings` display them as personal earnings — so even where the publication cycle *does* win the race (author below threshold), the author's dashboard and `ledger_writer_earned` claim money that actually went to the pool.

Fix: exclude `publication_id IS NOT NULL` reads from the writer cycle's base, recompute, and claim queries (and decide the corresponding treatment for `writer_accrual` and the earnings views — probably attribute publication reads to a publication-level earned figure).

### 3. Card-less accounts get unlimited permanent unlocks for free

`classifyRead` (`payment-service/src/services/accrual.ts:35`) marks every no-card read `provisional` regardless of allowance state, `recordGatePass` decrements `free_allowance_remaining_pence` on the card-less path with no floor or remaining-balance check (gated on `!hasCard`, not literally "unconditional" — card holders never hit it — but unbounded within that path; no CHECK constraint floors it), and nothing — not the accrual service, not the gate-pass route, not `routes/payment.ts` — rejects a read when the allowance is exhausted. `allowanceJustExhausted` is a UI signal only. Worse, step 6 of `performGatePass` writes a *permanent* `article_unlocks` row for every successful gate pass, provisional included. A reader on a burner email can therefore unlock the entire paid catalogue permanently, with the only consequence being an ever-more-negative allowance column that materialises into debt *only if they voluntarily attach a card*.

This may be a deliberate soft-paywall posture for launch — but if so it should be a documented decision with a cap, because as written it is an unmetered giveaway with a trivially exploitable permanent-unlock side effect. Minimum hardening: gate key issuance once `free_allowance_remaining_pence − amount < 0` (or a configured floor), and consider making provisional unlocks non-permanent until conversion.

---

## P1 — the machinery targets events that won't arrive, or races itself

### 4. `transfer.paid` / `transfer.failed` are not delivered for platform→connected-account transfers

The payout confirmation model (`webhook.ts` cases `transfer.paid` / `transfer.failed`; `confirmPayout`, `handleFailedPayout`, `confirmTributePayout`, `handleFailedTributePayout`, `confirmPublicationSplit`, `handleFailedPublicationSplit`) is built on webhook events that the current Stripe API does not emit for `transfers.create` to a connected account. The events list for modern API versions includes only `transfer.created`, `transfer.updated`, and `transfer.reversed`; <cite index="4-1">the legacy `transfer.paid`/`transfer.failed` events applied to transfers from connected Stripe accounts to their bank accounts, not to transfers to the connected accounts themselves</cite>. The in-code comment ("Stripe SDK v14 types don't include all webhook event types … but they are valid at runtime") is the wrong conclusion from the missing types.

Consequences: every payout row of all three kinds stalls at `initiated` forever (`completed` is unreachable), and the entire failure-rollback branch — reads released back to `platform_settled`, accruals unclaimed — is dead code. **(Calibration, 2026-07-05: the funds actually move and the `writer_payout` ledger entry posts *synchronously* at the `initiated` transition off the `transfers.create` response — `completed` is a reporting/reconciliation status, not the money gate. So no money is stuck; the exposure is (a) completion/reporting is permanently blind and (b) reversals are unhandled — not stalled payouts.)** In practice platform→Connect transfers land in the connected balance near-synchronously and rarely fail post-create (the terminal-create path you already handle covers most real failures), so the money risk is modest; but your completion tracking is a permanent blind spot and `transfer.reversed` (which *does* fire, e.g. on a platform-initiated reversal) is unhandled. Fix: treat a successful `transfers.create` response as completion (or key on `transfer.created`), delete the paid/failed branches, and add a `transfer.reversed` handler.

### 5. The chargeback planner is publication-blind

`computeChargebackReversal` (`chargeback.ts:158`) reverses every `writer_paid` read against `read_events.writer_id` with a `writer_payout_reversal`. Reads paid via a *publication* payout were never paid to the writer personally — the money went to split recipients per `publication_payout_splits`. A chargeback on such a read posts the reversal to the wrong account: the author's ledger goes negative for money the standing members received. This interlocks with finding 2 (today the writer cycle usually steals those reads first, making the reversal accidentally "correct"); once 2 is fixed, this becomes an active mis-attribution. The planner needs the payout vehicle per read (personal vs publication) and, for publication reads, reversal entries per split recipient.

### 6. SELECT-then-UPDATE claim races (READ COMMITTED per-statement snapshots)

Two money paths compute an amount from a `SELECT` and then claim rows with a *separate* `UPDATE` whose predicate can match rows that committed in between:

`convertProvisionalReads` (`payment-service/src/services/accrual.ts:180`) selects provisional reads `FOR UPDATE`, then updates `WHERE reader_id = $2 AND state = 'provisional'` — a concurrent `recordGatePass` (which locks the *account*, not held by the converter) can commit a fresh provisional read between the two statements; the blanket UPDATE flips it to `accrued`, but it is in neither `totalPence` (tab under-incremented) nor the ledger loop (missing debit entry). The Phase-3 "−SUM == balance" invariant breaks silently. Note the vote-charges branch immediately below already uses the correct `UPDATE … RETURNING` pattern; make the reads branch match it, or lock the account row first.

`reserveWriterPayout` (`payment-service/src/services/payout.ts:474–560`) computes `lockedAmountPence` from a subquery, then claims with unconstrained `UPDATE … WHERE state='platform_settled' AND writer_payout_id IS NULL`. It *does* take `SELECT id FROM accounts … FOR UPDATE` (serialising concurrent payouts for the *same writer*), but that does not close the settlement race: `confirmSettlement` does not hold the writer's account lock, so reads settling mid-transaction get claimed (flipped toward `writer_paid`) without being in the transferred amount — the writer is underpaid for rows marked paid. Same fix: claim via `UPDATE … RETURNING` and sum the returned rows, and derive the transfer amount from the claim.

### 7. Gate-pass has no concurrency or retry idempotency — double charges

`read_events` has no unique constraint on `(reader_id, article_id)` (only the unlock table does), and the permanent unlock is written *after* the payment call. Two concurrent gate passes for the same article both pass `checkArticleAccess`, both hit `/gate-pass`, and both debit the tab — a double-tap on a slow connection is enough. Separately, the gateway→payment-service call carries no idempotency key: an ambiguous network failure after the payment service committed, followed by a client retry, charges twice (the unlock that would have short-circuited the retry was never written). **(Calibration, 2026-07-05: a *partial* guard exists — once step 6's `article_unlocks` row is written, a retry short-circuits at `checkArticleAccess` → `already_unlocked` and skips payment. The unguarded window is specifically "payment committed but step 6 not yet written" (crash/retry between the payment call and the unlock insert), plus the genuine concurrency race of two simultaneous first-reads. Narrower than "no retry protection anywhere," but real.)** Fix: a per-(reader, article) advisory lock or unique guard in `recordGatePass`, plus an idempotency key derived from `(readerId, articleId)` on the internal call.

### 8. Webhook-delivered payment failures don't back off — decline hammering

The synchronous terminal-decline path in `completeSettlement` sets `card_action_required_at` so settlement backs off until a card re-attach. The asynchronous path — `payment_intent.payment_failed` via `handleFailedPayment` (`settlement.ts:640`) — marks the settlement `failed` and does nothing else. `checkAndSettle` runs on *every* gate pass, so a reader with a card that declines asynchronously gets a fresh settlement attempt per read against a known-bad card: Stripe decline fees, issuer risk flags, and a pending-settlement churn loop. `handleFailedPayment` should set the same back-off flag. **Independent bug (2026-07-05):** its UPDATE is `WHERE id = $1` only — no `AND status = 'pending'` guard (unlike `completeSettlement`/`confirmSettlement`), so a late or duplicate `payment_intent.payment_failed` webhook arriving *after* a settlement already reached `completed` flips it `completed → failed`. That is state corruption on its own, not merely decline-hammering — add the status guard as well as the back-off flag.

---

## P2 — economy semantics and consistency

### 9. Paid voting is fully live and threads money-path surface through every stage

Paid up/downvotes are **live in the running code** — `gateway/src/routes/votes.ts`, `web/.../VoteControls.tsx` (still renders the paid-confirm modal and charges from the 2nd vote onward), `shared/src/lib/voting.ts`, and `vote_charges` handling run through accrual conversion, settlement advancement, payout eligibility (KYC-gated in `payout.ts`), and the chargeback planner. There is no flag, config, or gate disabling or zeroing vote cost anywhere in the four services.

**(Correction, 2026-07-05: an earlier draft framed this as "paid voting is retired at the product level but load-bearing in the code." That is wrong — retirement is not reflected anywhere in the code; the running system charges real money for votes and fully exposes the flow to users. If retirement is the intended product direction it must be decided and then implemented, not assumed.)** The observation that survives is scope: this is a large money-path footprint, and if voting is later simplified or removed, findings 5 and 6 get cheaper once `vote_charges` leaves the model.

`voteCostPence` doubles unbounded (`shared/src/lib/voting.ts:24-26`, no cap). **(Correction: the earlier "exceeds int4 around the ~29th vote" claim is wrong — `votes.cost_pence` and `vote_charges.amount_pence` are `bigint`, not int4. The real ceilings are ~n≈51 (JS `Number` integer precision) and ~n≈62 (bigint), both economically unreachable. No practical overflow risk; a cost cap is still worth adding for hygiene.)**

**Decision (2026-07-05): remove paid voting entirely.** Strip the `vote_charges` money path from accrual/settlement/payout/chargeback and the frontend paid-vote path; leave the `votes`/`vote_charges` tables and their historical ledger entries inert (append-only — the history can't be deleted). This dissolves the `vote_charges` half of F6 and shrinks F5 (one fewer reversal path); the `read_events` races in F6a/F6c remain and are unaffected by removal.

### 10. Publication split arithmetic: overdraw and weight-vs-percentage ambiguity

In `computePublicationSplits` (`payout.ts:61`), `revenue_bps` article overrides decrement `remainingPool` with no floor — overlapping shares on the same article (nothing in this function caps the bps sum at 10000) can drive the pool negative, in which case the emitted splits exceed the fee-net pool and the platform pays the difference. Standing shares are then distributed as `remainingPool × bps / totalStandingBps` — i.e. *normalized weights*: a sole member with `revenue_share_bps = 1` receives 100% of the pool. If the members UI presents `revenue_share_bps` as "share of publication revenue," a publication with members summing to 6000 bps will pay out 100% rather than 60%. Confirm the intended semantics and either enforce the invariant at write time or guard in the split function.

### 11. Subscription fee rounding diverges from the platform rule

`logSubscriptionCharge` uses `Math.round((price × feeBps)/10000)`; every other money path floors, per the documented per-row-then-floor rule that `per-read-net.ts` exists to centralise. One-penny divergence per charge, and a second definition of "net" in the codebase — fold it into the shared helper when subscriptions are wired into the ledger (finding 1). **(Calibration, 2026-07-05: currently cosmetic — per finding 1 the `subscription_events` credit never pays out, so the rounded value affects only a displayed figure. It becomes real money the moment finding 1 is fixed, which is exactly when the helper should be adopted.)**

### 12. Post-chargeback re-collection is automatic — a dispute-risk decision hiding in the code

`reverseSettlement` restores the full disputed amount to `reading_tabs.balance_pence`. The next threshold crossing then re-charges the same card for debt the cardholder just disputed. Card networks treat re-charging disputed amounts harshly (repeat disputes, monitoring-programme thresholds). The debt restore is correct ledger-wise, but collection should probably be gated (e.g. set `card_action_required_at` on reversal, or require an explicit re-consent) rather than automatic.

### 13. ~~Defence-in-depth inconsistencies on internal routes~~ — RETRACTED (2026-07-05)

Both halves of this finding are wrong against the current code:

- The two `GET /earnings/:writerId` routes are **intentionally** unguarded, documented in `payment-service/src/routes/payment.ts:10-12`, with owner-only access enforced gateway-side. This is a deliberate design decision, not an oversight.
- Internal-token comparison is **already constant-time**: `payment.ts` compares via `crypto.timingSafeEqual` in a `constantTimeEqual` helper (`:14-21`), and the file carries a comment (`:13`) explaining exactly why a plain `!==` on the secret would leak a timing oracle. The residual `!==` uses are a length pre-check and type guards, not the secret comparison.

Nothing to fix here. (The original claim likely came from a code pattern the auditor expected rather than the code that is present.)

### 14. Free-allowance accounting misstates partial-allowance reads

`classifyRead` marks a read `on_free_allowance` whenever any allowance remains, even if the read exceeds it (5p left, 10p read → the full 10p flagged as allowance), and the decrement runs even when the allowance is already ≤ 0, so the column keeps drifting negative on the read path independent of finding 1. Whatever write-off treatment the ADR's §I.3/§II.3 applies at settlement will be computed against a flag that doesn't reflect the actual allowance/chargeable split. Model the split explicitly (allowance-consumed pence per read) or floor the classification.

---

## P3 — notes

`resumePendingSettlements` runs only at process startup; a settlement stuck `pending` after a transient Stripe error waits for a restart (the reconcile sweep only covers `completed`-but-unconfirmed rows). Payouts resume every cycle — give settlements the same periodic resume. Subscription period arithmetic uses fixed 30/365-day millisecond adds (drift across DST/leap; acceptable if deliberate). `confirmSettlement` advances reads by `read_at <= settled_at`, so a provisional read converted between reservation and confirmation can be marked `platform_settled` (and earn its writer a `writer_accrual`) under a settlement whose charged amount predates it — money conserves across the *next* settlement, but read-level attribution to settlements is approximate; worth a comment at minimum since reconciliation queries may pair on it.

## What holds up well

The three-phase reserve→Stripe→complete pattern with stable idempotency keys is applied consistently across settlements, writer payouts, publication splits, and tribute payouts, with terminal-vs-transient error discrimination and crash resume. The webhook endpoint does signature verification against multiple secrets, livemode guarding, and durable event claiming with retry-safe `processed_at` semantics. The reconcile sweeps (`reconcileSettlements`, `reconcileConnectKyc`) correctly treat Stripe webhooks as at-least-once and self-heal in both directions. The ledger's sign conventions, the negative-balance policy (column and ledger move by the same signed delta, no clamps), the per-row-then-floor rounding rule centralised in `per-read-net.ts`, and the pure, unit-testable chargeback planner with telescoping tribute conservation are all genuinely strong. The failures above are almost entirely cases where a *newer* subsystem (subscriptions, publications) was built against a mental model of the money core rather than its actual tables — the core itself is sound.

## Suggested order of attack

Fix 1 and 2 first (they are revenue-existential and each is a scoped SQL/flow change); then 7 and 8 (reader-facing double-charge and decline-hammering are trust-destroying at launch); then 4 (delete the dead webhook branches and key completion on the create response); then 6, 5, and the P2 semantics items (9, 10, 12) — all now decided (see *Decisions locked* at the top): F9 removes the vote money-path, F10 enforces fixed-share caps, F12 adds a dispute hold. Finding 3's posture is settled (hard gate).

---

# Implementation status (2026-07-06)

Shipped (migrations 139–141, code + tests + schema.sql regenerated, all checks green):

- **F1** — subscriptions wired into the tab + ledger. `logSubscriptionCharge` now debits `reading_tabs.balance_pence` and posts `subscription_charge` (−price) / `subscription_earning` (+net) ledger entries (migration 140 adds both trigger types to the reader-balance / writer-earned views + `subscription_events.writer_payout_id`); the 5 dead `free_allowance` decrements are removed; writer subscription earnings fold into the payout base (eligibility + reserve claim + rollback). F11 rounding folded in (floor, not round). Publication-subscription *distribution* through the pool is the one deferred sub-piece (collection works; the earning posts no ledger/payout).
- **F2** — publication reads isolated from the writer cycle via a denormalised `read_events.publication_id` (migration 139): excluded from eligibility/recompute/claim, no personal `writer_accrual`, dropped from the earnings displays.
- **F3 + F7** — hard-gate floor `FREE_ALLOWANCE_FLOOR_PENCE` in `recordGatePass` (402 on exhaustion); provisional unlocks marked non-permanent (migration 141, cleared on card-connect); per-(reader,article) advisory lock + one-charge-per-pair idempotency check.
- **F6** — `convertProvisionalReads` and `reserveWriterPayout` now claim via `UPDATE … RETURNING` and derive amounts from the claimed set.
- **F8 + F12** — `handleFailedPayment` sets the back-off flag + a `status='pending'` guard; `reverseSettlement` sets the same flag to gate post-chargeback re-collection.
- **F5 (partial)** — fixing F2 *activated* the publication-chargeback mis-attribution F5 warns of, so a safety gate was added: publication reads are charged back on the reader side only (no author-keyed writer/earned reversal), platform absorbs the un-reversed split. Full split-recipient reversal remains deferred F5.

Deferred (later session): **F4** (dead `transfer.paid/failed` branches + `transfer.reversed`), **F5** (full publication-aware chargeback), **F9** (remove paid voting), **F10** (publication split caps), **F14** (allowance-split modelling), **Wave 5** (periodic settlement resume, calendar arithmetic, the `read_at<=settled_at` comment).

---

# Fix implementation plan (2026-07-05)

Ordered in delivery waves. Each item lists the change, the files, migration/ledger implications, and how to verify. The product/architecture decisions that once blocked coding (F3, F9, F1 writer leg, F10, F12, F4) are all **settled** — see *Decisions locked* at the top; Wave 0 records them for the plan. Finding 13 is retracted (no work).

## Wave 0 — decisions (locked 2026-07-05)

All three open questions are settled (narrative in *Decisions locked* at the top); recorded here for the plan:

- **F3 (card-less unlock posture) → hard gate.** Refuse the gate pass once `free_allowance_remaining_pence − amount < 0` (configurable `FREE_ALLOWANCE_FLOOR_PENCE`), and make provisional unlocks non-permanent until settlement. Drives the F1/F14 code shape.
- **F9 (voting) → remove entirely.** Strip the `vote_charges` money path everywhere and the frontend paid path; leave the tables + historical ledger entries inert (append-only). Findings 5 and the `vote_charges` half of 6 shrink accordingly. Do not preserve any paid-vote UI.
- **F1 writer-side treatment → fold into the per-read payout base** (not a parallel pool). Add a `writer_payout_id`/link on `subscription_events` so each earning is claimed once; accept that subscription income counts toward the read-tuned KYC/£20 threshold.

## Wave 1 — revenue-existential (F1, F2, F3)

### F1 — wire subscriptions into the tab and the ledger
Goal: a subscription charge becomes collectable by the existing settlement machinery, and both legs post to the ledger.

- **Reader leg (collection).** In `logSubscriptionCharge` / the three charge sites (`gateway/src/routes/subscriptions/writer.ts:150,214`, `publication.ts:80,142`, `workers/subscription-expiry.ts:148`): stop decrementing `accounts.free_allowance_remaining_pence`; instead **debit `reading_tabs.balance_pence` by the full price** inside the charge txn, and post a mirror `recordLedger(client, …)` entry with a **new trigger type** (e.g. `subscription_charge`, reader account, `−price`, so `balance == −SUM` holds). Reuse the reader's tab row (`SELECT … FOR UPDATE` as elsewhere). This makes the charge settle through the untouched `settlement.ts` path.
- **Writer leg (earning).** Keep the `subscription_events` credit, add a mirror ledger entry (`subscription_earning`, writer account, `+net`), and **fold it into the per-read payout base** (Wave-0 decision): add the `subscription_events` earning legs to the eligibility/recompute/claim UNIONs in `payment-service/src/services/payout.ts`, and add a `writer_payout_id` (or a link table) on `subscription_events` so each earning is claimed by exactly one payout. Subscription income then counts toward the KYC/£20 threshold like reads — confirm that withholding recurring income below the read-tuned threshold is acceptable.
- **Ledger registration (required).** Add the new trigger types to `shared/src/lib/ledger.ts` sign conventions and to the six→(N) registered money paths in `scripts/check-ledger-adjacency.sh` — CI (`backend` job) will fail otherwise. Add the adjacency tripwire marker at each new tab-write site.
- **Migration.** New `ledger_entries.trigger` enum values (or text, per current column type — check `schema.sql`); regenerate `schema.sql` via the pg_dump-and-re-append discipline and run `scripts/check-schema-drift.sh`.
- **Verify.** New Vitest cases: a subscription charge increments `−SUM(ledger) == reading_tabs.balance_pence`; a settlement run collects a subscriber's tab; the writer's earnings reflect the credit. Run `scripts/reconcile-ledger.sql` to confirm parity.

### F2 — isolate publication revenue from the writer cycle
- **Exclude publication reads** from all three writer-cycle queries in `payment-service/src/services/payout.ts`: the eligibility base (`:355`), the locked recompute in `reserveWriterPayout` (`:496`), and the claiming UPDATE (`:544`). Add `AND publication_id IS NULL` — but `read_events` must expose it. Confirm whether `read_events` carries `publication_id`; if not, either denormalise it at gate-pass insert (add column + set from `article.publication_id`) or join `articles`. Denormalise (cleaner, avoids a hot join in the claim). Migration + `schema.sql` regen if a column is added.
- **Earnings displays.** In `confirmSettlement`, split the `writer_accrual` post: publication reads should not post a personal `writer_accrual` to the author. Introduce a publication-scoped earned figure (or suppress the author accrual for `publication_id IS NOT NULL` reads) so `getWriterEarnings`/`getPerArticleEarnings`/`ledger_writer_earned` stop claiming pool money as personal. Coordinate with the ledger views in `schema.sql`.
- **Verify.** Integration test: a read on a publication article, author KYC-complete + over threshold → the writer cycle must NOT claim it; the publication cycle must. Author dashboard must not show it as personal earnings.

### F3 — enforce the hard-gate unlock posture (Wave-0 decision)
- Reject key issuance in `performGatePass` (`gateway/src/services/article-access/gate-pass.ts`) / `recordGatePass` (`payment-service/src/services/accrual.ts`) once `free_allowance_remaining_pence − amount < FREE_ALLOWANCE_FLOOR_PENCE` (return the existing 402 shape). Make provisional `article_unlocks` **non-permanent** until conversion — either don't write the unlock row for provisional reads, or add an `is_provisional` flag on `article_unlocks` cleared at settlement, so `access-check.ts` doesn't grant permanent free access pre-payment. **Ordering note:** the permanent-unlock row currently doubles as F7's serial-retry short-circuit, so removing it for provisional reads *raises* F7's priority — ship F7's real idempotency key in the same wave.
- **Verify.** A card-less reader past the floor is refused; a provisional unlock does not survive as permanent free access.

## Wave 2 — trust-destroying at launch (F7, F8, F12)

### F7 — gate-pass idempotency + concurrency guard
- **Concurrency:** take a per-`(reader, article)` `pg_advisory_xact_lock` at the top of `recordGatePass` (hash the pair), so two simultaneous first-reads serialise; the second sees the unlock/charge from the first.
- **Retry idempotency:** derive an idempotency key from `(readerId, articleId)` on the gateway→payment internal `/gate-pass` call; have the payment route dedup on it (a `UNIQUE` guard on `read_events(reader_id, article_id)` where article reads are one-per-reader — verify that invariant holds before adding; if re-reads create multiple rows, use a dedicated idempotency table instead). Migration + `schema.sql` regen for any new constraint/table.
- **Verify.** Fire two concurrent gate passes for one article → exactly one charge, one unlock. Replay the internal call with the same key → no second charge.

### F8 — async decline back-off
- In `handleFailedPayment` (`settlement.ts:666`): set `accounts.card_action_required_at = now()` (mirror the synchronous terminal path at `:313`), and guard against flipping a settlement that already `confirmed` (same pattern as `confirmSettlement`). This stops `checkAndSettle` (fired per gate pass) from re-attempting against a known-bad card.
- **Verify.** Simulate a `payment_intent.payment_failed` webhook → `card_action_required_at` set, subsequent gate passes do not re-attempt settlement until re-attach.

### F12 — gate re-collection after chargeback
- In `reverseSettlement` (`settlement.ts:~875`): after restoring `tabRestorePence` to the tab (keep — ledger-correct), **set `card_action_required_at`** (or a dedicated `dispute_hold_at`) so the next threshold crossing does not auto-recharge the disputed card — the **hold-flag** posture chosen 2026-07-05 (keep the debt restore; gate only collection). Re-consent-before-resume is deferred, not adopted.
- **Verify.** After a chargeback reversal, the restored balance does not trigger an automatic settlement on the next gate pass.

## Wave 3 — Stripe correctness (F4, F5, F6)

### F4 — key completion on the create response; handle reversal
- **Verify first (decision 2026-07-05):** confirm against live Stripe — a test-mode platform→connected transfer, or the account's API-version event log — that `transfer.paid`/`transfer.failed` genuinely don't fire, *before* deleting the branches. The `transfer.reversed` handler and keying completion off the create response are correct regardless; only the deletion depends on this premise.
- Treat a successful `transfers.create` response as the completion signal: fold the `confirm*Payout`/`confirmPublicationSplit`/`confirmTributePayout` `completed` write into the create path (or a `transfer.created` handler), and **delete** the `transfer.paid`/`transfer.failed` cases and their `handleFailed*` branches (dead — those events don't fire for platform→connected transfers). Keep the terminal-vs-ambiguous create try/catch (that is the real failure gate).
- Add a `transfer.reversed` handler that reverses the payout (release reads/accruals, post the reversing ledger entry).
- Remove the misleading `webhook.ts:129-131` "valid at runtime" comment.
- **Verify.** A payout reaches `completed` with no webhook; a `transfer.reversed` event unwinds it.

### F5 — publication-aware chargeback (depends on F2)
- Extend `ReversalRead` (`chargeback.ts:60`) with the payout vehicle (personal vs publication) and, for publication reads, the split recipients. In `computeChargebackReversal` (`:174`), post `writer_payout_reversal` per split recipient against `publication_payout_splits` rather than a single reversal against `read_events.writer_id`. Sequence **after** F2 (which makes publication reads actually go through the publication payout, so the vehicle is knowable).
- **Verify.** Chargeback on a publication-paid read posts reversals to the split recipients, summing to the disputed amount (telescoping conservation intact).

### F6 — close the SELECT-then-UPDATE claim races
- `convertProvisionalReads` (`payment-service/src/services/accrual.ts:~213`): change the reads branch to `UPDATE … WHERE reader_id = $2 AND state = 'provisional' RETURNING id, amount_pence`, and compute `totalPence` **and** the ledger loop from the returned rows — matching the vote-charges branch immediately below. (Once F9 removes votes, this branch is the sole survivor of the pattern — copy its `RETURNING` shape before deleting the vote leg.)
- `reserveWriterPayout` (`payment-service/src/services/payout.ts:~544`): claim via `UPDATE … RETURNING` and derive `lockedAmountPence`/the transfer amount from the returned rows, not a prior `SUM` subquery. The existing `accounts … FOR UPDATE` only serialises same-writer payouts; the `RETURNING`-derived amount is what actually closes the settlement-vs-payout race.
- **Verify.** Unit test interleaving a fresh provisional insert between select and claim → tab increment and ledger entries match the claimed set exactly.

## Wave 4 — semantics & hygiene (F10, F11, F14, F9)

- **F10 — publication split caps (semantics decided: fixed share-of-revenue).** In `computePublicationSplits` (`payment-service/src/services/payout.ts:61`): floor `remainingPool` at 0 and guard `revenue_bps` overrides so their sum per article can't exceed 10000. `revenue_share_bps` is a **fixed share of revenue**: enforce `SUM(bps) ≤ 10000` at write time in the members/overrides UI (reject non-conforming member sets) *and* defensively in the split fn, and **stop the normalized-weight renormalisation** (`remainingPool × bps / totalStandingBps`) that pays a sole 1-bps member 100% — distribute against the fixed 10000 base so the platform retains any unallocated remainder.
- **F11 — fold subscription rounding into `per-read-net.ts`.** Replace `Math.round` in `logSubscriptionCharge` with the shared floor helper. Do this **with F1** (when the figure becomes real money).
- **F14 — model the allowance split.** In `classifyRead` (`payment-service/src/services/accrual.ts:24`): compute allowance-consumed pence explicitly (`min(remaining, amount)`) rather than a boolean `on_free_allowance`, floor the decrement at the actual consumed amount, and don't decrement when `remaining ≤ 0`. Persist the split so settlement write-off (ADR §I.3/§II.3) computes against real numbers. Coordinate with the F3 posture.
- **F9 — remove paid voting (Wave-0 decision).** Strip the `vote_charges` branches from accrual (the convert leg), settlement (the advance leg), payout (the eligibility UNION + claim/advance UPDATEs), and the chargeback planner (the vote-reversal arm), plus the frontend paid-vote confirm path. Leave the `votes`/`vote_charges` tables and their historical ledger entries in place (append-only). No `voteCostPence` cap needed — the function goes with the money path. Sequence this early: it removes surface area that F5 and F6 would otherwise have to carry.

## Wave 5 — P3 hardening

- Give settlements a **periodic** `resumePendingSettlements` (call it each settlement-check cycle, not only at process startup) so a `pending`-stuck settlement self-heals like payouts do.
- Replace the fixed 30/365-day millisecond adds in `subscription-expiry.ts:61` with calendar arithmetic (match `subscription-convert.ts`), so renewal periods don't drift across DST/leap.
- Add a comment (at minimum) at `confirmSettlement`'s `read_at <= settled_at` advance documenting that a read converted between reservation and confirmation attaches to a settlement whose charge predates it — reconciliation queries must not assume exact settlement/charge pairing.

## Cross-cutting checklist (run before each wave lands)

- Any new tab/ledger write site: add the `recordLedger` mirror **and** register in `scripts/check-ledger-adjacency.sh` (CI `backend` job blocks otherwise).
- Any schema change: regenerate `schema.sql` via pg_dump + re-append the `_migrations` seed in one step, then `scripts/check-schema-drift.sh` (CI `schema` job).
- `scripts/reconcile-ledger.sql` must still balance after F1/F2/F5.
- Root `npm run lint` at 0 errors.

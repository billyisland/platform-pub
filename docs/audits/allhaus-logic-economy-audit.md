# platform-pub — Logic & Economy Audit

**Date:** 2026-07-05 · **Scope:** money paths end to end (accrual → settlement → payout → chargeback), ledger discipline, subscriptions, publications, tributes, voting, gate-pass, Stripe integration, plus a targeted logic sweep of auth and concurrency patterns. ~588 TS files; the payment-service and gateway article-access/subscription code was read in full; the rest was swept by pattern.

**Headline:** the read-money core (accrual → tab settlement → writer payout → chargeback) is unusually well engineered — three-phase Stripe durability, stable idempotency keys, append-only ledger with mirror-entry discipline, reconcile sweeps for missed webhooks, a pure chargeback planner with telescoping conservation. The serious problems are all at the *seams*: subscriptions, publications, and the Stripe transfer-event model each diverge from what the read-money core assumes. Three findings are P0-grade in the sense that real money either never moves or moves to the wrong party.

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

`classifyRead` (`accrual.ts:27`) marks every no-card read `provisional` regardless of allowance state, `recordGatePass` decrements `free_allowance_remaining_pence` unconditionally (it goes negative without bound), and nothing — not the accrual service, not the gate-pass route, not `routes/payment.ts` — rejects a read when the allowance is exhausted. `allowanceJustExhausted` is a UI signal only. Worse, step 6 of `performGatePass` writes a *permanent* `article_unlocks` row for every successful gate pass, provisional included. A reader on a burner email can therefore unlock the entire paid catalogue permanently, with the only consequence being an ever-more-negative allowance column that materialises into debt *only if they voluntarily attach a card*.

This may be a deliberate soft-paywall posture for launch — but if so it should be a documented decision with a cap, because as written it is an unmetered giveaway with a trivially exploitable permanent-unlock side effect. Minimum hardening: gate key issuance once `free_allowance_remaining_pence − amount < 0` (or a configured floor), and consider making provisional unlocks non-permanent until conversion.

---

## P1 — the machinery targets events that won't arrive, or races itself

### 4. `transfer.paid` / `transfer.failed` are not delivered for platform→connected-account transfers

The payout confirmation model (`webhook.ts` cases `transfer.paid` / `transfer.failed`; `confirmPayout`, `handleFailedPayout`, `confirmTributePayout`, `handleFailedTributePayout`, `confirmPublicationSplit`, `handleFailedPublicationSplit`) is built on webhook events that the current Stripe API does not emit for `transfers.create` to a connected account. The events list for modern API versions includes only `transfer.created`, `transfer.updated`, and `transfer.reversed`; <cite index="4-1">the legacy `transfer.paid`/`transfer.failed` events applied to transfers from connected Stripe accounts to their bank accounts, not to transfers to the connected accounts themselves</cite>. The in-code comment ("Stripe SDK v14 types don't include all webhook event types … but they are valid at runtime") is the wrong conclusion from the missing types.

Consequences: every payout row of all three kinds stalls at `initiated` forever (`completed` is unreachable), and the entire failure-rollback branch — reads released back to `platform_settled`, accruals unclaimed — is dead code. In practice platform→Connect transfers land in the connected balance near-synchronously and rarely fail post-create (the terminal-create path you already handle covers most real failures), so the money risk is modest; but your completion tracking is a permanent blind spot and `transfer.reversed` (which *does* fire, e.g. on a platform-initiated reversal) is unhandled. Fix: treat a successful `transfers.create` response as completion (or key on `transfer.created`), delete the paid/failed branches, and add a `transfer.reversed` handler.

### 5. The chargeback planner is publication-blind

`computeChargebackReversal` (`chargeback.ts:158`) reverses every `writer_paid` read against `read_events.writer_id` with a `writer_payout_reversal`. Reads paid via a *publication* payout were never paid to the writer personally — the money went to split recipients per `publication_payout_splits`. A chargeback on such a read posts the reversal to the wrong account: the author's ledger goes negative for money the standing members received. This interlocks with finding 2 (today the writer cycle usually steals those reads first, making the reversal accidentally "correct"); once 2 is fixed, this becomes an active mis-attribution. The planner needs the payout vehicle per read (personal vs publication) and, for publication reads, reversal entries per split recipient.

### 6. SELECT-then-UPDATE claim races (READ COMMITTED per-statement snapshots)

Two money paths compute an amount from a `SELECT` and then claim rows with a *separate* `UPDATE` whose predicate can match rows that committed in between:

`convertProvisionalReads` (`accrual.ts:196`) selects provisional reads `FOR UPDATE`, then updates `WHERE reader_id = $2 AND state = 'provisional'` — a concurrent `recordGatePass` (which locks the *account*, not held by the converter) can commit a fresh provisional read between the two statements; the blanket UPDATE flips it to `accrued`, but it is in neither `totalPence` (tab under-incremented) nor the ledger loop (missing debit entry). The Phase-3 "−SUM == balance" invariant breaks silently. Note the vote-charges branch immediately below already uses the correct `UPDATE … RETURNING` pattern; make the reads branch match it, or lock the account row first.

`reserveWriterPayout` (`payout.ts:470–560`) computes `lockedAmountPence` from a subquery, then claims with unconstrained `UPDATE … WHERE state='platform_settled' AND writer_payout_id IS NULL`. `confirmSettlement` does not lock the writer's account, so reads settling mid-transaction get claimed (flipped toward `writer_paid`) without being in the transferred amount — the writer is underpaid for rows marked paid. Same fix: claim via `UPDATE … RETURNING` and sum the returned rows, and derive the transfer amount from the claim.

### 7. Gate-pass has no concurrency or retry idempotency — double charges

`read_events` has no unique constraint on `(reader_id, article_id)` (only the unlock table does), and the permanent unlock is written *after* the payment call. Two concurrent gate passes for the same article both pass `checkArticleAccess`, both hit `/gate-pass`, and both debit the tab — a double-tap on a slow connection is enough. Separately, the gateway→payment-service call carries no idempotency key: an ambiguous network failure after the payment service committed, followed by a client retry, charges twice (the unlock that would have short-circuited the retry was never written). Fix: a per-(reader, article) advisory lock or unique guard in `recordGatePass`, plus an idempotency key derived from `(readerId, articleId)` on the internal call.

### 8. Webhook-delivered payment failures don't back off — decline hammering

The synchronous terminal-decline path in `completeSettlement` sets `card_action_required_at` so settlement backs off until a card re-attach. The asynchronous path — `payment_intent.payment_failed` via `handleFailedPayment` (`settlement.ts:640`) — marks the settlement `failed` and does nothing else. `checkAndSettle` runs on *every* gate pass, so a reader with a card that declines asynchronously gets a fresh settlement attempt per read against a known-bad card: Stripe decline fees, issuer risk flags, and a pending-settlement churn loop. `handleFailedPayment` should set the same back-off flag (and, like `confirmSettlement`, guard against flipping a settlement that already confirmed).

---

## P2 — economy semantics and consistency

### 9. Paid voting is retired at the product level but fully load-bearing in the code

Paid up/downvotes were retired as structurally incompatible with the MoR model, yet `gateway/src/routes/votes.ts`, `web/.../VoteControls.tsx`, `shared/src/lib/voting.ts`, and `vote_charges` handling remain live through accrual conversion, settlement advancement, payout eligibility, KYC reconciliation, and the chargeback planner. That is a lot of money-path surface area for a dead product. Either the retirement decision hasn't reached the repo, or this is scheduled removal — but every fix in findings 2, 5, and 6 gets cheaper once vote_charges leaves the model. Also a latent overflow: `voteCostPence` doubles unbounded; around the ~29th paid vote in one direction the pence value exceeds int4 and the `votes.cost_pence` insert will error (nuisance, not loss).

### 10. Publication split arithmetic: overdraw and weight-vs-percentage ambiguity

In `computePublicationSplits` (`payout.ts:61`), `revenue_bps` article overrides decrement `remainingPool` with no floor — overlapping shares on the same article (nothing in this function caps the bps sum at 10000) can drive the pool negative, in which case the emitted splits exceed the fee-net pool and the platform pays the difference. Standing shares are then distributed as `remainingPool × bps / totalStandingBps` — i.e. *normalized weights*: a sole member with `revenue_share_bps = 1` receives 100% of the pool. If the members UI presents `revenue_share_bps` as "share of publication revenue," a publication with members summing to 6000 bps will pay out 100% rather than 60%. Confirm the intended semantics and either enforce the invariant at write time or guard in the split function.

### 11. Subscription fee rounding diverges from the platform rule

`logSubscriptionCharge` uses `Math.round((price × feeBps)/10000)`; every other money path floors, per the documented per-row-then-floor rule that `per-read-net.ts` exists to centralise. One-penny divergence per charge, and a second definition of "net" in the codebase — fold it into the shared helper when subscriptions are wired into the ledger (finding 1).

### 12. Post-chargeback re-collection is automatic — a dispute-risk decision hiding in the code

`reverseSettlement` restores the full disputed amount to `reading_tabs.balance_pence`. The next threshold crossing then re-charges the same card for debt the cardholder just disputed. Card networks treat re-charging disputed amounts harshly (repeat disputes, monitoring-programme thresholds). The debt restore is correct ledger-wise, but collection should probably be gated (e.g. set `card_action_required_at` on reversal, or require an explicit re-consent) rather than automatic.

### 13. Defence-in-depth inconsistencies on internal routes

In `payment-service/src/routes/payment.ts`, `/gate-pass`, `/card-connected`, `/payout-cycle`, and `/settlement-check/monthly` all verify `x-internal-token`, but the two `GET /earnings/:writerId` routes don't — the gateway enforces owner-only access, so exposure depends entirely on network isolation of the payment service. Also, all internal-token comparisons are `!==` (non-constant-time); use `crypto.timingSafeEqual`. Low severity, cheap to fix.

### 14. Free-allowance accounting misstates partial-allowance reads

`classifyRead` marks a read `on_free_allowance` whenever any allowance remains, even if the read exceeds it (5p left, 10p read → the full 10p flagged as allowance), and the decrement runs even when the allowance is already ≤ 0, so the column keeps drifting negative on the read path independent of finding 1. Whatever write-off treatment the ADR's §I.3/§II.3 applies at settlement will be computed against a flag that doesn't reflect the actual allowance/chargeable split. Model the split explicitly (allowance-consumed pence per read) or floor the classification.

---

## P3 — notes

`resumePendingSettlements` runs only at process startup; a settlement stuck `pending` after a transient Stripe error waits for a restart (the reconcile sweep only covers `completed`-but-unconfirmed rows). Payouts resume every cycle — give settlements the same periodic resume. Subscription period arithmetic uses fixed 30/365-day millisecond adds (drift across DST/leap; acceptable if deliberate). `confirmSettlement` advances reads by `read_at <= settled_at`, so a provisional read converted between reservation and confirmation can be marked `platform_settled` (and earn its writer a `writer_accrual`) under a settlement whose charged amount predates it — money conserves across the *next* settlement, but read-level attribution to settlements is approximate; worth a comment at minimum since reconciliation queries may pair on it.

## What holds up well

The three-phase reserve→Stripe→complete pattern with stable idempotency keys is applied consistently across settlements, writer payouts, publication splits, and tribute payouts, with terminal-vs-transient error discrimination and crash resume. The webhook endpoint does signature verification against multiple secrets, livemode guarding, and durable event claiming with retry-safe `processed_at` semantics. The reconcile sweeps (`reconcileSettlements`, `reconcileConnectKyc`) correctly treat Stripe webhooks as at-least-once and self-heal in both directions. The ledger's sign conventions, the negative-balance policy (column and ledger move by the same signed delta, no clamps), the per-row-then-floor rounding rule centralised in `per-read-net.ts`, and the pure, unit-testable chargeback planner with telescoping tribute conservation are all genuinely strong. The failures above are almost entirely cases where a *newer* subsystem (subscriptions, publications) was built against a mental model of the money core rather than its actual tables — the core itself is sound.

## Suggested order of attack

Fix 1 and 2 first (they are revenue-existential and each is a scoped SQL/flow change); then 7 and 8 (reader-facing double-charge and decline-hammering are trust-destroying at launch); then 4 (delete the dead webhook branches and key completion on the create response); then 6, 5, and the P2 semantics decisions (9, 10, 12) as product calls. Finding 3 needs an explicit posture decision before launch either way.

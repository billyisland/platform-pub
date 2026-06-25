# all.haus — Stripe integration audit & fix plan (2026-06-25)

Scope: the full Stripe surface — reader card onboarding + Connect onboarding
(`gateway/src/routes/auth.ts`), the three-stage money flow (accrual → settlement
→ payout in `payment-service/src/services/`), the webhook router
(`payment-service/src/routes/webhook.ts`), the reconcile workers, and the pure
chargeback planner (`payment-service/src/services/chargeback.ts`).

The integration is mature: webhook-driven state, stable idempotency keys on every
Stripe write, three-phase reserve→charge→confirm durability, reconcile sweeps for
dropped webhooks, append-only ledger mirroring, and a unit-tested chargeback
planner. The items below are the gaps that survived cross-checking against source.

Priority is **correctness risk × blast radius × effort**, matching
`FIX-PROGRAMME.md`. P0 can silently stall money movement or strand funds. P1 are
real bugs not actively losing money. P2 is hardening / ops visibility.

---

## Summary

| # | Pri | Title | Files | Status |
|---|-----|-------|-------|--------|
| S1 | **P0** | Declined / SCA off-session settlement orphans a permanently-`pending` settlement and freezes the tab | `payment-service/src/services/settlement.ts` | ✅ Fixed 2026-06-25 |
| S2 | P1 | Reader cards attach with no server-side validation (compounds S1) | `gateway/src/routes/auth.ts` | ✅ Fixed 2026-06-25 (needs live Stripe browser test) |
| S3 | P1 | Connect payability is one-way — capability revocation & de-authorization unhandled | `payment-service/src/routes/webhook.ts`, `payment-service/src/lib/connect-payable.ts` | ✅ Fixed 2026-06-25 |
| S4 | P2 | Webhook hardening — Connect-event secret, `livemode` assertion, partial-refund / `dispute.created` visibility | `payment-service/src/routes/webhook.ts` | ✅ Fixed 2026-06-25 |

> **All four findings were independently verified against source before fixing** (every cited line number, code path, and causal claim held; no overstated findings). Implementation log at the foot of this doc.

---

## S1 — P0 — Declined / SCA off-session settlement orphans the tab

### Diagnosis

`completeSettlement` (`payment-service/src/services/settlement.ts:242-288`) creates
a confirmed off-session PaymentIntent and then, on the next line, writes its id and
flips the row to `completed`:

```ts
const paymentIntent = await this.stripe.paymentIntents.create(
  { amount, currency: 'gbp', customer, confirm: true, off_session: true, ... },
  { idempotencyKey: `settlement-${settlementId}` },
)
await pool.query(`UPDATE tab_settlements SET stripe_payment_intent_id=$1, status='completed' WHERE id=$2 AND status='pending'`, ...)
```

There is **no try/catch**. When the saved card is declined or requires
authentication, `paymentIntents.create({confirm:true, off_session:true})` *throws*
(`StripeCardError`, `code: 'authentication_required' | 'card_declined' | ...`).
The failure cascade:

1. The `UPDATE` never runs → `stripe_payment_intent_id` stays NULL, row stays
   `status='pending'`.
2. Stripe still emits `payment_intent.payment_failed`, but `handleFailedPayment`
   (`settlement.ts:561-592`) matches **by `stripe_payment_intent_id`** — never
   stored — so it hits 0 rows and returns. The settlement is never marked `failed`.
3. `reserveSettlement` (`settlement.ts:191-202`) refuses to open a new settlement
   while a `pending` one exists → **every future settlement for that tab is blocked**.
4. `resumePendingSettlements` (`settlement.ts:296-355`) runs only at startup and
   replays the same idempotency key → same decline → throws again, forever.
5. `reconcileSettlements` (`settlement.ts:845-916`) only considers
   `status='completed' AND stripe_charge_id IS NULL` rows, so it never touches a
   stuck `pending`.

**Net effect:** a reader whose card later declines accrues an unbounded tab that
can never settle, the writer is never paid, and nothing surfaces an error.

### Fix

In `completeSettlement`, wrap the `paymentIntents.create` call and branch on
terminal vs. transient failure:

- **Terminal** (`StripeCardError`, or `StripeInvalidRequestError` for an
  unusable/detached payment method): capture the PI id from the thrown error
  (`err.payment_intent?.id` / `err.raw?.payment_intent?.id`), persist it onto the
  settlement, and flip the row to `status='failed'` in one statement. This
  releases the `reserveSettlement` pending-guard so the tab is no longer frozen,
  and — because the PI id is now stored — a subsequent `payment_intent.payment_failed`
  webhook for the same PI matches and is a safe no-op.
- **Transient** (network error / timeout / 5xx / rate-limit): re-throw (or leave
  pending) so `resumePendingSettlements` retries with the stable key. Do **not**
  mark failed — the charge may have succeeded.

Sketch:

```ts
let paymentIntent: Stripe.PaymentIntent
try {
  paymentIntent = await this.stripe.paymentIntents.create({ ... }, { idempotencyKey: `settlement-${settlementId}` })
} catch (err) {
  if (isTerminalChargeError(err)) {
    const piId = (err as any).payment_intent?.id ?? (err as any).raw?.payment_intent?.id ?? null
    await pool.query(
      `UPDATE tab_settlements SET status='failed', stripe_payment_intent_id=COALESCE($1, stripe_payment_intent_id), failure_reason=$2 WHERE id=$3 AND status='pending'`,
      [piId, (err as any).code ?? 'charge_failed', settlementId],
    )
    logger.warn({ settlementId, code: (err as any).code }, 'Settlement charge declined — marked failed, tab unfrozen')
    return
  }
  throw err // transient → resume retries with the stable idempotency key
}
```

`isTerminalChargeError` = `err.type === 'StripeCardError'` or a
`StripeInvalidRequestError` indicating an unusable payment method.

### Secondary hardening (same finding)

- **Re-attempt backoff.** Once a settlement is `failed`, the gate-pass path
  (`checkAndSettle`, `settlement.ts:51`) will re-trigger on the next read and
  decline again. Add a guard: skip threshold settlement if the tab's most recent
  settlement is `failed` within the last N hours (or until the reader updates
  their card — see S2). Cheap version: `reserveSettlement` checks for a recent
  `failed` row and returns null.
- **Reader signal.** A terminal decline should mark the account so the UI can
  prompt a card re-auth (e.g. an `accounts.card_action_required_at` timestamp, or
  reuse an existing notification path). Without it the reader has no way to know
  their tab is stalled.

### Schema

`failure_reason` is not currently on `tab_settlements` (it has `reversal_reason`
only — `schema.sql:2500`). Either add a `failure_reason text` column via migration
(then regenerate `schema.sql` + re-seed `_migrations` per CLAUDE.md) **or** reuse
logging only and skip the column. Adding the column is preferred for ops triage.

### Tests

- Unit: `completeSettlement` with a stubbed Stripe that throws `StripeCardError`
  → row ends `failed`, PI id stored, tab balance unchanged, pending-guard released
  (a subsequent `reserveSettlement` succeeds).
- Unit: stubbed transient error → row stays `pending`, re-throws.
- Idempotency: `payment_intent.payment_failed` webhook after a terminal decline
  matches the stored PI id and no-ops cleanly.

---

## S2 — P1 — Reader cards attach with no server-side validation

### Diagnosis

`/auth/connect-card` (`gateway/src/routes/auth.ts:402-477`) attaches a
client-supplied `paymentMethodId`, sets it as the customer default, and records
the customer id — but never confirms a SetupIntent server-side. The card's
chargeability is first exercised at settlement time, i.e. the exact off-session
path that orphans in S1. An expired, invalid, or 3DS-mandatory card attaches
cleanly; reads accrue for weeks; the failure only lands at the £8 threshold.

### Fix

At attach time, create + confirm a SetupIntent with `usage: 'off_session'` (or
require the client to pass a SetupIntent id and verify its `status === 'succeeded'`
and that future off-session usage was authorized). This surfaces a bad or
auth-required card immediately, at a point where the user is present to fix it —
turning S1's silent weeks-later stall into an inline error.

This pairs with S1: S1 makes the late failure recoverable; S2 prevents most late
failures from happening at all.

### Tests

- A card that needs authentication is rejected at `connect-card` rather than
  attached.
- A valid card sets up off-session usage and the existing `card-connected` →
  `convertProvisionalReads` flow still fires.

---

## S3 — P1 — Connect payability is one-way

### Diagnosis

`isConnectPayable` (`payment-service/src/lib/connect-payable.ts:20`) is the single
gate, applied by both the `account.updated` webhook (`webhook.ts:210-220`) and the
KYC reconcile sweep. Both only ever flip `stripe_connect_kyc_complete = TRUE`
(`webhook.ts:231-246`). There is **no path that sets it back to FALSE**.

Consequences:

- If Stripe later disables a writer's `transfers` capability (compliance review,
  fraud, negative balance), the corresponding `account.updated` is effectively
  ignored. The writer keeps showing as payable, and `runPayoutCycle`
  (`payout.ts:331-415`) keeps selecting them — each transfer rejected by Stripe and
  rolled back as a `failed` payout, cycle after cycle. No money is lost (Stripe
  refuses the transfer), but it's churn and the writer-facing state is wrong.
- `account.application.deauthorized` (writer disconnects their Connect account) is
  not handled, leaving a stale `stripe_connect_id` that the payout cycle will keep
  targeting.

### Fix

- In the `account.updated` handler, make the flag track `isConnectPayable` in
  **both** directions: when it returns false for an account currently marked
  complete, set `stripe_connect_kyc_complete = FALSE` (and log). Keep the
  reconcile sweep symmetric so the two paths can't diverge (the stated reason
  `connect-payable.ts` exists).
- Add an `account.application.deauthorized` case that clears
  `stripe_connect_kyc_complete` (and optionally nulls `stripe_connect_id`) for the
  matching account, so a disconnected writer drops out of the payout cycle.

### Tests

- `account.updated` with `transfers` no longer active flips a previously-complete
  writer back to incomplete; the next payout cycle skips them.
- `account.application.deauthorized` clears the writer's payable state.

---

## S4 — P2 — Webhook hardening & ops visibility

`payment-service/src/routes/webhook.ts`. None of these are losing money today;
they're robustness / observability.

1. **Connect-event delivery & secret.** `account.updated` for an Express
   connected account and `transfer.*` must all reach `/webhooks/stripe` under the
   single `STRIPE_WEBHOOK_SECRET`. That holds **only if** the dashboard endpoint is
   configured to "listen to events on connected accounts." This is a config
   dependency the code can't enforce — **verify in the Stripe dashboard** and
   document it in `DEPLOYMENT.md`. If Connect events use a separate endpoint/secret,
   the verifier must try both secrets.
2. **`livemode` assertion.** The handler never checks `event.livemode`. A stray
   test-mode event hitting the prod endpoint would be processed. Add an early guard
   comparing `event.livemode` to the expected mode for the running environment.
3. **Partial refunds & `dispute.created`.** `charge.refunded` reverses only on full
   refunds and partial refunds are logged-and-skipped (`webhook.ts:194-205`);
   `charge.dispute.created` isn't surfaced (only `dispute.closed`/lost reverses).
   These are deliberate (the per-read model can't proportionally unwind), but a
   partial refund silently leaves the reader charged and writers paid, with only a
   log line. Add an ops-visible signal (a row in a review queue / a metric /
   an alert) so partial refunds and opened disputes are actioned manually rather
   than lost in logs.

---

## Suggested order

1. **S1** (P0) — the only item that stalls money movement; ship first.
2. **S3** (P1) — small, symmetric webhook change; removes payout-cycle churn.
3. **S2** (P1) — prevents most of S1's failures at the source; slightly larger
   (client + server SetupIntent change).
4. **S4** (P2) — config verification + guards + a refund/dispute review surface.

## Non-issues confirmed (rejected during cross-check)

- Read advancement in `confirmSettlement` keys off `tab_settlements.settled_at`,
  which is `DEFAULT now() NOT NULL` (`schema.sql:2496`) — set at reserve time, so
  the `read_at <= settled_at` window is correct, not NULL-poisoned.
- Per-row fee flooring in payout/earnings is writer-favourable by ≤ N−1 pence and
  is intentional + documented (`payout.ts:308-317`).
- Settlement & payout idempotency keys (`settlement-${id}`, `payout-${id}`,
  `pub-split-${payoutId}-${accountId}`, `tribute-payout-${id}`) are stable per
  immutable row — safe across retries and crash-resume.

---

## Implementation log — 2026-06-25

### S1 — settlement orphan (P0)
- **Migration 135** (`135_settlement_decline_handling.sql`): adds
  `tab_settlements.failure_reason` and `accounts.card_action_required_at`.
  `schema.sql` regenerated (throwaway-from-committed + apply 135 + pg_dump,
  per the dev-DB-drift discipline), `_migrations` re-seeded; all four
  `check-schema-drift.sh` checks green.
- **`settlement.ts::completeSettlement`** now wraps `paymentIntents.create` in
  try/catch. Terminal errors (`isTerminalChargeError`) → mark the settlement
  `failed` (releasing the `reserveSettlement` pending-guard, unfreezing the
  tab), persist the PI id via `COALESCE`, store `failure_reason`, and set
  `accounts.card_action_required_at` — all in one transaction. Transient errors
  re-throw so `resumePendingSettlements` retries with the stable key. This is
  self-healing for already-orphaned prod rows (resume re-attempts on next boot).
- **Back-off:** `checkAndSettle` skips settlement while `card_action_required_at`
  is set → one decline per card-attach, not one per read. Cleared by
  `connectPaymentMethod` (`shared/src/auth/accounts.ts`) on re-attach.
- **Defensive guard:** `confirmSettlement` now refuses to advance a `failed`
  settlement (a stray success on a stored-PI failed row can't double-credit).
- **Reader signal** surfaced on `GET /my/tab` as `cardActionRequiredAt` (a
  frontend re-auth prompt is the remaining follow-up; the data is now exposed).
- **Helper** `payment-service/src/lib/charge-errors.ts::isTerminalChargeError`
  (Stripe-free, so unit-testable) + `tests/charge-errors.test.ts` (11 cases).

### S3 — Connect payability one-way (P1)
- **`webhook.ts` `account.updated`** is now bidirectional: not payable →
  `handleConnectPayableLost` flips `stripe_connect_kyc_complete = FALSE`
  (guarded on `= TRUE`).
- **New `account.application.deauthorized`** case →
  `handleConnectDeauthorized` clears payability (keeps `stripe_connect_id` for
  the payout audit trail; `kyc_complete = FALSE` alone drops the writer from the
  cycle).
- **`payout.ts::reconcileConnectKyc`** made symmetric: candidates are now any
  account with a Connect id **and** pending earnings (regardless of flag); the
  sweep promotes (FALSE→TRUE) **and** demotes (TRUE→FALSE), so a dropped
  account.updated in either direction self-heals. Bounded to accounts with
  money waiting. Return shape gained `demoted` (logged by the worker).

### S2 — card attach validation (P1)
- **Split `/auth/connect-card`** into `POST /auth/setup-intent` (creates/reuses
  the Stripe Customer, returns a SetupIntent `client_secret` with
  `usage: 'off_session'`) and the rewritten `POST /auth/connect-card` (retrieves
  the SetupIntent, asserts `status === 'succeeded'` **and** `metadata.account_id`
  matches, sets the validated PM as default, records the customer). The customer
  id is persisted only on success, so `stripe_customer_id` (the "has a card"
  signal for `auth/me`, votes, settlement) flips true only for a confirmed card.
- **Client** (`CardSetup.tsx`) switched from `createPaymentMethod` to
  `stripe.confirmCardSetup(clientSecret, …)` — validates the card and runs any
  3DS/SCA step inline while the reader is present. `lib/api/auth.ts` gained
  `createSetupIntent`; `connectCard` now takes a `setupIntentId`.
- `next build` clean. **Remaining:** a live browser test with Stripe test cards
  (incl. a 3DS card, e.g. `4000002500003155`) — needs real keys, can't be done
  headless. Web is a prod build, so `docker compose build web && up -d web` to
  deploy.

### S4 — webhook hardening (P2)
- **Multi-secret verification:** verifies against `STRIPE_WEBHOOK_SECRET` and an
  optional `STRIPE_CONNECT_WEBHOOK_SECRET` (separate Connect endpoint).
- **`livemode` guard:** expected mode derived from the secret key prefix; a
  misrouted test/live event is acked (200) but not processed.
- **Ops visibility:** new `charge.dispute.created` case + the partial-refund
  branch both log the alertable `event: "manual_review_required"` marker
  (`kind: dispute_opened | partial_refund`). Documented in `DEPLOYMENT.md`
  (Connect-event endpoint config, the optional second secret, livemode, and the
  alert). A dedicated review-queue table/UI was judged out of scope for a P2
  (events are already durably persisted in `stripe_webhook_events`).

### S1 follow-on — payout-side transfer orphan (found during S3, fixed same day)
- **Diagnosis (verified):** `completeWriterPayout` and `completeTributePayout`
  called `transfers.create` with **no try/catch**. A terminal rejection (e.g. a
  revoked `transfers` capability) throws, so Stripe creates no transfer object
  and never emits `transfer.failed` — and `handleFailedPayout` /
  `handleFailedTributePayout` are keyed on `stripe_transfer_id`, so they never
  fire. The row sits `pending` forever with its earnings claimed
  (`writer_payout_id`/`tribute_payout_id` set), never paid, never released;
  `resumePending*Payouts` retries every cycle (ignoring the KYC flag). No
  payout-side reconcile backstop exists. The payout-side twin of S1.
  (`completePublicationSplit` already caught this — only writer + tribute had
  the gap.)
- **Fix:** wrapped both `transfers.create` calls. On a deterministic rejection
  (`isTerminalTransferError` — **StripeInvalidRequestError only**, the narrow
  classifier, because the failure mode here is double-PAY) → mark the payout
  `failed` and release its claimed earnings for re-pay under a fresh id, via the
  extracted `rollbackWriterPayoutRows` / `rollbackTributePayoutRows` (now shared
  with the `transfer.failed` webhook handlers so the two rollback paths can't
  diverge). On any ambiguous error → re-throw, so `resumePending*Payouts`
  retries with the stable idempotency key (which dedupes a transfer that did go
  through) — never roll back, never double-pay. Ledger-clean: the throw precedes
  the ledger txn, so no entry exists to reverse. +8 `isTerminalTransferError`
  unit tests.

### Verification run
- `payment-service` full suite: **84 passed** (incl. `charge-errors`, 19 cases).
- `check-schema-drift.sh`: 4/4 green · `check-ledger-adjacency.sh`: green ·
  `check-hairlines.sh` (touched web file): clean.
- `tsc` clean: payment-service, gateway, shared. `next build` clean: web.
</content>
</invoke>

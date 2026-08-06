# Runbook — a reading tab in credit (`negative_reader_tab`)

**Alert marker:** `alert: "negative_reader_tab"`, level `fatal`, emitted by
`payment-service/src/services/reconcile-ledger.ts`.
**Payouts:** **NOT halted.** Nobody else's money is frozen by this alert — that
is deliberate (see *Why it doesn't halt*).
**Response time:** same working day. This is an incident, not a backlog item.
**Spec:** `docs/adr/PAYMENT-PERIMETER-ADR.md` W1.

---

## What the alert means

`reading_tabs.balance_pence < 0` for at least one reader. A reading tab is a
**debt** the reader owes; a negative balance is the platform owing the reader —
a reader-redeemable claim, redeemable against future reads. That is the shape
the payment-perimeter analysis concludes we do **not** have (HJ §6), on the
assumption it cannot arise. So it is a state to end, not a state to manage.

The books are not necessarily wrong. A negative tab usually reconciles to the
penny against `ledger_reader_balance` — which is exactly why it needed its own
check: `reader_balance_parity` compares the column with the ledger and passes
when they agree. The August 2026 double-charge left a reader £14 in credit and
nothing alerted, for precisely that reason (the code narrates it above
`resumePendingSettlements` in `payment-service/src/services/settlement.ts`).

## Why it doesn't halt payouts

Every other check in that file freezes all three payout cycles. This one must
not. A reader in credit is not a books-divergence — freezing every Writer's
payout over one Reader's credit would itself be the ¶7.14.6 "principal-like
control over other people's money" marker the perimeter work exists to narrow.
The alert is the response; the money keeps moving.

If a *divergence* is present in the same run, the halt fires on its own account
and its reason names only the halting class.

---

## Step 1 — Read the alert payload

The structured log carries up to 20 rows, **deepest credit first**, each with:

| Field | Meaning |
|---|---|
| `account_id` | the reader in credit |
| `credit_pence` | the balance (negative) |
| `last_settlement_id` / `_intent` / `_pence` / `_at` | the reader's most recent settlement |

`truncated: true` means there were **at least** 20 — `count` is a floor, not a
total. Get the real figure before deciding anything:

```sql
SELECT count(*), sum(balance_pence) FROM reading_tabs WHERE balance_pence < 0;
```

The settlement fields are a **starting point, not an attribution**. The tab
carries no per-movement provenance, so the check reports the latest settlement
because the commonest cause puts the culprit there. Step 2 is where you find out
if it is.

## Step 2 — Diagnose the cause. The resolution depends on it.

Three code paths can take the column below zero. All three go through
`applyLedgerDelta`, the column's only writer, so the reader's ledger tells you
which one:

```sql
SELECT created_at, trigger_type, amount_pence, ref_table, ref_id, counterparty_id
FROM ledger_entries
WHERE account_id = '<account_id>'
ORDER BY created_at DESC
LIMIT 40;
```

Walk the running total back to the point it crossed zero. The entry that took it
there names the cause:

| Trigger type | Path | Cause |
|---|---|---|
| `tab_settlement` | `settlement.ts` confirm leg | **A. Double settlement** — the reader was charged twice for the same debt |
| `tab_settlement_reversal` | `settlement.ts` reverse leg | **A′.** A reversal restored more debt than was outstanding, or a reversal landed on an already-settled tab |
| `subscription_credit` | `gateway/src/routes/articles/subscription-convert.ts` | **B. Spend-conversion credit-back** — see the warning below |
| `dispute_stake_refund` | `gateway/src/routes/upstream-edges.ts` | **C.** A stake refunded that was never debited (or debited twice) |

> **Cause B is not an incident and this runbook cannot fix it.** The
> spend→subscription conversion route credits the reader's month-to-date spend
> back to the tab, `min(spend, subscription price)`, with no offsetting debit —
> and it counts reads *regardless of state*, including reads the reader has
> already settled. A reader who settled mid-month and then converts is taken
> below zero **by design**. That is a Reader-funded, reader-redeemable credit,
> i.e. the instrument PAYMENT-PERIMETER-ADR §4 rule 4 bans, arriving through a
> route nobody classed as one. **Do not refund it and do not treat it as an
> operator error.** Escalate: it is a product/perimeter decision, recorded as an
> open dilemma against W1 in the ADR.

## Step 3 — Resolve

### Cause A / A′ (double settlement) — refund the duplicate charge in full

This is the clean path, and it is nearly automatic. Find the duplicate:

```sql
SELECT id, amount_pence, status, stripe_payment_intent_id, stripe_charge_id, settled_at
FROM tab_settlements
WHERE reader_id = '<account_id>'
ORDER BY settled_at DESC LIMIT 10;
```

Two `completed` rows of the same amount, minutes or hours apart, are the shape.
Refund the **later** one **in full** (Stripe Dashboard → the payment → Refund →
full amount; reason "duplicate").

The rest happens on the webhook. `charge.refunded` with
`amount_refunded == amount` routes to `reverseSettlement(chargeId, 'refund')`
(`payment-service/src/routes/webhook.ts`), which:

- restores the debt to the tab (`+tabRestorePence`) via `applyLedgerDelta`, so
  the column and its ledger move as one pair and the tab returns toward zero;
- rolls the reads that settlement paid for back to `accrued` and reverses the
  writer accruals it created;
- records the refund draw against the charge's allocation (a no-op while
  `STRIPE_ALLOCATED_FUNDS` is off).

**A full refund is required.** A *partial* refund does not unwind: the handler
logs `manual_review_required` / `kind: "partial_refund"` and skips the reversal,
so the reader keeps the credit AND gets money back. If the correct amount is
less than the whole charge, stop — that is the admin-action case below.

**Two side effects to expect and communicate:**

1. `reverseSettlement` sets `accounts.card_action_required_at`, which gates
   automatic collection until the reader re-attaches a card. That is right for a
   cardholder-initiated chargeback and wrong-feeling for a platform-initiated
   correction, but it is the current behaviour: the reader will be asked to
   re-add their card. Tell them why.
2. The restored reads are `accrued` again and will settle normally at the next
   threshold crossing (once the card is re-attached). The reader is not charged
   twice; they are charged once, later.

Confirm afterwards:

```sql
SELECT balance_pence FROM reading_tabs WHERE reader_id = '<account_id>';
```

Then re-run the check on demand — `POST /reconcile-ledger` on the
payment-service internal port (`x-internal-token`) — and expect
`negative_reader_tab` absent from `violations`.

### Cause C (stake refund) and any residual credit — the admin refund action

Where no single full-charge refund lands the tab back at zero, the resolution is
an outward refund of **the credit that remains at the moment it runs**, paired
with a ledger entry that brings the column to zero.

**That action does not exist yet.** It is a full new Stripe money path (three-
phase reserve → create → confirm, a row-stable idempotency key, the
terminal/ambiguous split, a new `credit_refund` trigger type added to the
`ledger_reader_balance` view in the same migration, resume-sweep coverage) and
sits in PAYMENT-PERIMETER-ADR W1's parallel lane. Until it ships:

- **Do not** hand-write a ledger entry. The ledger is append-only and
  `credit_refund` is not in the `ledger_reader_balance` view; posting an entry
  the view does not count breaks `reader_balance_parity` and **halts all
  payouts, every run, permanently**.
- **Do not** issue a partial Stripe refund and leave it there. The tab stays
  negative and the reader has now been paid twice over.
- **Do** escalate to whoever owns the payment service, record the account and
  amount, and treat the alert as open until the action lands.

The one thing that is always in force, whatever the cause:

> **Never resolve a credit by letting it be spent down against future reads,
> and never surface it to the reader as a balance.** No wallet, no "credit
> applied" copy, no gate that consults it. The tab arithmetic will net some
> incidental spend-down during the incident window — that is unavoidable without
> freezing the tab — but no path may *offer* the credit for spending. (ADR W1,
> and §4 rule 4.)

## Step 4 — Close

Record in the incident log: the account, the credit, the cause from Step 2, the
resolution, and the final `balance_pence`. If the cause was A, the underlying
double-charge is its own investigation — `reserveSettlement`'s in-flight guard
closed the known window (measured 2026-07-31), so a fresh occurrence means a new
one.

---

## Testing this without an incident

- Severity behaviour (alerts, never halts; its own marker; truncation reported
  as a floor): `payment-service/tests/ledger-reconcile.test.ts`.
- The detector itself against real Postgres — a synthetic double-settlement
  producing a negative tab that the parity check passes over in silence:
  `payment-service/tests/negative-reader-tab-integration.test.ts` (rolled back;
  never mutates the target DB).

```bash
TEST_DATABASE_URL=postgresql://platformpub:password@localhost:5432/platformpub \
  npx vitest run tests/negative-reader-tab-integration.test.ts   # from payment-service/
```

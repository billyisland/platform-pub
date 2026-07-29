# Stripe Funds Segregation (Allocated Funds) — Integration Spec

**Status:** Sandbox enabled (2026-07). Live enablement expected from Stripe ~w/c 2026-08-03.
**Docs:** https://docs.stripe.com/connect/funds-segregation
**Revision:** rev 3 (2026-07-29) — rev 2's design was sound but specified the *packing* in
detail and the *lifecycle* by assertion; §3.3c, §3.5 and §5 are rewritten around per-child
state. Rev 1's per-settlement slice model remains withdrawn. See §9. Read §3.3 fresh.
**Owner context:** Segregation locks pooled reader funds into a holding state on the platform
account so they can only move to connected accounts — the regulatory point of the whole
exercise. Everything below is gated behind `STRIPE_ALLOCATED_FUNDS=1` so live behaviour is
unchanged until Stripe flips our live account.

---

## 0. Account state (already done — do not redo)

- Live account fully activated; platform profile complete with platform loss liability
  (a hard requirement of the beta).
- Live keys deployed: `STRIPE_SECRET_KEY` (sk_live) in `payment-service/.env` and
  `gateway/.env`; `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (pk_live) as a web build arg in
  root `.env`.
- Two live webhook destinations, both → `https://all.haus/webhooks/stripe`
  (nginx `location = /webhooks/stripe` → `payment:3001`):
  1. **Your account** scope: `payment_intent.succeeded`, `payment_intent.payment_failed`,
     `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`,
     `transfer.reversed` → secret in `STRIPE_WEBHOOK_SECRET`.
  2. **Connected accounts** scope: `account.updated`, `account.application.deauthorized`
     → secret in `STRIPE_CONNECT_WEBHOOK_SECRET`.
- Webhook handler verifies against both secrets and enforces a livemode guard keyed off
  the secret key prefix.

> **Unresolved contradiction — settle this before the live flip.** `DEPLOYMENT.md:794`
> states that `transfer.*` events "are emitted on *connected* accounts" and reach us only
> via the Connect-scoped endpoint. The configuration above puts `transfer.reversed` on the
> **platform-account** endpoint. A Transfer is a platform-account object and Stripe
> documents reversal semantics from the platform's perspective, so the configuration is
> very likely right and `DEPLOYMENT.md` is wrong for `transfer.*` (it is correct for
> `account.*`) — but if it is the other way round, transfer reversals are silently never
> delivered, and §3.5's ledger semantics never fire. Verify in the dashboard (send a test
> reversal in the sandbox and observe which endpoint receives it), then correct whichever
> document is wrong. This is a pre-existing defect, not one segregation introduces;
> segregation just raises the cost of getting it wrong, because reversed funds now return
> to the **allocated** state and our own allocation model (§3.3a) must learn about it.

---

## 1. What is actually true about our money (read this before touching payout code)

Rev 1 asserted an invariant here that the code does not honour. Three statements, each
verified against the code, replace it.

### 1.1 Reads reach payout only through a completed settlement — but the pairing is approximate

Every payable read passes `accrued → platform_settled`, and only `confirmSettlement` makes
that transition, stamping `tab_settlement_id`. So a payable read always *has* a settlement.

But **which** settlement is approximate, and deliberately so. `confirmSettlement` advances
reads by a TIME predicate — `read_at <= settled_at` (`settlement.ts:604`) — not by which
reads' grosses summed to the charged amount. The code says so in terms at
`settlement.ts:587–596` ("read↔settlement attribution is APPROXIMATE … reconciliation
queries must not assume an exact per-settlement charge/read pairing"), and the property
test `settlement-attribution-conservation.test.ts` pins conservation **globally** (P5),
explicitly not per settlement. PAYMENTS ADR §1.1 forbids changing that apportionment SQL.

Two ordinary mechanisms make `SUM(read net attributed to settlement S) > charge(S)`:

- **The reserve clamp.** `actualAmount = Math.min(lockedBalance, expectedAmountPence)`
  (`settlement.ts:188`). Reads landing between the balance check and the tab lock are
  advanced by the confirm but were not in the charged amount.
- **Any pre-paid credit.** A negative tab balance (from `subscription_credit`,
  `opening_balance`, a dispute path) makes the charge structurally smaller than the gross
  of the reads it settles.

**Consequence for this integration:** a payout unit of (writer × settlement) that assumes
its slice fits inside its charge will be rejected by Stripe as a routine matter, not an
edge case. The design in §3.3 therefore separates *attribution* (which reads earned the
money — unchanged) from *funding* (which charge's allocated balance pays it).

### 1.2 Some payable earnings are funded by platform credit, not by any charge

There is no charge behind every penny, and this is coded behaviour, not drift:

- **Credit-funded subscription earnings.** `logSubscriptionCharge` stamps
  `settled_at` at charge time whenever the post-charge balance is `<= 0`
  (`gateway/src/routes/subscriptions/shared.ts:83`) — "fully funded by pre-paid credit …
  no settlement will ever fire for it". That earning is payable with **no
  `tab_settlements` row and no `stripe_charge_id` in existence**.
- **Spend→subscription conversion.** `gateway/src/routes/articles/subscription-convert.ts`
  credits the reader's tab down by up to the subscription price against a month's reads,
  *whatever state those reads are in* — including reads already settled and already earned
  by their writers. The writers keep their accruals; the reader is charged less. The
  platform absorbs the difference, which surfaces later as a settlement charge smaller than
  the reads it settles (i.e. as §1.1's second mechanism).

So a platform-subsidised earnings path **does exist**, and a plain-transfer fallback **is**
required. Rev 1's "no residual bucket, no plain-transfer fallback needed" was wrong. §3.3d
specifies the residual path and, more importantly, makes it *measured* — a growing residual
is the signal that credits are outrunning charges, which is a business fact worth an alert
whether or not segregation is on.

### 1.3 The free allowance is a gift (shipped: migration 164, 2026-07-29)

A read carries a list price (`amount_pence`) and a chargeable amount (`chargeable_pence`
= list price − `allowance_consumed_pence`, GENERATED); every money path over `read_events`
computes from the latter, CI-enforced by `scripts/check-read-chargeable.sh`.

**Structural impact on segregation: none, and it slightly shrinks §1.2's residual.** Gifted
pence never enter a tab, so they were never charged, never allocated and never payable — the
packer simply sees smaller units. Two consequences worth carrying forward: the payout claim
SQL already reads `chargeable_pence` (`payout.ts:564`), so §3.3b's unit arithmetic inherits
it for free; and the *historical* population (readers billed for gifts before 164) was
deliberately left unrestated, so if it is ever refunded those refunds are ordinary tab
credits and appear as exactly the kind of credit-funded earning §1.2 describes.

### 1.4 The invariant that does hold

> **In aggregate, across all time, settlement charges fund all payable read earnings:
> `Σ charged == Σ settled-read gross`** (the P5 property), less the platform credits
> enumerated in §1.2.

Aggregate, not per-charge. That is exactly enough to make segregation work — the platform
genuinely holds reader funds destined for writers — and it is why §3.3's funding model packs
against a *pool* of charges rather than a per-settlement pairing.

It also means **the residual (§3.3d) has a structural floor, not an exceptional one**: every
credit-funded penny lands there by construction, forever. Measure that floor before choosing
an alert threshold (§3.3d, §5 step 0).

## 2. What the beta changes (three breaking deltas)

All three verified against the Stripe documentation 2026-07-29.

1. **Transfers must reference their funding charge.** Allocated funds can only be
   transferred with `source_transaction: <charge id>` set ("you **must** set the
   `source_transaction` parameter to the ID of the associated charge"). Our current payout
   model — one aggregate transfer per writer summing many settlements — is dead. The payout
   unit becomes **(payout × funding charge)**: N transfers per payout, one per charge drawn
   on. Splitting one charge across many recipients is explicitly supported, with no
   documented limit on the number of transfers, "as long as the total doesn't exceed the
   original payment amount".
2. **The 8% platform fee must become explicit.** Stripe treats `application_fee_amount` on a
   transfer as **optional** — but for us it is effectively required, because with allocation
   the FULL charge amount is locked away and the current "keep the difference in platform
   balance" stops working. Specifying it debits the fee from allocated funds and credits our
   payments balance. Anything we do *not* claim as an application fee stays locked in
   allocated state (see §3.3f, and §3.4 where this bites hardest).
3. **Preview header on all Stripe API requests:**
   `Stripe-Version: 2026-06-24.preview; allocated_funds_preview=v1`.
   Set as the client `apiVersion`. The SDK is pinned at `2023-10-16` (`stripe@^14`) —
   either upgrade stripe-node (beta release for types) or cast params; runtime is governed
   by the header.

Also inherited from the beta:
- **Payment methods restricted to Visa, Mastercard, Amex, Discover and Swish.** We use
  `payment_method_types: ['card']` (`settlement.ts:277`), which is **broader** than that
  set — in GBP it also admits JCB, Diners and UnionPay. Such a charge simply carries no
  allocated funds, and a `source_transaction` transfer against it succeeds anyway from
  ordinary balance, so the segregation guarantee would lapse **silently, with no error
  anywhere**. The fix is not a brand allow-list (which would refuse a reader's card at
  settlement time, turning a compliance nicety into lost revenue): it is **never to assume
  allocation** — §3.3a reads the allocated balance back from Stripe per charge, so an
  ineligible brand yields a charge that is simply not drawable, handled by the same path as
  a not-yet-settled one. Never introduce `automatic_payment_methods`.
- Dashboard does NOT display allocated funds; fee billing becomes asynchronous. Our
  ledger + the allocation model (§3.3a) + a reconcile job (§3.6) are the only visibility.
- Refunds/disputes draw allocated funds first, then platform balance. Transfer reversals
  always return funds to the **allocated** state, not platform balance (and
  `refund_application_fee=true` returns the fee there too). Dispute fees always hit
  platform balance.
- A charge's allocated funds become transferable only after capture **and** payment-method
  settlement. `source_transaction` transfers queue against that automatically — which is a
  feature for us (§3.3e), not a constraint to engineer around.
- Testing works only in a **Sandbox**, not classic test mode.

## 3. Code changes

### 3.1 Env / client
- New env: `STRIPE_ALLOCATED_FUNDS` (default off). `payment-service` and `gateway`.
- When on, construct Stripe clients with
  `apiVersion: '2026-06-24.preview; allocated_funds_preview=v1'`.
- Flag off ⇒ behaviour byte-identical to today.
- There are **four** Stripe client constructions: `settlement.ts:45`, `payout.ts:200`,
  `webhook.ts:20`, `gateway/src/routes/auth.ts:58`. The first three read or write allocation
  objects (PaymentIntents, Transfers, and the events describing both) and **must** take the
  flag — a client on the wrong API version reading objects written by another is the failure
  mode. **`auth.ts` is deliberately excluded:** it constructs Connect onboarding objects
  (`accounts`, `accountLinks`) that carry no allocation and gain nothing from the preview
  version, while a *preview* API version can move under us on the account-onboarding path,
  which is the one path whose breakage locks writers out of getting paid at all. If a future
  change makes `auth.ts` touch a charge or transfer, it joins the other three.
- Brake conventions (CLAUDE.md): add a `DEPLOYMENT.md` env-table row and a
  `docker-compose.yml` default in the same commit. The flip is gated on evidence — Stripe
  confirming live enablement, plus a green §5 sandbox run — and that gate is recorded on
  the queue item.

### 3.2 Settlement PI creation (`payment-service/src/services/settlement.ts`)
When flag on, add to `paymentIntents.create`:
- `allocated_funds: { enabled: true }` (wire form `allocated_funds[enabled]=true`)
- `transfer_group: 'settlement-<settlementId>'` — optional; it buys grouping in the
  dashboard and nothing else. `source_transaction` is what does the work. Include it or
  don't; do not spend design effort on it.

Everything else (off_session, confirm, idempotency `settlement-<id>`) unchanged.

**Do not** add a synchronous allocation read here or in `confirmSettlement`. The webhook
path is already the critical, idempotency-guarded path; the allocation sweep (§3.3a) does
that work out of band, and is also what makes the design robust to settlement timing.

### 3.3 Payout — attribution stays, funding is new

The one structural idea: **`reserveWriterPayout`'s claim and net arithmetic do not change
at all.** Which reads a writer is owed for, the per-read-then-floor net, the subscription
leg, the ROOT tribute carve, the collection gate, the `publication_id IS NULL` exclusion —
all of it stays byte-identical, so every existing conformance test stays green and no money
question is reopened. What is new is a **funding** step that decides which charges pay the
already-decided amount, and a **per-child lifecycle** so that one Stripe rejection out of N
is an ordinary event rather than a wedged payout.

#### 3.3a The allocation model — never assume, read it back

New state, because Stripe gives us no queryable view of remaining allocation per charge:

- `tab_settlements.allocated_pence integer` — what Stripe actually locked for this charge.
  **NULL means "not known to be drawable"**: pre-flip, ineligible card brand, not yet
  settled, or sweep hasn't run. NULL is the safe default and the only default.
- `tab_settlements.allocation_synced_at timestamptz` — last sweep touch.
- `allocated_draws` — one row per claim against a charge's allocation:
  `id, settlement_id, kind ('transfer'|'refund'|'reversal'), ref_table, ref_id,
   gross_pence, created_at`, with `UNIQUE (ref_table, ref_id, kind)` for idempotency.
  For a transfer draw, `(ref_table, ref_id)` is `('payout_transfers', <child id>)` — one
  draw per child, which is what makes releasing a failed child's draw a single DELETE.

Remaining allocation for a settlement is **derived, never stored**:

```sql
GREATEST(0, ts.allocated_pence - COALESCE((
  SELECT SUM(d.gross_pence) FROM allocated_draws d WHERE d.settlement_id = ts.id
), 0))
```

**Lock ordering is part of the contract.** The packer reads those remainders under
`SELECT … FOR UPDATE`, and the pack order (§3.3b) is data-dependent, so it must not also be
the *lock* order — two concurrent packers (a cycle and a resume sweep, or two cycles) would
take the same settlement rows in opposite orders and deadlock. Acquire every candidate
settlement lock up front, in a single statement, in primary-key order:

```sql
SELECT id, allocated_pence FROM tab_settlements
 WHERE id = ANY($1) ORDER BY id FOR UPDATE
```

then pack in preference order against the locked set. One statement, one deterministic
order, held for the whole of Txn 1.

> **`allocated_draws` is a drawing budget, not a ledger.** It never mirrors
> `ledger_entries`, posts no money movement, and the `GREATEST(0, …)` above is deliberate
> and safe — the clamp-is-a-bug rule (CLAUDE.md money-ledger invariant) governs
> `reading_tabs.balance_pence` and its mirror entries, where a clamp silently diverges
> column from ledger. Here the clamp only makes us *under*-draw, which degrades to the
> residual path (§3.3d) and never to an over-transfer. Stripe's own accounting stays
> authoritative; §3.6 is what catches divergence between the two.

**`allocation-sync` sweep** (new worker task, modelled on `reconcileSettlements`, which is
the existing shape for "re-read the truth from Stripe"): for each `completed` settlement
with `stripe_charge_id IS NOT NULL` and (`allocated_pence IS NULL` OR
`allocation_synced_at` older than the freshness window), retrieve the PaymentIntent with
`expand[]=latest_charge.allocated_funds.balance` and stamp
`allocated_pence = balance.pending + balance.available` (0 if the charge carries no
`allocated_funds`). Bounded batch per run; oldest-unsynced first.

This one mechanism disposes of three separate problems: ineligible card brands (§2),
payment-method settlement timing (§2), and the pre-flip transition (§6) — in every case the
charge is simply not drawable, and the packer routes around it identically.

#### 3.3b The payout unit: pack whole earning-units onto charges

After the claim commits its amount, the payout is decomposed into **units** — the smallest
indivisible pieces of what we owe, each carrying its own exact `(net, fee)` pair and a
*preferred* settlement. A unit's **gross** is `net + fee`: that is what the charge must
fund, because Stripe debits the application fee from the same allocated balance as the
transfer, and the two together are what "must not exceed the original payment amount"
bounds. No unit is ever split, so **no rounding is introduced anywhere in this design**;
every fee is the fee that already existed.

| Unit source | net | fee | preferred settlement |
| --- | --- | --- | --- |
| Read (`read_events`) | `perReadNetPence(chargeable_pence, feeBps)`, less any carve apportioned to it (below) | `chargeable_pence − perReadNetPence(chargeable_pence, feeBps)` | its `tab_settlement_id` |
| Subscription earning (`subscription_events`) | `amount_pence` (already net) | paired `subscription_charge.amount_pence` − `amount_pence`; **0 if the pair cannot be resolved** | its `tab_settlement_id` (new column, below) |
| ROOT tribute carve (tribute cycle) | the accrual's `amount_pence` | 0 (the fee rode the author's unit) | the read's `tab_settlement_id` |

**Subscription earnings need a settlement id, and do not have one.** `subscription_events`
carries only `settled_at`, stamped `now()` by `confirmSettlement` (`settlement.ts:618`) or at
charge time by `logSubscriptionCharge` — so "the settlement that stamped it" is
unrecoverable after the fact, and a time-join would reintroduce §1.1's approximation at a
second site. Add `subscription_events.tab_settlement_id uuid` (§4) and stamp it in the
same UPDATE that already sets `settled_at`; the charge-time credit-funded branch leaves it
NULL, which is correct — that earning has no charge and belongs in the residual (§1.2).
Until the column is backfilled-by-nature (it only fills going forward), a NULL simply means
"no preference", which the packer already handles.

**The tribute carve is apportioned, never allowed to go negative.** Today the carve is a
single set-level `SUM` subtracted once (`lockedAmountPence = readNet + subNet − carve`,
`payout.ts:564`). Making it a per-read deduction — as rev 2 did — can drive an individual
unit's net below zero, and flooring at 0 would make `Σ units > lockedAmountPence`: the
writer overpaid, the carve under-collected, and (because §3.3c restates the parent amount
from placed units) the overpay silently ratified in both Stripe and the ledger. Instead:

```
carveRemaining = SUM(root accruals on the claimed reads)      // exactly today's number
for each read unit, in descending net:
  take = min(unit.net, carveRemaining)
  unit.net -= take; carveRemaining -= take
assert carveRemaining == 0
assert SUM(unit.net) == lockedAmountPence      // else throw, rolling back Txn 1
```

Natural per-read attribution where it fits, overflow carried to the next unit, no negative
unit possible, integer pence throughout so nothing rounds. The two assertions are cheap and
turn the entire class of error into a rolled-back transaction instead of a silent overpay.
The carve's own unit still appears in the tribute cycle with fee 0, so author-side deduction
and inspirer-side payment telescope exactly as they do today. Inert while `TRIBUTES_ENABLED`
is off — which is precisely why the assertions matter: this is the code that will be
switched on years from now by someone who wasn't here.

**Fees always floor, never round up.** Taking too little fee leaves dust in allocated funds,
which the §3.3f sweep reclaims. Taking too much over-draws the charge and Stripe rejects the
transfer. The two error directions are not symmetric; always err toward dust. The "fee 0 if
unpairable" rule above is the same principle.

**Packing** (`payment-service/src/lib/allocation-packer.ts`, pure and unit-tested — the
arithmetic lives in one testable place, like the pure planner in
`payment-service/src/services/chargeback.ts`):

```
for each unit, ordered by (has preferred settlement first, then gross descending):
  place it on the first source whose remaining >= unit.gross:
    1. its preferred settlement, if allocated and sufficient
    2. any allocated settlement with sufficient remaining — largest remaining first
    3. platform_balance (residual, §3.3d)
  accumulate units into a slice keyed by the chosen source
```

Preferring the unit's own settlement keeps the common case legible in the audit trail.
Falling back to the pool is what makes §1.1's approximate attribution a non-issue: the money
genuinely is there in aggregate (§1.4), just not always behind the charge the read is
stamped with. Largest-remaining-first minimises the transfer count. Gross-descending
placement is a first-fit-decreasing bin pack — near-optimal in slice count and, more
importantly, deterministic, so a resume produces the same packing.

**Is drawing on another reader's charge legitimate?** Yes, and it is the *better* answer.
Stripe permits any split of a charge across connected accounts. The regulatory guarantee at
stake is "pooled reader funds can only reach connected accounts, never platform working
capital" — and pool-drawing keeps a unit under segregation that would otherwise fall to the
unsegregated residual. The alternative (strict own-settlement-only) is more legible but
strictly weaker on the thing the exercise is for. If a future regulator requires
per-payer tracing, the child rows record exactly which charge funded which unit, so the
weaker policy is a one-line change to the packer's step 2.

#### 3.3c Tables, transactions, idempotency, and the per-child lifecycle

**`payout_transfers`** — one child row per slice, **shared by all three payout cycles** (the
polymorphic parent is deliberate: one packer, one execute loop, one resume sweep, three
callers — three near-identical tables is how the three cycles drifted apart in the first
place):

```
id, parent_table ('writer_payouts'|'publication_payout_splits'|'tribute_payouts'),
parent_id, settlement_id NULL, stripe_charge_id NULL,
funding ('allocated'|'platform_balance'),
net_pence, fee_pence, status ('pending'|'completed'|'failed'|'reversed'),
stripe_transfer_id, failure_reason, created_at
```

`status` is a text CHECK, deliberately **not** the `payout_status` enum: adding a value to
that enum would be an `ALTER TYPE … ADD VALUE` migration, which the runner routes down the
no-transaction path, and the new value cannot be used until commit. Nothing here needs to
join the enum's fate.

Indexes on `(parent_table, parent_id)`, `(settlement_id)`, `(stripe_transfer_id)` — the
webhook lookup key, see §3.5 — and a **partial** index on `status` where `status = 'pending'`,
the resume sweep's only query.

**Units must record their child.** Releasing a failed child's units, and un-claiming
overflow units, both require knowing which unit landed on which slice — and nothing in the
claim tables records it (`read_events.writer_payout_id` points at the *parent*, and
`rollbackWriterPayoutRows` at `payout.ts:994` is payout-granular by construction, its state
filters load-bearing for the chargeback interaction). Add a nullable
`payout_transfer_id uuid` to `read_events`, `subscription_events` and `tribute_accruals`,
stamped in Txn 1 alongside the existing parent claim column. Everything below depends on it;
without it, per-child failure is unimplementable and §5.3 cannot pass.

- **Reserve (Txn 1):** claim exactly as today → build units (§3.3b, with both assertions) →
  lock candidate settlements in id order → pack → insert the parent row plus one child per
  slice → stamp `payout_transfer_id` on each unit's claim row → insert one `allocated_draws`
  row per allocated child → **and, if the packing overflows `payout_max_slices`, un-claim the
  overflow units in the same transaction** (drop both the parent stamp and
  `payout_transfer_id`) so they roll to the next cycle rather than being paid in a thousand
  transfers. Recompute the parent's `amount_pence` from the units actually placed, and
  re-test it against the threshold: if the placed total falls under it, roll the whole
  transaction back and skip this writer this cycle. This is one of two places the claimed
  amount and the paid amount can legitimately differ, and it must differ *inside* Txn 1 or
  the ledger and Stripe disagree.
- **Execute:** one `transfers.create` per child.
  Allocated: `{ amount: net_pence, currency: 'gbp', destination, source_transaction:
  stripe_charge_id, application_fee_amount: fee_pence, metadata: {...} }`.
  Residual: the same without `source_transaction` / `application_fee_amount` (the fee stays
  implicit, exactly as today).
  Idempotency key `xfer-<childRowId>` — **row-stable, never composed from
  (payout, settlement)**. This is the 2026-07-15 publication-split lesson: a key that can
  collide across two legitimate rows produces a param-mismatch `idempotency_error`,
  classified ambiguous, re-thrown, wedging the payout forever.
  Preserve the reserve→create→confirm discipline and `isTerminalTransferError` handling
  **per child**.
- **Complete a child (Txn 2, once per child):** flip the child `pending → completed` with
  its `stripe_transfer_id`, and **post that child's ledger entry in the same transaction,
  gated on the flip's `rowCount`**. This is `processPublicationSplits`' existing shape
  (`payout.ts:1405–1526`), whose own comment explains why: if the flip committed but the
  entry didn't, the child would never be re-selected and the credit would be lost.
  **Rev 2's "post once at parent completion for the parent's full amount" is withdrawn** —
  it opens a window in which money has moved and the ledger is silent, and if any sibling
  terminally fails the parent's full amount is not what was transferred.
  **The entry's `(ref_table, ref_id)` stays the PARENT row** (`writer_payouts`,
  `publication_payout_splits`, `tribute_payouts`) — N entries per parent, which nothing
  forbids (`ledger_entries` has no uniqueness on the ref, and `writer_accrual` already posts
  one entry per read). This is not cosmetic: `ledger_publication_distribution` hard-filters
  `ref_table = 'publication_payout_splits'` and joins `ref_id = publication_payout_splits.id`,
  so re-pointing the ref at the child would silently empty that view.
  `ledger_writer_earnings` filters on `trigger_type` alone and is unaffected either way.
  Per-child idempotency is the flip's `rowCount`, not the ref.
- **Fail a child terminally:** flip the child to `failed` with its reason, DELETE its
  `allocated_draws` row (returning the remainder to the budget), and release its units —
  null `payout_transfer_id` and the parent claim column on exactly the rows carrying that
  child's id, reusing the existing state filters (a read a chargeback flipped to
  `charged_back` mid-flight keeps its state and loses only its pointers, per
  `rollbackWriterPayoutRows`). Siblings and parent are untouched.
- **Complete the parent:** when **no child is left `pending`** — not "when every child is
  `completed`". Restate the parent's `amount_pence` to `SUM(net_pence)` over its `completed`
  children, record a `failed_reason` naming the failed count if any, and flip to `completed`.
  Ledger parity holds by construction, since each completed child posted exactly its own net.
  > **This also fixes a live latent defect.** `finalisePublicationPayout`
  > (`payout.ts:1533`) today completes the parent only when
  > `NOT EXISTS (split WHERE status <> 'completed')`, while
  > `resumePendingPublicationPayouts` retries only `pending` splits — so a single `failed`
  > split leaves the parent permanently `pending`, a zombie no sweep will ever resolve.
  > Rev 2 would have copied that shape into the writer cycle. Apply the "no child pending"
  > rule to the publication parent in the same change.
- **Zero-value slices are never created.** Stripe rejects `amount: 0`; a unit whose net
  reaches 0 after the carve apportionment contributes only its fee, and a slice of pure fee
  with no net is not a transfer — leave that fee as dust for §3.3f.
- **Crash-resume:** `resumePendingWriterPayouts` (and its two siblings) become one sweep
  over `payout_transfers WHERE status = 'pending'`, retrying each with its stable key, then
  re-evaluating parent completion. Because packing already committed in Txn 1, resume never
  re-packs — it replays.

#### 3.3d The residual path, and why it must be measured

A residual child (`funding = 'platform_balance'`) is an ordinary transfer with no
`source_transaction`, drawing platform balance — i.e. exactly today's behaviour. It exists
because §1.2's credit-funded earnings have no charge behind them, and it is the honest
answer rather than a leak.

But it must not be silent. Record `payout_transfers.funding` on every row and alert when the
rolling 30-day residual share exceeds `allocated_residual_alert_bps` (a `platform_config`
dial — added to `shared/src/db/config-defaults.sql`, **never seeded by a migration**, per the
tuning-dials invariant).

**Pick that threshold from a measurement, not a guess.** Per §1.4 the residual has a
structural floor: every credit-funded penny lands there by construction. Set the dial from
30 days of production data *before* the flip — `Σ subscription_credit` plus credit-funded
`subscription_earning` (those with `settled_at` stamped at charge time), over `Σ` writer
payouts for the same window — with headroom above it. A threshold chosen without that
baseline fires on day one and gets muted, which is worse than not having the alert. The
query is §5 step 0 and can be run today.

Do **not** halt payouts on it. `haltPayouts` (`payment-service/src/lib/payout-halt.ts`) is
reserved for the reader-tab parity break, where the money is provably wrong; a large
residual means the money is right and the *segregation coverage* is poor.

#### 3.3e Over-transfer is now structurally impossible, not tested-against

With the packer, no transfer can exceed its charge's remaining allocation, because the
remainder is read under lock and decremented in the same transaction that creates the child.
The residual path absorbs anything that does not fit. The remaining risk is our model
disagreeing with Stripe's — a refund we failed to record, a sweep that stamped a stale
balance — and that is what §3.6 is for, and why the §5 test plan keeps its
deliberately-forced over-transfer case (§5.3) as a test of the *failure handling*, not of
the ordinary path.

Note the `source_transaction` bonus: transfers queue against charge settlement rather than
failing for insufficient balance, so a freshly-synced charge is safe to draw on immediately.

#### 3.3f Fee dust and hanging allocated balances

Floored fees, unpairable subscription fees and pure-fee slices leave small amounts locked in
allocated state. Reclaim periodically via Balance Transfers
(`balance_transfers.create`, `source_balance[type]=allocated_funds`, per charge), run against
charges whose reads are all `writer_paid` and whose remaining allocation is below a
threshold.

An **ops script rather than an automatic job** is the right start *for genuine dust* — but
see §3.4: without the fee proration specified there, the publication cycle strands roughly
the whole pooled platform fee in allocated state every cycle, which is not dust and is not
an ops-script-shaped problem. Ship the proration, and this stays a script.

Do not add a `platform_rounding` ledger trigger type: the packer introduces no rounding
(§3.3b), so there is no residue to post. If a Balance Transfer sweep later needs ledger
visibility, that is its own change with its own trigger type added to the union in
`shared/src/lib/ledger.ts`.

### 3.4 The other two payout cycles

Same packer, same per-child lifecycle, different unit sources. Nothing may ship that
transfers allocated-era money without `source_transaction`.

**Tribute cycle** (`runTributePayoutCycle`, `payout.ts:1617`) — the easy one. A
`tribute_accruals` row joins `read_events`, so each accrual is a unit with a real preferred
settlement and zero fee (§3.3b), and `tribute_accruals` gains the same `payout_transfer_id`
column as the other claim tables. Inert while `TRIBUTES_ENABLED` is off, but implement it:
leaving it unbuilt is how the flag becomes unflippable later.

**Publication cycle** (`runPublicationPayoutCycle`) — harder, in two distinct ways.

*Attribution.* A `publication_payout_splits` row is a **bps share of a pool**, not a sum of
reads: the pool spans many charges, and `publication_payouts.sub_net_pence` may have no
charge behind it at all (§1.2). A member's share therefore has no natural per-read
decomposition. Resolve it at the *funding* layer rather than inventing an attribution: build
one unit per split (net = the split's `amount_pence`), with **no single preferred settlement**
but a *preference set* — the pool's contributing settlements, from the reads'
`tab_settlement_id`. That is a two-line generalisation of the packer (step 1 iterates a set
instead of testing one id), and the only concession the publication cycle needs. Confirm the
generalised signature before building this cycle so the packer isn't written twice.

*The pooled fee, which rev 2 got wrong.* Rev 2 gave publication units `fee = 0`, reasoning
that the pooled fee was already withheld when the pool was computed so charging an
application fee would take it twice. The reasoning is right and the conclusion is wrong:
under allocation the **full** charge is locked, so a fee that is never claimed as an
`application_fee_amount` never leaves allocated state at all. It is not taken twice — it is
taken **zero** times, and roughly 10% of all publication revenue accumulates as locked
allocated funds every cycle. That is not §3.3f dust.

Carry the already-withheld fee as a prorated per-split `fee_pence`:

```
withheldFee   = publication_payouts.platform_fee_pence      // already computed, not new money
distributed   = SUM(split.amount_pence) over the payout's splits
split.fee     = floor(withheldFee * split.amount_pence / distributed)
```

The recipient's `net` is untouched, so no split's payment changes and
`computePublicationSplits` is not reopened; the fee simply routes out of allocated funds into
platform balance where it already belonged. Floor, so the proration under-claims and the
remainder is real dust for §3.3f. The `sub_net_pence` portion of the pool contributes no
withheld fee (per-charge fees were floored at charge time), so it dilutes the proration
slightly — safe, in the under-claim direction, and not worth a second denominator.

`computePublicationSplits` and the F5 chargeback proration (`amountPence × read gross ÷
pool`, `payment-service/src/services/chargeback.ts:239`) are untouched: they operate on
splits, and splits still exist unchanged. Only the transfer underneath a split becomes
several, with the split as the `payout_transfers` parent.

### 3.5 Webhook / refund / reversal accounting

Two things change here: the allocation model needs new hooks, and **every transfer webhook
handler needs re-keying**, which rev 2 missed entirely.

**Re-key the transfer handlers — this is not optional.** `confirmPayout` (`payout.ts:858`),
`reverseWriterPayout` (`:898`) and `handleFailedPayout` (`:952`) all resolve the payout by
`writer_payouts.stripe_transfer_id = $1`. With N transfers per payout that column can hold
one id, so a `transfer.reversed` for any other child finds nothing and is silently dropped —
and if it *did* match, `reverseWriterPayout` would reverse the parent's **full
`amount_pence`** for one child's reversal. All three must look up
`payout_transfers.stripe_transfer_id` (hence its index, §3.3c), act on that child's
`net_pence`, and flip the child `completed → reversed`; the reversal ledger entry keeps the
parent ref (§3.3c) and takes its idempotency from that flip's `rowCount`, replacing the
current `SUM(writer_payout_reversal) WHERE ref_id = payoutId` guard, which cannot distinguish
children. `writer_payouts.stripe_transfer_id` becomes vestigial for multi-child payouts —
leave it NULL there rather than storing an arbitrary child's id, which would read as
authoritative and isn't. The tribute (`:1953`, `:1984`, `:2085`) and publication (`:2236`,
`:2282`, `:2346`) equivalents take the same treatment.

Allocation hooks:

- **`transfer.reversed`:** reversed funds land back in **allocated** state (per-charge), not
  platform balance — audit ledger annotations and any "return to platform balance"
  comments. Insert a compensating `allocated_draws` row (`kind = 'reversal'`,
  `gross_pence` negative) so the charge's remainder reflects the return. When reversing
  manually, pass `refund_application_fee=true` or the fee stays with the platform while the
  principal returns to allocation — a silent divergence between our model and Stripe's.
  Put this in the ops runbook; it is the kind of thing that is only ever done by hand at
  2am.
- **`charge.refunded` — full:** `reverseSettlement` already moves the reads to
  `charged_back` (`settlement.ts:1090`), so they leave the payout pool. Add an
  `allocated_draws` row (`kind = 'refund'`) for the refunded amount.
- **`charge.refunded` — partial:** today this only raises the `manual_review_required`
  WARN; the reads stay `platform_settled`. **Under allocation that is a wedge**: Stripe's
  allocated balance drops, our model's does not, and the next payout packs a slice the
  charge can no longer fund. The `allocated_draws` refund row above is what closes it —
  our remainder drops in step, and the packer routes the shortfall to another charge or to
  the residual. Keep the manual-review WARN; add the allocated/platform split to its log
  payload if cheaply known.
- **Dispute lost after reversal:** funds stay allocated; unallocating requires a Stripe
  support request — surface via ops log, don't automate.
- **Hanging allocated balances** (e.g. refunded from platform balance, later reversed from
  a writer): clear via Balance Transfer as in §3.3f. Ops script, not an automatic job.

### 3.6 Reconciliation — the only visibility there is

Extend `ledger-reconcile` (or a sibling worker): for settlements synced in the recent
window, fetch the PI with `expand[]=latest_charge.allocated_funds.balance` and diff Stripe's
remaining allocation against ours (`allocated_pence − SUM(allocated_draws.gross_pence)`).
Alert on divergence beyond a small tolerance.

Two things this must respect, both learned the hard way in this repo:

- **Alert, do not halt.** `reconcile-ledger.ts` halts payouts only on the reader-tab parity
  break, and its header explains why a false halt elsewhere is worse than the gap it would
  catch. Allocation divergence means our *drawing budget* is stale, and the packer's
  response to a stale budget is already safe (§3.3a). Halting every payout because a
  webhook was slow would be the same false-halt mistake in new clothes.
- **A watermark over `allocation_synced_at` must round-trip at Postgres precision** —
  carry it as `::text` and compare with `$1::timestamptz`, never through a JS `Date`
  (CLAUDE.md timeline-precision invariant; three prior instances, all shipping green
  because truncation errs backwards into duplicates rather than errors).

## 4. Migration

One migration, no `platform_config` INSERTs (dials go in `config-defaults.sql`, §3.3d), and
no `ALTER TYPE` (§3.3c keeps `payout_transfers.status` off the `payout_status` enum
deliberately, so this stays a single ordinary transactional migration):

- `tab_settlements`: `ADD COLUMN allocated_pence integer`,
  `ADD COLUMN allocation_synced_at timestamptz`.
- `subscription_events`: `ADD COLUMN tab_settlement_id uuid` (§3.3b) + FK to
  `tab_settlements(id)`.
- `read_events`, `subscription_events`, `tribute_accruals`:
  `ADD COLUMN payout_transfer_id uuid` (§3.3c) + FK to `payout_transfers(id)`, each with a
  partial index `WHERE payout_transfer_id IS NOT NULL` (the release path's only query).
- `allocated_draws` table + `UNIQUE (ref_table, ref_id, kind)` + index on `(settlement_id)`.
- `payout_transfers` table + indexes on `(parent_table, parent_id)`, `(settlement_id)`,
  `(stripe_transfer_id)`, and the **partial** index on `status` where `status = 'pending'`.
- No changes to `ledger_entries` — append-only, and this design adds no trigger types
  (§3.3f) and no ref-shape change (§3.3c).
- No changes to the `ledger_*` views: refs stay on the parent rows precisely so
  `ledger_publication_distribution`'s `ref_table = 'publication_payout_splits'` filter keeps
  matching (§3.3c).

Ordering note: `payout_transfers` must be created before the three `payout_transfer_id` FKs.

Then regenerate `schema.sql` with `pg_dump --exclude-schema=graphile_worker` from a
fully-migrated DB, re-append the `_migrations` seed in the same step, and run
`scripts/check-schema-drift.sh`. Note Check 3 is name-grep only — the six `ADD COLUMN`s
above are precisely its residual blind spot, so the mechanical
dump-and-re-append-in-one-step discipline is what covers them.

**The ledger tripwire will NOT flag this, and rev 2 said it would.**
`scripts/check-ledger-adjacency.sh` Guard 2 is a per-file `recordLedger` *count*
(`payment-service/src/services/payout.ts::4`); moving the writer entry from
`completeWriterPayout` to the per-child completion leaves the count at 4 and trips nothing.
Guard 3's `PAYOUT_MARKER` matches `INSERT INTO writer_payouts|publication_payout_splits|
tribute_accruals|tribute_payouts` and does not know about `payout_transfers`. Two deliberate
actions, in this commit: re-read the registry counts by hand against the new call sites, and
**add `INSERT INTO payout_transfers` to `PAYOUT_MARKER`** so a future out-of-registry writer
does trip. Do not rely on the tripwire to notice this change.

## 5. Sandbox test plan (do this now, before live flips)

Setup: switch the dashboard into the segregation-enabled Sandbox; use ITS API keys in a
staging env with `STRIPE_ALLOCATED_FUNDS=1`. Webhooks: staging endpoint with the sandbox's
own signing secrets, or `stripe listen --forward-to localhost:3001/webhooks/stripe`.

**Step 0 — do these before building anything.** They retire real uncertainty at near-zero
cost and two of them produce numbers the design needs as inputs:

- Run steps 1, 4, 6, 7 and **7b** below against the sandbox with no §3.3 code at all.
  7b is the one rev 2 never thought to ask: reverse **one child of a multi-child transfer
  set** and observe which webhook arrives and what it can be keyed on. That is §3.5's
  re-keying requirement, and it is a fifteen-minute test.
- Run the §3.3d residual baseline query against **production** (read-only): 30 days of
  `subscription_credit` + charge-time-stamped `subscription_earning` over writer payouts.
  That number sets `allocated_residual_alert_bps`.
- Run the §7.2 distribution query for `payout_max_slices`.

Sequence (assert ledger + our allocation model + Stripe all agree at every step):

1. Card setup + settlement with allocation on → expand charge; assert
   `allocated_funds.balance.pending == amount`; platform balance unchanged; the
   `allocation-sync` sweep stamps `allocated_pence`.
2. Accrue reads for ≥2 writers across ≥2 settlements; cross the threshold → the payout
   cycle emits one transfer per drawn charge with correct `source_transaction` and
   `application_fee_amount`; app fees appear in platform balance; each child posts **its own**
   ledger entry at its own completion, refs pointing at the parent; the parent completes once
   with `amount_pence == SUM(completed children)`.
3. **Forced over-transfer** — bypass the packer (or hand-edit an `allocated_draws` row) to
   emit a slice exceeding the charge's remaining allocation → Stripe rejects; the worker
   marks that child `failed`, DELETEs its draw row, releases exactly its units
   (`payout_transfer_id` + parent stamp nulled on those rows and no others); siblings
   complete; the parent completes with the restated, smaller amount and a `failed_reason`;
   the ledger sums to the restated amount; the next cycle re-packs the released units onto a
   different source. This tests failure *handling*: with the packer in place the ordinary
   path can no longer produce this (§3.3e).
4. Full refund pre-transfer → drawn entirely from allocated funds; reads → `charged_back`;
   `allocated_draws` refund row lands; the charge stops being drawable.
5. **Partial refund pre-transfer** → allocated balance drops; `manual_review_required`
   fires; the reads stay payable; the next payout packs around the shortfall rather than
   wedging.
6. Refund post-transfer → partial platform-balance draw; `manual_review_required` fires.
7. Transfer reversal (with `refund_application_fee=true`) → funds return to allocated
   state; our `reversal` draw row restores the remainder; ledger reversing entries agree.
7b. **Reversal of one child among several** → the handler resolves via
   `payout_transfers.stripe_transfer_id`, reverses **that child's** `net_pence` only,
   siblings and parent amount untouched, and a redelivery of the same webhook is a no-op
   (the child's `completed → reversed` flip is the idempotency guard).
8. **Credit-funded earning** — drive a `subscription-convert` credit-back, then a payout
   → the earning packs to `funding = 'platform_balance'`, the transfer carries no
   `source_transaction`, and the residual metric moves.
9. **Ineligible brand** — settle with a JCB or Diners test card → `allocated_pence` syncs
   to 0, the charge is never drawn on, and the payout routes elsewhere with no error.
10. Crash-resume: kill the worker mid-child-sequence; restart; assert idempotent
    completion, no double transfer, no re-pack, and that a child completed before the crash
    posts exactly one ledger entry.
11. **Publication cycle** — a payout whose pool spans ≥2 charges → per-split children draw
    from the preference set; `SUM(child.fee_pence) <= platform_fee_pence` and the difference
    is dust, not a tenth of the pool (§3.4); a deliberately failed split completes its parent
    rather than zombifying it (§3.3c).
12. **Carve assertion** — with `TRIBUTES_ENABLED` on in the sandbox, construct a read whose
    root carve exceeds its own net → the apportionment carries the overflow to the next unit,
    both §3.3b assertions hold, and `SUM(unit.net) == writer_payouts.amount_pence`.
13. Flag-off regression: run the full existing payment test suite with
    `STRIPE_ALLOCATED_FUNDS` unset — zero behaviour change.

## 6. Rollout

1. Merge with flag off. Live unchanged.
2. When Stripe confirms live enablement: set `STRIPE_ALLOCATED_FUNDS=1` in production env
   files, restart payment + gateway.
3. **Transition.** Earnings accrued pre-flip are funded by unallocated historical charges.
   The allocation sweep stamps those `allocated_pence = 0`, so the packer never draws on
   them and routes their units to the residual — which is correct (the segregation
   guarantee simply doesn't cover pre-flip funds) and requires no special-casing. Note that
   a payout cycle spanning the flip will mix allocated and unallocated charges in one
   writer's slices: nothing may assume homogeneity, and the residual metric (§3.3d) will
   show a transient spike, above the structural floor measured in §5 step 0, that decays as
   pre-flip earnings drain. Say so in the runbook, or someone will read the spike as a defect.
4. Post-flip smoke: first real settlement → allocated balance via API and via
   `allocated_pence`; first payout cycle → children, fees, funding mix, one ledger entry per
   completed child; reconcile job green.

## 7. Open questions for the implementing session (answer from the repo first)

1. **The paired `subscription_charge` for a `subscription_earning`** — is
   `(subscription_id, period_start, period_end)` a reliable pairing key for the fee
   derivation in §3.3b? If not, take the fee as 0 (safe direction) and note the dust. (The
   *settlement* half of this question is closed: §3.3b adds
   `subscription_events.tab_settlement_id`.)
2. **`payout_max_slices`** — pick a starting value from real settlement-count distributions
   in prod (`SELECT count(DISTINCT tab_settlement_id)` per unpaid writer balance). It is a
   `platform_config` dial, so this is a starting value, not a decision. Run it in §5 step 0.
3. **Publication pool preference set** (§3.4) — confirm the generalised packer signature
   before building the publication cycle, so it isn't written twice.
4. **Not this work, but decide it:** whether to refund the pre-164 gifted-read population
   (§1.3).

Closed since rev 2: the four-client question (§3.1 — three yes, `auth.ts` deliberately no);
stripe-node upgrade vs casting (**cast**, behind a single typed wrapper — the `apiVersion`
literal union is the only obstacle, runtime is governed by the header, and a v14→v18 major
across four call sites plus webhook event typing is not on this critical path); the
`DEPLOYMENT.md:794` webhook-scope contradiction (§0 — the code side is very likely right, but
still verify in the dashboard, since being wrong is silent).

## 8. What this does *not* fix

Stated plainly so a later reader doesn't mistake silence for coverage:

- **Approximate read↔settlement attribution remains** (§1.1). This design routes around it
  rather than fixing it, because PAYMENTS ADR §1.1 forbids touching the apportionment SQL
  and because global conservation (§1.4) is genuinely sufficient for funding. A reader
  looking for "which charge paid for this read" will still not get an exact answer — but
  `payout_transfers` now answers the question that actually matters, "which charge paid this
  writer".
- **The platform subsidy in `subscription-convert`** (§1.2) is unchanged and now merely
  *visible*. Whether crediting a reader for already-settled, already-earned reads is
  intended is a product question.
- **Readers already billed for gifted reads before migration 164** are not refunded by
  it (§1.3). The rule is fixed going forward; the historical population is an open
  business decision.
- **Transfer volume grows from O(writers) to roughly O(writers × charges drawn).** The
  packer minimises the count and `payout_max_slices` bounds it, but the payout cycle is now
  materially more Stripe calls, and more ledger rows (one per child rather than one per
  payout — the SUM views are unaffected but row counts grow). Watch the cycle duration after
  the flip; if it becomes a problem the answer is a longer payout period or a higher
  threshold, not a bigger cap.
- **`writer_payouts.stripe_transfer_id` loses meaning for multi-child payouts** (§3.5). It
  is left NULL rather than holding an arbitrary child's id. Anything reading it as "the
  transfer for this payout" must move to `payout_transfers`.

## 9. Revision history

**rev 3 (2026-07-29)** — rev 2's analysis stands and its external Stripe facts were
re-verified against the published docs (all six correct, verbatim). Its design specified the
*packing* in detail and the *lifecycle* by assertion; three defects followed from that, all
in the same omission — per-child granularity was assumed everywhere and provided for nowhere:

- **No unit → child mapping existed**, so §5.3's "release only that child's units" and
  §3.3c's "un-claim the overflow units" were both unimplementable
  (`read_events.writer_payout_id` points at the parent; `rollbackWriterPayoutRows` is
  payout-granular). Fixed by `payout_transfer_id` on the three claim tables (§3.3c, §4).
- **The ledger was to be posted once at parent completion for the parent's full amount**,
  which either over-reports when a child fails or leaves money moved and the ledger silent
  when the parent never completes — the orphan class this repo has hit twice. Fixed by
  posting per child inside the child's flip transaction, which is what
  `processPublicationSplits` has always done. Refs stay on the parent because
  `ledger_publication_distribution` filters on `ref_table = 'publication_payout_splits'`.
- **The transfer webhook handlers were left keyed on `writer_payouts.stripe_transfer_id`**,
  which can hold one id of N — so `transfer.reversed` for any other child resolves to
  nothing, and if it resolved would reverse the parent's full amount. Fixed in §3.5.

Also corrected: the per-read tribute carve could produce negative units, and flooring them
would silently overpay the writer (§3.3b now apportions with overflow carry and two
assertions); `subscription_events` has no settlement id and none is recoverable after the
fact (§3.3b adds the column); publication splits with `fee = 0` strand the whole pooled
platform fee in allocated state each cycle, which is not dust (§3.4 prorates it); the packer
took `FOR UPDATE` in a data-dependent order and could deadlock (§3.3a fixes the lock order);
`check-ledger-adjacency.sh` would **not** have flagged the moved ledger call as rev 2
claimed, since Guard 2 is a per-file count (§4). A live latent defect was found in passing:
`finalisePublicationPayout` zombifies its parent on any failed split, and rev 2 would have
copied the shape (§3.3c). Smaller: `application_fee_amount` is optional in Stripe's docs,
not required (§2.2 — the conclusion is unchanged, the framing was wrong); `auth.ts` is now
deliberately excluded from the preview API version (§3.1); `chargeback.ts` and
`subscription-convert.ts` were cited at the wrong paths.

**rev 2 (2026-07-29)** — rewritten after evaluating rev 1 against the codebase. Rev 1 was
correct on every external Stripe fact and wrong on three internal ones:

- Its §1 invariant ("every penny of payable writer earnings traces to a completed
  `tab_settlements` row and its `stripe_charge_id`") is false in two coded branches (§1.2),
  and its free-allowance claim was contradicted by `convertProvisionalReads` (§1.3 — since
  fixed by migration 164). It instructed that both be copied into `HOW-MONEY-MOVES.md` and
  into a comment at `classifyRead` so that "future audits stop re-deriving a charge-backed
  earnings gap that doesn't exist". The gap does exist; that instruction would have planted
  a false claim at exactly the spot a future auditor checks. Withdrawn.
- Its payout unit — (writer × settlement), each slice funded by its own charge — assumed a
  per-settlement pairing the code documents as approximate (§1.1). Slices exceeding their
  charge are routine, not exotic; rev 1's response ("fail that child, release only its
  reads") would have released them to be re-claimed and fail identically every cycle,
  forever. Replaced by the attribution/funding split in §3.3.
- Its §3.3 slice query would have returned zero rows (`re.state = 'accrued'` — accrued reads
  have no `tab_settlement_id`; the payable state is `platform_settled`) and omitted three of
  the four terms in the real net. The rewrite avoids the class of error by not touching the
  claim arithmetic at all.

Smaller corrections: `payment_method_types: ['card']` is broader than the eligible brand set
(§2); partial refunds needed handling (§3.5); the publication cycle is not "the same mapping,
different grouping" (§3.4); `application_fee_amount` must floor, never round (§3.3b);
idempotency keys must be row-stable (§3.3c); the resume sweep needs a partial index (§4);
the brake needs its `DEPLOYMENT.md` row and compose default (§3.1); and the
`DEPLOYMENT.md:794` webhook-scope contradiction needs settling (§0).

# Stripe Funds Segregation (Allocated Funds) — Integration Spec

**Status:** Sandbox enabled (2026-07). Live enablement expected from Stripe ~w/c 2026-08-03.
**Docs:** https://docs.stripe.com/connect/funds-segregation
**Revision:** rev 3.1 (2026-07-29) — verification pass: every §2 Stripe fact re-checked
against the live docs (all hold, verbatim); two substantive corrections (§3.5's reversal
claim was stale, §3.6 misstated the halt scope), citation fixes, and the GB cross-border
open question (§7.5). Rev 3 rewrote §3.3c, §3.5 and §5 around per-child state; rev 1's
per-settlement slice model remains withdrawn. See §9. Read §3.3 fresh.
**Build status:** partially built, 2026-07-29 — migration 165, the packer, the shared child
lifecycle and the **writer** cycle are in, dark behind `STRIPE_ALLOCATED_FUNDS=0`. The
publication and tribute cycles, the refund/allocation hooks and the reconcile sweep are
NOT. **Read §10 before doing anything else**: it is the as-built record, and it is where
the code and this spec diverge.
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
> `account.*`). Stripe's Connect-webhooks page supports this reading — its routing rule
> sends "events triggered by resources that exist in your account" to the **Your account**
> scope, and a Transfer is such a resource — but it never names `transfer.*` explicitly,
> so the empirical check stands: if it is the other way round, transfer reversals are
> silently never delivered, and §3.5's ledger semantics never fire. Verify in the
> dashboard (send a test reversal in the sandbox and observe which endpoint receives it),
> then correct whichever document is wrong — noting `DEPLOYMENT.md` also describes a
> ONE-endpoint shape (connected-account listening on, `STRIPE_CONNECT_WEBHOOK_SECRET`
> optional) rather than the two destinations above, so it needs updating beyond line 794
> either way. This is a pre-existing defect, not one segregation introduces; segregation
> just raises the cost of getting it wrong, because reversed funds now return to the
> **allocated** state and our own allocation model (§3.3a) must learn about it.

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
- **Spend→subscription conversion — currently dark, but coded and revivable.**
  `gateway/src/routes/articles/subscription-convert.ts` credits the reader's tab down by up
  to the subscription price against a month's reads, *whatever state those reads are in* —
  including reads already settled and already earned by their writers. The writers keep
  their accruals; the reader is charged less. The platform absorbs the difference, which
  surfaces later as a settlement charge smaller than the reads it settles (i.e. as §1.1's
  second mechanism). The route has been 503-gated behind `SUBSCRIPTION_CONVERT_ENABLED`
  (default off) since 2026-07-16 (deep-audit H2), so it contributes *historical*
  `subscription_credit` entries but no new ones while dark — read the §3.3d baseline with
  that window in mind, and revisit the dial if the flag is ever re-lit. (Found while
  verifying, unrelated to segregation: the route's credit SQL sums bare `amount_pence`
  with no state filter — a pre-164 chargeable-rule violation invisible to
  `check-read-chargeable.sh` Guard 2, which only matches `r.`/`re.`-aliased forms. Queue
  it; do not fix it here.)

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
SQL already reads `chargeable_pence` (`payout.ts:645`; also `:586`, `:588`), so §3.3b's
unit arithmetic inherits it for free; and the *historical* population (readers billed for gifts before 164) was
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
- Unsupported alongside allocation: **overcapture, multicapture, incremental
  authorization**. We use none of them (settlement is a plain off-session card PI);
  recorded so nobody re-derives it.
- **Currency is an implicit constraint**, stated here because it is nowhere else: a
  `source_transaction` transfer must match the currency of the charge's balance
  transaction, and a Balance Transfer (§3.3f) must match the charge's settlement currency.
  All-GBP today, so inert — but it is an assumption, not a fact of nature.
- Availability is BE/CH/DE/DK/ES/FR/GB/NL/SE/US — GB is in. The docs' only cross-border
  statement is US-scoped ("you can only transfer allocated funds to US connected
  accounts"); whether a GB platform can transfer allocated funds to a non-GB connected
  account is **undocumented**. Open question §7.5; probed in §5 step 0.
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
  (`accounts`, `accountLinks`) **and reader card-setup objects** (`customers.*`,
  `setupIntents.*`, `auth.ts:465–567`) — none of which carry allocation or gain anything
  from the preview version, while a *preview* API version can move under us on paths whose
  breakage locks writers out of onboarding or readers out of attaching a card at all. The
  card-setup seam is safe across the version split because this client only *mints*
  Customers and PaymentMethods that the preview-version client later references by id — an
  API version governs request/response shapes, never the objects themselves. If a future
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

**`allocation-sync` sweep**, modelled on `reconcileSettlements` — which is a *service
method* (`settlement.ts:1136`), not a worker: the worker is
`payment-service/src/workers/settlement-reconcile.ts`, a self-rescheduling loop running
three isolated try/catch sweeps at 00:15/08:15/16:15 UTC, and allocation-sync is most
naturally its fourth sweep (or a sibling worker file + one line in `index.ts`), inheriting
the `LIMIT 200` batch + one-hour-grace shape. For each `completed` settlement
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
`payout.ts:687` — `:564` is the `reserveWriterPayout` signature, a rev-3 miscitation). Making it a per-read deduction — as rev 2 did — can drive an individual
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

`status` is a text CHECK, deliberately **not** the `payout_status` enum. Not because a
value is missing — all four child states already exist in that enum
(`pending`/`initiated`/`completed`/`failed`/`reversed`, `schema.sql:145`) — but to
decouple: the child lifecycle should be able to grow a state without an
`ALTER TYPE … ADD VALUE` migration (which the runner routes down the no-transaction path,
its new value unusable until commit) rippling through the three parent tables that share
the enum.

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
  its `stripe_transfer_id` — the guard is `WHERE status = 'pending'`, never merely
  `<> 'completed'` (today's `confirmPublicationSplit` guards only `<> 'completed'`,
  `payout.ts:2241`, so a stray `transfer.paid` can resurrect a `failed` split and even
  complete its parent; the child lifecycle must not copy that hole) — and **post that
  child's ledger entry in the same transaction, gated on the flip's `rowCount`**. This is
  `processPublicationSplits`' existing shape
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
query is §5 step 0 and can be run today. Read it knowing `subscription_credit` has been
dark since 2026-07-16 (`SUBSCRIPTION_CONVERT_ENABLED`, §1.2): a trailing-30-day window
measures only the live `logSubscriptionCharge` branch — the honest *current* floor — and
the dial must be revisited if that flag is ever re-lit.

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
one id, so a `transfer.reversed` for any other child finds nothing and is **silently
dropped** — that alone is the whole argument. (Rev 3 added "and if it did match it would
reverse the parent's full `amount_pence`"; **stale** — the handler has been delta-aware
since 2026-07-06, posting only the cumulative `amount_reversed` delta capped at
`amount_pence` and flipping `reversed` only on full reversal, `payout.ts:916–939`, its own
comment at `:884` naming the full-amount behaviour as the *fixed* bug. Today's handlers
are partial-safe but child-blind.) All three must look up
`payout_transfers.stripe_transfer_id` (hence its index, §3.3c), act on that child's
`net_pence`, and flip the child `completed → reversed`; the reversal ledger entry keeps the
parent ref (§3.3c) and takes its idempotency from that flip's `rowCount`, replacing the
current cumulative-SUM guard — `SUM(writer_payout_reversal) WHERE ref_table =
'writer_payouts' AND ref_id = payoutId` (`payout.ts:917–923`; the `ref_table` scope is
load-bearing, that trigger type being multi-table — F5 posts it against
`publication_payout_splits`, the chargeback planner against `tab_settlements`) — which
cannot distinguish children. Confirm-side flips stay `pending`-guarded per §3.3c.
`writer_payouts.stripe_transfer_id` becomes vestigial for multi-child payouts — leave it
NULL there rather than storing an arbitrary child's id, which would read as authoritative
and isn't (its UNIQUE constraint admits any number of NULLs; the three
`conformance-*-payout` tests pin the old single-transfer semantics and move with this
change — nothing in `gateway/`, `web/` or `shared/` reads the column). The tribute
(`:1953`, `:1984`, `:2085`) and publication (`:2236`, `:2282`, `:2346`) equivalents take
the same treatment, noting `reversePublicationSplit` is likewise already delta-aware.

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

- **Alert, do not halt — and know what already halts.** Rev 3 said `reconcile-ledger.ts`
  halts only on the reader-tab parity break; **wrong**. Its `CRITICAL_CHECKS` holds five
  halting checks — reader parity, two magnitude checks, dispute-stake integrity, and
  `ledger_orphans` — and the header's "reader-tab side only" excludes only the *aggregate
  earnings-vs-table comparison*, not orphan/ref integrity. Two consequences. First,
  `ledger_orphans` ends in a **default-deny catch-all**: a reversal entry whose
  `ref_table` is outside the known set halts ALL payouts — §3.3c's keep-refs-on-parents
  decision is what keeps the new per-child entries inside that set, so it is load-bearing
  twice over, and any future entry with a new `ref_table` must extend the catch-all in the
  same change. Second, verify before the first live cycle that `ledger_orphans` tolerates
  N entries per parent and per-child reversal deltas (§5 steps 2 and 7b assert it). With
  that understood, the original point stands: allocation divergence means our *drawing
  budget* is stale, the packer's response to a stale budget is already safe (§3.3a), and
  halting every payout because a webhook was slow would be a false halt.
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
`scripts/check-ledger-adjacency.sh` Guard **1** (rev 3 miscounted it as Guard 2; Guard 2
is the raw-balance scan) is a per-file `recordLedger` *count*
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
cost and two of them produce numbers the design needs as inputs.

> **Written, not run (2026-07-30).** The build went ahead of this section, so both halves
> now exist as runnable harnesses and the only thing missing is credentials:
> `scripts/segregation-probes.ts` (probes 1, 4, 6, 7, 7b — plus `--countries` for the §7.5
> enumeration) and `scripts/segregation-baseline.sql` (the §3.3d residual baseline, the
> §7.2 slice distribution, and the connect-id list). The probes talk to Stripe raw, per
> this section's own instruction, and print what comes back rather than asserting our
> assumptions onto it. **Read Query 0 of the SQL before Query A** — see the caveat in
> §10.3's step-0 bullet, which is the one thing about these queries that is not obvious.

The list:

- Run steps 1, 4, 6, 7 and **7b** below against the sandbox with no §3.3 code at all.
  7b is the one rev 2 never thought to ask: reverse **one child of a multi-child transfer
  set** and observe which webhook arrives and what it can be keyed on. That is §3.5's
  re-keying requirement, and it is a fifteen-minute test.
- Run the §3.3d residual baseline query against **production** (read-only): 30 days of
  `subscription_credit` + charge-time-stamped `subscription_earning` over writer payouts.
  That number sets `allocated_residual_alert_bps` (read with §3.3d's dark-flag caveat).
- Run the §7.2 distribution query for `payout_max_slices`.
- Enumerate the countries of all live connected accounts (Stripe `accounts.list`, or the
  accounts behind our stored connect ids). All GB → record that as the §7.5 standing
  assumption. Any non-GB → §7.5 is live: probe in the sandbox whether a GB platform's
  allocated funds transfer cross-border, before the flip.

Sequence (assert ledger + our allocation model + Stripe all agree at every step):

1. Card setup + settlement with allocation on → expand charge; assert
   `allocated_funds.balance.pending == amount`; platform balance unchanged; the
   `allocation-sync` sweep stamps `allocated_pence`.
2. Accrue reads for ≥2 writers across ≥2 settlements; cross the threshold → the payout
   cycle emits one transfer per drawn charge with correct `source_transaction` and
   `application_fee_amount`; app fees appear in platform balance; each child posts **its own**
   ledger entry at its own completion, refs pointing at the parent; the parent completes once
   with `amount_pence == SUM(completed children)`; then run the ledger-reconcile cycle and
   assert it stays green — `ledger_orphans` must tolerate N entries per parent (§3.6).
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
   (the child's `completed → reversed` flip is the idempotency guard); ledger-reconcile
   stays green after the per-child reversal entry (§3.6's catch-all sees
   `ref_table = 'writer_payouts'`, inside the known set).
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
5. **Cross-border allocated transfers from a GB platform** — Stripe documents the
   restriction only for US platforms ("you can only transfer allocated funds to US
   connected accounts"); the GB case is undocumented. §5 step 0 enumerates connected-account
   countries: all GB → record that as the standing assumption here; any non-GB → ask
   Stripe / probe the sandbox before the flip.

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

**rev 3.1 (2026-07-29)** — verification pass against the live Stripe docs and the code;
the design is unchanged. Every §2 external fact held verbatim (preview header string,
brand set, multi-transfer split wording, Balance-Transfer reclaim shape, the `expand[]`
read-back with `pending`/`available`, refund/reversal/dispute semantics, sandbox-only,
and the queue-until-settlement behaviour of `source_transaction` transfers). Corrections:

- **§3.5's "would reverse the parent's full `amount_pence`" was stale** —
  `reverseWriterPayout` has been delta-aware since 2026-07-06 (`payout.ts:916–939`); the
  re-keying requirement stands on the dropped-event half alone. (The rev 3 entry below
  repeats the stale clause; corrected here, not rewritten there.) The guard being replaced
  is also `ref_table`-scoped, which rev 3 omitted and which is load-bearing.
- **§3.6 claimed `reconcile-ledger.ts` halts only on reader-tab parity** — five checks
  halt, including `ledger_orphans` with a default-deny catch-all over reversal
  `ref_table`s, making §3.3c's parent-ref decision load-bearing twice over; §5 steps 2/7b
  gain the matching assertions.
- **§1.2's spend→subscription mechanism is dark** — 503-gated behind default-off
  `SUBSCRIPTION_CONVERT_ENABLED` since 2026-07-16, so it contributes historical entries
  only; the §3.3d baseline reading is annotated. (Side finding for the queue, not this
  work: its credit SQL violates the migration-164 chargeable rule invisibly to the
  tripwire.)
- **§3.3c's enum-avoidance rationale was moot** (all four child states already exist in
  `payout_status`); restated as a decoupling choice. The child completion flip is now
  specified `pending`-guarded, closing the resurrect hole `confirmPublicationSplit` has
  today (`payout.ts:2241` guards only `<> 'completed'`).
- **Citations:** the carve formula is `payout.ts:687` and the `chargeable_pence` claim SQL
  `payout.ts:645` (both were cited as `:564`, the `reserveWriterPayout` signature); the
  ledger-adjacency registry count is Guard **1**, not 2; `reconcileSettlements` is a
  service method whose worker is `settlement-reconcile.ts` (§3.3a); `auth.ts`'s client
  also drives reader card setup, not only onboarding (§3.1).
- **Added:** the beta's unsupported-features list and currency-match constraints (§2); the
  GB cross-border open question (§7.5, probed in §5 step 0); the Connect-webhooks routing
  rule supporting (but not settling) the §0 `transfer.*` scope question, and the note that
  `DEPLOYMENT.md` needs updating either way; the conformance-test / no-other-readers facts
  behind leaving `writer_payouts.stripe_transfer_id` NULL (§3.5).

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

## 10. As built (2026-07-29) — what exists, what diverges, what is missing

**Updated later the same day (part 2).** The publication cycle, the
`charge.refunded` allocation hooks and the `finalisePublicationPayout` zombie
are now built, and the flag-ON assembly has DB-backed, mutation-verified
coverage.

**Updated again the same day (part 3).** The TRIBUTE cycle, the §3.6 reconcile
sweep, the §3.3d residual metric and the §3.3f dust script are built, so **the
build is complete**: all three payout cycles fund through the packer and the
shared child lifecycle. §10.3 is now short and worth reading in full — what
remains is the unrun §5 step 0 (the single flip blocker), one pre-existing
carve/slice-cap interaction found on the way, and the Stripe-facing half of the
execute loop that no test in this repo can reach. Read §10.1b and §10.3
together.

Everything below is behind `STRIPE_ALLOCATED_FUNDS` (default off). Flag off is
byte-identical to before: the four conformance batteries pass unchanged, which is §5.13.

### 10.1 Built

- **Migration 165** (`payout_transfers`, `allocated_draws`, the two `tab_settlements`
  columns, `subscription_events.tab_settlement_id`, the three `payout_transfer_id`
  stamps). `schema.sql` regenerated by pg_dump-and-re-append from a throwaway built off
  the committed file; `check-schema-drift.sh` green on all seven checks.
- **`STRIPE_ALLOCATED_FUNDS`** + `ALLOCATED_FUNDS_API_VERSION` in `shared/src/lib/env.ts`;
  `DEPLOYMENT.md` row and `docker-compose.yml` defaults (payment + gateway).
- **`payment-service/src/lib/stripe-client.ts`** — the single cast site (§7's closed
  question 2). Three clients switched (`settlement.ts`, `payout.ts`, `routes/webhook.ts`);
  `gateway/src/routes/auth.ts` deliberately not, per §3.1.
- **§3.2 settlement** — `allocated_funds[enabled]` + `transfer_group` on the PI.
- **§3.3a allocation sync** — `settlementService.syncAllocations()`, wired as the
  settlement-reconcile worker's fourth sweep, `LIMIT 200`, oldest-unsynced first, `0`
  (not NULL) for a charge carrying no allocation.
- **§3.3b packer** — `payment-service/src/lib/allocation-packer.ts`: `packUnits`,
  `apportionCarve`, `prorateWithheldFee`. Pure, 20 tests, and three mutations were run
  against it (gross ignoring the fee; the carve's `min` clamp; floor→ceil on the fee
  proration) — each turns the suite red.
- **§3.3c lifecycle** — `payment-service/src/services/payout-children.ts`: lock-in-id-order
  funding sources, child insert + draw, the execute loop with per-child terminal/ambiguous
  handling and the `xfer-<childRowId>` key, per-child completion posting its own ledger
  entry inside the flip transaction, per-child terminal failure, parent completion on "no
  child pending", and the webhook-side child resolution + reversal.
- **The writer cycle end to end** — packing inside Txn 1 (both §3.3b assertions live),
  slice-cap overflow un-claimed in the same transaction with a threshold re-test, per-child
  execute/complete/fail, and §3.5's re-keying of `confirmPayout` / `reverseWriterPayout` /
  `handleFailedPayout`.
- **§4 tripwire** — `INSERT INTO payout_transfers` added to `PAYOUT_MARKER`;
  `payout-children.ts` registered.

### 10.1a Built in part 2 (2026-07-29, later)

- **§3.5 `charge.refunded`, both arms.** `settlementService.recordRefundDraw`
  (statement exported as `RECORD_REFUND_DRAW_SQL`) inserts one
  `allocated_draws` row per settlement, `kind = 'refund'`, holding the
  CUMULATIVE refunded total. Called from the webhook BEFORE the reverse
  decision, so the partial arm — which does nothing else but WARN — is covered:
  that arm was the wedge, since the reads stay `platform_settled` and stay
  payable against a charge that has been drained. Idempotent by the
  `(ref_table, ref_id, kind)` unique; **GREATEST, not assignment**, because
  webhook delivery is unordered and a late redelivery of the first partial must
  not shrink the budget back. A lost dispute deliberately records nothing
  (§3.5: disputed funds stay allocated), with `syncAllocations` as the backstop.
- **§3.4 the publication cycle.** `packPublicationSplits` runs inside
  `reservePublicationPayout`'s transaction: one unit per split, the pool's
  contributing settlements (from the claimed reads' and subs'
  `tab_settlement_id`) as the **preference set**, and
  `prorateWithheldFee` supplying the per-split fee so the already-withheld
  pooled fee actually leaves allocated state. `processPublicationSplits`
  branches on `hasChildren` (data, not flag) into
  `completePublicationSplitChildren`; the three transfer webhook handlers
  (`confirmPublicationSplit`, `reversePublicationSplit`,
  `handleFailedPublicationSplit`) resolve a child first.
  `advanceUnits`/`releaseUnits` are **no-ops by design** — a split owns no claim
  rows (its reads are claimed under the payout), and a terminally failed split
  keeps its claim for manual re-pay (§1.2).
- **The legacy `finalisePublicationPayout` zombie is fixed.** The rule is now
  "no split PENDING", in one place — `PUBLICATION_PAYOUT_COMPLETE_SQL`, used by
  all three call sites.
- **Coverage.** `payment-service/tests/segregation-assembly-integration.test.ts`
  — 14 DB-backed tests (real Postgres, always-rollback, `skipIf(!DB_URL)` so CI
  stays green) over budget → pack → children → draws → complete → reverse, plus
  the refund hook and the zombie. **Seven mutations were run and all seven turn
  the suite red**: the zombie predicate restored; `prorateWithheldFee` back to
  rev 2's `0`; the refund upsert's GREATEST dropped (in the test's copy AND in
  production's statement); `completeParentIfSettled` blocking on a failed child;
  `failChild` not releasing its draw; the draw recording net instead of gross.
  Both SQL statements are **exported and executed by the test**, not copied, so
  a regression in the service is detectable at all — and the publication
  conformance mock now **parses the sibling predicate out of the SQL** rather
  than restating it, so it catches the zombie mutation too (it did not, at
  first: that was found by running the mutation, not by reading the mock).

### 10.1b Built in part 3 (2026-07-29, later still)

- **§3.4 the TRIBUTE cycle.** `packTributePayout` runs inside
  `reserveTributePayout`'s transaction: one unit per claimed `tribute_accruals`
  row, its read's `tab_settlement_id` as the preferred settlement, and **fee 0**
  — an accrual is carved out of the author's already-post-fee net, so there is no
  second fee to claim. This node's ONWARD carve to its direct children goes
  through the same `apportionCarve` the writer cycle uses, with the same two
  assertions (`carveRemaining === 0`, `Σ units === the payable net`), so a naive
  per-accrual deduction driving a unit negative is a rolled-back transaction
  rather than an over-pay. `completeTributePayout` branches on `hasChildren`
  (data, not flag) into `completeTributePayoutChildren`; all three transfer
  webhook handlers resolve a child first.
- **The carve, per child.** The author's `tribute_carve` debit is now posted per
  child for THAT child's accruals, at their **GROSS** (`amount_pence`), not the
  child's post-carve net — the onward carve flows from the inspirer, not the
  author. It is read from `state = 'released'`, which is **order-dependent**:
  `postLedger` runs before `advanceUnits` inside the shared completion
  transaction, and read after the advance it sums 0 and the author silently keeps
  earnings that left them. Both statements are exported and the integration test
  runs them in that order, with the post-advance figure as a paired control.
- **The carve-zeroed accruals** (whose whole share went onward) keep the parent
  claim, get no child, and advance at parent completion —
  `TRIBUTE_CHILDLESS_ADVANCE_SQL`, whose `RETURNING` is the single-shot gate that
  ledger entry needs. `completeParentIfSettled` cannot supply one: it reports
  `completed` from a tally, not from its own UPDATE's `rowCount`.
- **`prorateCarveReversal`** (`allocation-packer.ts`) — the per-child carve
  re-credit, prorated to the CHILD's own cumulative reversal fraction, derived
  from `payout_transfers.reversed_pence` before and after the flip. It improves
  on the parent-grain path structurally: both terms use the same carve figure, so
  the difference cannot go negative even when a chargeback shrinks the carve
  between two partials, where the legacy `carveTarget − Σ ledger entries` needs
  its `> 0` test to stay honest.
- **§3.6 reconcile + §3.3d residual metric** —
  `payment-service/src/services/allocation-reconcile.ts`, a **sibling** of
  `reconcile-ledger`, not part of it: that file's `CRITICAL_CHECKS` holds five
  HALTING checks and a default-deny catch-all, and an allocation check added
  there is one edit away from halting payouts because a webhook was slow. Both
  sweeps alert at ERROR and never halt. Wired into the ledger-reconcile worker
  (3×/day) in its own try/catch, after the parity run, so a Stripe outage cannot
  cost us the halting decision above it.
  - **No watermark, deliberately.** §3.6 warns a watermark over
    `allocation_synced_at` must round-trip at Postgres precision. This sweep needs
    none: `syncAllocations` already rotates oldest-first past
    `allocation_sync_freshness_hours`, so taking the MOST RECENTLY SYNCED batch
    walks a moving window over the whole population, comparing only figures fresh
    enough that a difference means something. No stored position, no precision to
    lose.
  - The divergence figure is deliberately **not** `GREATEST(0, …)` — a model that
    has drawn past zero is exactly the state worth alerting on, and flooring it
    (as `lockFundingSources` correctly does, where an under-draw is safe) would
    hide the magnitude.
  - The residual metric returns **null, not 0 bps**, for an empty window: no
    payouts is no measurement, and 0 would read as perfect coverage and satisfy
    the alert forever on a platform whose payout cycle had stopped.
- **§3.3f `scripts/sweep-allocated-dust.ts`** — report-only by default, `--apply`
  to issue Balance Transfers, `--max-pence` (default 100) for what counts as
  dust. It refuses a charge with any `pending` child, and its header names the
  trap: if this finds POUNDS the fee proration is what to check, not the
  threshold.
- **Coverage.** +7 DB-backed tribute tests and +5 reconciliation tests in
  `segregation-assembly-integration.test.ts` (26 total), +5 `prorateCarveReversal`
  and +6 `allocation-reconcile` unit tests. **Fifteen mutations were run; all but
  one turned a suite red, and the survivor was fixed rather than explained away**
  — dropping `allocated_pence IS NOT NULL` from the candidate SQL left everything
  green, because the fixture's sibling guard excluded the row anyway. The test now
  poses the combination the guard exists for (synced-stamped, no figure) and
  detects. The neighbouring `allocation_synced_at IS NOT NULL` guard is genuinely
  redundant, measured the same way, and says so in its own comment rather than
  carrying a contrived fixture.

### 10.2 Divergences from the spec above — read these, they are deliberate

1. **`payout_transfers.reversed_pence` is a column the spec does not name, and the design
   needs it.** §3.5 says per-child reversal "takes its idempotency from that flip's
   `rowCount`", which is true only for a full reversal. Stripe reports `amount_reversed`
   CUMULATIVELY, so a staged partial must post a delta — and the existing handlers derive
   that delta by SUMming reversal ledger entries against the payout row, which cannot work
   here: §3.3c keeps the ledger ref on the PARENT, so N children share one ref and their
   reversals are indistinguishable in it. Per-child cumulative state is the only place the
   figure can live. `reverseChild` reads and writes it under the child's row lock.
2. **A parent whose children ALL failed is flipped `failed`, not left `pending`.**
   §3.3c specifies completion on "no child pending" and is silent on the zero-completed
   case; leaving it `pending` recreates exactly the `finalisePublicationPayout` zombie the
   same section calls out — the resume sweep would revisit it every cycle, find nothing
   pending, and never resolve it. Its units were already released child by child, so the
   next cycle re-pays them under a fresh parent.
3. **Completion branches on whether the payout HAS children, not on the flag.** A payout
   reserved with segregation on must complete through its children even if an operator
   flips the flag off mid-flight — the children exist and their draws are recorded, so one
   aggregate transfer would double-pay against them.
4. **The §4 tripwire claim needed correcting in the code, not just in prose.** §4 is right
   that the guard would not have flagged this, but `payout.ts`'s registry floor stood at
   **4 against 9 actual call sites**, so it would equally not have flagged deleting four of
   them. The floor is now 11, re-read by hand. `payout-children.ts` is registered at a floor
   of **0** — it inserts `payout_transfers` (hence Guard 3) but correctly posts no ledger
   entry of its own, each cycle supplying one through `ChildCycleSpec.postLedger`. That
   legitimate 0-floor exposed a latent bash bug in the script (`grep -c || echo 0` emitting
   two lines into an arithmetic test); fixed in the same commit.
5. **§7 question 1 answered: the pairing key holds.** `logSubscriptionCharge` inserts the
   charge and the earning together with the same `(subscription_id, period_start,
   period_end)`, so the fee is recoverable — but the lookup REQUIRES exactly one match and
   takes fee 0 otherwise, per the safe direction §3.3b names.
6. **§7 question 3 answered ahead of the publication cycle.** `EarningUnit` carries
   `preferredSettlementIds: string[]`, not a scalar, so the preference-set generalisation
   §3.4 needs is already in the packer's signature and tested. The publication cycle will
   not rewrite it.

### 10.3 Not built — the honest remainder

**All three payout cycles, the reconcile sweep, the residual metric and the dust
script are now built** (§10.1 / §10.1a / §10.1b). What is left is one measured
decision, one known interaction, and the parts of the Stripe-facing loop no test
in this repo can reach.

- **A publication split is ONE indivisible unit, so it never spreads across charges.**
  Per §3.4 as written, but worth stating as a known limitation rather than leaving it
  implicit: a pool spans many charges by construction, so a member's share can exceed any
  single charge's remaining allocation and route to platform balance. Safe (it is ordinary
  pre-flip behaviour) but NOT segregated, and it will show up as publication-heavy residual
  in the §3.3d metric — which is the measurement that should decide whether a divisible
  unit is worth the fee-proration rounding it would reintroduce. Do not decide it before
  the metric exists.
- **The slice cap and the carve interact, and the interaction over-carves.** Found
  while building the tribute cycle; it is **pre-existing in the shipped writer
  cycle** and the tribute cycle now reproduces its shape deliberately rather than
  diverging from it. The carve is scoped to the reads/accruals claimed *this*
  cycle and is apportioned across ALL units **before** packing; units past
  `payout_max_slices` are then un-claimed and roll to the next cycle, where their
  carve is counted **again** — while this cycle already collected it, possibly
  from a different unit. The recipient is permanently short by the overlap and
  the money stays in platform balance. Needs BOTH tributes live AND an overflow
  (a writer whose earnings span more than `payout_max_slices` charges), so it is
  inert today on two counts. Not fixed here because the honest fix is not local —
  the carve determines the nets, the nets determine the packing, and the packing
  determines the overflow, so excluding overflowed units from the carve is a
  fixpoint. **This is a third input to §5 step 0**: the slice distribution that
  sets `payout_max_slices` also decides how reachable this is.
- ~~**Zero-net units could wedge a reserve** (found by the 2026-07-30 commit review,
  finding 4)~~ — **FIXED 2026-07-30**. A fully-gifted read (`chargeable_pence = 0`,
  migration 164) and a 1p-chargeable read (whose net FLOORS to 0 under
  `perReadNetPence`) both settle and both get claimed — the claim deliberately has no
  amount filter — and either could open its own slice: a `netPence: 0` child violating
  `payout_transfers_net_positive`, aborting the whole reserve, and (packing being
  deterministic) aborting the SAME writer every cycle. Gross 0 also "fitted" a
  settlement id absent from the sources map, handing `openSlice` an undefined source.
  Fixed in the packer itself so all three cycles are covered structurally: `packUnits`
  sets `netPence <= 0` units aside in a new `zeroNet` result bucket (callers KEEP
  their claims — the same childless-advance treatment as carve-zeroed reads; any fee
  is dust for the Balance-Transfer sweep, the safe direction), and `usable` now
  requires presence in the sources map before comparing remainders. Four packer tests
  + two DB-backed assembly tests (the CHECK as a paired control, and the wedge shape
  through pack→insert); mutation-verified — reverting the filter in place turns 5
  tests red.
- **Test coverage, and what it still does not reach.** The flag-ON assembly now has 28
  DB-backed, mutation-verified tests (§10.1a, §10.1b, + the two zero-net tests above). What they do NOT cover is
  `executePendingChildren`'s Stripe call itself — it drives the module-level `pool`, so it
  is unreachable from inside a rolled-back transaction, and the terminal/ambiguous split,
  the row-stable key and the flip-gated ledger emit remain pinned only by the mock-based
  conformance batteries. Nor is the publication reserve driven end-to-end with the flag ON:
  `packPublicationSplits` is exercised through its parts, not through
  `runPublicationPayoutCycle`.
- **§5 step 0 was not run, and the design consumed placeholders in its place.**
  `allocated_residual_alert_bps` ships at 2000 as an explicit placeholder and WILL fire
  spuriously; `payout_max_slices` ships at 20 as a guess. Both are dials, so both are an
  UPDATE — but §3.3d's warning stands: a threshold set without the baseline gets muted, and
  a muted alert is worse than none.
  - **The harnesses were written 2026-07-30** (`scripts/segregation-probes.ts`,
    `scripts/segregation-baseline.sql`) so this is now a credentials errand rather than a
    build. The two halves are blocked differently: the **probes** need a segregation Sandbox
    key, which no dev stack has (its `STRIPE_SECRET_KEY` is the literal placeholder
    `sk_test_...`); the **baseline** needs only production DB access and is runnable today.
  - **A trap in the residual query, which is why it leads with a diagnostic.** Query A must
    tell a credit-funded `subscription_earning` from a charge-funded one. The exact test is
    `tab_settlement_id IS NULL` — but migration 165 added that column with **no backfill,
    deliberately** ("stamped going forward"), so every row predating the stamp carries NULL
    whatever funded it and the exact classifier reads them all as credit-funded. On a DB
    where 165 has not run at all, that is a ~100% residual and a meaningless dial. So Query 0
    reads `_migrations.applied_at` and states which classifier the window supports, and
    Query A reports the exact and a `settled_at < created_at + 1 minute` heuristic side by
    side. The heuristic works on pre-stamp rows and errs toward a LARGER residual — the safer
    direction for a threshold.
  - **On production the stamp started 2026-07-29** (migration applied 16:35 UTC; the part-1
    code that writes the column live in the backend images built ~16:10 that day), so a
    30-day window run today straddles the boundary and the **heuristic** row is the honest
    one. The exact row becomes authoritative around **2026-08-28**, when a full window sits
    behind the stamp. Recorded here because it was got wrong twice in one session by
    inferring prod's state from this file rather than querying it: `_migrations.applied_at`
    and `docker compose images` are the evidence, and both are one command away.
  - **`payout_max_slices` is measured as an upper bound**, and says so: the packer
    co-locates units onto a shared charge where one has room, and collapses all residual
    units into a single `platform_balance` slice, so realised slices are ≤ the measured
    figure. Exact measurement is impossible pre-flip — remaining allocation per charge is
    unknown until charges carry allocation at all. An upper bound is the right side to err
    on for a cap, given §10.3's carve × slice-cap interaction above.
- **§0's `DEPLOYMENT.md:794` webhook-scope contradiction is untouched.** It needs the
  dashboard observation, not an edit.

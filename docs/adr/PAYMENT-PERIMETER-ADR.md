# Payment Perimeter — Platform Stance (not Merchant of Record)

**Status:** Accepted, 2026-08-05 (rev. 4 — rev. 3 plus corrections from a full
W1–W8 code-verification pass, same day: W1's second detection option struck,
W2's metric source and destination corrected, W3's dead publication dial
found, W4 re-scoped around attribution/truncation/the publication cycle, the
W7 audit RUN with findings recorded in place, and the pooled-fee remainder
disclosure folded into W0(c). Rev. 3 was rev. 2 plus W1/W4/W5 scoping;
supersedes the Proposed draft of the same date). Sits alongside
`FUNDS-SEGREGATION-INTEGRATION.md` (mechanism) and
`UPSTREAM-EDGES-TRIBUTE-COMPLIANCE.md` (tribute).
**Counsel:** Harper James draft advice note, 8 May 2026 (VNL platform & payment
services). Paragraph references (`HJ ¶x.y`) are to that note. It is a DRAFT,
its §1 background misdescribes our funds flow (see §1.3), and it must not be
cited as covering the current build. A final note on the true flow is being
sought — see W0.
**Stripe docs:** https://docs.stripe.com/connect/charges ·
https://docs.stripe.com/connect/funds-segregation ·
https://docs.stripe.com/connect/separate-charges-and-transfers

**Owner decision (Ed, 2026-08-05):** we adopt counsel's own restructuring
option at **HJ ¶7.27.2** — VNL as **commercial agent of the Writer**, with
authority in the Writer Terms to conclude the sale of reading access, and
receipt by VNL discharging the Reader's debt. Priorities, in order: (1) reach a
legally approvable model in the shortest time with minimal counsel round-trips;
(2) keep that model as close as possible to the Platform-plus-segregation
build, not Merchant of Record. Merchant of Record and SPI/API authorisation are
fallbacks only, reachable exclusively through the ladder in W0(e).

**Read §1 before proposing any change to charge type. Read §4 before writing
any user-facing or documentation sentence about where money sits. Read
"Execution order" before starting any work item.**

---

## 0. Decision

We pursue a **Platform** stance on two legs:

- **Leg A — the commercial agent exclusion** (HJ ¶7.27.2; Sch. 1 Pt. 2
  para (b) PSRs). Now the **adopted primary structure**, pending counsel's
  confirmation via W0. VNL acts as agent of the Writer only, never of the
  Reader. **The legal pivot, stated once so no session rediscovers it:** the
  FCA's Q33A example of a platform acting for *both* sides is a payer paying
  into an account the platform controls *where that receipt does not settle
  the payer's debt*, followed by a later transfer to the payee. That example
  is our funds flow **unless the Writer Terms provide that payment to VNL
  discharges the Reader's debt at the moment of charge** (agent-of-payee
  receipt = good discharge). Leg A therefore requires (i) that term, drafted
  by counsel, and (ii) code and copy consistent with discharge-on-receipt.
  The code already is, in the ways that matter: reads are stamped
  `platform_settled` on webhook confirmation and the Reader is never
  re-pursued for a successfully charged settlement. The chargeback path
  restores debt to the tab — W0(a) asks counsel to confirm that reads as a
  *new* claim arising from the reversal, not evidence the original was never
  discharged. Code obligations beyond that are §3.W9 only.
- **Leg B — funds-control minimisation.** Code. This ADR.

Leg B cannot succeed alone and must never be written up as though it could.
Its job is to make the answers to HJ ¶7.10.3 (legal entitlement pending
settlement) and ¶7.10.4 (operational control) as good as the architecture
permits, so that if Leg A is challenged the fallback position is defensible
rather than empty.

---

## Execution order (for coding sessions)

Work items are not equal. The strategy is one comprehensive counsel package
(W0) instead of iterative Q&A, so the critical path is *making true the two
things that package asserts*, then sending it.

- **Critical path — do first, this gates W0 going out:**
  **W1 detection + runbook** (negative tab = incident, discharged outward).
  **DONE 2026-08-06** — but it surfaced a blocker on the letter itself: the
  spend→subscription conversion route produces a Reader-funded negative tab *by
  design*, so W0 cannot assert that a negative tab is always an incident until
  that is resolved. See W1's dilemma note; it is an owner decision.
  The **W7 audit is DONE** (2026-08-05, findings recorded in W7): what still
  gates W0 from it is carrying the pooled-fee-remainder disclosure into the
  letter (now in W0(c)); the W7 renames are parallel-lane. The W1 **admin
  refund action does not gate W0** — it is a full new Stripe money path (see
  W1) and sits in the parallel lane; the detection plus the documented runbook
  is what makes the package's assertion true on the day it goes.
- **Parallel — start any time, none gates approval:**
  W2, W4, W5, W6, W8, the W3 threshold/cadence work, and the W1 admin refund
  action.
- **Gated — do not start until W0's response is back:**
  W9 (agent copy), the W3 "pay me now" endpoint, and any renaming or copy
  that presupposes the trust (W7 second bullet is safe to do now; the *Terms*
  are counsel's).
- **Not code, not this repo's job, but blocks W9:** W0 itself.

A session that finds itself blocked on counsel should pick up the parallel
lane, not invent interim copy.

---

## 1. The fixed constraint (do not relitigate)

### 1.1 One payment, one settlement account

A payment collected from a customer settles on exactly one Stripe account — the
settlement merchant. The reading tab is by design a **shared** tab: one card
charge discharging reads across N Writers. Therefore:

| Charge type | Writer is settlement merchant? | Compatible with a shared tab? |
|---|---|---|
| Direct charges | Yes | **No** — one connected account per charge |
| Destination charges + `on_behalf_of` | Yes | **No** — `on_behalf_of` must match `transfer_data[destination]`, i.e. exactly one account |
| Separate charges and transfers | No | Yes — this is what we run |

Stripe classes destination charges and SC&T together as **indirect charges:
payments made to your platform**. There is no configuration under which a
shared tab charge does not land with VNL first.

### 1.2 The escape route is arithmetically dead

Per-Writer tabs would restore direct charges. At 20p an article and an £8
threshold, a Writer's tab needs 40 reads *of that Writer* to settle; a reader
spread across twenty Writers settles with nobody, and Stripe's 30p floor plus
per-charge fees consume the rest. Do not propose it. Do not propose a hybrid
that "promotes" high-volume Writers to direct charges — it splits the ledger
into two incompatible funds flows for no perimeter gain on the tail.

**Consequence, recorded plainly: HJ ¶7.10.1 (where funds are legally received)
and ¶7.10.2 (in whose name the balance is maintained) answer "VNL" and cannot
be made to answer otherwise while the tab is shared.** The shared tab *is* the
product (see README, `CLAUDE.md` §What This Is). Trading it away to move those
two factors would trade the platform for the perimeter. Under Leg A this is
survivable *because* receipt discharges the Reader's debt — which is why W0(a)
is the question that matters most.

### 1.3 The advice was given on a different funds flow

HJ ¶1.7.2(d), ¶1.7.2(f), ¶1.8 and ¶1.9 describe Stripe deducting the Fee,
retaining its own and forwarding the VNL Fee — a destination-charge flow — and
state that funds accumulating toward a Writer's minimum are held *by Stripe*,
with VNL neither holding nor controlling them. Neither is true of this
codebase. Any future session that reads the advice as blessing the current
build has misread it. `docs/HOW-MONEY-MOVES.md` is the accurate account and is the
factual substrate of the W0 package.

---

## 2. What we are scoring against

HJ ¶7.14 lists the control factors that raise perimeter risk. Current and
target state:

| Factor | Today | Target | Mechanism |
|---|---|---|---|
| 7.14.1 withdraw | Yes — settled funds sit in the platform balance | No | Segregation: allocated funds are outside the platform balance and can only move to a connected account |
| 7.14.2 redirect | Yes — payout logic, publication splits, tribute | Minimised | `source_transaction`; §3.W5; §3.W6 |
| 7.14.3 refunds | Drawn from platform balance | Drawn from the funding charge's allocation | Segregation refund hook (already built) |
| 7.14.4 apply against liabilities | 8% retained implicitly from gross | Explicit `application_fee_amount` at transfer | Segregation (already built) |
| 7.14.5 settlement timing | VNL sets thresholds and cadence | Writer's standing instruction | §3.W3 — but see its trade-off note |
| 7.14.6 principal-like control | Global payout halt; broad discretion | Narrowed, evidenced, bounded | §3.W4 |

Two things this table cannot reach, and which must be stated as limits rather
than quietly omitted:

- **Segregation is a Stripe product feature, not statutory safeguarding.** An
  allocated balance is not a trust, is not safeguarded under reg. 23 PSRs, and
  on its own gives Writers no proprietary claim if VNL fails. It is the
  *mechanism* by which a trust declared in the Writer Terms would be performed.
  Without that declaration it is good hygiene and nothing more (§3.W7, W0(c)).
- **Dispute liability is permanent.** With indirect charges the platform is
  responsible for related negative balances, and the segregation preview
  *requires* platform responsibility for connected-account negative balances
  (cite: Stripe funds-segregation docs — verify the current text when next in
  them and pin the URL/date here). VNL is the disputed merchant. That marker
  of principal cannot be engineered away and should not be argued around.

---

## 3. Work items

Each item states the change, the files, the acceptance criterion, and the trap.
Ordering and gating are in "Execution order" above; W1 and the W7 audit gate
the W0 package, and W0's response gates W9.

### W0 — One counsel package, not iterative Q&A (not code)

**Owner:** Ed, with Harper James. Recorded here because it gates W9 and every
external representation, and so no coding session waits on questions that have
already been sent.

Contents of the instruction letter — framed as **decisions made, seeking
confirmation and drafting**, never as open uncertainties (open questions
invite hedged drafts and a second cycle):

- **(a)** We adopt your ¶7.27.2 structure. Confirm the commercial agent
  exclusion survives the SC&T shared-tab flow given Q33A's both-sides
  example, on the basis that the Writer Terms provide receipt by VNL settles
  the Reader's debt at the moment of charge. Confirm the chargeback path
  (debt restored to the tab, collection paused pending card re-attach) reads
  as a new claim, consistent with the original discharge.
- **(b)** Confirm dual-role users (the same person Reader in one transaction,
  Writer in another) do not defeat the exclusion, it being transaction-level.
- **(c)** Draft the Writer Terms and Reader Terms: the agency grant,
  discharge-on-receipt, and a declaration that VNL holds settled-but-unpaid
  Writer earnings on trust, with Stripe allocated funds as the mechanism of
  performance. Counsel drafts; we do not send our own drafts for review.
  **The trust must be drafted around one disclosed retention beyond the 8%**
  (W7 audit finding, 2026-08-05): where a publication's standing shares sum
  below 10000 bps the platform retains the remainder
  (`publication_payouts.remaining_pool_pence`). It is member-mandated — the
  members set the bps — but it leaves the Writer-owed pool, so the letter
  must disclose it or the "8% and nothing else" assertion is untrue on send
  day. Disclosure, not code change (see W7).
- **(d)** The consumer credit question (HJ ¶11, ¶13.2) scoped into the same
  letter: deferred collection to £8 / £2-at-30-days, subscriptions accrued to
  the tab, disputed debt restored with collection paused. Running-account,
  repayable in full, no interest or charges — their call whether an RAO
  exemption applies. Launch-blocking either way (README).
- **(e)** A pre-specified fallback ladder so a "no" on (a) does not cost a
  second cycle: *if the exclusion fails, advise in the same note whether
  trust + segregation alone is defensible; if not, whether SPI registration
  (volumes comfortably under the €3m/month average, HJ ¶7.33) or agent-of-EMI
  is the faster route.* This ladder is the only door to MoR or SPI/API;
  nothing in this repo moves toward either without it.
- **(f)** Enclosures: `docs/HOW-MONEY-MOVES.md` (checked against code
  2026-08-05) and this ADR. Ask for a **final** note on this flow, not a revision of the
  draft. (Rev. 4 note: that doc describes the shared tab and the separate
  charges-and-transfers mechanics accurately but never uses either term — the
  covering letter should name them once so counsel can map the doc onto
  Stripe's taxonomy without inferring it.)
- **(g)** Also enclose the W3 question below: does a Writer-settable payout
  instruction plus an on-demand payout strengthen the "payment account"
  characterisation of the Writer-owed balance (reg. 2(1) PSRs), and if so
  should the on-demand endpoint be dropped?

**Acceptance.** The letter is sent with W1's detection + runbook and the W7
audit done, so its factual assertions are true on the day it goes. The wired
admin action may trail (parallel lane).

### W1 — A negative reading tab becomes an incident, not a legal state

**Today.** `settlement.ts:1084` and `:1572` deliberately permit
`reading_tabs.balance_pence` to go negative, with the comment that negative
means the reader is in credit. Under Leg A/Leg B this is the wrong default: a
reader-redeemable balance created on receipt of funds is a claim on VNL,
redeemable against reads, i.e. exactly the shape HJ §6 concludes we do *not*
have — on the assumption it cannot arise. The August 2026 double-charge went
unalerted precisely because the state was treated as legal. (Rev. 4: the code
itself already narrates that incident — the comment block above
`resumePendingSettlements` records the −£14 tab and closes "which is why
nothing alerted". Two further unclamped negative-capable write sites exist
outside settlement.ts — the dispute-stake debit in
`gateway/src/routes/upstream-edges.ts` and the credit-back in
`gateway/src/routes/articles/subscription-convert.ts`. Detection watches the
*column*, so both are covered automatically, but the runbook should name all
three paths.)

**Change.**
- Keep the arithmetic. Do **not** clamp at zero inside the reversal path — a
  clamp loses pennies and breaks the ledger's to-the-penny guarantee. The
  reversal legs at `:1572` stay as they are.
- Add detection: `services/reconcile-ledger.ts` gains a distinct mismatch class
  for `reading_tabs.balance_pence < 0`, alerting per-account with the amount
  and the settlement that produced it. (Note: today a negative tab that
  *agrees* with the ledger passes reconciliation silently — the B1 invariant
  only compares the two. That is the gap.) **This check must ALERT and never
  halt, and the file cannot express that today**: every `CRITICAL_CHECKS`
  entry halts all payouts on any violation. A negative tab that agrees with
  its ledger is an incident, not books-divergence — freezing every Writer's
  payout for one Reader's credit would itself be a ¶7.14.6 discretion. **The
  severity tier is the only real option — the alternative is struck**
  (rev. 4): `runAllocationReconcile` short-circuits whenever
  `allocatedFundsEnabled()` is false, so a check riding
  `allocation-reconcile.ts` is a silent no-op exactly while
  `STRIPE_ALLOCATED_FUNDS` ships dark — i.e. on the day the package goes.
  The tier is small: `Check` is `{name, description, sql}`, and the change
  touches the interface, the five check literals, the violation loop, and the
  halt gate — one file, ~30 lines.
- Add a defined response: the runbook resolution is **refund the credit to the
  reader's card**, never "let it be spent down against future reads". The
  runbook — detection plus the documented manual Stripe refund — is the part
  that gates W0.
- **The wired admin action is a full new Stripe money path, not a button**
  (parallel lane, does not gate W0). No refund-issuing path exists in any
  service — production refunds today are inbound webhook events only (the
  only `refunds.create` calls in the repo are the sandbox segregation probe
  scripts). Building it takes
  the whole money-moving-create discipline (`CLAUDE.md` Stripe invariant):
  three-phase reserve → create → confirm with a row-stable idempotency key and
  the terminal/ambiguous split (`charge-errors.ts`), resume-sweep coverage, a
  new ledger trigger type (e.g. `credit_refund`) posted via `applyLedgerDelta`
  to bring the tab from negative to zero, that trigger type added to the
  `ledger_reader_balance` view (migration + `schema.sql` regen — omit it and
  B1 parity halts payouts on the action's first use; parity compares the view
  itself, so the halt is guaranteed and platform-wide, recurring every run —
  the view migration lands WITH the action, never after), a `ledger_orphans`
  branch, and `check-ledger-adjacency` registration (convention, not
  enforcement — Guard 1 is per-file floors and Guard 3 keys on payout-table
  INSERTs, so an unregistered pure-ledger site stays green; register it
  anyway). The plumbing home exists
  (gateway admin proxy → payment-service internal `x-internal-token`
  endpoint), and the `charge.refunded` webhook already posts the
  `allocated_draws` refund draw, so segregation accounting comes free.
- Do **not** add a DB `CHECK` constraint — it would abort a legitimate
  multi-leg reversal mid-transaction.

**SHIPPED 2026-08-06 — detection + runbook (the part that gates W0).**
`reconcile-ledger.ts` gained the severity tier (`Check.severity: 'halt' |
'alert'`, `ReconcileResult.haltRequired`, and an enforcement path that halts
only on halting classes while alert-tier violations log under their **own**
marker, `alert: <check name>`), plus the `negative_reader_tab` check
(`NEGATIVE_READER_TAB_SQL`, exported as its one home). Violations now carry
`truncated`, so a capped sample reports `20+` rather than reading as a total —
the alert payload IS the response for an alert-tier check, and a silent
truncation would read as "that's all of them". Behaviour is pinned twice:
severity/marker/truncation against a scripted client
(`tests/ledger-reconcile.test.ts`), and the detector itself against real
Postgres (`tests/negative-reader-tab-integration.test.ts`) — the DB test's
control is the shipped `reader_balance_parity` predicate run over the same
synthetic double-settlement and asserted **clean**, which is the silence the
August incident happened in. Every assertion was mutation-checked. Runbook:
`docs/runbooks/reader-tab-credit.md`; alert marker documented in
`DEPLOYMENT.md`.

**Two findings from building it, both material to W0:**

- **The double-charge cause resolves through the EXISTING webhook, not the
  unbuilt admin action.** A **full** Stripe refund of the duplicate charge fires
  `charge.refunded` → `reverseSettlement`, which restores the debt via
  `applyLedgerDelta` and rolls the reads back to `accrued`. So the commonest
  cause has a complete manual resolution today, and the runbook documents it.
  The admin action is still needed for a *residual* credit (no single full
  charge to refund) — a **partial** refund is not a resolution, because the
  webhook logs `manual_review_required` and skips the unwind, leaving the reader
  with the credit *and* the money. Side effect to expect: `reverseSettlement`
  sets `card_action_required_at`, so a platform-initiated correction asks the
  reader to re-attach their card.
- **DILEMMA — one negative-tab producer is by design, and it is a Reader-funded
  credit.** `gateway/src/routes/articles/subscription-convert.ts` credits the
  reader's month-to-date spend back to the tab (`min(spend, subscription
  price)`) with **no offsetting tab debit** — the subscription's first month is
  logged to `subscription_events` only — and its spend query sums
  `read_events.amount_pence` **regardless of state**, so it counts reads the
  reader has already *settled*. A reader who settles mid-month and then converts
  is taken below zero by construction, holding a credit they funded, redeemable
  against future reads. That is the instrument §4 rule 4 bans, reached through a
  route nobody classed as one, and it makes W1's premise — a negative tab
  "cannot arise" legitimately — **untrue as built**. It is not an operator
  error and the runbook explicitly refuses to "fix" it. Two consequences: the
  alert will fire on ordinary business until this is resolved (so the resolution
  cannot wait for a quiet week), and **W0's letter must not assert that a
  negative tab is always an incident** while this route ships. Options, in
  ascending cost: (i) cap the credit at the tab's outstanding balance (kills the
  credit, keeps the conversion, one line — but silently shrinks the benefit the
  reader was offered); (ii) restrict the spend query to unsettled reads (means
  what it says: convert only what you still owe); (iii) debit the first month's
  `subPrice` to the tab as `subscription_charge` so the conversion nets to zero
  (the shape the renewal path already uses via `logSubscriptionCharge`). (iii)
  looks right and is the only one that leaves the reader's offer intact, but it
  changes what conversion *means* commercially — an owner decision, not a code
  cleanup. Until then the runbook escalates cause B rather than refunding it.

**Acceptance.** For W0: a synthetic double-settlement produces (a) a negative
tab and (b) an alert naming the account and settlement, **with no other
account's payouts frozen by it**, and the runbook names the outward refund as
the only resolution. For the parallel-lane action: (c) the admin action
discharges whatever credit **remains at the moment it runs**. "Remains" is
deliberate: the tab arithmetic nets future reads against a negative balance
automatically (accruals move it toward zero; settlement only fires at
+threshold), so some incidental spend-down in the incident window is
unavoidable without freezing the tab. The enforceable criterion is that no
path **deliberately offers** the credit for spending — no wallet, no "credit
applied" copy, no gate that consults it.

**Trap.** Someone will propose making the credit spendable because it is
friendlier. It is friendlier and it is a stored-value instrument. Refuse and
point here.

### W2 — Allocation coverage becomes a measured number, never an adjective

**Today.** `lib/stripe-client.ts` `ALLOCATION_ELIGIBLE_CARD_BRANDS` is
default-deny (visa, amex, discover, diners), and `allocatedFundsParam()`
returns `{}` for an ineligible or unreadable brand, so the charge succeeds
**unallocated** and its earnings route to the residual. That default-deny is
correct and must not be weakened — asking for allocation on an ineligible brand
500s and wedges the reader's tab permanently, per that file's own measured
note.

But an unallocated charge is a charge where VNL really does hold Writers' money
in its general balance. **Coverage is therefore the regulatory number**, and
with the Mastercard bug outstanding it is materially below 100%.

**Change.**
- Surface a rolling coverage metric — allocated pence ÷ settled pence over 30
  days, and the count of unallocated settlements. **This is a NEW charge-side
  query over `tab_settlements`, not a re-surfacing of `measureResidualShare`**
  (rev. 4): the existing residual metric is payout-side (transfer funding mix
  over `payout_transfers`) — a different number, not derivable from this one.
  The charge-side columns exist and are indexed (no migration). The crux is
  `allocated_pence`'s tri-state — NULL = never synced, 0 = measured-zero — so
  the unallocated predicate is `allocation_synced_at IS NOT NULL AND
  allocated_pence = 0`, never a bare `IS NULL`. Two more facts: the metric is
  **implementable now but measurable only post-flip** (`syncAllocations`
  no-ops while `STRIPE_ALLOCATED_FUNDS=0`, so every row is NULL today — an
  empty denominator, not "low coverage"; the panel must say "no measured
  settlements yet", never a fake 0%); and **no card brand is stored in the
  DB**, so uncovered settlements cannot be attributed to Mastercard
  retrospectively.
- **There is no admin ledger view to put it in** (rev. 4): the dashboard has
  four stage panels and a passive `payouts_halted` banner; allocation-reconcile
  reports to logs alone (its own header calls itself "the only visibility
  funds segregation has"). W2 builds a small coverage/segregation panel on
  `/admin/dashboard/overview` — gateway proxy → payment-service internal
  endpoint, the existing pattern.
- Record the intended end state here so it isn't rediscovered: **once Stripe
  fixes the Mastercard allocation 500** (attack order 0b — tracked live in
  `CONSOLIDATED-TODO.md`; fullest statement in
  `FUNDS-SEGREGATION-INTEGRATION.md`), the decision to take is whether to gate
  ineligible brands at *card-add* time rather than charging them unallocated.
  Mechanics (rev. 4): the gate can only live at gateway `connect-card` — at
  `setupIntents.create` no card exists yet; at the `setupIntents.retrieve` an
  `{expand: ["payment_method"]}` yields the brand at no extra API call (the
  same trick settlement's `resolveDefaultPaymentMethod` uses), and the reader
  is present. Two prerequisites: `ALLOCATION_ELIGIBLE_CARD_BRANDS` moves to
  `shared/` (the gateway has no payment-service dependency), and the gateway's
  Stripe client stays off the preview API version (its exclusion is
  deliberate — the gate must not drag it on). Gating at add-time is the only
  way to reach full coverage without wedging tabs, because the failure must be
  surfaced while the reader is present. It is blocked on Stripe, not on
  appetite. Refusing Mastercard today is not commercially survivable and we are
  not pretending otherwise.

**Acceptance.** The coverage figure is queryable and appears in the new admin
coverage panel, reading honestly pre-flip ("no measured settlements yet",
never 0%). No code comment, doc, or UI string asserts ring-fencing without it.

### W3 — Payout timing becomes the Writer's standing instruction (HJ ¶7.14.5)

**Today.** `writer_payout_threshold_pence` and
`publication_payout_threshold_pence` live in `platform_config`; cadence is the
02:30 worker (`workers/payout.ts`). Both are VNL's choice about when a Writer's
money moves — squarely ¶7.14.5.

**Rev. 4 finding: the publication key is a DEAD DIAL** — seeded and editable
in the admin config UI, loaded by nothing; the publication cycle's eligibility
binds `writerPayoutThresholdPence`. Editing it changes nothing — exactly the
"dial with no reader" class `CLAUDE.md` bans. W3 either revives it as the
publication default or drops it; revive is the natural move, since this item
touches every read site anyway.

**Trade-off, recorded before the change.** Converting timing into the
Writer's instruction helps ¶7.14.5 but pulls against the money-remittance
characterisation: a balance the holder can instruct payments from on demand
looks more like a **payment account** (reg. 2(1) PSRs — "used for the
execution of payment transactions"), and remittance requires that no payment
account exists. The threshold/cadence setting is a standing instruction about
*when the platform pays what it owes* and is safe. The on-demand endpoint is
the sharper edge. So:

**Change (parallel lane).**
- Migration: `accounts.payout_threshold_pence integer NULL` and
  `accounts.payout_cadence` (enum: `daily` | `weekly` | `monthly`). Same for
  `publications`.
- `services/payout.ts` reads the per-account value, falling back to
  `platform_config`. The config value becomes a **default, never an override**.
- Site inventory (rev. 4 — three production sites, all in
  `services/payout.ts`): writer **eligibility** (already joins `accounts`; a
  one-line `COALESCE`); the writer **pack floor** in
  `reserveWriterPayout`/`packWriterPayout` (thread the per-account value into
  the pack config — the account row is already locked `FOR UPDATE` there, so
  select the column under that lock); publication **eligibility** (no join to
  hang a value on — add `JOIN publications`). **The eligibility query and the
  pack floor must read the SAME per-account value**: if they disagree, a
  writer is claimed and rolled back every cycle, forever, and nothing errors.
- Cadence needs **no scheduling work** (rev. 4): the worker already fires
  daily and calls all three cycles; per-account `daily|weekly|monthly` is a
  predicate in the eligibility queries — "is today a due day". The real cost
  is a last-paid anchor, which no table carries: per the recurring-boundary
  invariant it is a **stored anchor column**, never `previous + step` and not
  re-derived per cycle from `MAX(triggered_at)`. Note also the manual
  `POST /payout-cycle` runs the writer cycle only — publication/tribute have
  no manual trigger.
- Writer-settable in the editorial dashboard, with the setting worded as an
  instruction ("Pay me when I'm owed at least £X") rather than a platform
  policy notice.

**Change (gated on W0(g)).**
- The on-demand **"pay me now"** — same reserve → transfer → confirm path for
  a single account, subject to Stripe's minimum and `isConnectPayable` — is
  **not built** until counsel answers W0(g). If the answer is that it
  strengthens the payment-account reading, it is dropped and this section
  updated to say so.

**Acceptance.** A Writer who sets £5 daily is paid on those terms without any
platform-side change. `platform_config` is consulted only where the account has
no value set.

**Trap.** If "pay me now" is ever built, it must not bypass the halt (W4) or
the reconciliation gate. An instruction about *timing* is not an instruction
to pay against books that don't balance.

### W4 — Narrow the global payout halt (HJ ¶7.14.6 — the largest residual)

**Today.** `lib/payout-halt.ts` sets a durable `payouts_halted` flag on any
ledger-reconciliation divergence, and all three cycles refuse to move anything
until a human clears it. The reasoning in that file is sound and the control
stays. But as built it is VNL exercising discretion over *every* Writer's money
on the strength of a divergence that may implicate one — the clearest surviving
¶7.14.6 marker.

**Change.**
- Halt at the granularity the checks can **honestly attribute** — which is
  narrower than "which accounts diverge". `reconcile-ledger.ts` identifies
  violating *rows*, but the accounts it names are mostly READERS: the file
  deliberately scopes to reader-tab checks (its own header records why the
  payout side was excluded as expected-nonzero), so `reader_balance_parity` —
  the commonest class — names a Reader, not a Writer whose payouts should
  halt, and mapping it to Writers via `read_events` would be over-broad by
  design. **Rev. 4 correction: the only attributable class is
  `ledger_orphans`, and only its payout-side branches.** `dispute_stake` comes
  OFF the list — it is a reader-side trigger (counted by
  `ledger_reader_balance`; the stake debits the disputant's reading tab), so
  halting that account's payouts is the same reader→Writer category error this
  item refuses for `reader_balance_parity`. And `ledger_orphans` mixes
  reader-side triggers into the same check, so attribution branches on
  `trigger_type` (writer_payout / publication_split / tribute_*), never on the
  check name; its SELECT must gain `le.account_id` — the only recoverable
  handle, since the orphan's source row is by definition gone. So: per-account
  halt for the attributable branches; the global flag
  keeps catching parity breaks and the halt record says so. If ¶7.14.6 needs
  more, the follow-on is writer-side *attributable* checks (alert-only, per
  the reconcile file's own expected-nonzero warning), never a reader→Writer
  taint walk.
- **Attribution runs uncapped** (rev. 4). Every check's SQL carries
  `SAMPLE_LIMIT` (20) and the runner stores a 5-row sample — deliberately,
  because *existence* is all a global halt needs. Per-account halting from a
  truncated payload silently pays the 21st diverging account. Rule: the
  attribution query for a halting class runs without the cap; if a bound is
  ever kept, a truncated result falls back to the global halt, never a
  partial per-account one.
- Storage: `payouts_halted_accounts` is a small **table** (account_id,
  mismatch_class, reason, created_at) — a set does not fit `platform_config`'s
  one-key/one-value shape, and the table is the natural home for the
  mismatch-class-not-free-text requirement. The global flag stays where it is.
  The **writer and tribute** cycle-start gates become per-account exclusions
  in their eligibility queries (both already join `accounts`); the global
  check is retained. **The publication cycle cannot do this** (rev. 4): its
  eligibility query never touches an account — recipients resolve per split
  at transfer time — so the exclusion lands beside the existing not-payable
  `continue` in `processPublicationSplits` (which the resume path also routes
  through). That changes the semantics, and one interaction must be resolved
  before building: an excluded member's split stays `pending` inside an
  otherwise-completed pool, and the parent completes on "no split PENDING" —
  **a permanently halted member would wedge the parent forever**. Either a
  halted split counts like a failed one for parent completion (keeping its
  claim for manual re-pay, the existing failed-split shape), or the exclusion
  flips the split to a distinct non-pending state.
- Bound it: a halt older than a configured age escalates. A halt that is never
  cleared is indistinguishable from a policy of not paying. Nothing acts on
  halt age today (the banner displays it; no job compares it), and the failure
  is already on the record: dev sat halted for a fortnight, silently, from
  2026-07-17 — every payout cycle a no-op with nothing wrong with the payout
  code (`scripts/backfill-seed-opening-balances.ts` header).

**Acceptance.** A divergence in an attributable class (an orphaned
writer_payout / publication_split / tribute row) halts that account's payouts
and nobody else's; a global halt names the class that could not be attributed.
(Recorded honestly: "a divergence confined to one Writer's ledger" is not yet
an observable event — no `CRITICAL_CHECKS` entry examines a Writer's ledger at
all. That stronger acceptance becomes testable only if the writer-side checks
above are added.)

**Trap.** Do not add a "resume anyway" that skips reconciliation. First-writer-
wins on the halt reason stays.

### W5 — Publication splits: record the mandate (HJ ¶7.14.2)

**Today.** `publication_members.revenue_share_bps` is set by members holding
`can_manage_finances` — so VNL is *already* executing a member decision rather
than choosing splits, which is the right shape. What's missing is evidence: at
payout time there is no immutable record of which split each member agreed to.

**Change.** Version the splits — an append-only `publication_split_versions`
(publication, bps map, effective_from, set_by) plus per-member acknowledgement
rows. The version is stamped on **`publication_payouts` (the parent) by the
pool cycle that computes the splits** — not per child in
`services/payout-children.ts`, which executes splits already fixed. Note the
*executed* split is already evidenced (`publication_payout_splits.share_bps`
records what each payout actually paid); this item adds **mandate** evidence
only — the version the members agreed to, tied to the payout that ran under
it. A payout against a version a member never acknowledged still runs —
the acknowledgement is evidence of mandate, not a payment gate; blocking a
member's money on their own inaction would itself be a ¶7.14.6 discretion.
Surface unacknowledged versions in the admin view instead.

**Rev. 4 scoping — four facts to design around.** (1) **The mandate is bigger
than the standing bps map**: per-article overrides in
`publication_article_shares` (flat fees + bps) are first-class split inputs,
and their *ordering* is load-bearing when the pool is short — a version
capturing only member bps is half the evidence; the version must fix both
halves, order included, to be reproducible. (2) **A second write path
bypasses the finance permission**: `PATCH /publications/:id/members/:memberId`
(gated `can_manage_members`) writes `revenue_share_bps` via its fieldMap — it
takes the same `pub_shares` lock and Σ ≤ 10000 guard, so concurrency holds,
but the *mandate* story doesn't. Tighten it (move the field behind
`can_manage_finances`) or a version's `set_by` can name someone with no
finance mandate. (3) The parent `publication_payouts` row is INSERTed before
the splits are computed and DELETEd when nothing was claimed — the version
stamp is nullable-then-patched, or minted only after the claim survives.
(4) Executed `share_bps` legitimately diverges from the mandated bps (the
10000 clamps clip whoever sorts last) — the admin view expects a non-zero
version-vs-executed diff and never "repairs" it.

**Acceptance.** Every publication payout row names a split version, and that
version names the members who assented to it (or shows assent outstanding).

### W6 — Tribute stays off, and the flag says why

Redirecting a slice of one Writer's earnings to third parties who have no
relationship with the paying Reader is the clearest money-remittance shape in
the tree (HJ ¶3.32–3.35). Under a Platform stance it does not ship without its
own advice.

**Change.** A guard comment at the tribute cycle entry point
(`runTributePayoutCycle`) and the worker call, stating that the block is a
**perimeter** decision, not an incomplete feature — so a future session
doesn't switch it on during a flag cleanup. **At the flag itself this is a
REWRITE, not an addition** (rev. 4): `shared/src/lib/env.ts`'s comment still
gives the pre-Phase-3 settlement-apportionment question as the reason — a
gate that resolved in June — which would mislead exactly the cleanup session
this item defends against. Cross-reference
`UPSTREAM-EDGES-TRIBUTE-COMPLIANCE.md`.

**SHIPPED 2026-08-06.** All three sites carry the perimeter reason:
`shared/src/lib/env.ts::tributesEnabled` (rewritten — the stale
settlement-apportionment reason removed, with a note saying so, because a stale
reason on a live brake is how a brake gets released), the cycle entry point
`runTributePayoutCycle` in `payment-service/src/services/payout.ts`, and the
worker call in `payment-service/src/workers/payout.ts`. Each says the same
thing: the cycle is complete and tested, and it is off for a legal reason, not
an engineering one.

### W7 — Don't contradict the trust counsel will declare (HJ ¶7.10.3)

The highest-value single item on the whole list is contractual — the trust
declaration is being requested in W0(c). Code cannot declare it. Code can
avoid making it untrue, and the audit half of this item **gates the W0
package**.

**Change — audit (critical path), then fix anything found.**
- Confirm no path pays VNL out of, or nets a VNL liability against, the
  Writer-owed pool other than the disclosed 8%.
- Rename the residual pool and its comments so it reads as what it is: **money
  owed to Writers whose charge failed allocation**, not platform money that
  happens to be earmarked.
- Confirm that nothing treats the Writer-owed balance as available working
  capital — including in any future cash-flow, reserve, or fee-netting logic.

**Audit run 2026-08-05 (rev. 4) — findings recorded, fixes scoped:**
- **There is no residual pool object.** The residual is a funding mode
  (`payout_transfers.funding = 'platform_balance'`) plus a derived metric
  (`measureResidualShare`) — no table, no balance. **No site spends it, nets
  against it, or treats it as working capital**: a residual child still pays
  the Writer, fee implicit. The prose comments are already careful ("the
  money is not wrong; the coverage is"); the *identifiers* are what read as
  platform money — the enum literal `platform_balance`, "the unsegregated
  residual", a "funded from platform balance" log line. Rename decision:
  code identifiers and comments are cheap; the DB enum literal itself is a
  migration + `schema.sql` regen. The proportionate cut is renaming the code
  names and letting the enum stand under a corrected column comment.
- **One true retention beyond the 8% exists**: the publication pooled-fee
  remainder (`remaining_pool_pence`) — disclosure now lives in W0(c). The
  grep acceptance below fails on it until the letter carries it; that is a
  disclosure fix, not a code fix.
- **Chargeback netting, recorded for the trail**: on a chargeback of a
  settlement carrying subscription charges the platform absorbs the writer
  leg rather than clawing it back, and keeps float it never disbursed
  (`chargeback.ts`). Platform-unfavourable direction — not a take — but it is
  a platform-vs-Writer netting decision the trust audit records.
- **User copy is clean**: a money-context sweep of `web/` for "segregated /
  ring-fenced / protected / on trust / safeguard / escrow" found nothing (the
  trust-*graph* UI is the only lexical neighbour). §4.3 currently holds.

**Acceptance.** A grep for the pool's identifiers turns up no site where it is
treated as VNL's — after the rename, with the pooled-fee remainder carved out
as disclosed in W0(c).

### W8 — Fee mechanics: prefer the explicit form

With the flag off, the 8% is *implicit* — "the difference between what the
reader paid and what Writers get", with the platform not modelled as an
account. With segregation on, it is an explicit `application_fee_amount`
debited from allocated funds at transfer. Same economics; the explicit form is
preferred because it is **evidenced and bounded**: the fee is a named, fixed
claim taken at a defined moment, which is the posture the trust declaration
(W0(c)) needs — the disclosed 8% and nothing else leaves the Writer-owed pool.
(Do **not** cite HJ ¶1.8 for this: ¶1.8 described Stripe deducting and
forwarding in a destination-charge flow, and reading it as blessing our
SC&T fee mechanics is the §1.3 misreading.) Record here that the flag-on form
is the target and the implicit form is a transitional state, not a design
preference. Two rev. 4 precisions for any copy this feeds: the 8% is
`platform_fee_bps` (800), a live-editable operator dial — copy states "the
disclosed platform fee", never a hard-coded percentage as an invariant; and
what is implicit today is the fee's *movement*, not its amount —
`tab_settlements.platform_fee_pence` records it per settlement and the admin
revenue panel sums it.

### W9 — The only code Leg A needs (gated on W0)

**Do not start until counsel's terms come back.** Implementing the copy
without the underlying authority in the Writer Terms is worse than not doing
it: it asserts an agency we don't have.

When the terms exist:

- Purchase-point copy, receipts, and the reading-history/ledger views name the
  **Writer as seller** and all.haus as acting on the Writer's behalf.
- Receipts and the ledger view state, in whatever wording counsel approves,
  that payment to all.haus settles what the Reader owes for those reads —
  discharge-on-receipt is the pivot of the whole structure (§0) and the copy
  must carry it, not merely avoid contradicting it.
- Nothing in Reader-facing copy or Reader Terms describes all.haus as acting
  for, collecting for, or holding funds for the **Reader**. The exclusion is
  lost if we are agent for both sides of the same transaction.
- Statement descriptors and dispute-response text follow the same framing so
  far as Stripe permits (we remain the settlement merchant — see §2).

---

## 4. What must not be done

1. Do not clamp a negative tab silently (W1).
2. Do not weaken the AMBIGUOUS classification of Stripe 500s, or add ineligible
   brands to `ALLOCATION_ELIGIBLE_CARD_BRANDS` on inference. Default-deny stands.
3. Do not describe funds as "segregated", "ring-fenced", "protected" or "held on
   trust" in user copy, marketing, or docs until coverage is 100% (W2) **and**
   the Writer Terms say so (W0(c)/W7). Write the number, not the adjective.
4. Do not add any Reader-facing credit balance, wallet, top-up, prepay, gift
   balance, or transferable allowance. The £5 allowance is safe *because* it is
   not issued on receipt of funds; anything funded by the Reader is a different
   instrument (EMRs 2011, reg. 2).
5. Do not add any path that pays a third party out of the Writer-owed pool
   (W6).
6. Do not relitigate direct or destination charges, or per-Writer tabs (§1).
7. Do not cite HJ ¶9's conclusion as covering the current build (§1.3), and do
   not cite HJ ¶1.8 for the SC&T fee mechanics (W8).
8. Do not build the on-demand "pay me now" endpoint before W0(g) is answered
   (W3).
9. Do not write agent-framing copy before counsel's terms exist (W9), and do
   not move toward MoR or SPI/API except through the W0(e) ladder.

---

## 5. Where this leaves the score

Before: five of six ¶7.14 factors present; ¶7.10.3 and ¶7.10.4 answered against
us. After W1–W8 with segregation live: ¶7.14.1–4 substantially negated,
¶7.14.5 converted from discretion to mandate (on-demand element pending
W0(g)), ¶7.14.6 narrowed but surviving; ¶7.10.3 answerable once counsel
declares the trust (W0(c)); ¶7.10.4 much improved. ¶7.10.1 and ¶7.10.2
unchanged and unchangeable (§1.2) — survivable under Leg A via
discharge-on-receipt, which is what W0(a) exists to confirm.

Leg B alone is a defensible fallback, not a clean pass. The clean pass is
Leg A, and W0 is how we get a definitive answer on it in one cycle.

---

## 6. Out of scope for this ADR's code items

- **Consumer credit / the tab model.** In scope for the W0 *letter* (W0(d));
  out of scope for code here. The build is more credit-shaped than the
  original briefing described (deferred payment to £8, subscription charges
  accrued to the tab, disputed debt restored to the tab with collection
  paused). Separate ADR once counsel answers; README lists CCA sign-off as
  launch-blocking.
- Merchant of Record restructuring (HJ ¶7.27.1) — W0(e) ladder only.
- SPI/API authorisation (HJ ¶7.29–7.35) — W0(e) ladder only. Recorded reason
  for not pursuing now: application lead time and reg. 23 safeguarding +
  ongoing compliance load, unjustified while Leg A is live and volumes make it
  available later if needed.
- The Technical Service Provider exclusion. Doubly unreachable: the exclusion
  itself requires never entering into possession of the funds — SC&T fails
  that on its face — and HJ ¶7.22 lists five behavioural disqualifiers we
  meet. Spend nothing here.

## 7. Superseded: open questions

The four open questions in rev. 1 are withdrawn as questions. (1) and (2) are
now W0(a)/(b), reframed as confirmations of an adopted structure. (3) —
whether partial allocation coverage weakens the trust — is folded into W0(c)'s
drafting instruction (counsel drafts the trust over the *pool*, with
segregation as partial mechanism of performance and W2's coverage number
disclosed). (4) is W0(g).

# Payments: what to fix now, and the dilemmas that remain

**Status:** Draft for review, 2026-07-13. Derived from a close read of `payment-service/`, `key-service/`, the tribute compliance memo (`docs/adr/UPSTREAM-EDGES-TRIBUTE-COMPLIANCE.md`), and the gateway money routes.

**Framing.** The payment core is architecturally correct for its constraint set — a shared reading tab across many writers, settled via Stripe Connect *separate charges and transfers*, means the platform must keep its own books; no Stripe primitive absorbs that. The saga shape (reserve → Stripe call with stable idempotency key → complete → webhook confirm → reconcile sweep → resume-on-crash) is the standard pattern for coordinating Postgres with a non-transactional external system, and the code is unusually well-hardened for a solo codebase, with audit-annotated fixes (S1, F7, F8, F14, etc.) at exactly the failure modes that bite in production. The problems are not wrongness. They are **duplication**, **invariants held by discipline rather than construction**, **thin tests on money-adjacent features outside the core**, and **two unresolved regulatory forks** whose resolution the code cannot hedge.

Everything in Part 1 is worth doing regardless of how the forks in Part 2 resolve. That independence is the point: it is the work that is safe to start today.

---

## Part 1 — Fix now (decision-independent)

### 1.1 Collapse the four payout clones into one skeleton

`payout.ts` (2,457 lines) runs four near-identical saga flows — writer, publication (+ per-split legs), tribute, and the settlement flow in `settlement.ts` shares the same shape. Each has its own reserve / complete / confirm / reverse / resume / fail-terminal handlers; only the claim query, target table, and ledger trigger type differ. A bug fixed in one flow must be remembered in three other places, and the interleaving-safety reasoning (e.g. "while we hold the account lock, reads only ADD to platform_settled") is re-derived in comments per flow.

**Fix:** extract a parameterised `PayoutFlow` — strategy object supplying `claimRows()`, `netQuery()`, table names, trigger types — over a single shared skeleton. Keep the genuinely divergent logic (tribute child carves and swept returns, publication split-leg confirmation) inside the strategies. Expected reduction: ~1,500 lines to ~600, and every future hardening lands in all flows at once. This is also the cheapest insurance for Part 2: a segregation allocation step or a VAT leg gets written once, not four times.

**Effort:** days. **Risk:** low if done against the existing test suite (settlement, payout-math, ledger-parity, chargeback-reversal, transfer-reversal tests all exist and pass as the safety net).

### 1.2 Promote load-bearing comments to tested invariants

Several correctness arguments live only in prose: the confirm-path interleaving argument in `confirmSettlement`, the "stale-high-safe but never stale-low" peek reasoning in `reserveWriterPayout`, the no-clamp signed-delta rule ("column and ledger must move by the SAME signed delta"). If a future edit violates one, nothing fails until money diverges.

**Fix:** encode each as a test or a database constraint where possible — e.g. a parity check that `−SUM(ledger_entries) = reading_tabs.balance_pence` per account run as a scheduled reconciliation job (not just a test fixture), and property-style tests for the tribute telescoping conservation (`author + Σ retained == read_net`), which the audit-fixes doc says already has 8 conservation tests — extend the same treatment to settlement/read attribution.

### 1.3 Test the untested money-adjacent surfaces

Zero dedicated tests currently cover: **upstream-edges dispute stakes** (real £5 debits to reading tabs — the worst gap in the repo), **pledge drives** (tab debits on pledge fulfilment), **paid DMs**, **gift links**, and all of **traffology**. The core payment service is well tested; these peripheral routes touch the same tab and ledger with none of the same scrutiny.

**Fix, in priority order:** (1) dispute stake debit/refund round-trip including the withdraw path; (2) pledge fulfilment against the ledger parity check; (3) paid-DM pricing and charge path; (4) traffology aggregation math (lower stakes — analytics errors are silent rather than financial, but they inform writer decisions). Do (1) before un-darking disputes, without exception.

### 1.4 Write the chargeback-attribution constraint into policy now

The read↔settlement attribution is documented in `confirmSettlement` as approximate: a read accruing between a settlement's reservation and its confirmation advances under *this* settlement but is collected by the *next* one. Money conserves globally, but "exactly which reads did this disputed charge pay for" has no answer in principle. The chargeback planner (`chargeback.ts`) works with this, but the *policy* — what a reader is told, what writers see clawed back — must not promise per-charge precision that the data model cannot deliver.

**Fix:** one paragraph in the refund/dispute policy and in the writer-facing earnings documentation stating that reversals are computed against the settlement's read set, not a per-penny pairing. Do this before the first live dispute forces an improvised answer.

### 1.5 Pre-position the tax schema (empty)

There is currently zero VAT/tax/invoice code anywhere in the money path. Whatever Part 2 resolves to, retro-deriving tax positions from historical settlement rows is miserable; carrying empty columns costs nothing.

**Fix:** add nullable `vat_pence`, `vat_rate_bps`, `tax_point` to `tab_settlements`; add a `vat` trigger type to the ledger vocabulary; leave both unused. Additionally, document (and have counsel bless) the position that **one settlement = one consolidated supply** — the settlement is already the natural invoice unit, and per-read VAT at pence granularity is not viable under any model.

### 1.6 Concentrate the "merchant posture" surface

Fee computation is already centralised (`shared/src/lib/per-read-net.ts`, consolidated after being hand-duplicated across ~12 SQL sites — evidence of how this drifts). Receipt wording, refund-source policy, and seller-of-record language are not.

**Fix:** a single module owning receipt/invoice text, the refund-source rule, and any seller-identification strings, so that a Part-2 pivot is a strategy swap rather than a grep across three services.

### 1.7 Consider durable execution — decide now, even if the answer is no

Roughly half the payment-service code is crash/retry/webhook-ordering scaffolding (`resumePending*`, `reconcile*`, status-guarded transitions) that a durable-execution runtime (Temporal; or graphile-worker job-per-step, already in the stack for traffology) provides by construction. Pre-launch is the last cheap moment; post-launch this is open-heart surgery. The honest trade: a new infrastructure dependency and learning curve against permanently deleting the most bug-prone category of code. If the answer is no — defensible, given the scaffolding is written, tested, and audited — record the decision so it isn't relitigated mid-incident.

---

## Part 2 — Dilemmas that code cannot resolve

### 2.1 The fork: Stripe funds segregation vs Merchant of Record

The baseline posture (per the compliance memo): the platform charges plain PaymentIntents to its own Stripe balance and later transfers to connected accounts, staying outside PSR 2017 / EMR 2011 authorisation by relying on Stripe as the regulated EMI/PI that *possesses* the funds while the platform merely *instructs* allocation. The exposure is that "separate charges and transfers" undeniably gives the platform control over allocation, and PS25/12 (in force May 2026) tightened the safeguarding regime. Two exits:

**Branch A — Stripe approves funds segregation.** Mechanically cheap: one allocation call in `confirmSettlement` moving `net_to_writers_pence` into the segregated balance (the fee/net split already exists per settlement row), matching de-allocation in the reversal paths, and a treasury rule that refunds are funded from the unsegregated balance (segregated funds can move *only* to connected accounts). Days of code. Strongest possible answer to the baseline float question.

**Branch B — Merchant of Record.** The charging machinery survives unchanged (MoR also charges to the platform as seller; transfers become supplier payments). The missing layer is everything in 1.5/1.6: VAT computation and registration (UK now; OSS if EU readers materialise), invoice generation naming the platform as seller, and rewritten writer agreements (writers become suppliers). The known non-code costs: the platform becomes the seller of what writers publish — a materially worse libel posture — and takes on the VAT margin question.

**The trap between them:** these are not independent choices, because of 2.2.

### 2.2 Segregation contradicts the tribute characterisation

The tribute compliance memo's entire resolution rests on the held share being **the author's own deferred earnings under a revocable redirect instruction** — not third-party client money — held indistinguishably from every other unpaid writer earning, with *no ring-fencing* (memo condition 3: "Ring-fencing it would *assert* it is third-party money and defeat the characterisation"). Funds segregation ring-fences the entire writer-side float. Adopting Branch A therefore asserts, at the balance level, exactly what the tribute framing denies — and holding an earmark for a *non-consented* party inside a formally third-party balance is a worse look than the status quo, not a better one.

**Resolved (2026-07-13): Dial A adopted, unconditionally — not contingent on the Stripe answer.** Tributes move to **consent-gated, forward-only accrual**: no `tribute_accruals` row until the inspirer accepts (`live`); before that the share is a pure projection, and accrual runs forward only from consent. This eliminates the earmark-and-hold for a non-consenting party entirely, so the §2.2 contradiction dissolves *and* segregation (Branch A) would now compose cleanly with tributes if ever taken — the coupling that made this a trap is gone. The cost is the "the money was always waiting for you" cushion (a late accepter earns only forward), accepted. Counsel no longer needs the "does segregation change the characterisation of an unconsented share" question — there is no unconsented share held. What remains for counsel is only 2.3 (the baseline). Recorded in `docs/adr/UPSTREAM-EDGES-TRIBUTE-COMPLIANCE.md` › *Decision (2026-07-13)*; code rework tracked in `UPSTREAM-EDGES-BUILD-PLAN.md` › *Dial-A rework*.

### 2.3 The remaining human sign-off on the baseline

The prior engineering gates on `TRIBUTES_ENABLED` were cleared (copy audit done 2026-06-23; F3 reversal path built 2026-06-24), though the 2026-07-13 Dial-A ruling (§2.2) adds one more engineering gate — the consent-gated-accrual rework — before the flag flips. On the *compliance* side, one gate remains, and it is bigger than tributes: **residual checklist #1 — confirming that reliance on Stripe as the regulated PI/EMI keeps the platform itself outside PSR/EMR authorisation for the existing reading-tab float.** This is a platform-wide question tributes merely inherit. It should be settled independently of, and prior to, both the tribute flag and the Stripe decision, because it is the question both branches of 2.1 are answers to. If the answer is "the baseline is fine as-is," Branch A becomes belt-and-braces rather than necessity, and the MoR trade (libel + VAT for regulatory simplicity) may not be worth taking at all.

### 2.4 What not to do

Do not build speculative branches for both models. The current discipline — one posture, clean seams (fee/net split per settlement, centralised net formula, reversal paths), dark flags only for the genuinely contingent — is the right shape. Part 1 keeps the seams sharp; Part 2 is decided in a meeting, not a merge.

---

## Sequence

1. **This week:** 1.3(1) dispute-stake tests; 1.4 chargeback policy paragraph; 1.5 tax schema migration; put **only** the 2.3 baseline sign-off request to Harper James (the 2.2 question is closed — Dial A adopted 2026-07-13, so there is no unconsented-hold characterisation to ask about). Schedule the Dial-A code rework (`UPSTREAM-EDGES-BUILD-PLAN.md` › *Dial-A rework*) as the remaining engineering pre-flag gate.
2. **Before launch:** 1.1 clone collapse; 1.2 reconciliation job; 1.3(2–3); 1.6 merchant-posture module; 1.7 decision recorded.
3. **On the Stripe answer:** execute the pre-decided branch of 2.1, with the 2.2 tribute posture already agreed.

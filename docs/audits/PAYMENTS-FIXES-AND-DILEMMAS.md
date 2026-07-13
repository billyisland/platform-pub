# ADR: Payments — the fixes to ship and the dilemmas to decide

**Status:** Part 1 (§1.1–§1.7) accepted, ready to scope for build. Part 2: §2.2 decided (Dial A, 2026-07-13); §2.1 and §2.3 open, pending counsel.
**Date:** 2026-07-13 (rev. 2026-07-13 — §1.7 decided *no*; §1.1 revised to step-primitives; §2.2 code-vs-paper gate added; build sequence made scope-ready).
**Deciders:** Ed Lake.
**Related:** `docs/adr/UPSTREAM-EDGES-TRIBUTE-COMPLIANCE.md`, `docs/adr/UPSTREAM-EDGES-BUILD-PLAN.md` (Dial-A rework), `docs/audits/STRIPE-INTEGRATION-AUDIT-2026-06-25.md`, `docs/audits/allhaus-logic-economy-audit.md`.

Derived from a close read of `payment-service/`, `key-service/`, the tribute compliance memo, and the gateway money routes.

**Framing.** The payment core is architecturally correct for its constraint set — a shared reading tab across many writers, settled via Stripe Connect *separate charges and transfers*, means the platform must keep its own books; no Stripe primitive absorbs that. The saga shape (reserve → Stripe call with stable idempotency key → complete → webhook confirm → reconcile sweep → resume-on-crash) is the standard pattern for coordinating Postgres with a non-transactional external system, and the code is unusually well-hardened for a solo codebase, with audit-annotated fixes (S1, F7, F8, F14, etc.) at exactly the failure modes that bite in production. The problems are not wrongness. They are **duplication**, **invariants held by discipline rather than construction**, **thin tests on money-adjacent features outside the core**, and **two unresolved regulatory forks** whose resolution the code cannot hedge.

Everything in Part 1 is worth doing regardless of how the forks in Part 2 resolve. That independence is the point: it is the work that is safe to start today.

---

## Part 1 — Fix now (decision-independent)

### 1.1 Dedup the four sagas by step-primitives, not a whole-flow skeleton

`payout.ts` (2,457 lines) runs four near-identical saga flows — writer, publication (+ per-split legs), tribute, and the settlement flow in `settlement.ts` (1,185 lines) shares the same shape. Each has its own reserve / complete / confirm / reverse / resume / fail-terminal handlers; only the claim query, target table, and ledger trigger type differ. A bug fixed in one flow must be remembered in three other places, and the interleaving-safety reasoning is re-derived in comments per flow.

**Decision.** Do **NOT** build a parameterised whole-flow skeleton over the four sagas (the original proposal here, now rejected). A single spine over all four would need per-flow boolean flags — settlement is a *charge* saga with async webhook confirm + apportionment, the payouts are *synchronous transfer* sagas — and per-flow flags on a shared money spine are exactly where hidden divergence loses money. Instead: extract shared **step-primitives**, and keep all four flows as explicit, top-to-bottom sequences that call them. The *pattern* stays cloned per flow (which is the point — four readable clones of the industry-standard Stripe reserve→idempotent-call→confirm→reconcile pattern beat one bespoke abstraction over live money); only the *hazardous primitives* stop being cloned. See §1.7 for why the code is a faithful clone of the standard pattern rather than homemade jank, and why this is the chosen alternative to durable execution.

**Sequence — tests first, refactor second, tribute last.**

1. **Write a table-driven conformance battery against the CURRENT code, per flow.** These tests are mandatory regardless of the refactor — they are the drift-pinning suite that lets us keep running clones safely (they encode §1.2's invariants as executable checks). Cover at minimum:
   - crash between DB reserve and Stripe call → resume completes exactly once;
   - crash after Stripe call, before local complete → resume finds the existing object via the stable idempotency key, no duplicate;
   - terminal Stripe error → terminal failure state, correct ledger reversal;
   - ambiguous Stripe error → **NO rollback**, remains pending for resume (never roll back on ambiguous — that double-charges/double-pays);
   - webhook double-delivery / out-of-order delivery (settlement only);
   - **multi-leg crash (publication only): crash after leg 2 of 4 → resume completes legs 3–4 exactly once, legs 1–2 never re-paid;**
   - resume-sweep idempotency (running the sweep twice is a no-op);
   - ledger parity: `−SUM(ledger_entries) == balance` after every scenario;
   - same-signed-delta: column and ledger move by the same signed amount, no `GREATEST(0,…)` clamps.

   **Go/no-go gate, also in step 1:** verify all four flows take row locks in the same order (account → payout/settlement row). If they differ, **STOP and report** — that is a pre-existing deadlock bug to surface before any refactor line is written, not a refactor detail.

2. **Only once the battery is green, extract primitives — one flow at a time, each its own commit.** Candidate set (adjust to what the code actually repeats; don't force it):
   - **`applyLedgerDelta(...)` — the star of the exercise.** Writes the ledger row + the column update in one place, mechanically enforcing same-signed-delta / no-clamp. This converts §1.2's load-bearing comment into a *mechanism*. If only this primitive and the battery shipped, most of the value is captured.
   - **`executeStripeIdempotent(key, call, classifier)` — classify-and-signal ONLY.** Takes the explicit classifier (`isTerminalChargeError` vs the deliberately narrower `isTerminalTransferError` stay **separate and named** — that divergence is real, keep it visible). It makes the idempotent call, classifies terminal-vs-ambiguous, re-throws on ambiguous (so resume retries with the same key), and on terminal **signals back to the flow**. The flow does its own per-flow terminal cleanup (settlement: drop the pending-guard + flag `card_action_required_at`; payout: roll back claimed reads/accruals). The primitive must **not** own that cleanup, or it needs a flow flag.
   - **`statusGuardedTransition(client, table, id, from, to, extraSet?)`** — the `UPDATE … WHERE status = $from` pattern, returning whether it won.
   - ~~`resumeSweep(...)`~~ — **dropped from the set.** Its `completer` callback is the closest thing to the banned inversion of control, and the sweep loop itself is cheap, non-hazardous boilerplate (the hazard lives in the per-flow completer). Leave it cloned per flow unless it can stay a plain, flag-free function.

**Hard constraints.**
- **No boolean flags** on any primitive that encode "which flow am I in." If a primitive needs one, the extraction is wrong — leave that code in the flow.
- **No inversion of control:** primitives are plain functions the flow calls; the flow's reserve → call → complete → confirm sequence must remain readable top-to-bottom in one place per flow.
- Every primitive takes a `flowName` for log/error context; per-flow distinguishability of logs and stack traces must not regress.
- **Tribute goes LAST, after the Dial-A rework** (see §2.2). Dial A is a net deletion of the held/swept/returned path, so batterying + refactoring the current tribute flow now is refactoring code about to be deleted. Do writer → publication → settlement now; tribute's battery is written against the **post-Dial-A** shape, and its extraction lands after that rework.
- Settlement's apportionment logic (`confirmSettlement` read-claiming + fee split) is **out of scope** for this pass — do not touch it.
- Do not modify `charge-errors.ts`, `per-read-net.ts`, or `recordLedger` semantics; they are already the centralised hazardous core.

**Acceptance.**
- Conformance battery green before *and* after, per flow.
- Existing suite (settlement, payout-math, ledger-parity, chargeback, transfer-reversal) untouched and green.
- **Real criterion:** hazardous logic now lives in one tested place, and each flow still reads reserve → call → complete → confirm top-to-bottom in one file. "Net LOC down" / "no primitives file > ~200 lines" are smell-checks, **not** pass/fail gates — do not let the LOC number drive over-extraction.
- Update the candidate-primitive list above to what actually shipped once the work lands.

**Effort:** the battery is days and is the larger, more valuable half; the extraction is days on top, one flow per commit. **Risk:** low for the battery; low-to-moderate for the extraction, and only *low against the tribute flow's final (post-Dial-A) shape* — do not extract tribute against the current shape.

### 1.2 Promote load-bearing comments to tested invariants

Several correctness arguments live only in prose: the confirm-path interleaving argument in `confirmSettlement`, the "stale-high-safe but never stale-low" peek reasoning in `reserveWriterPayout`, the no-clamp signed-delta rule ("column and ledger must move by the SAME signed delta"). If a future edit violates one, nothing fails until money diverges.

**Fix:** encode each as a test or a database constraint where possible — e.g. a parity check that `−SUM(ledger_entries) = reading_tabs.balance_pence` per account run as a scheduled reconciliation job (not just a test fixture), and property-style tests for the tribute telescoping conservation (`author + Σ retained == read_net`), which the audit-fixes doc says already has 8 conservation tests — extend the same treatment to settlement/read attribution. **Note:** the §1.1 conformance battery *is* the executable form of several of these invariants; §1.2 is the superset (scheduled reconciliation job + the property tests the battery doesn't cover).

### 1.3 Test the untested money-adjacent surfaces

Zero dedicated tests currently cover: **upstream-edges dispute stakes** (real £5 debits to reading tabs — the worst gap in the repo; `DISPUTE_STAKE_PENCE = 500` → `reading_tabs.balance_pence`, `dispute_stake` ledger trigger), **pledge drives** (tab debits on pledge fulfilment), **paid DMs**, **gift links**, and all of **traffology**. The core payment service is well tested; these peripheral routes touch the same tab and ledger with none of the same scrutiny.

**Fix, in priority order:** (1) dispute stake debit/refund round-trip including the withdraw path; (2) pledge fulfilment against the ledger parity check; (3) paid-DM pricing and charge path; (4) traffology aggregation math (lower stakes — analytics errors are silent rather than financial, but they inform writer decisions). **Do (1) before un-darking disputes, without exception.**

### 1.4 Write the chargeback-attribution constraint into policy now

The read↔settlement attribution is documented in `confirmSettlement` as approximate: a read accruing between a settlement's reservation and its confirmation advances under *this* settlement but is collected by the *next* one. Money conserves globally, but "exactly which reads did this disputed charge pay for" has no answer in principle. The chargeback planner (`chargeback.ts`) works with this, but the *policy* — what a reader is told, what writers see clawed back — must not promise per-charge precision that the data model cannot deliver.

**Fix:** one paragraph in the refund/dispute policy and in the writer-facing earnings documentation stating that reversals are computed against the settlement's read set, not a per-penny pairing. Do this before the first live dispute forces an improvised answer.

### 1.5 Pre-position the tax schema (empty)

There is currently zero VAT/tax/invoice code anywhere in the money path (confirmed: `tab_settlements` has no tax columns; no `vat` ledger trigger type). Whatever Part 2 resolves to, retro-deriving tax positions from historical settlement rows is miserable; carrying empty columns is cheap.

**Fix:** add nullable `vat_pence`, `vat_rate_bps`, `tax_point` to `tab_settlements`; add a `vat` trigger type to the ledger vocabulary; leave both unused. (Mind the repo's schema discipline — regenerate `schema.sql`, re-append the `_migrations` seed, run the drift guard; unused columns are cheap but not free.) Additionally, document (and have counsel bless) the position that **one settlement = one consolidated supply** — the settlement is already the natural invoice unit, and per-read VAT at pence granularity is not viable under any model.

### 1.6 Concentrate the "merchant posture" surface

Fee computation is already centralised (`shared/src/lib/per-read-net.ts`, consolidated after being hand-duplicated across ~12 SQL sites — evidence of how this drifts). Receipt wording, refund-source policy, and seller-of-record language are not.

**Fix:** a single module owning receipt/invoice text, the refund-source rule, and any seller-identification strings, so that a Part-2 pivot is a strategy swap rather than a grep across three services.

### 1.7 Durable execution — decided: no (permanent)

Roughly half of `payment-service` is crash/retry/webhook-ordering scaffolding (`resumePending*`, `reconcile*`, status-guarded transitions) that a durable-execution runtime (Temporal; or graphile-worker job-per-step) provides by construction. This is the last cheap moment to consider replacing it; post-launch such a migration is open-heart surgery.

**Decision: no, permanently.** Reasons, so this is not relitigated mid-incident:

- **Temporal is the wrong weight class and a lock-in risk.** It is a distributed system (self-hosted server + its own backing DB, or paid Temporal Cloud) on the critical money path of a solo, pre-launch service — to orchestrate **four flows** that already work. Durable-execution engines earn their keep with *many* workflow types and a team to run the infra; they are battle-tested at Uber/Netflix scale, which is not our reference class. It fails "right-sized" and "another service with its own politics and jeopardy" is precisely the outcome to avoid.
- **graphile-worker-for-sagas is a lateral move, not the prize.** It is already in the stack (near-zero infra fear), but it is a *job queue, not a workflow engine*: it gives durable jobs, retries, and job-key idempotency, but not "resume at step 4 after a crash with local variables intact." Building sagas on it means hand-rolling state machines in our own tables — relocating the homemade code, not deleting it.
- **The real cost of either is re-earning the hardening.** The value of the current code is not its line count; it is the accumulated scar tissue (S1, F7, F8, the terminal-vs-ambiguous classifier, "never roll back on ambiguous"). Any migration resets that clock — every crash/retry/webhook invariant must be re-proven on the new engine.
- **Reframe, don't refactor.** The sagas are not homemade jank: they are a faithful hand-implementation of *the* canonical Stripe "separate charges and transfers" pattern (reserve → idempotent create → webhook confirm → reconcile sweep), with the genuinely hazardous parts already centralised (`charge-errors.ts`, `recordLedger`, `per-read-net.ts`). That is the battle-tested clone we want; it lives as our code only because the tab/ledger boundary is ours and no library owns it.

**The chosen alternative is §1.1** (step-primitives dedup) — capture the maintainability win *without* importing an engine or building a bespoke skeleton.

---

## Part 2 — Dilemmas that code cannot resolve

### 2.1 The fork: Stripe funds segregation vs Merchant of Record

The baseline posture (per the compliance memo): the platform charges plain PaymentIntents to its own Stripe balance and later transfers to connected accounts, staying outside PSR 2017 / EMR 2011 authorisation by relying on Stripe as the regulated EMI/PI that *possesses* the funds while the platform merely *instructs* allocation. The exposure is that "separate charges and transfers" undeniably gives the platform control over allocation, and PS25/12 (in force May 2026) tightened the safeguarding regime. Two exits:

**Branch A — Stripe approves funds segregation.** Mechanically cheap: one allocation call in `confirmSettlement` moving `net_to_writers_pence` into the segregated balance (the fee/net split already exists per settlement row), matching de-allocation in the reversal paths, and a treasury rule that refunds are funded from the unsegregated balance (segregated funds can move *only* to connected accounts). Days of code. Strongest possible answer to the baseline float question. **Hard ordering gate: must not ship before the Dial-A rework — see §2.2.**

**Branch B — Merchant of Record.** The charging machinery survives unchanged (MoR also charges to the platform as seller; transfers become supplier payments). The missing layer is everything in §1.5/§1.6: VAT computation and registration (UK now; OSS if EU readers materialise), invoice generation naming the platform as seller, and rewritten writer agreements (writers become suppliers). The known non-code costs: the platform becomes the seller of what writers publish and takes on the VAT margin question. **Caveat to confirm with counsel:** seller-of-record *for VAT* is not automatically publisher/seller-of-content *for defamation* — the "materially worse libel posture" claim is plausible but is itself a counsel question, not a settled fact.

**The trap between them:** these were not independent choices, because of §2.2 — a trap now defused by the Dial-A decision below.

### 2.2 Segregation vs the tribute characterisation — decided (Dial A), but not yet dissolved in code

The tribute compliance memo's original resolution rested on the held share being **the author's own deferred earnings under a revocable redirect instruction** — not third-party client money — held indistinguishably from every other unpaid writer earning, with *no ring-fencing* (memo condition 3: "Ring-fencing it would *assert* it is third-party money and defeat the characterisation"). Funds segregation ring-fences the entire writer-side float. Adopting Branch A would therefore have asserted, at the balance level, exactly what the tribute framing denied.

**Decided (2026-07-13): Dial A adopted, unconditionally.** Tributes move to **consent-gated, forward-only accrual**: no `tribute_accruals` row until the inspirer accepts (`live`); before that the share is a pure projection, and accrual runs forward only from consent. This eliminates the earmark-and-hold for a non-consenting party entirely, so the contradiction dissolves *and* Branch A would compose cleanly with tributes if ever taken. The cost is the "the money was always waiting for you" cushion (a late accepter earns only forward), accepted. Recorded in `docs/adr/UPSTREAM-EDGES-TRIBUTE-COMPLIANCE.md` › *Decision (2026-07-13)*.

**Gate — dissolved on paper, NOT yet in code.** The decision is made; the code is not changed. The schema still carries `tribute_accruals` with `state IN (held, released, paid, swept, returned, voided)` and the append-only protect trigger — i.e. the earmark-and-hold for a possibly-non-consenting party that this section says is gone *still exists in the data model*. Consequences for build scoping:

- **The Dial-A code rework is a prerequisite, not a footnote.** When this payments work is scoped for implementation, the Dial-A rework (`docs/adr/UPSTREAM-EDGES-BUILD-PLAN.md` › *Dial-A rework* — the net deletion of the held/swept/returned path) is an **explicit line item**, not assumed done. Until it ships, "resolved" here is provisional.
- **Hard ordering gate:** Branch A (§2.1) must **not** ship before the Dial-A rework, or it ring-fences a float that still contains the unconsented hold this section claims was eliminated — reintroducing the very contradiction.
- **Same fact, two angles:** this is why tribute goes last in §1.1. Do not refactor, segregate, or treat-as-resolved the tribute path until Dial-A has actually deleted the held-share machinery from the code.

### 2.3 The remaining human sign-off on the baseline

The prior engineering gates on `TRIBUTES_ENABLED` were cleared (copy audit done 2026-06-23; F3 reversal path built 2026-06-24), though the Dial-A ruling (§2.2) adds one more engineering gate — the consent-gated-accrual rework — before the flag flips. On the *compliance* side, one gate remains, and it is bigger than tributes: **residual checklist #1 — confirming that reliance on Stripe as the regulated PI/EMI keeps the platform itself outside PSR/EMR authorisation for the existing reading-tab float.** This is a platform-wide question tributes merely inherit. It should be settled independently of, and prior to, both the tribute flag and the Stripe decision, because it is the question both branches of §2.1 are answers to. If the answer is "the baseline is fine as-is," Branch A becomes belt-and-braces rather than necessity, and the MoR trade may not be worth taking at all.

### 2.4 What not to do

Do not build speculative branches for both models. The current discipline — one posture, clean seams (fee/net split per settlement, centralised net formula, reversal paths), dark flags only for the genuinely contingent — is the right shape. Part 1 keeps the seams sharp; Part 2 is decided in a meeting, not a merge.

---

## Build scope & sequence

Ready-to-scope ordering. Items marked **[build]** are code; **[decision]** are human/counsel sign-offs that gate code.

**Prerequisite (gates several items below):**
- **[build] Dial-A rework** (`UPSTREAM-EDGES-BUILD-PLAN.md` › *Dial-A rework*) — net deletion of the held/swept/returned tribute path. Blocks: §1.1 tribute-flow extraction, §2.1 Branch A, the `TRIBUTES_ENABLED` flip. Scope this first; it is a §2.2 prerequisite, not optional cleanup.

**This week (decision-independent, no prerequisite):**
1. **[build]** §1.3(1) — dispute-stake debit/refund/withdraw tests. *Before un-darking disputes.*
2. **[build]** §1.4 — chargeback-attribution policy paragraph.
3. **[build]** §1.5 — tax schema migration (empty columns + `vat` trigger type).
4. **[decision]** Put **only** the §2.3 baseline sign-off request to Harper James. The §2.2 question is closed (Dial A) — do not ask about an unconsented-hold characterisation; there isn't one. §2.1 waits on §2.3.

**Before launch:**
5. **[build]** §1.1 step 1 — conformance battery + lock-ordering gate, all four flows (tribute's battery written against the post-Dial-A shape).
6. **[build]** §1.1 step 2 — primitive extraction, one flow per commit, order **writer → publication → settlement → (tribute, after Dial-A)**. `applyLedgerDelta` first.
7. **[build]** §1.2 — scheduled reconciliation job + remaining property tests.
8. **[build]** §1.3(2–3) — pledge + paid-DM tests.
9. **[build]** §1.6 — merchant-posture module.

**On the compliance answers:**
10. **[decision → build]** Execute the pre-decided branch of §2.1 once §2.3 returns. Branch A only after the Dial-A rework has shipped (§2.2 hard gate). Branch B pulls §1.5/§1.6 from schema-stubs into live VAT/invoice code.

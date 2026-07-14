# ADR: Payments — the fixes to ship and the dilemmas to decide

**Status:** Part 1 (§1.1–§1.8) accepted, ready to scope for build. **Shipped so far:** item A (settlement lock-order fix, 2026-07-13); **§1.8 `applyLedgerDelta` + §1.3(1) dispute-stake tests (2026-07-14); §1.4 chargeback-attribution policy paragraph + §1.5 tax-schema migration 155 (2026-07-14); the Dial-A rework (§2.2 prerequisite — migration 156, 2026-07-14); §1.1 step 1 — the saga conformance battery for all four flows (2026-07-14).** The whole "this week (decision-independent)" build queue is shipped, and the scope-first prerequisite (Dial-A rework) is now done — so §2.2 is dissolved in code as well as on paper, and only §2.3 (counsel sign-off) remains this-week. On the "before launch" queue, §1.1 **step 1 (battery)** and **step 2 (primitive extraction: `executeStripeIdempotent` across all four flows; `statusGuardedTransition` assessed and not extracted)** are both shipped (2026-07-14), and **§1.2 shipped in full 2026-07-14** — its scheduled reconciliation job (alert + halt payouts on mismatch) *and* its superset half, the settlement/read-attribution conservation property tests (`payment-service/tests/settlement-attribution-conservation.test.ts`, 5 tests driving the real `confirmSettlement`); the next before-launch code items are §1.3(2)/(4) (pledge + traffology tests) and §1.6 (merchant-posture module). Part 2: §2.2 decided (Dial A, 2026-07-13) **and shipped**; §2.1 and §2.3 open, pending counsel.
**Date:** 2026-07-13 (rev. 2026-07-14 — Dial-A rework shipped (migration 156): held/swept/returned machinery deleted, settlement freezes `live`-only forward-only accruals, chargeback planner + payout cycles + display carves + reconcile simplified; earlier 2026-07-14 rev — §1.8 `applyLedgerDelta` across all 9 tab-debit sites + adjacency-tripwire Guard 2 rewrite + §1.3(1) dispute-stake round-trip tests; earlier 2026-07-13 rev — §1.7 decided *no*; §1.1 revised to step-primitives; §2.2 code-vs-paper gate added; build sequence made scope-ready; §1.8 split `applyLedgerDelta` out to the tab-debit sites and the lock-ordering gate promoted to a standalone item).
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

**Scope note.** This section covers the **saga control-flow** primitives only — the Stripe-call and status-transition machinery shared by the four flows. The ledger⇄column same-signed-delta mirror — the single most valuable primitive, and the only invariant here that has actually lost money — is **not** a saga concern: three of the four sagas are *transfer* flows that mutate no running-balance column, and most of the mirror's real call sites are plain tab debits *outside* these four flows. It is extracted separately and **earlier** as §1.8; do not gate it behind this refactor.

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

   **Go/no-go gate — now a standalone this-week item (see Build scope), not buried in this refactor:** verify all four flows take row locks in the same order (account → payout/settlement row). If they differ, **STOP and report** — that is a pre-existing deadlock bug to surface *before any refactor line is written*, and it is worth running on its own **even if the §1.1 refactor never happens**. It has no prerequisite and gates nothing; it is pure risk-surfacing, so it leads the queue.

2. **Only once the battery is green, extract primitives — one flow at a time, each its own commit.** Candidate set (adjust to what the code actually repeats; don't force it). The ledger-mirror primitive is deliberately **absent** here — it is §1.8, extracted separately and earlier, because most of its call sites are plain tab debits outside these four flows:
   - **`executeStripeIdempotent(flowName, key, call, classifier)` — classify-and-signal ONLY. ✅ SHIPPED 2026-07-14** (`payment-service/src/lib/stripe-idempotent.ts`). Takes the explicit classifier (`isTerminalChargeError` vs the deliberately narrower `isTerminalTransferError` stay **separate and named** — that divergence is real, kept visible: each call site passes the named function). It makes the idempotent call, classifies terminal-vs-ambiguous, re-throws on ambiguous (so resume retries with the same key; the ORIGINAL error is re-thrown unwrapped, preserving webhook/classifier matching + stack traces), and on terminal returns `{ ok:false, err }` to **signal back to the flow**. The flow does its own per-flow terminal cleanup (settlement: drop the pending-guard + flag `card_action_required_at`; payout: `fail*PayoutTerminal` roll back claimed reads/accruals). The primitive does **not** own that cleanup. All four flows routed through it (writer → settlement → publication → tribute, one commit each); ships with 8 unit tests + a co-located `stripeErrorCode(err, fallback)` leaf helper (the `code ?? type ?? fallback` idiom the four cleanups repeated). Full suite 151 green.
   - ~~**`statusGuardedTransition(client, table, id, from, to, extraSet?)`**~~ — **assessed, NOT extracted (2026-07-14).** The four `UPDATE … WHERE status='pending'` flips each carry *different* extra SET columns (`completed_at` / `stripe_transfer_id` / `stripe_payment_intent_id`) with positionally-threaded params, so a generic version needs a dynamic table name + a raw `extraSet` SQL fragment — a dynamic-SQL builder over money tables, whose param-order/injection surface is a *worse* hazard than the four readable clones. The genuinely repeated hazardous bit — gating the `recordLedger` post on the flip's `rowCount` so resume can't double-post — is a one-line `if (flipped.rowCount! > 0)` at each site; capturing it would need a `completer`-style callback, the banned inversion (same reason `resumeSweep` was dropped). Left cloned, per "don't force it" + the no-inversion constraint.
   - ~~`resumeSweep(...)`~~ — **dropped from the set.** Its `completer` callback is the closest thing to the banned inversion of control, and the sweep loop itself is cheap, non-hazardous boilerplate (the hazard lives in the per-flow completer). Leave it cloned per flow unless it can stay a plain, flag-free function.

**Hard constraints.**
- **No boolean flags** on any primitive that encode "which flow am I in." If a primitive needs one, the extraction is wrong — leave that code in the flow.
- **No primitive owns cross-step control flow or cleanup.** Primitives are leaf helpers the flow calls; the flow's reserve → call → complete → confirm sequence must remain readable top-to-bottom in one place per flow. (A primitive taking a `call` thunk or a `classifier` — as `executeStripeIdempotent` does — is fine: it classifies and signals *back*, it does not decide the next step or run the per-flow cleanup. The banned shape is a primitive that owns the sequencing or the terminal cleanup — e.g. `resumeSweep`'s `completer` callback, which is why it stays cloned below.)
- Every primitive takes a `flowName` for log/error context; per-flow distinguishability of logs and stack traces must not regress.
- **Tribute goes LAST, after the Dial-A rework** (see §2.2). Dial A is a net deletion of the held/swept/returned path, so batterying + refactoring the current tribute flow now is refactoring code about to be deleted. Do writer → settlement → publication now — prove the primitive against **both** saga shapes on single-object flows first (writer = one transfer / `isTerminalTransferError`; settlement = one charge / `isTerminalChargeError`), then apply the hardened primitive to the **multi-leg publication** flow last, whose partial-double-pay blast radius is the worst of the four. Tribute's battery is written against the **post-Dial-A** shape, and its extraction lands after that rework.
- Settlement's apportionment logic (`confirmSettlement` read-claiming + fee split) is **out of scope** for this pass — do not touch it.
- Do not modify `charge-errors.ts`, `per-read-net.ts`, or `recordLedger` semantics; they are already the centralised hazardous core.

**Acceptance.**
- Conformance battery green before *and* after, per flow.
- Existing suite (settlement, payout-math, ledger-parity, chargeback, transfer-reversal) untouched and green.
- **Real criterion:** hazardous logic now lives in one tested place, and each flow still reads reserve → call → complete → confirm top-to-bottom in one file. "Net LOC down" / "no primitives file > ~200 lines" are smell-checks, **not** pass/fail gates — do not let the LOC number drive over-extraction.
- Update the candidate-primitive list above to what actually shipped once the work lands. **Done (2026-07-14):** only `executeStripeIdempotent` shipped; `statusGuardedTransition` and `resumeSweep` are recorded above as assessed-and-not-extracted (dynamic-SQL hazard / banned inversion respectively). The Real criterion is met — the one hazardous-and-identical step (classify-and-signal) now lives in one tested place, and all four flows still read top-to-bottom.

**Effort:** the battery is days and is the larger, more valuable half; the extraction is days on top, one flow per commit. **Risk:** low for the battery; low-to-moderate for the extraction, and only *low against the tribute flow's final (post-Dial-A) shape* — do not extract tribute against the current shape.

### 1.2 Promote load-bearing comments to tested invariants

> **Scheduled reconciliation job SHIPPED 2026-07-14.** The reader-tab parity invariant is now an *enforced control*, not a manual psql script. New `payment-service/src/services/reconcile-ledger.ts::reconcileLedger` runs the five "must always be empty" reader-tab checks (B1 reader parity + A1/A3 magnitude + A7 dispute-stake integrity + A6 orphans — the exact halt-worthy subset of `scripts/reconcile-ledger.sql`, which stays the comprehensive human-run superset; the payout-side B2/A4/A5/A9/A10 checks are *expected-nonzero* and deliberately omitted so they can't false-halt). Response on ANY mismatch (the "action on mismatch" §1.2 demands): `runLedgerReconcileAndEnforce` **alerts** (`logger.fatal` structured event keyed `alert:'payouts_halted'`) **and halts payouts** — a durable `platform_config.payouts_halted` flag (`payment-service/src/lib/payout-halt.ts`; first-writer-wins so the original divergence reason survives) that the three payout cycles (`runPayoutCycle`/`runPublicationPayoutCycle`/`runTributePayoutCycle`) check at entry and no-op past. Settlement (charging readers) is deliberately NOT halted — the hazard is irreversible money leaving on unbalanced books. Scheduled 3×/day via `workers/ledger-reconcile.ts` (01:45/09:45/17:45 UTC; the 01:45 run gates the 02:30 payout). Manual controls: internal `POST /reconcile-ledger` (run + enforce), `GET /payouts/halt-status`, `POST /payouts/resume` (clear after a human reconciles). 7 tests (`tests/ledger-reconcile.test.ts`); suite 158 green.
>
> **Conservation property tests (the superset half) SHIPPED 2026-07-14.** `payment-service/tests/settlement-attribution-conservation.test.ts` (5 tests) drives the **real** `confirmSettlement` (incl. the real `applyLedgerDelta`/`recordLedger`) against a stateful in-memory model of `{tab_settlements, reading_tabs, read_events, ledger}` with numeric virtual timestamps, so the `read_at <= settled_at` advance window is deterministic. §1.1 forbids touching the apportionment SQL, so the properties are pinned by OBSERVATION: **P1** each accrued read reaches `platform_settled` under exactly one settlement (no double-settle/loss); **P2** `Σ(writer_accrual) == Σ perReadNet(gross)` over settled non-pub reads, once each (F2 publication reads advance but earn no personal accrual); **P3** reader parity `−Σ(reader ledger) == balance` after every confirm; **P4** the fee split conserves (`amount == fee + net`; per-row-then-floor keeps the dust with the writer); **P5** GLOBAL conservation under approximate attribution — reads attribute to the settlement whose time-window covers their `read_at`, and a settlement whose `amount_pence ≠ Σ(advanced read gross)` (subscription debt on the same tab) still drains to a balanced ledger with writers earning only their reads — plus a double-webhook idempotence check. Suite 163 green. **§1.2 is now fully shipped.**

Several correctness arguments live only in prose: the confirm-path interleaving argument in `confirmSettlement`, the "stale-high-safe but never stale-low" peek reasoning in `reserveWriterPayout`, the no-clamp signed-delta rule ("column and ledger must move by the SAME signed delta"). If a future edit violates one, nothing fails until money diverges.

**Fix:** encode each as a test or a database constraint where possible — e.g. a parity check that `−SUM(ledger_entries) = reading_tabs.balance_pence` per account run as a scheduled reconciliation job (not just a test fixture), and property-style tests for the tribute telescoping conservation (`author + Σ retained == read_net`), which the audit-fixes doc says already has 8 conservation tests — extend the same treatment to settlement/read attribution. **Note:** the §1.1 conformance battery *is* the executable form of several of these invariants; §1.2 is the superset (scheduled reconciliation job + the property tests the battery doesn't cover). The scheduled reconciliation job must specify its **action on mismatch** (alert + halt payouts, not detect-and-log — detection without a defined response is half a control). The no-clamp signed-delta invariant is the one case promoted from comment to *construction* rather than merely a test — see §1.8's `applyLedgerDelta`.

### 1.3 Test the untested money-adjacent surfaces

Zero dedicated tests currently cover: **upstream-edges dispute stakes** (real £5 debits to reading tabs — the worst gap in the repo; `DISPUTE_STAKE_PENCE = 500` → `reading_tabs.balance_pence`, `dispute_stake` ledger trigger), **pledge drives** (tab debits on pledge fulfilment), **paid DMs**, **gift links**, and all of **traffology**. The core payment service is well tested; these peripheral routes touch the same tab and ledger with none of the same scrutiny.

**Fix, in priority order:** (1) dispute stake debit/refund round-trip including the withdraw path; (2) pledge fulfilment against the ledger parity check; (3) paid-DM pricing and charge path; (4) traffology aggregation math (lower stakes — analytics errors are silent rather than financial, but they inform writer decisions). **Do (1) before un-darking disputes, without exception.**

> **(1) SHIPPED 2026-07-14** — `gateway/tests/dispute-stake.test.ts` (5 tests). Drives POST/DELETE `/disputes` through the REAL `applyLedgerDelta` against a stateful scripted client that tracks balance + every ledger entry, asserting `−SUM(ledger) == balance` across the full debit→withdraw round-trip, plus the three money guards: cited-author holds no stake, a duplicate (`ON CONFLICT` no-op) doesn't double-charge, and a second withdraw (guarded `UPDATE` claims 0 rows) refunds nothing. (2)/(3)/(4) still open — but per §B, (3) paid-DM is an *unbuilt feature* (no charge path) and gift links carry no ledger, so the real remaining §1.3 targets are only (2) pledge fulfilment and (4) traffology.

### 1.4 Write the chargeback-attribution constraint into policy now

The read↔settlement attribution is documented in `confirmSettlement` as approximate: a read accruing between a settlement's reservation and its confirmation advances under *this* settlement but is collected by the *next* one. Money conserves globally, but "exactly which reads did this disputed charge pay for" has no answer in principle. The chargeback planner (`chargeback.ts`) works with this, but the *policy* — what a reader is told, what writers see clawed back — must not promise per-charge precision that the data model cannot deliver.

**Fix:** one paragraph in the refund/dispute policy and in the writer-facing earnings documentation stating that reversals are computed against the settlement's read set, not a per-penny pairing. Do this before the first live dispute forces an improvised answer.

### 1.5 Pre-position the tax schema (empty)

> **SHIPPED 2026-07-14** — migration `155_tax_schema_prepositioning.sql` adds nullable `vat_pence int` / `vat_rate_bps int` / `tax_point timestamptz` to `tab_settlements` (unused); `vat` added to `LedgerTriggerType` (`shared/src/lib/ledger.ts`, TS union — no DB CHECK). `schema.sql` regenerated (columns + seed line 155), all four drift-guard checks green, migration applied to the dev DB. The one-settlement-=-one-consolidated-supply position is documented in the migration header; counsel blessing of it is folded into the §2.3 sign-off request.

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

### 1.8 Extract `applyLedgerDelta` across the tab-debit sites (the star, re-homed)

> **SHIPPED 2026-07-14.** `applyLedgerDelta` added to `shared/src/lib/ledger.ts`; all **9** call sites (§C inventory) routed through it — accrual (recordGatePass + convert loop), settlement confirm + reverse, subscription charge, subscription-convert credit, pledge fulfilment, dispute stake debit + refund. The primitive UPSERTS the tab by `reader_id` (create-or-update, sites 7–9), takes `deltaPence` = the signed **column** delta and posts the mirror ledger entry at **−deltaPence** (the reader-tab convention `balance == −SUM`; the sign is derived, not passed — a caller cannot pass a mismatched pair), never clamps, and takes no `FOR UPDATE` (confirmSettlement keeps its own prior lock for the confirm↔reverse ordering). Returns `{ ledgerId, balancePence, tabId }` (site 8 persists `ledgerId`; site 5 branches on `balancePence`). Callers posting a SECOND non-tab entry (subscription `subscription_earning`) keep that as a plain `recordLedger`. reverseSettlement's reader `tab_settlement_reversal` entry moved into the applyLedgerDelta call and is filtered out of the writer/tribute-leg loop. **Adjacency tripwire rewritten** (`scripts/check-ledger-adjacency.sh`): Guard 1 now counts both funnels; new **Guard 2** allows the raw-balance-write marker ONLY in `shared/src/lib/ledger.ts` and flags any bypass; Guard 3 is the payout-INSERT scan. Tests: 6 new `applyLedgerDelta` unit tests (mirror/no-clamp/upsert/touch, `payment-service/tests/ledger.test.ts`); `settlement-ledger-parity.test.ts` reworked to assert the confirm→applyLedgerDelta delta; writer-accrual + parity mocks updated. Typecheck + all 116 payment-service / 325 gateway tests green.

`recordLedger` inserts the ledger row *only*; every mutation of `reading_tabs.balance_pence` is a **separate** SQL statement at the call site, and the two are kept in lockstep — same signed delta, no clamp — by a **comment**, not a mechanism. This is the single invariant that has actually lost money here: all three 2026-06-20 HIGH findings (settlement `GREATEST(0,…)`, subscription credit-back, pledge non-upsert) were a column and its mirror ledger entry drifting apart. The primitive that fixes this is `applyLedgerDelta` — and it was mis-scoped in the original §1.1, which filed it under a saga refactor it doesn't belong to.

**Why it is NOT a saga primitive.** Three of §1.1's four sagas are *transfer* flows: they post `+amount` payout entries with a `NULL` platform counterparty and mutate **no** running-balance column (writer/publication earnings are `SUM()` views). The column⇄ledger mirror hazard exists only where a real balance moves — and those sites are overwhelmingly **outside** the four sagas:

- `gateway/src/routes/upstream-edges.ts` — the **dispute stake** debit *and* its withdraw/refund (`±DISPUTE_STAKE_PENCE`). Real £5 tab debits, **zero tests**, the worst gap in the repo (§1.3), guarded today by the literal comment *"The ledger debit mirrors the tab movement by the same signed delta."* Exactly the shape the primitive exists to abolish.
- pledge-drive fulfilment debits (§1.3(2)).
- per-read **accrual** and the **settlement** `+settled` write (the one saga that does mirror a column).
- **subscription** charge / credit-back (`subscription_charge` / `subscription_credit`).
- the migration-121 `opening_balance` backfill (one-time, same pattern).

**The primitive.**

```
applyLedgerDelta(client, {
  accountId, counterpartyId, deltaPence,     // signed; NO clamp, NO floor
  triggerType, refTable, refId,
})
```

It mutates `reading_tabs.balance_pence` by `deltaPence` **and** posts the mirror `recordLedger` entry by the *same signed delta*, as one indivisible pair. It wraps `recordLedger` (whose semantics are **not** modified) and owns the `balance_pence = balance_pence + $delta` UPDATE. Because the column may legitimately go negative (migration 124 dropped the non-negative CHECK), the primitive **must not** clamp — clamping the column while the ledger posts the full amount *is* the bug class it closes.

**Sequencing — this ships WITH §1.3, not behind the saga battery.** It is a mechanical wrap of an existing `UPDATE + recordLedger` pair, not a control-flow refactor; it needs no conformance battery in front of it and has no dependency on §1.1. It must land **before disputes un-dark**, because it is what structurally prevents the clamp bug on precisely the route §1.3(1) is racing to test. Do §1.3(1)'s tests and §1.8 together: the tests pin the behaviour, the primitive makes it hard to break.

**CI note.** `scripts/check-ledger-adjacency.sh` currently asserts every `balance_pence = balance_pence [-+]` site has an *adjacent* `recordLedger`. Centralising the pair inside `applyLedgerDelta` relocates that adjacency into the primitive — update the tripwire to treat `applyLedgerDelta` as the sanctioned adjacency site **and** to flag any *raw* `balance_pence` UPDATE that bypasses it, or the refactor trips its own guard.

**Scope boundary.** The payout-side sagas stay out: their correctness is claim-rollback (`rollback*PayoutRows`), not column mirroring, and forcing them through `applyLedgerDelta` would need a "no column" flag — the banned shape. `applyLedgerDelta` is a **tab** primitive.

**Acceptance.** Every `reading_tabs.balance_pence` write routes through `applyLedgerDelta`; a grep finds no raw balance UPDATE paired with a separate `recordLedger`; the adjacency tripwire is green against the new sanctioned site; ledger parity (`−SUM == balance`) holds across the dispute/pledge/subscription round-trip tests from §1.3.

**Effort:** small — days. **Risk:** low, and *decoupled* from the saga refactor's risk.

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

**Gate — dissolved on paper AND in code (shipped 2026-07-14, migration 156).** The Dial-A rework has landed: the schema's `tribute_accruals.state` CHECK is narrowed to `released/paid/voided`, the `swept_return_payout_id`/`swept_return_kind` columns + their CHECKs + the swept-unclaimed index are dropped, and settlement freezes a share only for a `live` tribute (forward-only) — so the earmark-and-hold for a possibly-non-consenting party no longer exists in the data model. Consequences for build scoping (now historical, retained for the record):

- **The Dial-A code rework was the prerequisite — now DONE** (`docs/adr/UPSTREAM-EDGES-BUILD-PLAN.md` › *Dial-A rework*, marked shipped). "Resolved" here is no longer provisional.
- **Hard ordering gate, now satisfied:** Branch A (§2.1) may ship after §2.3 returns — the float it would ring-fence no longer contains any unconsented hold.
- **Same fact, two angles:** this is why tribute went last in §1.1. The held-share machinery is deleted from the code, so the tribute path may now be refactored/segregated/treated-as-resolved.

### 2.3 The remaining human sign-off on the baseline

The prior engineering gates on `TRIBUTES_ENABLED` were cleared (copy audit done 2026-06-23; F3 reversal path built 2026-06-24), though the Dial-A ruling (§2.2) adds one more engineering gate — the consent-gated-accrual rework — before the flag flips. On the *compliance* side, one gate remains, and it is bigger than tributes: **residual checklist #1 — confirming that reliance on Stripe as the regulated PI/EMI keeps the platform itself outside PSR/EMR authorisation for the existing reading-tab float.** This is a platform-wide question tributes merely inherit. It should be settled independently of, and prior to, both the tribute flag and the Stripe decision, because it is the question both branches of §2.1 are answers to. If the answer is "the baseline is fine as-is," Branch A becomes belt-and-braces rather than necessity, and the MoR trade may not be worth taking at all.

### 2.4 What not to do

Do not build speculative branches for both models. The current discipline — one posture, clean seams (fee/net split per settlement, centralised net formula, reversal paths), dark flags only for the genuinely contingent — is the right shape. Part 1 keeps the seams sharp; Part 2 is decided in a meeting, not a merge.

---

## Build scope & sequence

Ready-to-scope ordering. Items marked **[build]** are code; **[decision]** are human/counsel sign-offs that gate code.

**Prerequisite (gates several items below) — ✅ SHIPPED 2026-07-14 (migration 156):**
- **[build] Dial-A rework** (`UPSTREAM-EDGES-BUILD-PLAN.md` › *Dial-A rework*) — net deletion of the held/swept/returned tribute path. **DONE.** No longer blocks §1.1 tribute-flow extraction (the tribute flow now has its final post-Dial-A shape) or §2.1 Branch A; the last `TRIBUTES_ENABLED` gate is compliance residual #1 (§2.3).

**This week (decision-independent, no prerequisite):**
1. **[build] Lock-ordering gate** (§1.1 step 1, promoted) — verify all four flows lock in the same order (account → payout/settlement row); **STOP and report** if they differ. No prerequisite, gates nothing, pure risk-surfacing — run it first and on its own, whether or not the §1.1 refactor ever happens.
2. **[build]** §1.8 — `applyLedgerDelta` across the tab-debit sites (dispute/pledge/accrual/subscription), + adjacency-tripwire update. *Before un-darking disputes.* Pairs with item 3.
3. **[build]** §1.3(1) — dispute-stake debit/refund/withdraw tests. *Before un-darking disputes.*
4. **[build]** §1.4 — chargeback-attribution policy paragraph.
5. **[build]** §1.5 — tax schema migration (empty columns + `vat` trigger type).
6. **[decision]** Put **only** the §2.3 baseline sign-off request to Harper James. The §2.2 question is closed (Dial A) — do not ask about an unconsented-hold characterisation; there isn't one. §2.1 waits on §2.3.

**Before launch:**
7. **[build] ✅ SHIPPED 2026-07-14** — §1.1 step 1 — conformance battery, all four flows (tribute's battery written against the post-Dial-A shape; lock-ordering gate already run as item 1). 32 tests in `payment-service/tests/conformance-*.test.ts` (+ `tests/support/conformance.ts`), each driving the REAL service against a stateful table+ledger model and a Stripe double (idempotency replay + programmable terminal/ambiguous). Full §1.1-step-1 checklist covered per flow, incl. the publication multi-leg crash and — settlement only, via the real `applyLedgerDelta` — parity + the no-clamp regression. Suite 143/143. See FIX-PROGRAMME 2026-07-14.
8. **[build] ✅ SHIPPED 2026-07-14** — §1.1 step 2 — **saga** primitive extraction. `executeStripeIdempotent` (classify-and-signal) extracted and all four flows routed through it, one commit each, order **writer → settlement → publication → tribute** (tribute against the shipped post-Dial-A shape). Ships with 8 unit tests + `stripeErrorCode` helper; the item-7 battery stayed green throughout (151-test suite green after every flow). `statusGuardedTransition` assessed and **not** extracted (dynamic-SQL-over-money-tables hazard > the four readable clones; the hazardous `rowCount`-gate bit is a one-liner whose extraction would need the banned callback inversion) — see §1.1 step 2 candidate list. (`applyLedgerDelta` shipped separately as item 2 — not part of this pass.)
9. **[build] ✅ scheduled reconciliation job SHIPPED 2026-07-14** — §1.2 — `reconcile-ledger.ts` (five reader-tab checks) + `payout-halt.ts` (durable `platform_config.payouts_halted` flag, first-writer-wins) + `workers/ledger-reconcile.ts` (3×/day) + internal reconcile/halt-status/resume routes; the three payout cycles gate on the flag. Mismatch response = `logger.fatal` alert + halt (never detect-and-log). 7 tests, suite 158 green. **§1.2 property tests (superset half) ✅ SHIPPED 2026-07-14** — `settlement-attribution-conservation.test.ts` (5 tests, real `confirmSettlement`, conservation properties P1–P5 + double-webhook idempotence; suite 163 green). **§1.2 fully shipped.**
10. **[build]** §1.3(2–3) — pledge + paid-DM tests.
11. **[build]** §1.6 — merchant-posture module.

**On the compliance answers:**
12. **[decision → build]** Execute the pre-decided branch of §2.1 once §2.3 returns. Branch A only after the Dial-A rework has shipped (§2.2 hard gate). Branch B pulls §1.5/§1.6 from schema-stubs into live VAT/invoice code.

---

## Appendix — Build scoping, verified against code (2026-07-13)

Each Part-1 item was checked against the current tree (migrations through 154; `payout.ts` 2457 / `settlement.ts` 1185 lines, matching the framing). This appendix records the concrete file:line targets, four places where the code differs from the body above, and the outcome of the lock-ordering gate. Where this appendix and the body disagree on a *fact*, the appendix is the checked one; the body's *decisions* stand.

### A. Lock-ordering gate (item 1) — RAN, found a real defect, FIXED

The gate ("verify all four flows lock in the same order; STOP and report if they differ") was run. The three payout flows (writer/publication/tribute) are each internally consistent but anchor on *different* tables (`accounts` / `publications` / `tributes`) and none lock an `accounts` row alongside a payout row — so there is no cross-flow contention to deadlock on. **Settlement was the outlier**, and the defect is real (verified by reading the code, not inferred):

| Path | Lock order on `{reading_tabs, tab_settlements}` | Ref |
|---|---|---|
| `reserveSettlement` | `reading_tabs` FOR UPDATE → insert `tab_settlements` | `settlement.ts:178 → 224` |
| `reverseSettlement` | `reading_tabs` FOR UPDATE → update `tab_settlements` | `settlement.ts:864 → 871` |
| `confirmSettlement` (pre-fix) | update `tab_settlements` → update `reading_tabs` | `settlement.ts:534 → 557` |

`confirmSettlement` acquired the two rows in the **opposite** order from its siblings, and `reconcileSettlements` inherits it. A reconcile-driven `confirmSettlement` racing a `reverseSettlement` (refund/dispute webhook) on the same settlement could form a lock cycle → Postgres deadlock-kills one txn on the money path.

**Fixed 2026-07-13:** `confirmSettlement` now takes `SELECT balance_pence FROM reading_tabs WHERE id = $tab_id FOR UPDATE` before claiming the `tab_settlements` row (`settlement.ts`, just above the `stripe_charge_id` claim), making its order `reading_tabs → tab_settlements` like the other two. The lock is already held through the balance debit below, so there is no extra round-trip. Typecheck clean; the 17 settlement/parity/writer-accrual tests pass unchanged. This was decision-independent and shipped ahead of the rest of Part 1, exactly as item 1 anticipated.

### B. Four corrections where the code differs from Part 1

1. **§1.3(3) "paid-DM pricing and charge path" — the charge path does not exist.** `dm_pricing.price_pence` can be set/read (`gateway/src/services/messages.ts:546–611`, routes `messages.ts:174–204`), but `sendMessage()` (`services/messages.ts:306–414`) never reads the price, never touches `reading_tabs`, never calls `recordLedger`. This is an *unbuilt feature*, not a test gap — remove it from the §1.3 test queue and re-file as build work if paid DMs are wanted.
2. **§1.3 gift links are not a money feature.** Redemption inserts `article_unlocks` with `unlocked_via='author_grant'` (`gateway/src/routes/gift-links.ts:149–188`) — a free author comp, no ledger/tab. Nothing money-adjacent to test; drop from scope. The real §1.3 money-path targets are only: **(1) dispute stakes** (live, untested), **(2) pledge fulfilment** (dark behind `PLEDGES_ENABLED`, untested), and **(4) traffology math** (analytics, no money).
3. **§1.6 merchant-posture is greenfield, not a de-dup.** There are no scattered receipt/seller/refund-source strings to consolidate. The single charge site (`settlement.ts:266–285`) sets no `statement_descriptor`, `receipt_email`, `description`, or seller-of-record posture; refunds are pure webhook logic (`payment-service/src/routes/webhook.ts:234–282`, `chargeback.ts`). The "Nostr receipts" (kind 9901) are proof-of-read, unrelated. The module *introduces* this surface — effort is design + new copy, not grep-and-move.
4. **§1.5 ledger vocabulary is a TS union, not a DB CHECK.** `ledger_entries.trigger_type` has no CHECK; the authoritative list is `LedgerTriggerType` in `shared/src/lib/ledger.ts:72–92`. Adding `vat` is a one-line TS edit (+ any partitioning-view WHERE-clauses in `schema.sql`). Only the `tab_settlements` columns need an actual migration (shipped as 155; **next number is now 156**).

### C. §1.8 `applyLedgerDelta` — verified call-site inventory (blast radius)

Nine `reading_tabs.balance_pence`-moving sites, all currently dual-written with an adjacent `recordLedger`, none clamped:

| # | Site | Δ | Trigger | Note |
|---|---|---|---|---|
| 1 | `accrual.ts:211` (`recordGatePass`) | + | `read_accrual` | plain UPDATE |
| 2 | `accrual.ts:319` (`convertProvisionalReads`) | + | `read_accrual` (loop) | plain UPDATE |
| 3 | `settlement.ts:556` (`confirmSettlement`) | − | `tab_settlement` | parity test hard-matches this SQL shape |
| 4 | `settlement.ts:1027` (`reverseSettlement`) | + | `tab_settlement_reversal` (+ writer/tribute legs) | plain UPDATE |
| 5 | `subscriptions/shared.ts:68` (`logSubscriptionCharge`) | + | `subscription_charge` **and** `subscription_earning` | two ledger calls |
| 6 | `articles/subscription-convert.ts:142` | − | `subscription_credit` | plain UPDATE |
| 7 | `drives.ts:826` (`fulfillDrive`) | + | `pledge_fulfil` | **upsert** (`ON CONFLICT DO UPDATE`) |
| 8 | `upstream-edges.ts:464` (dispute stake debit) | + | `dispute_stake` | **upsert** |
| 9 | `upstream-edges.ts:557` (dispute stake refund/withdraw) | − | `dispute_stake_refund` | **upsert** |

Design consequences: (a) `applyLedgerDelta` must support **create-or-update** (sites 7–9 upsert to mint the tab if absent), not UPDATE-only; (b) site 5 posts **two** ledger entries per balance move — the primitive must allow N mirror entries or the caller posts the second (`subscription_earning`) itself; (c) `settlement-ledger-parity.test.ts` regex-matches `balance_pence = balance_pence - $1` and must be updated when site 3 is centralized; (d) `scripts/check-ledger-adjacency.sh` (registry + the `balance_pence = balance_pence [-+]` marker) must be updated to treat `applyLedgerDelta` as the sanctioned adjacency site and flag any raw balance UPDATE that bypasses it. The `opening_balance` backfill (migration 121) inserts ledger rows only, does **not** move the column — out of scope. Payout-side sagas stay out (claim-rollback, not column-mirror).

### D. §1.5 tax-schema migration (155) — concrete shape — SHIPPED 2026-07-14

`tab_settlements` (`schema.sql:2100–2118`) confirmed to carry no tax columns. Migration 155: add nullable `vat_pence int`, `vat_rate_bps int`, `tax_point timestamptz`; add `vat` to `LedgerTriggerType` (`shared/src/lib/ledger.ts:72`); leave unused. Then regenerate `schema.sql` via `pg_dump --exclude-schema=graphile_worker`, re-append the `_migrations` seed in the same step, and run `scripts/check-schema-drift.sh` (CI-enforced). **Done exactly as specified** — columns hand-appended to the `tab_settlements` CREATE (matching pg_dump attnum order), seed line added, all four drift checks green (round-trip clean confirms the hand-edit is canonical), migration applied to the dev DB.

### E. Dial-A rework (prerequisite) — verified blast radius — ✅ SHIPPED 2026-07-14 (migration 156)

Net deletion, ~8 code files + 1 migration, concentrated in `payout.ts`. **Built exactly as scoped below** (migration 156 narrows the state CHECK to `released/paid/voided` + drops the swept-return columns/CHECKs/index; settlement freezes `live`-only always-`released`; the payout cycles, chargeback planner, `ReversalAccrual`, display carves, consent/decline/lapse, and reconcile A10c/A11 all reworked; `reconcileConnectKyc`'s two swept-return EXISTS clauses also dropped). Chargeback conservation re-verified (11 tests), schema.sql regenerated (327 objects, drift 4/4), ledger-adjacency green, payment-service 111 + gateway 325 tests green, all services typecheck clean. Per `docs/adr/UPSTREAM-EDGES-BUILD-PLAN.md` › *Dial-A rework*:

- **Migration**: narrow `tribute_accruals.state` CHECK from `held/released/paid/swept/returned/voided` (`schema.sql:2146`) to `released/paid/voided`; drop `swept_return_payout_id` + `swept_return_kind` and their two CHECKs (`schema.sql:2147–2148`); drop `idx_tribute_accruals_swept_unclaimed` (`schema.sql:4962`); keep historical rows valid.
- **`settlement.ts:658–719`**: rewrite apportionment to `live`-only, always `released` (drop the `proposed→held` branch, line 713).
- **`payout.ts`** (largest surface): strip swept-return claim/advance/rollback + `held` handling from `runPayoutCycle`/`reserveWriterPayout`/`completeWriterPayout` and `runTributePayoutCycle`/`completeTributePayout`/`rollbackTributePayoutRows` and the eligibility predicate — ~lines 371–429, 561–570, 658–665, 779–783, 1017–1022, 1602–1763, 2137–2150, 2365–2391. The `tribute_carve` post at `:1888` **stays** (now the sole carve entry point, mechanic unchanged).
- **`gateway/src/routes/tributes.ts:364/422`** and **`gateway/src/lib/tribute-sweep.ts:149`**: consent/decline/lapse become status-only (no accrual state flips).
- **`chargeback.ts:253–280`**: collapse the `held`/`swept`/`returned`/in-flight cases to `released`-unclaimed→`voided` and `paid`→`tribute_payout_reversal`; simplify `ReversalAccrual`; re-verify the 8 conservation tests telescope to −`read_net`.
- **Display**: carve on `released|paid` of `live` only — `payout.ts:206–312` (incl. `reservedPence` at :239) and `gateway/src/routes/my-account.ts:178–180, 306–308`.
- **`scripts/reconcile-ledger.sql`**: drop A10c (`:202`, swept-return consistency); keep/reword A11 (`:215`). Re-run adjacency + drift after the migration.

Blocks: §1.1 tribute-flow extraction, §2.1 Branch A, the `TRIBUTES_ENABLED` flip.

### F. Corrected queue (supersedes the counts above only where noted)

**Done:** A — settlement lock-order fix (shipped 2026-07-13, this appendix); **§1.8 `applyLedgerDelta` across all 9 tab-debit sites + adjacency-tripwire Guard-2 rewrite, paired with §1.3(1) dispute-stake round-trip tests (shipped 2026-07-14).** Both were the "before disputes un-dark" gate — that gate is now met for the dispute path. **§1.4 chargeback-attribution policy paragraph (`docs/HOW-MONEY-MOVES.md`, refund/chargeback section) + §1.5 tax-schema migration 155 (`vat_pence`/`vat_rate_bps`/`tax_point` nullable on `tab_settlements`, empty; `vat` added to `LedgerTriggerType`; schema.sql regenerated + drift guard green) (shipped 2026-07-14).** The entire "this week (decision-independent)" build queue is now shipped. **Dial-A rework (§E prerequisite — migration 156, shipped 2026-07-14):** held/swept/returned machinery deleted; the tribute path now has its final post-Dial-A shape.
**This week (remaining):** §2.3 baseline sign-off to counsel (decision only).
**Prerequisite, scope-first:** Dial-A rework (§E) — ✅ DONE.
**Before launch:** §1.1 battery ✅ SHIPPED 2026-07-14 (all four flows, 32 tests) → §1.1 **primitive extraction** ✅ SHIPPED 2026-07-14 (`executeStripeIdempotent` across all four flows, one commit each, writer → settlement → publication → tribute; `statusGuardedTransition` assessed and not extracted; suite 151 green) → §1.2 **scheduled reconciliation job** ✅ SHIPPED 2026-07-14 (reader-tab parity checks + alert + durable payout-halt flag + 3×/day worker + manual routes; suite 158 green) → §1.2 **conservation property tests (superset half)** ✅ SHIPPED 2026-07-14 (`settlement-attribution-conservation.test.ts`, 5 tests, real `confirmSettlement`, P1–P5 + double-webhook idempotence; suite 163 green — **§1.2 now fully closed**) → **next:** §1.3(2) pledge tests + §1.3(4) traffology math (§1.3(3) paid-DM and gift links dropped per §B); §1.6 merchant-posture module, greenfield (§B3).

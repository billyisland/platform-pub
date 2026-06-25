# Writer-side ledger cutover (Architecture-audit item 3, final phase)

**Status:** Spec + as-built. Closes the one open phase of the keystone ledger
(item 3): the dashboard read of writer earnings is cut over from `read_events`
to a `SUM()` read-model view, and — the prerequisite — the ledger is taught to
**model writer-side accrual**, including the Upstream-Edges tribute carve.

**Companions:** `ARCHITECTURE-AUDIT-IMPLEMENTATION-PLAN-2026-06-15.md` (item 3,
Phases 0–3 reader-side), `UPSTREAM-EDGES-TRIBUTE-COMPLIANCE.md` (build-plan
guard #7 — the held share stays out of the ledger), `shared/src/lib/ledger.ts`.

## The gap

Before this change the ledger posted writer-side entries **only at payout**
(`writer_payout` / `publication_split` / `tribute_payout`, all credits). It
recorded nothing when a writer *earned* from a read. So `ledger_writer_earnings`
summed money **paid out**, while the dashboard's `getWriterEarnings()` summed
money **earned-incl-pending** (`read_events` net in states `platform_settled` +
`writer_paid`). Different quantities — the views stayed reconciliation-only.

## What a writer earns, precisely

`getWriterEarnings().earningsTotalPence` for writer `X` =

```
read_net(X)  −  Σ( root carve on X's reads in states held|released|paid )
```

where `read_net = amount − FLOOR(amount·feeBps/10000)` per read (`per-read-net.ts`),
and the *root carve* is the depth-0 (`parent_tribute_id IS NULL`) tribute
accrual redirected from X's earnings. `reservedPence` is the `held|released`
slice of that (still X's money, conditionally directed). Deeper chain carves are
the **inspirers'** business (telescoping within a root's gross), never the
article author's — so the writer-side model concerns **root carve only**.

## The model — three new economic events, one constraint

The constraint is **build-plan guard #7 / compliance condition #3**: a *held*
tribute share must stay **out of `ledger_entries`** until it reaches a real
account. While held it is still the author's money. So the ledger keeps the
author's **full** `read_net` until a carve is actually **paid** to the inspirer
— the only moment the redirect executes and the money moves.

The load-bearing algebra:

```
earningsTotal + reservedPence  =  read_net − paid_root_carve
```

— a quantity that changes **only** when a root carve flips `held|released → paid`
(never on freeze, sweep, or return). So the ledger models exactly that, and the
held/released split (`reservedPence`) stays a projection over `tribute_accruals`.

| Event | Where | Entry | Sign / account / cp |
|-------|-------|-------|---------------------|
| **Read settles** (`accrued → platform_settled`) | `settlement.ts` `confirmSettlement`, per settled read | `writer_accrual` | `+read_net`, acct = writer, cp = reader |
| **Root carve paid** (root accrual `released → paid`) | `payout.ts` `completeTributePayout`, per root accrual flipped | `tribute_carve` | `−accrual.amount`, acct = author, cp = root inspirer |
| **Read charged back** | `chargeback.ts` planner | `writer_accrual_reversal` | `−read_net`, acct = writer, cp = reader (every charged-back settled read) |
| **Paid root carve charged back** | `chargeback.ts` planner | `tribute_carve_reversal` | `+accrual.amount`, acct = author, cp = inspirer (root paid accruals only) |

No entry on settlement **freeze**, the 60-day **sweep**, or a **swept-return**:
none changes `read_net − paid_root_carve`. (The swept-return to the author rides
inside the existing `writer_payout` credit — paid-side, a disjoint view.)

## The view + cutover

```sql
CREATE VIEW ledger_writer_earned AS
SELECT account_id, SUM(amount_pence)::bigint AS earned_pence
FROM ledger_entries
WHERE trigger_type IN ('writer_accrual','writer_accrual_reversal','tribute_carve','tribute_carve_reversal')
GROUP BY account_id;
```

`ledger_writer_earned(X) = read_net(X) − paid_root_carve(X) = earningsTotal + reservedPence`.

`getWriterEarnings()` is cut over so the **headline** earned-total reads the
ledger:

```
earningsTotalPence = ledger_writer_earned(X) − reservedPence(X)
```

with `reservedPence` and the `pending`/`paid` sub-split left on their existing
`read_events` / `tribute_accruals` sources (a pure-ledger pending/paid split
would need a per-read entry at every payout — ledger bloat for a breakdown).
A **parity test** asserts `ledger_writer_earned == earningsTotal + reservedPence`
to the penny, across all history.

## Backfill (migration 136, one-time, inert on fresh DB)

- `writer_accrual` `+read_net` for every historic `platform_settled | writer_paid`
  read (charged-back reads excluded — they carry no forward accrual).
- `tribute_carve` `−amount` for every historic **root** accrual in state `paid`.

Both posted only where non-zero; on a from-`schema.sql` boot there are no reads
and no accruals, so the migration is a no-op (the `121` precedent).

## Tributes-dark today, faithful when live

`TRIBUTES_ENABLED` is OFF in prod, so `paid_root_carve` and `reservedPence` are
**zero**: `ledger_writer_earned = read_net = earningsTotal`, penny-exact now. The
carve is *already modeled*, so flipping `TRIBUTES_ENABLED` needs **no further
ledger work** — the parity test is the standing guard (it runs against a
tributes-on fixture too).

## Conservation (unchanged invariant, extended coverage)

For a fully-resolved charged-back read the **earned-side** reversals sum to
`−(read_net − paid_root_carve)` for the author (`writer_accrual_reversal` +
`tribute_carve_reversal`), backing the author's earned to zero — disjoint from
the existing **paid-side** reversals (`writer_payout_reversal` /
`tribute_payout_reversal`), which the 8 `chargeback-reversal.test.ts` cases
already prove telescope to `−read_net`. The two sides never share a trigger, so
they never interfere.

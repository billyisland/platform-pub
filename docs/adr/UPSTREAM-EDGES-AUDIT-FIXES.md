# Upstream Edges — Audit Fix Plan

**Companion to:** `UPSTREAM-EDGES-ADR.md`, `UPSTREAM-EDGES-BUILD-PLAN.md`, `UPSTREAM-EDGES-TRIBUTE-COMPLIANCE.md`.
**Source:** full commit audit of the tribute/citation body of work (`75c58ea`→`370f599`, migrations 125–128, `tributes.ts` / `upstream-edges.ts` / `tribute-sweep.ts`, `settlement.ts` / `payout.ts`, `per-read-net.ts`, `UpstreamEdges.tsx`), 2026-06-24. The money core was read line-by-line and conservation verified by hand; three sub-agents swept migrations / routes / frontend and their high-impact claims were re-checked against source (several severities were adjusted down here after verification).

## Verdict (so the plan is read in context)

The apportionment math is **sound** — telescoping conservation `author + Σ(every node's retained) == read_net` holds, the author carves **roots only** (Phase-5 corrected), the carve+swept-return is ordering-safe across cycles, payouts are crash-safe with stable idempotency keys and exactly-once claim columns. **These findings are hardening gaps and one missing reversal path, not flaws in the core money logic.** Nothing here blocks the *code* — the gates are the live Phase-1 items (F1/F2) and the pre-money-flag items (F3, F7, F11).

**Flag state:** Phase 1 (credits/citations/**disputes + real £5 stakes**) is **LIVE in production** — `upstream-edges.ts` has no `tributesEnabled()` gate. Phases 2–5 (all tribute money) are **dark** behind `TRIBUTES_ENABLED` / `NEXT_PUBLIC_TRIBUTES_ENABLED`; the production money flag is OFF pending compliance sign-off (memo residual #1).

Priority is **correctness risk × blast radius × effort**, FIX-PROGRAMME convention. Each item points at files/lines so the diagnosis can be re-checked before work starts.

---

## P0 — Live in production now (Phase 1, real money on the tab)

- [x] **F1 · Dispute uniqueness — repeated stakes + public count manipulation.** ✅ 2026-06-24
  `gateway/src/routes/upstream-edges.ts:329` (`POST /disputes`) does no "already disputed?" check and `dispute_edges` (migration 125) has no unique constraint. A third party can dispute the same edge N times (£5 self-charged each — self-harm, but each bumps the public `thirdPartyCount`); a **cited author disputes for free, unlimited** (`is_by_cited_author` ⇒ no stake), inflating the disclaimer/dispute counts the GET endpoints render.
  **Fix:** partial unique index on `(disputant_account_id, citation_edge_id)` and `(disputant_account_id, credit_edge_id)` (each `WHERE … IS NOT NULL AND withdrawn_at IS NULL AND deleted_at IS NULL`), + an idempotent insert (`ON CONFLICT DO NOTHING` → 409/return-existing). New migration (129).
  **As built:** migration `129_dispute_uniqueness.sql` adds the two partial unique indexes (`uq_dispute_active_citation` / `uq_dispute_active_credit`). The insert is now `ON CONFLICT DO NOTHING`; `rowCount===0` skips the stake + relay enqueue inside the txn and returns **409** with the disputant's existing live dispute id (`{ error, id, staked }`). Re-disputing after a withdrawal stays allowed (partial index excludes `withdrawn_at`/`deleted_at`). Frontend `UpstreamEdges.tsx` treats the 409 idempotently (reloads to surface the existing dispute + its Withdraw, no retry prompt). `schema.sql` regenerated; all four drift checks green.

- [x] **F2 · Credit privilege ignores ATProto/ActivityPub/RSS cited parties.** ✅ 2026-06-24
  `gateway/src/routes/upstream-edges.ts:375-380` grants the no-stake privilege only to native members and Nostr-keyed identities. Someone credited via a Bluesky DID / AP actor must pay £5 to disclaim a credit **about themselves** — contradicts the ADR ("the cited author … stakes nothing; anyone else holds a stake"). 
  **Fix:** extend the `is_by_cited_author` match to compare the disputant's linked external identities (`network_presences` / `external_identity_links`) against `credit_edges.target_protocol`/`target_external_id`. If that's too broad for now, document the limitation in the ADR rather than leave it silent.
  **As built:** the credit-dispute branch now adds a third privilege arm — if the credit target is an external protocol, it grants `is_by_cited_author` when the disputant holds an **active, valid** `network_presences` row matching `(protocol, external_id)` exactly. Exact-match only (no fuzzy handle/DID normalisation), so it can never over-grant the free dispute; a format mismatch simply falls back to the £5 stake (the pre-existing behaviour), never an exploit. `external_identity_links` was not needed — it links external↔external author records, not account↔external identity, which is what `network_presences` already provides.

---

## P1 — Fix before the money flag flips (dark today)

- [ ] **F3 · Refund/chargeback unwind is required by the ADR but unbuilt.**
  ADR *Edge cases* and Build-Plan Phase 3 both require a reversed read to "unwind the author's credit **and** its tribute accruals." No handler reverses a settled read or voids its accruals — only `handleFailedPayout` (transfer failure; does correctly unclaim swept shares) and `handleFailedPayment` (pre-accrual) exist (`payment-service/src/services/payout.ts`, `settlement.ts`). A reader Stripe chargeback after settlement leaves accruals — and, once paid, real Connect transfers — un-reversed. Partly a pre-existing platform gap (no reader-chargeback path exists at all).
  **Fix:** either build the `charge.dispute.created` / refund path that rolls the read back and voids/reverses its accrual subtree (`held|released` voided in place; `paid` posts a reversing `tribute_payout` per the plan), **or** record the deferral explicitly in the build plan's Phase-3 "as built" + the compliance residual checklist. Do not ship the money flag with this silently absent.

- [ ] **F7 · Reminder token rotation can strand a claim.**
  `gateway/src/lib/tribute-sweep.ts:72-77` rotates `invite_token_hash` in a committed `pool.query`, *then* emails the new link; if `sendReminderEmail` throws (swallowed at :83), the **old link is already dead and the new one was never delivered**, and `reminder_sent_at` stays NULL so it rotates again next tick (perpetually killing the prior link).
  **Fix:** rotate-and-send atomically (stamp `reminder_sent_at` + rotate only on confirmed send), or send first then rotate. Also confirm the caller holds `ADVISORY_LOCKS.TRIBUTES` around the whole `runTributeSweep` (the per-row UPDATEs have no `FOR UPDATE`; overlapping ticks would double-rotate/double-send).

- [ ] **F11 · Claim token left in the URL.**
  `web/src/app/tribute/claim/page.tsx` stashes `?token=…` to `sessionStorage` but never `replaceState`s it out — it persists in browser history, server access logs, and `Referer`. For a token that binds money to an account, strip it: `router.replace('/tribute/claim')` immediately after stash.

- [ ] **F10 · Citation marker can mis-anchor after a body edit.**
  `web/src/components/article/UpstreamEdges.tsx` + `web/src/lib/citation-anchor.ts` place the marker at the stored `char_start` with **no check that the text there still equals the stored `excerpt`**. Native articles are NIP-23 replaceable/editable; after a republish the offset is stale and the "[N]" marker silently lands on unrelated prose — corrupting the faithfulness the feature exists for.
  **Fix:** re-verify the excerpt at placement time and drop the marker on mismatch (the composer already does this on author edit; reuse that check on the read side). Note: Phase 1 (citations) is live, so this is a present correctness gap, not dark — borderline P0/P1.

- [ ] **F4 · `tribute_accruals` lacks the append-only guard its siblings carry.**
  `ledger_entries` is DB-guarded against UPDATE/DELETE/TRUNCATE (migrations 119/124); `tribute_accruals` is money-bearing and its `amount_pence` is documented "frozen … never recomputed" but is freely mutable. (The table *must* allow `state` transitions, so this is not full append-only.)
  **Fix:** `BEFORE UPDATE` trigger blocking changes to `amount_pence` / `read_event_id` / `tribute_id` (allow `state` + claim-column writes). New migration.

---

## P2 — Defense-in-depth / hardening (route-enforced today, no live exploit found)

- [ ] **F5 · No DB backstop that a child's parent stays `live`.** ADR C6's compliance posture leans on "every held share traces up an unbroken chain of consented earners." Verified currently unreachable to violate: `live` is terminal (consent/decline both guard `WHERE status='proposed'`; `DELETE` withdraws proposed only) and children require a live parent (C1) — only a manual DB edit could orphan a child. Add a CHECK/trigger backstop given the compliance reliance. `migrations/128`, `gateway/src/routes/tributes.ts`.

- [ ] **F6 · Missing consistency CHECKs that sibling tables have.** `credit_edges`/`tributes` carry `*_target_consistency` CHECKs; add the analogues: `citation_edges` (`source_protocol` ↔ addressing), `dispute_edges` (`is_by_cited_author = false ⇒ stake_ledger_entry_id IS NOT NULL`; `wider_excerpt` ↔ `wider_excerpt_sha256` all-or-nothing). `migrations/125`. Route-enforced only today.

- [ ] **F8 · `consent`/`decline`/`claim` lack the `23514` catch that `create` has.** `gateway/src/routes/tributes.ts:350` runs the consent UPDATE (a tribute write firing the ceiling/D1 trigger) with no try/catch → a `check_violation` would surface as a 500. Verified **not reachable today** (insert-time enforcement keeps Σ proposed+live ≤ 9000; the reverse trigger blocks publication-while-tributed) — latent robustness only. Wrap the three handlers' txns to map `23514` → 400, mirroring `create`.

- [ ] **F9 · Self-tribute is not blocked** (`gateway/src/routes/tributes.ts`, `POST /tributes`, no `t.accountId !== writerId` check). **By design** — the ADR documents "Self-crediting is not uplift … Noted as a limit, not plugged," and conservation still holds. Listed only so it isn't re-discovered as a "bug." Add a guard only if the circle polluting the accrual/ledger model becomes a concern.

- [ ] **F13 · `UpstreamEdges.tsx` robustness.** `renderTributeForest` (`:366`) recurses with no visited-set — a malformed/cyclic payload stack-overflows the reader (schema prevents cycles, but a money surface deserves a `Set` guard). `acceptAndPass` (`:137`, `:471`) treats a post-consent `load()` failure as an *accept* failure, inviting a double-accept retry after the consent already succeeded. Orphaned subtrees (child whose parent isn't in the returned list) render nowhere.

---

## P3 — Nits

- [ ] **F12 · `citation-anchor.ts:50` `<=` boundary quirk** — at an exact text-node boundary the marker attaches to the end of the *previous* node rather than the start of the next. **Cosmetic** (identical visual position for adjacent text; differs only by landing inside a trailing inline `<em>`/link at element boundaries; `<=` is also required to place at true end-of-body). Leave unless it surfaces visibly.
- [ ] **F14 · `BalanceHeader.tsx:37` uses banned `bg-grey-100`** for the allowance track (CLAUDE.md deprecates it for these surfaces). Pre-existing, in a touched file. Swap to a well/glasshouse token when next editing.
- [ ] **Reserved-line copy** — `reservedPence` includes `released` accruals (consented, *will* pay the inspirer, won't return), but `BalanceHeader`'s "returns to you if an offer isn't taken up" reads as if all of it returns. Tighten the copy or split held vs released.

---

## Verified sound (do not re-litigate)

- Telescoping conservation; author carves roots-only; ordering-safe carve + swept-return across multiple payout cycles (parent-paid-then-child-declines traced by hand).
- Three-phase payout durability + stable idempotency keys; `flipped.rowCount` gates the ledger emit so crash-resume can't double-post; `handleFailedPayout` correctly unclaims swept shares.
- `ON CONFLICT (tribute_id, read_event_id)` backed by `uq_tribute_accruals_tribute_read`; migration 128's data-migration order (UPDATE → drop index → drop column → recreate index) is correct; `schema.sql` genesis parity holds; all four drift checks documented green.
- Dispute stake mirrors the tab delta with no clamp (negative-balance invariant); refund idempotent via the `withdrawn_at` claim.
- Dark-flag gating consistent; GET endpoints don't leak `invite_email` / `invite_token_hash` / stake ids; relay-outbox enqueues inside the caller's txn; SQL parameterised throughout; hairline tripwire clean on the four frontend files.

## Not independently re-run

The CI suites (schema-drift, ledger-adjacency, reconcile, payment-service/shared vitest, `next build`) — the build plan documents them green and the wiring was verified, but they were not re-executed during this audit.

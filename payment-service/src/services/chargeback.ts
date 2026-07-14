import { perReadNetPence } from '@platform-pub/shared/lib/per-read-net.js'
import type { LedgerTriggerType } from '@platform-pub/shared/lib/ledger.js'

// =============================================================================
// computeChargebackReversal — the pure core of F3 (reader chargeback / refund).
//
// A reversed Stripe charge is one tab_settlements row. The reversal splits in
// two: the READER side (always restore the clawed-back debt) and the WRITER
// side (reverse only what already LEFT the platform; PREVENT what hasn't). This
// function is pure — settlement.reverseSettlement() loads the rows, calls this,
// and applies the plan (tab restore + ledger entries + state flips) in one txn.
// Pure so the conservation math is unit-testable (the repo idiom — cf.
// computePublicationSplits): for a fully-resolved tributed read the writer-side
// reversal entries sum to exactly −read_net.
//
// Per charged-back read R (net = amount − floor(amount·fee), per-read-net.ts):
//   • read writer_paid     → writer_payout_reversal −(read_net − Σ root accruals)
//                            (the author's carve-reduced net actually paid)
//   • read platform_settled→ no ledger (never paid); just → charged_back
//   • read isPublication   → F5: writer_payout_reversal per PAID split recipient,
//                            each −(their receipt × R.gross ÷ payout pool). The
//                            author is NEVER reversed (pub reads pay the pool, not
//                            the author) and post no writer_accrual, so the earned
//                            side is untouched. Platform absorbs its pooled fee +
//                            rounding remainder + any unpaid (KYC-pending) split.
//   • accrual paid         → tribute_payout_reversal −(node_gross − Σ its direct
//                            children gross on R), acct=inspirer, cp=author.
//                            State LEFT 'paid' (the transfer really happened; the
//                            reversal is a separate ledger fact, so reconcile
//                            A9/A10a stay intact — they pair on the original
//                            trigger, never the *_reversal one).
//   • accrual released, UNCLAIMED → 'voided' (never paid; just prevent it). No ledger.
//   • accrual released, CLAIMED (a tribute payout reserved it concurrently)
//                            → reverse AS IF 'paid'. A claimed released accrual is
//                            in-flight: the reserved tribute_payout row exists and
//                            the cycle WILL pay it (synchronously or on resume), so
//                            that transfer is money the reader is clawing back.
//                            Treat it as 'paid' (claimed via tribute_payout_id) and
//                            post the matching reversal — otherwise the payout pays
//                            out clawed-back money with no reversing entry (money
//                            created). Residual (far rarer than the old skip): if
//                            that in-flight payout's transfer ultimately FAILS or
//                            stays permanently pending (inspirer lost KYC), the
//                            reversal slightly over-reports the platform's loss — a
//                            reconciliation-only artefact, never phantom money.
//   (Dial A — consent-gated accrual: a share is only ever released → paid, so
//   the held/swept/returned states and their swept-return-to-parent reversal are
//   gone; a live tribute never un-consents, so nothing returns to the author.)
//
// Conservation (telescoping): the author carves roots; each node carves its own
// direct children. For a read where every accrual resolved (all 'paid'), the sum
// negates exactly what each account received → −read_net. Money never paid out
// (released-voided accruals, platform_settled reads) is correctly NOT reversed —
// it is prevented instead, and the platform simply keeps the float it never
// disbursed. Degrades to the platform-wide case with zero accruals: author net =
// read_net, so the writer reversal is the full read net — no tribute branch
// needed, no flag gate (data-driven).
//
// Two DELIBERATE one-sided postures (2026-07-06 audit, recorded not "fixed"):
//   • Subscription debt: a chargeback of a settlement that collected
//     subscription charges restores the reader's FULL settled amount to the
//     tab, but the writer's subscription_earning — possibly already paid out —
//     is NOT reversed (this planner iterates read_events only; subscription
//     earnings carry no read row). The platform absorbs the writer leg, the
//     same absorb-direction as the publication pooled-fee residual above.
//   • Chargeback × manual transfer reversal can STACK: if a dispute is handled
//     by this planner (recipient debited their prorated slice) and an operator
//     ALSO reverses the same recipient's transfer in the Stripe dashboard, the
//     transfer.reversed handler posts its own reversing entry — the recipient
//     is debited twice for one dispute. Both entries record real Stripe events
//     (money DID move twice), so neither is suppressed; the guard is
//     operational: do not manually reverse a transfer whose dispute the
//     chargeback path already settled. Check the recipient's ledger first.
// =============================================================================

export interface ReversalRead {
  id: string
  amountPence: number
  /** 'platform_settled' | 'writer_paid' */
  state: string
  writerId: string
  /**
   * F2/F5: true for a publication-article read. Publication reads earn NO
   * personal writer_accrual (settlement.ts skips them) and are paid to the
   * publication split recipients, not the author — so the author-keyed writer
   * reversals below MUST NOT fire for them (that would mis-attribute the
   * chargeback to the author). Instead the split recipients are reversed (F5,
   * below), never the author.
   */
  isPublication?: boolean
  /**
   * F5: the whole pool of the publication payout that paid this read —
   * total_pool_pence (Σ gross read amounts) + sub_net_pence (the subscription
   * leg, §1.3). The prorating base for splitting this one read's chargeback
   * across recipients: splits were paid from both legs, but only the
   * read-derived slice reverses (subscription debt on chargeback is the
   * platform-absorbs posture above), so the sub leg dilutes the read's share.
   */
  publicationPoolPence?: number
  /**
   * F5: the PAID splits (status initiated|completed — money that actually left
   * the platform) of the publication payout that paid this read. Each recipient
   * is reversed by their receipt × (this read's gross ÷ the payout's gross pool).
   * Splits still pending (KYC-incomplete recipient) or failed are NOT passed in,
   * so money that never moved is never reversed. Empty/absent ⇒ the read's pool
   * was never paid out; the read is charged back on the reader side only.
   */
  publicationSplits?: { accountId: string; amountPence: number }[]
}

export interface ReversalAccrual {
  id: string
  readEventId: string
  tributeId: string
  parentTributeId: string | null
  amountPence: number
  /** released | paid (voided rows are excluded upstream). Dial A: no held/swept/returned. */
  state: string
  /** tribute.resolved_account_id — the inspirer (party-of-funds for this node). */
  resolvedAccountId: string
  /** tribute.author_account_id — the party whose share was redirected to the node. */
  authorAccountId: string
  /** True if a tribute payout has reserved this accrual (tribute_payout_id set). */
  claimed: boolean
}

export interface ReversalLedgerEntry {
  accountId: string
  counterpartyId: string | null
  /** Signed; always ≤ 0 for a reversal. */
  amountPence: number
  trigger: LedgerTriggerType
}

export interface ReversalPlan {
  /** Pence to add back to reading_tabs.balance_pence (the restored debt). */
  tabRestorePence: number
  /** Every ledger entry to post — the reader reversal first, then writer/tribute reversals. */
  ledgerEntries: ReversalLedgerEntry[]
  chargeBackReadIds: string[]
  voidAccrualIds: string[]
}

export interface ReversalInput {
  readerId: string
  settlementAmountPence: number
  reads: ReversalRead[]
  accruals: ReversalAccrual[]
  platformFeeBps: number
}

export function computeChargebackReversal(input: ReversalInput): ReversalPlan {
  const { readerId, settlementAmountPence, reads, accruals, platformFeeBps } = input

  // Index accruals by read for the children/root gross lookups.
  const accrualsByRead = new Map<string, ReversalAccrual[]>()
  for (const a of accruals) {
    const list = accrualsByRead.get(a.readEventId)
    if (list) list.push(a)
    else accrualsByRead.set(a.readEventId, [a])
  }
  const rootGross = (readId: string): number =>
    (accrualsByRead.get(readId) ?? [])
      .filter((a) => a.parentTributeId === null)
      .reduce((s, a) => s + a.amountPence, 0)
  const childrenGross = (readId: string, tributeId: string): number =>
    (accrualsByRead.get(readId) ?? [])
      .filter((c) => c.parentTributeId === tributeId)
      .reduce((s, c) => s + c.amountPence, 0)

  // Writer-side reversal accumulates per account (NULL counterparty = platform).
  const writerReversal = new Map<string, number>()
  const addWriter = (accountId: string, amount: number) =>
    writerReversal.set(accountId, (writerReversal.get(accountId) ?? 0) + amount)

  // Tribute-side reversal accumulates per (inspirer, redirected-from author).
  const tributeReversal = new Map<string, { accountId: string; counterpartyId: string | null; amount: number }>()
  const addTribute = (accountId: string, counterpartyId: string | null, amount: number) => {
    const key = `${accountId}|${counterpartyId ?? ''}`
    const e = tributeReversal.get(key) ?? { accountId, counterpartyId, amount: 0 }
    e.amount += amount
    tributeReversal.set(key, e)
  }

  // EARNED-side reversals (item 3 final phase) — a DISJOINT trigger set from the
  // paid-side reversals above; they back out ledger_writer_earned, never the
  // paid-out ledger_writer_earnings. Every charged-back settled read got a
  // writer_accrual at settlement (full read_net), so reverse the FULL net per
  // writer (cp = the reader). A paid ROOT carve got a tribute_carve author debit
  // at payout, so reverse the FULL root gross per (author, inspirer).
  const accrualReversal = new Map<string, number>()
  const addAccrual = (writerId: string, amount: number) =>
    accrualReversal.set(writerId, (accrualReversal.get(writerId) ?? 0) + amount)
  const carveReversal = new Map<string, { accountId: string; counterpartyId: string | null; amount: number }>()
  const addCarve = (accountId: string, counterpartyId: string | null, amount: number) => {
    const key = `${accountId}|${counterpartyId ?? ''}`
    const e = carveReversal.get(key) ?? { accountId, counterpartyId, amount: 0 }
    e.amount += amount
    carveReversal.set(key, e)
  }

  const chargeBackReadIds: string[] = []
  for (const r of reads) {
    chargeBackReadIds.push(r.id)
    // F2/F5: a publication read earns no personal writer_accrual (skip the
    // earned side entirely) and was paid to the publication SPLIT RECIPIENTS,
    // not the author. Reverse each recipient by their receipt × (this read's
    // gross ÷ the payout's gross pool) — proportional attribution against the
    // stored splits. Only PAID splits are passed in (see ReversalRead), so
    // money that never left the platform is never reversed; the platform keeps
    // its pooled fee + rounding remainder + any unpaid split, exactly as the
    // individual-writer case keeps its per-read fee. Same clawed-back-payout
    // posture as writer_payout_reversal (a recipient's earned total may go
    // negative; no synchronous Stripe recovery). NEVER reverse against the
    // author — that was the F5 mis-attribution the safety gate guarded against.
    if (r.isPublication) {
      const pool = r.publicationPoolPence ?? 0
      if (pool > 0 && r.publicationSplits) {
        for (const s of r.publicationSplits) {
          const share = Math.floor((s.amountPence * r.amountPence) / pool)
          if (share !== 0) addWriter(s.accountId, share)
        }
      }
      continue
    }
    // EARNED side: every settled read (platform_settled OR writer_paid) got a
    // writer_accrual of the full net at settlement — reverse it regardless of
    // payout state. cp = reader, mirroring the forward entry.
    const readNet = perReadNetPence(r.amountPence, platformFeeBps)
    if (readNet !== 0) addAccrual(r.writerId, readNet)
    if (r.state === 'writer_paid') {
      // PAID side: author's actual receipt for R = read net minus the carve of
      // its DIRECT children — the roots (the author's depth-0 children), matching
      // the state-agnostic carve at payout. Zero accruals ⇒ full read net.
      const authorNet = readNet - rootGross(r.id)
      if (authorNet !== 0) addWriter(r.writerId, authorNet)
    }
  }

  const voidAccrualIds: string[] = []
  for (const a of accruals) {
    // Dial A: an accrual is only ever 'released' → 'paid'. A claimed-but-still-
    // 'released' accrual is in-flight to 'paid' via a reserved tribute_payout that
    // WILL pay it — treat it as already 'paid' and reverse it, rather than skip
    // (which lets that payout pay clawed-back money with no reversal).
    const terminal = a.claimed && a.state === 'released' ? 'paid' : a.state

    if (terminal === 'paid') {
      // Node received its gross minus the carve of its own direct children.
      addTribute(a.resolvedAccountId, a.authorAccountId, a.amountPence - childrenGross(a.readEventId, a.tributeId))
      // EARNED side: a paid ROOT carve debited the author the full root gross at
      // payout (tribute_carve) — reverse it, restoring the author's earned. ROOT
      // only (child carves never debited the article author). account = author,
      // cp = inspirer, mirroring the forward tribute_carve.
      if (a.parentTributeId === null) addCarve(a.authorAccountId, a.resolvedAccountId, a.amountPence)
    } else {
      // released AND unclaimed — never paid out; prevent it, don't reverse.
      voidAccrualIds.push(a.id)
    }
  }

  const ledgerEntries: ReversalLedgerEntry[] = [
    // Reader: restore the clawed-back debt. Mirrors the original tab_settlement
    // (+amount) with −amount, so −SUM(reader entries) == reading_tabs.balance_pence holds.
    { accountId: readerId, counterpartyId: null, amountPence: -settlementAmountPence, trigger: 'tab_settlement_reversal' },
  ]
  for (const [accountId, amount] of writerReversal) {
    if (amount !== 0) ledgerEntries.push({ accountId, counterpartyId: null, amountPence: -amount, trigger: 'writer_payout_reversal' })
  }
  for (const e of tributeReversal.values()) {
    if (e.amount !== 0) ledgerEntries.push({ accountId: e.accountId, counterpartyId: e.counterpartyId, amountPence: -e.amount, trigger: 'tribute_payout_reversal' })
  }
  // EARNED-side reversals (disjoint trigger set from the paid-side ones above).
  for (const [accountId, amount] of accrualReversal) {
    if (amount !== 0) ledgerEntries.push({ accountId, counterpartyId: readerId, amountPence: -amount, trigger: 'writer_accrual_reversal' })
  }
  for (const e of carveReversal.values()) {
    if (e.amount !== 0) ledgerEntries.push({ accountId: e.accountId, counterpartyId: e.counterpartyId, amountPence: e.amount, trigger: 'tribute_carve_reversal' })
  }

  return {
    tabRestorePence: settlementAmountPence,
    ledgerEntries,
    chargeBackReadIds,
    voidAccrualIds,
  }
}

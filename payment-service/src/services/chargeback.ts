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
//   • accrual paid         → tribute_payout_reversal −(node_gross − Σ its direct
//                            children gross on R), acct=inspirer, cp=author.
//                            State LEFT 'paid' (the transfer really happened; the
//                            reversal is a separate ledger fact, so reconcile
//                            A9/A10a stay intact — they pair on the original
//                            trigger, never the *_reversal one).
//   • accrual returned     → reverse the swept share against whoever it returned
//                            to: kind 'writer' → author (writer_payout_reversal);
//                            kind 'tribute' → parent inspirer (tribute_payout_
//                            reversal). State left 'returned'.
//   • accrual held/released/swept, UNCLAIMED → 'voided' (never paid; just
//                            prevent it). No ledger.
//   • accrual held/released/swept, CLAIMED (a payout reserved it concurrently)
//                            → skip (left as-is). Rare chargeback-during-payout
//                            window; documented residual, not silently mis-handled.
//
// Conservation (telescoping): the author carves roots; each node carves its own
// direct children; a returned share is reversed against its recipient. For a
// read where every accrual resolved (all 'paid'/'returned'), the sum negates
// exactly what each account received → −read_net. Money never paid out (held/
// swept-voided, platform_settled reads) is correctly NOT reversed — it is
// prevented instead, and the platform simply keeps the held float it never
// disbursed. Degrades to the platform-wide case with zero accruals: author net =
// read_net, so the writer reversal is the full read net — no tribute branch
// needed, no flag gate (data-driven).
// =============================================================================

export interface ReversalRead {
  id: string
  amountPence: number
  /** 'platform_settled' | 'writer_paid' */
  state: string
  writerId: string
}

export interface ReversalVote {
  id: string
  amountPence: number
  state: string
  recipientId: string | null
}

export interface ReversalAccrual {
  id: string
  readEventId: string
  tributeId: string
  parentTributeId: string | null
  amountPence: number
  /** held | released | paid | swept | returned (voided rows are excluded upstream) */
  state: string
  /** tribute.resolved_account_id — the inspirer (party-of-funds for this node). */
  resolvedAccountId: string
  /** tribute.author_account_id — the party whose share was redirected to the node. */
  authorAccountId: string
  /** Parent tribute's resolved/author, for reversing a 'returned' (kind 'tribute') share. */
  parentResolvedAccountId: string | null
  parentAuthorAccountId: string | null
  /** 'writer' | 'tribute' | null — how a swept share was/returned. */
  sweptReturnKind: string | null
  /** True if a payout has reserved this accrual (tribute_payout_id or swept_return_payout_id set). */
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
  chargeBackVoteIds: string[]
  voidAccrualIds: string[]
}

export interface ReversalInput {
  readerId: string
  settlementAmountPence: number
  reads: ReversalRead[]
  votes: ReversalVote[]
  accruals: ReversalAccrual[]
  platformFeeBps: number
}

export function computeChargebackReversal(input: ReversalInput): ReversalPlan {
  const { readerId, settlementAmountPence, reads, votes, accruals, platformFeeBps } = input

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

  const chargeBackReadIds: string[] = []
  for (const r of reads) {
    chargeBackReadIds.push(r.id)
    if (r.state === 'writer_paid') {
      // Author's actual receipt for R = read net minus the carve of its DIRECT
      // children — the roots (the author's depth-0 children), matching the
      // state-agnostic carve at payout. Zero accruals ⇒ full read net.
      const authorNet = perReadNetPence(r.amountPence, platformFeeBps) - rootGross(r.id)
      if (authorNet !== 0) addWriter(r.writerId, authorNet)
    }
  }

  const chargeBackVoteIds: string[] = []
  for (const v of votes) {
    chargeBackVoteIds.push(v.id)
    if (v.state === 'writer_paid' && v.recipientId) {
      addWriter(v.recipientId, perReadNetPence(v.amountPence, platformFeeBps))
    }
  }

  const voidAccrualIds: string[] = []
  for (const a of accruals) {
    if (a.state === 'paid') {
      // Node received its gross minus the carve of its own direct children.
      addTribute(a.resolvedAccountId, a.authorAccountId, a.amountPence - childrenGross(a.readEventId, a.tributeId))
    } else if (a.state === 'returned') {
      // The swept share was paid back to its recipient — reverse against them.
      if (a.sweptReturnKind === 'writer') {
        addWriter(a.authorAccountId, a.amountPence) // root → article author, via writer payout
      } else if (a.sweptReturnKind === 'tribute' && a.parentResolvedAccountId) {
        addTribute(a.parentResolvedAccountId, a.parentAuthorAccountId, a.amountPence)
      }
    } else if (a.state === 'held' || a.state === 'released' || a.state === 'swept') {
      // Never paid out — prevent it, don't reverse. Skip if a payout already
      // reserved it (concurrent-payout window — leave for that payout to resolve).
      if (!a.claimed) voidAccrualIds.push(a.id)
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

  return {
    tabRestorePence: settlementAmountPence,
    ledgerEntries,
    chargeBackReadIds,
    chargeBackVoteIds,
    voidAccrualIds,
  }
}

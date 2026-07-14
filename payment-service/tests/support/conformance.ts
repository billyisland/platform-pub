// =============================================================================
// Shared helpers for the saga conformance battery (PAYMENTS ADR §1.1 step 1).
//
// The classifiers (src/lib/charge-errors.ts) key purely on `err.type`, so a
// plainly-shaped object is enough to drive the terminal-vs-ambiguous branches
// faithfully — no need to mock the classifier itself.
//   • isTerminalChargeError   → StripeCardError | StripeInvalidRequestError
//   • isTerminalTransferError → StripeInvalidRequestError ONLY (narrower: the
//                               transfer failure mode is double-PAY)
// =============================================================================

/** Terminal for a CHARGE (decline / SCA / unusable card). Ambiguous for a transfer. */
export const cardDeclined = (code = 'card_declined') => ({ type: 'StripeCardError', code })

/** Terminal for BOTH charge and transfer (a deterministic 400 — nothing created). */
export const invalidRequest = (code = 'parameter_invalid') => ({
  type: 'StripeInvalidRequestError',
  code,
})

/** AMBIGUOUS for both: the resource may have been created before the response
 *  was lost, so the flow must re-throw and leave the row pending for resume. */
export const connectionError = () => ({ type: 'StripeConnectionError' })
export const apiError = () => ({ type: 'StripeAPIError' })
export const rateLimitError = () => ({ type: 'StripeRateLimitError' })

/** A ledger_entries row as captured by a battery file's scripted client. */
export interface LedgerRow {
  account: string
  counterparty: string | null
  amount: number
  trigger: string
  refTable?: string
  refId?: string
}

/**
 * Reader-tab parity — the money-ledger invariant that has actually lost money
 * here: reading_tabs.balance_pence == −SUM(the reader's tab-affecting entries).
 * Filtered to the reader account (writer/tribute earned entries live on other
 * accounts and never move the reader's tab).
 */
export function readerParity(ledger: LedgerRow[], readerId: string, balance: number): boolean {
  const sum = ledger
    .filter((e) => e.account === readerId)
    .reduce((s, e) => s + e.amount, 0)
  return -sum === balance
}

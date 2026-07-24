import { request } from './client'

// Closed-beta waiting list (CLOSED-BETA-ADR Phase 2). The endpoint is
// enumeration-safe — it returns the same generic acknowledgement whether the
// email is new or already on the list — so the UI treats every 2xx the same.
export const waitlist = {
  join: (input: { email: string; publishInterest?: boolean }) =>
    request<{ ok: boolean; message: string }>('/waitlist', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
}

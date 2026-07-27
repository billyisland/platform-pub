'use client'

import { useEffect, useState } from 'react'
import { adminDashboard, type AdminWaitlist } from '../../../lib/api'
import { AdminShell } from '../../../components/admin/AdminShell'
import { StatCard, StatGrid, StatSection } from '../../../components/admin/Stat'

// =============================================================================
// Waitlist panel — the read half (CLOSED-BETA-ADR §XI.2).
//
// The list has been write-only since migration 162: POST /waitlist stores a
// prospect, nothing read the table, and on 2026-07-27 a real prospect went
// unnoticed for eight hours because the only way to look was psql on the box.
// The digest (§XI.4) now says the count moved; this page says who.
//
// NO ACTIONS HERE. Admit is the next item and needs `admitted_at` on the row to
// be safe — a button with nothing recording it is a double-admit waiting to
// happen. So this page is honest about what it cannot do rather than offering
// a control that half-works.
//
// ABSOLUTE DATES, NOT "3d ago". An operator picking a cohort wants to know
// whether someone has been waiting since the launch post or since this morning,
// and a relative stamp makes that arithmetic the reader's job.
//
// THE DOMAIN IS THE TRIAGE, AND IT IS ALREADY ON SCREEN. Disposable-mail
// signups will happen (one of the first three real rows was one). Nothing here
// filters or flags them: the address is right there to read, and auto-judging a
// domain is a policy decision with false positives that belongs to a person.
// =============================================================================

/** `27 Jul 2026, 08:55` — the same absolute stamp the digest email uses. */
function joined(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function AdminWaitlistPage() {
  const [data, setData] = useState<AdminWaitlist | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    adminDashboard
      .waitlist()
      .then(setData)
      .catch(() => setError('Failed to load the waiting list.'))
  }, [])

  return (
    <AdminShell title="Site owner">
      {error && (
        <div className="bg-glasshouse-well px-4 py-3 text-ui-xs text-black mb-8">{error}</div>
      )}
      {!data && !error && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 animate-pulse bg-white" />
          ))}
        </div>
      )}
      {data && (
        <>
          <StatSection label="The waiting list">
            <StatGrid>
              <StatCard label="Total waiting" value={data.totals.total} />
              <StatCard label="Joined, 7 days" value={data.totals.joinedLast7d} />
              <StatCard
                label="Want to publish"
                value={data.totals.publishInterest}
                detail="Ticked the opt-in"
              />
              <StatCard
                label="Last digest"
                value={data.lastDigestAt ? joined(data.lastDigestAt) : 'Never'}
                detail={data.lastDigestAt ? undefined : 'Nobody has been told yet'}
                warn={!data.lastDigestAt && data.totals.total > 0}
              />
            </StatGrid>
          </StatSection>

          <StatSection
            label="Everyone waiting"
            helper="Newest first. Admitting someone is still manual — there is no action here yet."
          >
            {data.totals.total === 0 ? (
              <p className="text-ui-sm text-grey-600">
                Nobody has joined yet.
              </p>
            ) : (
              <div className="bg-glasshouse-well px-6 py-5">
                <table className="w-full text-ui-xs">
                  <thead>
                    <tr className="border-b-2 border-grey-200">
                      <th className="label-ui text-grey-600 text-left pb-2">Email</th>
                      <th className="label-ui text-grey-600 text-left pb-2">Publish</th>
                      <th className="label-ui text-grey-600 text-right pb-2">Joined</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.entries.map((e) => (
                      <tr key={e.email}>
                        <td className="py-2 text-black">{e.email}</td>
                        <td className="py-2 text-grey-600">
                          {e.publishInterest ? 'Yes' : '—'}
                        </td>
                        <td className="py-2 text-right tabular-nums text-grey-600">
                          {joined(e.joinedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {data.truncated && (
              <p className="text-ui-xs text-grey-600 mt-3">
                Showing the {data.shown} most recent of {data.totals.total}. The rest are in
                the <span className="font-mono">waitlist</span> table.
              </p>
            )}
          </StatSection>

          <p className="text-ui-xs text-grey-600">
            Nothing on this page writes to anyone. Joining sends no email by design, and
            admitting a prospect — creating their account and inviting them — is still a
            manual step outside the dashboard.
          </p>
        </>
      )}
    </AdminShell>
  )
}

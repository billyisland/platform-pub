'use client'

import { useState, useEffect } from 'react'
import { subscriptionOffers, type SubscriptionOffer } from '../../lib/api'

type FormMode = null | 'code' | 'grant'

export function OffersTab() {
  const [offers, setOffers] = useState<SubscriptionOffer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [formMode, setFormMode] = useState<FormMode>(null)
  const [creating, setCreating] = useState(false)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // Form fields
  const [label, setLabel] = useState('')
  const [discountPct, setDiscountPct] = useState(100)
  const [durationMonths, setDurationMonths] = useState<number | null>(null)
  const [maxRedemptions, setMaxRedemptions] = useState<number | null>(null)
  const [expiresAt, setExpiresAt] = useState('')
  const [recipientUsername, setRecipientUsername] = useState('')

  useEffect(() => {
    (async () => {
      setLoading(true)
      try {
        const res = await subscriptionOffers.list()
        setOffers(res.offers)
      } catch {
        setError('Failed to load offers.')
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  function resetForm() {
    setFormMode(null)
    setLabel('')
    setDiscountPct(100)
    setDurationMonths(null)
    setMaxRedemptions(null)
    setExpiresAt('')
    setRecipientUsername('')
  }

  async function handleCreate() {
    if (!formMode || !label.trim()) return
    setCreating(true)
    setError(null)
    try {
      const result = await subscriptionOffers.create({
        label: label.trim(),
        mode: formMode,
        discountPct,
        durationMonths,
        maxRedemptions: formMode === 'code' ? maxRedemptions : 1,
        expiresAt: expiresAt || null,
        recipientUsername: formMode === 'grant' ? recipientUsername : undefined,
      })

      // Reload the list to get the full offer object
      const res = await subscriptionOffers.list()
      setOffers(res.offers)
      resetForm()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create offer.')
    } finally {
      setCreating(false)
    }
  }

  async function handleRevoke(offerId: string) {
    setRevokingId(offerId)
    try {
      await subscriptionOffers.revoke(offerId)
      setOffers(prev => prev.map(o => o.id === offerId ? { ...o, revoked: true } : o))
    } catch {
      setError('Failed to revoke offer.')
    } finally {
      setRevokingId(null)
    }
  }

  function copyUrl(code: string, offerId: string) {
    const url = `${window.location.origin}/subscribe/${code}`
    navigator.clipboard.writeText(url)
    setCopiedId(offerId)
    setTimeout(() => setCopiedId(null), 2000)
  }

  if (loading) return <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-10 animate-pulse bg-white" />)}</div>

  const active = offers.filter(o => !o.revoked)
  const revoked = offers.filter(o => o.revoked)

  return (
    <div className="space-y-6">
      {error && <div className="bg-red-50 px-4 py-3 text-ui-xs text-red-700">{error}</div>}

      {/* Action buttons */}
      {!formMode && (
        <div className="flex items-center gap-4">
          <button
            onClick={() => setFormMode('code')}
            className="text-ui-xs text-black underline underline-offset-4 hover:opacity-70"
          >
            New offer code
          </button>
          <button
            onClick={() => setFormMode('grant')}
            className="text-ui-xs text-black underline underline-offset-4 hover:opacity-70"
          >
            Gift subscription
          </button>
        </div>
      )}

      {/* Create form */}
      {formMode && (
        <div className="bg-white px-5 py-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="label-ui text-black">
              {formMode === 'code' ? 'New offer code' : 'Gift subscription'}
            </h3>
            <button onClick={resetForm} className="text-ui-xs text-grey-300 hover:text-black">Cancel</button>
          </div>

          <div className="space-y-3">
            <div>
              <label className="label-ui text-grey-400 mb-1 block">Label</label>
              <input
                type="text"
                value={label}
                onChange={e => setLabel(e.target.value)}
                placeholder={formMode === 'code' ? 'e.g. Launch discount' : 'e.g. Comp for Jane'}
                className="w-full bg-grey-100 px-3 py-1.5 text-sm focus:outline-none"
              />
            </div>

            <div className="flex items-center gap-4">
              <div>
                <label className="label-ui text-grey-400 mb-1 block">Discount %</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={discountPct}
                  onChange={e => setDiscountPct(parseInt(e.target.value, 10) || 0)}
                  className="w-20 bg-grey-100 px-3 py-1.5 text-sm focus:outline-none"
                />
              </div>
              <div>
                <label className="label-ui text-grey-400 mb-1 block">Duration</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={120}
                    value={durationMonths ?? ''}
                    onChange={e => setDurationMonths(e.target.value ? parseInt(e.target.value, 10) : null)}
                    placeholder="—"
                    className="w-16 bg-grey-100 px-3 py-1.5 text-sm focus:outline-none"
                  />
                  <span className="text-ui-xs text-grey-400">months (blank = permanent)</span>
                </div>
              </div>
            </div>

            {formMode === 'code' && (
              <div className="flex items-center gap-4">
                <div>
                  <label className="label-ui text-grey-400 mb-1 block">Max redemptions</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={100000}
                      value={maxRedemptions ?? ''}
                      onChange={e => setMaxRedemptions(e.target.value ? parseInt(e.target.value, 10) : null)}
                      placeholder="—"
                      className="w-20 bg-grey-100 px-3 py-1.5 text-sm focus:outline-none"
                    />
                    <span className="text-ui-xs text-grey-400">blank = unlimited</span>
                  </div>
                </div>
                <div>
                  <label className="label-ui text-grey-400 mb-1 block">Expires</label>
                  <input
                    type="date"
                    value={expiresAt}
                    onChange={e => setExpiresAt(e.target.value)}
                    className="bg-grey-100 px-3 py-1.5 text-sm focus:outline-none"
                  />
                </div>
              </div>
            )}

            {formMode === 'grant' && (
              <div>
                <label className="label-ui text-grey-400 mb-1 block">Recipient username</label>
                <input
                  type="text"
                  value={recipientUsername}
                  onChange={e => setRecipientUsername(e.target.value)}
                  placeholder="username"
                  className="w-48 bg-grey-100 px-3 py-1.5 text-sm focus:outline-none"
                />
              </div>
            )}
          </div>

          <button
            onClick={handleCreate}
            disabled={creating || !label.trim() || (formMode === 'grant' && !recipientUsername.trim())}
            className="btn disabled:opacity-50"
          >
            {creating ? 'Creating…' : formMode === 'code' ? 'Create offer code' : 'Grant subscription'}
          </button>
        </div>
      )}

      {/* Active offers */}
      {active.length > 0 && (
        <div className="overflow-x-auto bg-white">
          <table className="w-full text-ui-xs">
            <thead>
              <tr className="border-b-2 border-grey-200">
                <th className="px-4 py-3 text-left label-ui text-grey-400">Label</th>
                <th className="px-4 py-3 text-left label-ui text-grey-400">Type</th>
                <th className="px-4 py-3 text-right label-ui text-grey-400">Discount</th>
                <th className="px-4 py-3 text-right label-ui text-grey-400">Duration</th>
                <th className="px-4 py-3 text-right label-ui text-grey-400">Redeemed</th>
                <th className="px-4 py-3 text-right label-ui text-grey-400">Actions</th>
              </tr>
            </thead>
            <tbody>
              {active.map(offer => (
                <tr key={offer.id} className="border-b-2 border-grey-200 last:border-b-0">
                  <td className="px-4 py-3">{offer.label}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 text-[11px] font-mono ${offer.mode === 'code' ? 'bg-grey-100 text-grey-600' : 'bg-grey-100 text-crimson'}`}>
                      {offer.mode === 'code' ? 'code' : `grant → ${offer.recipientUsername ?? '?'}`}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {offer.discountPct}%{offer.discountPct === 100 ? ' (free)' : ''}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-grey-400">
                    {offer.durationMonths ? `${offer.durationMonths}mo` : 'permanent'}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {offer.redemptionCount}{offer.maxRedemptions ? `/${offer.maxRedemptions}` : ''}
                  </td>
                  <td className="px-4 py-3 text-right space-x-3">
                    {offer.code && (
                      <button
                        onClick={() => copyUrl(offer.code!, offer.id)}
                        className="text-grey-400 hover:text-black"
                      >
                        {copiedId === offer.id ? 'Copied!' : 'Copy link'}
                      </button>
                    )}
                    <button
                      onClick={() => handleRevoke(offer.id)}
                      disabled={revokingId === offer.id}
                      className="text-grey-300 hover:text-black disabled:opacity-50"
                    >
                      {revokingId === offer.id ? '…' : 'Revoke'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {active.length === 0 && !formMode && (
        <div className="py-16 text-center">
          <p className="text-ui-sm text-grey-400 mb-2">No active offers.</p>
          <p className="text-ui-xs text-grey-300">Create an offer code to share discounted subscriptions, or gift a subscription to a specific reader.</p>
        </div>
      )}

      {/* Revoked offers */}
      {revoked.length > 0 && (
        <details className="text-ui-xs">
          <summary className="text-grey-300 cursor-pointer hover:text-grey-600">
            {revoked.length} revoked
          </summary>
          <div className="mt-2 space-y-1">
            {revoked.map(offer => (
              <div key={offer.id} className="flex items-center gap-3 text-grey-300 py-1">
                <span className="line-through">{offer.label}</span>
                <span className="font-mono text-[11px]">{offer.mode}</span>
                <span>{offer.discountPct}%</span>
                <span className="tabular-nums">{offer.redemptionCount} redeemed</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

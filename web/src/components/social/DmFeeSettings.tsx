'use client'

import { useState, useEffect } from 'react'
import { dmPricing, type DmPricingOverride } from '../../lib/api'

export function DmFeeSettings() {
  const [dmPrice, setDmPrice] = useState('')
  const [dmOverrides, setDmOverrides] = useState<DmPricingOverride[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [overrideUsername, setOverrideUsername] = useState('')
  const [overridePrice, setOverridePrice] = useState('')
  const [addingOverride, setAddingOverride] = useState(false)

  useEffect(() => {
    dmPricing.get().then(data => {
      setDmPrice(data.defaultPricePence > 0 ? (data.defaultPricePence / 100).toFixed(2) : '')
      setDmOverrides(data.overrides)
    }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  return (
    <div>
      <p className="label-ui text-grey-400 mb-4">DM access</p>
      <p className="text-ui-xs text-grey-600 leading-relaxed mb-4">
        Discourage unwanted messages by setting a fee for DMs from people you don&apos;t follow. Set to £0 or leave blank for free.
      </p>

      {loading ? (
        <div className="h-8 w-48 animate-pulse bg-grey-100" />
      ) : (
        <>
          <form onSubmit={async (e) => {
            e.preventDefault()
            const pence = dmPrice.trim() ? Math.round(parseFloat(dmPrice) * 100) : 0
            if (isNaN(pence) || pence < 0) { setMsg('Enter a valid price.'); return }
            setSaving(true); setMsg(null)
            try {
              await dmPricing.update(pence)
              setMsg('DM pricing updated.')
            } catch { setMsg('Failed to update.') }
            finally { setSaving(false) }
          }} className="space-y-4 mb-6">
            <div className="flex items-center gap-3">
              <span className="text-[14px] font-sans text-grey-400">£</span>
              <input
                type="number"
                step="0.01"
                min="0"
                max="100"
                value={dmPrice}
                onChange={(e) => setDmPrice(e.target.value)}
                className="w-28 bg-grey-100 px-3 py-1.5 text-[14px] font-sans text-black placeholder-grey-300"
                placeholder="0.00"
              />
              <span className="text-[13px] font-sans text-grey-300">per message</span>
            </div>
            <button type="submit" disabled={saving} className="btn text-sm disabled:opacity-50">
              {saving ? 'Saving...' : 'Save'}
            </button>
          </form>
          {msg && <p className="text-[13px] font-sans text-grey-600 mb-4">{msg}</p>}

          <details className="text-ui-xs">
            <summary className="text-grey-400 cursor-pointer hover:text-grey-600 mb-3">
              Per-user overrides ({dmOverrides.length})
            </summary>

            {dmOverrides.length > 0 && (
              <div className="space-y-1 mb-4">
                {dmOverrides.map(o => (
                  <div key={o.userId} className="flex items-center justify-between py-1">
                    <span className="text-black">{o.displayName ?? o.username} <span className="text-grey-300">@{o.username}</span></span>
                    <div className="flex items-center gap-3">
                      <span className="tabular-nums">{o.pricePence === 0 ? 'Free' : `£${(o.pricePence / 100).toFixed(2)}`}</span>
                      <button
                        onClick={async () => {
                          try {
                            await dmPricing.removeOverride(o.userId)
                            setDmOverrides(prev => prev.filter(x => x.userId !== o.userId))
                          } catch {}
                        }}
                        className="text-grey-300 hover:text-black"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <form onSubmit={async (e) => {
              e.preventDefault()
              if (!overrideUsername.trim()) return
              setAddingOverride(true)
              try {
                const res = await fetch(`/api/v1/search?q=${encodeURIComponent(overrideUsername.trim())}&type=writers`, { credentials: 'include' })
                const data = await res.json()
                const found = data.results?.[0]
                if (!found) { setMsg('User not found.'); setAddingOverride(false); return }
                const pence = overridePrice.trim() ? Math.round(parseFloat(overridePrice) * 100) : 0
                await dmPricing.setOverride(found.id, pence)
                setDmOverrides(prev => [...prev.filter(x => x.userId !== found.id), {
                  userId: found.id,
                  username: found.username,
                  displayName: found.displayName,
                  pricePence: pence,
                }])
                setOverrideUsername('')
                setOverridePrice('')
              } catch { setMsg('Failed to add override.') }
              finally { setAddingOverride(false) }
            }} className="flex items-center gap-2">
              <input
                type="text"
                value={overrideUsername}
                onChange={(e) => setOverrideUsername(e.target.value)}
                placeholder="Username"
                className="w-32 bg-grey-100 px-2 py-1 text-[13px] font-sans text-black placeholder-grey-300"
              />
              <span className="text-[13px] font-sans text-grey-400">£</span>
              <input
                type="number"
                step="0.01"
                min="0"
                max="100"
                value={overridePrice}
                onChange={(e) => setOverridePrice(e.target.value)}
                placeholder="0.00"
                className="w-20 bg-grey-100 px-2 py-1 text-[13px] font-sans text-black placeholder-grey-300"
              />
              <button type="submit" disabled={addingOverride} className="text-ui-xs text-black underline underline-offset-4 hover:opacity-70 disabled:opacity-50">
                {addingOverride ? '...' : 'Add'}
              </button>
            </form>
          </details>
        </>
      )}
    </div>
  )
}

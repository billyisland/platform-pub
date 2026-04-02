'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '../../stores/auth'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { myArticles, account as accountApi, type MyArticle } from '../../lib/api'
import { loadDrafts, deleteDraft } from '../../lib/drafts'
import { KIND_DELETION } from '../../lib/ndk'
import { signAndPublish } from '../../lib/sign'
import { DrivesTab } from '../../components/dashboard/DrivesTab'
import { FreePassManager } from '../../components/dashboard/FreePassManager'

type DashboardTab = 'articles' | 'drafts' | 'drives' | 'settings'

export default function DashboardPage() {
  const { user, loading } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const rawTab = searchParams.get('tab')
  const initialTab: DashboardTab = (rawTab as DashboardTab) || 'articles'
  const [activeTab, setActiveTab] = useState<DashboardTab>(initialTab)

  useEffect(() => { if (!loading && !user) router.push('/auth?mode=login') }, [user, loading, router])

  // Sync tab from URL (for notification deep-linking)
  useEffect(() => {
    if (rawTab && ['articles', 'drafts', 'drives', 'settings'].includes(rawTab)) {
      setActiveTab(rawTab as DashboardTab)
    }
  }, [rawTab])

  function switchTab(tab: DashboardTab) {
    setActiveTab(tab)
    const url = new URL(window.location.href); url.searchParams.set('tab', tab)
    window.history.replaceState({}, '', url.toString())
  }

  if (loading || !user) return <DashboardSkeleton />

  const tabs: DashboardTab[] = ['articles', 'drafts', 'drives', 'settings']

  return (
    <div className="mx-auto max-w-content px-6 py-10">
      <div className="flex items-center justify-between mb-10">
        <div className="flex gap-2">
          {tabs.map(tab => (
            <button key={tab} onClick={() => switchTab(tab)} className={`tab-pill ${activeTab === tab ? 'tab-pill-active' : 'tab-pill-inactive'}`}>{tab.charAt(0).toUpperCase() + tab.slice(1)}</button>
          ))}
        </div>
        <div className="flex items-center gap-4">
          <Link href="/account" className="text-ui-xs text-grey-400 hover:text-black underline underline-offset-4">View account</Link>
          <Link href="/write" className="btn">New article</Link>
        </div>
      </div>
      {activeTab === 'articles' && <ArticlesTab userId={user.id} pubkey={user.pubkey} />}
      {activeTab === 'drafts' && <DraftsTab />}
      {activeTab === 'drives' && <DrivesTab userId={user.id} />}
      {activeTab === 'settings' && <WriterSettingsTab stripeReady={user.stripeConnectKycComplete} />}
    </div>
  )
}

// =============================================================================
// Articles Tab — with free pass overflow menu
// =============================================================================

function ArticlesTab({ userId, pubkey }: { userId: string; pubkey: string }) {
  const [articles, setArticles] = useState<MyArticle[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState<string | null>(null); const [deletingId, setDeletingId] = useState<string | null>(null)
  const [freePassArticleId, setFreePassArticleId] = useState<string | null>(null)
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)

  useEffect(() => { (async () => { setLoading(true); try { setArticles((await myArticles.list()).articles) } catch { setError('Failed to load articles.') } finally { setLoading(false) } })() }, [userId])
  async function handleToggleReplies(id: string, on: boolean) { try { await myArticles.update(id, { repliesEnabled: on }); setArticles(p => p.map(a => a.id === id ? { ...a, repliesEnabled: on } : a)) } catch { setError('Failed to update.') } }
  async function handleDelete(id: string) {
    setDeletingId(id)
    try {
      const result = await myArticles.remove(id)
      setArticles(p => p.filter(a => a.id !== id))
      try {
        await signAndPublish({
          kind: KIND_DELETION,
          content: '',
          tags: [['e', result.nostrEventId], ['a', `30023:${pubkey}:${result.dTag}`]],
        })
      } catch { /* non-fatal */ }
    }
    catch { setError('Failed to delete.') }
    finally { setDeletingId(null) }
  }

  if (loading) return <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-10 animate-pulse bg-white" />)}</div>
  if (error) return <div className="bg-white px-4 py-3 text-ui-xs text-black">{error}</div>
  if (articles.length === 0) return <div className="py-20 text-center"><p className="text-ui-sm text-grey-400 mb-4">No published articles yet.</p><Link href="/write" className="text-ui-xs text-black underline underline-offset-4">Write your first article</Link></div>

  return (
    <div className="overflow-x-auto bg-white">
      <table className="w-full text-ui-xs">
        <thead><tr className="border-b-2 border-grey-200"><th className="px-4 py-3 text-left label-ui text-grey-400">Title</th><th className="px-4 py-3 text-left label-ui text-grey-400">Status</th><th className="px-4 py-3 text-right label-ui text-grey-400">Reads</th><th className="px-4 py-3 text-right label-ui text-grey-400">Earned</th><th className="px-4 py-3 text-center label-ui text-grey-400">Replies</th><th className="px-4 py-3 text-right label-ui text-grey-400">Actions</th></tr></thead>
        <tbody>{articles.map(a => (
          <tr key={a.id} className="border-b-2 border-grey-200 last:border-b-0">
            <td className="px-4 py-3"><Link href={`/article/${a.dTag}`} className="text-black hover:opacity-70">{a.title}</Link></td>
            <td className="px-4 py-3">{a.isPaywalled ? <span className="text-black">£{((a.pricePence??0)/100).toFixed(2)}</span> : <span className="text-grey-400">Free</span>}</td>
            <td className="px-4 py-3 text-right tabular-nums">{a.readCount}</td>
            <td className="px-4 py-3 text-right text-black tabular-nums">£{(a.netEarningsPence/100).toFixed(2)}</td>
            <td className="px-4 py-3 text-center"><button onClick={() => handleToggleReplies(a.id, !a.repliesEnabled)} className={`text-ui-xs ${a.repliesEnabled ? 'text-crimson' : 'text-grey-300'}`}>{a.repliesEnabled ? 'On' : 'Off'}</button></td>
            <td className="px-4 py-3 text-right">
              <div className="flex items-center justify-end gap-3">
                <Link href={`/write?edit=${a.nostrEventId}`} className="text-grey-400 hover:text-black">Edit</Link>
                <button onClick={() => handleDelete(a.id)} disabled={deletingId===a.id} className="text-grey-300 hover:text-black disabled:opacity-50">{deletingId===a.id ? '...' : 'Delete'}</button>
                {a.isPaywalled && (
                  <div className="relative">
                    <button
                      onClick={() => setMenuOpenId(menuOpenId === a.id ? null : a.id)}
                      className="text-grey-300 hover:text-black text-lg leading-none"
                      title="More actions"
                    >
                      &#8943;
                    </button>
                    {menuOpenId === a.id && (
                      <div className="absolute right-0 top-full mt-1 w-40 bg-white border border-grey-200 shadow-lg z-10">
                        <button
                          onClick={() => { setFreePassArticleId(freePassArticleId === a.id ? null : a.id); setMenuOpenId(null) }}
                          className="block w-full text-left px-3 py-2 text-[13px] font-sans text-black hover:bg-grey-100"
                        >
                          Free passes
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </td>
          </tr>
        ))}
        </tbody>
      </table>

      {/* Free pass inline panel */}
      {freePassArticleId && (
        <FreePassManager articleId={freePassArticleId} />
      )}
    </div>
  )
}

// =============================================================================
// Drafts Tab
// =============================================================================

function DraftsTab() {
  const [drafts, setDrafts] = useState<any[]>([]); const [loading, setLoading] = useState(true)
  useEffect(() => { (async () => { setLoading(true); try { setDrafts(await loadDrafts()) } catch {} finally { setLoading(false) } })() }, [])
  async function handleDelete(id: string) { try { await deleteDraft(id); setDrafts(p => p.filter((d:any) => d.draftId !== id)) } catch {} }
  if (loading) return <div className="space-y-3">{[1,2].map(i => <div key={i} className="h-8 animate-pulse bg-white" />)}</div>
  if (drafts.length === 0) return <div className="py-20 text-center"><p className="text-ui-sm text-grey-400 mb-4">No saved drafts.</p><Link href="/write" className="text-ui-xs text-black underline underline-offset-4">Start writing</Link></div>
  return <div className="space-y-2">{drafts.map((d:any) => <div key={d.draftId} className="flex items-center justify-between bg-white px-4 py-3"><div><p className="text-ui-sm text-black">{d.title||'Untitled'}</p><p className="text-ui-xs text-grey-300 mt-0.5">Last saved {new Date(d.autoSavedAt).toLocaleDateString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</p></div><div className="flex items-center gap-4"><Link href={`/write?draft=${d.draftId}`} className="text-ui-xs text-black hover:text-black">Continue</Link><button onClick={() => handleDelete(d.draftId)} className="text-ui-xs text-grey-300 hover:text-black">Delete</button></div></div>)}</div>
}

// =============================================================================
// Writer Settings Tab — subscription price, Stripe status
// =============================================================================

function WriterSettingsTab({ stripeReady }: { stripeReady: boolean }) {
  const { user, fetchMe } = useAuth()
  const [subPrice, setSubPrice] = useState('')
  const [savingPrice, setSavingPrice] = useState(false)
  const [priceMsg, setPriceMsg] = useState<string | null>(null)

  async function handleSavePrice(e: React.FormEvent) {
    e.preventDefault()
    const pence = Math.round(parseFloat(subPrice) * 100)
    if (isNaN(pence) || pence < 0) { setPriceMsg('Enter a valid price.'); return }
    setSavingPrice(true); setPriceMsg(null)
    try {
      await accountApi.updateSubscriptionPrice(pence)
      setPriceMsg('Subscription price updated.')
    } catch { setPriceMsg('Failed to update.') }
    finally { setSavingPrice(false) }
  }

  return (
    <div className="space-y-8">
      {/* Subscription price */}
      <div className="bg-white px-6 py-5">
        <p className="label-ui text-grey-400 mb-4">Subscription price</p>
        <p className="text-ui-xs text-grey-600 leading-relaxed mb-4">
          Set the monthly price readers pay to subscribe to your content. Set to £0 to disable subscriptions.
        </p>
        <form onSubmit={handleSavePrice} className="flex items-center gap-3">
          <span className="text-[14px] font-sans text-grey-400">£</span>
          <input
            type="number"
            step="0.01"
            min="0"
            value={subPrice}
            onChange={(e) => setSubPrice(e.target.value)}
            className="w-28 border border-grey-200 px-3 py-1.5 text-[14px] font-sans text-black placeholder-grey-300"
            placeholder="3.00"
          />
          <span className="text-[13px] font-sans text-grey-300">/month</span>
          <button type="submit" disabled={savingPrice} className="btn text-sm disabled:opacity-50">
            {savingPrice ? 'Saving…' : 'Save'}
          </button>
        </form>
        {priceMsg && <p className="text-[13px] font-sans text-grey-600 mt-2">{priceMsg}</p>}
      </div>

      {/* Stripe Connect status */}
      <div className="bg-white px-6 py-5">
        <p className="label-ui text-grey-400 mb-4">Stripe Connect</p>
        {stripeReady ? (
          <div className="flex items-center justify-between">
            <div>
              <p className="text-ui-sm text-black">Verified</p>
              <p className="text-ui-xs text-grey-300 mt-0.5">Payouts are enabled.</p>
            </div>
            <span className="text-ui-xs text-grey-400">Active</span>
          </div>
        ) : (
          <div>
            <p className="text-ui-xs text-grey-600 mb-3">Connect Stripe to receive payouts from articles and subscriptions.</p>
            <Link href="/settings" className="text-ui-xs text-crimson underline underline-offset-4">
              Set up Stripe Connect
            </Link>
          </div>
        )}
      </div>

      {/* DM pricing placeholder */}
      <div className="bg-white px-6 py-5">
        <p className="label-ui text-grey-400 mb-4">DM pricing</p>
        <p className="text-ui-xs text-grey-300">Coming soon — set a price for direct messages from non-followers.</p>
      </div>
    </div>
  )
}

// =============================================================================
// Skeleton
// =============================================================================

function DashboardSkeleton() {
  return <div className="mx-auto max-w-content px-6 py-10"><div className="flex gap-2 mb-10">{[1,2,3,4].map(i => <div key={i} className="h-9 w-24 animate-pulse bg-white"/>)}</div><div className="grid grid-cols-1 gap-4 sm:grid-cols-3">{[1,2,3].map(i => <div key={i} className="bg-white p-6"><div className="h-3 w-20 animate-pulse bg-grey-100 mb-3"/><div className="h-7 w-28 animate-pulse bg-grey-100"/></div>)}</div></div>
}

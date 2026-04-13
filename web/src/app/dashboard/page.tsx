'use client'

import React, { useState, useEffect } from 'react'
import { useAuth } from '../../stores/auth'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { myArticles, account as accountApi, publications as pubApi, type MyArticle, type PublicationMembership } from '../../lib/api'
import { loadDrafts, deleteDraft } from '../../lib/drafts'
import { KIND_DELETION } from '../../lib/ndk'
import { signAndPublish } from '../../lib/sign'
import { DrivesTab } from '../../components/dashboard/DrivesTab'
import { OffersTab } from '../../components/dashboard/OffersTab'
import { GiftLinksPanel } from '../../components/dashboard/GiftLinksPanel'
import { PublicationArticlesTab } from '../../components/dashboard/PublicationArticlesTab'
import { MembersTab } from '../../components/dashboard/MembersTab'
import { PublicationSettingsTab } from '../../components/dashboard/PublicationSettingsTab'
import { RateCardTab } from '../../components/dashboard/RateCardTab'
import { PayrollTab } from '../../components/dashboard/PayrollTab'
import { PublicationEarningsTab } from '../../components/dashboard/PublicationEarningsTab'
import { SubscribersTab } from '../../components/dashboard/SubscribersTab'

type DashboardTab = 'articles' | 'drafts' | 'subscribers' | 'drives' | 'offers' | 'pricing'
type PubDashboardTab = 'articles' | 'members' | 'settings' | 'rate-card' | 'payroll' | 'earnings'

export default function DashboardPage() {
  const { user, loading } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const rawTab = searchParams.get('tab')
  const contextSlug = searchParams.get('context')
  const resolvedTab = rawTab === 'settings' ? 'pricing' : rawTab
  const initialTab: DashboardTab = (resolvedTab as DashboardTab) || 'articles'
  const [activeTab, setActiveTab] = useState<DashboardTab>(initialTab)
  const [pubTab, setPubTab] = useState<PubDashboardTab>((rawTab as PubDashboardTab) || 'articles')
  const [pubMemberships, setPubMemberships] = useState<PublicationMembership[]>([])
  const [selectedContext, setSelectedContext] = useState<string | null>(contextSlug)
  const [showNewPub, setShowNewPub] = useState(false)
  const [newPubName, setNewPubName] = useState('')
  const [newPubSlug, setNewPubSlug] = useState('')
  const [newPubSaving, setNewPubSaving] = useState(false)
  const [newPubError, setNewPubError] = useState<string | null>(null)

  useEffect(() => { if (!loading && !user) router.push('/auth?mode=login') }, [user, loading, router])

  // Load publication memberships
  useEffect(() => {
    if (!user) return
    pubApi.myMemberships()
      .then(res => setPubMemberships(res.publications))
      .catch(() => { /* non-critical */ })
  }, [user])

  // Sync tab from URL (for notification deep-linking)
  useEffect(() => {
    const tab = rawTab === 'settings' ? 'pricing' : rawTab
    if (selectedContext) {
      if (tab && ['articles', 'members', 'settings', 'rate-card', 'payroll', 'earnings'].includes(tab)) {
        setPubTab(tab as PubDashboardTab)
      }
    } else {
      if (tab && ['articles', 'drafts', 'drives', 'offers', 'pricing'].includes(tab)) {
        setActiveTab(tab as DashboardTab)
      }
    }
  }, [rawTab, selectedContext])

  // Sync context from URL
  useEffect(() => {
    setSelectedContext(contextSlug)
  }, [contextSlug])

  function switchTab(tab: DashboardTab) {
    setActiveTab(tab)
    const url = new URL(window.location.href); url.searchParams.set('tab', tab); url.searchParams.delete('context')
    window.history.replaceState({}, '', url.toString())
  }

  function switchPubTab(tab: PubDashboardTab) {
    setPubTab(tab)
    const url = new URL(window.location.href); url.searchParams.set('tab', tab)
    window.history.replaceState({}, '', url.toString())
  }

  function switchContext(slug: string | null) {
    setSelectedContext(slug)
    const url = new URL(window.location.href)
    if (slug) {
      url.searchParams.set('context', slug)
      url.searchParams.set('tab', 'articles')
      setPubTab('articles')
    } else {
      url.searchParams.delete('context')
      url.searchParams.set('tab', 'articles')
      setActiveTab('articles')
    }
    window.history.replaceState({}, '', url.toString())
  }

  async function handleCreatePublication(e: React.FormEvent) {
    e.preventDefault()
    const name = newPubName.trim()
    const slug = newPubSlug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
    if (!name || !slug) return
    setNewPubSaving(true); setNewPubError(null)
    try {
      const result = await pubApi.create({ name, slug })
      const memberships = await pubApi.myMemberships()
      setPubMemberships(memberships.publications)
      setShowNewPub(false); setNewPubName(''); setNewPubSlug('')
      switchContext(result.slug)
    } catch (err: any) {
      setNewPubError(err?.body?.error ?? err?.message ?? 'Failed to create publication.')
    } finally { setNewPubSaving(false) }
  }

  if (loading || !user) return <DashboardSkeleton />

  const selectedPub = pubMemberships.find(p => p.slug === selectedContext)
  const isPublicationContext = !!selectedPub

  const personalTabs: DashboardTab[] = ['articles', 'drafts', ...(user.isWriter ? ['subscribers' as DashboardTab] : []), 'drives', 'offers', 'pricing']
  const pubTabs: PubDashboardTab[] = [
    'articles', 'members', 'settings',
    ...(selectedPub?.can_manage_finances ? ['rate-card', 'payroll', 'earnings'] as PubDashboardTab[] : []),
  ]

  return (
    <div className="mx-auto max-w-content px-4 sm:px-6 py-10">
      {/* Context switcher */}
      <div className="flex items-center gap-2 mb-6 text-ui-xs flex-wrap">
        {pubMemberships.length > 0 && (
          <>
            <span className="text-grey-400">Dashboard:</span>
            <button
              onClick={() => switchContext(null)}
              className={`px-2 py-1 ${!isPublicationContext ? 'text-black font-medium' : 'text-grey-400 hover:text-black'}`}
            >
              Personal
            </button>
            {pubMemberships.map(p => (
              <button
                key={p.slug}
                onClick={() => switchContext(p.slug)}
                className={`px-2 py-1 ${selectedContext === p.slug ? 'text-black font-medium' : 'text-grey-400 hover:text-black'}`}
              >
                {p.name}
              </button>
            ))}
            <span className="text-grey-200">|</span>
          </>
        )}
        <button
          onClick={() => setShowNewPub(v => !v)}
          className="px-2 py-1 text-grey-400 hover:text-black transition-colors"
        >
          + New publication
        </button>
      </div>

      {showNewPub && (
        <form onSubmit={handleCreatePublication} className="mb-8 bg-white px-6 py-5 max-w-md space-y-4">
          <p className="label-ui text-grey-400">Create a publication</p>
          <div>
            <label htmlFor="pub-name" className="block text-ui-xs text-grey-300 mb-1">Name</label>
            <input
              id="pub-name"
              type="text"
              value={newPubName}
              onChange={(e) => {
                setNewPubName(e.target.value)
                if (!newPubSlug || newPubSlug === newPubName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')) {
                  setNewPubSlug(e.target.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
                }
              }}
              maxLength={80}
              placeholder="The Daily Dispatch"
              className="w-full bg-grey-100 px-3 py-2 text-sm text-black placeholder-grey-300 focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="pub-slug" className="block text-ui-xs text-grey-300 mb-1">URL slug</label>
            <div className="flex items-center text-sm text-grey-300">
              <span className="mr-1">/pub/</span>
              <input
                id="pub-slug"
                type="text"
                value={newPubSlug}
                onChange={(e) => setNewPubSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                maxLength={60}
                placeholder="daily-dispatch"
                className="flex-1 bg-grey-100 px-3 py-2 text-sm text-black placeholder-grey-300 focus:outline-none"
              />
            </div>
          </div>
          {newPubError && <p className="text-ui-xs text-red-600">{newPubError}</p>}
          <div className="flex items-center gap-3">
            <button type="submit" disabled={newPubSaving || !newPubName.trim() || !newPubSlug.trim()} className="btn disabled:opacity-50">
              {newPubSaving ? 'Creating...' : 'Create'}
            </button>
            <button type="button" onClick={() => { setShowNewPub(false); setNewPubError(null) }} className="text-ui-xs text-grey-400 hover:text-black">
              Cancel
            </button>
          </div>
        </form>
      )}

      {isPublicationContext ? (
        /* Publication dashboard */
        <>
          <div className="flex items-center justify-between mb-10">
            <div className="flex gap-2">
              {pubTabs.map(tab => {
                const label = tab === 'rate-card' ? 'Rate card' : tab === 'payroll' ? 'Payroll' : tab === 'earnings' ? 'Earnings' : tab.charAt(0).toUpperCase() + tab.slice(1)
                return (
                  <button key={tab} onClick={() => switchPubTab(tab)} className={`tab-pill ${pubTab === tab ? 'tab-pill-active' : 'tab-pill-inactive'}`}>{label}</button>
                )
              })}
            </div>
            <Link href={`/write?pub=${selectedPub!.slug}`} className="btn">New article</Link>
          </div>
          {pubTab === 'articles' && (
            <PublicationArticlesTab
              publicationId={selectedPub!.id}
              publicationSlug={selectedPub!.slug}
              canPublish={selectedPub!.can_publish}
              canEditOthers={selectedPub!.can_edit_others}
            />
          )}
          {pubTab === 'members' && (
            <MembersTab
              publicationId={selectedPub!.id}
              canManageMembers={selectedPub!.can_manage_members}
            />
          )}
          {pubTab === 'settings' && selectedPub!.can_manage_settings && (
            <PublicationSettingsTab
              publicationId={selectedPub!.id}
              publicationSlug={selectedPub!.slug}
            />
          )}
          {pubTab === 'rate-card' && selectedPub!.can_manage_finances && (
            <RateCardTab publicationId={selectedPub!.id} />
          )}
          {pubTab === 'payroll' && selectedPub!.can_manage_finances && (
            <PayrollTab publicationId={selectedPub!.id} />
          )}
          {pubTab === 'earnings' && selectedPub!.can_manage_finances && (
            <PublicationEarningsTab publicationId={selectedPub!.id} />
          )}
        </>
      ) : (
        /* Personal dashboard */
        <>
          <div className="flex items-center justify-between mb-10">
            <div className="flex gap-2">
              {personalTabs.map(tab => {
                const label = tab === 'drives' ? 'Pledge drives' : tab === 'pricing' ? 'Pricing' : tab === 'offers' ? 'Offers' : tab === 'subscribers' ? 'Subscribers' : tab.charAt(0).toUpperCase() + tab.slice(1)
                return (
                  <button key={tab} onClick={() => switchTab(tab)} className={`tab-pill ${activeTab === tab ? 'tab-pill-active' : 'tab-pill-inactive'}`}>{label}</button>
                )
              })}
            </div>
            <div className="flex items-center gap-4">
              <Link href="/traffology" className="text-ui-xs text-grey-400 hover:text-black underline underline-offset-4">Analytics</Link>
              <Link href="/account" className="text-ui-xs text-grey-400 hover:text-black underline underline-offset-4">View account</Link>
              <Link href="/write" className="btn">New article</Link>
            </div>
          </div>
          {activeTab === 'articles' && <ArticlesTab userId={user.id} pubkey={user.pubkey} />}
          {activeTab === 'drafts' && <DraftsTab />}
          {activeTab === 'subscribers' && <SubscribersTab />}
          {activeTab === 'drives' && <DrivesTab userId={user.id} />}
          {activeTab === 'offers' && <OffersTab />}
          {activeTab === 'pricing' && <PricingTab stripeReady={user.stripeConnectKycComplete} />}
        </>
      )}
    </div>
  )
}

// =============================================================================
// Articles Tab
// =============================================================================

function ArticlesTab({ userId, pubkey }: { userId: string; pubkey: string }) {
  const [articles, setArticles] = useState<MyArticle[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState<string | null>(null); const [deletingId, setDeletingId] = useState<string | null>(null); const [giftLinksOpenId, setGiftLinksOpenId] = useState<string | null>(null); const [unpublishingId, setUnpublishingId] = useState<string | null>(null); const [unpublishedMsg, setUnpublishedMsg] = useState<string | null>(null)

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
  async function handleUnpublish(id: string) {
    if (!confirm('Revert this article to draft? It will be removed from your public profile but not deleted.')) return
    setUnpublishingId(id)
    try {
      await myArticles.unpublish(id)
      setArticles(p => p.filter(a => a.id !== id))
      setUnpublishedMsg('Moved to drafts.')
      setTimeout(() => setUnpublishedMsg(null), 3000)
    } catch { setError('Failed to unpublish.') }
    finally { setUnpublishingId(null) }
  }

  if (loading) return <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-10 animate-pulse bg-white" />)}</div>
  if (error) return <div className="bg-white px-4 py-3 text-ui-xs text-black">{error}</div>
  if (articles.length === 0) return <div className="py-20 text-center"><p className="text-ui-sm text-grey-400 mb-4">No published articles yet.</p><Link href="/write" className="text-ui-xs text-black underline underline-offset-4">Write your first article</Link></div>

  return (
    <div className="overflow-x-auto bg-white">
      <table className="w-full text-ui-xs">
        <thead><tr className="border-b-2 border-grey-200"><th className="px-4 py-3 text-left label-ui text-grey-400">Title</th><th className="px-4 py-3 text-left label-ui text-grey-400">Status</th><th className="px-4 py-3 text-right label-ui text-grey-400">Reads</th><th className="px-4 py-3 text-right label-ui text-grey-400">Earned</th><th className="px-4 py-3 text-center label-ui text-grey-400">Replies</th><th className="px-4 py-3 text-right label-ui text-grey-400">Actions</th></tr></thead>
        <tbody>{articles.map(a => (
          <React.Fragment key={a.id}>
          <tr className="border-b-2 border-grey-200 last:border-b-0">
            <td className="px-4 py-3"><Link href={`/article/${a.dTag}`} className="text-black hover:opacity-70">{a.title}</Link></td>
            <td className="px-4 py-3">{a.isPaywalled ? <span className="text-black">£{((a.pricePence??0)/100).toFixed(2)}</span> : <span className="text-grey-400">Free</span>}</td>
            <td className="px-4 py-3 text-right tabular-nums">{a.readCount}</td>
            <td className="px-4 py-3 text-right text-black tabular-nums">£{(a.netEarningsPence/100).toFixed(2)}</td>
            <td className="px-4 py-3 text-center"><button onClick={() => handleToggleReplies(a.id, !a.repliesEnabled)} className={`text-ui-xs ${a.repliesEnabled ? 'text-crimson' : 'text-grey-300'}`}>{a.repliesEnabled ? 'On' : 'Off'}</button></td>
            <td className="px-4 py-3 text-right">
              <div className="flex items-center justify-end gap-3">
                {a.isPaywalled && (
                  <button onClick={() => setGiftLinksOpenId(giftLinksOpenId === a.id ? null : a.id)} className={`text-grey-300 hover:text-black ${giftLinksOpenId === a.id ? 'text-black' : ''}`}>Gifts</button>
                )}
                <Link href={`/write?edit=${a.nostrEventId}`} className="text-grey-400 hover:text-black">Edit</Link>
                <button onClick={() => handleUnpublish(a.id)} disabled={unpublishingId===a.id} className="text-grey-300 hover:text-black disabled:opacity-50">{unpublishingId===a.id ? '...' : 'Unpublish'}</button>
                <button onClick={() => handleDelete(a.id)} disabled={deletingId===a.id} className="text-grey-300 hover:text-black disabled:opacity-50">{deletingId===a.id ? '...' : 'Delete'}</button>
              </div>
            </td>
          </tr>
          {giftLinksOpenId === a.id && (
            <tr><td colSpan={6} className="bg-grey-50 border-b-2 border-grey-200"><GiftLinksPanel articleId={a.id} dTag={a.dTag} /></td></tr>
          )}
          </React.Fragment>
        ))}
        </tbody>
      </table>
      {unpublishedMsg && <p className="text-ui-xs text-grey-600 px-4 py-2">{unpublishedMsg}</p>}
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
// Pricing Tab — subscription price, per-article pricing, Stripe status
// =============================================================================

function PricingTab({ stripeReady }: { stripeReady: boolean }) {
  const { user, fetchMe } = useAuth()
  const [subPrice, setSubPrice] = useState('')
  const [annualDiscount, setAnnualDiscount] = useState('15')
  const [articlePriceMode, setArticlePriceMode] = useState<'auto' | 'fixed'>(
    user?.defaultArticlePricePence != null ? 'fixed' : 'auto'
  )
  const [fixedArticlePrice, setFixedArticlePrice] = useState(
    user?.defaultArticlePricePence != null ? (user.defaultArticlePricePence / 100).toFixed(2) : ''
  )
  const [savingPrice, setSavingPrice] = useState(false)
  const [priceMsg, setPriceMsg] = useState<string | null>(null)

  async function handleSavePrice(e: React.FormEvent) {
    e.preventDefault()
    const pence = Math.round(parseFloat(subPrice) * 100)
    const discount = parseInt(annualDiscount, 10)
    if (isNaN(pence) || pence < 0) { setPriceMsg('Enter a valid price.'); return }
    if (isNaN(discount) || discount < 0 || discount > 30) { setPriceMsg('Discount must be 0–30%.'); return }
    const defaultArticlePricePence = articlePriceMode === 'fixed'
      ? Math.round(parseFloat(fixedArticlePrice || '0') * 100)
      : null
    if (articlePriceMode === 'fixed' && (isNaN(defaultArticlePricePence!) || defaultArticlePricePence! < 0)) {
      setPriceMsg('Enter a valid per-article price.'); return
    }
    setSavingPrice(true); setPriceMsg(null)
    try {
      await accountApi.updateSubscriptionPrice(pence, discount, defaultArticlePricePence)
      await fetchMe()
      setPriceMsg('Pricing updated.')
    } catch { setPriceMsg('Failed to update.') }
    finally { setSavingPrice(false) }
  }

  const monthlyPence = Math.round(parseFloat(subPrice || '0') * 100)
  const discountPct = parseInt(annualDiscount || '0', 10)
  const annualPence = Math.round(monthlyPence * 12 * (1 - discountPct / 100))
  const annualPounds = (annualPence / 100).toFixed(2)

  return (
    <div className="space-y-8">
      <form onSubmit={handleSavePrice} className="space-y-8">
        {/* Subscription price */}
        <div className="bg-white px-6 py-5">
          <p className="label-ui text-grey-400 mb-4">Subscription pricing</p>
          <p className="text-ui-xs text-grey-600 leading-relaxed mb-4">
            Set the monthly price readers pay to subscribe to your content. Readers can also choose an annual plan at a discount you configure.
          </p>
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="text-[14px] font-sans text-grey-400">£</span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={subPrice}
                onChange={(e) => setSubPrice(e.target.value)}
                className="w-28 bg-grey-100 px-3 py-1.5 text-[14px] font-sans text-black placeholder-grey-300"
                placeholder="3.00"
              />
              <span className="text-[13px] font-sans text-grey-300">/month</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[14px] font-sans text-grey-400 w-[13px]">%</span>
              <input
                type="number"
                min="0"
                max="30"
                value={annualDiscount}
                onChange={(e) => setAnnualDiscount(e.target.value)}
                className="w-28 bg-grey-100 px-3 py-1.5 text-[14px] font-sans text-black placeholder-grey-300"
                placeholder="15"
              />
              <span className="text-[13px] font-sans text-grey-300">annual discount</span>
            </div>
            {monthlyPence > 0 && (
              <p className="text-[13px] font-sans text-grey-400">
                Readers pay £{subPrice}/mo or £{annualPounds}/year{discountPct > 0 ? ` (save ${discountPct}%)` : ''}
              </p>
            )}
          </div>
        </div>

        {/* Per-article pricing */}
        <div className="bg-white px-6 py-5">
          <p className="label-ui text-grey-400 mb-4">Per-article pricing</p>
          <p className="text-ui-xs text-grey-600 leading-relaxed mb-4">
            Default price for paywalled articles. You can override this per article in the editor. Free articles are always free.
          </p>
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => setArticlePriceMode('auto')}
              className={`w-full text-left px-4 py-3 transition-colors ${
                articlePriceMode === 'auto' ? 'bg-black text-white' : 'bg-grey-100 text-black hover:bg-grey-200/60'
              }`}
            >
              <p className={`text-ui-sm font-medium ${articlePriceMode === 'auto' ? 'text-white' : 'text-black'}`}>
                Auto
              </p>
              <p className={`text-ui-xs mt-0.5 ${articlePriceMode === 'auto' ? 'text-grey-300' : 'text-grey-400'}`}>
                Price scales with article length
              </p>
            </button>
            <button
              type="button"
              onClick={() => setArticlePriceMode('fixed')}
              className={`w-full text-left px-4 py-3 transition-colors ${
                articlePriceMode === 'fixed' ? 'bg-black text-white' : 'bg-grey-100 text-black hover:bg-grey-200/60'
              }`}
            >
              <p className={`text-ui-sm font-medium ${articlePriceMode === 'fixed' ? 'text-white' : 'text-black'}`}>
                Fixed default
              </p>
              <p className={`text-ui-xs mt-0.5 ${articlePriceMode === 'fixed' ? 'text-grey-300' : 'text-grey-400'}`}>
                Same starting price for every paywalled article
              </p>
            </button>
            {articlePriceMode === 'fixed' && (
              <div className="flex items-center gap-3 pt-1">
                <span className="text-[14px] font-sans text-grey-400">£</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={fixedArticlePrice}
                  onChange={(e) => setFixedArticlePrice(e.target.value)}
                  className="w-28 bg-grey-100 px-3 py-1.5 text-[14px] font-sans text-black placeholder-grey-300"
                  placeholder="0.20"
                />
                <span className="text-[13px] font-sans text-grey-300">per read</span>
              </div>
            )}
          </div>
        </div>

        <div className="px-6">
          <button type="submit" disabled={savingPrice} className="btn text-sm disabled:opacity-50">
            {savingPrice ? 'Saving…' : 'Save pricing'}
          </button>
          {priceMsg && <p className="text-[13px] font-sans text-grey-600 mt-2">{priceMsg}</p>}
        </div>
      </form>

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
            <Link href="/profile" className="text-ui-xs text-crimson underline underline-offset-4">
              Set up Stripe Connect
            </Link>
          </div>
        )}
      </div>

    </div>
  )
}

// =============================================================================
// Skeleton
// =============================================================================

function DashboardSkeleton() {
  return <div className="mx-auto max-w-content px-4 sm:px-6 py-10"><div className="flex gap-2 mb-10">{[1,2,3,4].map(i => <div key={i} className="h-9 w-24 animate-pulse bg-white"/>)}</div><div className="grid grid-cols-1 gap-4 sm:grid-cols-3">{[1,2,3].map(i => <div key={i} className="bg-white p-6"><div className="h-3 w-20 animate-pulse bg-grey-100 mb-3"/><div className="h-7 w-28 animate-pulse bg-grey-100"/></div>)}</div></div>
}

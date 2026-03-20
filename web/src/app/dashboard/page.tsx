'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '../../stores/auth'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { payment, myArticles, type WriterEarnings, type ArticleEarnings, type MyArticle } from '../../lib/api'
import { loadDrafts, deleteDraft } from '../../lib/drafts'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { getNdk, KIND_DELETION } from '../../lib/ndk'
import { signViaGateway } from '../../lib/sign'

type DashboardTab = 'articles' | 'drafts' | 'credits' | 'debits'

export default function DashboardPage() {
  const { user, loading } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const rawTab = searchParams.get('tab')
  const initialTab: DashboardTab = rawTab === 'earnings' ? 'credits' : (rawTab as DashboardTab) || 'articles'
  const [activeTab, setActiveTab] = useState<DashboardTab>(initialTab)
  const [hasEarnings, setHasEarnings] = useState<boolean | null>(null)

  useEffect(() => { if (!loading && !user) router.push('/auth?mode=login') }, [user, loading, router])

  // Check if user has any earnings (to conditionally show credits tab)
  useEffect(() => {
    if (!user) return
    async function checkEarnings() {
      try {
        const res = await fetch(`/api/v1/earnings/${user!.id}`, { credentials: 'include' })
        if (res.ok) {
          const data = await res.json()
          setHasEarnings(data.earningsTotalPence > 0 || data.readCount > 0)
        } else {
          setHasEarnings(false)
        }
      } catch { setHasEarnings(false) }
    }
    // Also check for subscribers
    async function checkSubscribers() {
      try {
        const res = await fetch('/api/v1/subscribers', { credentials: 'include' })
        if (res.ok) {
          const data = await res.json()
          if (data.subscribers?.length > 0) setHasEarnings(true)
        }
      } catch {}
    }
    checkEarnings()
    checkSubscribers()
  }, [user])

  function switchTab(tab: DashboardTab) {
    setActiveTab(tab)
    const url = new URL(window.location.href); url.searchParams.set('tab', tab)
    window.history.replaceState({}, '', url.toString())
  }

  if (loading || !user) return <DashboardSkeleton />

  const tabs: DashboardTab[] = hasEarnings
    ? ['articles', 'drafts', 'credits', 'debits']
    : ['articles', 'drafts', 'debits']

  return (
    <div className="mx-auto max-w-content px-6 py-10">
      <div className="flex items-center justify-between mb-10">
        <div className="flex gap-2">
          {tabs.map(tab => (
            <button key={tab} onClick={() => switchTab(tab)} className={`tab-pill ${activeTab === tab ? 'tab-pill-active' : 'tab-pill-inactive'}`}>{tab}</button>
          ))}
        </div>
        <Link href="/write" className="btn">New article</Link>
      </div>
      {activeTab === 'articles' && <ArticlesTab userId={user.id} pubkey={user.pubkey} />}
      {activeTab === 'drafts' && <DraftsTab />}
      {activeTab === 'credits' && hasEarnings && <CreditsTab userId={user.id} stripeReady={user.stripeConnectKycComplete} />}
      {activeTab === 'debits' && <DebitsTab userId={user.id} freeAllowancePence={user.freeAllowanceRemainingPence} hasCard={user.hasPaymentMethod} />}
    </div>
  )
}

// =============================================================================
// Articles Tab — unchanged from previous
// =============================================================================

function ArticlesTab({ userId, pubkey }: { userId: string; pubkey: string }) {
  const [articles, setArticles] = useState<MyArticle[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState<string | null>(null); const [deletingId, setDeletingId] = useState<string | null>(null)
  useEffect(() => { (async () => { setLoading(true); try { setArticles((await myArticles.list()).articles) } catch { setError('Failed to load articles.') } finally { setLoading(false) } })() }, [userId])
  async function handleToggleReplies(id: string, on: boolean) { try { await myArticles.update(id, { repliesEnabled: on }); setArticles(p => p.map(a => a.id === id ? { ...a, repliesEnabled: on } : a)) } catch { setError('Failed to update.') } }
  async function handleDelete(id: string) {
    setDeletingId(id)
    try {
      const result = await myArticles.remove(id)
      setArticles(p => p.filter(a => a.id !== id))
      // Also publish the kind 5 deletion event from the frontend so the relay
      // removes the article from feeds even if the gateway's relay publish failed.
      try {
        const ndk = getNdk(); await ndk.connect()
        const delEvent = new NDKEvent(ndk)
        delEvent.kind = KIND_DELETION; delEvent.content = ''
        delEvent.tags = [['e', result.nostrEventId], ['a', `30023:${pubkey}:${result.dTag}`]]
        const signed = await signViaGateway(delEvent)
        await signed.publish()
      } catch { /* non-fatal — DB is already soft-deleted */ }
    }
    catch { setError('Failed to delete.') }
    finally { setDeletingId(null) }
  }

  if (loading) return <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-10 animate-pulse bg-surface-raised" />)}</div>
  if (error) return <div className="bg-surface-raised px-4 py-3 text-ui-xs text-content-primary">{error}</div>
  if (articles.length === 0) return <div className="py-20 text-center"><p className="text-ui-sm text-content-muted mb-4">No published articles yet.</p><Link href="/write" className="text-ui-xs text-ink-900 underline underline-offset-4">Write your first article</Link></div>

  return (
    <div className="overflow-x-auto bg-surface-raised">
      <table className="w-full text-ui-xs">
        <thead><tr className="border-b border-surface-strong"><th className="px-4 py-3 text-left label-ui text-content-muted">Title</th><th className="px-4 py-3 text-left label-ui text-content-muted">Status</th><th className="px-4 py-3 text-right label-ui text-content-muted">Reads</th><th className="px-4 py-3 text-right label-ui text-content-muted">Earned</th><th className="px-4 py-3 text-center label-ui text-content-muted">Replies</th><th className="px-4 py-3 text-right label-ui text-content-muted">Actions</th></tr></thead>
        <tbody>{articles.map(a => (
          <tr key={a.id} className="border-b border-surface-strong last:border-b-0">
            <td className="px-4 py-3"><Link href={`/article/${a.dTag}`} className="text-ink-900 hover:opacity-70">{a.title}</Link></td>
            <td className="px-4 py-3">{a.isPaywalled ? <span className="text-content-primary">£{((a.pricePence??0)/100).toFixed(2)}</span> : <span className="text-content-muted">Free</span>}</td>
            <td className="px-4 py-3 text-right tabular-nums">{a.readCount}</td>
            <td className="px-4 py-3 text-right text-ink-900 tabular-nums">£{(a.netEarningsPence/100).toFixed(2)}</td>
            <td className="px-4 py-3 text-center"><button onClick={() => handleToggleReplies(a.id, !a.repliesEnabled)} className={`text-ui-xs ${a.repliesEnabled ? 'text-accent' : 'text-content-faint'}`}>{a.repliesEnabled ? 'On' : 'Off'}</button></td>
            <td className="px-4 py-3 text-right"><div className="flex items-center justify-end gap-3"><Link href={`/write?edit=${a.nostrEventId}`} className="text-content-muted hover:text-ink-900">Edit</Link><button onClick={() => handleDelete(a.id)} disabled={deletingId===a.id} className="text-content-faint hover:text-ink-900 disabled:opacity-50">{deletingId===a.id ? '...' : 'Delete'}</button></div></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  )
}

// =============================================================================
// Drafts Tab — unchanged
// =============================================================================

function DraftsTab() {
  const [drafts, setDrafts] = useState<any[]>([]); const [loading, setLoading] = useState(true)
  useEffect(() => { (async () => { setLoading(true); try { setDrafts(await loadDrafts()) } catch {} finally { setLoading(false) } })() }, [])
  async function handleDelete(id: string) { try { await deleteDraft(id); setDrafts(p => p.filter((d:any) => d.draftId !== id)) } catch {} }
  if (loading) return <div className="space-y-3">{[1,2].map(i => <div key={i} className="h-8 animate-pulse bg-surface-raised" />)}</div>
  if (drafts.length === 0) return <div className="py-20 text-center"><p className="text-ui-sm text-content-muted mb-4">No saved drafts.</p><Link href="/write" className="text-ui-xs text-ink-900 underline underline-offset-4">Start writing</Link></div>
  return <div className="space-y-2">{drafts.map((d:any) => <div key={d.draftId} className="flex items-center justify-between bg-surface-raised px-4 py-3"><div><p className="text-ui-sm text-ink-900">{d.title||'Untitled'}</p><p className="text-ui-xs text-content-faint mt-0.5">Last saved {new Date(d.autoSavedAt).toLocaleDateString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</p></div><div className="flex items-center gap-4"><Link href={`/write?draft=${d.draftId}`} className="text-ui-xs text-content-primary hover:text-ink-900">Continue</Link><button onClick={() => handleDelete(d.draftId)} className="text-ui-xs text-content-faint hover:text-ink-900">Delete</button></div></div>)}</div>
}

// =============================================================================
// Credits Tab — itemised chronological log + subscribers + value flagging
// =============================================================================

interface SubscriberInfo {
  subscriptionId: string
  readerUsername: string
  readerDisplayName: string | null
  pricePence: number
  status: string
  articlesRead: number
  totalArticleValuePence: number
  gettingMoneysworth: boolean
  startedAt: string
}

interface CreditEvent {
  type: 'read' | 'subscription'
  date: string
  description: string
  amountPence: number
  readerName?: string
  articleTitle?: string
}

function CreditsTab({ userId, stripeReady }: { userId: string; stripeReady: boolean }) {
  const [earnings, setEarnings] = useState<WriterEarnings | null>(null)
  const [articleEarnings, setArticleEarnings] = useState<ArticleEarnings[]>([])
  const [subscribers, setSubscribers] = useState<SubscriberInfo[]>([])
  const [subEvents, setSubEvents] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    (async () => {
      setLoading(true)
      try {
        const [earningsRes, perArticleRes, subscribersRes, subEventsRes] = await Promise.all([
          payment.getEarnings(userId),
          payment.getPerArticleEarnings(userId),
          fetch('/api/v1/subscribers', { credentials: 'include' }).then(r => r.ok ? r.json() : { subscribers: [] }),
          fetch(`/api/v1/subscription-events?role=writer&limit=50`, { credentials: 'include' }).then(r => r.ok ? r.json() : { events: [] }).catch(() => ({ events: [] })),
        ])
        setEarnings(earningsRes)
        setArticleEarnings(perArticleRes.articles)
        setSubscribers(subscribersRes.subscribers ?? [])
        setSubEvents(subEventsRes.events ?? [])
      } catch { setError('Failed to load earnings data.') }
      finally { setLoading(false) }
    })()
  }, [userId])

  // Net balance calculation
  const totalCredits = (earnings?.earningsTotalPence ?? 0) + subscribers.reduce((s, sub) => s + (sub.status === 'active' ? sub.pricePence : 0), 0)
  const activeSubscribers = subscribers.filter(s => s.status === 'active')

  if (error) return <div className="bg-surface-raised px-4 py-3 text-ui-xs text-content-primary">{error}</div>

  return (
    <div>
      {/* Connect Stripe prompt */}
      {!stripeReady && earnings && earnings.earningsTotalPence > 0 && (
        <div className="mb-10 bg-accent-50 border-l-[3px] border-accent px-6 py-4">
          <p className="text-ui-sm text-content-primary">You've earned £{(earnings.earningsTotalPence/100).toFixed(2)} from {earnings.readCount} paid reads. Connect your bank to get paid.</p>
          <a href="/settings" className="mt-2 inline-block text-ui-xs text-accent-700 underline underline-offset-4">Connect Stripe</a>
        </div>
      )}

      {/* Summary cards */}
      {loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 mb-14">{[1,2,3].map(i => <div key={i} className="bg-surface-raised p-6"><div className="h-3 w-20 animate-pulse bg-surface-sunken mb-3"/><div className="h-7 w-28 animate-pulse bg-surface-sunken"/></div>)}</div>
      ) : earnings ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4 mb-14">
          <Card label="Total earned" pence={earnings.earningsTotalPence} sub={`${earnings.readCount} paid reads`} primary />
          <Card label="Pending" pence={earnings.pendingTransferPence} sub="Awaiting threshold" />
          <Card label="Paid out" pence={earnings.paidOutPence} sub="To your bank" />
          <Card label="Subscribers" pence={activeSubscribers.reduce((s, sub) => s + sub.pricePence, 0)} sub={`${activeSubscribers.length} active`} accent />
        </div>
      ) : null}

      {/* Subscribers section */}
      {subscribers.length > 0 && (
        <div className="mb-14">
          <p className="label-ui text-content-muted mb-4">Subscribers</p>
          <div className="overflow-x-auto bg-surface-raised">
            <table className="w-full text-ui-xs">
              <thead><tr className="border-b border-surface-strong">
                <th className="px-4 py-3 text-left label-ui text-content-muted">Reader</th>
                <th className="px-4 py-3 text-right label-ui text-content-muted">Pays</th>
                <th className="px-4 py-3 text-right label-ui text-content-muted">Articles read</th>
                <th className="px-4 py-3 text-right label-ui text-content-muted">Article value</th>
                <th className="px-4 py-3 text-center label-ui text-content-muted">Value</th>
                <th className="px-4 py-3 text-left label-ui text-content-muted">Status</th>
              </tr></thead>
              <tbody>{subscribers.map(s => (
                <tr key={s.subscriptionId} className="border-b border-surface-strong last:border-b-0">
                  <td className="px-4 py-3">
                    <Link href={`/${s.readerUsername}`} className="text-ink-900 hover:opacity-70">{s.readerDisplayName ?? s.readerUsername}</Link>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">£{(s.pricePence/100).toFixed(2)}/mo</td>
                  <td className="px-4 py-3 text-right tabular-nums">{s.articlesRead}</td>
                  <td className="px-4 py-3 text-right tabular-nums">£{(s.totalArticleValuePence/100).toFixed(2)}</td>
                  <td className="px-4 py-3 text-center">
                    {s.gettingMoneysworth ? (
                      <span className="text-accent text-ui-xs font-medium" title="Reading more than they pay — getting their money's worth">Good value</span>
                    ) : (
                      <span className="text-amber-600 text-ui-xs" title="Reading less than subscription cost — may cancel">At risk</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-ui-xs ${s.status === 'active' ? 'text-accent font-medium' : 'text-content-faint'}`}>
                      {s.status === 'active' ? 'Active' : 'Cancelled'}
                    </span>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}

      {/* How credits work */}
      <div className="bg-surface-raised p-6 mb-12">
        <p className="label-ui text-content-muted mb-3">How credits work</p>
        <div className="space-y-2 text-ui-xs text-content-secondary leading-relaxed">
          <p>All figures shown after the 8% platform fee. Per-article reads and subscription income are netted against your own reading debits. Payouts trigger monthly when your net balance clears the threshold.</p>
          <p>Subscriber reads are logged at zero cost but tracked — you can see which subscribers are getting their money's worth and which may be at risk of cancelling.</p>
        </div>
      </div>

      {/* Per-article revenue */}
      <p className="label-ui text-content-muted mb-4">Per-article revenue</p>
      {loading ? <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-8 animate-pulse bg-surface-raised"/>)}</div>
      : articleEarnings.length === 0 ? <p className="text-ui-xs text-content-faint">No settled revenue yet.</p>
      : <div className="overflow-x-auto bg-surface-raised"><table className="w-full text-ui-xs"><thead><tr className="border-b border-surface-strong"><th className="px-4 py-3 text-left label-ui text-content-muted">Article</th><th className="px-4 py-3 text-right label-ui text-content-muted">Reads</th><th className="px-4 py-3 text-right label-ui text-content-muted">Earned</th><th className="px-4 py-3 text-right label-ui text-content-muted">Pending</th><th className="px-4 py-3 text-right label-ui text-content-muted">Paid</th></tr></thead><tbody>{articleEarnings.map(a => <tr key={a.articleId} className="border-b border-surface-strong last:border-b-0"><td className="px-4 py-3"><a href={`/article/${a.dTag}`} className="text-ink-900 hover:opacity-70">{a.title}</a></td><td className="px-4 py-3 text-right tabular-nums">{a.readCount}</td><td className="px-4 py-3 text-right text-ink-900 tabular-nums">£{(a.netEarningsPence/100).toFixed(2)}</td><td className="px-4 py-3 text-right text-content-faint tabular-nums">£{(a.pendingPence/100).toFixed(2)}</td><td className="px-4 py-3 text-right text-content-faint tabular-nums">£{(a.paidPence/100).toFixed(2)}</td></tr>)}</tbody></table></div>}
    </div>
  )
}

// =============================================================================
// Debits Tab — itemised reads + subscriptions + value flagging
// =============================================================================

interface TabData {
  tabBalancePence: number
  freeAllowanceRemainingPence: number
  lastSettledAt: string | null
  reads: {
    readId: string; articleTitle: string; articleDTag: string
    writerDisplayName: string | null; writerUsername: string
    chargePence: number; readAt: string; settledAt: string | null
    isSubscriptionRead?: boolean
  }[]
}

interface MySubscription {
  id: string; writerId: string; writerUsername: string
  writerDisplayName: string | null; pricePence: number
  status: string; currentPeriodEnd: string
}

function DebitsTab({ userId, freeAllowancePence, hasCard }: { userId: string; freeAllowancePence: number; hasCard: boolean }) {
  const [tabData, setTabData] = useState<TabData | null>(null)
  const [subscriptions, setSubscriptions] = useState<MySubscription[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    (async () => {
      setLoading(true)
      try {
        const [tabRes, subRes] = await Promise.all([
          fetch('/api/v1/my/tab', { credentials: 'include' }),
          fetch('/api/v1/subscriptions/mine', { credentials: 'include' }),
        ])
        if (tabRes.ok) setTabData(await tabRes.json())
        else setError('Failed to load reading tab.')
        if (subRes.ok) {
          const subData = await subRes.json()
          setSubscriptions(subData.subscriptions ?? [])
        }
      } catch { setError('Failed to load.') }
      finally { setLoading(false) }
    })()
  }, [userId])

  const unsettled = tabData?.reads.filter(r => !r.settledAt) ?? []
  const settled = tabData?.reads.filter(r => r.settledAt) ?? []
  const subscriptionCostPence = subscriptions.filter(s => s.status === 'active').reduce((s, sub) => s + sub.pricePence, 0)

  return (
    <div>
      {/* How it works */}
      <div className="bg-surface-raised p-6 mb-10">
        <p className="label-ui text-content-muted mb-3">How your reading tab works</p>
        <div className="space-y-2 text-ui-xs text-content-secondary leading-relaxed">
          <p>Per-article reads and subscriptions are both debits. Reads of articles by writers you subscribe to show as zero-cost. Your tab settles at £8, or monthly.</p>
          {!hasCard && freeAllowancePence > 0 && <p className="text-ink-900">You have £{(freeAllowancePence/100).toFixed(2)} of free credit remaining.</p>}
          {!hasCard && freeAllowancePence <= 0 && <p className="text-ink-900">Free allowance used. <a href="/settings" className="underline underline-offset-4">Add a card</a> to keep reading.</p>}
        </div>
      </div>

      {/* Summary cards */}
      {loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 mb-14">{[1,2,3].map(i => <div key={i} className="bg-surface-raised p-6"><div className="h-3 w-20 animate-pulse bg-surface-sunken mb-3"/><div className="h-7 w-28 animate-pulse bg-surface-sunken"/></div>)}</div>
      ) : tabData ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4 mb-14">
          <Card label="Current tab" pence={tabData.tabBalancePence} sub={`${unsettled.length} unsettled`} primary />
          <Card label="Free credit" pence={tabData.freeAllowanceRemainingPence} sub="Of £5.00 welcome" />
          <Card label="Subscriptions" pence={subscriptionCostPence} sub={`${subscriptions.filter(s=>s.status==='active').length} active`} accent />
          <Card label="Total settled" pence={settled.reduce((s,r)=>s+r.chargePence,0)} sub={tabData.lastSettledAt ? `Last ${new Date(tabData.lastSettledAt).toLocaleDateString('en-GB',{day:'numeric',month:'short'})}` : 'None yet'} />
        </div>
      ) : null}

      {error && <div className="bg-surface-raised px-4 py-3 text-ui-xs text-content-primary mb-8">{error}</div>}

      {/* Active subscriptions */}
      {subscriptions.length > 0 && (
        <div className="mb-12">
          <p className="label-ui text-content-muted mb-4">Your subscriptions</p>
          <div className="space-y-2">
            {subscriptions.map(sub => (
              <div key={sub.id} className="flex items-center justify-between bg-surface-raised px-4 py-3">
                <div className="flex items-center gap-3">
                  <div>
                    <Link href={`/${sub.writerUsername}`} className="text-ui-sm text-ink-900 hover:opacity-70">{sub.writerDisplayName ?? sub.writerUsername}</Link>
                    <p className="text-ui-xs text-content-faint mt-0.5">
                      £{(sub.pricePence/100).toFixed(2)}/mo
                      {sub.status === 'cancelled' && ` · access until ${new Date(sub.currentPeriodEnd).toLocaleDateString('en-GB',{day:'numeric',month:'short'})}`}
                    </p>
                  </div>
                </div>
                <span className={`text-ui-xs ${sub.status === 'active' ? 'text-accent font-medium' : 'text-content-faint'}`}>
                  {sub.status === 'active' ? 'Active' : 'Cancelled'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Unsettled reads */}
      {!loading && unsettled.length > 0 && (
        <>
          <p className="label-ui text-content-muted mb-4">On your tab</p>
          <div className="overflow-x-auto bg-surface-raised mb-12">
            <table className="w-full text-ui-xs">
              <thead><tr className="border-b border-surface-strong"><th className="px-4 py-3 text-left label-ui text-content-muted">Article</th><th className="px-4 py-3 text-left label-ui text-content-muted">Writer</th><th className="px-4 py-3 text-left label-ui text-content-muted">Read</th><th className="px-4 py-3 text-right label-ui text-content-muted">Charge</th></tr></thead>
              <tbody>{unsettled.map(r => (
                <tr key={r.readId} className="border-b border-surface-strong last:border-b-0">
                  <td className="px-4 py-3"><a href={`/article/${r.articleDTag}`} className="text-ink-900 hover:opacity-70">{r.articleTitle}</a></td>
                  <td className="px-4 py-3 text-content-muted">{r.writerDisplayName??r.writerUsername}</td>
                  <td className="px-4 py-3 text-content-faint">{new Date(r.readAt).toLocaleDateString('en-GB',{day:'numeric',month:'short'})}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {r.isSubscriptionRead || r.chargePence === 0 ? (
                      <span className="text-accent text-ui-xs">Subscribed</span>
                    ) : (
                      <span className="text-ink-900">£{(r.chargePence/100).toFixed(2)}</span>
                    )}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </>
      )}

      {/* Settled reads */}
      {!loading && settled.length > 0 && (
        <>
          <p className="label-ui text-content-muted mb-4">Settled</p>
          <div className="overflow-x-auto bg-surface-raised">
            <table className="w-full text-ui-xs">
              <thead><tr className="border-b border-surface-strong"><th className="px-4 py-3 text-left label-ui text-content-muted">Article</th><th className="px-4 py-3 text-left label-ui text-content-muted">Writer</th><th className="px-4 py-3 text-left label-ui text-content-muted">Read</th><th className="px-4 py-3 text-right label-ui text-content-muted">Charge</th></tr></thead>
              <tbody>{settled.map(r => (
                <tr key={r.readId} className="border-b border-surface-strong last:border-b-0">
                  <td className="px-4 py-3"><a href={`/article/${r.articleDTag}`} className="text-ink-900 hover:opacity-70">{r.articleTitle}</a></td>
                  <td className="px-4 py-3 text-content-muted">{r.writerDisplayName??r.writerUsername}</td>
                  <td className="px-4 py-3 text-content-faint">{new Date(r.readAt).toLocaleDateString('en-GB',{day:'numeric',month:'short'})}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {r.isSubscriptionRead || r.chargePence === 0 ? (
                      <span className="text-accent text-ui-xs">Subscribed</span>
                    ) : (
                      <span className="text-content-faint">£{(r.chargePence/100).toFixed(2)}</span>
                    )}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </>
      )}

      {!loading && !error && tabData && tabData.reads.length === 0 && subscriptions.length === 0 && (
        <div className="py-20 text-center"><p className="text-ui-sm text-content-muted mb-4">No paywalled articles read yet.</p><Link href="/feed" className="text-ui-xs text-ink-900 underline underline-offset-4">Browse the feed</Link></div>
      )}
    </div>
  )
}

// =============================================================================
// Shared Card Component
// =============================================================================

function Card({ label, pence, sub, primary=false, accent=false }: { label: string; pence: number; sub: string; primary?: boolean; accent?: boolean }) {
  const bg = primary ? 'bg-ink-900' : accent ? 'bg-accent-50 border-l-[3px] border-accent' : 'bg-surface-raised'
  const labelColor = primary ? 'text-ink-400' : accent ? 'text-accent-700' : 'text-content-muted'
  const valueColor = primary ? 'text-surface' : accent ? 'text-accent-800' : 'text-ink-800'
  const subColor = primary ? 'text-ink-400' : accent ? 'text-accent-600' : 'text-content-faint'

  return (
    <div className={`p-6 ${bg}`}>
      <p className={`label-ui mb-2 ${labelColor}`}>{label}</p>
      <p className={`font-serif text-2xl font-light ${valueColor}`}>£{(pence/100).toFixed(2)}</p>
      <p className={`mt-1 text-ui-xs ${subColor}`}>{sub}</p>
    </div>
  )
}

function DashboardSkeleton() {
  return <div className="mx-auto max-w-content px-6 py-10"><div className="flex gap-2 mb-10">{[1,2,3,4].map(i => <div key={i} className="h-9 w-24 animate-pulse bg-surface-raised"/>)}</div><div className="grid grid-cols-1 gap-4 sm:grid-cols-3">{[1,2,3].map(i => <div key={i} className="bg-surface-raised p-6"><div className="h-3 w-20 animate-pulse bg-surface-sunken mb-3"/><div className="h-7 w-28 animate-pulse bg-surface-sunken"/></div>)}</div></div>
}

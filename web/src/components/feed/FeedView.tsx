'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../../stores/auth'
import { useRouter } from 'next/navigation'
import { ArticleCard } from '../feed/ArticleCard'
import { NoteCard } from '../feed/NoteCard'
import { NoteComposer } from '../feed/NoteComposer'
import type { FeedItem, NoteEvent } from '../../lib/ndk'
import { getNdk, parseArticleEvent, parseNoteEvent, KIND_ARTICLE, KIND_NOTE, KIND_DELETION } from '../../lib/ndk'
import type { NDKFilter, NDKKind } from '@nostr-dev-kit/ndk'

type FeedTab = 'following' | 'for-you'

export function FeedView() {
  const { user, loading } = useAuth()
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<FeedTab>('following')
  const [feedItems, setFeedItems] = useState<FeedItem[]>([])
  const [feedLoading, setFeedLoading] = useState(true)

  useEffect(() => { if (!loading && !user) router.push('/auth?mode=login') }, [user, loading, router])

  useEffect(() => {
    if (!user) return
    async function loadFeed() {
      setFeedLoading(true)
      try {
        const ndk = getNdk(); await ndk.connect()
        if (activeTab === 'following') {
          const pks = await fetchFollowedPubkeys(user!.id)
          const af = pks.length > 0 ? { authors: pks } : {}
          const [articleEvents, noteEvents, deletionEvents] = await Promise.all([
            ndk.fetchEvents({ kinds: [KIND_ARTICLE as NDKKind], limit: 30, ...af }),
            ndk.fetchEvents({ kinds: [KIND_NOTE as NDKKind], limit: 30, ...af }),
            ndk.fetchEvents({ kinds: [KIND_DELETION as NDKKind], limit: 100, ...af }),
          ])
          const deleted = new Set<string>()
          for (const d of deletionEvents) for (const t of d.tags) if (t[0] === 'e') deleted.add(t[1])
          const articles: FeedItem[] = Array.from(articleEvents).filter(e => !deleted.has(e.id)).map(e => ({ ...parseArticleEvent(e), type: 'article' as const }))
          const notes: FeedItem[] = Array.from(noteEvents).filter(e => !e.tags.find(t => t[0] === 'e')).filter(e => !deleted.has(e.id)).map(e => parseNoteEvent(e))
          setFeedItems([...articles, ...notes].sort((a, b) => b.publishedAt - a.publishedAt))
        } else { setFeedItems([]) }
      } catch (err) { console.error('Feed load error:', err) }
      finally { setFeedLoading(false) }
    }
    loadFeed()
  }, [user, activeTab])

  const handleNotePublished = useCallback((note: NoteEvent) => { setFeedItems(prev => [note, ...prev]) }, [])
  const handleNoteDeleted = useCallback((id: string) => { setFeedItems(prev => prev.filter(i => i.id !== id)) }, [])

  if (loading || !user) return <FeedSkeleton />

  return (
    <div className="mx-auto max-w-article px-6 py-10">
      <NoteComposer onPublished={handleNotePublished} />
      <div className="flex gap-2 mb-6">
        <button onClick={() => setActiveTab('following')} className={`tab-pill ${activeTab === 'following' ? 'tab-pill-active' : 'tab-pill-inactive'}`}>Following</button>
        <button onClick={() => setActiveTab('for-you')} className={`tab-pill ${activeTab === 'for-you' ? 'tab-pill-active' : 'tab-pill-inactive'}`}>For you</button>
      </div>
      {feedLoading ? <FeedSkeleton /> : feedItems.length === 0 ? (
        <div className="py-20 text-center"><p className="text-ui-sm text-content-muted">{activeTab === 'following' ? 'Nothing here yet. Follow some writers to see their work.' : 'For You recommendations are coming soon.'}</p></div>
      ) : (
        <div className="space-y-3">
          {feedItems.map(item => item.type === 'article'
            ? <ArticleCard key={item.id} article={item} />
            : <NoteCard key={item.id} note={item} onDeleted={handleNoteDeleted} />
          )}
        </div>
      )}
    </div>
  )
}

function FeedSkeleton() {
  return (
    <div className="mx-auto max-w-article px-6 py-10 space-y-3">
      {[1,2,3].map(i => <div key={i} className="bg-surface-raised p-5"><div className="h-3 w-24 animate-pulse bg-surface-sunken mb-4" /><div className="h-5 w-3/4 animate-pulse bg-surface-sunken mb-3" /><div className="h-3 w-full animate-pulse bg-surface-sunken" /></div>)}
    </div>
  )
}

async function fetchFollowedPubkeys(readerId: string): Promise<string[]> {
  try { const res = await fetch('/api/v1/follows/pubkeys', { credentials: 'include' }); if (!res.ok) return []; return (await res.json()).pubkeys ?? [] } catch { return [] }
}

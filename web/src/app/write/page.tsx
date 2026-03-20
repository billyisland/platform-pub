'use client'

import { useAuth } from '../../stores/auth'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { ArticleEditor, type PublishData } from '../../components/editor/ArticleEditor'
import { publishArticle } from '../../lib/publish'
import { loadDraft } from '../../lib/drafts'
import { getNdk, fetchArticleByDTag, KIND_ARTICLE } from '../../lib/ndk'
import { articles as articlesApi } from '../../lib/api'
import type { NDKFilter, NDKKind } from '@nostr-dev-kit/ndk'

// =============================================================================
// Write Page
//
// Three modes:
//   1. New article: /write (no params)
//   2. Edit published article: /write?edit=<nostrEventId>
//   3. Continue draft: /write?draft=<draftId>
// =============================================================================

export default function WritePage() {
  const { user, loading } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()

  const editEventId = searchParams.get('edit')
  const draftId = searchParams.get('draft')

  const [editorReady, setEditorReady] = useState(false)
  const [initialData, setInitialData] = useState<{
    title: string
    content: string
    gatePosition: number
    price: number
    commentsEnabled: boolean
    editingEventId?: string
    editingDTag?: string
  } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (!loading && !user) {
      router.push('/auth?mode=login')
    }
  }, [user, loading, router])

  // Load edit or draft data
  useEffect(() => {
    if (!user) return

    async function loadEditData() {
      if (editEventId) {
        try {
          // Fetch article metadata from gateway
          const ndk = getNdk()
          await ndk.connect()

          // Find the article event on the relay by event ID
          const event = await ndk.fetchEvent(editEventId)
          if (!event) {
            setLoadError('Could not find the article to edit.')
            return
          }

          const dTag = event.tagValue('d') ?? ''
          const title = event.tagValue('title') ?? ''
          const priceTag = event.tags.find(t => t[0] === 'price')
          const gateTag = event.tags.find(t => t[0] === 'gate')

          setInitialData({
            title,
            content: event.content,
            gatePosition: gateTag ? parseInt(gateTag[1], 10) : 50,
            price: priceTag ? parseInt(priceTag[1], 10) : 0,
            commentsEnabled: true, // Will be overridden by DB data if available
            editingEventId: editEventId,
            editingDTag: dTag,
          })
        } catch (err) {
          console.error('Failed to load article for editing:', err)
          setLoadError('Failed to load article for editing.')
        }
      } else if (draftId) {
        try {
          const draft = await loadDraft(draftId)
          if (!draft) {
            setLoadError('Draft not found.')
            return
          }
          setInitialData({
            title: (draft as any).title ?? '',
            content: (draft as any).content ?? '',
            gatePosition: (draft as any).gatePositionPct ?? 50,
            price: (draft as any).pricePence ?? 0,
            commentsEnabled: true,
            editingDTag: (draft as any).dTag ?? undefined,
          })
        } catch {
          setLoadError('Failed to load draft.')
        }
      } else {
        // New article — no initial data needed
        setInitialData(null)
      }
      setEditorReady(true)
    }

    loadEditData()
  }, [user, editEventId, draftId])

  async function handlePublish(data: PublishData) {
    if (!user) return

    const result = await publishArticle(
      data,
      user.pubkey,
      initialData?.editingDTag
    )
    console.log('Published:', result)
    router.push('/dashboard?tab=articles')
  }

  if (loading || !user) {
    return (
      <div className="mx-auto max-w-article px-6 pt-16 pb-16 lg:pt-8 text-center">
        <div className="h-8 w-48 mx-auto animate-pulse rounded bg-ink-100" />
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-article px-6 pt-16 pb-16 lg:pt-8 text-center">
        <p className="text-red-600 mb-4">{loadError}</p>
        <a href="/dashboard" className="text-sm text-brand-600 hover:text-brand-700">
          Back to dashboard
        </a>
      </div>
    )
  }

  if ((editEventId || draftId) && !editorReady) {
    return (
      <div className="mx-auto max-w-article px-6 pt-16 pb-16 lg:pt-8 text-center">
        <div className="h-8 w-48 mx-auto animate-pulse rounded bg-ink-100" />
        <p className="mt-4 text-sm text-ink-400">Loading...</p>
      </div>
    )
  }

  return (
    <ArticleEditor
      initialTitle={initialData?.title}
      initialContent={initialData?.content}
      initialGatePosition={initialData?.gatePosition}
      initialPrice={initialData?.price}
      initialCommentsEnabled={initialData?.commentsEnabled}
      editingEventId={initialData?.editingEventId}
      editingDTag={initialData?.editingDTag}
      onPublish={handlePublish}
    />
  )
}

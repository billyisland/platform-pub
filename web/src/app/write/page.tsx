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
    dek: string
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
          const summary = event.tagValue('summary') ?? ''
          const priceTag = event.tags.find(t => t[0] === 'price')
          const gateTag = event.tags.find(t => t[0] === 'gate')

          setInitialData({
            title,
            dek: summary,
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
            title: draft.title ?? '',
            dek: draft.dek ?? '',
            content: draft.content ?? '',
            gatePosition: draft.gatePositionPct ?? 50,
            price: draft.pricePence ?? 0,
            commentsEnabled: true,
            editingDTag: draft.dTag ?? undefined,
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
    router.push('/dashboard?tab=articles')
  }

  if (loading || !user) {
    return (
      <div className="mx-auto max-w-article px-6 pt-16 pb-16 lg:pt-8 text-center">
        <div className="h-8 w-48 mx-auto animate-pulse rounded bg-surface-deep" />
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-article px-6 pt-16 pb-16 lg:pt-8 text-center">
        <p className="text-red-600 mb-4">{loadError}</p>
        <a href="/dashboard" className="text-sm text-accent hover:text-accent-dark">
          Back to dashboard
        </a>
      </div>
    )
  }

  if ((editEventId || draftId) && !editorReady) {
    return (
      <div className="mx-auto max-w-article px-6 pt-16 pb-16 lg:pt-8 text-center">
        <div className="h-8 w-48 mx-auto animate-pulse rounded bg-surface-deep" />
        <p className="mt-4 text-sm text-content-faint">Loading...</p>
      </div>
    )
  }

  return (
    <ArticleEditor
      initialTitle={initialData?.title}
      initialDek={initialData?.dek}
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

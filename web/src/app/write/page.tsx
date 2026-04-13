'use client'

import { useAuth } from '../../stores/auth'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import type { PublishData } from '../../components/editor/ArticleEditor'

const ArticleEditor = dynamic(
  () => import('../../components/editor/ArticleEditor').then(m => m.ArticleEditor),
  {
    ssr: false,
    loading: () => (
      <div className="mx-auto max-w-article px-4 sm:px-6 pt-16 pb-16 lg:pt-8 text-center">
        <div className="h-8 w-48 mx-auto animate-pulse rounded bg-grey-100" />
        <p className="mt-4 text-sm text-grey-300">Loading editor...</p>
      </div>
    ),
  }
)
import { publishArticle, publishToPublication } from '../../lib/publish'
import { loadDraft, saveDraft, scheduleDraft } from '../../lib/drafts'
import { articles as articlesApi, publications as publicationsApi, tags as tagsApi } from '../../lib/api'
import type { PublicationContext } from '../../components/editor/ArticleEditor'

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
  const pubSlug = searchParams.get('pub')

  const [editorReady, setEditorReady] = useState(false)
  const [initialData, setInitialData] = useState<{
    title: string
    dek: string
    content: string
    gatePosition: number
    price: number
    commentsEnabled: boolean
    tags?: string[]
    editingEventId?: string
    editingDTag?: string
    publicationId?: string | null
  } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pubMemberships, setPubMemberships] = useState<PublicationContext[]>([])
  const [initialPubId, setInitialPubId] = useState<string | null>(null)

  useEffect(() => {
    if (!loading && !user) {
      router.push('/auth?mode=login')
    }
  }, [user, loading, router])

  // Load publication memberships
  useEffect(() => {
    if (!user) return
    publicationsApi.myMemberships().then(res => {
      const ctx: PublicationContext[] = res.publications.map(p => ({
        id: p.id, slug: p.slug, name: p.name,
        can_publish: p.can_publish,
      }))
      setPubMemberships(ctx)
      // Pre-select from ?pub= query param
      if (pubSlug) {
        const match = ctx.find(p => p.slug === pubSlug)
        if (match) setInitialPubId(match.id)
      }
    }).catch(() => { /* non-critical */ })
  }, [user, pubSlug])

  // Load edit or draft data
  useEffect(() => {
    if (!user) return

    async function loadEditData() {
      if (editEventId) {
        try {
          // Fetch article data from gateway by event ID
          // The gateway stores the free content which is enough to populate the editor
          const res = await fetch(`/api/v1/articles/by-event/${editEventId}`, { credentials: 'include' })
          if (!res.ok) {
            // Fallback: try to find by searching my articles
            setLoadError('Could not find the article to edit.')
            return
          }
          const meta = await res.json()

          let existingTags: string[] = []
          if (meta.id) {
            try { existingTags = (await tagsApi.getForArticle(meta.id)).tags } catch { /* non-fatal */ }
          }

          setInitialData({
            title: meta.title ?? '',
            dek: meta.summary ?? '',
            content: meta.contentFree ?? '',
            gatePosition: meta.gatePositionPct ?? 50,
            price: meta.pricePence ?? 0,
            commentsEnabled: true,
            tags: existingTags,
            editingEventId: editEventId,
            editingDTag: meta.dTag ?? '',
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

    if (data.publicationId) {
      // Publication article — server-side pipeline
      const result = await publishToPublication(
        data.publicationId,
        { ...data, showOnWriterProfile: data.showOnWriterProfile },
        initialData?.editingDTag
      )
      const pub = pubMemberships.find(p => p.id === data.publicationId)
      router.push(`/dashboard?context=${pub?.slug ?? ''}&tab=articles`)
    } else {
      // Personal article — existing client-side pipeline
      await publishArticle(
        data,
        user.pubkey,
        initialData?.editingDTag
      )
      router.push('/dashboard?tab=articles')
    }
  }

  async function handleSchedule(data: PublishData, scheduledAt: string) {
    if (!user) return

    // Save the draft first, then schedule it
    const content = data.content
    const saved = await saveDraft({
      title: data.title,
      dek: data.dek,
      content,
      gatePositionPct: data.gatePositionPct,
      pricePence: data.pricePence,
      dTag: initialData?.editingDTag,
    })

    await scheduleDraft(saved.draftId, scheduledAt)
    router.push('/dashboard?tab=articles')
  }

  if (loading || !user) {
    return (
      <div className="mx-auto max-w-article px-4 sm:px-6 pt-16 pb-16 lg:pt-8 text-center">
        <div className="h-8 w-48 mx-auto animate-pulse rounded bg-grey-100" />
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-article px-4 sm:px-6 pt-16 pb-16 lg:pt-8 text-center">
        <p className="text-red-600 mb-4">{loadError}</p>
        <a href="/dashboard" className="text-sm text-crimson hover:text-crimson-dark">
          Back to dashboard
        </a>
      </div>
    )
  }

  if ((editEventId || draftId) && !editorReady) {
    return (
      <div className="mx-auto max-w-article px-4 sm:px-6 pt-16 pb-16 lg:pt-8 text-center">
        <div className="h-8 w-48 mx-auto animate-pulse rounded bg-grey-100" />
        <p className="mt-4 text-sm text-grey-300">Loading...</p>
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
      initialTags={initialData?.tags}
      editingEventId={initialData?.editingEventId}
      editingDTag={initialData?.editingDTag}
      publicationMemberships={pubMemberships}
      initialPublicationId={initialPubId}
      onPublish={handlePublish}
      onSchedule={!editEventId ? handleSchedule : undefined}
    />
  )
}

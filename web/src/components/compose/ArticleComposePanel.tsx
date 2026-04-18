'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import CharacterCount from '@tiptap/extension-character-count'
import { Markdown } from 'tiptap-markdown'
import { useAuth } from '../../stores/auth'
import { useCompose } from '../../stores/compose'
import { createAutoSaver, saveDraft, loadDraft, scheduleDraft } from '../../lib/drafts'
import { publishArticle, publishToPublication } from '../../lib/publish'
import { publications as publicationsApi } from '../../lib/api'
import { uploadImage } from '../../lib/media'
import { ImageUpload } from '../editor/ImageUpload'
import { PaywallGateNode, PAYWALL_GATE_MARKER } from '../editor/PaywallGateNode'
import { EmbedNode } from '../editor/EmbedNode'
import type { PublishData } from '../editor/ArticleEditor'

interface Membership {
  id: string
  slug: string
  name: string
  can_publish: boolean
}

export function ArticleComposePanel() {
  const router = useRouter()
  const { user } = useAuth()
  const { articleDraftId, articlePublicationSlug, close } = useCompose()

  const [title, setTitle] = useState('')
  const [pricePence, setPricePence] = useState(user?.defaultArticlePricePence ?? 0)
  const [draftId, setDraftId] = useState<string | null>(articleDraftId)
  const [saveStatus, setSaveStatus] = useState<string | null>(null)
  const [memberships, setMemberships] = useState<Membership[]>([])
  const [selectedPubId, setSelectedPubId] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)
  const [showSchedule, setShowSchedule] = useState(false)
  const [scheduleDateTime, setScheduleDateTime] = useState('')
  const [uploading, setUploading] = useState(false)
  const [loadingDraft, setLoadingDraft] = useState(!!articleDraftId)

  const titleRef = useRef(title)
  titleRef.current = title
  const priceRef = useRef(pricePence)
  priceRef.current = pricePence
  const draftIdRef = useRef<string | null>(articleDraftId)
  draftIdRef.current = draftId
  const userSetPrice = useRef(user?.defaultArticlePricePence != null)

  const autoSaver = useMemo(() => createAutoSaver(3000), [])

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3] } }),
      Markdown.configure({ html: false, transformCopiedText: true }),
      Image.configure({ inline: false, allowBase64: false }),
      ImageUpload.configure({
        onUploadStart: () => setUploading(true),
        onUploadEnd: () => setUploading(false),
        onUploadError: (err) => {
          setUploading(false)
          setPublishError(err.message)
        },
      }),
      EmbedNode,
      PaywallGateNode,
      Placeholder.configure({ placeholder: 'Start writing…' }),
      CharacterCount,
    ],
    editorProps: {
      attributes: {
        class: 'prose prose-lg max-w-none focus:outline-none min-h-[200px] article-compose-body',
      },
    },
    onUpdate: ({ editor }) => {
      if (!userSetPrice.current) {
        const words = editor.storage.characterCount.words()
        const suggested = suggestPrice(words)
        setPricePence(suggested)
        priceRef.current = suggested
      }
      const content = editor.storage.markdown.getMarkdown()
      autoSaver(
        {
          title: titleRef.current,
          content,
          gatePositionPct: 50,
          pricePence: priceRef.current,
        },
        (saved) => {
          setDraftId(saved.draftId)
          draftIdRef.current = saved.draftId
          setSaveStatus(`SAVED · ${timestamp()}`)
        },
        () => setSaveStatus('SAVE FAILED'),
      )
    },
  })

  // Load publication memberships once
  useEffect(() => {
    if (!user) return
    publicationsApi.myMemberships().then((res) => {
      const list: Membership[] = res.publications.map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        can_publish: p.can_publish,
      }))
      setMemberships(list)
      if (articlePublicationSlug) {
        const match = list.find((p) => p.slug === articlePublicationSlug)
        if (match) setSelectedPubId(match.id)
      }
    }).catch(() => { /* non-critical */ })
  }, [user, articlePublicationSlug])

  // Hydrate from an existing draft, if one was opened
  useEffect(() => {
    if (!articleDraftId || !editor) return
    let cancelled = false
    loadDraft(articleDraftId).then((draft) => {
      if (cancelled || !draft) {
        setLoadingDraft(false)
        return
      }
      setTitle(draft.title ?? '')
      titleRef.current = draft.title ?? ''
      if (draft.pricePence != null) {
        setPricePence(draft.pricePence)
        priceRef.current = draft.pricePence
        userSetPrice.current = draft.pricePence > 0
      }
      editor.commands.setContent(draft.content ?? '')
      setLoadingDraft(false)
    }).catch(() => setLoadingDraft(false))
    return () => { cancelled = true }
  }, [articleDraftId, editor])

  const hasGateMarker = useCallback(() => {
    if (!editor) return false
    let found = false
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'paywallGate') {
        found = true
        return false
      }
    })
    return found
  }, [editor])

  const flushDraft = useCallback(async (): Promise<string | null> => {
    if (!editor) return draftIdRef.current
    const content = editor.storage.markdown.getMarkdown()
    if (!titleRef.current.trim() && !content.trim()) return draftIdRef.current
    try {
      const saved = await saveDraft({
        title: titleRef.current,
        content,
        gatePositionPct: 50,
        pricePence: priceRef.current,
      })
      setDraftId(saved.draftId)
      draftIdRef.current = saved.draftId
      return saved.draftId
    } catch {
      return draftIdRef.current
    }
  }, [editor])

  const buildPublishData = useCallback((): PublishData | null => {
    if (!editor || !title.trim()) return null
    const fullContent = editor.storage.markdown.getMarkdown()
    const isPaywalled = hasGateMarker()
    let freeContent = fullContent
    let paywallContent = ''
    let gatePositionPct = 0
    if (isPaywalled) {
      const idx = fullContent.indexOf(PAYWALL_GATE_MARKER)
      if (idx !== -1) {
        freeContent = fullContent.slice(0, idx).trim()
        paywallContent = fullContent.slice(idx + PAYWALL_GATE_MARKER.length).trim()
        const total = freeContent.length + paywallContent.length
        gatePositionPct = total > 0
          ? Math.min(99, Math.max(1, Math.round((freeContent.length / total) * 100)))
          : 50
      }
    }
    return {
      title: title.trim(),
      dek: '',
      content: fullContent.replace(PAYWALL_GATE_MARKER, '').trim(),
      freeContent,
      paywallContent,
      isPaywalled,
      pricePence: isPaywalled ? pricePence : 0,
      gatePositionPct,
      commentsEnabled: true,
      publicationId: selectedPubId,
      showOnWriterProfile: true,
      sendEmail: true,
      tags: [],
    }
  }, [editor, title, pricePence, hasGateMarker, selectedPubId])

  const handleOpenInFull = useCallback(async () => {
    const id = await flushDraft()
    const params = new URLSearchParams()
    if (id) params.set('draft', id)
    if (selectedPubId) {
      const slug = memberships.find((m) => m.id === selectedPubId)?.slug
      if (slug) params.set('pub', slug)
    }
    const query = params.toString()
    close()
    router.push(query ? `/write?${query}` : '/write')
  }, [flushDraft, selectedPubId, memberships, close, router])

  const handlePublish = useCallback(async () => {
    if (!user) return
    const data = buildPublishData()
    if (!data) return
    setPublishing(true)
    setPublishError(null)
    try {
      if (data.publicationId) {
        const result = await publishToPublication(data.publicationId, data)
        const slug = memberships.find((m) => m.id === data.publicationId!)?.slug ?? ''
        close()
        router.push(`/dashboard?context=${slug}&tab=articles`)
        return result
      }
      const result = await publishArticle(data, user.pubkey)
      close()
      router.push('/dashboard?tab=articles')
      return result
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : 'Publishing failed.')
    } finally {
      setPublishing(false)
    }
  }, [user, buildPublishData, memberships, close, router])

  const handleSchedule = useCallback(async () => {
    if (!editor || !title.trim() || !scheduleDateTime) return
    setPublishing(true)
    setPublishError(null)
    try {
      const id = await flushDraft()
      if (!id) throw new Error('Draft save failed')
      await scheduleDraft(id, new Date(scheduleDateTime).toISOString())
      close()
      router.push('/dashboard?tab=articles')
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : 'Scheduling failed.')
    } finally {
      setPublishing(false)
      setShowSchedule(false)
      setScheduleDateTime('')
    }
  }, [editor, title, scheduleDateTime, flushDraft, close, router])

  if (!editor) {
    return (
      <div className="px-6 py-10 text-center">
        <span className="label-ui text-grey-400">LOADING EDITOR</span>
      </div>
    )
  }

  const wordCount = editor.storage.characterCount.words()
  const readMinutes = Math.max(1, Math.round(wordCount / 200))
  const gateInserted = hasGateMarker()
  const selectedPub = memberships.find((m) => m.id === selectedPubId)
  const canPublish = !publishing && !loadingDraft && title.trim().length > 0 && wordCount >= 10

  return (
    <>
      {/* Top zone: title + publication selector */}
      <div className="px-6 py-4 space-y-2" style={{ borderBottom: '4px solid #E5E5E5' }}>
        <input
          type="text"
          value={title}
          onChange={(e) => { setTitle(e.target.value); titleRef.current = e.target.value }}
          placeholder="Article title"
          className="w-full border-none bg-transparent font-serif italic text-[22px] text-black placeholder:text-grey-300 focus:outline-none"
          style={{ letterSpacing: '-0.02em', lineHeight: 1.2 }}
        />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="label-ui text-grey-400">PUBLISH AS:</span>
            {memberships.length > 0 ? (
              <select
                value={selectedPubId ?? ''}
                onChange={(e) => setSelectedPubId(e.target.value || null)}
                className="font-mono text-[11px] uppercase tracking-[0.06em] text-black bg-transparent border-none focus:outline-none cursor-pointer"
              >
                <option value="">PERSONAL</option>
                {memberships.map((m) => (
                  <option key={m.id} value={m.id}>{m.name.toUpperCase()}</option>
                ))}
              </select>
            ) : (
              <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-black">PERSONAL</span>
            )}
          </div>
          {wordCount > 0 && (
            <span className="font-mono text-[11px] text-grey-400">
              {wordCount} WORDS · {readMinutes} MIN
            </span>
          )}
        </div>
      </div>

      {/* Inline toolbar */}
      <div className="px-6 py-2 flex items-center gap-1" style={{ borderBottom: '1px solid #F0F0F0' }}>
        <TB onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive('bold')}>B</TB>
        <TB onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive('italic')}>I</TB>
        <TB onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={editor.isActive('heading', { level: 2 })}>H2</TB>
        <TB onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} active={editor.isActive('heading', { level: 3 })}>H3</TB>
        <TB onClick={() => editor.chain().focus().toggleBlockquote().run()} active={editor.isActive('blockquote')}>&ldquo;</TB>
        <TB
          onClick={async () => {
            const input = document.createElement('input')
            input.type = 'file'
            input.accept = 'image/jpeg,image/png,image/gif,image/webp'
            input.onchange = async (e) => {
              const file = (e.target as HTMLInputElement).files?.[0]
              if (!file) return
              setUploading(true)
              try {
                const result = await uploadImage(file)
                editor.chain().focus().setImage({ src: result.url }).run()
              } catch (err) {
                setPublishError(err instanceof Error ? err.message : 'Image upload failed')
              } finally {
                setUploading(false)
              }
            }
            input.click()
          }}
        >
          {uploading ? '…' : 'IMG'}
        </TB>
        <span className="mx-1 text-grey-300">|</span>
        <TB
          onClick={() => {
            if (gateInserted) editor.commands.removePaywallGate()
            else editor.commands.insertPaywallGate()
          }}
          active={gateInserted}
          accent
        >
          {gateInserted ? 'PAID ✓' : 'PAYWALL'}
        </TB>
      </div>

      {/* Editor body */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <EditorContent editor={editor} />
        {gateInserted && (
          <div className="mt-4 flex items-center gap-3 py-2" style={{ borderTop: '1px solid #F0F0F0' }}>
            <span className="label-ui text-grey-400">PRICE</span>
            <span className="font-mono text-[11px] text-grey-600">£</span>
            <input
              type="number"
              min={0.01}
              step={0.01}
              value={(pricePence / 100).toFixed(2)}
              onChange={(e) => {
                userSetPrice.current = true
                const n = parseFloat(e.target.value)
                setPricePence(isNaN(n) ? 0 : Math.round(n * 100))
              }}
              className="w-20 bg-transparent border-none font-mono text-[11px] text-black focus:outline-none"
            />
          </div>
        )}
      </div>

      {/* Controls zone */}
      <div className="px-6 py-3 flex items-center gap-4" style={{ borderTop: '4px solid #E5E5E5' }}>
        <span className="font-mono text-[11px] text-grey-400 min-w-[80px]">
          {saveStatus ?? (loadingDraft ? 'LOADING…' : draftId ? 'DRAFT' : '')}
        </span>
        <span className="flex-1" />
        <button
          onClick={handleOpenInFull}
          className="font-mono text-[11px] uppercase tracking-[0.06em] text-grey-600 hover:text-black transition-colors"
        >
          OPEN IN FULL EDITOR ↗
        </button>
        <button
          onClick={() => setShowSchedule((v) => !v)}
          disabled={!canPublish}
          className="font-mono text-[11px] uppercase tracking-[0.06em] text-grey-600 hover:text-black transition-colors disabled:opacity-40"
        >
          SCHEDULE
        </button>
        <button
          onClick={handlePublish}
          disabled={!canPublish}
          className="btn-accent disabled:opacity-30 py-1.5 px-5 text-[12px] font-sans font-semibold"
        >
          {publishing
            ? 'Publishing…'
            : selectedPub && !selectedPub.can_publish
              ? 'Submit'
              : 'Publish'}
        </button>
      </div>

      {/* Schedule picker */}
      {showSchedule && (
        <div className="px-6 py-3 flex items-center gap-3" style={{ borderTop: '1px solid #F0F0F0' }}>
          <input
            type="datetime-local"
            value={scheduleDateTime}
            onChange={(e) => setScheduleDateTime(e.target.value)}
            min={new Date().toISOString().slice(0, 16)}
            className="bg-grey-100 px-3 py-1.5 text-sm focus:outline-none"
          />
          <button
            onClick={handleSchedule}
            disabled={publishing || !scheduleDateTime}
            className="btn text-sm disabled:opacity-50"
          >
            {publishing ? 'Scheduling…' : 'Confirm'}
          </button>
          <button
            onClick={() => { setShowSchedule(false); setScheduleDateTime('') }}
            className="font-mono text-[11px] uppercase tracking-[0.06em] text-grey-400 hover:text-black"
          >
            CANCEL
          </button>
        </div>
      )}

      {/* Error row */}
      {publishError && (
        <div className="px-6 py-2 flex items-center justify-between" style={{ borderTop: '1px solid #F0F0F0' }}>
          <p className="text-ui-xs text-crimson">{publishError}</p>
          <button onClick={() => setPublishError(null)} className="text-grey-600 hover:text-crimson text-sm ml-2">&times;</button>
        </div>
      )}
    </>
  )
}

function TB({ active, accent, onClick, children }: { active?: boolean; accent?: boolean; onClick: () => void; children: React.ReactNode }) {
  const base = 'px-2 py-1 text-[11px] font-mono uppercase tracking-[0.06em] rounded transition-colors'
  const tone = accent
    ? active ? 'text-crimson border border-crimson' : 'text-crimson hover:bg-grey-100 border border-transparent'
    : active ? 'bg-grey-100 text-black' : 'text-grey-400 hover:bg-grey-100 hover:text-black'
  return <button onClick={onClick} className={`${base} ${tone}`}>{children}</button>
}

function timestamp() {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function suggestPrice(wordCount: number): number {
  if (wordCount < 700) return 0
  if (wordCount < 1500) return 50
  if (wordCount < 3000) return 75
  if (wordCount < 5000) return 100
  if (wordCount < 7000) return 120
  if (wordCount < 9000) return 140
  if (wordCount < 11000) return 160
  if (wordCount < 13000) return 180
  return 200
}

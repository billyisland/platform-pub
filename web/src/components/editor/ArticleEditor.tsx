'use client'

import { useState, useCallback, useMemo, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import CharacterCount from '@tiptap/extension-character-count'
import { Markdown } from 'tiptap-markdown'
import { useAuth } from '../../stores/auth'
import { createAutoSaver, saveDraft, type SavedDraft } from '../../lib/drafts'
import { ImageUpload } from './ImageUpload'
import { TagInput } from './TagInput'
import { EmbedNode } from './EmbedNode'
import { PaywallGateNode, PAYWALL_GATE_MARKER } from './PaywallGateNode'
import { uploadImage } from '../../lib/media'

// =============================================================================
// Article Editor
//
// Rich text editor with:
//   - WYSIWYG with markdown shortcuts
//   - Inline paywall gate marker (visible divider, not a slider)
//   - Image upload via gateway (drag-and-drop, paste, file picker)
//   - Rich media embedding via oEmbed
//   - Character/word count
//   - NIP-23 markdown serialisation on publish
//   - Auto-save to drafts
//   - Edit mode for updating published articles
// =============================================================================

interface EditorProps {
  initialTitle?: string
  initialDek?: string
  initialContent?: string
  initialGatePosition?: number
  initialPrice?: number
  initialCommentsEnabled?: boolean
  initialTags?: string[]
  editingEventId?: string
  editingDTag?: string
  publicationMemberships?: PublicationContext[]
  initialPublicationId?: string | null
  onPublish?: (data: PublishData) => void
  onSchedule?: (data: PublishData, scheduledAt: string) => Promise<void>
}

export interface PublicationContext {
  id: string
  slug: string
  name: string
  can_publish: boolean
  default_article_price_pence?: number
}

export interface PublishData {
  title: string
  dek: string
  content: string
  freeContent: string
  paywallContent: string
  isPaywalled: boolean
  pricePence: number
  gatePositionPct: number
  commentsEnabled: boolean
  publicationId?: string | null
  showOnWriterProfile: boolean
  sendEmail?: boolean
  tags: string[]
}

export function ArticleEditor({
  initialTitle = '',
  initialDek = '',
  initialContent = '',
  initialGatePosition = 50,
  initialPrice,
  initialCommentsEnabled = true,
  initialTags = [],
  editingEventId,
  editingDTag,
  publicationMemberships = [],
  initialPublicationId = null,
  onPublish,
  onSchedule,
}: EditorProps) {
  const { user } = useAuth()

  const [title, setTitle] = useState(initialTitle)
  const [dek, setDek] = useState(initialDek)
  const defaultPrice = initialPrice ?? user?.defaultArticlePricePence ?? 0
  const [pricePence, setPricePence] = useState(defaultPrice)
  const [commentsEnabled, setCommentsEnabled] = useState(initialCommentsEnabled)
  const [articleTags, setArticleTags] = useState<string[]>(initialTags)
  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)
  const [draftStatus, setDraftStatus] = useState<string | null>(null)
  const [currentDraftId, setCurrentDraftId] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [selectedPublicationId, setSelectedPublicationId] = useState<string | null>(initialPublicationId)
  const [showOnWriterProfile, setShowOnWriterProfile] = useState(true)
  const [showPublishConfirm, setShowPublishConfirm] = useState(false)
  const [sendEmail, setSendEmail] = useState(true)
  const [showSchedulePicker, setShowSchedulePicker] = useState(false)
  const [scheduleDateTime, setScheduleDateTime] = useState('')

  const isEditing = !!editingEventId
  const userSetPrice = useRef(!!initialPrice || user?.defaultArticlePricePence != null)
  const selectedPub = publicationMemberships.find(p => p.id === selectedPublicationId)

  // Refs so the onUpdate closure always sees current values
  const titleRef = useRef(title)
  titleRef.current = title
  const dekRef = useRef(dek)
  dekRef.current = dek
  const pricePenceRef = useRef(pricePence)
  pricePenceRef.current = pricePence

  const autoSaver = useMemo(() => createAutoSaver(3000), [])

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
      }),
      Markdown.configure({
        html: false,
        transformCopiedText: true,
      }),
      Image.configure({
        inline: false,
        allowBase64: false,
      }),
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
      Placeholder.configure({
        placeholder: 'Start writing...',
      }),
      CharacterCount,
    ],
    content: initialContent,
    editorProps: {
      attributes: {
        class: 'prose prose-lg max-w-none focus:outline-none min-h-[400px]',
      },
    },
    onUpdate: ({ editor }) => {
      // Auto-suggest price based on word count (unless the user set one manually)
      if (!userSetPrice.current) {
        const words = editor.storage.characterCount.words()
        const suggested = suggestPrice(words)
        setPricePence(suggested)
        pricePenceRef.current = suggested
      }

      // Auto-save draft
      const content = editor.storage.markdown.getMarkdown()
      autoSaver(
        { title: titleRef.current, dek: dekRef.current, content, gatePositionPct: 50, pricePence: pricePenceRef.current },
        (saved) => {
          setCurrentDraftId(saved.draftId)
          setDraftStatus('Saved')
          setTimeout(() => setDraftStatus(null), 2000)
        },
        () => setDraftStatus('Save failed')
      )
    },
  })

  // Check if a paywall gate marker exists in the document
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

  const handlePublish = useCallback(async () => {
    if (!editor || !title.trim()) return

    setPublishing(true)
    setPublishError(null)
    setShowPublishConfirm(false)

    try {
      const fullContent = editor.storage.markdown.getMarkdown()
      const isPaywalled = hasGateMarker()

      let freeContent = fullContent
      let paywallContent = ''
      let gatePositionPct = 0

      if (isPaywalled) {
        const splitResult = splitAtGateMarker(fullContent)
        freeContent = splitResult.free
        paywallContent = splitResult.paywall
        // Calculate approximate gate position for the DB
        const totalLen = freeContent.length + paywallContent.length
        gatePositionPct = totalLen > 0 ? Math.min(99, Math.max(1, Math.round((freeContent.length / totalLen) * 100))) : 50
      }

      const data: PublishData = {
        title: title.trim(),
        dek: dek.trim(),
        content: fullContent.replace(PAYWALL_GATE_MARKER, '').trim(),
        freeContent,
        paywallContent,
        isPaywalled,
        pricePence: isPaywalled ? pricePence : 0,
        gatePositionPct,
        commentsEnabled,
        publicationId: selectedPublicationId,
        showOnWriterProfile,
        sendEmail: isEditing ? false : sendEmail,
        tags: articleTags,
      }

      if (onPublish) {
        await onPublish(data)
      }
    } catch (err) {
      console.error('Publish error:', err)
      setPublishError(err instanceof Error ? err.message : 'Publishing failed — please try again.')
    } finally {
      setPublishing(false)
    }
  }, [editor, title, dek, pricePence, onPublish, hasGateMarker, commentsEnabled, selectedPublicationId, showOnWriterProfile, sendEmail, isEditing, articleTags])

  // Show the publish confirmation panel for new personal articles;
  // submit-for-review and edits skip confirmation and go straight through.
  const handlePublishClick = useCallback(() => {
    const isSubmitForReview = selectedPub && !selectedPub.can_publish
    if (isEditing || isSubmitForReview) {
      handlePublish()
    } else {
      setSendEmail(true)
      setShowPublishConfirm(true)
    }
  }, [isEditing, selectedPub, handlePublish])

  const handleScheduleSubmit = useCallback(async () => {
    if (!editor || !title.trim() || !scheduleDateTime || !onSchedule) return

    setPublishing(true)
    setPublishError(null)

    try {
      const fullContent = editor.storage.markdown.getMarkdown()
      const isPaywalled = hasGateMarker()

      let freeContent = fullContent
      let paywallContent = ''
      let gatePositionPct = 0

      if (isPaywalled) {
        const splitResult = splitAtGateMarker(fullContent)
        freeContent = splitResult.free
        paywallContent = splitResult.paywall
        const totalLen = freeContent.length + paywallContent.length
        gatePositionPct = totalLen > 0 ? Math.min(99, Math.max(1, Math.round((freeContent.length / totalLen) * 100))) : 50
      }

      const data: PublishData = {
        title: title.trim(),
        dek: dek.trim(),
        content: fullContent.replace(PAYWALL_GATE_MARKER, '').trim(),
        freeContent,
        paywallContent,
        isPaywalled,
        pricePence: isPaywalled ? pricePence : 0,
        gatePositionPct,
        commentsEnabled,
        publicationId: selectedPublicationId,
        showOnWriterProfile,
        sendEmail: false,
        tags: articleTags,
      }

      await onSchedule(data, new Date(scheduleDateTime).toISOString())
    } catch (err) {
      console.error('Schedule error:', err)
      setPublishError(err instanceof Error ? err.message : 'Scheduling failed — please try again.')
    } finally {
      setPublishing(false)
      setShowSchedulePicker(false)
      setScheduleDateTime('')
    }
  }, [editor, title, dek, pricePence, onSchedule, hasGateMarker, commentsEnabled, selectedPublicationId, showOnWriterProfile, articleTags, scheduleDateTime])

  if (!editor) return null

  const wordCount = editor.storage.characterCount.words()
  const readMinutes = Math.max(1, Math.round(wordCount / 200))
  const priceDisplay = (pricePence / 100).toFixed(2)
  const gateInserted = hasGateMarker()

  return (
    <div className="mx-auto max-w-editor-frame px-4 sm:px-6 pt-16 lg:pt-8 pb-8">
      {/* Sticky title + toolbar — stays visible while scrolling the body */}
      <div className="sticky top-[53px] lg:top-0 z-20 bg-white pb-4 mb-6">
      {/* Title card */}
      <div className="bg-grey-100 px-5 py-4 mb-2">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Article title"
          className="w-full border-none bg-transparent font-serif text-2xl font-medium italic text-black placeholder:text-grey-300 focus:outline-none sm:text-3xl"
          style={{ letterSpacing: '-0.02em' }}
        />
      </div>

      {/* Standfirst card */}
      <div className="bg-grey-100 px-5 py-4 mb-2">
        <input
          type="text"
          value={dek}
          onChange={(e) => setDek(e.target.value)}
          placeholder="Add a subtitle or standfirst…"
          className="w-full border-none bg-transparent font-serif text-lg text-grey-600 italic placeholder:text-grey-300 focus:outline-none"
        />
      </div>

      {/* Editor toolbar */}
      <div className="flex items-center gap-0.5 sm:gap-1 bg-white px-2 sm:px-4 py-2.5">
        <ToolbarButton
          active={editor.isActive('bold')}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          B
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive('italic')}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          I
        </ToolbarButton>
        <span className="contents max-[479px]:hidden">
          <ToolbarButton
            active={editor.isActive('heading', { level: 2 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          >
            H2
          </ToolbarButton>
        </span>
        <span className="hidden sm:contents">
          <ToolbarButton
            active={editor.isActive('heading', { level: 3 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          >
            H3
          </ToolbarButton>
        </span>
        <ToolbarButton
          active={editor.isActive('blockquote')}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        >
          &ldquo;
        </ToolbarButton>
        <span className="contents max-[479px]:hidden">
          <ToolbarButton
            active={editor.isActive('bulletList')}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          >
            &bull;
          </ToolbarButton>
        </span>
        <ToolbarButton
          active={false}
          onClick={() => {
            const input = document.createElement('input')
            input.type = 'file'
            input.accept = 'image/jpeg,image/png,image/gif,image/webp'
            input.onchange = async (e) => {
              const file = (e.target as HTMLInputElement).files?.[0]
              if (!file) return
              try {
                setUploading(true)
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
          {uploading ? '...' : 'img'}
        </ToolbarButton>
        <ToolbarButton
          active={false}
          onClick={() => {
            const url = window.prompt('Paste a YouTube, Vimeo, Twitter, or Spotify URL:')
            if (url) {
              editor.chain().focus().setEmbed({ src: url }).run()
            }
          }}
        >
          embed
        </ToolbarButton>

        {/* Paywall gate button */}
        <span className="mx-1 text-grey-300">|</span>
        <ToolbarButton
          active={gateInserted}
          accent
          onClick={() => {
            if (gateInserted) {
              editor.commands.removePaywallGate()
            } else {
              editor.commands.insertPaywallGate()
            }
          }}
        >
          {gateInserted ? 'Paywall ✓' : 'Paywall'}
        </ToolbarButton>

        <div className="ml-auto shrink-0 text-xs text-grey-300 max-[479px]:hidden">
          {wordCount} words &middot; {readMinutes} min read
        </div>
      </div>
      </div>{/* end sticky */}

      {/* Editor content — solid writing area */}
      <div className="bg-grey-100 p-8 sm:p-10">
        <EditorContent editor={editor} />
      </div>

      {/* Tags */}
      <div className="mt-3">
        <TagInput value={articleTags} onChange={setArticleTags} />
      </div>

      {/* Article settings card — publishing, price, replies */}
      <div className="mt-3 bg-grey-100 px-5 py-4 space-y-3">
        {/* Publishing as */}
        {publicationMemberships.length > 0 && (
          <div className="flex items-center gap-3 flex-wrap">
            <label className="label-ui text-grey-400">Publishing as</label>
            <select
              value={selectedPublicationId ?? ''}
              onChange={(e) => setSelectedPublicationId(e.target.value || null)}
              className="bg-grey-100 px-3 py-1.5 text-sm text-black"
            >
              <option value="">Yourself</option>
              {publicationMemberships.map(pub => (
                <option key={pub.id} value={pub.id}>{pub.name}</option>
              ))}
            </select>
            {selectedPublicationId && (
              <label className="flex items-center gap-2 ml-auto cursor-pointer">
                <input
                  type="checkbox"
                  checked={showOnWriterProfile}
                  onChange={(e) => setShowOnWriterProfile(e.target.checked)}
                />
                <span className="text-ui-xs text-grey-400">Also show on personal profile</span>
              </label>
            )}
          </div>
        )}

        {/* Price — only when paywall gate is inserted */}
        {gateInserted && (
          <div className="flex items-center gap-4">
            <label className="label-ui text-grey-400">Price</label>
            <div className="flex items-center gap-2">
              <span className="text-ui-xs text-grey-400">&pound;</span>
              <input
                type="number"
                min={0.01}
                step={0.01}
                value={(pricePence / 100).toFixed(2)}
                onChange={(e) => {
                  userSetPrice.current = true
                  setPricePence(Math.round(parseFloat(e.target.value) * 100))
                }}
                className="w-24 bg-white border-none px-3 py-1.5 text-sm focus:outline-none"
              />
              <span className="text-mono-xs text-grey-300">
                Suggested: &pound;{priceDisplay} based on {wordCount} words
              </span>
            </div>
          </div>
        )}

        {/* Replies toggle */}
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={commentsEnabled}
            onChange={(e) => setCommentsEnabled(e.target.checked)}
          />
          <span className="text-ui-xs text-grey-400">
            Allow replies
          </span>
        </label>
      </div>

      {/* Publish confirmation panel */}
      {showPublishConfirm && (
        <div className="mt-6 bg-grey-100 px-5 py-4 rounded">
          <p className="text-sm text-grey-600 mb-3">Your article will be published.</p>
          <label className="flex items-center gap-2 mb-4 cursor-pointer">
            <input
              type="checkbox"
              checked={sendEmail}
              onChange={(e) => setSendEmail(e.target.checked)}
            />
            <span className="text-sm text-grey-600">
              Email subscribers
            </span>
          </label>
          <div className="flex items-center gap-3">
            <button
              onClick={handlePublish}
              disabled={publishing}
              className="btn disabled:opacity-50"
            >
              {publishing ? 'Publishing...' : 'Publish'}
            </button>
            <button
              onClick={() => setShowPublishConfirm(false)}
              className="text-sm text-grey-300 hover:text-grey-600 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Publish button */}
      {publishError && (
        <div className="mt-6 bg-red-50 px-5 py-3 text-sm text-red-700">
          {publishError}
        </div>
      )}
      {!showPublishConfirm && (
      <div className="mt-6 flex items-center gap-4">
        <button
          onClick={handlePublishClick}
          disabled={publishing || !title.trim() || wordCount < 10}
          className="btn disabled:opacity-50"
        >
          {publishing
            ? (isEditing ? 'Updating...' : 'Publishing...')
            : isEditing
              ? 'Update'
              : selectedPub && !selectedPub.can_publish
                ? 'Submit for review'
                : 'Publish'}
        </button>
        {!isEditing && onSchedule && (
          <button
            onClick={() => setShowSchedulePicker(!showSchedulePicker)}
            disabled={publishing || !title.trim() || wordCount < 10}
            className="text-sm text-grey-400 hover:text-black transition-colors disabled:opacity-50"
          >
            Schedule
          </button>
        )}
        <button
          className="text-sm text-grey-300 hover:text-grey-600 transition-colors"
          onClick={async () => {
            if (!editor) return
            setDraftStatus('Saving...')
            try {
              const content = editor.storage.markdown.getMarkdown()
              const saved = await saveDraft({
                title, dek, content, gatePositionPct: 50, pricePence,
              })
              setCurrentDraftId(saved.draftId)
              setDraftStatus('Saved')
              setTimeout(() => setDraftStatus(null), 2000)
            } catch {
              setDraftStatus('Save failed')
            }
          }}
        >
          Save draft
        </button>
        {draftStatus && (
          <span className="text-xs text-grey-300">{draftStatus}</span>
        )}
      </div>
      )}

      {/* Schedule picker */}
      {showSchedulePicker && (
        <div className="mt-3 flex items-center gap-3">
          <input
            type="datetime-local"
            value={scheduleDateTime}
            onChange={e => setScheduleDateTime(e.target.value)}
            min={new Date().toISOString().slice(0, 16)}
            className="bg-grey-100 px-3 py-1.5 text-sm focus:outline-none"
          />
          <button
            onClick={handleScheduleSubmit}
            disabled={publishing || !scheduleDateTime}
            className="btn text-sm disabled:opacity-50"
          >
            {publishing ? 'Scheduling...' : 'Confirm schedule'}
          </button>
          <button
            onClick={() => { setShowSchedulePicker(false); setScheduleDateTime('') }}
            className="text-sm text-grey-300 hover:text-black"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}

// =============================================================================
// Helpers
// =============================================================================

function ToolbarButton({
  active,
  accent,
  onClick,
  children,
}: {
  active: boolean
  accent?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  const accentStyles = accent
    ? active
      ? 'bg-grey-100 text-crimson border border-crimson'
      : 'text-crimson hover:bg-grey-100 border border-transparent'
    : active
      ? 'bg-grey-100 text-black'
      : 'text-grey-400 hover:bg-grey-100 hover:text-black'

  return (
    <button
      onClick={onClick}
      className={`rounded px-1.5 sm:px-2.5 py-1 text-xs font-medium transition-colors ${accentStyles}`}
    >
      {children}
    </button>
  )
}

// Price suggestion per ADR §II.2
function suggestPrice(wordCount: number): number {
  if (wordCount < 700)   return 0
  if (wordCount < 1500)  return 50
  if (wordCount < 3000)  return 75
  if (wordCount < 5000)  return 100
  if (wordCount < 7000)  return 120
  if (wordCount < 9000)  return 140
  if (wordCount < 11000) return 160
  if (wordCount < 13000) return 180
  if (wordCount < 15000) return 200
  return 200
}

// Split markdown content at the paywall gate marker
function splitAtGateMarker(markdown: string): { free: string; paywall: string } {
  const markerIndex = markdown.indexOf(PAYWALL_GATE_MARKER)
  if (markerIndex === -1) {
    return { free: markdown, paywall: '' }
  }

  const free = markdown.slice(0, markerIndex).trim()
  const paywall = markdown.slice(markerIndex + PAYWALL_GATE_MARKER.length).trim()

  return { free, paywall }
}

'use client'

import { useState, useCallback, useMemo } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import CharacterCount from '@tiptap/extension-character-count'
import { Markdown } from 'tiptap-markdown'
import { useAuth } from '../../stores/auth'
import { createAutoSaver, saveDraft, type SavedDraft } from '../../lib/drafts'
import { ImageUpload } from './ImageUpload'
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
  editingEventId?: string
  editingDTag?: string
  onPublish?: (data: PublishData) => void
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
}

export function ArticleEditor({
  initialTitle = '',
  initialDek = '',
  initialContent = '',
  initialGatePosition = 50,
  initialPrice,
  initialCommentsEnabled = true,
  editingEventId,
  editingDTag,
  onPublish,
}: EditorProps) {
  const { user } = useAuth()

  const [title, setTitle] = useState(initialTitle)
  const [dek, setDek] = useState(initialDek)
  const [pricePence, setPricePence] = useState(initialPrice ?? 0)
  const [commentsEnabled, setCommentsEnabled] = useState(initialCommentsEnabled)
  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)
  const [draftStatus, setDraftStatus] = useState<string | null>(null)
  const [currentDraftId, setCurrentDraftId] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)

  const isEditing = !!editingEventId

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
      // Auto-suggest price based on word count
      if (!initialPrice) {
        const words = editor.storage.characterCount.words()
        const suggested = suggestPrice(words)
        setPricePence(suggested)
      }

      // Auto-save draft
      const content = editor.storage.markdown.getMarkdown()
      autoSaver(
        { title, dek, content, gatePositionPct: 50, pricePence },
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
  }, [editor, title, pricePence, onPublish, hasGateMarker, commentsEnabled])

  if (!editor) return null

  const wordCount = editor.storage.characterCount.words()
  const readMinutes = Math.max(1, Math.round(wordCount / 200))
  const priceDisplay = (pricePence / 100).toFixed(2)
  const gateInserted = hasGateMarker()

  return (
    <div className="mx-auto max-w-article px-6 pt-16 lg:pt-8 pb-8">
      {/* Sticky title + toolbar — stays visible while scrolling the body */}
      <div className="sticky top-[53px] lg:top-0 z-20 bg-surface pb-4 border-b border-rule mb-6">
      {/* Title input */}
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Article title"
        className="w-full border-none bg-transparent font-serif text-3xl font-medium italic text-ink placeholder:text-content-faint focus:outline-none mb-3 pt-4 sm:text-4xl"
        style={{ letterSpacing: '-0.02em' }}
      />
      <input
        type="text"
        value={dek}
        onChange={(e) => setDek(e.target.value)}
        placeholder="Add a subtitle or standfirst…"
        className="w-full border-none bg-transparent font-serif text-lg text-content-secondary italic placeholder:text-content-faint focus:outline-none mb-3"
      />

      {/* Editor toolbar */}
      <div className="flex items-center gap-1 flex-wrap">
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
        <ToolbarButton
          active={editor.isActive('heading', { level: 2 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        >
          H2
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive('heading', { level: 3 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        >
          H3
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive('blockquote')}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        >
          &ldquo;
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive('bulletList')}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          &bull;
        </ToolbarButton>
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
        <span className="mx-1 text-rule">|</span>
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

        <div className="ml-auto text-xs text-content-faint">
          {wordCount} words &middot; {readMinutes} min read
        </div>
      </div>
      </div>{/* end sticky */}

      {/* Editor content */}
      <EditorContent editor={editor} />

      {/* Price control — only shown when gate is inserted */}
      {gateInserted && (
        <div className="mt-10 border-t border-rule pt-6">
          <div className="flex items-center gap-4">
            <label className="block text-sm text-content-secondary">
              Price
            </label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-content-muted">&pound;</span>
              <input
                type="number"
                min={0.01}
                step={0.01}
                value={(pricePence / 100).toFixed(2)}
                onChange={(e) => setPricePence(Math.round(parseFloat(e.target.value) * 100))}
                className="w-24 border border-rule px-3 py-1.5 text-sm focus:border-accent focus:outline-none"
              />
              <span className="text-xs text-content-faint">
                Suggested: &pound;{priceDisplay} based on {wordCount} words
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Replies toggle */}
      <div className="mt-6 flex items-center gap-2">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={commentsEnabled}
            onChange={(e) => setCommentsEnabled(e.target.checked)}
          />
          <span className="text-sm text-content-secondary">
            Allow replies on this article
          </span>
        </label>
      </div>

      {/* Publish button */}
      {publishError && (
        <div className="mt-6 bg-red-50 px-4 py-3 text-sm text-red-700">
          {publishError}
        </div>
      )}
      <div className="mt-4 flex items-center gap-4">
        <button
          onClick={handlePublish}
          disabled={publishing || !title.trim() || wordCount < 10}
          className="btn disabled:opacity-50"
        >
          {publishing ? (isEditing ? 'Updating...' : 'Publishing...') : (isEditing ? 'Update' : 'Publish')}
        </button>
        <button
          className="text-sm text-content-faint hover:text-content-secondary transition-colors"
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
          <span className="text-xs text-content-faint">{draftStatus}</span>
        )}
      </div>
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
      ? 'bg-surface-deep text-accent border border-accent'
      : 'text-accent hover:bg-surface-deep border border-transparent'
    : active
      ? 'bg-surface-deep text-ink'
      : 'text-content-muted hover:bg-surface-deep hover:text-ink'

  return (
    <button
      onClick={onClick}
      className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${accentStyles}`}
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

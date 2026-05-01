'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import CharacterCount from '@tiptap/extension-character-count'
import { Markdown } from 'tiptap-markdown'
import { useAuth } from '../../stores/auth'
import { publishNote, type CrossPostTarget } from '../../lib/publishNote'
import { publishReply } from '../../lib/replies'
import { publishArticle, publishToPublication } from '../../lib/publish'
import { createAutoSaver, saveDraft } from '../../lib/drafts'
import { uploadImage } from '../../lib/media'
import { ImageUpload } from '../editor/ImageUpload'
import { EmbedNode } from '../editor/EmbedNode'
import { PaywallGateNode, PAYWALL_GATE_MARKER } from '../editor/PaywallGateNode'
import {
  resolver,
  messages as messagesApi,
  linkedAccounts as linkedAccountsApi,
  publications as publicationsApi,
  type LinkedAccount,
  type ResolverMatch,
  type ResolverResult,
} from '../../lib/api'

const NOTE_CHAR_LIMIT = 1000
const NUDGE_WORDS_THRESHOLD = 400

const TOKENS = {
  scrim: 'rgba(26, 26, 24, 0.4)',
  panelBg: '#FFFFFF',
  panelBorder: '#1A1A18',
  bannerBg: '#F0EFEB',
  bannerFg: '#1A1A18',
  hintFg: '#8A8880',
  errorFg: '#B5242A',
  publishBg: '#1A1A18',
  publishFg: '#F0EFEB',
  publishDisabled: '#BBBBBB',
  publishArticleBg: '#B5242A',
  inputBorder: '#E6E5E0',
  fieldBg: '#F0EFEB',
  chipBg: '#1A1A18',
  chipFg: '#F0EFEB',
  chipBroadcastBg: '#E6E5E0',
  chipBroadcastFg: '#1A1A18',
  matchHoverBg: '#F0EFEB',
  toggleOnBg: '#1A1A18',
  toggleOnFg: '#F0EFEB',
  toggleOffBg: 'transparent',
  toggleOffFg: '#1A1A18',
  toggleDisabledFg: '#BBBBBB',
  toolbarFg: '#5F5E5A',
  toolbarActive: '#1A1A18',
  toolbarHoverBg: '#F0EFEB',
  paywallFg: '#B5242A',
}

type Protocol = 'allhaus' | 'nostr' | 'atproto' | 'activitypub'

const PROTOCOL_LABELS: Record<Protocol, string> = {
  allhaus: 'ALL.HAUS',
  nostr: 'NOSTR',
  atproto: 'BLUESKY',
  activitypub: 'ACTIVITYPUB',
}

// Native protocols always available (allhaus + nostr ride the same custodial
// signing key). The other two require a linked_accounts row before they can
// receive a cross-post.
const NATIVE_PROTOCOLS: ReadonlySet<Protocol> = new Set(['allhaus', 'nostr'])

const PROTOCOL_FROM_LINKED: Record<LinkedAccount['protocol'], Protocol | null> = {
  atproto: 'atproto',
  activitypub: 'activitypub',
  nostr_external: null,
  rss: null,
}

const BROADCAST_TOKENS: { id: string; label: string; protocol: Protocol }[] = [
  { id: 'broadcast:allhaus', label: 'Everyone on all.haus', protocol: 'allhaus' },
  { id: 'broadcast:nostr', label: 'Everyone on Nostr', protocol: 'nostr' },
  { id: 'broadcast:atproto', label: 'Everyone on Bluesky', protocol: 'atproto' },
  { id: 'broadcast:activitypub', label: 'Everyone on the fediverse', protocol: 'activitypub' },
]

interface ToChip {
  kind: 'person' | 'broadcast'
  id: string
  label: string
  protocol?: Protocol
  match?: ResolverMatch
}

type ComposerMode = 'note' | 'article'

interface PublicationOption {
  id: string
  slug: string
  name: string
  canPublish: boolean
}

export interface ReplyTarget {
  eventId: string
  eventKind: number
  authorPubkey: string
  authorName: string
  excerpt?: string
}

interface ComposerProps {
  open: boolean
  initialMode?: ComposerMode
  replyTarget?: ReplyTarget | null
  onClose: () => void
  onPublished?: () => void
}

export function Composer({ open, initialMode = 'note', replyTarget, onClose, onPublished }: ComposerProps) {
  const { user } = useAuth()
  const [mode, setMode] = useState<ComposerMode>(initialMode)
  const [chips, setChips] = useState<ToChip[]>([])
  const [toQuery, setToQuery] = useState('')
  const [resolverResult, setResolverResult] = useState<ResolverResult | null>(null)
  const [resolving, setResolving] = useState(false)
  const [body, setBody] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [enabledProtocols, setEnabledProtocols] = useState<Set<Protocol>>(
    () => new Set<Protocol>(['allhaus', 'nostr', 'atproto', 'activitypub']),
  )
  const [linkedByProtocol, setLinkedByProtocol] = useState<Partial<Record<Protocol, LinkedAccount>>>({})

  // Article-mode state. Created up-front so the TipTap instance survives a
  // mode toggle within a single Composer open. Reset on close.
  const [title, setTitle] = useState('')
  const [dek, setDek] = useState('')
  const [pricePence, setPricePence] = useState(0)
  const [publications, setPublications] = useState<PublicationOption[]>([])
  const [selectedPublicationId, setSelectedPublicationId] = useState<string | null>(null)
  const [draftStatus, setDraftStatus] = useState<string | null>(null)
  const [currentDraftId, setCurrentDraftId] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [nudgeDismissed, setNudgeDismissed] = useState(false)
  const [showNudge, setShowNudge] = useState(false)

  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const toInputRef = useRef<HTMLInputElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollCountRef = useRef(0)
  const titleRef = useRef(title)
  titleRef.current = title
  const dekRef = useRef(dek)
  dekRef.current = dek
  const pricePenceRef = useRef(pricePence)
  pricePenceRef.current = pricePence
  const autoSaver = useMemo(() => createAutoSaver(3000), [])

  // TipTap editor for article mode. Always mounted while open so that
  // a mode switch from note→article carries the textarea content forward
  // without remounting; the editor's onUpdate also drives auto-save +
  // word count once article mode renders the surface.
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
          setError(err.message)
        },
      }),
      EmbedNode,
      PaywallGateNode,
      Placeholder.configure({ placeholder: 'Start writing…' }),
      CharacterCount,
    ],
    content: '',
    editorProps: {
      attributes: {
        class: 'prose prose-sm max-w-none focus:outline-none min-h-[280px]',
      },
    },
    onUpdate: ({ editor: ed }) => {
      const md = ed.storage.markdown.getMarkdown()
      // Auto-save fires only after we have a title — saveDraft requires it.
      if (titleRef.current.trim()) {
        autoSaver(
          {
            title: titleRef.current,
            dek: dekRef.current,
            content: md,
            gatePositionPct: 50,
            pricePence: pricePenceRef.current,
          },
          (saved) => {
            setCurrentDraftId(saved.draftId)
            setDraftStatus('Saved')
            setTimeout(() => setDraftStatus(null), 2000)
          },
          () => setDraftStatus('Save failed'),
        )
      }
    },
  }, [open])

  useEffect(() => {
    if (!open) return
    setMode(replyTarget ? 'note' : initialMode)
    setChips([])
    setToQuery('')
    setResolverResult(null)
    setResolving(false)
    setBody('')
    setError(null)
    setPublishing(false)
    setTitle('')
    setDek('')
    setPricePence(0)
    setSelectedPublicationId(null)
    setDraftStatus(null)
    setCurrentDraftId(null)
    setNudgeDismissed(false)
    setShowNudge(false)
    const t = setTimeout(() => {
      if (initialMode === 'article') {
        // Title field gets focus first in article mode.
      } else {
        bodyRef.current?.focus()
      }
    }, 0)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !publishing) onClose()
    }
    document.addEventListener('keydown', onKey)

    // Fetch linked accounts so the protocol toggles know which non-native
    // protocols can actually receive a cross-post. Failure is non-fatal —
    // toggles fall back to disconnected state and the publish remains a
    // pure Nostr broadcast.
    let cancelled = false
    linkedAccountsApi
      .list()
      .then(({ accounts }) => {
        if (cancelled) return
        const map: Partial<Record<Protocol, LinkedAccount>> = {}
        for (const acc of accounts) {
          if (!acc.isValid) continue
          const p = PROTOCOL_FROM_LINKED[acc.protocol]
          if (p && !map[p]) map[p] = acc
        }
        setLinkedByProtocol(map)
      })
      .catch(() => {
        if (!cancelled) setLinkedByProtocol({})
      })

    // Pre-fetch publication memberships so the PUBLISH AS selector renders
    // immediately when the user escalates to article mode. Non-fatal.
    publicationsApi
      .myMemberships()
      .then(({ publications: list }) => {
        if (cancelled) return
        setPublications(
          list.map((p) => ({
            id: p.id,
            slug: p.slug,
            name: p.name,
            canPublish: p.can_publish,
          })),
        )
      })
      .catch(() => {
        if (!cancelled) setPublications([])
      })

    return () => {
      cancelled = true
      clearTimeout(t)
      document.removeEventListener('keydown', onKey)
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [open, initialMode, onClose, publishing])

  // Note→article elevation. One-way per slice 10 — once switched, the
  // textarea content lands as the editor's initial value and the editor
  // takes over as source of truth. A heading-prefixed first line is
  // promoted to the title (Wireframe Step 6 "Pre-populated if note content
  // began with a heading").
  const switchToArticle = useCallback(() => {
    if (mode === 'article') return
    const trimmed = body.trimStart()
    let initialTitle = ''
    let initialBody = body
    const headingMatch = trimmed.match(/^#{1,3}\s+(.+?)\s*\n([\s\S]*)$/)
    if (headingMatch) {
      initialTitle = headingMatch[1].trim()
      initialBody = headingMatch[2].trimStart()
    }
    setTitle(initialTitle)
    setMode('article')
    setShowNudge(false)
    // TipTap content takes the body text. setContent fires onUpdate which
    // would auto-save with an empty title — guard inside onUpdate covers
    // that case.
    if (editor) {
      editor.commands.setContent(initialBody, false)
    }
  }, [mode, body, editor])

  // 400-word nudge in note mode. Per spec, one-shot per session — once
  // dismissed it doesn't re-show until the Composer reopens.
  useEffect(() => {
    if (mode !== 'note' || nudgeDismissed) {
      setShowNudge(false)
      return
    }
    const wordCount = body.trim() === '' ? 0 : body.trim().split(/\s+/).length
    if (wordCount >= NUDGE_WORDS_THRESHOLD) setShowNudge(true)
  }, [mode, body, nudgeDismissed])

  const pollForResults = useCallback(async (requestId: string) => {
    pollCountRef.current++
    if (pollCountRef.current > 3) {
      setResolving(false)
      return
    }
    await new Promise((r) => setTimeout(r, 1000))
    try {
      const res = await resolver.poll(requestId)
      setResolverResult(res)
      if (res.status === 'pending') {
        pollForResults(requestId)
      } else {
        setResolving(false)
      }
    } catch {
      setResolving(false)
    }
  }, [])

  function onToQueryChange(value: string) {
    setToQuery(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!value.trim()) {
      setResolverResult(null)
      setResolving(false)
      return
    }
    debounceRef.current = setTimeout(async () => {
      setResolving(true)
      pollCountRef.current = 0
      try {
        const res = await resolver.resolve(value.trim(), 'dm')
        setResolverResult(res)
        if (res.requestId && res.status === 'pending') {
          pollForResults(res.requestId)
        } else {
          setResolving(false)
        }
      } catch {
        setResolving(false)
      }
    }, 300)
  }

  function addPersonChip(match: ResolverMatch) {
    if (match.type !== 'native_account' || !match.account) return
    const id = `person:${match.account.id}`
    if (chips.some((c) => c.id === id)) return
    setChips((prev) => [
      ...prev,
      {
        kind: 'person',
        id,
        label: match.account!.displayName || `@${match.account!.username}`,
        match,
      },
    ])
    setToQuery('')
    setResolverResult(null)
    toInputRef.current?.focus()
  }

  function addBroadcastChip(token: (typeof BROADCAST_TOKENS)[number]) {
    if (chips.some((c) => c.id === token.id)) return
    setChips((prev) => [
      ...prev,
      { kind: 'broadcast', id: token.id, label: token.label, protocol: token.protocol },
    ])
    setToQuery('')
    setResolverResult(null)
    toInputRef.current?.focus()
  }

  function removeChip(id: string) {
    setChips((prev) => prev.filter((c) => c.id !== id))
    toInputRef.current?.focus()
  }

  function onToKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && toQuery === '' && chips.length > 0) {
      e.preventDefault()
      setChips((prev) => prev.slice(0, -1))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const top = resolverResult?.matches.find(
        (m) => m.type === 'native_account' && m.account,
      )
      if (top) addPersonChip(top)
    }
  }

  function toggleProtocol(p: Protocol) {
    setEnabledProtocols((prev) => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })
  }

  if (!open) return null

  const charCount = body.length
  const overLimit = mode === 'note' && charCount > NOTE_CHAR_LIMIT
  const hasPersonChip = chips.some((c) => c.kind === 'person')
  const hasBroadcastChip = chips.some((c) => c.kind === 'broadcast')
  const isMixed = hasPersonChip && hasBroadcastChip
  const isPrivate = hasPersonChip && !hasBroadcastChip
  const broadcastNostrSelected =
    chips.length === 0
      ? enabledProtocols.has('nostr')
      : hasBroadcastChip
        ? chips.some((c) => c.kind === 'broadcast' && c.protocol === 'nostr')
        : enabledProtocols.has('nostr')

  // Resolve the broadcast protocol set: chip-driven if broadcast chips are
  // present, otherwise the toggle selector. Non-native protocols only fire
  // a cross-post when a valid linked account exists for that protocol.
  const broadcastProtocols: Set<Protocol> = hasBroadcastChip
    ? new Set(chips.filter((c) => c.kind === 'broadcast' && c.protocol).map((c) => c.protocol!))
    : enabledProtocols
  const crossPostTargets: { protocol: Protocol; account: LinkedAccount }[] = []
  for (const p of (['atproto', 'activitypub'] as const)) {
    if (!broadcastProtocols.has(p)) continue
    const acc = linkedByProtocol[p]
    if (acc) crossPostTargets.push({ protocol: p, account: acc })
  }

  // Article-mode derived state.
  const wordCount = editor ? editor.storage.characterCount.words() : 0
  const readMinutes = Math.max(1, Math.round(wordCount / 200))
  const gateInserted = (() => {
    if (!editor) return false
    let found = false
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'paywallGate') {
        found = true
        return false
      }
    })
    return found
  })()
  const selectedPub = publications.find((p) => p.id === selectedPublicationId)
  const isSubmitForReview = !!selectedPub && !selectedPub.canPublish

  const isReply = !!replyTarget && mode === 'note'

  const canPublishNote =
    !!user &&
    !!body.trim() &&
    !overLimit &&
    !publishing &&
    (isReply || (!isMixed && (isPrivate || broadcastNostrSelected)))

  const canPublishArticle =
    !!user && !publishing && !!title.trim() && wordCount >= 10 && !hasPersonChip

  const canPublish = mode === 'note' ? canPublishNote : canPublishArticle

  async function handlePublishNote() {
    if (!canPublishNote || !user) return
    setPublishing(true)
    setError(null)
    try {
      if (isReply && replyTarget) {
        await publishReply({
          content: body,
          targetEventId: replyTarget.eventId,
          targetKind: replyTarget.eventKind,
          targetAuthorPubkey: replyTarget.authorPubkey,
        })
        onPublished?.()
        onClose()
        return
      }
      if (isPrivate) {
        const memberIds = chips
          .filter((c) => c.kind === 'person' && c.match?.account?.id)
          .map((c) => c.match!.account!.id)
        const conv = await messagesApi.createConversation(memberIds)
        const sendResult = await messagesApi.send(conv.conversationId, body)
        if (sendResult.skippedRecipientIds.length > 0) {
          setError(
            `Sent, but ${sendResult.skippedRecipientIds.length} recipient(s) were skipped — DM pricing not paid.`,
          )
          setPublishing(false)
          return
        }
      } else {
        const cross: CrossPostTarget[] = crossPostTargets.map(({ account }) => ({
          linkedAccountId: account.id,
          actionType: 'original',
        }))
        await publishNote(body, user.pubkey, undefined, cross.length > 0 ? cross : undefined)
      }
      onPublished?.()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to publish.')
      setPublishing(false)
    }
  }

  async function handlePublishArticle() {
    if (!canPublishArticle || !user || !editor) return
    setPublishing(true)
    setError(null)
    try {
      const fullContent = editor.storage.markdown.getMarkdown()
      const isPaywalled = gateInserted
      let freeContent = fullContent
      let paywallContent = ''
      let gatePositionPct = 0
      if (isPaywalled) {
        const markerIndex = fullContent.indexOf(PAYWALL_GATE_MARKER)
        if (markerIndex >= 0) {
          freeContent = fullContent.slice(0, markerIndex).trim()
          paywallContent = fullContent.slice(markerIndex + PAYWALL_GATE_MARKER.length).trim()
          const totalLen = freeContent.length + paywallContent.length
          gatePositionPct =
            totalLen > 0
              ? Math.min(99, Math.max(1, Math.round((freeContent.length / totalLen) * 100)))
              : 50
        }
      }
      const data = {
        title: title.trim(),
        dek: dek.trim(),
        content: fullContent.replace(PAYWALL_GATE_MARKER, '').trim(),
        freeContent,
        paywallContent,
        isPaywalled,
        pricePence: isPaywalled ? pricePence : 0,
        gatePositionPct,
        commentsEnabled: true,
        publicationId: selectedPublicationId,
        showOnWriterProfile: true,
        sendEmail: true,
        tags: [] as string[],
      }
      if (selectedPublicationId) {
        await publishToPublication(selectedPublicationId, data)
      } else {
        await publishArticle(data, user.pubkey)
      }
      onPublished?.()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to publish.')
      setPublishing(false)
    }
  }

  async function handlePublish() {
    if (mode === 'note') return handlePublishNote()
    return handlePublishArticle()
  }

  function onScrimClick(e: React.MouseEvent) {
    if (e.target === scrimRef.current && !publishing) onClose()
  }

  const personMatches = (resolverResult?.matches ?? []).filter(
    (m) => m.type === 'native_account' && m.account,
  )
  const filteredBroadcasts = toQuery.trim()
    ? BROADCAST_TOKENS.filter((t) =>
        t.label.toLowerCase().includes(toQuery.trim().toLowerCase()),
      )
    : []
  const showResolverDropdown =
    !!toQuery.trim() && (personMatches.length > 0 || filteredBroadcasts.length > 0 || resolving)

  return (
    <div
      ref={scrimRef}
      onMouseDown={onScrimClick}
      role="dialog"
      aria-modal="true"
      aria-label={isReply ? 'Reply' : mode === 'article' ? 'Write an article' : 'New note'}
      style={{
        position: 'fixed',
        inset: 0,
        background: TOKENS.scrim,
        zIndex: 60,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 96,
      }}
    >
      <div
        style={{
          width: 640,
          maxWidth: 'calc(100vw - 48px)',
          background: TOKENS.panelBg,
          border: `1px solid ${TOKENS.panelBorder}`,
          padding: 24,
          boxShadow: '0 24px 48px rgba(0, 0, 0, 0.18)',
        }}
      >
        {isReply && replyTarget && (
          <div
            style={{
              background: TOKENS.bannerBg,
              padding: '10px 12px',
              marginBottom: 16,
            }}
          >
            <div
              className="font-mono text-[11px] uppercase tracking-[0.06em]"
              style={{ color: TOKENS.hintFg }}
            >
              Replying to {replyTarget.authorName}
            </div>
            {replyTarget.excerpt && (
              <p
                className="font-serif italic text-[13px] mt-1"
                style={{ color: TOKENS.bannerFg, lineHeight: 1.45 }}
              >
                {replyTarget.excerpt}
              </p>
            )}
          </div>
        )}

        {!isReply && !hasPersonChip && (
          <div
            className="font-mono text-[11px] uppercase tracking-[0.06em]"
            style={{
              background: TOKENS.bannerBg,
              color: TOKENS.bannerFg,
              padding: '8px 12px',
              marginBottom: 16,
            }}
          >
            Publishing publicly
          </div>
        )}

        {!isReply && (
        <label
          className="label-ui block"
          htmlFor="composer-to"
          style={{ color: TOKENS.hintFg, marginBottom: 6 }}
        >
          To
        </label>
        )}

        {!isReply && (
        <div
          style={{
            border: `1px solid ${TOKENS.inputBorder}`,
            padding: '6px 8px',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 6,
            position: 'relative',
            marginBottom: 16,
          }}
          onClick={() => toInputRef.current?.focus()}
        >
          {chips.map((chip) => (
            <span
              key={chip.id}
              className="font-mono text-[11px] uppercase tracking-[0.06em]"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 8px',
                background: chip.kind === 'broadcast' ? TOKENS.chipBroadcastBg : TOKENS.chipBg,
                color: chip.kind === 'broadcast' ? TOKENS.chipBroadcastFg : TOKENS.chipFg,
              }}
            >
              {chip.label}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  removeChip(chip.id)
                }}
                aria-label={`Remove ${chip.label}`}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'inherit',
                  cursor: 'pointer',
                  padding: 0,
                  fontSize: 14,
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </span>
          ))}
          <input
            id="composer-to"
            ref={toInputRef}
            type="text"
            value={toQuery}
            onChange={(e) => onToQueryChange(e.target.value)}
            onKeyDown={onToKey}
            placeholder={chips.length === 0 ? '∀  (everyone, everywhere)' : ''}
            className="font-sans text-[14px]"
            style={{
              flex: 1,
              minWidth: 160,
              border: 'none',
              outline: 'none',
              padding: '4px 4px',
              background: 'transparent',
            }}
          />
          {resolving && (
            <span
              aria-hidden
              style={{
                width: 12,
                height: 12,
                border: '2px solid #BBBBBB',
                borderTopColor: '#1A1A18',
                borderRadius: '50%',
                animation: 'spin 0.8s linear infinite',
              }}
            />
          )}

          {showResolverDropdown && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                right: 0,
                marginTop: 4,
                background: TOKENS.panelBg,
                border: `1px solid ${TOKENS.panelBorder}`,
                boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12)',
                zIndex: 1,
                maxHeight: 240,
                overflowY: 'auto',
              }}
              onMouseDown={(e) => e.preventDefault()}
            >
              {personMatches.map((m, i) => (
                <button
                  key={`person-${i}`}
                  type="button"
                  onClick={() => addPersonChip(m)}
                  className="font-sans text-[14px] block w-full text-left"
                  style={{
                    padding: '8px 12px',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={(e) => {
                    ;(e.currentTarget as HTMLButtonElement).style.background = TOKENS.matchHoverBg
                  }}
                  onMouseLeave={(e) => {
                    ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
                  }}
                >
                  <span style={{ fontWeight: 500 }}>{m.account?.displayName}</span>
                  <span
                    className="font-mono text-[11px]"
                    style={{ color: TOKENS.hintFg, marginLeft: 8 }}
                  >
                    @{m.account?.username}
                  </span>
                </button>
              ))}
              {filteredBroadcasts.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => addBroadcastChip(t)}
                  className="font-sans text-[14px] block w-full text-left"
                  style={{
                    padding: '8px 12px',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={(e) => {
                    ;(e.currentTarget as HTMLButtonElement).style.background = TOKENS.matchHoverBg
                  }}
                  onMouseLeave={(e) => {
                    ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
                  }}
                >
                  {t.label}
                </button>
              ))}
              {!resolving && personMatches.length === 0 && filteredBroadcasts.length === 0 && (
                <div
                  className="font-mono text-[11px]"
                  style={{ color: TOKENS.hintFg, padding: '8px 12px' }}
                >
                  No matches.
                </div>
              )}
            </div>
          )}
        </div>
        )}

        {!isReply && mode === 'note' && chips.length === 0 && (
          <ProtocolSelector
            enabled={enabledProtocols}
            linked={linkedByProtocol}
            onToggle={toggleProtocol}
          />
        )}

        {mode === 'note' ? (
          <>
            <textarea
              ref={bodyRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="What are you thinking?"
              className="font-serif text-[16px] w-full"
              style={{
                border: `1px solid ${TOKENS.inputBorder}`,
                padding: '12px 14px',
                minHeight: 160,
                resize: 'vertical',
                outline: 'none',
                lineHeight: 1.55,
                marginTop: 16,
              }}
            />
            {showNudge && (
              <div
                style={{
                  marginTop: 8,
                  padding: '10px 12px',
                  background: TOKENS.bannerBg,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                <span className="font-sans text-[13px]" style={{ color: TOKENS.bannerFg }}>
                  This is getting long. Switch to article mode?
                </span>
                <span style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    onClick={switchToArticle}
                    className="font-mono text-[11px] uppercase tracking-[0.06em]"
                    style={{
                      padding: '6px 10px',
                      background: TOKENS.publishBg,
                      color: TOKENS.publishFg,
                      border: 'none',
                      cursor: 'pointer',
                    }}
                  >
                    Switch
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowNudge(false)
                      setNudgeDismissed(true)
                    }}
                    className="font-mono text-[11px] uppercase tracking-[0.06em]"
                    style={{
                      padding: '6px 10px',
                      background: 'transparent',
                      color: TOKENS.hintFg,
                      border: 'none',
                      cursor: 'pointer',
                    }}
                  >
                    Dismiss
                  </button>
                </span>
              </div>
            )}
            {!isReply && (
              <div style={{ marginTop: 8, textAlign: 'right' }}>
                <button
                  type="button"
                  onClick={switchToArticle}
                  className="font-sans text-[13px]"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: TOKENS.hintFg,
                    cursor: 'pointer',
                    padding: 0,
                  }}
                >
                  Write an article →
                </button>
              </div>
            )}
          </>
        ) : (
          <ArticleModePanel
            title={title}
            setTitle={setTitle}
            dek={dek}
            setDek={setDek}
            editor={editor}
            publications={publications}
            selectedPublicationId={selectedPublicationId}
            setSelectedPublicationId={setSelectedPublicationId}
            pricePence={pricePence}
            setPricePence={setPricePence}
            gateInserted={gateInserted}
            uploading={uploading}
            setError={setError}
            wordCount={wordCount}
            readMinutes={readMinutes}
          />
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: 12,
            gap: 16,
          }}
        >
          <div className="font-mono text-[11px]" style={{ color: TOKENS.hintFg }}>
            {error ? (
              <span style={{ color: TOKENS.errorFg }}>{error}</span>
            ) : isReply ? (
              <span style={{ color: overLimit ? TOKENS.errorFg : TOKENS.hintFg }}>
                {charCount}/{NOTE_CHAR_LIMIT}
              </span>
            ) : mode === 'article' ? (
              hasPersonChip ? (
                <span style={{ color: TOKENS.errorFg }}>
                  Articles can&rsquo;t be sent privately — remove person chips to publish.
                </span>
              ) : (
                <span style={{ color: TOKENS.hintFg }}>
                  {wordCount} {wordCount === 1 ? 'word' : 'words'} · {readMinutes} min read
                  {draftStatus ? ` · ${draftStatus}` : ''}
                </span>
              )
            ) : isMixed ? (
              <span style={{ color: TOKENS.errorFg }}>
                Mixing people with broadcast targets isn&rsquo;t supported in one send.
              </span>
            ) : isPrivate ? (
              <span style={{ color: TOKENS.hintFg }}>
                Sending privately to{' '}
                {chips.filter((c) => c.kind === 'person').length} recipient
                {chips.filter((c) => c.kind === 'person').length === 1 ? '' : 's'} — appears in
                their inbox at all.haus/messages.
              </span>
            ) : !broadcastNostrSelected ? (
              <span style={{ color: TOKENS.errorFg }}>
                Cross-protocol broadcast needs Nostr as the anchor. Include Nostr to publish.
              </span>
            ) : crossPostTargets.length > 0 ? (
              <span style={{ color: overLimit ? TOKENS.errorFg : TOKENS.hintFg }}>
                Publishing to Nostr ·{' '}
                {crossPostTargets.map((t) => PROTOCOL_LABELS[t.protocol]).join(' · ')} —{' '}
                {charCount}/{NOTE_CHAR_LIMIT}
              </span>
            ) : (
              <span style={{ color: overLimit ? TOKENS.errorFg : TOKENS.hintFg }}>
                {charCount}/{NOTE_CHAR_LIMIT}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={onClose}
              disabled={publishing}
              className="font-sans text-[13px]"
              style={{
                padding: '8px 14px',
                background: 'transparent',
                color: TOKENS.bannerFg,
                border: 'none',
                cursor: publishing ? 'default' : 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handlePublish}
              disabled={!canPublish}
              className="font-sans text-[13px]"
              style={{
                padding: '8px 16px',
                background: canPublish
                  ? mode === 'article'
                    ? TOKENS.publishArticleBg
                    : TOKENS.publishBg
                  : TOKENS.publishDisabled,
                color: TOKENS.publishFg,
                border: 'none',
                cursor: canPublish ? 'pointer' : 'default',
              }}
            >
              {publishing
                ? isReply
                  ? 'Replying…'
                  : isPrivate
                    ? 'Sending…'
                    : 'Publishing…'
                : isReply
                  ? 'Reply'
                  : mode === 'article'
                  ? isSubmitForReview
                    ? 'Submit for review'
                    : 'Publish'
                  : isPrivate
                    ? 'Send'
                    : 'Publish'}
            </button>
          </div>
        </div>
      </div>
      <style jsx>{`
        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>
    </div>
  )
}

function ProtocolSelector({
  enabled,
  linked,
  onToggle,
}: {
  enabled: Set<Protocol>
  linked: Partial<Record<Protocol, LinkedAccount>>
  onToggle: (p: Protocol) => void
}) {
  const order: Protocol[] = ['allhaus', 'nostr', 'atproto', 'activitypub']
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <span
        className="label-ui"
        style={{ color: TOKENS.hintFg, marginRight: 4 }}
      >
        Send via
      </span>
      {order.map((p) => {
        const isNative = NATIVE_PROTOCOLS.has(p)
        const isConnected = isNative || !!linked[p]
        const isOn = enabled.has(p) && isConnected
        const handleClick = () => {
          if (!isConnected) return
          onToggle(p)
        }
        return (
          <button
            key={p}
            type="button"
            onClick={handleClick}
            disabled={!isConnected}
            className="font-mono text-[11px] uppercase tracking-[0.06em]"
            title={
              isConnected
                ? undefined
                : `Connect ${PROTOCOL_LABELS[p]} in Settings → Linked accounts to broadcast there.`
            }
            style={{
              padding: '4px 10px',
              background: isOn ? TOKENS.toggleOnBg : TOKENS.toggleOffBg,
              color: isOn
                ? TOKENS.toggleOnFg
                : isConnected
                  ? TOKENS.toggleOffFg
                  : TOKENS.toggleDisabledFg,
              border: `1px solid ${isOn ? TOKENS.toggleOnBg : TOKENS.inputBorder}`,
              cursor: isConnected ? 'pointer' : 'not-allowed',
            }}
          >
            {PROTOCOL_LABELS[p]}
          </button>
        )
      })}
    </div>
  )
}

interface ArticleModePanelProps {
  title: string
  setTitle: (v: string) => void
  dek: string
  setDek: (v: string) => void
  editor: ReturnType<typeof useEditor>
  publications: PublicationOption[]
  selectedPublicationId: string | null
  setSelectedPublicationId: (v: string | null) => void
  pricePence: number
  setPricePence: (v: number) => void
  gateInserted: boolean
  uploading: boolean
  setError: (v: string | null) => void
  wordCount: number
  readMinutes: number
}

function ArticleModePanel({
  title,
  setTitle,
  dek,
  setDek,
  editor,
  publications,
  selectedPublicationId,
  setSelectedPublicationId,
  pricePence,
  setPricePence,
  gateInserted,
  uploading,
  setError,
  wordCount,
  readMinutes,
}: ArticleModePanelProps) {
  return (
    <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Article title"
        autoFocus
        className="font-serif italic"
        style={{
          fontSize: 22,
          fontWeight: 500,
          letterSpacing: '-0.01em',
          padding: '10px 12px',
          background: TOKENS.fieldBg,
          border: 'none',
          outline: 'none',
        }}
      />
      <input
        type="text"
        value={dek}
        onChange={(e) => setDek(e.target.value)}
        placeholder="Standfirst (optional)"
        className="font-serif italic"
        style={{
          fontSize: 15,
          padding: '8px 12px',
          background: TOKENS.fieldBg,
          color: '#5F5E5A',
          border: 'none',
          outline: 'none',
        }}
      />

      {publications.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
          <span className="label-ui" style={{ color: TOKENS.hintFg }}>
            Publish as
          </span>
          <select
            value={selectedPublicationId ?? ''}
            onChange={(e) => setSelectedPublicationId(e.target.value || null)}
            className="font-sans text-[13px]"
            style={{
              background: TOKENS.fieldBg,
              border: 'none',
              padding: '6px 8px',
              outline: 'none',
            }}
          >
            <option value="">PERSONAL</option>
            {publications.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {!p.canPublish ? ' (review)' : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      <ArticleToolbar
        editor={editor}
        gateInserted={gateInserted}
        uploading={uploading}
        onError={setError}
      />

      <div
        style={{
          background: TOKENS.fieldBg,
          padding: 16,
          minHeight: 320,
          maxHeight: 'calc(100vh - 480px)',
          overflowY: 'auto',
        }}
      >
        <EditorContent editor={editor} />
      </div>

      {gateInserted && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
          <span className="label-ui" style={{ color: TOKENS.paywallFg }}>
            Price
          </span>
          <span className="font-sans text-[13px]" style={{ color: TOKENS.hintFg }}>
            £
          </span>
          <input
            type="number"
            min={0}
            step={0.01}
            value={(pricePence / 100).toFixed(2)}
            onChange={(e) => {
              const n = parseFloat(e.target.value)
              setPricePence(Number.isFinite(n) ? Math.round(n * 100) : 0)
            }}
            className="font-sans text-[13px]"
            style={{
              width: 80,
              padding: '4px 8px',
              background: TOKENS.fieldBg,
              border: 'none',
              outline: 'none',
            }}
          />
          <span className="font-mono text-[11px]" style={{ color: TOKENS.hintFg }}>
            {wordCount} {wordCount === 1 ? 'word' : 'words'} · {readMinutes} min read
          </span>
        </div>
      )}
    </div>
  )
}

function ArticleToolbar({
  editor,
  gateInserted,
  uploading,
  onError,
}: {
  editor: ReturnType<typeof useEditor>
  gateInserted: boolean
  uploading: boolean
  onError: (v: string | null) => void
}) {
  if (!editor) return null

  const btn = (label: React.ReactNode, active: boolean, accent: boolean, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      className="font-sans text-[13px]"
      style={{
        padding: '4px 8px',
        background: active ? TOKENS.bannerBg : 'transparent',
        color: accent ? TOKENS.paywallFg : active ? TOKENS.toolbarActive : TOKENS.toolbarFg,
        border: accent ? `1px solid ${active ? TOKENS.paywallFg : 'transparent'}` : 'none',
        cursor: 'pointer',
        fontWeight: 500,
      }}
    >
      {label}
    </button>
  )

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '4px 0',
        borderBottom: `1px solid ${TOKENS.inputBorder}`,
        marginTop: 4,
      }}
    >
      {btn('B', editor.isActive('bold'), false, () => editor.chain().focus().toggleBold().run())}
      {btn(
        <span style={{ fontStyle: 'italic' }}>I</span>,
        editor.isActive('italic'),
        false,
        () => editor.chain().focus().toggleItalic().run(),
      )}
      {btn('H2', editor.isActive('heading', { level: 2 }), false, () =>
        editor.chain().focus().toggleHeading({ level: 2 }).run(),
      )}
      {btn('H3', editor.isActive('heading', { level: 3 }), false, () =>
        editor.chain().focus().toggleHeading({ level: 3 }).run(),
      )}
      {btn('“', editor.isActive('blockquote'), false, () =>
        editor.chain().focus().toggleBlockquote().run(),
      )}
      {btn(uploading ? '…' : 'IMG', false, false, () => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = 'image/jpeg,image/png,image/gif,image/webp'
        input.onchange = async (e) => {
          const file = (e.target as HTMLInputElement).files?.[0]
          if (!file) return
          try {
            const result = await uploadImage(file)
            editor.chain().focus().setImage({ src: result.url }).run()
          } catch (err) {
            onError(err instanceof Error ? err.message : 'Image upload failed')
          }
        }
        input.click()
      })}
      <span style={{ color: '#BBBBBB', padding: '0 4px' }}>|</span>
      {btn(gateInserted ? 'PAYWALL ✓' : 'PAYWALL', gateInserted, true, () => {
        if (gateInserted) editor.commands.removePaywallGate()
        else editor.commands.insertPaywallGate()
      })}
    </div>
  )
}

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../../stores/auth'
import { publishNote, type CrossPostTarget } from '../../lib/publishNote'
import {
  resolver,
  messages as messagesApi,
  linkedAccounts as linkedAccountsApi,
  type LinkedAccount,
  type ResolverMatch,
  type ResolverResult,
} from '../../lib/api'

const NOTE_CHAR_LIMIT = 1000

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
  inputBorder: '#E6E5E0',
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

interface ComposerProps {
  open: boolean
  onClose: () => void
  onPublished?: () => void
}

export function Composer({ open, onClose, onPublished }: ComposerProps) {
  const { user } = useAuth()
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

  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const toInputRef = useRef<HTMLInputElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollCountRef = useRef(0)

  useEffect(() => {
    if (!open) return
    setChips([])
    setToQuery('')
    setResolverResult(null)
    setResolving(false)
    setBody('')
    setError(null)
    setPublishing(false)
    const t = setTimeout(() => bodyRef.current?.focus(), 0)
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

    return () => {
      cancelled = true
      clearTimeout(t)
      document.removeEventListener('keydown', onKey)
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [open, onClose, publishing])

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
  const overLimit = charCount > NOTE_CHAR_LIMIT
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

  const canPublish =
    !!user &&
    !!body.trim() &&
    !overLimit &&
    !publishing &&
    !isMixed &&
    (isPrivate || broadcastNostrSelected)

  async function handlePublish() {
    if (!canPublish || !user) return
    setPublishing(true)
    setError(null)
    try {
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
      aria-label="New note"
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
        {!hasPersonChip && (
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

        <label
          className="label-ui block"
          htmlFor="composer-to"
          style={{ color: TOKENS.hintFg, marginBottom: 6 }}
        >
          To
        </label>

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

        {chips.length === 0 && (
          <ProtocolSelector
            enabled={enabledProtocols}
            linked={linkedByProtocol}
            onToggle={toggleProtocol}
          />
        )}

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
                background: canPublish ? TOKENS.publishBg : TOKENS.publishDisabled,
                color: TOKENS.publishFg,
                border: 'none',
                cursor: canPublish ? 'pointer' : 'default',
              }}
            >
              {publishing ? (isPrivate ? 'Sending…' : 'Publishing…') : isPrivate ? 'Send' : 'Publish'}
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

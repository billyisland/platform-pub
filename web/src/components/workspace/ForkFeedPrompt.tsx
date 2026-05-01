'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  resolver,
  workspaceFeeds as workspaceFeedsApi,
  type AddWorkspaceFeedSourceInput,
  type ResolverMatch,
  type ResolverResult,
  type WorkspaceFeed,
} from '../../lib/api'

// ForkFeedPrompt — slice 8. Wires the ∀ menu's "Fork feed by URL" item.
// One gesture = (create feed) + (add first source) + (open vessel). Same
// resolver-debounced input grammar as FeedComposer's "Add a source", but
// instead of attaching to an existing feed we mint a new one with a name
// derived from the resolved match.

const TOKENS = {
  scrim: 'rgba(26, 26, 24, 0.4)',
  panelBg: '#FFFFFF',
  panelBorder: '#1A1A18',
  hintFg: '#8A8880',
  errorFg: '#B5242A',
  inputBorder: '#E6E5E0',
  matchHoverBg: '#F0EFEB',
}

const NAME_LIMIT = 80

interface ForkFeedPromptProps {
  open: boolean
  onClose: () => void
  onForked: (feed: WorkspaceFeed) => void
}

interface MatchOption {
  key: string
  label: string
  sublabel: string | null
  add: AddWorkspaceFeedSourceInput
  derivedName: string
}

function clampName(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length <= NAME_LIMIT) return trimmed
  return trimmed.slice(0, NAME_LIMIT).trimEnd()
}

function matchToOptions(match: ResolverMatch): MatchOption[] {
  const out: MatchOption[] = []
  if (match.type === 'native_account' && match.account) {
    const label = match.account.displayName || `@${match.account.username}`
    out.push({
      key: `acc:${match.account.id}`,
      label,
      sublabel: match.account.username ? `@${match.account.username}` : null,
      add: { sourceType: 'account', accountId: match.account.id },
      derivedName: clampName(label),
    })
  }
  if (match.type === 'external_source' && match.externalSource) {
    const x = match.externalSource
    const label = x.displayName || x.sourceUri
    out.push({
      key: `xs:${x.protocol}:${x.sourceUri}`,
      label,
      sublabel: x.protocol,
      add: {
        sourceType: 'external_source',
        protocol: x.protocol as 'rss' | 'atproto' | 'activitypub' | 'nostr_external',
        sourceUri: x.sourceUri,
        displayName: x.displayName,
        description: x.description,
        avatarUrl: x.avatar,
        relayUrls: x.relayUrls,
      },
      derivedName: clampName(label),
    })
  }
  if (match.type === 'rss_feed' && match.rssFeed) {
    const label = match.rssFeed.title || match.rssFeed.feedUrl
    out.push({
      key: `rss:${match.rssFeed.feedUrl}`,
      label,
      sublabel: 'rss',
      add: {
        sourceType: 'external_source',
        protocol: 'rss',
        sourceUri: match.rssFeed.feedUrl,
        displayName: match.rssFeed.title,
        description: match.rssFeed.description,
      },
      derivedName: clampName(label),
    })
  }
  return out
}

export function ForkFeedPrompt({ open, onClose, onForked }: ForkFeedPromptProps) {
  const [query, setQuery] = useState('')
  const [resolverResult, setResolverResult] = useState<ResolverResult | null>(null)
  const [resolving, setResolving] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollCountRef = useRef(0)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setResolverResult(null)
    setResolving(false)
    setBusyKey(null)
    setError(null)
    const t = setTimeout(() => inputRef.current?.focus(), 0)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busyKey) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(t)
      document.removeEventListener('keydown', onKey)
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [open, onClose, busyKey])

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
      if (res.status === 'pending') void pollForResults(requestId)
      else setResolving(false)
    } catch {
      setResolving(false)
    }
  }, [])

  function onQueryChange(value: string) {
    setQuery(value)
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
        const res = await resolver.resolve(value.trim(), 'subscribe')
        setResolverResult(res)
        if (res.requestId && res.status === 'pending') void pollForResults(res.requestId)
        else setResolving(false)
      } catch {
        setResolving(false)
      }
    }, 300)
  }

  // Tag fallback — the resolver doesn't classify `#tag`, so we mint a tag
  // option directly when the input begins with `#`.
  function tagFallback(): MatchOption | null {
    const trimmed = query.trim()
    if (!trimmed.startsWith('#') || trimmed.length < 2) return null
    const tagName = trimmed.slice(1).trim().replace(/\s+/g, '-').toLowerCase()
    if (!tagName) return null
    return {
      key: `tag:${tagName}`,
      label: `#${tagName}`,
      sublabel: 'tag',
      add: { sourceType: 'tag', tagName },
      derivedName: clampName(`#${tagName}`),
    }
  }

  async function handleFork(opt: MatchOption) {
    if (busyKey) return
    setBusyKey(opt.key)
    setError(null)
    let createdFeed: WorkspaceFeed | null = null
    try {
      const created = await workspaceFeedsApi.create(opt.derivedName || 'Untitled feed')
      createdFeed = created.feed
      await workspaceFeedsApi.addSource(createdFeed.id, opt.add)
      onForked(createdFeed)
    } catch (err) {
      // If the feed was created but the source failed, hand the partial back
      // so the user can finish wiring it via FeedComposer rather than losing
      // the new vessel.
      if (createdFeed) {
        onForked(createdFeed)
        setError(
          err instanceof Error
            ? `Feed created but source add failed: ${err.message}`
            : 'Feed created but source add failed.',
        )
      } else {
        setError(err instanceof Error ? err.message : 'Failed to fork feed.')
      }
      setBusyKey(null)
    }
  }

  function onScrimClick(e: React.MouseEvent) {
    if (e.target === scrimRef.current && !busyKey) onClose()
  }

  if (!open) return null

  const matches = (resolverResult?.matches ?? []).flatMap(matchToOptions)
  const fallbackTag = tagFallback()
  const showTagFallback = fallbackTag && !matches.some((m) => m.key === fallbackTag.key)
  const dropdownItems = fallbackTag && showTagFallback ? [...matches, fallbackTag] : matches

  return (
    <div
      ref={scrimRef}
      onMouseDown={onScrimClick}
      role="dialog"
      aria-modal="true"
      aria-label="Fork feed by URL"
      style={{
        position: 'fixed',
        inset: 0,
        background: TOKENS.scrim,
        zIndex: 60,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 144,
      }}
    >
      <div
        style={{
          width: 480,
          maxWidth: 'calc(100vw - 48px)',
          background: TOKENS.panelBg,
          border: `1px solid ${TOKENS.panelBorder}`,
          padding: 24,
          boxShadow: '0 24px 48px rgba(0, 0, 0, 0.18)',
        }}
      >
        <div className="label-ui" style={{ color: TOKENS.hintFg, marginBottom: 6 }}>
          Fork feed by URL
        </div>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Paste a URL, @username, npub, DID, or #tag"
          className="font-sans text-[14px] w-full"
          style={{
            border: `1px solid ${TOKENS.inputBorder}`,
            padding: '10px 12px',
            outline: 'none',
            marginBottom: 8,
          }}
        />
        <div className="font-mono text-[11px]" style={{ color: TOKENS.hintFg, marginBottom: 12 }}>
          Picks something below to mint a new feed pointed at it. Rename later from the feed composer.
        </div>

        <div style={{ minHeight: 24 }}>
          {resolving && (
            <div className="font-mono text-[11px]" style={{ color: TOKENS.hintFg }}>
              RESOLVING…
            </div>
          )}
          {!resolving && query && dropdownItems.length === 0 && (
            <div className="font-mono text-[11px]" style={{ color: TOKENS.hintFg }}>
              No match. Try a full URL, an @username, an npub, or a #tag.
            </div>
          )}
          {dropdownItems.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {dropdownItems.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => void handleFork(opt)}
                  disabled={busyKey === opt.key}
                  className="font-sans text-[13px]"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 10px',
                    background: 'transparent',
                    border: 'none',
                    borderTop: `1px solid ${TOKENS.inputBorder}`,
                    color: TOKENS.panelBorder,
                    cursor: busyKey === opt.key ? 'default' : 'pointer',
                    textAlign: 'left',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = TOKENS.matchHoverBg)}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {busyKey === opt.key ? `Forking ${opt.label}…` : opt.label}
                  </span>
                  {opt.sublabel && (
                    <span className="font-mono text-[11px] uppercase tracking-[0.06em]" style={{ color: TOKENS.hintFg, marginLeft: 12 }}>
                      {opt.sublabel}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {error && (
          <div className="font-mono text-[11px]" style={{ color: TOKENS.errorFg, marginTop: 12 }}>
            {error}
          </div>
        )}
      </div>
    </div>
  )
}

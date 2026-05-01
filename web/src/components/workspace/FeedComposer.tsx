'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  resolver,
  workspaceFeeds as workspaceFeedsApi,
  type AddWorkspaceFeedSourceInput,
  type ResolverMatch,
  type ResolverResult,
  type WorkspaceFeed,
  type WorkspaceFeedSource,
} from '../../lib/api'

// FeedComposer — slice 4. Reached from the vessel name label. Lists the
// feed's current sources and accepts a free-form input that the universal
// resolver classifies into a native account / external source / RSS feed
// candidate. Clicking a candidate POSTs the corresponding feed_sources row.
//
// Out of scope for slice 4: per-source weights (column reserved), source
// reordering, mute toggle (column reserved, no UI), feed rename / delete
// (routes exist; UI is its own slice), tag autocomplete from a tags index
// (free-form `#name` is enough until the index is exposed).

const TOKENS = {
  scrim: 'rgba(26, 26, 24, 0.4)',
  panelBg: '#FFFFFF',
  panelBorder: '#1A1A18',
  rowBg: '#F0EFEB',
  hintFg: '#8A8880',
  errorFg: '#B5242A',
  inputBorder: '#E6E5E0',
  closeBg: '#1A1A18',
  closeFg: '#F0EFEB',
  matchHoverBg: '#F0EFEB',
  removeFg: '#8A8880',
  removeHoverFg: '#B5242A',
}

interface FeedComposerProps {
  feed: WorkspaceFeed | null
  open: boolean
  onClose: () => void
  onSourcesChanged?: () => void
}

interface MatchOption {
  key: string
  label: string
  sublabel: string | null
  add: AddWorkspaceFeedSourceInput
  confidence: ResolverMatch['confidence']
}

function matchToOptions(match: ResolverMatch): MatchOption[] {
  const out: MatchOption[] = []
  if (match.type === 'native_account' && match.account) {
    out.push({
      key: `acc:${match.account.id}`,
      label: match.account.displayName || `@${match.account.username}`,
      sublabel: match.account.username ? `@${match.account.username}` : null,
      add: { sourceType: 'account', accountId: match.account.id },
      confidence: match.confidence,
    })
  }
  if (match.type === 'external_source' && match.externalSource) {
    const x = match.externalSource
    out.push({
      key: `xs:${x.protocol}:${x.sourceUri}`,
      label: x.displayName || x.sourceUri,
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
      confidence: match.confidence,
    })
  }
  if (match.type === 'rss_feed' && match.rssFeed) {
    out.push({
      key: `rss:${match.rssFeed.feedUrl}`,
      label: match.rssFeed.title || match.rssFeed.feedUrl,
      sublabel: 'rss',
      add: {
        sourceType: 'external_source',
        protocol: 'rss',
        sourceUri: match.rssFeed.feedUrl,
        displayName: match.rssFeed.title,
        description: match.rssFeed.description,
      },
      confidence: match.confidence,
    })
  }
  return out
}

export function FeedComposer({ feed, open, onClose, onSourcesChanged }: FeedComposerProps) {
  const [sources, setSources] = useState<WorkspaceFeedSource[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [resolverResult, setResolverResult] = useState<ResolverResult | null>(null)
  const [resolving, setResolving] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollCountRef = useRef(0)

  const refreshSources = useCallback(async (feedId: string) => {
    setLoading(true)
    try {
      const data = await workspaceFeedsApi.listSources(feedId)
      setSources(data.sources)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sources.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open || !feed) return
    setQuery('')
    setResolverResult(null)
    setResolving(false)
    setBusyKey(null)
    setError(null)
    void refreshSources(feed.id)
    const t = setTimeout(() => inputRef.current?.focus(), 0)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(t)
      document.removeEventListener('keydown', onKey)
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [open, feed, onClose, refreshSources])

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

  async function handleAdd(opt: MatchOption) {
    if (!feed || busyKey) return
    setBusyKey(opt.key)
    setError(null)
    try {
      await workspaceFeedsApi.addSource(feed.id, opt.add)
      setQuery('')
      setResolverResult(null)
      await refreshSources(feed.id)
      onSourcesChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add source.')
    } finally {
      setBusyKey(null)
    }
  }

  // Tag fallback — when the input starts with `#` and the resolver returns
  // nothing useful, offer a literal tag add. Tags don't go through the
  // resolver at all so this is an out-of-band path.
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
      confidence: 'exact',
    }
  }

  async function handleRemove(sourceId: string) {
    if (!feed) return
    setBusyKey(`remove:${sourceId}`)
    setError(null)
    try {
      await workspaceFeedsApi.removeSource(feed.id, sourceId)
      await refreshSources(feed.id)
      onSourcesChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove source.')
    } finally {
      setBusyKey(null)
    }
  }

  function onScrimClick(e: React.MouseEvent) {
    if (e.target === scrimRef.current) onClose()
  }

  if (!open || !feed) return null

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
      aria-label={`Feed composer: ${feed.name}`}
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
          width: 520,
          maxWidth: 'calc(100vw - 48px)',
          background: TOKENS.panelBg,
          border: `1px solid ${TOKENS.panelBorder}`,
          padding: 24,
          boxShadow: '0 24px 48px rgba(0, 0, 0, 0.18)',
          maxHeight: 'calc(100vh - 144px)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <div className="label-ui" style={{ color: TOKENS.hintFg }}>Feed composer</div>
            <div className="font-sans text-[18px]" style={{ color: TOKENS.panelBorder, marginTop: 2 }}>
              {feed.name}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-[11px] uppercase tracking-[0.06em]"
            style={{
              padding: '6px 10px',
              background: 'transparent',
              color: TOKENS.hintFg,
              border: 'none',
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>

        <div className="label-ui" style={{ color: TOKENS.hintFg, marginBottom: 6 }}>
          Sources
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16, overflowY: 'auto' }}>
          {loading && (
            <div className="font-mono text-[11px]" style={{ color: TOKENS.hintFg }}>
              LOADING…
            </div>
          )}
          {!loading && sources.length === 0 && (
            <div className="font-mono text-[11px]" style={{ color: TOKENS.hintFg }}>
              No sources yet — this feed shows the explore stream until you add one.
            </div>
          )}
          {sources.map((s) => (
            <div
              key={s.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: TOKENS.rowBg,
                padding: '8px 10px',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <div className="font-sans text-[13px]" style={{ color: TOKENS.panelBorder, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {s.display.label}
                </div>
                {s.display.sublabel && (
                  <div className="font-mono text-[11px] uppercase tracking-[0.06em]" style={{ color: TOKENS.hintFg }}>
                    {s.display.sublabel}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => void handleRemove(s.id)}
                disabled={busyKey === `remove:${s.id}`}
                aria-label={`Remove ${s.display.label}`}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: TOKENS.removeFg,
                  cursor: 'pointer',
                  fontSize: 16,
                  padding: '4px 8px',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = TOKENS.removeHoverFg)}
                onMouseLeave={(e) => (e.currentTarget.style.color = TOKENS.removeFg)}
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <div className="label-ui" style={{ color: TOKENS.hintFg, marginBottom: 6 }}>
          Add a source
        </div>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Username, URL, npub, DID, #tag…"
          className="font-sans text-[14px] w-full"
          style={{
            border: `1px solid ${TOKENS.inputBorder}`,
            padding: '10px 12px',
            outline: 'none',
            marginBottom: 8,
          }}
        />
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
                  onClick={() => void handleAdd(opt)}
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
                    {opt.label}
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

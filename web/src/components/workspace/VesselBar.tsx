'use client'

import { useCallback, useRef, useState } from 'react'
import {
  resolver,
  workspaceFeeds as workspaceFeedsApi,
  type AddWorkspaceFeedSourceInput,
  type ResolverMatch,
  type ResolverResult,
} from '../../lib/api'
import type { VesselPalette, Brightness, Density, Orientation } from './tokens'
import { nextBrightness, nextDensity, nextOrientation } from './tokens'

const BAR_H = 32

interface VesselBarProps {
  feedId: string
  palette: VesselPalette
  brightness: Brightness
  density: Density
  orientation: Orientation
  savedView?: boolean
  onBrightnessCommit?: (b: Brightness) => void
  onDensityCommit?: (d: Density) => void
  onOrientationCommit?: (o: Orientation) => void
  onToggleSavedView?: () => void
  onSourceAdded?: () => void
  onNameClick?: () => void
}

interface MatchOption {
  key: string
  label: string
  sublabel: string | null
  add: AddWorkspaceFeedSourceInput
}

function matchToOptions(match: ResolverMatch): MatchOption[] {
  const out: MatchOption[] = []
  if (match.type === 'native_account' && match.account) {
    out.push({
      key: `acc:${match.account.id}`,
      label: match.account.displayName || `@${match.account.username}`,
      sublabel: match.account.username ? `@${match.account.username}` : null,
      add: { sourceType: 'account', accountId: match.account.id },
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
    })
  }
  return out
}

export { BAR_H }

export function VesselBar({
  feedId,
  palette,
  brightness,
  density,
  orientation,
  savedView,
  onBrightnessCommit,
  onDensityCommit,
  onOrientationCommit,
  onToggleSavedView,
  onSourceAdded,
  onNameClick,
}: VesselBarProps) {
  const [query, setQuery] = useState('')
  const [resolverResult, setResolverResult] = useState<ResolverResult | null>(null)
  const [resolving, setResolving] = useState(false)
  const [resolveError, setResolveError] = useState(false)
  const [adding, setAdding] = useState(false)
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollCountRef = useRef(0)
  const barRef = useRef<HTMLDivElement>(null)

  const pollForResults = useCallback(async (requestId: string) => {
    pollCountRef.current++
    if (pollCountRef.current > 8) {
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
      setResolveError(false)
      return
    }
    debounceRef.current = setTimeout(async () => {
      setResolving(true)
      setResolveError(false)
      pollCountRef.current = 0
      try {
        const res = await resolver.resolve(value.trim(), 'subscribe')
        setResolverResult(res)
        if (res.requestId && res.status === 'pending') void pollForResults(res.requestId)
        else setResolving(false)
      } catch {
        setResolveError(true)
        setResolving(false)
      }
    }, 300)
  }

  async function handleAdd(opt: MatchOption) {
    if (adding) return
    setAdding(true)
    try {
      await workspaceFeedsApi.addSource(feedId, opt.add)
      setQuery('')
      setResolverResult(null)
      onSourceAdded?.()
    } catch (err) {
      console.error('VesselBar add source error:', err)
    } finally {
      setAdding(false)
    }
  }

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
    }
  }

  const matches = (resolverResult?.matches ?? []).flatMap(matchToOptions)
  const fallbackTag = tagFallback()
  const showTagFallback = fallbackTag && !matches.some((m) => m.key === fallbackTag.key)
  const dropdownItems = fallbackTag && showTagFallback ? [...matches, fallbackTag] : matches
  const doneWithNoResults = !resolving && resolverResult !== null && dropdownItems.length === 0
  const showDropdown = focused && query.trim().length > 0 && (dropdownItems.length > 0 || resolving || doneWithNoResults || resolveError)

  const brightnessGlyph: Record<Brightness, string> = {
    primary: '○',
    medium: '◐',
    dim: '●',
  }
  const densityGlyph: Record<Density, string> = {
    compact: 'c',
    standard: 's',
    full: 'f',
  }
  const orientationGlyph: Record<Orientation, string> = {
    vertical: '|',
    horizontal: '─',
  }

  return (
    <div ref={barRef} style={{ position: 'relative' }}>
      <div
        style={{
          height: BAR_H,
          background: palette.barBg,
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          paddingLeft: 6,
          paddingRight: 6,
        }}
      >
        {/* Cycle controls — left side */}
        {onBrightnessCommit && (
          <BarButton
            label={`Brightness: ${brightness}`}
            glyph={brightnessGlyph[brightness]}
            color={palette.barText}
            mutedColor={palette.barTextMuted}
            onClick={() => onBrightnessCommit(nextBrightness(brightness))}
          />
        )}
        {onDensityCommit && (
          <BarButton
            label={`Density: ${density}`}
            glyph={densityGlyph[density]}
            color={palette.barText}
            mutedColor={palette.barTextMuted}
            onClick={() => onDensityCommit(nextDensity(density))}
          />
        )}
        {onOrientationCommit && (
          <BarButton
            label={`Orientation: ${orientation}`}
            glyph={orientationGlyph[orientation]}
            color={palette.barText}
            mutedColor={palette.barTextMuted}
            onClick={() => onOrientationCommit(nextOrientation(orientation))}
          />
        )}
        {onToggleSavedView && (
          <BarButton
            label={savedView ? 'Showing saved items — tap to return' : 'Show saved items'}
            glyph={savedView ? '★' : '☆'}
            color={savedView ? palette.crimson : palette.barText}
            mutedColor={savedView ? palette.crimson : palette.barTextMuted}
            onClick={onToggleSavedView}
          />
        )}

        {/* Gear button — opens the FeedComposer modal for rename/delete/full source list */}
        {onNameClick && (
          <BarButton
            label="Feed settings"
            glyph="⚙"
            color={palette.barText}
            mutedColor={palette.barTextMuted}
            onClick={onNameClick}
          />
        )}

        {/* Spacer */}
        <div style={{ flex: 1, minWidth: 8 }} />

        {/* Source search input — right side */}
        <div style={{ position: 'relative', maxWidth: 200, minWidth: 80, flex: '0 1 200px' }}>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setTimeout(() => setFocused(false), 150)
            }}
            placeholder="+ add source"
            className="font-mono text-[11px] uppercase tracking-[0.04em]"
            style={{
              width: '100%',
              height: 22,
              background: palette.barInputBg,
              color: palette.barInputText,
              border: 'none',
              borderRadius: 2,
              padding: '0 8px',
              outline: 'none',
              lineHeight: '22px',
            }}
          />
        </div>
      </div>

      {/* Dropdown — renders below the bar */}
      {showDropdown && (
        <div
          style={{
            position: 'absolute',
            right: 6,
            top: BAR_H,
            width: 280,
            maxHeight: 200,
            overflowY: 'auto',
            background: palette.barDropdownBg,
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.25)',
            zIndex: 20,
          }}
        >
          {resolving && dropdownItems.length === 0 && (
            <div
              className="font-mono text-[11px] uppercase tracking-[0.04em]"
              style={{ padding: '8px 10px', color: palette.barTextMuted }}
            >
              Resolving…
            </div>
          )}
          {resolveError && (
            <div
              className="font-mono text-[11px] uppercase tracking-[0.04em]"
              style={{ padding: '8px 10px', color: palette.crimson }}
            >
              Resolution failed
            </div>
          )}
          {doneWithNoResults && (
            <div
              className="font-mono text-[11px] uppercase tracking-[0.04em]"
              style={{ padding: '8px 10px', color: palette.barTextMuted }}
            >
              No match — try a URL, @user, npub, or #tag
            </div>
          )}
          {dropdownItems.map((opt) => (
            <button
              key={opt.key}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void handleAdd(opt)}
              disabled={adding}
              className="font-mono text-[11px] tracking-[0.02em]"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                width: '100%',
                padding: '8px 10px',
                background: 'transparent',
                border: 'none',
                color: palette.barText,
                cursor: adding ? 'default' : 'pointer',
                textAlign: 'left',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = palette.barDropdownHover)}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                {opt.label}
              </span>
              {opt.sublabel && (
                <span
                  className="font-mono text-[10px] uppercase tracking-[0.06em]"
                  style={{ color: palette.barTextMuted, marginLeft: 8, flexShrink: 0 }}
                >
                  {opt.sublabel}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function BarButton({
  label,
  glyph,
  color,
  mutedColor,
  onClick,
}: {
  label: string
  glyph: string
  color: string
  mutedColor: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="font-mono text-[11px] uppercase tracking-[0.06em] select-none"
      style={{
        color: mutedColor,
        background: 'transparent',
        border: 'none',
        padding: '0 5px',
        cursor: 'pointer',
        lineHeight: `${BAR_H}px`,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.color = color)}
      onMouseLeave={(e) => (e.currentTarget.style.color = mutedColor)}
    >
      {glyph}
    </button>
  )
}

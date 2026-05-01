'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useAuth } from '../../stores/auth'
import { TrustPip } from '../ui/TrustPip'
import { trust as trustApi, follows as followsApi } from '../../lib/api'
import type { TrustProfileResponse } from '../../lib/api/trust'
import type { PipStatus } from '../../lib/ndk'

// PipPanel — popover surface opened by tapping a TrustPip on a vessel card.
// Slice 12: native authors only (notes + articles). External cards' pips stay
// inert because external authors don't have a platform user id and the trust
// route keys on user id.
//
// Per CARDS-AND-PIP-PANEL-HANDOFF.md §"The pip panel": header (large pip +
// author name + chevron link to profile + right-aligned FOLLOW), bio line,
// TRUST section, VOLUME section, footer (SUBSCRIBE if offered).
//
// This slice ships a first cut: trust section renders the existing Layer 1
// signals + dimension scores from `trust_profiles` rather than the polling
// questions described in the handoff (the polling backend is a future system
// per ADR-OMNIBUS §III.7 and the trust-system spec proper). The VOLUME bar
// is rendered as a placeholder — interactive, but per-feed volume isn't yet
// schema-backed (ADR §3 "stub in code, no schema until the surface
// solidifies"). Both sections are flagged in-panel so users see what's real.

const TOKENS = {
  scrim: 'rgba(26, 26, 24, 0.18)',
  panelBg: '#FFFFFF',
  panelBorder: '#1A1A18',
  fg: '#1A1A18',
  meta: '#5F5E5A',
  hint: '#8A8880',
  rule: '#E6E5E0',
  crimson: '#B5242A',
}

interface PipPanelProps {
  open: boolean
  pubkey: string
  pipStatus?: PipStatus
  // Page coordinates of the tapped pip — used to anchor the popover.
  anchorRect: { top: number; left: number; bottom: number; right: number } | null
  initialIsFollowing: boolean
  onClose: () => void
  onFollowChanged?: (pubkey: string, following: boolean) => void
}

interface WriterMeta {
  id: string
  username: string
  displayName: string | null
  bio: string | null
  subscriptionPricePence: number
}

export function PipPanel({
  open,
  pubkey,
  pipStatus = 'unknown',
  anchorRect,
  initialIsFollowing,
  onClose,
  onFollowChanged,
}: PipPanelProps) {
  const { user } = useAuth()
  const [writer, setWriter] = useState<WriterMeta | null>(null)
  const [trustProfile, setTrustProfile] = useState<TrustProfileResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [following, setFollowing] = useState(initialIsFollowing)
  const [followBusy, setFollowBusy] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setFollowing(initialIsFollowing)
  }, [open, initialIsFollowing])

  // Fetch writer meta + trust profile on open. Sequenced because the trust
  // route keys on the writer's user id which we don't have until the writer
  // lookup returns.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setWriter(null)
    setTrustProfile(null)

    ;(async () => {
      try {
        const writerRes = await fetch(`/api/v1/writers/by-pubkey/${pubkey}`, {
          credentials: 'include',
        })
        if (!writerRes.ok) {
          throw new Error('Writer not found')
        }
        const wd = await writerRes.json()
        if (cancelled) return
        const writerMeta: WriterMeta = {
          id: wd.id,
          username: wd.username,
          displayName: wd.displayName ?? null,
          bio: wd.bio ?? null,
          subscriptionPricePence: wd.subscriptionPricePence ?? 0,
        }
        setWriter(writerMeta)
        try {
          const profile = await trustApi.getProfile(writerMeta.id)
          if (cancelled) return
          setTrustProfile(profile)
        } catch {
          // Trust route 404s for non-writer accounts; not fatal — leave the
          // section blank rather than blocking the rest of the panel.
        }
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [open, pubkey])

  // Esc + outside click close. Outside-click is a pointerdown listener on
  // document so a click that lands on the scrim or anywhere outside the panel
  // dismisses immediately.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    function onPointerDown(e: PointerEvent) {
      if (!panelRef.current) return
      if (panelRef.current.contains(e.target as Node)) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open, onClose])

  if (!open || !anchorRect) return null

  // Anchor positioning: open below-and-right of the pip when there's room,
  // otherwise above. Width clamps inside the viewport.
  const PANEL_W = 420
  const PANEL_H_HINT = 360 // estimate for placement; actual height is intrinsic.
  const margin = 12
  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1280
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800
  const preferredLeft = Math.min(
    Math.max(anchorRect.left, margin),
    viewportW - PANEL_W - margin,
  )
  const wantsAbove = anchorRect.bottom + margin + PANEL_H_HINT > viewportH
  const top = wantsAbove
    ? Math.max(margin, anchorRect.top - PANEL_H_HINT - margin)
    : anchorRect.bottom + margin

  const isOwn = !!user && user.pubkey === pubkey
  const profileHref = writer ? `/${writer.username}` : '#'
  const subscriptionPence = writer?.subscriptionPricePence ?? 0
  const offersSubscription = subscriptionPence > 0

  async function handleFollowToggle() {
    if (!writer || !user || isOwn || followBusy) return
    setFollowBusy(true)
    try {
      if (following) {
        await followsApi.unfollow(writer.id)
        setFollowing(false)
        onFollowChanged?.(pubkey, false)
      } else {
        await followsApi.follow(writer.id)
        setFollowing(true)
        onFollowChanged?.(pubkey, true)
      }
    } catch {
      // Silent — the visible state stays as-is on failure.
    } finally {
      setFollowBusy(false)
    }
  }

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Author details"
      style={{
        position: 'fixed',
        top,
        left: preferredLeft,
        width: PANEL_W,
        maxWidth: 'calc(100vw - 24px)',
        background: TOKENS.panelBg,
        border: `1px solid ${TOKENS.panelBorder}`,
        boxShadow: '0 12px 32px rgba(0, 0, 0, 0.18)',
        zIndex: 70,
        padding: 24,
      }}
    >
      {loading ? (
        <div
          className="font-mono text-[11px] uppercase tracking-[0.06em]"
          style={{ color: TOKENS.hint }}
        >
          LOADING…
        </div>
      ) : error ? (
        <div className="font-sans text-[13px]" style={{ color: TOKENS.meta }}>
          {error}
        </div>
      ) : writer ? (
        <>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span
              style={{ display: 'inline-flex', transform: 'scale(1.4)', transformOrigin: 'center' }}
            >
              <TrustPip status={pipStatus} />
            </span>
            <Link
              href={profileHref}
              onClick={onClose}
              className="font-serif"
              style={{
                fontSize: 18,
                fontWeight: 500,
                color: TOKENS.fg,
                textDecoration: 'none',
                flex: 1,
              }}
            >
              {writer.displayName || writer.username}
              <span style={{ color: TOKENS.hint, marginLeft: 6 }}>›</span>
            </Link>
            {!isOwn && user && (
              <button
                type="button"
                onClick={handleFollowToggle}
                disabled={followBusy}
                className="font-mono text-[11px] uppercase tracking-[0.06em]"
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: followBusy ? 'default' : 'pointer',
                  color: following ? TOKENS.meta : TOKENS.fg,
                  padding: 0,
                }}
              >
                {following ? 'FOLLOWING ›' : 'FOLLOW ›'}
              </button>
            )}
          </div>

          {/* Bio */}
          {writer.bio && (
            <p
              className="font-serif"
              style={{
                fontSize: 14,
                color: TOKENS.fg,
                marginTop: 12,
                lineHeight: 1.5,
              }}
            >
              {writer.bio}
            </p>
          )}

          {/* TRUST section — first cut */}
          <div style={{ marginTop: 20 }}>
            <div
              className="font-mono text-[11px] uppercase tracking-[0.06em]"
              style={{ color: TOKENS.meta, marginBottom: 8 }}
            >
              Trust
            </div>
            {trustProfile ? (
              <TrustSignals profile={trustProfile} />
            ) : (
              <p
                className="font-sans text-[13px]"
                style={{ color: TOKENS.hint }}
              >
                No trust signals yet.
              </p>
            )}
            <p
              className="font-serif italic"
              style={{
                fontSize: 13,
                color: TOKENS.hint,
                marginTop: 10,
                lineHeight: 1.45,
              }}
            >
              Polling questions land in a future slice.
            </p>
          </div>

          {/* Footer */}
          {offersSubscription && writer.username && (
            <div
              style={{
                marginTop: 20,
                paddingTop: 16,
                borderTop: `1px solid ${TOKENS.rule}`,
                textAlign: 'right',
              }}
            >
              <Link
                href={`/${writer.username}`}
                onClick={onClose}
                className="font-mono text-[11px] uppercase tracking-[0.06em]"
                style={{
                  color: TOKENS.crimson,
                  textDecoration: 'none',
                  fontWeight: 500,
                }}
              >
                SUBSCRIBE · £{(subscriptionPence / 100).toFixed(2)}/MO ›
              </Link>
            </div>
          )}
        </>
      ) : null}
    </div>
  )
}

// First-cut trust signals row. Renders the Layer 1 signals + dimension counts
// rather than the polling questions described in CARDS-AND-PIP-PANEL-HANDOFF.md
// — those need a polling backend that doesn't exist yet. The current set
// answers a similar question (what does the system know about this author?)
// using data that's actually available.
function TrustSignals({ profile }: { profile: TrustProfileResponse }) {
  const l1 = profile.layer1
  const rows: Array<{ label: string; value: string }> = [
    {
      label: 'Account age',
      value: l1.accountAgeDays >= 365
        ? `${Math.floor(l1.accountAgeDays / 365)}y`
        : `${l1.accountAgeDays}d`,
    },
    { label: 'Articles', value: String(l1.articleCount) },
    { label: 'Paying readers', value: String(l1.payingReaderCount) },
    { label: 'NIP-05', value: l1.nip05Verified ? 'YES' : 'NO' },
    { label: 'Payment verified', value: l1.paymentVerified ? 'YES' : 'NO' },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.map((r) => (
        <div
          key={r.label}
          style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}
        >
          <span
            className="font-sans text-[13px]"
            style={{ color: '#1A1A18', flex: 1 }}
          >
            {r.label}
          </span>
          <span
            className="font-mono text-[11px] uppercase tracking-[0.06em]"
            style={{ color: '#5F5E5A' }}
          >
            {r.value}
          </span>
        </div>
      ))}
    </div>
  )
}

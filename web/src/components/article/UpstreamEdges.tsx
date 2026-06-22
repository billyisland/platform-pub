'use client'

import { useState, useEffect } from 'react'
import { upstreamEdges, type CreditEdge, type CitationEdge } from '../../lib/api'
import { ProfileLink } from '../ui/ProfileLink'

// =============================================================================
// Upstream Edges — piece-foot apparatus (UPSTREAM-EDGES-ADR, Phase 1)
//
// Renders a piece's CREDITS (acknowledged debts, with any disclaimers adjacent)
// and CITATIONS ("X argues Y", with the pinned excerpt and disputes) as an
// endnote block at the foot of the article, ahead of replies. Read-only.
//
// The reader is the fixed-light surface (no per-feed palette in scope), so this
// follows the reader's own grey idiom + .label-ui — never per-feed palette
// fields. No single-pixel lines: separation is whitespace, emphasis the 4px slab.
//
// DEFERRED (focused follow-up): the inline-in-prose citation marker anchored at
// char_start inside the dangerouslySetInnerHTML body. That needs careful prose-
// DOM injection + runtime iteration; the cited-author dispute renders here in
// the apparatus (one per citation) in the meantime.
// =============================================================================

export function UpstreamEdges({ articleDbId }: { articleDbId?: string }) {
  const [credits, setCredits] = useState<CreditEdge[]>([])
  const [citations, setCitations] = useState<CitationEdge[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!articleDbId) return
    let cancelled = false
    void Promise.all([
      upstreamEdges.getCredits(articleDbId).catch(() => ({ credits: [] })),
      upstreamEdges.getCitations(articleDbId).catch(() => ({ citations: [] })),
    ]).then(([c, q]) => {
      if (cancelled) return
      setCredits(c.credits)
      setCitations(q.citations)
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [articleDbId])

  if (!loaded || (credits.length === 0 && citations.length === 0)) return null

  return (
    <section className="mt-16 space-y-10">
      {credits.length > 0 && (
        <div>
          <h2 className="label-ui text-grey-400 mb-4">Credits</h2>
          <ul className="space-y-5">
            {credits.map((c) => (
              <CreditRow key={c.id} credit={c} />
            ))}
          </ul>
        </div>
      )}

      {citations.length > 0 && (
        <div>
          <h2 className="label-ui text-grey-400 mb-4">Citations</h2>
          <ul className="space-y-6">
            {citations.map((c) => (
              <CitationRow key={c.id} citation={c} />
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

// ── Credit ────────────────────────────────────────────────────────────────

function CreditRow({ credit }: { credit: CreditEdge }) {
  const { target } = credit
  const name = target.displayName ?? target.username ?? 'an unnamed source'

  return (
    <li className="text-ui-sm text-grey-600 leading-relaxed">
      <span className="text-black">
        {target.accountId && target.username ? (
          <ProfileLink href={`/${target.username}`} className="font-medium hover:underline">
            {name}
          </ProfileLink>
        ) : (
          <span className="font-medium">{name}</span>
        )}
      </span>
      {credit.note && <span> — {credit.note}</span>}

      {credit.disclaimers.map((d) => (
        <p key={d.id} className="mt-1 pl-4 text-ui-xs text-grey-600">
          <span className="text-grey-400">↳ </span>
          {d.byCreditedParty ? 'They reject this attribution: ' : 'Disputed: '}
          {d.counterCharacterisation}
        </p>
      ))}
    </li>
  )
}

// ── Citation ──────────────────────────────────────────────────────────────

function CitationRow({ citation }: { citation: CitationEdge }) {
  const [showContext, setShowContext] = useState(false)
  const [showThirdParty, setShowThirdParty] = useState(false)
  const { source, disputes } = citation

  const sourceLabel = source.displayName ?? source.username ?? source.uri ?? null
  const cited = disputes.citedAuthor

  return (
    <li className="space-y-2">
      <p className="text-ui-sm text-black leading-relaxed">{citation.characterisation}</p>

      <blockquote className="font-serif italic text-grey-600 leading-relaxed pl-4">
        “{citation.excerpt}”
      </blockquote>

      {sourceLabel && (
        <p className="label-ui text-grey-400">
          {source.username ? (
            <ProfileLink href={`/${source.username}`} className="hover:underline">
              {sourceLabel}
            </ProfileLink>
          ) : (
            sourceLabel
          )}
        </p>
      )}

      {/* The cited author's own dispute — rendered inline (max one). */}
      {cited && (
        <div className="pl-4 text-ui-xs text-grey-600">
          <p>
            <span className="text-grey-400">↳ </span>
            The cited author disputes this: {cited.counterCharacterisation}
          </p>
          {cited.widerExcerpt && (
            <div className="mt-1">
              <button
                onClick={() => setShowContext((v) => !v)}
                className="label-ui text-grey-400 hover:text-black hover:underline transition-colors"
              >
                {showContext ? 'Hide fuller context' : 'Show fuller context'}
              </button>
              {showContext && (
                <blockquote className="mt-1 font-serif italic text-grey-600 leading-relaxed">
                  “{cited.widerExcerpt}”
                </blockquote>
              )}
            </div>
          )}
        </div>
      )}

      {/* Third-party disputes — a count only, on expansion (never a badge). */}
      {disputes.thirdPartyCount > 0 && (
        <div className="pl-4">
          <button
            onClick={() => setShowThirdParty((v) => !v)}
            className="label-ui text-grey-400 hover:text-black hover:underline transition-colors"
          >
            {showThirdParty
              ? 'Hide disputes'
              : `${disputes.thirdPartyCount} ${disputes.thirdPartyCount === 1 ? 'dispute' : 'disputes'}`}
          </button>
          {showThirdParty && (
            <p className="mt-1 text-ui-xs text-grey-600">
              {disputes.thirdPartyCount}{' '}
              {disputes.thirdPartyCount === 1 ? 'reader has' : 'readers have'} disputed this citation.
            </p>
          )}
        </div>
      )}
    </li>
  )
}

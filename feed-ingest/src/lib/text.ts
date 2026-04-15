// =============================================================================
// Text helpers shared by outbound adapters.
//
// Post-length limits on the platforms we federate to are counted in graphemes
// (Bluesky: 300, Mastodon: 500 by default — operator-overridable per instance),
// not code units. An emoji, CJK ideogram, or combining-mark sequence renders
// as a single grapheme but takes multiple JS string units, so naive
// `text.length` truncation over-cuts non-Latin posts and can split surrogate
// pairs, producing invalid UTF-16.
//
// countGraphemes() returns the grapheme array (null if Intl.Segmenter is
// missing — Node 18+ always has it, so the fallback is defensive only).
// truncateWithLink() keeps room for a "…\n\n<url>" tail so truncated
// federations still link back to the canonical all.haus post.
// =============================================================================

export function countGraphemes(text: string): string[] | null {
  // Intl.Segmenter is runtime-available on Node 18+ but may be missing from
  // the TS lib target on older setups — cast through any to tolerate both.
  const Segmenter = (typeof Intl !== 'undefined' ? (Intl as any).Segmenter : undefined) as
    | (new (locale: string | undefined, options: { granularity: 'grapheme' }) => {
        segment: (t: string) => Iterable<{ segment: string }>
      })
    | undefined
  if (!Segmenter) return null
  const seg = new Segmenter(undefined, { granularity: 'grapheme' })
  const parts: string[] = []
  for (const s of seg.segment(text)) parts.push(s.segment)
  return parts
}

export interface TruncateOptions {
  /** Maximum number of graphemes in the output. */
  max: number
  /** Appended verbatim when truncation is needed, e.g. all.haus canonical URL. */
  linkSuffix?: string
  /** Ellipsis glyph. Default "…" (one grapheme). */
  ellipsis?: string
  /** Separator between body and linkSuffix. Default "\n\n". */
  separator?: string
}

export function truncateWithLink(text: string, opts: TruncateOptions): string {
  if (!text) return ''
  const { max } = opts
  if (max <= 0) return ''

  const ellipsis = opts.ellipsis ?? '…'
  const separator = opts.separator ?? '\n\n'
  const parts = countGraphemes(text)

  // Fallback: no Intl.Segmenter — assume 1 code unit ≈ 1 grapheme. Callers
  // on modern Node hit this only if text is short enough that mis-counting is
  // harmless; still, prefer the Segmenter path when present.
  if (!parts) {
    if (text.length <= max) return text
    if (!opts.linkSuffix) return text.slice(0, Math.max(0, max - 1)) + ellipsis
    const tail = `${separator}${opts.linkSuffix}`
    const budget = Math.max(0, max - tail.length - 1)
    return text.slice(0, budget) + ellipsis + tail
  }

  if (parts.length <= max) return text
  if (!opts.linkSuffix) return parts.slice(0, Math.max(0, max - 1)).join('') + ellipsis

  const tail = `${separator}${opts.linkSuffix}`
  const tailParts = countGraphemes(tail) ?? [tail]
  const budget = Math.max(0, max - tailParts.length - 1) // -1 for ellipsis
  return parts.slice(0, budget).join('') + ellipsis + tail
}

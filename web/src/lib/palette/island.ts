// =============================================================================
// Light island — the inline style that re-pins the global-dark neutral slugs
// back to their canonical LIGHT triples on a subtree. Under `html.dark`,
// globals.css inverts these slugs at the document root; any element carrying
// LIGHT_ISLAND_STYLE redeclares them inline (inline beats the stylesheet rule),
// so its whole subtree resolves canonical-light regardless of the global mode.
//
// Used to keep desktop feed vessels per-scheme (they must NOT follow the global
// light/dark toggle), the ForallMenu locked-chrome disc, and the FeedComposer
// scheme swatch (which must always preview true scheme colours).
//
// DARK_SLUGS must stay in sync with the `html.dark { … }` block in globals.css.
// =============================================================================

import type { CSSProperties } from 'react'
import { PALETTE_REGISTRY, rgbVarName, hexToTriple } from './registry'

/** The neutral chrome slugs the global dark mode inverts. */
export const DARK_SLUGS = [
  'ink',
  'nav-grey',
  'grey-600',
  'grey-400',
  'grey-300',
  'grey-200',
  'grey-100',
  'white',
  'glasshouse',
  'glasshouse-well',
  'bone',
  'bone-bright',
  'off-white',
  'cream',
  'cream-hover',
] as const

const REG = new Map(PALETTE_REGISTRY.map((e) => [e.slug, e.hex]))

/** Inline style re-pinning every DARK_SLUG to its canonical light `-rgb` triple. */
export const LIGHT_ISLAND_STYLE: CSSProperties = Object.fromEntries(
  DARK_SLUGS.map((slug) => [rgbVarName(slug), hexToTriple(REG.get(slug) as string)]),
) as CSSProperties

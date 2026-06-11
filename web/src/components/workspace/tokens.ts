// Workspace colour palettes — per-feed colour schemes (feature-debt §3,
// productising WIREFRAME-DECISIONS-CONSOLIDATED.md "Colour tokens committed").
//
// 'primary' (light) and 'dark' are the two hand-tuned reference palettes; the
// other schemes are CURATED SURFACE SETS (walls / interior / card, slugs in
// lib/palette/registry.ts) whose text colours are DERIVED, never hand-set:
// luminance picks between the two tuned text ramps (light-surface ramp from
// `primary`, dark-surface ramp from `dark`), so the primary/secondary/muted
// hierarchy survives any curated surface. Semantic colour flips ride the same
// switch (crimson → crimson-soft on dark cards). Curate swatches to be clearly
// light or clearly dark — a mid-luminance card defeats both ramps; that band
// is avoided by curation, not patched per-pixel.
//
// `normalizeBrightness` maps any stale persisted value (retired 'medium'/'dim',
// or a scheme id from a newer build) onto the light default so old
// localStorage layouts and stale clients keep working. The scheme id list must
// mirror FEED_SCHEME_IDS in gateway/src/routes/feeds.ts (PATCH validation).

import { PALETTE_REGISTRY } from '../../lib/palette/registry'

export type FeedScheme =
  | 'primary'
  | 'dark'
  | 'blush'
  | 'sage'
  | 'sand'
  | 'slate'
// Legacy name — the per-vessel "brightness" axis grew into the scheme picker;
// the persisted localStorage field and existing prop names keep this alias.
export type Brightness = FeedScheme
export type Density = 'compact' | 'standard' | 'full'
export type Orientation = 'vertical' | 'horizontal'

export const DEFAULT_BRIGHTNESS: FeedScheme = 'primary'
export const DEFAULT_DENSITY: Density = 'standard'
export const DEFAULT_ORIENTATION: Orientation = 'vertical'

export interface VesselPalette {
  /** Dark-card family — drives isDarkPalette() and the derived text ramp. */
  isDark: boolean
  walls: string
  interior: string
  nameLabel: string
  cardBg: string
  cardTitle: string
  cardStandfirst: string
  cardMeta: string
  crimson: string
  resizeHandle: string
  pipOpacity: number
  barBg: string
  barText: string
  barTextMuted: string
  barInputBg: string
  barInputText: string
  barInputPlaceholder: string
  barDropdownBg: string
  barDropdownHover: string
}

// Same weighting as the PalettePanel helper — keep the two in agreement.
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  return (
    (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) /
    255
  )
}

const REGISTRY_HEX = new Map(PALETTE_REGISTRY.map((e) => [e.slug, e.hex]))
function registryHex(slug: string): string {
  const hex = REGISTRY_HEX.get(slug)
  if (!hex) throw new Error(`Unknown palette registry slug: ${slug}`)
  return hex
}

// Curated scheme → its three surfaces (registry slugs). The bar shares the
// walls colour, mirroring primary (ink/ink) and dark (true-black/true-black).
const SCHEME_SURFACES: Record<
  Exclude<FeedScheme, 'primary' | 'dark'>,
  { walls: string; interior: string; cardBg: string }
> = {
  blush: { walls: 'blush-walls', interior: 'blush-interior', cardBg: 'blush-card' },
  sage: { walls: 'sage-walls', interior: 'sage-interior', cardBg: 'sage-card' },
  sand: { walls: 'sand-walls', interior: 'sand-interior', cardBg: 'sand-card' },
  slate: { walls: 'slate-walls', interior: 'slate-interior', cardBg: 'slate-card' },
}

// Expand a curated surface set into a full VesselPalette. Luminance is read
// from the canonical registry hex (devtool overrides re-skin the rendered
// vars but don't flip the text family — curated schemes are committed to one
// family). The bar wells are derived washes of the walls var via color-mix so
// they keep tracking live-tuned walls.
function deriveVesselPalette(s: {
  walls: string
  interior: string
  cardBg: string
}): VesselPalette {
  const v = (slug: string) => `var(--ah-${slug})`
  const darkCard = luminance(registryHex(s.cardBg)) < 0.5
  const darkInterior = luminance(registryHex(s.interior)) < 0.5
  const darkBar = luminance(registryHex(s.walls)) < 0.5
  const well = (pct: number) =>
    `color-mix(in srgb, ${v(s.walls)}, rgb(var(--ah-${
      darkBar ? 'white' : 'ink'
    }-rgb)) ${pct}%)`
  return {
    isDark: darkCard,
    walls: v(s.walls),
    interior: v(s.interior),
    nameLabel: darkInterior ? 'var(--ah-stone-350)' : 'var(--ah-stone-600)',
    cardBg: v(s.cardBg),
    cardTitle: darkCard ? 'var(--ah-bone)' : 'var(--ah-ink)',
    cardStandfirst: darkCard ? 'var(--ah-stone-300)' : 'var(--ah-stone-600)',
    cardMeta: 'var(--ah-stone-400)',
    crimson: darkCard ? 'var(--ah-crimson-soft)' : 'var(--ah-crimson)',
    resizeHandle: 'var(--ah-stone-600)',
    pipOpacity: 1,
    barBg: v(s.walls),
    barText: darkBar ? 'var(--ah-bone-bright)' : 'var(--ah-ink)',
    barTextMuted: darkBar ? 'var(--ah-stone-400)' : 'var(--ah-stone-600)',
    barInputBg: well(9),
    barInputText: darkBar ? 'var(--ah-bone-bright)' : 'var(--ah-ink)',
    barInputPlaceholder: darkBar ? 'var(--ah-stone-350)' : 'var(--ah-stone-400)',
    barDropdownBg: well(5),
    barDropdownHover: well(9),
  }
}

export const PALETTES: Record<FeedScheme, VesselPalette> = {
  // The two reference palettes stay literal (hand-tuned wells incl. the
  // ink-850/ink-925 bar steps) — derivation selects between their text ramps.
  primary: {
    isDark: false,
    walls: 'var(--ah-ink)',
    interior: 'var(--ah-bone)',
    nameLabel: 'var(--ah-stone-600)',
    cardBg: 'var(--ah-white)',
    cardTitle: 'var(--ah-ink)',
    cardStandfirst: 'var(--ah-stone-600)',
    cardMeta: 'var(--ah-stone-400)',
    crimson: 'var(--ah-crimson)',
    resizeHandle: 'var(--ah-stone-600)',
    pipOpacity: 1,
    barBg: 'var(--ah-ink)',
    barText: 'var(--ah-bone-bright)',
    barTextMuted: 'var(--ah-stone-400)',
    barInputBg: 'var(--ah-ink-850)',
    barInputText: 'var(--ah-bone-bright)',
    barInputPlaceholder: 'var(--ah-ink-grey)',
    barDropdownBg: 'var(--ah-ink-925)',
    barDropdownHover: 'var(--ah-ink-850)',
  },
  dark: {
    isDark: true,
    walls: 'var(--ah-true-black)',
    interior: 'var(--ah-ink-925)',
    nameLabel: 'var(--ah-stone-350)',
    cardBg: 'var(--ah-ink-900)',
    cardTitle: 'var(--ah-bone)',
    cardStandfirst: 'var(--ah-stone-300)',
    cardMeta: 'var(--ah-stone-400)',
    crimson: 'var(--ah-crimson-soft)',
    resizeHandle: 'var(--ah-stone-600)',
    pipOpacity: 1,
    barBg: 'var(--ah-true-black)',
    barText: 'var(--ah-bone-bright)',
    barTextMuted: 'var(--ah-stone-400)',
    barInputBg: 'var(--ah-ink-850)',
    barInputText: 'var(--ah-bone-bright)',
    barInputPlaceholder: 'var(--ah-ink-grey)',
    barDropdownBg: 'var(--ah-ink-925)',
    barDropdownHover: 'var(--ah-ink-850)',
  },
  blush: deriveVesselPalette(SCHEME_SURFACES.blush),
  sage: deriveVesselPalette(SCHEME_SURFACES.sage),
  sand: deriveVesselPalette(SCHEME_SURFACES.sand),
  slate: deriveVesselPalette(SCHEME_SURFACES.slate),
}

// Picker metadata, in display order (FeedComposer swatch row).
export const SCHEME_OPTIONS: ReadonlyArray<{ id: FeedScheme; label: string }> = [
  { id: 'primary', label: 'Paper' },
  { id: 'dark', label: 'Dark' },
  { id: 'blush', label: 'Blush' },
  { id: 'sage', label: 'Sage' },
  { id: 'sand', label: 'Sand' },
  { id: 'slate', label: 'Slate' },
]

const SCHEME_IDS = new Set<string>(SCHEME_OPTIONS.map((o) => o.id))

// Coerce any value (stale persisted 'medium'/'dim', unknown scheme ids from a
// newer build, junk) to a live scheme.
export function normalizeBrightness(
  b: Brightness | string | null | undefined,
): FeedScheme {
  return typeof b === 'string' && SCHEME_IDS.has(b) ? (b as FeedScheme) : 'primary'
}

// Palette lookup that tolerates stale/undefined scheme ids without crashing.
export function paletteFor(
  b: Brightness | string | null | undefined,
): VesselPalette {
  return PALETTES[normalizeBrightness(b)]
}

// True when the palette is a dark-card family. Lets palette-only consumers pick
// a mode-aware translucent wash (a dark wash reads on light cards, a light wash
// on dark cards) without also threading the scheme through.
export function isDarkPalette(p: VesselPalette): boolean {
  return p.isDark
}

export function nextDensity(d: Density): Density {
  if (d === 'compact') return 'standard'
  if (d === 'standard') return 'full'
  return 'compact'
}

export function nextOrientation(o: Orientation): Orientation {
  return o === 'vertical' ? 'horizontal' : 'vertical'
}

// Per-feed reading-text size (task 8/9). Governs the prose body of every card
// in a feed (main, reply, parent) in lockstep; meta rows and bylines (mono
// `label-ui`) stay fixed. Default step 3 = 13.5px keeps today's body size; the
// range either side is deliberately wide so the smallest and largest steps
// read as distinctly denser / more generous, not just adjacent half-points.
export type TextSize = 1 | 2 | 3 | 4 | 5
export const DEFAULT_TEXT_SIZE: TextSize = 3
export const TEXT_SIZE_PX: Record<TextSize, number> = {
  1: 11,
  2: 12.25,
  3: 13.5,
  4: 15.75,
  5: 18,
}
export function nextTextSize(t: TextSize): TextSize {
  return t >= 5 ? 1 : ((t + 1) as TextSize)
}

// =============================================================================
// Canonical colour registry — the single ordered list of every colour the site
// renders. Each entry owns a pair of CSS custom properties defined in
// globals.css `:root`:
//
//   --ah-<slug>-rgb : "R G B" triple (Tailwind consumes it with <alpha-value>)
//   --ah-<slug>     : rgb(var(--ah-<slug>-rgb)) — what inline styles reference
//
// Position in this list is canonical: the Palette devtool renders boxes and the
// copyable identifier list in exactly this order, so "colour 07" always means
// the same set of components.
//
// TEMPORARY KIT NOTE: the registry itself (and the var() indirection it
// documents) is permanent infrastructure; the PalettePanel devtool + ForallMenu
// "Palette" row are the temporary parts to remove once the scheme is final.
// =============================================================================

export interface PaletteEntry {
  slug: string
  /** Canonical default, uppercase #RRGGBB. Must match the :root default. */
  hex: string
  /** Where the colour applies — for the human reading the panel. */
  label: string
}

export const PALETTE_REGISTRY: PaletteEntry[] = [
  { slug: 'ink', hex: '#111111', label: 'Primary ink — text, native card bar, slab rules, buttons, light-mode vessel walls' },
  { slug: 'true-black', hex: '#000000', label: 'Dark-mode vessel walls & bar; video letterbox' },
  { slug: 'white', hex: '#FFFFFF', label: 'Page ground, cards, input fields, text on dark' },
  { slug: 'grey-100', hex: '#F0F0F0', label: 'Soft fills — ghost buttons, inactive pills, paywall panel' },
  { slug: 'grey-200', hex: '#E5E5E5', label: 'Hover fills, input edges' },
  { slug: 'grey-300', hex: '#BBBBBB', label: 'External card bar, disabled states, blockquote rule' },
  { slug: 'neighbour-grey', hex: '#CCCCCC', label: 'Legacy neighbourhood-card bar' },
  { slug: 'grey-400', hex: '#999999', label: 'Placeholders, muted text links, section-label text' },
  { slug: 'grey-600', hex: '#666666', label: 'Secondary text on light & glasshouse surfaces' },
  { slug: 'nav-grey', hex: '#333333', label: 'Black-topbar dropdown 4px rules' },
  { slug: 'crimson', hex: '#B5242A', label: 'Accent — paid bar, selection, votes, errors, focus rings' },
  { slug: 'crimson-dark', hex: '#921D22', label: 'Crimson dark step (token crimson-dark)' },
  { slug: 'crimson-deep', hex: '#8B1B1F', label: 'Danger text-link hover' },
  { slug: 'crimson-soft', hex: '#D9555A', label: 'Dark-mode crimson (vessel palette)' },
  { slug: 'vouch-red', hex: '#C41230', label: 'Vouch modal error text' },
  { slug: 'danger-red', hex: '#DC2626', label: 'Destructive action buttons (danger zone)' },
  { slug: 'glasshouse', hex: '#DCDAD3', label: 'Frosted overlay pane (fixed mid-light surface)' },
  { slug: 'bone', hex: '#F0EFEB', label: 'Workspace floor & light interior; dark-mode card titles' },
  { slug: 'bone-bright', hex: '#E6E5E0', label: 'Vessel-bar text; pip-panel rules' },
  { slug: 'stone-300', hex: '#B4B2A9', label: 'Dark-mode card standfirst' },
  { slug: 'stone-350', hex: '#9C9A94', label: 'Dark-mode vessel name labels' },
  { slug: 'stone-400', hex: '#8A8880', label: 'Muted meta — card metadata, bar muted text (both modes)' },
  { slug: 'stone-600', hex: '#5F5E5A', label: 'Light-mode standfirst, name labels, resize handles' },
  { slug: 'trust-grey', hex: '#B0B0AB', label: 'Trust pip — unknown / thin' },
  { slug: 'ink-925', hex: '#1A1A18', label: 'Dark interior & ground, panel frames, forall button' },
  { slug: 'ink-900', hex: '#232320', label: 'Dark-mode card surface' },
  { slug: 'ink-850', hex: '#2A2A27', label: 'Vessel-bar inputs, dark dropdown hover' },
  { slug: 'ink-grey', hex: '#6A6A66', label: 'Vessel-bar input placeholder' },
  { slug: 'wall-grey', hex: '#4A4A47', label: 'Forall ceremony wall' },
  { slug: 'trust-green', hex: '#1D9E75', label: 'Trust pip — known / strong' },
  { slug: 'trust-amber', hex: '#EF9F27', label: 'Trust pip — partial / moderate' },
  { slug: 'klein-blue', hex: '#002FA7', label: 'Traffology provenance accent (IKB)' },
  { slug: 'cream', hex: '#F5F4F0', label: 'Forall ceremony card' },
  { slug: 'cream-hover', hex: '#FAFAF7', label: 'Playscript reply hover tint' },
  { slug: 'off-white', hex: '#FAFAFA', label: 'Provenance bar ground' },
  { slug: 'blush', hex: '#F5D5D6', label: 'Profile avatar gradient start' },
  { slug: 'blush-deep', hex: '#E8A5A7', label: 'Profile avatar gradient end' },
]

export const PALETTE_STORAGE_KEY = 'ah:palette-overrides'

export function rgbVarName(slug: string): string {
  return `--ah-${slug}-rgb`
}

/** '#B5242A' → '181 36 42' (the space-separated triple the vars hold). */
export function hexToTriple(hex: string): string {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = parseInt(full, 16)
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`
}

/** Accepts '#abc', 'abc123', '#ABC123' → '#ABC123'; null if not a hex colour. */
export function normalizeHex(input: string): string | null {
  const m = input.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{6}$/.test(m)) return `#${m.toUpperCase()}`
  if (/^[0-9a-fA-F]{3}$/.test(m))
    return `#${m.split('').map((c) => c + c).join('').toUpperCase()}`
  return null
}

/**
 * Push overrides into the live page: each overridden slug gets its `-rgb`
 * triple set inline on <html> (winning over the :root default); slugs without
 * an override have any inline value removed so they fall back to :root.
 */
export function applyPaletteOverrides(overrides: Record<string, string>): void {
  const root = document.documentElement
  for (const entry of PALETTE_REGISTRY) {
    const hex = overrides[entry.slug]
    if (hex) root.style.setProperty(rgbVarName(entry.slug), hexToTriple(hex))
    else root.style.removeProperty(rgbVarName(entry.slug))
  }
}

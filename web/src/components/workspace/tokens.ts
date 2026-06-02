// Workspace colour palettes — two brightness modes per
// WIREFRAME-DECISIONS-CONSOLIDATED.md "Colour tokens committed".
//
// Brightness is a straight light/dark toggle: 'primary' is the light reading
// surface, 'dark' is a proper dark mode (dark interior, light text). The old
// intermediate 'medium'/'dim' grey steps were retired — they were neither a
// useful brightness range nor a real dark mode. `normalizeBrightness` maps any
// stale persisted value ('medium'/'dim') back onto the light default so old
// localStorage layouts keep working.

export type Brightness = 'primary' | 'dark'
export type Density = 'compact' | 'standard' | 'full'
export type Orientation = 'vertical' | 'horizontal'

export const DEFAULT_BRIGHTNESS: Brightness = 'primary'
export const DEFAULT_DENSITY: Density = 'standard'
export const DEFAULT_ORIENTATION: Orientation = 'vertical'

export interface VesselPalette {
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

export const PALETTES: Record<Brightness, VesselPalette> = {
  primary: {
    walls: '#111111',
    interior: '#F0EFEB',
    nameLabel: '#5F5E5A',
    cardBg: '#FFFFFF',
    cardTitle: '#111111',
    cardStandfirst: '#5F5E5A',
    cardMeta: '#8A8880',
    crimson: '#B5242A',
    resizeHandle: '#5F5E5A',
    pipOpacity: 1,
    barBg: '#111111',
    barText: '#E6E5E0',
    barTextMuted: '#8A8880',
    barInputBg: '#2A2A27',
    barInputText: '#E6E5E0',
    barInputPlaceholder: '#6A6A66',
    barDropdownBg: '#1A1A18',
    barDropdownHover: '#2A2A27',
  },
  dark: {
    walls: '#000000',
    interior: '#1A1A18',
    nameLabel: '#9C9A94',
    cardBg: '#232320',
    cardTitle: '#F0EFEB',
    cardStandfirst: '#B4B2A9',
    cardMeta: '#8A8880',
    crimson: '#D9555A',
    resizeHandle: '#5F5E5A',
    pipOpacity: 1,
    barBg: '#000000',
    barText: '#E6E5E0',
    barTextMuted: '#8A8880',
    barInputBg: '#2A2A27',
    barInputText: '#E6E5E0',
    barInputPlaceholder: '#6A6A66',
    barDropdownBg: '#1A1A18',
    barDropdownHover: '#2A2A27',
  },
}

// Coerce any value (including stale persisted 'medium'/'dim') to a live mode.
export function normalizeBrightness(
  b: Brightness | string | null | undefined,
): Brightness {
  return b === 'dark' ? 'dark' : 'primary'
}

// Palette lookup that tolerates stale/undefined brightness without crashing.
export function paletteFor(
  b: Brightness | string | null | undefined,
): VesselPalette {
  return PALETTES[normalizeBrightness(b)]
}

export function nextBrightness(b: Brightness): Brightness {
  return normalizeBrightness(b) === 'dark' ? 'primary' : 'dark'
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

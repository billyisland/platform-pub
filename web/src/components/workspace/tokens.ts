// Workspace colour palettes — three brightness states per
// WIREFRAME-DECISIONS-CONSOLIDATED.md "Colour tokens committed".
//
// Slice 5c: brightness is one of three discrete states. The spec allows a
// continuous range (with dark mode at the limit) but the touch gesture that
// makes continuity feel right (two-finger vertical drag) is deferred per
// ADR §5; on desktop the cycle button cycles through the three tested
// tokens. Storing 'primary' | 'medium' | 'dim' rather than a number is more
// honest about what's wired today; when continuous lands, the storage
// shape evolves at that point.

export type Brightness = 'primary' | 'medium' | 'dim'
export type Density = 'compact' | 'standard' | 'full'
export type Orientation = 'vertical' | 'horizontal'

export const DEFAULT_BRIGHTNESS: Brightness = 'medium'
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
  },
  medium: {
    walls: '#4A4A47',
    interior: '#E6E5E0',
    nameLabel: '#8A8880',
    cardBg: '#F5F4F0',
    cardTitle: '#3A3A37',
    cardStandfirst: '#7A7974',
    cardMeta: '#9C9A94',
    crimson: '#B5242A',
    resizeHandle: '#9C9A94',
    pipOpacity: 1,
  },
  dim: {
    walls: '#8A8880',
    interior: '#D4D3CE',
    nameLabel: '#B4B2A9',
    cardBg: '#E8E7E2',
    cardTitle: '#6B6A66',
    cardStandfirst: '#9C9A94',
    cardMeta: '#A8A6A0',
    crimson: '#C4545A',
    resizeHandle: '#B4B2A9',
    pipOpacity: 0.7,
  },
}

export function nextBrightness(b: Brightness): Brightness {
  if (b === 'primary') return 'medium'
  if (b === 'medium') return 'dim'
  return 'primary'
}

export function nextDensity(d: Density): Density {
  if (d === 'compact') return 'standard'
  if (d === 'standard') return 'full'
  return 'compact'
}

export function nextOrientation(o: Orientation): Orientation {
  return o === 'vertical' ? 'horizontal' : 'vertical'
}

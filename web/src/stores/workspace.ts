import { create } from 'zustand'
import type { Brightness, Density, Orientation } from '../components/workspace/tokens'

// =============================================================================
// useWorkspace — vessel layout state for the workspace experiment
//
// Slice 5a: position ({x, y} in floor coordinates, top-left origin).
// Slice 5b: width + height (optional — undefined means "intrinsic size").
// Slice 5c: brightness, density, orientation (optional — undefined means
// the per-axis default: medium / standard / vertical).
//
// Per WORKSPACE-EXPERIMENT-ADR.md §3, localStorage is the source of truth
// for workspace layout. The store is hydrated from localStorage on first
// authenticated load (keyed by user id) and writes back debounced 200ms.
// No server sync this slice.
//
// Storage shape stays Record<feedId, VesselLayout>. Slice-5a values
// (`{x, y}` only) and slice-5b values (`{x, y, w, h}`) read forward cleanly
// because every additional axis is optional.
// =============================================================================

export interface VesselLayout {
  x: number
  y: number
  w?: number
  h?: number
  brightness?: Brightness
  density?: Density
  orientation?: Orientation
}

interface WorkspaceState {
  userId: string | null
  positions: Record<string, VesselLayout>
  hydrated: boolean

  hydrate: (userId: string) => void
  setVesselPosition: (feedId: string, pos: { x: number; y: number }) => void
  setVesselSize: (feedId: string, size: { w: number; h: number }) => void
  setVesselBrightness: (feedId: string, brightness: Brightness) => void
  setVesselDensity: (feedId: string, density: Density) => void
  setVesselOrientation: (feedId: string, orientation: Orientation) => void
  removeVessel: (feedId: string) => void
  reset: () => void
}

const STORAGE_PREFIX = 'workspace:layout:'
const WRITE_DEBOUNCE_MS = 200

let writeTimer: ReturnType<typeof setTimeout> | null = null

function storageKey(userId: string) {
  return `${STORAGE_PREFIX}${userId}`
}

function readFromStorage(userId: string): Record<string, VesselLayout> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(storageKey(userId))
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return parsed
    return {}
  } catch {
    return {}
  }
}

function scheduleWrite(userId: string, positions: Record<string, VesselLayout>) {
  if (typeof window === 'undefined') return
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    try {
      window.localStorage.setItem(storageKey(userId), JSON.stringify(positions))
    } catch {
      // Quota exceeded / private browsing — silently drop. The UI keeps the
      // in-memory layout; we don't want a write failure to crash the floor.
    }
    writeTimer = null
  }, WRITE_DEBOUNCE_MS)
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  userId: null,
  positions: {},
  hydrated: false,

  hydrate: (userId) => {
    if (get().userId === userId && get().hydrated) return
    const positions = readFromStorage(userId)
    set({ userId, positions, hydrated: true })
  },

  setVesselPosition: (feedId, pos) => {
    const userId = get().userId
    const existing = get().positions[feedId]
    const next = {
      ...get().positions,
      [feedId]: {
        ...existing,
        x: Math.round(pos.x),
        y: Math.round(pos.y),
      },
    }
    set({ positions: next })
    if (userId) scheduleWrite(userId, next)
  },

  setVesselSize: (feedId, size) => {
    const userId = get().userId
    const existing = get().positions[feedId] ?? { x: 0, y: 0 }
    const next = {
      ...get().positions,
      [feedId]: {
        ...existing,
        w: Math.round(size.w),
        h: Math.round(size.h),
      },
    }
    set({ positions: next })
    if (userId) scheduleWrite(userId, next)
  },

  setVesselBrightness: (feedId, brightness) => {
    const userId = get().userId
    const existing = get().positions[feedId] ?? { x: 0, y: 0 }
    const next = {
      ...get().positions,
      [feedId]: { ...existing, brightness },
    }
    set({ positions: next })
    if (userId) scheduleWrite(userId, next)
  },

  setVesselDensity: (feedId, density) => {
    const userId = get().userId
    const existing = get().positions[feedId] ?? { x: 0, y: 0 }
    const next = {
      ...get().positions,
      [feedId]: { ...existing, density },
    }
    set({ positions: next })
    if (userId) scheduleWrite(userId, next)
  },

  setVesselOrientation: (feedId, orientation) => {
    const userId = get().userId
    const existing = get().positions[feedId] ?? { x: 0, y: 0 }
    const next = {
      ...get().positions,
      [feedId]: { ...existing, orientation },
    }
    set({ positions: next })
    if (userId) scheduleWrite(userId, next)
  },

  removeVessel: (feedId) => {
    const userId = get().userId
    if (!(feedId in get().positions)) return
    const next = { ...get().positions }
    delete next[feedId]
    set({ positions: next })
    if (userId) scheduleWrite(userId, next)
  },

  reset: () => {
    const userId = get().userId
    set({ positions: {} })
    if (userId) scheduleWrite(userId, {})
  },
}))

import { create } from 'zustand'

// =============================================================================
// useWorkspace — vessel layout state for the workspace experiment
//
// Slice 5a scope: vessel position only ({x, y} in floor coordinates,
// top-left origin). Resize, brightness, density, rotation arrive in later
// slices and extend this store.
//
// Per WORKSPACE-EXPERIMENT-ADR.md §3, localStorage is the source of truth
// for workspace layout. The store is hydrated from localStorage on first
// authenticated load (keyed by user id) and writes back debounced 200ms.
// No server sync this slice.
// =============================================================================

export interface VesselLayout {
  x: number
  y: number
}

interface WorkspaceState {
  userId: string | null
  positions: Record<string, VesselLayout>
  hydrated: boolean

  hydrate: (userId: string) => void
  setVesselPosition: (feedId: string, pos: VesselLayout) => void
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
    const next = {
      ...get().positions,
      [feedId]: { x: Math.round(pos.x), y: Math.round(pos.y) },
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

import { create } from "zustand";
import { snap } from "../lib/workspace/grid";
import type {
  Brightness,
  Density,
  Orientation,
  TextSize,
} from "../components/workspace/tokens";

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
  x: number;
  y: number;
  w?: number;
  h?: number;
  brightness?: Brightness;
  density?: Density;
  orientation?: Orientation;
  textSize?: TextSize;
  minimized?: boolean;
  hidden?: boolean;
}

interface WorkspaceState {
  userId: string | null;
  positions: Record<string, VesselLayout>;
  hydrated: boolean;

  hydrate: (userId: string) => void;
  setVesselPosition: (feedId: string, pos: { x: number; y: number }) => void;
  setVesselSize: (feedId: string, size: { w: number; h: number }) => void;
  setVesselBrightness: (feedId: string, brightness: Brightness) => void;
  setVesselDensity: (feedId: string, density: Density) => void;
  setVesselOrientation: (feedId: string, orientation: Orientation) => void;
  setVesselTextSize: (feedId: string, textSize: TextSize) => void;
  setVesselMinimized: (feedId: string, minimized: boolean) => void;
  setVesselHidden: (feedId: string, hidden: boolean) => void;
  batchUpdatePositions: (
    updates: Record<string, { x: number; y: number }>,
  ) => void;
  removeVessel: (feedId: string) => void;
  reset: () => void;
}

const STORAGE_PREFIX = "workspace:layout:";
const WRITE_DEBOUNCE_MS = 200;

let writeTimer: ReturnType<typeof setTimeout> | null = null;

function storageKey(userId: string) {
  return `${STORAGE_PREFIX}${userId}`;
}

function readFromStorage(userId: string): Record<string, VesselLayout> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const clean: Record<string, VesselLayout> = {};
    for (const [key, val] of Object.entries(parsed)) {
      const v = val as Record<string, unknown>;
      if (
        v &&
        typeof v === "object" &&
        typeof v.x === "number" &&
        typeof v.y === "number" &&
        Number.isFinite(v.x) &&
        Number.isFinite(v.y)
      )
        clean[key] = v as unknown as VesselLayout;
    }
    return clean;
  } catch {
    return {};
  }
}

function scheduleWrite(
  userId: string,
  positions: Record<string, VesselLayout>,
) {
  if (typeof window === "undefined") return;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try {
      window.localStorage.setItem(
        storageKey(userId),
        JSON.stringify(positions),
      );
    } catch {
      // Quota exceeded / private browsing — silently drop. The UI keeps the
      // in-memory layout; we don't want a write failure to crash the floor.
    }
    writeTimer = null;
  }, WRITE_DEBOUNCE_MS);
}

export const useWorkspace = create<WorkspaceState>((set, get) => {
  function patchVessel(feedId: string, patch: Partial<VesselLayout>) {
    const userId = get().userId;
    const existing = get().positions[feedId] ?? { x: 0, y: 0 };
    const next = {
      ...get().positions,
      [feedId]: { ...existing, ...patch },
    };
    set({ positions: next });
    if (userId) scheduleWrite(userId, next);
  }

  return {
    userId: null,
    positions: {},
    hydrated: false,

    hydrate: (userId) => {
      if (get().userId === userId && get().hydrated) return;
      if (writeTimer) {
        clearTimeout(writeTimer);
        writeTimer = null;
      }
      const positions = readFromStorage(userId);
      set({ userId, positions, hydrated: true });
    },

    setVesselPosition: (feedId, pos) =>
      patchVessel(feedId, { x: snap(pos.x), y: snap(pos.y) }),

    setVesselSize: (feedId, size) =>
      patchVessel(feedId, { w: snap(size.w), h: snap(size.h) }),

    setVesselBrightness: (feedId, brightness) =>
      patchVessel(feedId, { brightness }),

    setVesselDensity: (feedId, density) => patchVessel(feedId, { density }),

    setVesselOrientation: (feedId, orientation) =>
      patchVessel(feedId, { orientation }),

    setVesselTextSize: (feedId, textSize) => patchVessel(feedId, { textSize }),

    setVesselMinimized: (feedId, minimized) =>
      patchVessel(feedId, { minimized }),

    setVesselHidden: (feedId, hidden) => patchVessel(feedId, { hidden }),

    batchUpdatePositions: (updates) => {
      const userId = get().userId;
      const current = get().positions;
      const next = { ...current };
      let changed = false;
      for (const [feedId, pos] of Object.entries(updates)) {
        const existing = next[feedId];
        if (!existing) continue;
        if (existing.x === pos.x && existing.y === pos.y) continue;
        next[feedId] = { ...existing, x: snap(pos.x), y: snap(pos.y) };
        changed = true;
      }
      if (!changed) return;
      set({ positions: next });
      if (userId) scheduleWrite(userId, next);
    },

    removeVessel: (feedId) => {
      const userId = get().userId;
      if (!(feedId in get().positions)) return;
      const next = { ...get().positions };
      delete next[feedId];
      set({ positions: next });
      if (userId) scheduleWrite(userId, next);
    },

    reset: () => {
      const userId = get().userId;
      set({ positions: {} });
      if (userId) scheduleWrite(userId, {});
    },
  };
});

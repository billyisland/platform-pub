import { create } from "zustand";
import {
  snap,
  VESSEL_MIN_W,
  VESSEL_MIN_H,
  VESSEL_DEFAULT_W,
} from "../lib/workspace/grid";
import { repairRestingLayout } from "../lib/workspace/collision";
import {
  normalizeBrightness,
  normalizeDensity,
  type Brightness,
  type Density,
  type Orientation,
  type TextSize,
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
  // LEGACY (MOBILE-LAYOUT-ADR §V): hide moved server-side onto the feed row
  // (feeds.hidden, migration 113). This field is read once on bootstrap to
  // push pre-migration local hides up, then cleared via clearLegacyHidden.
  // Nothing writes it anymore.
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
  // One-time migration sweeper: strip the legacy `hidden` flag from a layout
  // after its value has been pushed to the server (feeds.hidden). Without the
  // clear, a stale local flag would re-hide a feed the user later unhid.
  clearLegacyHidden: (feedId: string) => void;
  // Bootstrap-time reconcile against the authoritative server feed list:
  // prune layouts for feeds that no longer exist (deleted on another device —
  // removeVessel only ever runs locally, so ghosts otherwise persist forever)
  // and heal resting overlaps among the VISIBLE feeds only. Runs here, not at
  // hydrate: the store cannot know hidden/deleted at hydrate time, and a
  // blind heal shelves legal arrangements (a vessel resting over a HIDDEN
  // feed's stored rect is invariant-conforming — hidden feeds are not
  // obstacles).
  reconcileLayouts: (liveIds: string[], visibleIds: string[]) => void;
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
      ) {
        const layout = v as unknown as VesselLayout;
        // Retire stale brightness values ('medium'/'dim') from older builds,
        // and the removed 'full' density (→ 'standard').
        if (layout.brightness !== undefined)
          layout.brightness = normalizeBrightness(layout.brightness);
        if (layout.density !== undefined)
          layout.density = normalizeDensity(layout.density);
        clean[key] = layout;
      }
    }
    return clean;
  } catch {
    return {};
  }
}

// Overlap heal, run from reconcileLayouts once the server feed list is known
// (bootstrap): layouts persisted by the pre-2026-07-21 resolver can hold
// RESTING overlaps — its livelocked waves settled vessels at identical
// coordinates, which renders as one vessel on a floor with no retrieval
// affordance, so the user can never drag the pile apart themselves (they
// cannot see it) and the mover-scoped resolver never revisits it. Only the
// layouts passing `include` (the VISIBLE feeds) participate; hidden feeds'
// stored rects are not on the floor and must neither be moved nor treated as
// obstacles. Size detection is deliberately conservative so a deliberate
// arrangement is never disturbed: stored width is exact and intrinsic width
// is the known default, but intrinsic HEIGHT is content-driven and unknowable
// here, so absent heights are taken at the vessel minimum — any overlap found
// at minimum size is real whatever the content height. Under-detects partial
// overlaps of tall intrinsic vessels; never false-positives on size. Shelving
// (rightward, past everything kept) comes from the collision module's repair
// primitive — this heal is its sole remaining caller now that placement is
// mover-yields.
function healRestingOverlaps(
  positions: Record<string, VesselLayout>,
  include: (id: string) => boolean,
): Record<string, VesselLayout> {
  const rects = Object.entries(positions)
    .filter(([id]) => include(id))
    .map(([id, l]) => ({
      id,
      x: l.x,
      y: l.y,
      w: Math.max(l.w ?? VESSEL_DEFAULT_W, VESSEL_MIN_W),
      h: l.h ?? VESSEL_MIN_H,
    }));
  const repairs = repairRestingLayout(rects);
  if (repairs.size === 0) return positions;
  const next = { ...positions };
  for (const [id, pos] of repairs) {
    next[id] = { ...next[id], x: snap(pos.x), y: snap(pos.y) };
  }
  return next;
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
      // No heal here: at hydrate time the store cannot tell hidden feeds or
      // deleted-elsewhere ghosts from live vessels, and a blind repair
      // shelves legal arrangements. reconcileLayouts (bootstrap, once the
      // server list is in — before anything paints) owns pruning + healing.
      set({ userId, positions: readFromStorage(userId), hydrated: true });
    },

    reconcileLayouts: (liveIds, visibleIds) => {
      const userId = get().userId;
      const positions = get().positions;
      const live = new Set(liveIds);
      let pruned = positions;
      const ghosts = Object.keys(positions).filter((id) => !live.has(id));
      if (ghosts.length > 0) {
        pruned = { ...positions };
        for (const id of ghosts) delete pruned[id];
      }
      const visible = new Set(visibleIds);
      const healed = healRestingOverlaps(pruned, (id) => visible.has(id));
      if (healed === positions) return;
      set({ positions: healed });
      // A repair is a real layout change — persist it so it is once-per-pile,
      // not once-per-session.
      if (userId) scheduleWrite(userId, healed);
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

    clearLegacyHidden: (feedId) => {
      const userId = get().userId;
      const existing = get().positions[feedId];
      if (!existing || existing.hidden === undefined) return;
      const { hidden: _legacy, ...rest } = existing;
      const next = { ...get().positions, [feedId]: rest };
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

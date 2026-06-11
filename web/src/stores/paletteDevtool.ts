import { create } from "zustand";
import {
  applyPaletteOverrides,
  PALETTE_STORAGE_KEY,
} from "../lib/palette/registry";

// =============================================================================
// usePaletteDevtool — TEMPORARY live colour-tuning kit (see lib/palette/
// registry.ts). Holds the per-slug hex overrides, mirrors them to
// localStorage, and pushes them onto :root as inline CSS vars. The panel is
// deliberately NOT a Glasshouse: it floats above everything, leaves the
// backdrop sharp, and never touches any open overlay's state.
// =============================================================================

interface PaletteDevtoolState {
  isOpen: boolean;
  /** slug → '#RRGGBB' for every colour the user has changed. */
  overrides: Record<string, string>;
  open: () => void;
  close: () => void;
  setColor: (slug: string, hex: string) => void;
  resetColor: (slug: string) => void;
  resetAll: () => void;
  /** Load persisted overrides and apply them to :root (called once on mount). */
  hydrate: () => void;
}

function persist(overrides: Record<string, string>) {
  try {
    if (Object.keys(overrides).length === 0)
      localStorage.removeItem(PALETTE_STORAGE_KEY);
    else localStorage.setItem(PALETTE_STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // storage full/blocked — live tuning still works for the session
  }
}

export const usePaletteDevtool = create<PaletteDevtoolState>((set, get) => ({
  isOpen: false,
  overrides: {},
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  setColor: (slug, hex) => {
    const overrides = { ...get().overrides, [slug]: hex };
    applyPaletteOverrides(overrides);
    persist(overrides);
    set({ overrides });
  },
  resetColor: (slug) => {
    const overrides = { ...get().overrides };
    delete overrides[slug];
    applyPaletteOverrides(overrides);
    persist(overrides);
    set({ overrides });
  },
  resetAll: () => {
    applyPaletteOverrides({});
    persist({});
    set({ overrides: {} });
  },
  hydrate: () => {
    try {
      const raw = localStorage.getItem(PALETTE_STORAGE_KEY);
      if (!raw) return;
      const overrides = JSON.parse(raw) as Record<string, string>;
      applyPaletteOverrides(overrides);
      set({ overrides });
    } catch {
      // corrupt blob — ignore, defaults stand
    }
  },
}));

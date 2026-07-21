"use client";

import { create } from "zustand";
import { useEffect } from "react";

// =============================================================================
// Lens suppressors — non-Glasshouse surfaces that cover the workspace.
//
// The resting desktop ∀ disc is a difference lens (FORALL-CUT-AND-LOCKUP-ADR
// §IV): mix-blend-mode composites it against whatever renders beneath. The
// Glasshouse presence registry already flips it to the painted glyph, but a
// covering surface that is NOT a Glasshouse — the bespoke NewFeedPrompt modal
// (z-60 scrim), the LightboxOverlay (z-70) — otherwise leaves the disc
// difference-blended UNDER its scrim: an iridescent negative instead of the
// painted glyph (§0i.5).
//
// These surfaces can't ride the Glasshouse registry: it mirrors the single
// live pane's onClose into the mobile disc-X, which must NOT dismiss a
// lightbox or a naming dialog (they own their own dismiss affordances). So
// they self-declare here instead — a counted set, because the lightbox can
// open over other surfaces. Any FUTURE bespoke full-viewport overlay must call
// useLensSuppressor(open) too; the ADR's painted-state list is kept exhaustive
// against this file.
// =============================================================================

interface LensSuppressState {
  count: number;
  acquire: () => void;
  release: () => void;
}

export const useLensSuppress = create<LensSuppressState>((set) => ({
  count: 0,
  acquire: () => set((s) => ({ count: s.count + 1 })),
  release: () => set((s) => ({ count: Math.max(0, s.count - 1) })),
}));

/** Hold a lens suppression while `active` — release on flip or unmount. */
export function useLensSuppressor(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    useLensSuppress.getState().acquire();
    return () => useLensSuppress.getState().release();
  }, [active]);
}

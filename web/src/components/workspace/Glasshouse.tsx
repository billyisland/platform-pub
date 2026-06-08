"use client";

// =============================================================================
// Glasshouse — the canonical "frosted overlay over the workspace" primitive.
//
// One shape, reused everywhere a surface opens *over* the workspace (the reader
// pane, direct messages, future panels):
//   - a full-viewport frosted scrim (z-[55]) — a slight backdrop blur so the
//     workspace reads as frosted glass behind, click-to-close;
//   - a centred white pane (z-[56]) with the 6px black slab top + elevation
//     shadow, click-through guarded;
//   - Escape closes; body scroll is locked while mounted.
//
// The ForallMenu lives separately at z-60, so it floats CRISP above the frost
// as the sole nav affordance — that crispness is the whole point of the
// pattern and is preserved simply by Glasshouse never reaching z-60.
//
// Glasshouse owns only the chrome. URL-sync / history behaviour (the reader's
// shareable /article·/reader entries) is layered on top by the caller's store,
// not here. Mount it conditionally — it runs its scroll-lock on mount/unmount.
//
// Separation inside the pane is whitespace + the slab rules, per the sitewide
// no-thin-line rule; the 6px slab top and the elevation shadow are not lines.
// =============================================================================

import React, { useEffect } from "react";

interface GlasshouseProps {
  /** Invoked by the scrim, the close button, and Escape. */
  onClose: () => void;
  /** Max width of the centred pane, in px. */
  maxWidth: number;
  /** Accessible label for the pane dialog. */
  ariaLabel?: string;
  children: React.ReactNode;
}

export function Glasshouse({
  onClose,
  maxWidth,
  ariaLabel,
  children,
}: GlasshouseProps) {
  // Escape closes; lock body scroll while the Glasshouse is mounted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <>
      {/* Frosted scrim — full viewport, blur only (no tint, so the ground colour
          is preserved and the ForallMenu disc keeps its contrast), click to
          close. z-[55] sits above the workspace (so it blurs) but below the
          ForallMenu (z-60). */}
      <div
        className="fixed inset-0 z-[55] backdrop-blur-[3px]"
        onClick={onClose}
      />

      {/* Pane wrapper — click outside the pane closes. */}
      <div
        className="fixed inset-0 z-[56] flex items-start justify-center overflow-y-auto"
        onClick={onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={ariaLabel}
          className="relative w-full bg-white my-8 mx-4 shadow-lg"
          style={{ maxWidth, borderTop: "6px solid #111111" }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Close — floats top-right over the pane content. */}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-4 top-4 z-10 text-grey-400 hover:text-black text-lg leading-none"
            style={{ background: "none", border: "none", cursor: "pointer" }}
          >
            ✕
          </button>

          {children}
        </div>
      </div>
    </>
  );
}

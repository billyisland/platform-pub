"use client";

import type { CSSProperties } from "react";
import { NAV_ROW_H } from "./NavRow";

// =============================================================================
// Muster — the row of numbered feed roundels in the desktop nav row.
// NAV-ROW-MUSTER-ADR §IV.
//
// A centred run of one roundel per LIVE feed (hidden included), in numeral
// order. It answers "how many feeds do I have, and where am I among them" as
// ambient chrome (§II.2): it reports state and navigates; it never edits.
//
// CELLS ARE FIXED; DISCS ARE NOT. Each roundel owns a 32px cell (4 GRID: a 24px
// disc plus an 8px gutter). The cell width never changes, so NO ROUNDEL MOVES
// during a pan — the only thing panning changes is which discs are large (§IV,
// principle 3). Size, not position, encodes state; that is what keeps the row
// off the "flicker in the corner of the eye" list.
//
// GLOBAL CHROME, NOT A FEED ISLAND (§IV.4 / §IV dark-mode note). The discs are
// drawn from the row-relative neutral tokens `--ah-ink` / `--ah-bone` /
// `--ah-stone-350` and are NOT islanded like the ∀ disc — so `html.dark`
// inverts ink and bone with the row wholesale, and the mode-neutral stone tone
// stays put. No per-feed colourway ever reaches here.
//
// This is a separate fixed layer over the NavRow band rather than a child of
// NavRow: the state it needs (geometry, pan, the live feed list) lives in
// WorkspaceView, so the muster mounts there beside NavRow, exactly as the ∀
// lockup does via `ForallMenu anchor="row"`. NavRow stays the pure, empty band.
//
// Z-58, mirroring the row and the mobile bar — above the Glasshouse scrim (55)
// and pane (56) so a roundel is clickable over an open pane (§VII); below the ∀
// disc (60). The click closes any open pane before scrolling (§V) — wired in
// WorkspaceView's `onGoTo`.
//
// PHASE 2 (this file): geometry, the three states, fixed cells, click-to-go,
// centring + overflow that clears the lockup. Deferred to Phase 3 (§VIII.3):
// the floating hover-name label (a `title` stands in here), the Explain
// `navRow.muster` label (the container is marked `data-explain-chrome` as the
// conservative default until then), and the full §VII accessibility pass.
// =============================================================================

export type MusterState = "in" | "off" | "minimised";

export interface MusterFeed {
  id: string;
  /** Stable numeral (§III), assigned over the live set — may have gaps. */
  numeral: number;
  /** Descriptive feed name, for the hover title / aria label. May be empty. */
  name: string;
  state: MusterState;
}

// §IV geometry. The cell is fixed at 4 GRID; the disc grows within it.
const CELL = 32;
const DISC_IN = 24;
const DISC_OFF = 18;

// Symmetric side reservation so the centred track never runs under the ∀
// lockup at the row's right end (fixed container at `right: 24`, ~150px wide,
// z-60). Reserving the SAME width on both sides keeps the visual centre on the
// viewport centre while guaranteeing the clearance §IV asks for; past this the
// track scrolls in place. 200 covers the lockup (~174 from the right edge) plus
// a comfortable margin.
const SIDE_RESERVE = 200;

// §IV: 120–160ms ease-out on radius and fill, matching the mobile pip and the
// vessel outline. Size + fill + ring + numeral colour all ride it, so a state
// flip reads as one settle.
const DISC_TRANSITION =
  "width 140ms ease-out, height 140ms ease-out, background-color 140ms ease-out, border-color 140ms ease-out, color 140ms ease-out, font-size 140ms ease-out";

const STATE_LABEL: Record<MusterState, string> = {
  in: "in view",
  off: "off screen",
  minimised: "minimised",
};

function discStyle(state: MusterState): CSSProperties {
  const base: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    borderRadius: "50%",
    padding: 0,
    lineHeight: 1,
    fontWeight: 500,
    cursor: "pointer",
    background: "transparent",
    border: "none",
    transition: DISC_TRANSITION,
  };
  if (state === "in") {
    // 24px solid ink, bone numeral. No ring.
    return {
      ...base,
      width: DISC_IN,
      height: DISC_IN,
      background: "var(--ah-ink)",
      color: "var(--ah-bone)",
      fontSize: 12,
    };
  }
  // Panned off / minimised: 18px hollow disc, a 2px ring (the no-single-pixel
  // floor — never 1.5px, which slips the tripwire — §IV). Ink for on-floor,
  // stone-350 for minimised, so "away" reads as greyed and "present but
  // off-screen" as full ink.
  const tone = state === "minimised" ? "var(--ah-stone-350)" : "var(--ah-ink)";
  return {
    ...base,
    width: DISC_OFF,
    height: DISC_OFF,
    border: `2px solid ${tone}`,
    color: tone,
    fontSize: 11,
  };
}

export function Muster({
  feeds,
  onGoTo,
}: {
  feeds: MusterFeed[];
  onGoTo: (feedId: string) => void;
}) {
  if (feeds.length === 0) return null;

  return (
    // Full-width band overlaying the NavRow ground; only the track inside takes
    // pointer events, so the empty width to either side never eats a click.
    <div
      role="group"
      aria-label="Feeds"
      // Chrome default until the Phase-3 Explain label lands (see header): keeps
      // the annotation walk and focus guard from treating it as annotatable.
      data-explain-chrome=""
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        height: NAV_ROW_H,
        zIndex: 58,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <div
        className="scroll-silent"
        style={{
          display: "flex",
          alignItems: "center",
          // Centred while it fits clear of the lockup; past that it scrolls in
          // place (§IV centring + overflow). scrollbar hidden — a native bar
          // inside the row would draw a banned rule across it.
          maxWidth: `calc(100vw - ${SIDE_RESERVE * 2}px)`,
          overflowX: "auto",
          pointerEvents: "auto",
        }}
      >
        {feeds.map((f) => {
          const label = f.name
            ? `Go to Feed ${f.numeral}: ${f.name} (${STATE_LABEL[f.state]})`
            : `Go to Feed ${f.numeral} (${STATE_LABEL[f.state]})`;
          return (
            <div
              key={f.id}
              style={{
                width: CELL,
                flex: `0 0 ${CELL}px`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <button
                type="button"
                className="focus-ring font-sans"
                aria-label={label}
                // Phase-2 hover stand-in for the §V floating name label.
                title={f.name || `Feed ${f.numeral}`}
                onClick={() => onGoTo(f.id)}
                style={discStyle(f.state)}
              >
                {f.numeral}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

"use client";

import { useState, type CSSProperties } from "react";
import { NAV_ROW_H } from "./NavRow";
import { useExplain } from "../../stores/explain";
import { useAboutOverlay } from "../../stores/aboutOverlay";
import { prefersReducedMotion } from "../../lib/workspace/motion";

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
// PHASE 2: geometry, the three states, fixed cells, click-to-go, centring +
// overflow that clears the lockup.
//
// PHASE 3 (§VIII.3): the floating hover-name label (replacing the `title`
// stand-in), reduced-motion gate on the disc transition, the Explain
// `navRow.muster` label, and the §VII a11y pass (already a labelled group of
// aria-labelled buttons since Phase 2; the click guard below is the addition).
//
// HOW-divergence from §VII, owned: §VII imagined a passive
// `data-explain="navRow.muster"` tag the scrim's hit-test would find. But the
// as-built muster is a SEPARATE fixed layer ABOVE the floor-mode scrim (z-58 >
// 50) with `pointerEvents:auto` on its track — so pointermove over it never
// reaches the scrim and a passive tag is unreachable, exactly as for the ∀ disc
// (also z-60, also above the scrim). So the muster REPORTS ITS OWN HOVER to the
// engine (the disc pattern, ForallMenu.tsx), and the outer band keeps
// `data-explain-chrome` so any look-through path (wheel-forward, hit-test)
// still sees straight past it. A click while Explain is active sheds the
// annotations rather than navigating, mirroring the disc.
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
// flip reads as one settle. Gated off under prefers-reduced-motion (§VIII.3).
const DISC_TRANSITION =
  "width 140ms ease-out, height 140ms ease-out, background-color 140ms ease-out, border-color 140ms ease-out, color 140ms ease-out, font-size 140ms ease-out";

// Hover-name label tokens — the SAME treatment as the vessel's corner roundel
// name label (Vessel.tsx ROUNDEL_TOKENS), so the muster and the vessel speak
// one visual language (§V).
const LABEL_BG = "var(--ah-ink-925)";
const LABEL_FG = "var(--ah-bone)";

const STATE_LABEL: Record<MusterState, string> = {
  in: "in view",
  off: "off screen",
  minimised: "minimised",
};

function discStyle(state: MusterState, reduced: boolean): CSSProperties {
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
    transition: reduced ? undefined : DISC_TRANSITION,
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
  // Which roundel's floating name label is showing (§V). Local hover state,
  // independent of Explain — the name label reads the same whether or not a
  // program is active.
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Explain integration (§VII). The muster sits above the floor-mode scrim, so
  // it reports its own hover to the engine (the ∀-disc pattern) rather than
  // being found by the scrim's hit-test. Floor mode only: pane-mode Explain
  // annotates the pane alone, and About-open renders bubbles below the frost.
  const explainActive = useExplain((s) => s.isActive);
  const explainSurface = useExplain((s) => s.program?.surface);
  const aboutOpen = useAboutOverlay((s) => s.isOpen);
  const reportMusterHover =
    explainActive && explainSurface === "floor" && !aboutOpen;

  const reduced = prefersReducedMotion();

  if (feeds.length === 0) return null;

  return (
    // Full-width band overlaying the NavRow ground; only the track inside takes
    // pointer events, so the empty width to either side never eats a click.
    <div
      role="group"
      aria-label="Feeds"
      // Global chrome, drawn straight through by every look-through path
      // (scrim hit-test, wheel-forward). Explain reaches the muster by its own
      // hover report, not this tag — see the header HOW-divergence note.
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
        // The muster is one Explain subject: report navRow.muster on entering
        // the track, clear on leaving. Per-roundel hover drives only the name
        // label below.
        onMouseEnter={() => {
          if (reportMusterHover)
            useExplain.getState().setHover({ kind: "navRow.muster" });
        }}
        onMouseLeave={() => {
          if (explainActive) useExplain.getState().setHover(null);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          // Centred while it fits clear of the lockup; past that it scrolls in
          // place (§IV centring + overflow). scrollbar hidden — a native bar
          // inside the row would draw a banned rule across it. `max()` floors
          // the track at one cell so a pathologically narrow viewport can never
          // collapse it to a negative width (desktop is ≥768px, so this is
          // belt-and-braces).
          maxWidth: `max(${CELL}px, calc(100vw - ${SIDE_RESERVE * 2}px))`,
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
              onMouseEnter={() => setHoveredId(f.id)}
              onMouseLeave={() =>
                setHoveredId((cur) => (cur === f.id ? null : cur))
              }
              style={{
                position: "relative",
                width: CELL,
                flex: `0 0 ${CELL}px`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {/* §V floating name label — the vessel roundel's treatment,
                  floated ABOVE the disc (the muster sits at the screen's
                  bottom edge). Centred over the disc, pointer-inert. */}
              {f.name && (
                <div
                  className="label-ui"
                  aria-hidden
                  style={{
                    position: "absolute",
                    bottom: "100%",
                    left: "50%",
                    transform: "translateX(-50%)",
                    marginBottom: 6,
                    background: LABEL_BG,
                    color: LABEL_FG,
                    padding: "3px 8px",
                    whiteSpace: "nowrap",
                    boxShadow: "0 2px 6px rgba(0, 0, 0, 0.15)",
                    opacity: hoveredId === f.id ? 1 : 0,
                    pointerEvents: "none",
                    transition: reduced ? undefined : "opacity 120ms ease-out",
                  }}
                >
                  {f.name}
                </div>
              )}
              <button
                type="button"
                className="focus-ring font-sans"
                aria-label={label}
                onClick={() => {
                  // A click while Explain is active sheds the annotations
                  // rather than navigating (the disc's behaviour): the muster
                  // is above the scrim, so its click never reaches the scrim's
                  // own dismiss.
                  if (useExplain.getState().isActive) {
                    useExplain.getState().close();
                    return;
                  }
                  onGoTo(f.id);
                }}
                style={discStyle(f.state, reduced)}
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

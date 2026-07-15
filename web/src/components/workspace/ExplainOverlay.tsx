"use client";

import React, { useCallback } from "react";
import {
  useExplain,
  type Annotation,
  type HoverTarget,
} from "../../stores/explain";
import { useExplainRegistry } from "./ExplainProvider";
import { type ExplainKind, explainCopy } from "../../lib/explain/registry";

// =============================================================================
// ExplainOverlay — the visible engine layer (EXPLAIN-ADR §5, D1, D9, D12).
//
// This slice ships the scrim + pointer routing + hit-testing with a STUB bubble
// (build-plan §3 slice 3). The real bubble renderer — placement, crimson leader,
// live measurement / ResizeObserver invalidation, drag suspension, reduced
// motion — is slice 4 (D11). Nothing opens a program yet (the ∀-menu row is
// slice 5), so this is inert in production until then.
//
// D1 — the floor is inert while active: the scrim is a single full-viewport div
// that intercepts ALL pointer events (wheel/touch included), so the frozen floor
// cannot scroll and the surface is annotated exactly as it stood at open().
//   - pointermove → coordinate hit-test → live hover (D4).
//   - click on a discoverable target → pin it; click anywhere else → dismiss.
// Hit-test sources (D1): (a) `[data-explain]` tagged leaves via elementsFromPoint
// → closest, and (b) the registration Map's live root rects (floor / vessel /
// disc) by element identity.
// =============================================================================

// Marks the overlay's own DOM so hit-testing looks straight through it.
const CHROME_ATTR = "data-explain-chrome";

interface ResolvedTarget extends HoverTarget {
  el: HTMLElement;
}

export function ExplainOverlay() {
  const registry = useExplainRegistry();
  const isActive = useExplain((s) => s.isActive);
  const annotations = useExplain((s) => s.annotations);
  const index = useExplain((s) => s.index);
  const hover = useExplain((s) => s.hover);
  const setHover = useExplain((s) => s.setHover);
  const pin = useExplain((s) => s.pin);
  const close = useExplain((s) => s.close);

  // Resolve the pointer to the most specific explainable target under it.
  // elementsFromPoint returns deepest-painted first, so a tagged leaf (a
  // descendant of its vessel root) is always found before the root — giving
  // leaf > vessel > floor precedence for free.
  const hitTest = useCallback(
    (x: number, y: number): ResolvedTarget | null => {
      if (typeof document === "undefined") return null;
      const roots = registry?.snapshot() ?? [];
      const vessels = roots.filter((r) => r.kind === "vessel");
      const stack = document.elementsFromPoint(x, y) as HTMLElement[];
      for (const el of stack) {
        // Skip our own scrim / bubbles — look through them to the floor.
        if (el.closest(`[${CHROME_ATTR}]`)) continue;
        const tagged = el.closest<HTMLElement>("[data-explain]");
        if (tagged) {
          const kind = tagged.getAttribute("data-explain") as ExplainKind;
          // vessel.* leaves belong to a vessel; card.* leaves carry no key.
          const key = kind.startsWith("vessel.")
            ? vessels.find((v) => v.ref.current?.contains(tagged))?.key
            : undefined;
          return { kind, key, el: tagged };
        }
        // A registered root (floor / vessel / disc) — identity match.
        const root = roots.find((r) => r.ref.current === el);
        if (root) {
          return {
            kind: root.kind,
            key: root.kind === "vessel" ? root.key : undefined,
            el,
          };
        }
      }
      return null;
    },
    [registry],
  );

  // Resolve an annotation's live DOM element for measurement (D11). Roots come
  // from the registry Map; leaves are queried, vessel.* scoped to their vessel.
  const elementFor = useCallback(
    (t: HoverTarget): HTMLElement | null => {
      if (typeof document === "undefined") return null;
      const roots = registry?.snapshot() ?? [];
      if (t.kind === "floor" || t.kind === "disc") {
        return roots.find((r) => r.kind === t.kind)?.ref.current ?? null;
      }
      if (t.kind === "vessel") {
        return (
          roots.find((r) => r.kind === "vessel" && r.key === t.key)?.ref
            .current ?? null
        );
      }
      if (t.kind.startsWith("vessel.") && t.key) {
        const v = roots.find((r) => r.kind === "vessel" && r.key === t.key)?.ref
          .current;
        return (
          v?.querySelector<HTMLElement>(`[data-explain="${t.kind}"]`) ?? null
        );
      }
      return document.querySelector<HTMLElement>(`[data-explain="${t.kind}"]`);
    },
    [registry],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const hit = hitTest(e.clientX, e.clientY);
      const cur = useExplain.getState().hover;
      const next: HoverTarget | null = hit
        ? { kind: hit.kind, key: hit.key }
        : null;
      const changed =
        (cur?.kind ?? null) !== (next?.kind ?? null) ||
        (cur?.key ?? undefined) !== (next?.key ?? undefined);
      if (changed) setHover(next);
    },
    [hitTest, setHover],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const hit = hitTest(e.clientX, e.clientY);
      if (hit) {
        pin({ kind: hit.kind, key: hit.key }); // D1 click-pin
      } else {
        close(); // D1 empty-click dismiss
      }
    },
    [hitTest, pin, close],
  );

  // Copy for a live hover target, folding the vessel provenance fork (D7): read
  // fromStarter off the anchored vessel's registration params.
  const copyForHover = useCallback(
    (t: HoverTarget): string => {
      if (t.kind === "vessel") {
        const roots = registry?.snapshot() ?? [];
        const v = roots.find((r) => r.kind === "vessel" && r.key === t.key);
        return explainCopy("vessel", !!v?.params?.fromStarter);
      }
      return explainCopy(t.kind);
    },
    [registry],
  );

  if (!isActive) return null;

  const pinned: Annotation | null = annotations[index] ?? null;
  const hoverAnn: Annotation | null = hover
    ? { kind: hover.kind, key: hover.key, copy: copyForHover(hover) }
    : null;

  return (
    <>
      {/* Scrim — z-50, flat wash ≤0.18 alpha, no backdrop-filter (D9): feeds
          stay legible behind their own labels. Catches every pointer event so
          the floor is frozen (D1). */}
      <div
        {...{ [CHROME_ATTR]: "" }}
        onPointerMove={handlePointerMove}
        onClick={handleClick}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 50,
          background: "rgb(var(--ah-true-black-rgb) / 0.14)",
          cursor: "default",
        }}
      />
      {pinned && (
        <StubBubble
          annotation={pinned}
          el={elementFor(pinned)}
          dimmed={!!hover}
        />
      )}
      {hoverAnn && (
        <StubBubble annotation={hoverAnn} el={elementFor(hoverAnn)} hover />
      )}
    </>
  );
}

// Placeholder bubble — proves hit-testing + resolution wiring. Slice 4 replaces
// this with the real placement/leader/measurement renderer (D11). Positions to
// the right of the target's live rect, centred when it has no element
// (floor / disc free-float, D8).
function StubBubble({
  annotation,
  el,
  dimmed,
  hover,
}: {
  annotation: Annotation;
  el: HTMLElement | null;
  dimmed?: boolean;
  hover?: boolean;
}) {
  const rect = el?.getBoundingClientRect() ?? null;
  const WIDTH = 260;
  let left: number;
  let top: number;
  if (rect) {
    left = rect.right + 12;
    top = rect.top;
    // Crude viewport clamp; real placement (right→left→below→above) is slice 4.
    if (left + WIDTH > window.innerWidth) left = rect.left - WIDTH - 12;
    if (left < 8) left = 8;
    top = Math.max(8, Math.min(top, window.innerHeight - 120));
  } else {
    left = Math.max(8, window.innerWidth / 2 - WIDTH / 2);
    top = window.innerHeight / 2 - 60;
  }

  const copy = annotation.copy || `[${annotation.kind}]`;

  return (
    <div
      {...{ [CHROME_ATTR]: "" }}
      className="bg-glasshouse text-ui-sm text-black shadow-lg"
      style={{
        position: "fixed",
        left,
        top,
        width: WIDTH,
        zIndex: hover ? 53 : 52,
        padding: "12px 14px",
        borderRadius: 8,
        pointerEvents: "none",
        opacity: dimmed ? 0.4 : 1,
      }}
    >
      {copy}
    </div>
  );
}

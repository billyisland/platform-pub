"use client";

import React from "react";
import type { Density, VesselPalette } from "../workspace/tokens";
import type { PipStatus } from "../../lib/ndk";

// =============================================================================
// PostCard chassis — the shared shell + context for the unified card family.
//
// CardContext mirrors the workspace VesselCard's private context (density /
// palette / bodyPx) so PostCard drops into the ⊔ vessel with no visual change.
// Phase 5 will retire VesselCard's private copy in favour of this module.
//
// Separation rule (CLAUDE.md, absolute sitewide): this shell uses background
// fills + whitespace for spacing — no thin rules or dividers of any kind.
// =============================================================================

export interface CardContext {
  density: Density;
  palette: VesselPalette;
  bodyPx: number; // base reading size; the matrix textScale multiplies this
  dragData?: string;
  // The workspace feed this card is rendered in. Present only on feed surfaces
  // (absent on feedless surfaces like profile overlays / the reader). Drives
  // the feed-derived external Follow affordance (add-to-this-feed).
  feedId?: string;
}

// Pip-panel handoff callback (matches the workspace PipOpen contract).
export type PipOpen = (
  pubkey: string,
  rect: DOMRect,
  status: PipStatus | undefined,
) => void;

export function PostCardShell({
  ctx,
  indentPx,
  gapBelowPx,
  onClick,
  children,
}: {
  ctx: CardContext;
  indentPx: number;
  gapBelowPx: number;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  const padding = ctx.density === "compact" ? "8px 12px" : "16px";
  const draggable = !!ctx.dragData && ctx.density !== "compact";
  return (
    <div
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      draggable={draggable || undefined}
      onDragStart={
        draggable
          ? (e) => {
              e.dataTransfer.setData(
                "application/x-vessel-card",
                ctx.dragData!,
              );
              e.dataTransfer.effectAllowed = "move";
            }
          : undefined
      }
      style={{
        background: ctx.palette.cardBg,
        padding,
        marginLeft: indentPx || undefined,
        marginBottom: gapBelowPx || undefined,
        cursor: onClick ? "pointer" : undefined,
      }}
    >
      {children}
    </div>
  );
}

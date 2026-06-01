"use client";

import React from "react";
import {
  PALETTES,
  TEXT_SIZE_PX,
  DEFAULT_BRIGHTNESS,
  DEFAULT_DENSITY,
  DEFAULT_TEXT_SIZE,
  type Brightness,
  type Density,
} from "./tokens";
import { formatDateRelative } from "../../lib/format";

// =============================================================================
// NewUserVesselCard — the "X joined the platform" interstitial card in the feed.
//
// Extracted from VesselCard.tsx (UNIVERSAL-POST-ADR Phase 5) so it survives that
// file's deletion. It renders in the feed regardless of the card model (before
// the PostCard branch in WorkspaceView), so it is not part of the cutover. The
// minimal shell is inlined here (background + padding) rather than depending on
// VesselCard's CardShell/CompactRow.
// =============================================================================

export interface NewUserItem {
  type: "new_user";
  username: string;
  displayName: string | null;
  avatar: string | null;
  joinedAt: number;
}

export function NewUserVesselCard({
  item,
  density,
  brightness,
}: {
  item: NewUserItem;
  density?: Density;
  brightness?: Brightness;
}) {
  const d = density ?? DEFAULT_DENSITY;
  const palette = PALETTES[brightness ?? DEFAULT_BRIGHTNESS];
  const name = item.displayName ?? item.username ?? "Someone";

  const shellStyle: React.CSSProperties = {
    background: palette.cardBg,
    padding: d === "compact" ? "8px 12px" : "16px",
  };

  if (d === "compact") {
    return (
      <div style={shellStyle}>
        <div
          className="flex items-center gap-2 font-sans text-ui-xs"
          style={{ color: palette.cardTitle }}
        >
          <span className="truncate flex-1">{`${name} joined`}</span>
        </div>
      </div>
    );
  }

  return (
    <div style={shellStyle}>
      <div
        className="flex items-center gap-2 label-ui"
        style={{ color: palette.cardMeta }}
      >
        <span style={{ color: palette.cardTitle }} className="font-medium">
          {name}
        </span>
        <span>·</span>
        <time dateTime={new Date(item.joinedAt * 1000).toISOString()}>
          {formatDateRelative(item.joinedAt)}
        </time>
      </div>
      <p
        className="text-ui-xs leading-[1.45] mt-1.5"
        style={{ color: palette.cardStandfirst }}
      >
        joined the platform
      </p>
    </div>
  );
}

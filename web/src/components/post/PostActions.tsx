"use client";

import React from "react";
import { VoteControls } from "../ui/VoteControls";
import type { Post } from "../../lib/post/types";
import type { VesselPalette } from "../workspace/tokens";

// =============================================================================
// PostActions — the all.haus reaction row (vote / repost / save / report).
//
// §7: the all.haus scoresheet is minted for EVERY THING, so vote/repost/save are
// available at every tier. Native content votes through the existing VoteControls
// (keyed on the nostr event id = post.version). External all.haus reactions ride
// the greenfield POST /post/:postId/react endpoint (ADR §9), not built yet — so
// external repost/save render as quiet placeholder affordances this phase.
//
// haus mode:  "full" → buttons | "numerals-only" (condensed) → tally numeral only
//             | "none" (quoted) → nothing.
// Report is native-only and already gated by resolveSpec (showReport).
// =============================================================================

type HausMode = "full" | "numerals-only" | "none";

const ACTION_CLS =
  "font-mono text-[11px] uppercase tracking-[0.02em] hover:opacity-80";

export function PostActions({
  post,
  haus,
  showReport,
  palette,
  density,
  isOwnContent,
  onReply,
  onReport,
}: {
  post: Post;
  haus: HausMode;
  showReport: boolean;
  palette: VesselPalette;
  density: string;
  isOwnContent?: boolean;
  onReply?: () => void;
  onReport?: () => void;
}) {
  if (density === "compact") return null;
  if (haus === "none") return null;

  if (haus === "numerals-only") {
    const net = post.scoresheet.up - post.scoresheet.down;
    return (
      <span
        className="font-mono text-[11px] uppercase tracking-[0.02em]"
        style={{ color: palette.cardMeta }}
      >
        {net > 0 ? `+${net}` : net}
      </span>
    );
  }

  const native = post.origin.protocol === "nostr" && !!post.author.pubkey;

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="flex items-center gap-3 mt-3 label-ui"
      style={{ color: palette.cardMeta }}
    >
      {native && post.version && (
        <VoteControls
          targetEventId={post.version}
          targetKind={post.type === "article" ? 30023 : 1}
          isOwnContent={!!isOwnContent}
        />
      )}
      {onReply && (
        <button
          type="button"
          onClick={onReply}
          className={ACTION_CLS}
          style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: palette.cardMeta }}
        >
          Reply
        </button>
      )}
      {/* Phase 3: wire repost/save to POST /post/:postId/react (scoresheet). */}
      <button
        type="button"
        disabled
        className="font-mono text-[11px] uppercase tracking-[0.02em] opacity-50"
        style={{ background: "none", border: "none", padding: 0, cursor: "default", color: palette.cardMeta }}
        title="Coming soon"
      >
        Save
      </button>
      {showReport && (
        <button
          type="button"
          onClick={onReport}
          disabled={!onReport}
          className="font-mono text-[11px] uppercase tracking-[0.02em] hover:opacity-80 disabled:opacity-50"
          style={{ background: "none", border: "none", padding: 0, cursor: onReport ? "pointer" : "default", color: palette.cardMeta }}
        >
          Report
        </button>
      )}
    </div>
  );
}

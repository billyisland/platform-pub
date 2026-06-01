"use client";

import React from "react";
import type { Post } from "../../lib/post/types";
import type { VesselPalette } from "../workspace/tokens";

// =============================================================================
// PostCounters — the ORIGIN platform's like/reply/repost tallies (external only).
//
// Read-only this phase: numerals, no interact-back (reply/like to origin is the
// Phase-3 concern, via the linked-account dispatch). The §4 "fresh-on-expand"
// refresh (useLiveEngagement) is also Phase 3 — here we render post.originCounts
// as served. resolveSpec already collapses this to "none" for native (§6) and
// for tiers without origin counters (C/D).
//
//   "static" / "fresh-on-expand" → full row | "inline-numerals" (condensed) → compact
// =============================================================================

type CountersMode = "fresh-on-expand" | "static" | "inline-numerals" | "none";

export function PostCounters({
  post,
  mode,
  palette,
}: {
  post: Post;
  mode: CountersMode;
  palette: VesselPalette;
}) {
  if (mode === "none" || !post.originCounts) return null;
  const { like, reply, repost } = post.originCounts;

  // Match EngagementRow's protocol suppression.
  const proto = post.origin.protocol;
  const hideRepost = proto === "nostr_external" || proto === "rss" || proto === "email";
  const hideLike = proto === "rss" || proto === "email";
  const hideReply = proto === "rss" || proto === "email";

  const parts: string[] = [];
  if (!hideLike && like > 0) parts.push(`♥ ${like}`);
  if (!hideReply && reply > 0) parts.push(`↩ ${reply}`);
  if (!hideRepost && repost > 0) parts.push(`⇄ ${repost}`);
  if (parts.length === 0) return null;

  const inline = mode === "inline-numerals";
  return (
    <div
      className={`font-mono text-[11px] uppercase tracking-[0.02em] ${inline ? "" : "mt-2"} flex items-center gap-3`}
      style={{ color: palette.cardMeta }}
    >
      {parts.map((p) => (
        <span key={p}>{p}</span>
      ))}
    </div>
  );
}

"use client";

import React from "react";
import { resolveSpec } from "../../lib/post/level-spec";
import type { Level, Post } from "../../lib/post/types";
import { PostCardShell, type CardContext, type PipOpen } from "./chassis";
import { PostByline } from "./PostByline";
import { PostBody } from "./PostBody";
import { PostMedia } from "./PostMedia";
import { QuotedEmbed } from "./QuotedEmbed";
import { PostCounters } from "./PostCounters";
import { PostActions } from "./PostActions";
import { PostOriginTag } from "./PostOriginTag";
import type { PostInteractions } from "../../hooks/usePostInteractions";

// =============================================================================
// PostCard — the ONE card. Renders a Post at any §3 level via the §4 matrix.
//
// UNIVERSAL-POST-ADR Phase 2. The level + tier resolve once (resolveSpec) into a
// flat spec; the dumb leaf components each receive resolved values, never the raw
// level/tier — so a Post renders identically across levels except the matrix
// deltas (text scale, indent, gap, gated affordances).
//
// This phase is RENDER-ONLY: the click callbacks are wired but the workspace
// swap (Phase-2 commit 6) mounts only level="feed" and delegates expand to the
// legacy path; thread re-root is Phase 3, the reader pane is Phase R.
// =============================================================================

// Smallest text we will render after the matrix textScale (min base 11.5 × 0.85
// ≈ 9.8); floor keeps the deepest levels legible.
const READABILITY_FLOOR_PX = 10.5;

export function PostCard({
  post,
  level,
  ctx,
  onPipOpen,
  onReply,
  onQuote,
  onReport,
  onExpand,
  onCollapse,
  onReroot,
  onOpenReader,
  isOwnContent,
  interactions,
  header,
  footer,
}: {
  post: Post;
  level: Level;
  ctx: CardContext;
  onPipOpen?: PipOpen;
  onReply?: () => void;
  onQuote?: () => void;
  onReport?: () => void;
  onExpand?: (post: Post) => void;
  onCollapse?: (post: Post) => void;
  onReroot?: (post: Post) => void;
  onOpenReader?: (post: Post) => void;
  isOwnContent?: boolean;
  // External interact-back (usePostInteractions), supplied by PostCardInteractive
  // when the card is interactive. Absent ⇒ read-only counters + read-only poll.
  interactions?: PostInteractions;
  // Slots rendered inside the shell: `header` above the byline (parent-context
  // tile), `footer` below the actions (inline reply box). Owned by the container.
  header?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const spec = resolveSpec(level, post.biddabilityTier, post);
  const bodyPx = Math.max(
    Math.round(ctx.bodyPx * spec.textScale * 10) / 10,
    READABILITY_FLOOR_PX,
  );

  const pollVote = interactions
    ? {
        canVote: interactions.canVote,
        voting: interactions.pollVoting,
        onVote: interactions.onPollVote,
      }
    : undefined;

  const onClick = (() => {
    switch (spec.click) {
      case "expand-focal":
        return onExpand ? () => onExpand(post) : undefined;
      case "collapse":
        return onCollapse ? () => onCollapse(post) : undefined;
      case "reroot-focal":
        return onReroot ? () => onReroot(post) : undefined;
      case "reader-pane":
        return onOpenReader ? () => onOpenReader(post) : undefined;
      case "none":
      default:
        return undefined;
    }
  })();

  // Quoted is laid out inside its host's container — no shell, no own indent/gap.
  if (spec.insideHost) {
    return (
      <div style={{ cursor: onClick ? "pointer" : undefined }} onClick={onClick}>
        <PostByline post={post} palette={ctx.palette} bylineProfile={spec.bylineProfile} onPipOpen={onPipOpen} />
        <PostBody post={post} bodyPx={bodyPx} mode={spec.body} palette={ctx.palette} />
        <PostMedia post={post} mode={spec.media} video={spec.video} palette={ctx.palette} density={ctx.density} />
      </div>
    );
  }

  return (
    <PostCardShell ctx={ctx} indentPx={spec.indentPx} gapBelowPx={spec.gapBelowPx} onClick={onClick}>
      {header}
      <PostByline post={post} palette={ctx.palette} bylineProfile={spec.bylineProfile} onPipOpen={onPipOpen} />
      <PostBody post={post} bodyPx={bodyPx} mode={spec.body} palette={ctx.palette} pollVote={pollVote} />
      <PostMedia post={post} mode={spec.media} video={spec.video} palette={ctx.palette} density={ctx.density} />
      <QuotedEmbed post={post} mode={spec.quoteEmbed} palette={ctx.palette} />
      <PostCounters post={post} mode={spec.originCounters} palette={ctx.palette} interactions={interactions} />
      <PostActions
        post={post}
        haus={spec.haus}
        showReport={spec.showReport}
        palette={ctx.palette}
        density={ctx.density}
        isOwnContent={isOwnContent}
        onReply={onReply}
        onQuote={onQuote}
        onReport={onReport}
      />
      {spec.showOriginTag && (
        <PostOriginTag post={post} palette={ctx.palette} sourceOnly={spec.originTagSourceOnly} />
      )}
      {footer}
    </PostCardShell>
  );
}

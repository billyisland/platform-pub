"use client";

import React from "react";
import { QuotedPostTile } from "../workspace/QuotedPostTile";
import { truncateText } from "../../lib/format";
import type { Post } from "../../lib/post/types";
import type { VesselPalette } from "../workspace/tokens";

// =============================================================================
// QuotedEmbed — the depth-1 quoted post (§4 quote-embed row).
//
//   "full-child" (focal) → rendered as "mini" THIS PHASE. The §4.1 promotion to
//        a full feed-level child needs the /thread quote resolution (Phase 3);
//        documented scope cut.
//   "mini" (feed/parent/reply) → quoted-level mini (byline + body only).
//   "stub" / "none" (quoted/condensed) → a "quoted a post →" stub, or nothing.
//
// External quotes hydrate async via QuotedPostTile (keyed on the host item id).
// Native quotes render from the inline quotedPreview the adapter carries.
// =============================================================================

type QuoteMode = "full-child" | "mini" | "stub" | "none";

export function QuotedEmbed({
  post,
  mode,
  palette,
}: {
  post: Post;
  mode: QuoteMode;
  palette: VesselPalette;
}) {
  if (mode === "none" || !post.quotes) return null;

  if (mode === "stub") {
    return (
      <button
        type="button"
        onClick={(e) => e.stopPropagation() /* Phase 3: re-root onto the quoted post */}
        className="font-mono text-[11px] uppercase tracking-[0.06em] mt-2 hover:opacity-80"
        style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: palette.cardMeta }}
      >
        Quoted a post →
      </button>
    );
  }

  // External: async tile by the host item id (full-child folds to mini this phase).
  const native = post.origin.protocol === "nostr" && !!post.author.pubkey;
  if (!native) {
    if (!post.feedItemId) return null;
    return <QuotedPostTile itemId={post.feedItemId} palette={palette} />;
  }

  // Native: render the inline preview as a quoted-level mini.
  const preview = post.quotedPreview;
  if (!preview || (!preview.title && !preview.excerpt)) {
    return (
      <button
        type="button"
        onClick={(e) => e.stopPropagation()}
        className="font-mono text-[11px] uppercase tracking-[0.06em] mt-2 hover:opacity-80"
        style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: palette.cardMeta }}
      >
        Quoted a post →
      </button>
    );
  }

  // Byline reads "Author · SOURCE" for an external quote (migration 102); native
  // quotes carry no source.
  const byline = [preview.author, preview.source].filter(Boolean).join(" · ");

  const inner = (
    <>
      {byline && (
        <div
          className="font-mono text-[11px] uppercase tracking-[0.06em]"
          style={{ color: palette.cardMeta }}
        >
          {byline}
        </div>
      )}
      {preview.title && (
        <div className="font-serif" style={{ color: palette.cardTitle, fontSize: 14, marginTop: 2 }}>
          {preview.title}
        </div>
      )}
      {preview.excerpt && (
        <div
          style={{ color: palette.cardStandfirst, fontSize: 13, lineHeight: 1.5, marginTop: 2 }}
        >
          {truncateText(preview.excerpt, 160)}
        </div>
      )}
    </>
  );

  // External quote with a permalink → the tile links out to the origin (the one
  // sanctioned route to the source platform). Click must not bubble to the card.
  if (preview.url) {
    return (
      <a
        href={preview.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="mt-2 block hover:opacity-90"
        style={{ background: palette.interior, padding: "10px 12px" }}
      >
        {inner}
      </a>
    );
  }

  return (
    <div
      className="mt-2"
      style={{ background: palette.interior, padding: "10px 12px" }}
    >
      {inner}
    </div>
  );
}

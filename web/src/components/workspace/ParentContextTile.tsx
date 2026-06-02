"use client";

import { useEffect, useState } from "react";
import { externalItems, type ParentItem } from "../../lib/api/feeds";
import { truncateText } from "../../lib/format";
import { type VesselPalette, TEXT_SIZE_PX, DEFAULT_TEXT_SIZE } from "./tokens";
import { Byline } from "./Byline";

interface Props {
  itemId: string;
  palette: VesselPalette;
  // Reading-content size in px, inherited from the host card so the parent body
  // renders at the same size. Defaults to the standard step.
  bodyPx?: number;
  // The author of the card hosting this tile. When the fetched parent is the
  // same author (a self-thread), the tile is suppressed so each post stands
  // alone rather than reading as one merged card.
  selfAuthor?: { handle?: string; name?: string };
}

// Module-level cache keyed by itemId
const cache = new Map<
  string,
  {
    parent: ParentItem | null;
    grandparentTag: { authorName: string; authorHandle: string } | null;
  }
>();

export function ParentContextTile({
  itemId,
  palette,
  bodyPx = TEXT_SIZE_PX[DEFAULT_TEXT_SIZE],
  selfAuthor,
}: Props) {
  const [parent, setParent] = useState<ParentItem | null>(
    cache.get(itemId)?.parent ?? null,
  );
  const [grandparentTag, setGrandparentTag] = useState<{
    authorName: string;
    authorHandle: string;
  } | null>(cache.get(itemId)?.grandparentTag ?? null);
  const [loading, setLoading] = useState(!cache.has(itemId));

  useEffect(() => {
    if (cache.has(itemId)) return;

    externalItems
      .parent(itemId)
      .then((res) => {
        cache.set(itemId, {
          parent: res.parent,
          grandparentTag: res.grandparentTag,
        });
        setParent(res.parent);
        setGrandparentTag(res.grandparentTag);
      })
      .catch(() => {
        cache.set(itemId, { parent: null, grandparentTag: null });
      })
      .finally(() => setLoading(false));
  }, [itemId]);

  if (loading) {
    return (
      <div className="mb-3 animate-pulse" style={{ opacity: 0.4 }}>
        <div
          className="h-3 rounded mb-2"
          style={{ width: "40%", background: palette.cardMeta }}
        />
        <div
          className="h-3 rounded"
          style={{ width: "80%", background: palette.cardMeta }}
        />
      </div>
    );
  }

  if (!parent) return null;

  // Suppress the inline parent for self-threads: when the parent shares the
  // host card's author, the parent already stands as its own feed item, so the
  // tile is redundant and visually merges the two posts. Prefer a handle match;
  // fall back to a case-insensitive name match when handles are absent.
  if (selfAuthor) {
    const handleMatch =
      !!selfAuthor.handle &&
      !!parent.authorHandle &&
      selfAuthor.handle === parent.authorHandle;
    const nameMatch =
      !selfAuthor.handle &&
      !parent.authorHandle &&
      !!selfAuthor.name &&
      !!parent.authorName &&
      selfAuthor.name.toLowerCase() === parent.authorName.toLowerCase();
    if (handleMatch || nameMatch) return null;
  }

  const name = parent.authorName || parent.authorHandle || "Unknown";
  const body = parent.contentHtml || parent.contentText;

  return (
    <div className="mb-6">
      {grandparentTag && (
        <div
          className="font-mono text-[11px] uppercase tracking-[0.06em] mb-1"
          style={{ color: palette.cardMeta }}
        >
          → REPLYING TO @{grandparentTag.authorHandle}
        </div>
      )}
      <Byline
        name={name}
        publishedAt={parent.publishedAt}
        palette={palette}
        className="mb-1"
      />
      {body && (
        <div
          className="[&_p]:mb-2"
          style={{
            color: palette.cardTitle,
            fontSize: bodyPx,
            lineHeight: 1.5,
          }}
          dangerouslySetInnerHTML={
            parent.contentHtml ? { __html: parent.contentHtml } : undefined
          }
        >
          {!parent.contentHtml ? truncateText(body, 300) : undefined}
        </div>
      )}
      <EngagementMini
        likeCount={parent.likeCount}
        replyCount={parent.replyCount}
        repostCount={parent.repostCount}
        palette={palette}
      />
    </div>
  );
}

function EngagementMini({
  likeCount,
  replyCount,
  repostCount,
  palette,
}: {
  likeCount: number;
  replyCount: number;
  repostCount: number;
  palette: VesselPalette;
}) {
  if (likeCount === 0 && replyCount === 0 && repostCount === 0) return null;
  return (
    <div
      className="flex items-center gap-3 mt-1 font-mono text-[10px] uppercase tracking-[0.02em]"
      style={{ color: palette.cardMeta }}
    >
      {likeCount > 0 && (
        <span className="flex items-center gap-1">
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
          </svg>
          {likeCount}
        </span>
      )}
      {replyCount > 0 && (
        <span className="flex items-center gap-1">
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          {replyCount}
        </span>
      )}
      {repostCount > 0 && (
        <span className="flex items-center gap-1">
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="17 1 21 5 17 9" />
            <path d="M3 11V9a4 4 0 0 1 4-4h14" />
            <polyline points="7 23 3 19 7 15" />
            <path d="M21 13v2a4 4 0 0 1-4 4H3" />
          </svg>
          {repostCount}
        </span>
      )}
    </div>
  );
}

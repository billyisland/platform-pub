"use client";

import { useState } from "react";
import type { ReplyGroupItem, ExternalFeedItem } from "../../lib/ndk";
import type { ExternalThreadEntry } from "../../lib/api/feeds";
import {
  type Brightness,
  type Density,
  type TextSize,
  paletteFor,
  DEFAULT_DENSITY,
  DEFAULT_TEXT_SIZE,
  TEXT_SIZE_PX,
} from "./tokens";
import { ParentContextTile } from "./ParentContextTile";
import { ExternalPlayscriptEntry } from "./ExternalPlayscriptEntry";

const INITIAL_VISIBLE = 5;

interface Props {
  group: ReplyGroupItem;
  density?: Density;
  brightness?: Brightness;
  textSize?: TextSize;
}

function externalToEntry(ext: ExternalFeedItem): ExternalThreadEntry {
  return {
    id: ext.id,
    authorName: ext.authorName ?? "",
    authorHandle: ext.authorHandle ?? "",
    authorUri: ext.authorUri ?? "",
    contentHtml: ext.contentHtml ?? "",
    contentText: ext.contentText ?? "",
    publishedAt: new Date(ext.publishedAt * 1000).toISOString(),
    likeCount: ext.likeCount ?? 0,
    replyCount: ext.replyCount ?? 0,
    repostCount: ext.repostCount ?? 0,
    parentId: null,
    protocol: ext.sourceProtocol,
  };
}

export function ReplyGroupCard({
  group,
  density,
  brightness,
  textSize,
}: Props) {
  const palette = paletteFor(brightness);
  const d = density ?? DEFAULT_DENSITY;
  const bodyPx = TEXT_SIZE_PX[textSize ?? DEFAULT_TEXT_SIZE];
  const [showAll, setShowAll] = useState(false);

  if (d === "compact") {
    const authorName =
      group.replies[0]?.authorName ??
      group.replies[0]?.authorHandle ??
      "Unknown";
    return (
      <div style={{ background: palette.cardBg, padding: "8px 12px" }}>
        <div
          className="font-mono text-[11px] uppercase tracking-[0.06em] truncate"
          style={{ color: palette.cardMeta }}
        >
          {group.replies.length} replies · {authorName} and others
        </div>
      </div>
    );
  }

  const entries = group.replies.map(externalToEntry);
  const visible =
    showAll || entries.length <= INITIAL_VISIBLE
      ? entries
      : entries.slice(0, INITIAL_VISIBLE);
  const hiddenCount = entries.length - visible.length;

  return (
    <div
      style={{
        background: palette.cardBg,
        padding: "16px",
        borderLeft: "4px solid #BBBBBB",
        paddingLeft: "24px",
      }}
    >
      <ParentContextTile
        itemId={group.replies[0].id}
        palette={palette}
        bodyPx={bodyPx}
      />

      <div
        className="font-mono text-[11px] uppercase tracking-[0.06em] mb-3"
        style={{ color: palette.cardMeta }}
      >
        {group.replies.length} replies
      </div>

      <ol className="space-y-[24px]">
        {visible.map((entry) => (
          <li key={entry.id}>
            <ExternalPlayscriptEntry
              entry={entry}
              replyingTo={null}
              palette={palette}
              bodyPx={bodyPx}
            />
          </li>
        ))}
      </ol>

      {hiddenCount > 0 && (
        <button
          onClick={() => setShowAll(true)}
          className="mt-4 label-ui text-grey-400 hover:text-black hover:underline transition-colors"
        >
          Show {hiddenCount} more {hiddenCount === 1 ? "reply" : "replies"}
        </button>
      )}
    </div>
  );
}

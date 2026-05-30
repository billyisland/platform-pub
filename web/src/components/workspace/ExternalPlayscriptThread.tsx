"use client";

import { useState } from "react";
import type { ExternalThreadEntry } from "../../lib/api/feeds";
import type { LinkedAccount } from "../../lib/api/linked-accounts";
import type { VesselPalette } from "./tokens";
import { ExternalPlayscriptEntry } from "./ExternalPlayscriptEntry";
import { InlineReplyBox } from "./InlineReplyBox";

const INITIAL_VISIBLE = 10;

interface Props {
  ancestors: ExternalThreadEntry[];
  descendants: ExternalThreadEntry[];
  palette: VesselPalette;
  itemId: string;
  protocol: string;
  linkedAccount: LinkedAccount | null;
  // Reading-content size in px, inherited from the host card.
  bodyPx?: number;
  // Internal all.haus byline destination for thread entries (the expanded
  // item's source surface).
  sourceHref?: string;
}

export function ExternalPlayscriptThread({
  ancestors,
  descendants,
  palette,
  itemId,
  protocol,
  linkedAccount,
  bodyPx,
  sourceHref,
}: Props) {
  const [showAll, setShowAll] = useState(false);
  const [replyingToId, setReplyingToId] = useState<string | null>(null);

  const allEntries = [...ancestors, ...descendants];
  if (allEntries.length === 0) return null;

  // Build id→entry map for parent lookup
  const byId = new Map<string, ExternalThreadEntry>();
  for (const e of allEntries) byId.set(e.id, e);

  // Determine replyingTo for each entry: only show arrow when parent
  // is not the immediately preceding entry in the list
  const withContext = allEntries.map((entry, i) => {
    let replyingTo: { name: string } | null = null;
    if (entry.parentId) {
      const prev = i > 0 ? allEntries[i - 1] : null;
      if (!prev || prev.id !== entry.parentId) {
        const parent = byId.get(entry.parentId);
        if (parent) {
          replyingTo = { name: parent.authorName || parent.authorHandle };
        }
      }
    }
    return { entry, replyingTo };
  });

  const visibleEntries =
    showAll || withContext.length <= INITIAL_VISIBLE
      ? withContext
      : withContext.slice(0, INITIAL_VISIBLE);
  const hiddenCount = withContext.length - visibleEntries.length;

  return (
    <div className="ml-8">
      <ol className="space-y-[32px]">
        {visibleEntries.map(({ entry, replyingTo }) => (
          <li key={entry.id}>
            <ExternalPlayscriptEntry
              entry={entry}
              replyingTo={replyingTo}
              palette={palette}
              bodyPx={bodyPx}
              sourceHref={sourceHref}
              onReply={() =>
                setReplyingToId(replyingToId === entry.id ? null : entry.id)
              }
              replyActive={replyingToId === entry.id}
            />
            {replyingToId === entry.id && (
              <InlineReplyBox
                itemId={itemId}
                protocol={protocol}
                linkedAccount={linkedAccount}
                onClose={() => setReplyingToId(null)}
                onReplied={() => setReplyingToId(null)}
              />
            )}
          </li>
        ))}
      </ol>

      {hiddenCount > 0 && (
        <button
          onClick={() => setShowAll(true)}
          className="mt-[32px] label-ui text-grey-400 hover:text-black hover:underline transition-colors"
        >
          Show {hiddenCount} more {hiddenCount === 1 ? "reply" : "replies"}
        </button>
      )}
    </div>
  );
}

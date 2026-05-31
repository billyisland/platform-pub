"use client";

import type { ExternalThreadEntry } from "../../lib/api/feeds";
import type { VesselPalette } from "./tokens";
import { ExternalPlayscriptEntry } from "./ExternalPlayscriptEntry";

interface Props {
  // Ancestor chain (root-first) of the focal external item, as returned by
  // GET /external-items/:id/thread. Rendered ABOVE the focal card content so the
  // conversation reads top-down: oldest parent → … → the post you opened.
  ancestors: ExternalThreadEntry[];
  palette: VesselPalette;
  bodyPx?: number;
  // Re-roots the conversation onto the clicked ancestor. When provided, entries
  // become clickable; when absent they render as static context.
  onEntryClick?: (entry: ExternalThreadEntry) => void;
}

export function ExternalAncestorRail({
  ancestors,
  palette,
  bodyPx,
  onEntryClick,
}: Props) {
  if (ancestors.length === 0) return null;

  // Dedupe by id so a malformed ancestor chain (e.g. a cycle from the source)
  // can't collide on the React `key` (L4 parity).
  const seenIds = new Set<string>();
  const chain = ancestors.filter((e) => {
    if (seenIds.has(e.id)) return false;
    seenIds.add(e.id);
    return true;
  });

  const byId = new Map<string, ExternalThreadEntry>();
  for (const e of chain) byId.set(e.id, e);

  return (
    <div className="mb-6 ml-8">
      <ol className="space-y-[32px]">
        {chain.map((entry, i) => {
          // Annotate a non-adjacent parent the same way the descendant
          // playscript does.
          let replyingTo: { name: string } | null = null;
          if (entry.parentId) {
            const prev = i > 0 ? chain[i - 1] : null;
            if (!prev || prev.id !== entry.parentId) {
              const parent = byId.get(entry.parentId);
              if (parent) {
                replyingTo = { name: parent.authorName || parent.authorHandle };
              }
            }
          }
          return (
            <li key={entry.id}>
              <ExternalPlayscriptEntry
                entry={entry}
                replyingTo={replyingTo}
                palette={palette}
                bodyPx={bodyPx}
                onEntryClick={onEntryClick}
              />
            </li>
          );
        })}
      </ol>
    </div>
  );
}

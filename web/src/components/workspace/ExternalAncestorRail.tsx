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
  sourceHref?: string;
}

export function ExternalAncestorRail({
  ancestors,
  palette,
  bodyPx,
  sourceHref,
}: Props) {
  if (ancestors.length === 0) return null;

  const byId = new Map<string, ExternalThreadEntry>();
  for (const e of ancestors) byId.set(e.id, e);

  return (
    <div
      className="mb-3 pb-3 ml-8"
      style={{ borderBottom: `1px solid ${palette.cardMeta}33` }}
    >
      <ol className="space-y-[32px]">
        {ancestors.map((entry, i) => {
          // Annotate a non-adjacent parent the same way the descendant
          // playscript does.
          let replyingTo: { name: string } | null = null;
          if (entry.parentId) {
            const prev = i > 0 ? ancestors[i - 1] : null;
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
                sourceHref={sourceHref}
              />
            </li>
          );
        })}
      </ol>
    </div>
  );
}

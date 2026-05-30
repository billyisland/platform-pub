"use client";

import type { ExternalThreadEntry } from "../../lib/api/feeds";
import type { VesselPalette } from "./tokens";
import { TEXT_SIZE_PX, DEFAULT_TEXT_SIZE } from "./tokens";
import { Byline } from "./Byline";

interface Props {
  entry: ExternalThreadEntry;
  replyingTo: { name: string } | null;
  palette: VesselPalette;
  onReply?: () => void;
  replyActive?: boolean;
  // Reading-content size in px, inherited from the host card.
  bodyPx?: number;
  // Internal all.haus destination for the speaker's byline (the expanded
  // item's source surface). When absent, the byline renders as plain text —
  // we never link out to the native (Bluesky/Mastodon/…) profile.
  sourceHref?: string;
}

export function ExternalPlayscriptEntry({
  entry,
  replyingTo,
  palette,
  onReply,
  replyActive,
  bodyPx = TEXT_SIZE_PX[DEFAULT_TEXT_SIZE],
  sourceHref,
}: Props) {
  // Reply bylines match main-card bylines (task 9b): the shared Byline carries
  // name · time; the non-adjacent-parent "→ NAME" affordance rides as
  // `replyingTo`. The bold-`Name:` playscript convention is dropped.
  const publishedAtUnix = Math.floor(
    new Date(entry.publishedAt).getTime() / 1000,
  );
  return (
    <div className="group relative">
      <Byline
        name={entry.authorName || entry.authorHandle}
        nameHref={sourceHref}
        publishedAt={publishedAtUnix}
        replyingTo={replyingTo}
        palette={palette}
        className="mb-1"
      />

      {/* Dialogue line */}
      <div className="mt-1">
        {entry.contentHtml ? (
          <div
            className="font-sans [&_p]:mb-2 [&_p:last-child]:mb-0 [&_a]:underline"
            style={{ color: palette.cardTitle, fontSize: bodyPx, lineHeight: 1.5 }}
            dangerouslySetInnerHTML={{ __html: entry.contentHtml }}
          />
        ) : (
          <p
            className="font-sans whitespace-pre-wrap"
            style={{ color: palette.cardTitle, fontSize: bodyPx, lineHeight: 1.5 }}
          >
            {entry.contentText}
          </p>
        )}
      </div>

      {/* Action row: Reply (timestamp now lives in the byline) */}
      <div className="mt-2 flex items-center gap-4 font-mono text-[11px] uppercase tracking-[0.02em] text-grey-400">
        {onReply ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onReply();
            }}
            className={`hover:text-black transition-colors ${replyActive ? "text-black" : ""}`}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
            }}
          >
            Reply
          </button>
        ) : (
          <span>Reply</span>
        )}
      </div>
    </div>
  );
}

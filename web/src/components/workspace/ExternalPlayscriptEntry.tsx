"use client";

import Link from "next/link";
import type { ExternalThreadEntry } from "../../lib/api/feeds";
import type { VesselPalette } from "./tokens";

interface Props {
  entry: ExternalThreadEntry;
  replyingTo: { name: string } | null;
  palette: VesselPalette;
  onReply?: () => void;
  replyActive?: boolean;
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
  sourceHref,
}: Props) {
  return (
    <div className="group relative">
      {/* Speaker line */}
      <div className="label-ui text-grey-600 flex items-center gap-[6px]">
        {replyingTo && (
          <>
            <span className="text-grey-400">&rarr;</span>
            <span className="font-sans font-bold text-grey-400">
              {replyingTo.name}
            </span>
            <span className="text-grey-400">:</span>
            <span
              aria-hidden="true"
              style={{ display: "inline-block", width: "16px" }}
            />
          </>
        )}
        {sourceHref ? (
          <Link
            href={sourceHref}
            onClick={(e) => e.stopPropagation()}
            className="font-sans font-bold hover:underline"
            style={{ color: palette.cardTitle }}
          >
            {entry.authorName || entry.authorHandle}:
          </Link>
        ) : (
          <span
            className="font-sans font-bold"
            style={{ color: palette.cardTitle }}
          >
            {entry.authorName || entry.authorHandle}:
          </span>
        )}
      </div>

      {/* Dialogue line */}
      <div className="mt-1">
        {entry.contentHtml ? (
          <div
            className="font-sans text-[14.5px] leading-[1.55] [&_p]:mb-2 [&_p:last-child]:mb-0 [&_a]:underline"
            style={{ color: palette.cardTitle }}
            dangerouslySetInnerHTML={{ __html: entry.contentHtml }}
          />
        ) : (
          <p
            className="font-sans text-[14.5px] leading-[1.55] whitespace-pre-wrap"
            style={{ color: palette.cardTitle }}
          >
            {entry.contentText}
          </p>
        )}
      </div>

      {/* Action row: timestamp + Reply */}
      <div className="mt-2 flex items-center gap-4 font-mono text-[11px] uppercase tracking-[0.02em] text-grey-400">
        <time dateTime={entry.publishedAt}>
          {formatRelativeTime(entry.publishedAt)}
        </time>
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

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return "NOW";
  if (diffMins < 60) return `${diffMins}M`;
  if (diffHours < 24) return `${diffHours}H`;
  if (diffDays === 1) return "1D";
  if (diffDays < 7) return `${diffDays}D`;

  return date
    .toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    })
    .toUpperCase();
}

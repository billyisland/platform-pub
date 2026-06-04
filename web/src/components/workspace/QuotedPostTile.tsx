"use client";

import React, { useEffect, useState } from "react";
import { externalItems, type ParentItem } from "../../lib/api/feeds";
import { formatDateRelative, truncateText } from "../../lib/format";
import type { VesselPalette } from "./tokens";

interface Props {
  itemId: string;
  palette: VesselPalette;
  // When set, the tile is clickable and re-roots the thread onto the quoted
  // post (the host wires this to thread.reroot). Absent ⇒ static tile.
  onOpen?: () => void;
}

// Shape of the quoted post's own media (mirrors the feed media array). ParentItem
// types media as unknown[]; we narrow it here for rendering.
interface QuoteMedia {
  type: "image" | "video" | "audio" | "link";
  url: string;
  thumbnail?: string;
  alt?: string;
  title?: string;
  description?: string;
}

// Module-level cache keyed by itemId — survives card collapse/expand cycles.
const cache = new Map<string, ParentItem | null>();

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// A quote post embeds another post. We render that quoted post as a nested
// mini-card in our own idiom — QUOTING label, mono-caps byline, content, and the
// quoted post's own media — so a Bluesky/Mastodon quote reads here the way it
// does there. The author is plain text, never a link out to the origin platform
// (the quoted author may not be a subscribed source, so we don't fabricate an
// internal /source link either; CARD-BEHAVIOUR-ADR byline-routing rule).
export function QuotedPostTile({ itemId, palette, onOpen }: Props) {
  const [quote, setQuote] = useState<ParentItem | null>(
    cache.get(itemId) ?? null,
  );
  const [loading, setLoading] = useState(!cache.has(itemId));

  useEffect(() => {
    if (cache.has(itemId)) return;

    externalItems
      .quote(itemId)
      .then((res) => {
        cache.set(itemId, res.quote);
        setQuote(res.quote);
      })
      .catch(() => {
        cache.set(itemId, null);
      })
      .finally(() => setLoading(false));
  }, [itemId]);

  if (loading) {
    return (
      <div
        className="mt-2.5 mb-1.5 animate-pulse p-2.5"
        style={{ opacity: 0.4, background: palette.interior }}
      >
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

  if (!quote) return null;

  const name = quote.authorName || quote.authorHandle || "Unknown";
  const timestamp = formatDateRelative(quote.publishedAt);
  const body = quote.contentHtml || quote.contentText;
  const media = (quote.media ?? []) as QuoteMedia[];
  const image = media.find((m) => m.type === "image");
  const link = media.find((m) => m.type === "link" && m.url);

  return (
    <div
      className={`mt-2.5 mb-1.5 p-2.5${onOpen ? " cursor-pointer hover:opacity-90" : ""}`}
      style={{ background: palette.interior }}
      {...(onOpen
        ? {
            role: "button" as const,
            tabIndex: 0,
            "aria-label": `Open quoted post by ${name}`,
            onClick: (e: React.MouseEvent) => {
              e.stopPropagation();
              onOpen();
            },
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onOpen();
              }
            },
          }
        : {})}
    >
      <div
        className="font-mono text-[10px] uppercase tracking-[0.06em] mb-1.5"
        style={{ color: palette.cardMeta }}
      >
        ↱ Quoting {name} · {timestamp}
      </div>
      {body && (
        <div
          className="text-[13px] leading-[1.5] [&_p]:mb-2 [&_p:last-child]:mb-0"
          style={{ color: palette.cardTitle }}
          dangerouslySetInnerHTML={
            quote.contentHtml ? { __html: quote.contentHtml } : undefined
          }
        >
          {!quote.contentHtml ? truncateText(body, 240) : undefined}
        </div>
      )}
      {image && (
        <img
          src={image.url}
          alt={image.alt ?? ""}
          loading="lazy"
          referrerPolicy="no-referrer"
          className="mt-2 w-full"
          style={{
            maxHeight: 200,
            objectFit: "cover",
            display: "block",
            background: palette.interior,
          }}
        />
      )}
      {link && (
        <a
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="no-underline mt-2"
          style={{
            display: "flex",
            gap: 10,
            padding: 8,
            background: palette.cardBg,
          }}
        >
          {link.thumbnail && (
            <img
              src={link.thumbnail}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              style={{
                width: 48,
                height: 48,
                objectFit: "cover",
                background: palette.interior,
                flexShrink: 0,
              }}
            />
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            {link.title && (
              <p
                className="text-ui-xs font-semibold truncate"
                style={{ color: palette.cardTitle }}
              >
                {link.title}
              </p>
            )}
            <p
              className="text-mono-xs truncate"
              style={{ color: palette.cardMeta, marginTop: 2 }}
            >
              {hostOf(link.url)}
            </p>
          </div>
        </a>
      )}
    </div>
  );
}

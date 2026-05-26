"use client";

import { useState, useRef, useLayoutEffect } from "react";
import { formatDateRelative } from "../../lib/format";
import { TrustPip } from "../ui/TrustPip";
import { useAuth } from "../../stores/auth";
import { useCompose } from "../../stores/compose";
import { useNeighbourhood } from "../../hooks/useNeighbourhood";
import {
  NeighbourhoodCard,
  NeighbourhoodSkeleton,
  NeighbourhoodFailureStub,
  NeighbourhoodEmptyState,
} from "./NeighbourhoodCard";

// =============================================================================
// ExternalCard — renders external feed items (RSS, Nostr, Bluesky, Mastodon)
//
// Visual treatment: unified chassis with grey-300 left bar, mono-caps byline,
// provenance badge inline in the byline. Replies route through the compose
// overlay.
// =============================================================================

interface MediaAttachment {
  type: "image" | "video" | "audio" | "link";
  url: string;
  thumbnail?: string;
  alt?: string;
  width?: number;
  height?: number;
  title?: string;
  description?: string;
  duration_in_seconds?: number;
  size_in_bytes?: number;
}

export interface ExternalFeedItem {
  type: "external";
  id: string;
  sourceProtocol: string;
  sourceItemUri: string;
  authorName: string | null;
  authorHandle: string | null;
  authorAvatarUrl: string | null;
  authorUri: string | null;
  contentText: string | null;
  contentHtml: string | null;
  title: string | null;
  summary: string | null;
  sourceReplyUri?: string | null;
  sourceQuoteUri?: string | null;
  likeCount?: number;
  replyCount?: number;
  repostCount?: number;
  media: MediaAttachment[];
  publishedAt: number;
  sourceName: string | null;
  sourceAvatar: string | null;
  pipStatus?: "known" | "partial" | "unknown" | "contested";
  isReply?: boolean;
  biddabilityTier?: "A" | "B" | "C" | "D";
}

interface ExternalCardProps {
  item: ExternalFeedItem;
}

const PROTOCOL_LABELS: Record<string, string> = {
  rss: "VIA RSS",
  atproto: "VIA BLUESKY",
  activitypub: "VIA MASTODON",
  nostr_external: "VIA NOSTR",
  email: "VIA EMAIL",
};

// Turn an at:// URI into the Bluesky web URL so "View original" actually
// opens something. The canonical identifier is the AT URI, but browsers
// can't follow it. Same treatment for author DIDs.
function atprotoWebUri(atUri: string): string | null {
  const match = atUri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/);
  if (!match) return null;
  return `https://bsky.app/profile/${match[1]}/post/${match[2]}`;
}

function atprotoProfileUri(authorUri: string): string {
  return `https://bsky.app/profile/${authorUri}`;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const YT_VIDEO_RE =
  /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/;

function extractYouTubeVideoId(url: string): string | null {
  return url.match(YT_VIDEO_RE)?.[1] ?? null;
}

export function ExternalCard({ item }: ExternalCardProps) {
  const { user } = useAuth();
  const openCompose = useCompose((s) => s.open);

  const authorDisplay = item.authorName ?? item.sourceName ?? "Unknown source";
  const badge = PROTOCOL_LABELS[item.sourceProtocol] ?? "EXTERNAL";

  const isAtproto = item.sourceProtocol === "atproto";
  const viewOriginalUri = isAtproto
    ? (atprotoWebUri(item.sourceItemUri) ?? item.sourceItemUri)
    : item.sourceItemUri;
  const authorWebUri =
    isAtproto && item.authorUri
      ? atprotoProfileUri(item.authorUri)
      : item.authorUri;

  const imageMedia = item.media.filter((m) => m.type === "image");
  const linkEmbed = item.media.find((m) => m.type === "link");
  const videoMedia = item.media.find((m) => m.type === "video");
  const audioMedia = item.media.find((m) => m.type === "audio");
  const quoteWebUri =
    isAtproto && item.sourceQuoteUri
      ? atprotoWebUri(item.sourceQuoteUri)
      : null;

  function handleReply() {
    openCompose("reply", {
      eventId: item.id,
      eventKind: 1,
      authorPubkey: "",
      previewContent:
        item.contentText?.slice(0, 200) ?? item.title ?? undefined,
      previewAuthorName: authorDisplay,
      previewTitle: item.title ?? undefined,
    });
  }

  const [expanded, setExpanded] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const prevExpandedRef = useRef(false);

  const tier = item.biddabilityTier ?? "D";
  const neighbourhood = useNeighbourhood(
    item.id,
    "external",
    expanded,
    tier,
    item.sourceItemUri,
  );

  useLayoutEffect(() => {
    if (expanded && !prevExpandedRef.current && anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      const savedTop = rect.top;
      requestAnimationFrame(() => {
        if (!anchorRef.current) return;
        const newTop = anchorRef.current.getBoundingClientRect().top;
        const delta = newTop - savedTop;
        if (Math.abs(delta) > 1) {
          window.scrollBy(0, delta);
        }
      });
    }
    prevExpandedRef.current = expanded;
  }, [expanded, neighbourhood.parent, neighbourhood.parentChain.length]);

  function handleBodyExpand(e: React.MouseEvent) {
    e.stopPropagation();
    setExpanded((prev) => !prev);
  }

  const showProvenance = item.isReply && (tier === "A" || tier === "B");

  const hasParentChain = neighbourhood.parentChain.length > 0;
  const hasReplies = neighbourhood.replies.length > 0;
  const remainingReplies =
    neighbourhood.totalDescendants - neighbourhood.replies.length;

  return (
    <div>
      {/* Neighbourhood — parent chain (rendered above anchor) */}
      {expanded && neighbourhood.loading && <NeighbourhoodSkeleton />}
      {expanded && !neighbourhood.loading && neighbourhood.partial && (
        <NeighbourhoodFailureStub
          instanceDomain={neighbourhood.instanceDomain}
        />
      )}
      {expanded &&
        !neighbourhood.loading &&
        hasParentChain &&
        [...neighbourhood.parentChain].reverse().map((p, i) => (
          <div key={p.id} className="ml-8 mb-1">
            {i === 0 &&
              neighbourhood.parentChain.length > 0 &&
              neighbourhood.parentChain[neighbourhood.parentChain.length - 1]
                ?.sourceReplyUri && (
                <button
                  onClick={neighbourhood.loadParent}
                  className="label-ui text-grey-400 hover:text-grey-600 transition-colors mb-2"
                >
                  ↳ SHOW PARENT
                </button>
              )}
            <NeighbourhoodCard item={p} variant="parent" />
          </div>
        ))}

      {/* Anchor card */}
      <div
        ref={anchorRef}
        style={{ borderLeft: "4px solid #BBBBBB", paddingLeft: "24px" }}
      >
        {/* Provenance — reply signalling (Slice 1D) */}
        {showProvenance && (
          <div className="label-ui text-grey-400 mb-1">
            ↳ REPLYING TO A POST
          </div>
        )}

        {/* Byline — mono-caps, unified with ArticleCard/NoteCard */}
        <div className="flex items-center gap-2 mb-2">
          <TrustPip status={item.pipStatus} />
          {authorWebUri ? (
            <a
              href={authorWebUri}
              target="_blank"
              rel="noopener noreferrer"
              className="label-ui text-grey-600 hover:text-black transition-colors truncate"
              onClick={(e) => e.stopPropagation()}
            >
              {authorDisplay}
            </a>
          ) : (
            <span className="label-ui text-grey-600 truncate">
              {authorDisplay}
            </span>
          )}
          <span className="font-mono text-mono-xs text-grey-600">&middot;</span>
          <span className="font-mono text-mono-xs tracking-[0.02em] text-grey-600 flex-shrink-0">
            {formatDateRelative(item.publishedAt)}
          </span>
          <span className="font-mono text-mono-xs text-grey-600">&middot;</span>
          {/* Source attribution as route out (Slice 1E) */}
          {viewOriginalUri ? (
            <a
              href={viewOriginalUri}
              target="_blank"
              rel="noopener noreferrer"
              className="label-ui text-grey-400 hover:text-grey-600 transition-colors flex-shrink-0"
              onClick={(e) => e.stopPropagation()}
            >
              {badge} · {item.authorHandle ?? item.sourceName ?? "source"}
            </a>
          ) : (
            <span className="label-ui text-grey-400 flex-shrink-0">
              {badge} · {item.authorHandle ?? item.sourceName ?? "source"}
            </span>
          )}
          {item.sourceProtocol === "activitypub" && (
            <span
              className="label-ui text-amber-600 flex-shrink-0"
              title="Mastodon outbox polling is best-effort — some posts may be missing depending on the instance"
            >
              BETA
            </span>
          )}
        </div>

        {/* Title — clickable, opens source URL (Slice 1C) */}
        {item.title &&
          (viewOriginalUri ? (
            <a
              href={viewOriginalUri}
              target="_blank"
              rel="noopener noreferrer"
              className="block font-serif text-[20px] leading-[1.4] mt-1 text-black hover:text-crimson-dark transition-colors"
              onClick={(e) => e.stopPropagation()}
            >
              {item.title}
            </a>
          ) : (
            <h3 className="font-serif text-[20px] leading-[1.4] mt-1 text-black">
              {item.title}
            </h3>
          ))}

        {/* Body — click to expand neighbourhood (Phase 2); cursor signals interactivity */}
        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
        <div onClick={handleBodyExpand} className="cursor-pointer">
          {item.title ? (
            item.contentHtml ? (
              <div
                className="font-serif text-[14.5px] text-grey-600 leading-[1.5] mt-1.5 line-clamp-4 [&_a]:text-black [&_a]:underline [&_img]:hidden"
                dangerouslySetInnerHTML={{ __html: item.contentHtml }}
              />
            ) : item.contentText ? (
              <p className="font-serif text-[14.5px] text-grey-600 leading-[1.5] mt-1.5 line-clamp-4">
                {item.contentText}
              </p>
            ) : null
          ) : item.contentHtml ? (
            <div
              className="font-sans text-[15px] text-black leading-[1.55] mt-1.5 [&_a]:text-black [&_a]:underline [&_img]:hidden"
              dangerouslySetInnerHTML={{ __html: item.contentHtml }}
            />
          ) : item.contentText ? (
            <p className="font-sans text-[15px] text-black leading-[1.55] mt-1.5 whitespace-pre-wrap">
              {item.contentText}
            </p>
          ) : null}

          {/* Images */}
          {imageMedia.length > 0 && (
            <div className="mt-2.5 flex gap-2 overflow-x-auto">
              {imageMedia.slice(0, 4).map((m, i) => (
                <img
                  key={i}
                  src={m.url}
                  alt={m.alt ?? ""}
                  className="max-h-48 object-cover bg-grey-100"
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
              ))}
            </div>
          )}

          {/* Video — inline embed for YouTube, link for others */}
          {videoMedia &&
            (() => {
              const ytId =
                extractYouTubeVideoId(videoMedia.url) ??
                extractYouTubeVideoId(viewOriginalUri);
              if (ytId) {
                return (
                  <div
                    className="mt-2.5 relative overflow-hidden"
                    style={{ paddingBottom: "56.25%" }}
                  >
                    <iframe
                      src={`https://www.youtube-nocookie.com/embed/${ytId}`}
                      className="absolute inset-0 w-full h-full"
                      frameBorder="0"
                      allowFullScreen
                      loading="lazy"
                      referrerPolicy="no-referrer"
                    />
                  </div>
                );
              }
              return (
                <a
                  href={viewOriginalUri}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2.5 flex items-center gap-2 border border-grey-200 hover:border-grey-300 transition-colors px-3 py-2 no-underline"
                >
                  <span className="label-ui text-grey-400">VIDEO</span>
                  <span className="text-ui-xs text-grey-600">
                    Watch on {isAtproto ? "Bluesky" : "source"}
                  </span>
                </a>
              );
            })()}

          {/* Audio (podcast episodes) */}
          {audioMedia && (
            <div className="mt-2.5 border border-grey-200 px-3 py-2">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="label-ui text-grey-400">AUDIO</span>
                {audioMedia.duration_in_seconds != null && (
                  <span className="text-mono-xs text-grey-600">
                    {formatDuration(audioMedia.duration_in_seconds)}
                  </span>
                )}
              </div>
              <audio
                src={audioMedia.url}
                controls
                preload="none"
                className="w-full h-8"
              />
            </div>
          )}

          {/* Quoted post (Bluesky only for now) */}
          {quoteWebUri && (
            <a
              href={quoteWebUri}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2.5 block border-l-2 border-grey-300 pl-3 py-1 hover:border-black transition-colors no-underline"
            >
              <span className="label-ui text-grey-400">QUOTING</span>
              <span className="text-ui-xs text-grey-600 ml-2">
                View quoted post &rarr;
              </span>
            </a>
          )}

          {/* Link embed */}
          {linkEmbed && (
            <a
              href={linkEmbed.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2.5 flex gap-3 border border-grey-200 hover:border-grey-300 transition-colors p-2.5 no-underline"
            >
              {linkEmbed.thumbnail && (
                <img
                  src={linkEmbed.thumbnail}
                  alt=""
                  className="w-16 h-16 object-cover bg-grey-100 flex-shrink-0"
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
              )}
              <div className="min-w-0 flex-1">
                {linkEmbed.title && (
                  <p className="text-ui-sm font-semibold text-black truncate">
                    {linkEmbed.title}
                  </p>
                )}
                {linkEmbed.description && (
                  <p className="text-ui-xs text-grey-600 line-clamp-2 mt-0.5">
                    {linkEmbed.description}
                  </p>
                )}
                <p className="text-mono-xs text-grey-400 truncate mt-0.5">
                  {hostOf(linkEmbed.url)}
                </p>
              </div>
            </a>
          )}
        </div>
        {/* End body expand region */}

        {/* Footer — actions */}
        <div className="mt-3 flex items-center gap-4 font-mono text-[11px] uppercase tracking-[0.02em] text-grey-600">
          {user && (
            <button
              onClick={handleReply}
              className="hover:text-black transition-colors"
            >
              Reply
            </button>
          )}
        </div>
      </div>
      {/* End anchor card */}

      {/* Neighbourhood — replies (rendered below anchor) */}
      {expanded && !neighbourhood.loading && hasReplies && (
        <div className="ml-8 mt-2 space-y-2">
          {neighbourhood.replies.map((reply) => (
            <NeighbourhoodCard key={reply.id} item={reply} variant="reply" />
          ))}
          {remainingReplies > 0 && (
            <button
              onClick={neighbourhood.loadMoreReplies}
              className="label-ui text-grey-400 hover:text-grey-600 hover:underline transition-colors"
            >
              SHOW {remainingReplies} MORE{" "}
              {remainingReplies === 1 ? "REPLY" : "REPLIES"}
            </button>
          )}
        </div>
      )}
      {expanded &&
        !neighbourhood.loading &&
        !hasReplies &&
        !hasParentChain &&
        !neighbourhood.partial &&
        (tier === "C" || tier === "D") && <NeighbourhoodEmptyState />}
    </div>
  );
}

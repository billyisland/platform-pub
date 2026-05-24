"use client";

import React from "react";
import { useRouter } from "next/navigation";
import type {
  FeedItem,
  ArticleEvent,
  NoteEvent,
  ExternalFeedItem,
} from "../../lib/ndk";
import type { PipStatus } from "../../lib/ndk";
import { useAuth } from "../../stores/auth";
import { useWriterName } from "../../hooks/useWriterName";
import { TrustPip } from "../ui/TrustPip";
import { VoteControls } from "../ui/VoteControls";
import {
  formatDateRelative,
  truncateText,
  stripMarkdown,
} from "../../lib/format";
import { extractNoteMedia, stripMediaUrls } from "../../lib/media";
import type { ReplyTarget } from "./Composer";
import { PipTrigger } from "./PipTrigger";
import { ParentContextTile } from "./ParentContextTile";
import { ReplySection } from "../replies/ReplySection";
import { useLiveEngagement } from "../../hooks/useLiveEngagement";
import { useExternalThread } from "../../hooks/useExternalThread";
import { ExternalPlayscriptThread } from "./ExternalPlayscriptThread";
import { useLinkedAccounts } from "../../hooks/useLinkedAccounts";
import { externalItems } from "../../lib/api/external-items";

export type PipOpen = (
  pubkey: string,
  rect: DOMRect,
  status: PipStatus | undefined,
) => void;
import {
  PALETTES,
  DEFAULT_BRIGHTNESS,
  DEFAULT_DENSITY,
  type Brightness,
  type Density,
  type VesselPalette,
} from "./tokens";

// VesselCard — card variant for inside a ⊔.
// Slice 1: medium-bright tokens, standard-density grammar.
// Slice 5c: density variants (compact / standard / full) + brightness-driven
// palette flowed in from the chassis. Compact = inline 9px pip + title.
// Standard = current. Full = current + source-attribution line.
// Slice 11: click-through to reader + action strip (vote / reply / share).
// Compact density stays action-less; standard + full render the strip.

interface CardContext {
  density: Density;
  palette: VesselPalette;
  dragData?: string;
}

interface Props {
  item: FeedItem;
  density?: Density;
  brightness?: Brightness;
  onReply?: (target: ReplyTarget) => void;
  onPipOpen?: PipOpen;
  dragData?: string;
  // Slice 13: inline thread expansion state. Parent owns the toggle so
  // refresh ticks (after overlay-Composer replies) can target a specific
  // card without forcing the whole vessel to remount.
  threadExpanded?: boolean;
  onToggleThread?: (target: ReplyTarget) => void;
  threadRefreshKey?: number;
  isSaved?: boolean;
  onToggleSave?: (feedItemId: string, next: boolean) => void;
  expanded?: boolean;
  onToggleExpand?: (itemId: string) => void;
}

// at:// → bsky.app web URL. Mirrors the helper in feed/ExternalCard.tsx —
// kept local to avoid pulling in the deprecated card module.
function atprotoWebUri(atUri: string): string | null {
  const match = atUri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/);
  if (!match) return null;
  return `https://bsky.app/profile/${match[1]}/post/${match[2]}`;
}

export function VesselCard({
  item,
  density,
  brightness,
  onReply,
  onPipOpen,
  threadExpanded,
  onToggleThread,
  threadRefreshKey,
  isSaved,
  onToggleSave,
  expanded,
  onToggleExpand,
  dragData,
}: Props) {
  const ctx: CardContext = {
    density: density ?? DEFAULT_DENSITY,
    palette: PALETTES[brightness ?? DEFAULT_BRIGHTNESS],
    dragData,
  };
  if (item.type === "article")
    return (
      <ArticleVesselCard
        article={item}
        ctx={ctx}
        onReply={onReply}
        onPipOpen={onPipOpen}
        threadExpanded={threadExpanded}
        onToggleThread={onToggleThread}
        threadRefreshKey={threadRefreshKey}
        isSaved={isSaved}
        onToggleSave={onToggleSave}
        expanded={expanded}
        onToggleExpand={onToggleExpand}
      />
    );
  if (item.type === "note")
    return (
      <NoteVesselCard
        note={item}
        ctx={ctx}
        onReply={onReply}
        onPipOpen={onPipOpen}
        threadExpanded={threadExpanded}
        onToggleThread={onToggleThread}
        threadRefreshKey={threadRefreshKey}
        isSaved={isSaved}
        onToggleSave={onToggleSave}
        expanded={expanded}
        onToggleExpand={onToggleExpand}
      />
    );
  return (
    <ExternalVesselCard
      external={item}
      ctx={ctx}
      isSaved={isSaved}
      onToggleSave={onToggleSave}
      expanded={expanded}
      onToggleExpand={onToggleExpand}
      threadExpanded={threadExpanded}
      onToggleThread={onToggleThread}
    />
  );
}

function CardShell({
  ctx,
  onClick,
  children,
}: {
  ctx: CardContext;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  const padding = ctx.density === "compact" ? "8px 12px" : "16px";
  const draggable = !!ctx.dragData && ctx.density !== "compact";
  return (
    <div
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      draggable={draggable || undefined}
      onDragStart={
        draggable
          ? (e) => {
              e.dataTransfer.setData(
                "application/x-vessel-card",
                ctx.dragData!,
              );
              e.dataTransfer.effectAllowed = "move";
            }
          : undefined
      }
      style={{
        background: ctx.palette.cardBg,
        padding,
        cursor: onClick ? "pointer" : undefined,
      }}
    >
      {children}
    </div>
  );
}

// Action strip under the card body. Quiet by default — mono-caps, hint-coloured —
// in keeping with the card chassis grammar. Compact density skips this row.
function CardActions({
  ctx,
  voteEventId,
  voteKind,
  isOwnContent,
  replyTarget,
  shareUrl,
  onReply,
  threadExpanded,
  onToggleThread,
  feedItemId,
  isSaved,
  onToggleSave,
}: {
  ctx: CardContext;
  voteEventId?: string;
  voteKind?: number;
  isOwnContent?: boolean;
  replyTarget?: ReplyTarget;
  shareUrl?: string;
  onReply?: (target: ReplyTarget) => void;
  threadExpanded?: boolean;
  onToggleThread?: (target: ReplyTarget) => void;
  feedItemId?: string;
  isSaved?: boolean;
  onToggleSave?: (feedItemId: string, next: boolean) => void;
}) {
  if (ctx.density === "compact") return null;

  function handleShare(e: React.MouseEvent) {
    e.stopPropagation();
    if (!shareUrl) return;
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(shareUrl);
    }
  }

  // Slice 20: Save toggle. Crimson when saved (consistent with the rest of
  // the workspace's "committed" state colour). Suppressed if the item lacks
  // a feedItemId (e.g. surfaces that bypass the unified table).
  const canSave = !!feedItemId && !!onToggleSave;

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="flex items-center gap-3 mt-3 label-ui"
      style={{ color: ctx.palette.cardMeta }}
    >
      {voteEventId && voteKind !== undefined && (
        <VoteControls
          targetEventId={voteEventId}
          targetKind={voteKind}
          isOwnContent={!!isOwnContent}
        />
      )}
      {replyTarget && onReply && (
        <button
          type="button"
          onClick={() => onReply(replyTarget)}
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
            color: ctx.palette.cardMeta,
          }}
          className="hover:opacity-80"
        >
          Reply
        </button>
      )}
      {replyTarget && onToggleThread && (
        <button
          type="button"
          onClick={() => onToggleThread(replyTarget)}
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
            color: ctx.palette.cardMeta,
          }}
          className="hover:opacity-80"
        >
          {threadExpanded ? "Hide thread" : "Thread"}
        </button>
      )}
      {shareUrl && (
        <button
          type="button"
          onClick={handleShare}
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
            color: ctx.palette.cardMeta,
          }}
          className="hover:opacity-80"
        >
          Share
        </button>
      )}
      {canSave && (
        <button
          type="button"
          onClick={() => onToggleSave!(feedItemId!, !isSaved)}
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
            color: isSaved ? ctx.palette.crimson : ctx.palette.cardMeta,
          }}
          className="hover:opacity-80"
        >
          {isSaved ? "Saved" : "Save"}
        </button>
      )}
    </div>
  );
}

// Slice 13: inline playscript thread for vessel cards. Wraps the existing
// `ReplySection` (the source of truth for the playscript render + reply
// publish + vote tally pipeline) in a click-isolating shell so taps inside
// the thread don't bubble up to the card-level navigation. `compact` keeps
// ReplySection from drawing its own border-top + heading; the visual gap
// from the card body is provided by the `mt-4` here.
function CardThread({
  target,
  refreshKey,
}: {
  target: ReplyTarget;
  refreshKey?: number;
}) {
  return (
    <div onClick={(e) => e.stopPropagation()} className="mt-4">
      <ReplySection
        targetEventId={target.eventId}
        targetKind={target.eventKind}
        targetAuthorPubkey={target.authorPubkey}
        compact
        refreshKey={refreshKey}
      />
    </div>
  );
}

function CompactRow({
  pipNode,
  title,
  trailing,
  ctx,
}: {
  pipNode: React.ReactNode;
  title: string;
  trailing?: React.ReactNode;
  ctx: CardContext;
}) {
  return (
    <div
      className="flex items-center gap-2 font-sans text-ui-xs"
      style={{ color: ctx.palette.cardTitle }}
    >
      <span
        style={{
          display: "inline-flex",
          width: 9,
          height: 9,
        }}
      >
        {pipNode}
      </span>
      <span className="truncate flex-1">{title}</span>
      {trailing}
    </div>
  );
}

function Byline({
  pipNode,
  name,
  publishedAt,
  trailing,
  ctx,
}: {
  pipNode: React.ReactNode;
  name: string;
  publishedAt: number;
  trailing?: React.ReactNode;
  ctx: CardContext;
}) {
  return (
    <div
      className="flex items-center gap-2 mb-2 label-ui"
      style={{ color: ctx.palette.cardMeta }}
    >
      {pipNode}
      <span style={{ color: ctx.palette.cardTitle }} className="font-medium">
        {name}
      </span>
      <span>·</span>
      <time dateTime={new Date(publishedAt * 1000).toISOString()}>
        {formatDateRelative(publishedAt)}
      </time>
      {trailing}
    </div>
  );
}

function SourceAttribution({
  protocol,
  identifier,
  ctx,
}: {
  protocol: string;
  identifier?: string;
  ctx: CardContext;
}) {
  return (
    <div
      className="font-mono text-[10px] uppercase tracking-[0.06em] mt-2"
      style={{ color: ctx.palette.cardMeta }}
    >
      VIA {protocol}
      {identifier ? ` · ${identifier}` : ""}
    </div>
  );
}

// Slice 23 — hero media for notes + external cards. Articles defer until the
// editor + publish path carry the NIP-23 image tag.
//
// Renders the first image/video item; remaining items collapse into a `+N`
// corner pill. Image → lazy-loaded <img> in a 16:9 cover container. Video →
// thumbnail (if present) + play glyph; click opens the source URL. Suppressed
// in compact density since the action strip is also suppressed there — we
// don't want a hero image rendering on a row that's intentionally airless.
interface MediaItemLike {
  type: "image" | "video" | "audio" | "link";
  url: string;
  thumbnail?: string;
  alt?: string;
}

function MediaBlock({
  items,
  ctx,
  externalUrl,
}: {
  items: MediaItemLike[];
  ctx: CardContext;
  externalUrl?: string;
}) {
  if (ctx.density === "compact") return null;
  if (!items || items.length === 0) return null;

  // Pick the first image; if none, the first video. Audio + link items are
  // skipped — link cards have a different mental model (the existing external
  // card link-embed) and audio isn't part of the workspace's render budget.
  const hero =
    items.find((m) => m.type === "image") ??
    items.find((m) => m.type === "video");
  if (!hero) return null;

  const overflowCount = items.length - 1;
  const playable = hero.type === "video" && externalUrl;

  return (
    <div
      onClick={(e) => {
        if (!playable) return;
        e.stopPropagation();
        window.open(externalUrl, "_blank", "noopener,noreferrer");
      }}
      style={{
        position: "relative",
        marginTop: 10,
        marginBottom: 6,
        background: ctx.palette.interior,
        aspectRatio: "16 / 9",
        overflow: "hidden",
        cursor: playable ? "pointer" : undefined,
      }}
    >
      {hero.type === "image" && (
        <img
          src={hero.url}
          alt={hero.alt ?? ""}
          loading="lazy"
          referrerPolicy="no-referrer"
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: "block",
          }}
        />
      )}
      {hero.type === "video" && hero.thumbnail && (
        <img
          src={hero.thumbnail}
          alt={hero.alt ?? ""}
          loading="lazy"
          referrerPolicy="no-referrer"
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: "block",
          }}
        />
      )}
      {hero.type === "video" && (
        <div
          role="img"
          aria-label="Play video"
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: hero.thumbnail
              ? "rgba(0,0,0,0.18)"
              : "rgba(0,0,0,0.06)",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 44,
              height: 44,
              borderRadius: "50%",
              background: "rgba(255,255,255,0.92)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5 3.5v9l7-4.5z" fill="#1A1A18" />
            </svg>
          </span>
        </div>
      )}
      {overflowCount > 0 && (
        <span
          aria-hidden="true"
          className="font-mono"
          style={{
            position: "absolute",
            right: 8,
            bottom: 8,
            padding: "2px 8px",
            background: "rgba(0,0,0,0.72)",
            color: "#FFFFFF",
            fontSize: 11,
            letterSpacing: "0.04em",
          }}
        >
          +{overflowCount}
        </span>
      )}
    </div>
  );
}

function EngagementRow({
  likeCount,
  replyCount,
  repostCount,
  protocol,
  ctx,
  liked,
  onLike,
  likeDisabled,
}: {
  likeCount: number;
  replyCount: number;
  repostCount: number;
  protocol: string;
  ctx: CardContext;
  liked?: boolean;
  onLike?: () => void;
  likeDisabled?: boolean;
}) {
  const hideRepost = protocol === "nostr_external" || protocol === "rss";
  const hideLike = protocol === "rss";
  const showLike = !hideLike && (likeCount > 0 || onLike);
  if (!showLike && replyCount === 0 && repostCount === 0) return null;
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="flex items-center gap-3 mt-2 font-mono text-[11px] uppercase tracking-[0.02em]"
      style={{ color: ctx.palette.cardMeta }}
    >
      {showLike && (
        <button
          type="button"
          onClick={onLike}
          disabled={!onLike || liked}
          className="flex items-center gap-1 hover:opacity-80 disabled:opacity-50"
          style={{
            background: "none",
            border: "none",
            padding: 0,
            cursor: onLike && !liked ? "pointer" : "default",
            color: liked
              ? ctx.palette.crimson
              : likeDisabled
                ? ctx.palette.cardMeta
                : ctx.palette.cardMeta,
          }}
          title={
            likeDisabled
              ? "Connect account to interact"
              : liked
                ? "Liked"
                : "Like"
          }
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill={liked ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
          </svg>
          {likeCount > 0 && likeCount}
        </button>
      )}
      {replyCount > 0 && (
        <span className="flex items-center gap-1">
          <svg
            width="12"
            height="12"
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
      {!hideRepost && repostCount > 0 && (
        <span className="flex items-center gap-1">
          <svg
            width="12"
            height="12"
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

function ArticleVesselCard({
  article,
  ctx,
  onReply,
  onPipOpen,
  threadExpanded,
  onToggleThread,
  threadRefreshKey,
  isSaved,
  onToggleSave,
  expanded,
  onToggleExpand,
}: {
  article: ArticleEvent;
  ctx: CardContext;
  onReply?: (target: ReplyTarget) => void;
  onPipOpen?: PipOpen;
  threadExpanded?: boolean;
  onToggleThread?: (target: ReplyTarget) => void;
  threadRefreshKey?: number;
  isSaved?: boolean;
  onToggleSave?: (feedItemId: string, next: boolean) => void;
  expanded?: boolean;
  onToggleExpand?: (itemId: string) => void;
}) {
  const router = useRouter();
  const { user } = useAuth();
  const writer = useWriterName(article.pubkey);
  const name = writer?.displayName ?? article.pubkey.slice(0, 12) + "…";
  const standfirst =
    article.summary || truncateText(stripMarkdown(article.content), 140);
  const href = `/article/${article.dTag}`;
  const shareUrl =
    typeof window !== "undefined" ? `${window.location.origin}${href}` : href;
  const isOwnContent = !!user && user.pubkey === article.pubkey;
  const replyTarget: ReplyTarget = {
    eventId: article.id,
    eventKind: 30023,
    authorPubkey: article.pubkey,
    authorName: name,
    excerpt: article.title,
  };
  const expandKey = article.feedItemId ?? article.id;
  const onCardClick = onToggleExpand
    ? () => onToggleExpand(expandKey)
    : () => router.push(href);
  const pricePill =
    article.isPaywalled && article.pricePence ? (
      ctx.density === "compact" ? (
        <span style={{ color: ctx.palette.crimson, marginLeft: 4 }}>£</span>
      ) : (
        <>
          <span>·</span>
          <span style={{ color: ctx.palette.crimson }}>
            £{(article.pricePence / 100).toFixed(2)}
          </span>
        </>
      )
    ) : null;

  const pipNodeCompact = onPipOpen ? (
    <PipTrigger
      pubkey={article.pubkey}
      pipStatus={article.pipStatus}
      opacity={ctx.palette.pipOpacity}
      scale={0.82}
      onOpen={onPipOpen}
    />
  ) : (
    <span
      style={{
        opacity: ctx.palette.pipOpacity,
        transform: "scale(0.82)",
        transformOrigin: "top left",
      }}
    >
      <TrustPip status={article.pipStatus} />
    </span>
  );
  const pipNodeByline = onPipOpen ? (
    <PipTrigger
      pubkey={article.pubkey}
      pipStatus={article.pipStatus}
      opacity={ctx.palette.pipOpacity}
      onOpen={onPipOpen}
    />
  ) : (
    <span style={{ display: "inline-flex", opacity: ctx.palette.pipOpacity }}>
      <TrustPip status={article.pipStatus} />
    </span>
  );

  if (ctx.density === "compact") {
    return (
      <CardShell ctx={ctx} onClick={onCardClick}>
        <CompactRow
          pipNode={pipNodeCompact}
          title={article.title}
          trailing={pricePill}
          ctx={ctx}
        />
      </CardShell>
    );
  }

  return (
    <CardShell ctx={ctx} onClick={onCardClick}>
      <Byline
        pipNode={pipNodeByline}
        name={name}
        publishedAt={article.publishedAt}
        trailing={pricePill}
        ctx={ctx}
      />
      <h3
        className="font-serif text-[17px] leading-[1.25] mb-1.5"
        style={{ color: ctx.palette.cardTitle }}
      >
        {article.title}
      </h3>
      {expanded ? (
        <>
          {article.content && (
            <div
              className="font-serif text-[14.5px] leading-[1.55] mt-2"
              style={{ color: ctx.palette.cardTitle, whiteSpace: "pre-wrap" }}
            >
              {stripMarkdown(article.content)}
            </div>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              router.push(href);
            }}
            className="label-ui mt-3"
            style={{
              color: ctx.palette.crimson,
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
            }}
          >
            Read full article →
          </button>
        </>
      ) : (
        <>
          {standfirst && (
            <p
              className="text-ui-xs leading-[1.45]"
              style={{ color: ctx.palette.cardStandfirst }}
            >
              {standfirst}
            </p>
          )}
          <MediaBlock items={article.media ?? []} ctx={ctx} />
        </>
      )}
      {ctx.density === "full" && (
        <SourceAttribution
          protocol="ALL.HAUS"
          identifier={article.pubkey.slice(0, 12) + "…"}
          ctx={ctx}
        />
      )}
      <CardActions
        ctx={ctx}
        voteEventId={article.id}
        voteKind={30023}
        isOwnContent={isOwnContent}
        replyTarget={replyTarget}
        shareUrl={shareUrl}
        onReply={onReply}
        threadExpanded={threadExpanded}
        onToggleThread={onToggleThread}
        feedItemId={article.feedItemId}
        isSaved={isSaved}
        onToggleSave={onToggleSave}
      />
      {threadExpanded && (
        <CardThread target={replyTarget} refreshKey={threadRefreshKey} />
      )}
    </CardShell>
  );
}

function NoteVesselCard({
  note,
  ctx,
  onReply,
  onPipOpen,
  threadExpanded,
  onToggleThread,
  threadRefreshKey,
  isSaved,
  onToggleSave,
  expanded,
  onToggleExpand,
}: {
  note: NoteEvent;
  ctx: CardContext;
  onReply?: (target: ReplyTarget) => void;
  onPipOpen?: PipOpen;
  threadExpanded?: boolean;
  onToggleThread?: (target: ReplyTarget) => void;
  threadRefreshKey?: number;
  isSaved?: boolean;
  onToggleSave?: (feedItemId: string, next: boolean) => void;
  expanded?: boolean;
  onToggleExpand?: (itemId: string) => void;
}) {
  const { user } = useAuth();
  const writer = useWriterName(note.pubkey);
  const name = writer?.displayName ?? note.pubkey.slice(0, 12) + "…";
  const isOwnContent = !!user && user.pubkey === note.pubkey;
  const replyTarget: ReplyTarget = {
    eventId: note.id,
    eventKind: 1,
    authorPubkey: note.pubkey,
    authorName: name,
    excerpt: truncateText(note.content, 120),
  };

  const pipNodeCompact = onPipOpen ? (
    <PipTrigger
      pubkey={note.pubkey}
      pipStatus={note.pipStatus}
      opacity={ctx.palette.pipOpacity}
      scale={0.82}
      onOpen={onPipOpen}
    />
  ) : (
    <span
      style={{
        opacity: ctx.palette.pipOpacity,
        transform: "scale(0.82)",
        transformOrigin: "top left",
      }}
    >
      <TrustPip status={note.pipStatus} />
    </span>
  );
  const pipNodeByline = onPipOpen ? (
    <PipTrigger
      pubkey={note.pubkey}
      pipStatus={note.pipStatus}
      opacity={ctx.palette.pipOpacity}
      onOpen={onPipOpen}
    />
  ) : (
    <span style={{ display: "inline-flex", opacity: ctx.palette.pipOpacity }}>
      <TrustPip status={note.pipStatus} />
    </span>
  );

  if (ctx.density === "compact") {
    return (
      <CardShell ctx={ctx}>
        <CompactRow
          pipNode={pipNodeCompact}
          title={truncateText(note.content, 90)}
          ctx={ctx}
        />
      </CardShell>
    );
  }

  const noteMedia = extractNoteMedia(note.content);
  const noteDisplayText =
    noteMedia.length > 0
      ? stripMediaUrls(note.content).displayText
      : note.content;

  const expandKey = note.feedItemId ?? note.id;
  const onCardClick = onToggleExpand
    ? () => onToggleExpand(expandKey)
    : undefined;

  return (
    <CardShell ctx={ctx} onClick={onCardClick}>
      <Byline
        pipNode={pipNodeByline}
        name={name}
        publishedAt={note.publishedAt}
        ctx={ctx}
      />
      {noteDisplayText && (
        <p
          className="text-[13.5px] leading-[1.5] whitespace-pre-wrap"
          style={{ color: ctx.palette.cardTitle }}
        >
          {expanded ? noteDisplayText : truncateText(noteDisplayText, 220)}
        </p>
      )}
      <MediaBlock items={noteMedia} ctx={ctx} />
      {ctx.density === "full" && (
        <SourceAttribution
          protocol="NOSTR"
          identifier={note.pubkey.slice(0, 12) + "…"}
          ctx={ctx}
        />
      )}
      <CardActions
        ctx={ctx}
        voteEventId={note.id}
        voteKind={1}
        isOwnContent={isOwnContent}
        replyTarget={replyTarget}
        onReply={onReply}
        threadExpanded={threadExpanded}
        onToggleThread={onToggleThread}
        feedItemId={note.feedItemId}
        isSaved={isSaved}
        onToggleSave={onToggleSave}
      />
      {threadExpanded && (
        <CardThread target={replyTarget} refreshKey={threadRefreshKey} />
      )}
    </CardShell>
  );
}

export interface NewUserItem {
  type: "new_user";
  username: string;
  displayName: string | null;
  avatar: string | null;
  joinedAt: number;
}

export function NewUserVesselCard({
  item,
  density,
  brightness,
}: {
  item: NewUserItem;
  density?: Density;
  brightness?: Brightness;
}) {
  const ctx: CardContext = {
    density: density ?? DEFAULT_DENSITY,
    palette: PALETTES[brightness ?? DEFAULT_BRIGHTNESS],
  };
  const name = item.displayName ?? item.username ?? "Someone";

  if (ctx.density === "compact") {
    return (
      <CardShell ctx={ctx}>
        <CompactRow pipNode={null} title={`${name} joined`} ctx={ctx} />
      </CardShell>
    );
  }

  return (
    <CardShell ctx={ctx}>
      <div
        className="flex items-center gap-2 label-ui"
        style={{ color: ctx.palette.cardMeta }}
      >
        <span style={{ color: ctx.palette.cardTitle }} className="font-medium">
          {name}
        </span>
        <span>·</span>
        <time dateTime={new Date(item.joinedAt * 1000).toISOString()}>
          {formatDateRelative(item.joinedAt)}
        </time>
      </div>
      <p
        className="text-ui-xs leading-[1.45] mt-1.5"
        style={{ color: ctx.palette.cardStandfirst }}
      >
        joined the platform
      </p>
    </CardShell>
  );
}

function ExternalVesselCard({
  external,
  ctx,
  isSaved,
  onToggleSave,
  expanded,
  onToggleExpand,
  threadExpanded,
  onToggleThread,
}: {
  external: ExternalFeedItem;
  ctx: CardContext;
  isSaved?: boolean;
  onToggleSave?: (feedItemId: string, next: boolean) => void;
  expanded?: boolean;
  onToggleExpand?: (itemId: string) => void;
  threadExpanded?: boolean;
  onToggleThread?: (target: ReplyTarget) => void;
}) {
  const name =
    external.authorName ??
    external.authorHandle ??
    external.sourceName ??
    "External";
  const protocol = external.sourceProtocol.toUpperCase();
  const body = external.title ?? external.summary ?? external.contentText ?? "";
  const fullBody = external.contentText ?? external.contentHtml ?? body;
  const externalUrl =
    external.sourceProtocol === "atproto"
      ? (atprotoWebUri(external.sourceItemUri) ?? external.sourceItemUri)
      : external.sourceItemUri;
  const expandKey = external.feedItemId ?? external.id;
  const engagement = useLiveEngagement(external.id, !!expanded, {
    likeCount: external.likeCount ?? 0,
    replyCount: external.replyCount ?? 0,
    repostCount: external.repostCount ?? 0,
  });

  // Like interaction state
  const linkedAccounts = useLinkedAccounts();
  const matchingAccount = linkedAccounts?.find(
    (a) => a.protocol === external.sourceProtocol && a.isValid,
  );
  const [liked, setLiked] = React.useState(false);
  const [likeCountDelta, setLikeCountDelta] = React.useState(0);

  const handleLike = React.useCallback(() => {
    if (!matchingAccount || liked) return;
    setLiked(true);
    setLikeCountDelta(1);
    externalItems.like(external.id, matchingAccount.id).catch(() => {
      setLiked(false);
      setLikeCountDelta(0);
    });
  }, [matchingAccount, liked, external.id]);

  const onCardClick = onToggleExpand
    ? () => onToggleExpand(expandKey)
    : () => {
        if (typeof window !== "undefined") {
          window.open(externalUrl, "_blank", "noopener,noreferrer");
        }
      };

  const threadTarget: ReplyTarget | undefined =
    external.sourceProtocol !== "rss" &&
    external.sourceProtocol !== "nostr_external"
      ? {
          eventId: external.id,
          eventKind: 0,
          authorPubkey: "",
          authorName: name,
          excerpt: truncateText(body, 120),
        }
      : undefined;

  const pipNodeCompact = (
    <span
      style={{
        opacity: ctx.palette.pipOpacity,
        transform: "scale(0.82)",
        transformOrigin: "top left",
      }}
    >
      <TrustPip status={external.pipStatus} />
    </span>
  );
  const pipNodeByline = (
    <span style={{ display: "inline-flex", opacity: ctx.palette.pipOpacity }}>
      <TrustPip status={external.pipStatus} />
    </span>
  );

  if (ctx.density === "compact") {
    return (
      <CardShell ctx={ctx} onClick={onCardClick}>
        <CompactRow pipNode={pipNodeCompact} title={body || name} ctx={ctx} />
      </CardShell>
    );
  }

  return (
    <CardShell ctx={ctx} onClick={onCardClick}>
      <Byline
        pipNode={pipNodeByline}
        name={name}
        publishedAt={external.publishedAt}
        trailing={
          ctx.density === "standard" ? (
            <>
              <span>·</span>
              <span>VIA {protocol}</span>
            </>
          ) : null
        }
        ctx={ctx}
      />
      {expanded ? (
        <>
          {external.sourceReplyUri && (
            <ParentContextTile itemId={external.id} palette={ctx.palette} />
          )}
          {external.contentHtml ? (
            <div
              className="text-[13.5px] leading-[1.5] [&_p]:mb-2 [&_p:last-child]:mb-0 [&_a]:text-black [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-grey-300 [&_blockquote]:pl-3 [&_blockquote]:text-grey-600"
              style={{ color: ctx.palette.cardTitle }}
              dangerouslySetInnerHTML={{ __html: external.contentHtml }}
            />
          ) : fullBody ? (
            <p
              className="text-[13.5px] leading-[1.5] whitespace-pre-wrap"
              style={{ color: ctx.palette.cardTitle }}
            >
              {fullBody}
            </p>
          ) : null}
          <MediaBlock
            items={external.media ?? []}
            ctx={ctx}
            externalUrl={externalUrl}
          />
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (typeof window !== "undefined") {
                window.open(externalUrl, "_blank", "noopener,noreferrer");
              }
            }}
            className="label-ui mt-3"
            style={{
              color: ctx.palette.crimson,
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
            }}
          >
            Open original →
          </button>
        </>
      ) : (
        <>
          {body && (
            <p
              className="text-[13.5px] leading-[1.5]"
              style={{ color: ctx.palette.cardTitle }}
            >
              {truncateText(body, 200)}
            </p>
          )}
          <MediaBlock
            items={external.media ?? []}
            ctx={ctx}
            externalUrl={externalUrl}
          />
        </>
      )}
      <EngagementRow
        likeCount={engagement.likeCount + likeCountDelta}
        replyCount={engagement.replyCount}
        repostCount={engagement.repostCount}
        protocol={external.sourceProtocol}
        ctx={ctx}
        liked={liked}
        onLike={
          external.sourceProtocol !== "rss"
            ? matchingAccount
              ? handleLike
              : undefined
            : undefined
        }
        likeDisabled={external.sourceProtocol !== "rss" && !matchingAccount}
      />
      {ctx.density === "full" && (
        <SourceAttribution
          protocol={protocol}
          identifier={external.authorHandle ?? external.sourceName ?? undefined}
          ctx={ctx}
        />
      )}
      <CardActions
        ctx={ctx}
        shareUrl={externalUrl}
        feedItemId={external.feedItemId}
        isSaved={isSaved}
        onToggleSave={onToggleSave}
        replyTarget={threadTarget}
        threadExpanded={threadExpanded}
        onToggleThread={onToggleThread}
      />
      {threadExpanded && threadTarget && (
        <ExternalCardThread itemId={external.id} palette={ctx.palette} />
      )}
    </CardShell>
  );
}

function ExternalCardThread({
  itemId,
  palette,
}: {
  itemId: string;
  palette: VesselPalette;
}) {
  const { ancestors, descendants, loading, error } = useExternalThread(
    itemId,
    true,
  );

  if (loading) {
    return (
      <div onClick={(e) => e.stopPropagation()} className="mt-4 ml-8">
        <div className="space-y-[32px] py-2">
          {[1, 2].map((i) => (
            <div
              key={i}
              className="h-10 animate-pulse rounded"
              style={{ background: palette.interior }}
            />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div onClick={(e) => e.stopPropagation()} className="mt-4 ml-8">
        <p className="label-ui text-grey-400">Couldn&apos;t load thread</p>
      </div>
    );
  }

  if (ancestors.length === 0 && descendants.length === 0) {
    return (
      <div onClick={(e) => e.stopPropagation()} className="mt-4 ml-8">
        <p className="label-ui text-grey-400">No thread available</p>
      </div>
    );
  }

  return (
    <div onClick={(e) => e.stopPropagation()} className="mt-4">
      <ExternalPlayscriptThread
        ancestors={ancestors}
        descendants={descendants}
        palette={palette}
      />
    </div>
  );
}

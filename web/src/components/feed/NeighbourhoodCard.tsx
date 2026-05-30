"use client";

import Link from "next/link";
import { formatDateRelative } from "../../lib/format";
import type { ResolvedContent } from "../../lib/api/articles";
import type {
  NeighbourhoodParent,
  NeighbourhoodReply,
} from "../../hooks/useNeighbourhood";

type NeighbourhoodItem = NeighbourhoodParent | NeighbourhoodReply;

interface NeighbourhoodCardProps {
  item: NeighbourhoodItem;
  variant: "parent" | "reply";
}

function isParent(item: NeighbourhoodItem): item is NeighbourhoodParent {
  return "sourceProtocol" in item && !("protocol" in item);
}

function getPublishedAt(item: NeighbourhoodItem): number {
  if (typeof item.publishedAt === "number") return item.publishedAt;
  return Math.floor(new Date(item.publishedAt).getTime() / 1000);
}

export function NeighbourhoodCard({ item, variant }: NeighbourhoodCardProps) {
  const authorName = item.authorName || item.authorHandle || "Unknown";
  const ts = getPublishedAt(item);
  const barColor = variant === "parent" ? "#CCCCCC" : "#CCCCCC";

  return (
    <div style={{ borderLeft: `4px solid ${barColor}`, paddingLeft: "20px" }}>
      <div className="flex items-center gap-2 mb-1">
        <span className="label-ui text-grey-400 truncate">{authorName}</span>
        <span className="font-mono text-[10px] text-grey-400">&middot;</span>
        <span className="font-mono text-[10px] uppercase tracking-[0.02em] text-grey-400 flex-shrink-0">
          {formatDateRelative(ts)}
        </span>
      </div>

      {item.contentHtml ? (
        <div
          className="text-[14px] leading-[1.5] text-grey-600 [&_a]:text-grey-600 [&_a]:underline [&_img]:hidden [&_p]:mb-1.5 line-clamp-6"
          dangerouslySetInnerHTML={{ __html: item.contentHtml }}
        />
      ) : item.contentText ? (
        <p className="text-[14px] leading-[1.5] text-grey-600 line-clamp-6 whitespace-pre-wrap">
          {item.contentText}
        </p>
      ) : isParent(item) && item.title ? (
        <p className="font-serif text-[16px] leading-[1.4] text-grey-600 italic">
          {item.title}
        </p>
      ) : null}

      <EngagementMini
        likeCount={item.likeCount}
        replyCount={item.replyCount}
        repostCount={item.repostCount}
      />
    </div>
  );
}

function EngagementMini({
  likeCount,
  replyCount,
  repostCount,
}: {
  likeCount: number;
  replyCount: number;
  repostCount: number;
}) {
  if (likeCount === 0 && replyCount === 0 && repostCount === 0) return null;
  return (
    <div className="flex items-center gap-3 mt-1 font-mono text-[10px] uppercase tracking-[0.02em] text-grey-300">
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

// Native parent (a kind-1 note or kind-30023 article resolved via
// /content/resolve) rendered inset above a reply card. Shares the dimmed-bar,
// mono-caps-byline grammar with NeighbourhoodCard so native and external
// neighbourhoods read identically.
export function NativeParentCard({ item }: { item: ResolvedContent }) {
  const authorName =
    item.author.displayName || item.author.username || "Unknown";

  return (
    <div style={{ borderLeft: "4px solid #CCCCCC", paddingLeft: "20px" }}>
      <div className="flex items-center gap-2 mb-1">
        {item.author.username ? (
          <Link
            href={`/${item.author.username}`}
            onClick={(e) => e.stopPropagation()}
            className="label-ui text-grey-400 hover:text-grey-600 transition-colors truncate"
          >
            {authorName}
          </Link>
        ) : (
          <span className="label-ui text-grey-400 truncate">{authorName}</span>
        )}
        <span className="font-mono text-[10px] text-grey-400">&middot;</span>
        <span className="font-mono text-[10px] uppercase tracking-[0.02em] text-grey-400 flex-shrink-0">
          {formatDateRelative(item.publishedAt)}
        </span>
      </div>

      {item.type === "article" ? (
        item.dTag ? (
          <Link
            href={`/article/${item.dTag}`}
            onClick={(e) => e.stopPropagation()}
            className="block font-serif text-[16px] leading-[1.4] text-grey-600 italic hover:text-crimson-dark transition-colors"
          >
            {item.title}
          </Link>
        ) : (
          <p className="font-serif text-[16px] leading-[1.4] text-grey-600 italic">
            {item.title}
          </p>
        )
      ) : item.content ? (
        <p className="text-[14px] leading-[1.5] text-grey-600 line-clamp-6 whitespace-pre-wrap">
          {item.content}
        </p>
      ) : null}
    </div>
  );
}

export function NeighbourhoodSkeleton() {
  return (
    <div className="ml-8 animate-pulse py-2">
      <div className="h-3 w-32 bg-grey-200 mb-2" />
      <div className="h-3 w-3/4 bg-grey-200 mb-1.5" />
      <div className="h-3 w-1/2 bg-grey-200" />
    </div>
  );
}

export function NeighbourhoodFailureStub({
  instanceDomain,
}: {
  instanceDomain: string | null;
}) {
  return (
    <div className="ml-8 label-ui text-grey-400 py-3">
      ↳ PARENT POST · COULDN&apos;T REACH{" "}
      {instanceDomain ? instanceDomain.toUpperCase() : "SOURCE"}
    </div>
  );
}

// CARD-BEHAVIOUR-ADR §V.5: the empty state doubles as a reply affordance —
// clicking it opens the composer. Falls back to an inert label when no reply
// handler is available.
export function NeighbourhoodEmptyState({ onReply }: { onReply?: () => void }) {
  if (!onReply) {
    return (
      <div className="ml-8 label-ui text-grey-400 py-6 text-center">
        NO CONVERSATION YET — BE THE FIRST TO REPLY
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onReply}
      className="ml-8 label-ui text-grey-400 hover:text-black py-6 w-full text-center transition-colors"
    >
      NO CONVERSATION YET — BE THE FIRST TO REPLY
    </button>
  );
}

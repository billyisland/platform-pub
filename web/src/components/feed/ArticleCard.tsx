"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { ProfileLink } from "../ui/ProfileLink";
import { useRouter } from "next/navigation";
import type { ArticleEvent } from "../../lib/ndk";
import { useWriterName } from "../../hooks/useWriterName";
import { useAuth } from "../../stores/auth";
import { replies as repliesApi, bookmarks, type VoteTally, type MyVoteCount } from "../../lib/api";
import { ReplySection } from "../replies/ReplySection";
import { VoteControls } from "../ui/VoteControls";
import { BookmarkButton } from "../ui/BookmarkButton";
import { ShareButton } from "../ui/ShareButton";
import type { QuoteTarget } from "../../lib/publishNote";
import {
  formatDateRelative,
  truncateText,
  stripMarkdown,
} from "../../lib/format";
import { TrustPip } from "../ui/TrustPip";
import { useCompose } from "../../stores/compose";
import { AuthorModal, useAuthorHover } from "./AuthorModal";
import { ActionSheet } from "./ActionSheet";

interface ArticleCardProps {
  article: ArticleEvent;
  onQuote?: (target: QuoteTarget) => void;
  voteTally?: VoteTally;
  myVoteCounts?: MyVoteCount;
  isBookmarked?: boolean;
  twoUp?: boolean;
}

export function ArticleCard({
  article,
  onQuote,
  voteTally,
  myVoteCounts,
  isBookmarked,
  twoUp = false,
}: ArticleCardProps) {
  const { user } = useAuth();
  const router = useRouter();
  const writerInfo = useWriterName(article.pubkey);
  const openCompose = useCompose((s) => s.open);
  const hover = useAuthorHover("native", article.authorId ?? null);
  const [replyCount, setReplyCount] = useState<number | null>(null);
  const wordCount = article.content.split(/\s+/).length;
  const readMinutes = Math.max(1, Math.round(wordCount / 200));
  const sizeTier = article.sizeTier ?? "standard";
  const isBrief = sizeTier === "brief";
  const excerpt = isBrief
    ? ""
    : article.summary || truncateText(stripMarkdown(article.content), 200);

  useEffect(() => {
    repliesApi
      .getForTarget(article.id)
      .then((d) => setReplyCount(d.totalCount))
      .catch((err) => console.error("Failed to load reply count", err));
  }, [article.id]);

  const [expanded, setExpanded] = useState(false);
  const [bookmarked, setBookmarked] = useState(isBookmarked ?? false);

  const handleBodyExpand = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded((prev) => !prev);
  }, []);

  function handleQuote(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    onQuote?.({
      eventId: article.id,
      eventKind: 30023,
      authorPubkey: article.pubkey,
      previewTitle: article.title,
      previewContent: article.summary,
      previewAuthorName:
        writerInfo?.displayName ?? article.pubkey.slice(0, 8) + "\u2026",
    });
  }

  function handleReply(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    openCompose("reply", {
      eventId: article.id,
      eventKind: 30023,
      authorPubkey: article.pubkey,
      previewTitle: article.title,
      previewContent: article.summary,
      previewAuthorName:
        writerInfo?.displayName ?? article.pubkey.slice(0, 8) + "\u2026",
    });
  }

  const authorHref = writerInfo?.username ? `/${writerInfo.username}` : null;
  const isPaid = article.isPaywalled;
  const barColor = isPaid ? "var(--ah-crimson)" : "var(--ah-ink)";

  // Per-tier typography. Two-up briefs shrink byline/action to 10.5px per spec §4a.
  const headlineClass =
    sizeTier === "lead"
      ? "text-[30px]"
      : sizeTier === "brief"
        ? "text-[20px]"
        : "text-[22px]";
  const excerptSize = sizeTier === "lead" ? "text-[16px]" : "text-[15.5px]";
  const metaSize = twoUp ? "text-[10.5px]" : "text-[11px]";
  const showExtendedActions = !twoUp; // share, bookmark, quote only on full-width cards

  return (
    <div
      className="group"
      style={{ borderLeft: `4px solid ${barColor}`, paddingLeft: "24px" }}
    >
      {/* Byline — mono-caps, grey-600 */}
      <div
        className={`flex items-center gap-2 mb-3 font-mono ${metaSize} uppercase tracking-[0.06em] text-grey-600`}
      >
        <TrustPip status={article.pipStatus} />
        <span
          ref={hover.bylineRef as React.RefObject<HTMLSpanElement>}
          onMouseEnter={hover.onMouseEnter}
          onMouseLeave={hover.onMouseLeave}
        >
          {authorHref ? (
            <ProfileLink
              href={authorHref}
              className="hover:text-black transition-colors"
            >
              {writerInfo?.displayName ?? article.pubkey.slice(0, 12) + "..."}
            </ProfileLink>
          ) : (
            <span>
              {writerInfo?.displayName ?? article.pubkey.slice(0, 12) + "..."}
            </span>
          )}
        </span>
        {hover.open && hover.id && (
          <AuthorModal
            type="native"
            id={hover.id}
            anchorRef={hover.bylineRef}
            onClose={hover.onModalClose}
            onMouseEnter={hover.onModalMouseEnter}
            onMouseLeave={hover.onModalMouseLeave}
          />
        )}
        <span>·</span>
        <time
          dateTime={new Date(article.publishedAt * 1000).toISOString()}
          className="tracking-[0.02em]"
        >
          {formatDateRelative(article.publishedAt)}
        </time>
        {isPaid && article.pricePence && (
          <>
            <span>·</span>
            <span className="tracking-[0.02em] text-crimson">
              £{(article.pricePence / 100).toFixed(2)}
            </span>
          </>
        )}
      </div>

      {/* Headline — Literata italic, navigates to article */}
      <Link
        href={`/article/${article.dTag}`}
        className={`block font-serif ${headlineClass} font-medium italic text-black leading-[1.18] tracking-[-0.02em] ${isBrief ? "mb-3" : "mb-2"} hover:text-crimson-dark transition-colors cursor-pointer`}
      >
        {article.title}
      </Link>

      {/* Body — click to expand neighbourhood (Phase 2) */}
      { }
      <div onClick={handleBodyExpand} className="cursor-pointer">
        {/* Excerpt — Literata roman (omitted for briefs) */}
        {!isBrief && (
          <p
            className={`font-serif ${excerptSize} text-grey-600 leading-[1.65] mb-4`}
            style={{ maxWidth: "540px" }}
          >
            {excerpt}
          </p>
        )}

        {/* Tags — omitted for briefs */}
        {!isBrief && article.topicTags && article.topicTags.length > 0 && (
          <div className="flex items-center gap-1.5 mb-3 label-ui text-grey-600">
            {article.topicTags.map((tag, i) => (
              <span key={tag} className="flex items-center gap-1.5">
                {i > 0 && <span>&middot;</span>}
                <Link
                  href={`/tag/${tag}`}
                  onClick={(e) => e.stopPropagation()}
                  className="hover:text-black transition-colors"
                >
                  {tag}
                </Link>
              </span>
            ))}
          </div>
        )}
      </div>
      {/* End body expand region */}

      {/* Action row — mono-caps, grey-600 */}
      <div
        className={`flex items-center gap-3 font-mono ${metaSize} uppercase tracking-[0.02em] text-grey-600`}
      >
        <span>{readMinutes} min read</span>
        {replyCount !== null && replyCount > 0 && (
          <>
            <span className="opacity-50">·</span>
            <span>
              {replyCount} {replyCount !== 1 ? "replies" : "reply"}
            </span>
          </>
        )}
        <span className="flex-1" />
        {user && (
          <button
            onClick={handleReply}
            className="text-grey-600 hover:text-black transition-colors"
          >
            Reply
          </button>
        )}
        {/* Desktop: inline secondary actions; Touch: behind ⋯ */}
        <span className="hidden [@media(hover:hover)]:contents group-focus-within:contents">
          {showExtendedActions && user && onQuote && (
            <button
              onClick={handleQuote}
              className="text-grey-600 hover:text-black transition-colors"
            >
              Quote
            </button>
          )}
        </span>
        <span onClick={(e) => e.stopPropagation()}>
          <VoteControls
            targetEventId={article.id}
            targetKind={30023}
            isOwnContent={user?.pubkey === article.pubkey}
            initialTally={voteTally}
            initialMyVotes={myVoteCounts}
          />
        </span>
        <span className="hidden [@media(hover:hover)]:contents group-focus-within:contents">
          {showExtendedActions && (
            <>
              <span onClick={(e) => e.stopPropagation()}>
                <BookmarkButton
                  articleId={article.id}
                  initialBookmarked={isBookmarked}
                />
              </span>
              <span onClick={(e) => e.stopPropagation()}>
                <ShareButton
                  url={`/article/${article.dTag}`}
                  title={article.title}
                />
              </span>
            </>
          )}
        </span>
        <span
          className="[@media(hover:hover)]:hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {showExtendedActions && (
            <ActionSheet
              actions={[
                ...(user && onQuote
                  ? [{ label: "QUOTE", onClick: handleQuote }]
                  : []),
                {
                  label: bookmarked ? "UNBOOKMARK" : "BOOKMARK",
                  onClick: () => {
                    const prev = bookmarked;
                    setBookmarked(!prev);
                    (prev
                      ? bookmarks.remove(article.id)
                      : bookmarks.add(article.id)
                    ).catch(() => setBookmarked(prev));
                  },
                  hidden: !user,
                },
                {
                  label: "SHARE",
                  onClick: () => {
                    void navigator.clipboard?.writeText(
                      `${window.location.origin}/article/${article.dTag}`,
                    );
                  },
                },
              ]}
            />
          )}
        </span>
      </div>

      {/* Neighbourhood — reply thread on expansion */}
      {expanded && (
        <div className="mt-2">
          <ReplySection
            targetEventId={article.id}
            targetKind={30023}
            targetAuthorPubkey={article.pubkey}
            compact
            previewLimit={5}
            composerOpen={false}
          />
        </div>
      )}
    </div>
  );
}

"use client";

import { useState, useEffect, useRef, useLayoutEffect } from "react";
import Link from "next/link";
import { ProfileLink } from "../ui/ProfileLink";
import type { NoteEvent } from "../../lib/ndk";
import { useWriterName } from "../../hooks/useWriterName";
import { useAuth } from "../../stores/auth";
import { useCompose } from "../../stores/compose";
import { stripMediaUrls } from "../../lib/media";
import { MediaContent } from "../ui/MediaContent";
import { ReplySection } from "../replies/ReplySection";
import { QuoteCard } from "./QuoteCard";
import { VoteControls } from "../ui/VoteControls";
import type { QuoteTarget } from "../../lib/publishNote";
import { formatDateRelative } from "../../lib/format";
import { content as contentApi, type VoteTally, type MyVoteCount } from "../../lib/api";
import type { ResolvedContent } from "../../lib/api/articles";
import { TrustPip } from "../ui/TrustPip";
import { AuthorModal, useAuthorHover } from "./AuthorModal";
import { ActionSheet } from "./ActionSheet";
import { NativeParentCard, NeighbourhoodSkeleton } from "./NeighbourhoodCard";

interface NoteCardProps {
  note: NoteEvent;
  onDeleted?: (id: string) => void;
  onQuote?: (target: QuoteTarget) => void;
  voteTally?: VoteTally;
  myVoteCounts?: MyVoteCount;
  // Render the downward reply thread under the card (default true). The profile
  // Replies list passes false — each entry is already a leaf in that view and
  // hydrating a sub-thread per row would be a needless fan-out of fetches.
  showReplyThread?: boolean;
}

// Hydrate a native parent (note or article) for conversational-neighbourhood
// expansion. Cached module-wide so a popular parent is resolved once per
// session, mirroring the external useNeighbourhood cache.
const nativeParentCache = new Map<string, ResolvedContent | null>();

function useNativeParent(eventId: string | undefined, enabled: boolean) {
  const [parent, setParent] = useState<ResolvedContent | null>(() =>
    eventId ? (nativeParentCache.get(eventId) ?? null) : null,
  );
  const [loading, setLoading] = useState(false);
  const fetched = useRef(false);

  useEffect(() => {
    if (!enabled || !eventId || fetched.current) return;
    if (nativeParentCache.has(eventId)) {
      setParent(nativeParentCache.get(eventId) ?? null);
      return;
    }
    fetched.current = true;
    setLoading(true);
    contentApi
      .resolve(eventId)
      .then((res) => {
        nativeParentCache.set(eventId, res);
        setParent(res);
      })
      .catch(() => {
        // 404 (e.g. parent is itself a comment, which /content/resolve does not
        // resolve) or transient failure — degrade to no parent card; the
        // provenance line still signals that a parent exists.
        nativeParentCache.set(eventId, null);
        setParent(null);
      })
      .finally(() => setLoading(false));
  }, [enabled, eventId]);

  return { parent, loading };
}

function ExcerptPennant({ note }: { note: NoteEvent }) {
  const [articleDTag, setArticleDTag] = useState<string | null>(null);
  const [authorUsername, setAuthorUsername] = useState<string | null>(null);
  const [isPaid, setIsPaid] = useState(false);

  useEffect(() => {
    if (!note.quotedEventId) return;
    contentApi
      .resolve(note.quotedEventId)
      .then((data) => {
        if (data?.dTag) setArticleDTag(data.dTag);
        if (data?.author?.username && data.author.username.length < 40)
          setAuthorUsername(data.author.username);
        if (data?.isPaywalled) setIsPaid(true);
      })
      .catch((err) =>
        console.error("Failed to load quoted article metadata", err),
      );
  }, [note.quotedEventId]);

  const href = articleDTag
    ? `/article/${articleDTag}`
    : authorUsername
      ? `/${authorUsername}`
      : "#";
  const barColor = isPaid ? "var(--ah-crimson)" : "var(--ah-ink)";

  return (
    <Link
      href={href}
      onClick={(e) => {
        e.stopPropagation();
        if (href === "#") e.preventDefault();
      }}
      className="block mt-2.5 hover:opacity-80 transition-opacity"
      style={{
        borderLeft: `4px solid ${barColor}`,
        paddingLeft: "20px",
        paddingTop: "8px",
        paddingBottom: "8px",
      }}
    >
      <p className="font-serif italic text-[14px] text-grey-600 leading-[1.5]">
        {note.quotedExcerpt}
      </p>
      {(note.quotedTitle || note.quotedAuthor) && (
        <p className="font-mono text-[10px] uppercase tracking-[0.02em] text-grey-600 mt-1">
          {note.quotedTitle ?? ""}
          {note.quotedTitle && note.quotedAuthor ? " · " : ""}
          {note.quotedAuthor && authorUsername ? (
            <span
              className="hover:underline underline-offset-2 cursor-pointer"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                window.location.href = `/${authorUsername}`;
              }}
            >
              {note.quotedAuthor}
            </span>
          ) : (
            (note.quotedAuthor ?? "")
          )}
        </p>
      )}
    </Link>
  );
}

export function NoteCard({
  note,
  onDeleted,
  onQuote,
  voteTally,
  myVoteCounts,
  showReplyThread = true,
}: NoteCardProps) {
  const { user } = useAuth();
  const writerInfo = useWriterName(note.pubkey);
  const openCompose = useCompose((s) => s.open);
  const hover = useAuthorHover("native", note.authorId ?? null);
  const [replyCount, setReplyCount] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isAuthor = user?.pubkey === note.pubkey;

  // Event kind of this card. Notes are kind 1; comments surfaced through
  // NoteCard (profile Replies) pass 1111 so vote/quote/delete stay correct.
  const eventKind = note.kind ?? 1;

  const [expanded, setExpanded] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const prevExpandedRef = useRef(false);

  // Conversational-neighbourhood parent (\u00a7V). Hydrated on first expand when
  // this card is a reply with a resolvable native parent.
  const { parent: nativeParent, loading: parentLoading } = useNativeParent(
    note.replyToEventId,
    expanded && !!note.isReply,
  );

  // Keep the anchor card fixed when the parent appears above it \u2014 the reader
  // must not lose their place (\u00a7V.1). Mirrors ExternalCard's scroll-stabiliser.
  useLayoutEffect(() => {
    if (expanded && !prevExpandedRef.current && anchorRef.current) {
      const savedTop = anchorRef.current.getBoundingClientRect().top;
      requestAnimationFrame(() => {
        if (!anchorRef.current) return;
        const delta = anchorRef.current.getBoundingClientRect().top - savedTop;
        if (Math.abs(delta) > 1) window.scrollBy(0, delta);
      });
    }
    prevExpandedRef.current = expanded;
  }, [expanded, nativeParent, parentLoading]);

  const { displayText: displayContent } = stripMediaUrls(note.content);

  async function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    setDeleting(true);
    try {
      // Comments (kind 1111) carry a db id and delete via the replies route;
      // kind-1 notes delete by event id via the notes route.
      const url = note.dbId
        ? `/api/v1/replies/${note.dbId}`
        : `/api/v1/notes/${note.id}`;
      const res = await fetch(url, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) {
        onDeleted?.(note.id);
      } else {
        setConfirmDelete(false);
      }
    } catch {
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  }

  function handleQuote() {
    onQuote?.({
      eventId: note.id,
      eventKind,
      authorPubkey: note.pubkey,
      previewContent: displayContent.slice(0, 200),
      previewAuthorName:
        writerInfo?.displayName ?? note.pubkey.slice(0, 8) + "\u2026",
    });
  }

  function handleReply() {
    openCompose("reply", {
      eventId: note.id,
      eventKind,
      authorPubkey: note.pubkey,
      previewContent: displayContent.slice(0, 200),
      previewAuthorName:
        writerInfo?.displayName ?? note.pubkey.slice(0, 8) + "\u2026",
    });
  }

  function handleBodyExpand(e: React.MouseEvent) {
    e.stopPropagation();
    setExpanded((prev) => !prev);
  }

  const authorHref = writerInfo?.username ? `/${writerInfo.username}` : null;
  const showParentSlot = expanded && !!note.isReply && !!note.replyToEventId;

  return (
    <div>
      {/* Neighbourhood \u2014 native parent rendered above the anchor (\u00a7V.1) */}
      {showParentSlot && parentLoading && <NeighbourhoodSkeleton />}
      {showParentSlot && nativeParent && (
        <div className="ml-8 mb-1">
          <NativeParentCard item={nativeParent} />
        </div>
      )}

      {/* Anchor card \u2014 stays put when the parent expands above it */}
      <div
        ref={anchorRef}
        className="group"
        style={{ borderLeft: "4px solid var(--ah-ink)", paddingLeft: "24px" }}
      >
        {/* Provenance — reply signalling */}
        {note.isReply && (
          <div className="label-ui text-grey-600 mb-1">
            ↳ REPLYING TO{" "}
            {note.replyToAuthor ? `@${note.replyToAuthor}` : "A POST"}
          </div>
        )}

        {/* Byline — mono-caps, grey-600, matching ArticleCard */}
        <div className="flex items-center gap-2 mb-2">
          <TrustPip status={note.pipStatus} />
          <span
            ref={hover.bylineRef as React.RefObject<HTMLSpanElement>}
            onMouseEnter={hover.onMouseEnter}
            onMouseLeave={hover.onMouseLeave}
          >
            {authorHref ? (
              <ProfileLink
                href={authorHref}
                className="label-ui text-grey-600 hover:text-black transition-colors"
              >
                {writerInfo?.displayName ?? note.pubkey.slice(0, 12) + "..."}
              </ProfileLink>
            ) : (
              <span className="label-ui text-grey-600">
                {writerInfo?.displayName ?? note.pubkey.slice(0, 12) + "..."}
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
          <span className="font-mono text-mono-xs text-grey-600">&middot;</span>
          <span className="font-mono text-[11px] uppercase tracking-[0.02em] text-grey-600">
            {formatDateRelative(note.publishedAt)}
          </span>
          {isAuthor && (
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="ml-auto px-2.5 py-0.5 disabled:opacity-40 transition-colors font-mono text-[11px] uppercase"
              style={
                confirmDelete
                  ? { color: "var(--ah-crimson)", fontWeight: 500 }
                  : { color: "var(--ah-grey-600)" }
              }
            >
              {deleting ? "..." : confirmDelete ? "Confirm?" : "Delete"}
            </button>
          )}
        </div>

        {/* Body — click to expand neighbourhood (Phase 2).
            INTERIM (CARD-BEHAVIOUR-ADR §IV): notes have no headline/permalink
            region, so the body click expands rather than navigating to a
            permalink. Replace with a permalink-navigating headline once a note
            permalink page exists (cf. ExternalCard's headline). */}
        { }
        <div onClick={handleBodyExpand} className="cursor-pointer">
          {/* Content + media */}
          <div className="mt-1">
            <MediaContent
              content={note.content}
              variant="note"
              textClassName="whitespace-pre-wrap font-sans text-[15px] text-black leading-[1.55]"
            />
          </div>

          {/* Quoted content */}
          {note.quotedExcerpt ? (
            <ExcerptPennant note={note} />
          ) : note.quotedEventId ? (
            <QuoteCard eventId={note.quotedEventId} />
          ) : null}
        </div>

        {/* Action labels — mono-caps, grey-600 */}
        <div className="mt-3 flex items-center gap-4 font-mono text-[11px] uppercase tracking-[0.02em] text-grey-600">
          <button
            onClick={handleReply}
            className="hover:text-black transition-colors"
          >
            {replyCount > 0 ? `Reply (${replyCount})` : "Reply"}
          </button>
          <span className="hidden [@media(hover:hover)]:contents group-focus-within:contents">
            {user && onQuote && (
              <button
                onClick={handleQuote}
                className="hover:text-black transition-colors"
              >
                Quote
              </button>
            )}
          </span>
          <VoteControls
            targetEventId={note.id}
            targetKind={eventKind}
            isOwnContent={isAuthor}
            initialTally={voteTally}
            initialMyVotes={myVoteCounts}
          />
          <span
            className="[@media(hover:hover)]:hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {user && onQuote && (
              <ActionSheet
                actions={[{ label: "QUOTE", onClick: handleQuote }]}
              />
            )}
          </span>
        </div>

        {/* Reply thread — expanded shows full thread, collapsed shows preview */}
        {showReplyThread && (
          <div className="mt-2">
            <ReplySection
              targetEventId={note.id}
              targetKind={eventKind}
              targetAuthorPubkey={note.pubkey}
              compact
              previewLimit={expanded ? undefined : 3}
              composerOpen={false}
              onReplyCountLoaded={setReplyCount}
            />
          </div>
        )}
      </div>
      {/* End anchor card */}
    </div>
  );
}

"use client";

import { useState, useEffect, useCallback } from "react";
import { NoteCard } from "../feed/NoteCard";
import type { WriterProfile, VoteTally, MyVoteCount } from "../../lib/api";
import type { NoteEvent } from "../../lib/ndk";
import type { QuoteTarget } from "../../lib/publishNote";

interface DbNote {
  id: string;
  nostrEventId: string;
  content: string;
  publishedAt: string;
  quotedEventId?: string;
  quotedEventKind?: number;
  quotedExcerpt?: string;
  quotedTitle?: string;
  quotedAuthor?: string;
}

interface DbReply {
  id: string;
  nostrEventId: string;
  content: string;
  publishedAt: string;
  isDeleted: boolean;
  targetKind: number;
  targetEventId: string | null;
  articleSlug: string | null;
  articleTitle: string | null;
  articleAuthorUsername: string | null;
  articleAuthorDisplayName: string | null;
  parentEventId: string | null;
  parentAuthorUsername: string | null;
  parentAuthorDisplayName: string | null;
}

interface SocialTabProps {
  username: string;
  writer: WriterProfile;
  isOwnProfile: boolean;
  onQuote?: (target: QuoteTarget) => void;
}

export function SocialTab({ username, writer, onQuote }: SocialTabProps) {
  const [notes, setNotes] = useState<DbNote[]>([]);
  const [replies, setReplies] = useState<DbReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [voteTallies, setVoteTallies] = useState<Record<string, VoteTally>>({});
  const [myVoteCounts, setMyVoteCounts] = useState<Record<string, MyVoteCount>>(
    {},
  );

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const [notesRes, repliesRes] = await Promise.all([
          fetch(`/api/v1/writers/${username}/notes?limit=50`, {
            credentials: "include",
          }),
          fetch(`/api/v1/writers/${username}/replies?limit=50`, {
            credentials: "include",
          }),
        ]);

        const loadedNotes: DbNote[] = [];
        const loadedReplies: DbReply[] = [];

        if (notesRes.ok) {
          const data = await notesRes.json();
          loadedNotes.push(...(data.notes ?? []));
        }
        if (repliesRes.ok) {
          const data = await repliesRes.json();
          loadedReplies.push(...(data.replies ?? []));
        }

        setNotes(loadedNotes);
        setReplies(loadedReplies);

        // Fetch vote tallies
        const eventIds = [
          ...loadedNotes.map((n) => n.nostrEventId),
          ...loadedReplies.map((r) => r.nostrEventId),
        ];
        if (eventIds.length > 0) {
          const idsParam = eventIds.join(",");
          const [talliesRes, myVotesRes] = await Promise.all([
            fetch(`/api/v1/votes/tally?eventIds=${idsParam}`)
              .then((r) => (r.ok ? r.json() : { tallies: {} }))
              .catch(() => ({ tallies: {} })),
            fetch(`/api/v1/votes/mine?eventIds=${idsParam}`, {
              credentials: "include",
            })
              .then((r) => (r.ok ? r.json() : { voteCounts: {} }))
              .catch(() => ({ voteCounts: {} })),
          ]);
          setVoteTallies(talliesRes.tallies ?? {});
          setMyVoteCounts(myVotesRes.voteCounts ?? {});
        }
      } catch {
        /* silently fail */
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, [username]);

  const handleNoteDeleted = useCallback((id: string) => {
    setNotes((prev) => prev.filter((n) => n.nostrEventId !== id));
  }, []);

  const handleReplyDeleted = useCallback((id: string) => {
    setReplies((prev) => prev.filter((r) => r.nostrEventId !== id));
  }, []);

  if (loading) {
    return (
      <div className="py-10 text-center text-ui-sm text-grey-300">
        Loading...
      </div>
    );
  }

  const hasNotes = notes.length > 0;
  const hasReplies = replies.length > 0;

  if (!hasNotes && !hasReplies) {
    return (
      <p className="text-ui-sm text-grey-400 py-10">No notes or replies yet.</p>
    );
  }

  return (
    <div>
      {/* Notes section */}
      {hasNotes && (
        <>
          <h3 className="label-ui text-grey-300 mb-4">Notes</h3>
          <div className="space-y-3">
            {notes.map((n) => {
              const noteEvent: NoteEvent = {
                type: "note",
                id: n.nostrEventId,
                pubkey: writer.pubkey,
                content: n.content,
                publishedAt: Math.floor(
                  new Date(n.publishedAt).getTime() / 1000,
                ),
                quotedEventId: n.quotedEventId,
                quotedEventKind: n.quotedEventKind,
                quotedExcerpt: n.quotedExcerpt,
                quotedTitle: n.quotedTitle,
                quotedAuthor: n.quotedAuthor,
              };
              return (
                <NoteCard
                  key={n.id}
                  note={noteEvent}
                  onDeleted={handleNoteDeleted}
                  onQuote={onQuote}
                  voteTally={voteTallies[n.nostrEventId]}
                  myVoteCounts={myVoteCounts[n.nostrEventId]}
                />
              );
            })}
          </div>
        </>
      )}

      {/* Replies section */}
      {hasReplies && (
        <>
          {hasNotes && <div className="rule-inset my-8" />}
          <h3 className="label-ui text-grey-300 mb-4">Replies</h3>
          <div className="space-y-3">
            {replies.map((r) => {
              // A profile reply is a kind-1111 comment. Render it through the
              // unified NoteCard: provenance line + parent-above on expand
              // (the article/note it replies to, resolved from targetEventId),
              // with correct comment semantics (kind 1111, delete via dbId).
              const replyEvent: NoteEvent = {
                type: "note",
                id: r.nostrEventId,
                pubkey: writer.pubkey,
                content: r.content,
                publishedAt: Math.floor(
                  new Date(r.publishedAt).getTime() / 1000,
                ),
                isReply: true,
                replyToAuthor:
                  r.parentAuthorDisplayName ??
                  r.parentAuthorUsername ??
                  r.articleAuthorDisplayName ??
                  r.articleAuthorUsername ??
                  undefined,
                replyToEventId: r.targetEventId ?? undefined,
                kind: 1111,
                dbId: r.id,
              };
              return (
                <NoteCard
                  key={r.id}
                  note={replyEvent}
                  onDeleted={handleReplyDeleted}
                  onQuote={onQuote}
                  showReplyThread={false}
                  voteTally={voteTallies[r.nostrEventId]}
                  myVoteCounts={myVoteCounts[r.nostrEventId]}
                />
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

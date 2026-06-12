"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { PostCardInteractive } from "../post/PostCardInteractive";
import { PostThread } from "../post/PostThread";
import type { CardContext } from "../post/chassis";
import {
  PALETTES,
  DEFAULT_BRIGHTNESS,
  DEFAULT_DENSITY,
  DEFAULT_TEXT_SIZE,
  TEXT_SIZE_PX,
} from "../workspace/tokens";
import { authorPosts, authorReplies } from "../../lib/api/post";
import type { Post } from "../../lib/post/types";
import type { WriterProfile } from "../../lib/api";
import { useCompose } from "../../stores/compose";

// =============================================================================
// Profile Social tab — the writer's notes + replies, rendered through the one
// Post-model path (PostCardInteractive / PostThread), the same as the workspace
// and the constructed author profile. Notes come from GET /author/:id/posts?
// kind=note; replies (kind-1111 comments, which aren't feed_items) from
// GET /author/:id/replies. Each card expands inline to the unified thread
// (parent context above) instead of the old "→ replied to X" provenance line.
// =============================================================================

const CTX: CardContext = {
  density: DEFAULT_DENSITY,
  palette: PALETTES[DEFAULT_BRIGHTNESS],
  bodyPx: TEXT_SIZE_PX[DEFAULT_TEXT_SIZE],
};

interface SocialTabProps {
  username: string;
  writer: WriterProfile;
  isOwnProfile: boolean;
}

export function SocialTab({ writer, isOwnProfile }: SocialTabProps) {
  const router = useRouter();
  const [notes, setNotes] = useState<Post[]>([]);
  const [replies, setReplies] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      authorPosts(writer.id, undefined, "note", 50),
      authorReplies(writer.id, undefined, 50),
    ])
      .then(([notesRes, repliesRes]) => {
        if (cancelled) return;
        setNotes(notesRes.items);
        setReplies(repliesRes.items);
      })
      .catch(() => {
        /* silently fail */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [writer.id]);

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const openReader = useCallback(
    (p: Post) => {
      if (p.author.pubkey) {
        if (p.dTag) router.push(`/article/${p.dTag}`);
      } else {
        router.push(`/reader/${p.id}`);
      }
    },
    [router],
  );

  const replyFromPost = useCallback((p: Post) => {
    if (!p.author.pubkey) return;
    useCompose.getState().open("reply", {
      eventId: p.version ?? p.id,
      eventKind: p.type === "article" ? 30023 : 1,
      authorPubkey: p.author.pubkey,
      previewContent: (p.body.text ?? "").slice(0, 120),
    });
  }, []);

  const renderPost = useCallback(
    (post: Post) =>
      expanded.has(post.id) && post.type !== "article" ? (
        <PostThread
          key={post.id}
          rootPostId={post.id}
          ctx={CTX}
          onCollapse={() => toggleExpand(post.id)}
          onReply={replyFromPost}
          onOpenReader={openReader}
        />
      ) : (
        <PostCardInteractive
          key={post.id}
          post={post}
          level="feed"
          expanded={false}
          ctx={CTX}
          isOwnContent={isOwnProfile}
          onExpand={() => toggleExpand(post.id)}
          onOpenReader={openReader}
          onReply={post.author.pubkey ? () => replyFromPost(post) : undefined}
        />
      ),
    [expanded, isOwnProfile, openReader, replyFromPost, toggleExpand],
  );

  if (loading) {
    return (
      <div className="py-10 text-center text-ui-sm text-grey-600">
        Loading...
      </div>
    );
  }

  const hasNotes = notes.length > 0;
  const hasReplies = replies.length > 0;

  if (!hasNotes && !hasReplies) {
    return (
      <p className="text-ui-sm text-grey-600 py-10">No notes or replies yet.</p>
    );
  }

  return (
    <div>
      {hasNotes && (
        <>
          <h3 className="label-ui text-grey-600 mb-4">Notes</h3>
          <div className="space-y-[40px]">{notes.map(renderPost)}</div>
        </>
      )}

      {hasReplies && (
        <>
          {hasNotes && <div className="rule-inset my-8" />}
          <h3 className="label-ui text-grey-600 mb-4">Replies</h3>
          <div className="space-y-[40px]">{replies.map(renderPost)}</div>
        </>
      )}
    </div>
  );
}

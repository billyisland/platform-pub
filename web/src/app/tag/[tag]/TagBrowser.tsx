"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { PostCardInteractive } from "../../../components/post/PostCardInteractive";
import type { CardContext } from "../../../components/post/chassis";
import {
  PALETTES,
  DEFAULT_BRIGHTNESS,
  DEFAULT_DENSITY,
  DEFAULT_TEXT_SIZE,
  TEXT_SIZE_PX,
} from "../../../components/workspace/tokens";
import { tagPosts } from "../../../lib/api/post";
import type { Post } from "../../../lib/post/types";
import { useReader } from "../../../stores/reader";
import { useCompose } from "../../../stores/compose";

// =============================================================================
// /tag/:name — articles for one tag, rendered through the one Post-model path
// (PostCardInteractive), the same as SourceSurface / AuthorProfileView
// (FEED-RETIREMENT Slice 4). Tags are article-only, so every row is an article
// card opening the reader; there is no thread expansion here.
//
// `inOverlay` is set when TagBrowser renders inside the surface overlay
// (useSurfaceOverlay): article rows open the reader overlay in place rather than
// navigating to /article/:dTag and escaping the workspace to the black topbar.
// The standalone /tag/[tag] page leaves it false (full-page navigation).
// =============================================================================

const CTX: CardContext = {
  density: DEFAULT_DENSITY,
  palette: PALETTES[DEFAULT_BRIGHTNESS],
  bodyPx: TEXT_SIZE_PX[DEFAULT_TEXT_SIZE],
};

export function TagBrowser({
  tagName,
  inOverlay = false,
}: {
  tagName: string;
  inOverlay?: boolean;
}) {
  const router = useRouter();
  const openNative = useReader((s) => s.openNative);
  const [items, setItems] = useState<Post[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    tagPosts(tagName)
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setTotal(res.total);
        setCursor(res.nextCursor);
      })
      .catch(() => {
        /* silent */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tagName]);

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    tagPosts(tagName, cursor)
      .then((res) => {
        setItems((prev) => [...prev, ...res.items]);
        setCursor(res.nextCursor);
      })
      .catch(() => {
        /* silent */
      })
      .finally(() => setLoadingMore(false));
  }, [tagName, cursor, loadingMore]);

  // In the overlay, open the reader in place; on the standalone page navigate.
  const openReader = useCallback(
    (p: Post) => {
      if (!p.dTag) return;
      if (inOverlay) openNative(p.dTag, { postId: p.id });
      else router.push(`/article/${p.dTag}`);
    },
    [inOverlay, openNative, router],
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

  return (
    <div className="mx-auto max-w-feed px-4 sm:px-6 py-12">
      <h1 className="font-mono text-2xl uppercase tracking-[0.02em] text-black">
        #{tagName}
      </h1>
      <p className="label-ui text-grey-600 mt-1 mb-10">
        {total} article{total !== 1 ? "s" : ""}
      </p>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-20 animate-pulse bg-white" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="py-20 text-center">
          <p className="text-ui-sm text-grey-600">
            #{tagName} — No articles yet.
          </p>
        </div>
      ) : (
        <div className="space-y-[40px]">
          {items.map((post) => (
            <PostCardInteractive
              key={post.id}
              post={post}
              level="feed"
              ctx={CTX}
              onOpenReader={openReader}
              onReply={
                post.author.pubkey ? () => replyFromPost(post) : undefined
              }
            />
          ))}

          {cursor && (
            <div className="pt-8 text-center">
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="btn-text-muted"
              >
                {loadingMore ? "LOADING…" : "SHOW MORE"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageShell } from "../../../components/ui/PageShell";
import { PostCardInteractive } from "../../../components/post/PostCardInteractive";
import { PostThread } from "../../../components/post/PostThread";
import type { CardContext } from "../../../components/post/chassis";
import {
  PALETTES,
  DEFAULT_BRIGHTNESS,
  DEFAULT_DENSITY,
  DEFAULT_TEXT_SIZE,
  TEXT_SIZE_PX,
} from "../../../components/workspace/tokens";
import { sources, type SourceMeta } from "../../../lib/api/feeds";
import type { Post } from "../../../lib/post/types";
import { useCompose } from "../../../stores/compose";
import { ApiError } from "../../../lib/api/client";

// =============================================================================
// /source/:id — the external source surface (CARD-BEHAVIOUR-ADR §VI.2).
//
// Source meta header + a chronological full-view PostCard log from
// GET /sources/:id. Rendered through the one Post-model path (PostCardInteractive
// / PostThread), exactly like AuthorProfileView — external posts expand inline to
// the unified thread; nothing routes out to the origin platform from a card body.
// Shared by the standalone /source/:id page and the workspace SurfaceOverlay.
// =============================================================================

const PROTOCOL_LABELS: Record<string, string> = {
  rss: "VIA RSS",
  atproto: "VIA BLUESKY",
  activitypub: "VIA FEDIVERSE",
  nostr_external: "VIA NOSTR",
  email: "VIA EMAIL",
};

const CTX: CardContext = {
  density: DEFAULT_DENSITY,
  palette: PALETTES[DEFAULT_BRIGHTNESS],
  bodyPx: TEXT_SIZE_PX[DEFAULT_TEXT_SIZE],
};

export function SourceSurface({ id }: { id: string }) {
  const router = useRouter();
  const [source, setSource] = useState<SourceMeta | null>(null);
  const [items, setItems] = useState<Post[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    setNotFound(false);
    sources
      .get(id)
      .then((res) => {
        if (cancelled) return;
        setSource(res.source);
        setItems(res.items);
        setCursor(res.nextCursor);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) setNotFound(true);
        else setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    sources
      .get(id, cursor)
      .then((res) => {
        setItems((prev) => [...prev, ...res.items]);
        setCursor(res.nextCursor);
      })
      .catch(() => setError(true))
      .finally(() => setLoadingMore(false));
  }, [id, cursor, loadingMore]);

  const toggleExpand = useCallback((postId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(postId)) next.delete(postId);
      else next.add(postId);
      return next;
    });
  }, []);

  // Article → its addressable reader page (no overlay is mounted off-workspace).
  const openReader = useCallback(
    (p: Post) => {
      if (p.author.pubkey) {
        if (p.dTag) router.push(`/article/${p.dTag}`);
      } else {
        router.push(`/read/${p.id}`);
      }
    },
    [router],
  );

  // Native reply via the global compose overlay (mounted in app/layout).
  const replyFromPost = useCallback((p: Post) => {
    if (!p.author.pubkey) return;
    useCompose.getState().open("reply", {
      eventId: p.version ?? p.id,
      eventKind: p.type === "article" ? 30023 : 1,
      authorPubkey: p.author.pubkey,
      previewContent: (p.body.text ?? "").slice(0, 120),
    });
  }, []);

  if (loading) {
    return (
      <PageShell width="feed">
        <div className="label-ui text-grey-600 py-12 text-center">LOADING…</div>
      </PageShell>
    );
  }

  if (notFound) {
    return (
      <PageShell width="feed" title="Source not found">
        <p className="font-sans text-ui-sm text-grey-600">
          This source isn&apos;t available.{" "}
          <Link href="/reader" className="btn-text">
            Back to workspace
          </Link>
        </p>
      </PageShell>
    );
  }

  if (error || !source) {
    return (
      <PageShell width="feed" title="Couldn’t load source">
        <p className="font-sans text-ui-sm text-grey-600">
          Something went wrong loading this source.
        </p>
      </PageShell>
    );
  }

  const protocolLabel =
    PROTOCOL_LABELS[source.protocol] ?? source.protocol.toUpperCase();
  const name = source.displayName ?? source.sourceUri;

  return (
    <PageShell width="feed">
      {/* Source header */}
      <div className="mb-8">
        <div className="label-ui text-grey-600 mb-1">{protocolLabel}</div>
        <h1 className="font-sans text-2xl font-medium text-black tracking-tight">
          {name}
        </h1>
        {source.description && (
          <p className="font-sans text-ui-sm text-grey-600 mt-2 max-w-feed">
            {source.description}
          </p>
        )}
      </div>

      {items.length === 0 ? (
        <div className="label-ui text-grey-600 py-12 text-center">
          NO ITEMS YET
        </div>
      ) : (
        <div className="space-y-[40px]">
          {items.map((post) =>
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
                onExpand={() => toggleExpand(post.id)}
                onOpenReader={openReader}
                onReply={
                  post.author.pubkey ? () => replyFromPost(post) : undefined
                }
              />
            ),
          )}
        </div>
      )}

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
    </PageShell>
  );
}

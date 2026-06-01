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
import {
  authorProfile,
  authorPosts,
  type AuthorProfile,
} from "../../../lib/api/post";
import type { Post } from "../../../lib/post/types";
import { useCompose } from "../../../stores/compose";
import { ApiError } from "../../../lib/api/client";

// =============================================================================
// /author/:authorId — the constructed author profile (UNIVERSAL-POST-ADR §4.4).
//
// Header from GET /author/:id/profile, a chronological full-view PostCard log
// from GET /author/:id/posts. Reached from a tier-A/B external byline (and works
// for native ids too, though native bylines route to /{username}). Native
// articles open at /article/<dTag>, external at /reader/<postId>; notes/external
// expand inline to the unified PostThread, exactly as in the workspace.
// =============================================================================

const PROTOCOL_LABELS: Record<string, string> = {
  rss: "VIA RSS",
  atproto: "VIA BLUESKY",
  activitypub: "VIA FEDIVERSE",
  nostr_external: "VIA NOSTR",
  nostr: "ALL.HAUS",
  email: "VIA EMAIL",
};

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const CTX: CardContext = {
  density: DEFAULT_DENSITY,
  palette: PALETTES[DEFAULT_BRIGHTNESS],
  bodyPx: TEXT_SIZE_PX[DEFAULT_TEXT_SIZE],
};

export function AuthorProfileView({ authorId }: { authorId: string }) {
  const router = useRouter();
  const [profile, setProfile] = useState<AuthorProfile | null>(null);
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
    Promise.all([authorProfile(authorId), authorPosts(authorId)])
      .then(([prof, posts]) => {
        if (cancelled) return;
        setProfile(prof);
        setItems(posts.items);
        setCursor(posts.nextCursor);
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
  }, [authorId]);

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    authorPosts(authorId, cursor)
      .then((res) => {
        setItems((prev) => [...prev, ...res.items]);
        setCursor(res.nextCursor);
      })
      .catch(() => setError(true))
      .finally(() => setLoadingMore(false));
  }, [authorId, cursor, loadingMore]);

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Article → its addressable reader page (no overlay is mounted off-workspace).
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
        <div className="label-ui text-grey-400 py-12 text-center">LOADING…</div>
      </PageShell>
    );
  }

  if (notFound) {
    return (
      <PageShell width="feed" title="Author not found">
        <p className="font-sans text-ui-sm text-grey-600">
          This author isn&apos;t available.{" "}
          <Link href="/feed" className="btn-text">
            Back to feed
          </Link>
        </p>
      </PageShell>
    );
  }

  if (error || !profile) {
    return (
      <PageShell width="feed" title="Couldn’t load author">
        <p className="font-sans text-ui-sm text-grey-600">
          Something went wrong loading this profile.
        </p>
      </PageShell>
    );
  }

  const protocolLabel = profile.sourceProtocol
    ? (PROTOCOL_LABELS[profile.sourceProtocol] ??
      profile.sourceProtocol.toUpperCase())
    : null;
  const name = profile.displayName ?? profile.handle ?? "Author";
  const hasStats =
    profile.followerCount != null ||
    profile.followingCount != null ||
    profile.postCount != null;

  return (
    <PageShell width="feed">
      {/* Author header */}
      <div className="mb-8">
        {protocolLabel && (
          <div className="label-ui text-grey-400 mb-1">{protocolLabel}</div>
        )}
        <div className="flex items-start gap-3">
          {profile.avatarUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={profile.avatarUrl}
              alt=""
              className="w-12 h-12 rounded-full object-cover bg-grey-100 flex-shrink-0"
              referrerPolicy="no-referrer"
            />
          )}
          <div className="min-w-0">
            <h1 className="font-sans text-2xl font-medium text-black tracking-tight">
              {name}
            </h1>
            {profile.handle && (
              <p className="text-mono-xs text-grey-400">@{profile.handle}</p>
            )}
          </div>
        </div>
        {profile.bio && (
          <p className="font-sans text-ui-sm text-grey-600 mt-3 max-w-feed">
            {profile.bio}
          </p>
        )}
        {hasStats && (
          <div className="flex items-center gap-4 mt-3">
            {profile.followerCount != null && (
              <span className="text-mono-xs text-grey-600">
                <span className="font-medium text-black">
                  {formatCount(profile.followerCount)}
                </span>{" "}
                followers
              </span>
            )}
            {profile.followingCount != null && (
              <span className="text-mono-xs text-grey-600">
                <span className="font-medium text-black">
                  {formatCount(profile.followingCount)}
                </span>{" "}
                following
              </span>
            )}
            {profile.postCount != null && (
              <span className="text-mono-xs text-grey-600">
                <span className="font-medium text-black">
                  {formatCount(profile.postCount)}
                </span>{" "}
                posts
              </span>
            )}
          </div>
        )}
      </div>

      {items.length === 0 ? (
        <div className="label-ui text-grey-400 py-12 text-center">
          NO POSTS YET
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

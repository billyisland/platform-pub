"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { PostCardInteractive } from "../post/PostCardInteractive";
import { ProfileDriveCard } from "./ProfileDriveCard";
import type { CardContext } from "../post/chassis";
import {
  globalContentPalette,
  DEFAULT_DENSITY,
  DEFAULT_TEXT_SIZE,
  TEXT_SIZE_PX,
} from "../workspace/tokens";
import { authorPosts } from "../../lib/api/post";
import type { Post } from "../../lib/post/types";
import type { WriterProfile, PledgeDrive } from "../../lib/api";
import { useCompose } from "../../stores/compose";
import { useColorScheme } from "../../stores/colorScheme";
import { pledgesEnabled } from "../../lib/featureFlags";

// =============================================================================
// Profile Work tab — the writer's articles + pledge drives, rendered through the
// one Post-model path (PostCardInteractive), the same as the constructed author
// profile (AuthorProfileView). Articles come from GET /author/:id/posts?kind=
// article; pin state + the article db-id (for the pin toggle) are correlated by
// dTag from the legacy writers/articles endpoint, which still owns that metadata.
// =============================================================================

interface DbArticleMeta {
  id: string;
  dTag: string;
  pinnedOnProfile: boolean;
  profilePinOrder: number;
}

type WorkItem =
  | {
      kind: "article";
      publishedAt: number;
      pinned: boolean;
      pinOrder: number;
      post: Post;
      articleId: string | null;
    }
  | {
      kind: "drive";
      publishedAt: number;
      pinned: boolean;
      pinOrder: number;
      data: PledgeDrive;
    };

interface WorkTabProps {
  username: string;
  writer: WriterProfile;
  isOwnProfile: boolean;
}

export function WorkTab({ username, writer, isOwnProfile }: WorkTabProps) {
  const router = useRouter();
  const [items, setItems] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  // Content-log cards follow the GLOBAL light/dark toggle (not a feed scheme).
  const dark = useColorScheme((s) => s.dark);
  const CTX: CardContext = {
    density: DEFAULT_DENSITY,
    palette: globalContentPalette(dark),
    bodyPx: TEXT_SIZE_PX[DEFAULT_TEXT_SIZE],
  };

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [postsRes, articlesRes, drivesRes] = await Promise.all([
          authorPosts(writer.id, undefined, "article", 50),
          fetch(`/api/v1/writers/${username}/articles?limit=50`, {
            credentials: "include",
          })
            .then((r) => (r.ok ? r.json() : { articles: [] }))
            .catch(() => ({ articles: [] })),
          // Pledge drives parked behind PLEDGES_ENABLED (2026-07-13) — skip the
          // fetch entirely when off so no drive cards appear on the profile.
          pledgesEnabled()
            ? fetch(`/api/v1/drives/by-user/${writer.id}`, {
                credentials: "include",
              })
                .then((r) => (r.ok ? r.json() : { drives: [] }))
                .catch(() => ({ drives: [] }))
            : Promise.resolve({ drives: [] }),
        ]);
        if (cancelled) return;

        // Pin metadata + article db-id, keyed by the article's stable dTag.
        const metaByDTag = new Map<string, DbArticleMeta>();
        for (const a of (articlesRes.articles ?? []) as DbArticleMeta[]) {
          metaByDTag.set(a.dTag, a);
        }

        const work: WorkItem[] = [];
        for (const post of postsRes.items) {
          const meta = post.dTag ? metaByDTag.get(post.dTag) : undefined;
          work.push({
            kind: "article",
            publishedAt: post.publishedAt,
            pinned: meta?.pinnedOnProfile ?? false,
            pinOrder: meta?.profilePinOrder ?? 0,
            post,
            articleId: meta?.id ?? null,
          });
        }
        for (const d of (drivesRes.drives ?? []) as PledgeDrive[]) {
          work.push({
            kind: "drive",
            publishedAt: Math.floor(new Date(d.createdAt).getTime() / 1000),
            pinned: d.pinned,
            pinOrder: 0,
            data: d,
          });
        }
        setItems(work);
      } catch {
        /* silently fail */
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [username, writer.id]);

  const handleTogglePin = useCallback(async (articleId: string) => {
    try {
      const res = await fetch(`/api/v1/articles/${articleId}/pin`, {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        const { pinned } = await res.json();
        setItems((prev) =>
          prev.map((item) =>
            item.kind === "article" && item.articleId === articleId
              ? { ...item, pinned }
              : item,
          ),
        );
      }
    } catch {
      /* silently fail */
    }
  }, []);

  const openReader = useCallback(
    (p: Post) => {
      if (p.dTag) router.push(`/article/${p.dTag}`);
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

  if (loading) {
    return (
      <div className="py-10 text-center text-ui-sm text-grey-600">
        Loading...
      </div>
    );
  }

  if (items.length === 0) {
    return <p className="text-ui-sm text-grey-600 py-10">No articles yet.</p>;
  }

  const pinned = items
    .filter((i) => i.pinned)
    .sort((a, b) => a.pinOrder - b.pinOrder);

  const unpinned = items
    .filter((i) => !i.pinned)
    .sort((a, b) => b.publishedAt - a.publishedAt);

  function renderItem(item: WorkItem) {
    if (item.kind === "drive") {
      return <ProfileDriveCard key={item.data.id} drive={item.data} />;
    }
    const { post, articleId } = item;
    return (
      <div key={post.id}>
        <PostCardInteractive
          post={post}
          level="feed"
          ctx={CTX}
          onOpenReader={openReader}
          onReply={post.author.pubkey ? () => replyFromPost(post) : undefined}
        />
        {isOwnProfile && articleId && (
          <div className="px-6 pb-3 -mt-1">
            <button
              onClick={() => handleTogglePin(articleId)}
              className="btn-text-muted transition-colors"
            >
              {item.pinned ? "Unpin from profile" : "Pin to profile"}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      {pinned.length > 0 && (
        <>
          <h3 className="label-ui text-grey-600 mb-4">Pinned</h3>
          <div className="space-y-[40px] mb-8">{pinned.map(renderItem)}</div>
          <div className="rule-inset mb-8" />
        </>
      )}

      <div className="space-y-[40px]">{unpinned.map(renderItem)}</div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageShell } from "../../../components/ui/PageShell";
import { ExternalCard } from "../../../components/feed/ExternalCard";
import { sources, type SourceMeta } from "../../../lib/api/feeds";
import type { ExternalFeedItem } from "../../../lib/ndk";
import { ApiError } from "../../../lib/api/client";

const PROTOCOL_LABELS: Record<string, string> = {
  rss: "VIA RSS",
  atproto: "VIA BLUESKY",
  activitypub: "VIA FEDIVERSE",
  nostr_external: "VIA NOSTR",
  email: "VIA EMAIL",
};

// Mirrors FeedView's external mapping — the /sources endpoint returns the same
// shape the timeline does.
function mapExternal(item: any): ExternalFeedItem {
  return {
    type: "external",
    id: item.id,
    externalSourceId: item.externalSourceId,
    sourceProtocol: item.sourceProtocol,
    sourceItemUri: item.sourceItemUri,
    authorName: item.authorName,
    authorHandle: item.authorHandle,
    authorAvatarUrl: item.authorAvatarUrl,
    authorUri: item.authorUri,
    contentText: item.contentText,
    contentHtml: item.contentHtml,
    title: item.title,
    summary: item.summary,
    sourceReplyUri: item.sourceReplyUri ?? null,
    sourceQuoteUri: item.sourceQuoteUri ?? null,
    contentWarning: item.contentWarning ?? null,
    poll: item.poll ?? null,
    audience: item.audience ?? null,
    likeCount: item.likeCount ?? 0,
    replyCount: item.replyCount ?? 0,
    repostCount: item.repostCount ?? 0,
    media: item.media ?? [],
    publishedAt: item.publishedAt,
    sourceName: item.sourceName,
    sourceAvatar: item.sourceAvatar,
    pipStatus: item.pipStatus ?? "unknown",
    isReply: item.isReply ?? false,
    replyToAuthor: item.replyToAuthor,
    biddabilityTier: item.biddabilityTier ?? "D",
  } as ExternalFeedItem;
}

export function SourceSurface({ id }: { id: string }) {
  const [source, setSource] = useState<SourceMeta | null>(null);
  const [items, setItems] = useState<ExternalFeedItem[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState(false);

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
        setItems(res.items.map(mapExternal));
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
        setItems((prev) => [...prev, ...res.items.map(mapExternal)]);
        setCursor(res.nextCursor);
      })
      .catch(() => setError(true))
      .finally(() => setLoadingMore(false));
  }, [id, cursor, loadingMore]);

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
          <Link href="/feed" className="btn-text">
            Back to feed
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
          {items.map((item) => (
            <ExternalCard key={item.id} item={item} />
          ))}
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

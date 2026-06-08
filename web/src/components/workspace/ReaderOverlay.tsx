"use client";

// =============================================================================
// ReaderOverlay — UNIVERSAL-POST-ADR §3.1 / Phase R
//
// The single reading environment over the workspace. Driven by the useReader
// store; mounted once in WorkspaceView. Renders, by target kind:
//   - native   → ArticleReader (gate-pass unlock + decrypt, client-fetched by dTag)
//   - external → ExternalArticleReader (GET /extract reader-mode body)
// backed by a real URL (the store pushes /article/<dTag> or /reader/<postId>), so
// Back / Esc / scrim all close and restore the prior URL. Direct visits to those
// URLs render the same inner readers full-page (article/[dTag], reader/[postId]).
//
// Replaces the old ephemeral ReaderPane (deleted). Separation is whitespace +
// the existing slab rules inside the readers, per the sitewide no-thin-line rule.
// =============================================================================

import React, { useEffect, useState } from "react";
import { useReader } from "../../stores/reader";
import { Glasshouse } from "./Glasshouse";
import { ExternalArticleReader } from "../article/ExternalArticleReader";
import { ArticleReader } from "../article/ArticleReader";
import { articles, type ArticleMetadata } from "../../lib/api";

export function ReaderOverlay() {
  const { isOpen, target, close, dismiss, _handlePop } = useReader();

  // Glasshouse owns the chrome, Escape, and scroll-lock. The reader keeps only
  // the URL-sync concern: browser Back pops our pushed /article·/reader entry,
  // so _handlePop must run on popstate to finalise close. Gated on isOpen.
  useEffect(() => {
    if (!isOpen) return;
    window.addEventListener("popstate", _handlePop);
    return () => window.removeEventListener("popstate", _handlePop);
  }, [isOpen, _handlePop]);

  if (!isOpen || !target) return null;

  const isNative = target.kind === "native";
  // Wider panes in the overlay than the full-page routes so the text column
  // keeps its reading measure while the side whitespace roughly doubles
  // (native ~90px → ~180px; external 48px → 96px each side).
  const maxWidth = isNative ? 1000 : 736;

  return (
    <Glasshouse
      onClose={close}
      onSupersede={dismiss}
      maxWidth={maxWidth}
      ariaLabel="Reader"
    >
      {target.kind === "external" ? (
        <ExternalArticleReader
          url={target.url}
          title={target.title}
          siteName={target.siteName}
          paddingX="px-24"
        />
      ) : (
        <NativeArticleBody dTag={target.dTag} />
      )}
    </Glasshouse>
  );
}

// -----------------------------------------------------------------------------
// NativeArticleBody — client loader: fetch the article by d-tag and render the
// existing ArticleReader (its gate-pass unlock + markdown render run client-side,
// so no SSR / preRenderedFreeHtml is needed in the overlay). Mirrors the prop
// mapping in app/article/[dTag]/page.tsx.
// -----------------------------------------------------------------------------
function NativeArticleBody({ dTag }: { dTag: string }) {
  const [article, setArticle] = useState<ArticleMetadata | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setArticle(null);
    setError(false);
    articles
      .getByDTag(dTag)
      .then((a) => {
        if (!cancelled) setArticle(a);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [dTag]);

  if (error) {
    return (
      <div className="px-8 py-16 text-center">
        <p className="text-ui-xs text-grey-500">Could not load this article.</p>
      </div>
    );
  }

  if (!article) {
    return (
      <div className="px-8 py-16 space-y-3 animate-pulse">
        <div className="h-7 bg-grey-100 rounded w-3/4 mx-auto" />
        <div className="h-4 bg-grey-100 rounded w-full" />
        <div className="h-4 bg-grey-100 rounded w-5/6" />
        <div className="h-4 bg-grey-100 rounded w-full" />
      </div>
    );
  }

  return (
    <ArticleReader
      article={{
        id: article.nostrEventId,
        pubkey: article.writer.pubkey,
        dTag: article.dTag,
        title: article.title,
        summary: article.summary ?? "",
        content: article.contentFree ?? "",
        publishedAt: article.publishedAt
          ? Math.floor(new Date(article.publishedAt).getTime() / 1000)
          : 0,
        tags: [],
        pricePence: article.pricePence ?? undefined,
        gatePositionPct: article.gatePositionPct ?? undefined,
        isPaywalled: article.isPaywalled,
      }}
      coverImageUrl={article.coverImageUrl ?? null}
      articleDbId={article.id}
      writerName={article.writer.displayName ?? article.writer.username}
      writerUsername={article.writer.username}
      writerAvatar={article.writer.avatar ?? undefined}
      writerId={article.writer.id}
      subscriptionPricePence={
        article.publication?.subscriptionPricePence ??
        article.writer.subscriptionPricePence
      }
      writerSpendThisMonthPence={article.writerSpendThisMonthPence ?? undefined}
      nudgeShownThisMonth={article.nudgeShownThisMonth ?? false}
      publicationName={article.publication?.name ?? undefined}
      publicationSlug={article.publication?.slug ?? undefined}
    />
  );
}

"use client";

// =============================================================================
// ReaderOverlay — UNIVERSAL-POST-ADR §3.1 / Phase R
//
// The single reading environment over the workspace. Driven by the useReader
// store; mounted once in WorkspaceView. Renders, by target kind:
//   - native   → ArticleReader (gate-pass unlock + decrypt, client-fetched by dTag)
//   - external → ExternalArticleReader (GET /extract reader-mode body)
// backed by a real URL (the store pushes /article/<dTag> or /read/<postId>), so
// Back / Esc / scrim all close and restore the prior URL. Direct visits to those
// URLs render the same inner readers full-page (article/[dTag], reader/[postId]).
//
// Replaces the old ephemeral ReaderPane (deleted). Separation is whitespace +
// the existing slab rules inside the readers, per the sitewide no-thin-line rule.
// =============================================================================

import React, { useEffect, useRef, useState } from "react";
import { useReader } from "../../stores/reader";
import { useIsMobile } from "../../hooks/useIsMobile";
import { Glasshouse } from "./Glasshouse";
import { ExternalArticleReader } from "../article/ExternalArticleReader";
import { ArticleReader } from "../article/ArticleReader";
import { articles, type ArticleMetadata } from "../../lib/api";

export function ReaderOverlay() {
  const {
    isOpen,
    target,
    close,
    dismiss,
    _handlePop,
    frameColor,
    frameTextColor,
    nav,
    skip,
  } = useReader();

  // Glasshouse owns the chrome, Escape, and scroll-lock. The reader keeps only
  // the URL-sync concern: browser Back pops our pushed /article·/reader entry,
  // so _handlePop must run on popstate to finalise close. Gated on isOpen.
  useEffect(() => {
    if (!isOpen) return;
    window.addEventListener("popstate", _handlePop);
    return () => window.removeEventListener("popstate", _handlePop);
  }, [isOpen, _handlePop]);

  // Arrow-key reading controls. Up / down scroll the reading pane (the natural
  // gesture as you read down a piece); left / right flip back / forward through
  // the parent feed's articles — the keyboard twin of the skip ears, so you tap
  // → to start the next one. Scroll works whenever the reader is open; skip only
  // while launched from a feed (hasNav). `skip` reads the live nav from the
  // store and no-ops at the ends. Ignore the keys when a field has focus (caret
  // movement) or a modifier is held (browser shortcuts like Alt+←/⌘←).
  //
  // Instant (not smooth) scrollBy so key auto-repeat — holding ↓ — reads as one
  // continuous scroll rather than a stutter of queued animations.
  const SCROLL_STEP = 80;
  const scrollRef = useRef<HTMLDivElement>(null);
  const hasNav = !!nav;
  const isMobile = useIsMobile();

  // Horizontal swipe — the touch twin of the ←/→ skip keys (and the desktop
  // skip ears). On mobile, a decisive horizontal swipe across the reading pane
  // flips to the previous / next article in the parent feed; only meaningful
  // when launched from a feed (hasNav). Swipe left → next (the → key); swipe
  // right → previous (the ← key) — the standard paged-content convention.
  // Vertical-dominant gestures fall through to normal scrolling, and a swipe
  // that begins inside a horizontally-scrollable element (wide code block or
  // image) is left to that element — mirroring the mobile pager's restraint.
  const SWIPE_MIN_X = 56;
  const swipeRef = useRef<{ x: number; y: number } | null>(null);
  const hasScrollableXAncestor = (
    start: Element | null,
    root: Element,
  ): boolean => {
    let el: Element | null = start;
    while (el && el !== root) {
      if (el.scrollWidth > el.clientWidth) {
        const ox = getComputedStyle(el).overflowX;
        if (ox === "auto" || ox === "scroll") return true;
      }
      el = el.parentElement;
    }
    return false;
  };
  const onSwipeStart = (e: React.TouchEvent) => {
    if (!hasNav || !isMobile || e.touches.length !== 1) {
      swipeRef.current = null;
      return;
    }
    if (hasScrollableXAncestor(e.target as Element, e.currentTarget)) {
      swipeRef.current = null;
      return;
    }
    const t = e.touches[0];
    swipeRef.current = { x: t.clientX, y: t.clientY };
  };
  const onSwipeEnd = (e: React.TouchEvent) => {
    const start = swipeRef.current;
    swipeRef.current = null;
    if (!start || !hasNav || !isMobile) return;
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    // Decisive horizontal: enough travel, and clearly more across than down.
    if (Math.abs(dx) < SWIPE_MIN_X || Math.abs(dx) <= Math.abs(dy)) return;
    skip(dx < 0 ? 1 : -1);
  };

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      )
        return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        scrollRef.current?.scrollBy(0, SCROLL_STEP);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        scrollRef.current?.scrollBy(0, -SCROLL_STEP);
      } else if (hasNav && e.key === "ArrowLeft") {
        e.preventDefault();
        skip(-1);
      } else if (hasNav && e.key === "ArrowRight") {
        e.preventDefault();
        skip(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, hasNav, skip]);

  if (!isOpen || !target) return null;

  const isNative = target.kind === "native";
  // Wider panes in the overlay than the full-page routes so the text column
  // keeps its reading measure while the side whitespace roughly doubles
  // (native ~90px → ~180px; external 48px → 96px each side).
  const maxWidth = isNative ? 1000 : 736;

  // Feed-skip ears: present only when launched from a feed (nav set). Up the
  // feed = previous article, down = next.
  const sideNav = nav
    ? {
        onPrev: () => skip(-1),
        onNext: () => skip(1),
        canPrev: nav.index > 0,
        canNext: nav.index < nav.entries.length - 1,
      }
    : null;

  return (
    <Glasshouse
      onClose={close}
      onSupersede={dismiss}
      selfHistory
      maxWidth={maxWidth}
      ariaLabel="Reader"
      persistKey="reader"
      resizable
      frameColor={frameColor}
      frameTextColor={frameTextColor}
      sideNav={sideNav}
    >
      <div
        ref={scrollRef}
        onTouchStart={onSwipeStart}
        onTouchEnd={onSwipeEnd}
        // Explain C1: the reading surface's own label — answers any interior
        // hover a more specific leaf (reader.gate) doesn't, ahead of the
        // generic `pane` tag on the Glasshouse root.
        data-explain="reader"
        className="overflow-y-auto max-h-[var(--gh-h)]"
      >
        {target.kind === "external" ? (
          <ExternalArticleReader
            url={target.url}
            title={target.title}
            siteName={target.siteName}
            paddingX="px-6 sm:px-12 md:px-24"
          />
        ) : (
          <NativeArticleBody dTag={target.dTag} preview={target.preview} />
        )}
      </div>
    </Glasshouse>
  );
}

// -----------------------------------------------------------------------------
// NativeArticleBody — client loader: fetch the article by d-tag and render the
// existing ArticleReader (its gate-pass unlock + markdown render run client-side,
// so no SSR / preRenderedFreeHtml is needed in the overlay). Mirrors the prop
// mapping in app/article/[dTag]/page.tsx.
// -----------------------------------------------------------------------------
function NativeArticleBody({
  dTag,
  preview,
}: {
  dTag: string;
  preview?: { title: string | null; summary: string | null } | null;
}) {
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
        <p className="text-ui-xs text-grey-600">Could not load this article.</p>
      </div>
    );
  }

  if (!article) {
    // Instant preview (audit #6): when the card seeded a title/dek, paint the
    // article's identity on the first frame — in the same typography the loaded
    // ArticleReader header uses, so the body fading in below causes no shift.
    // Falls back to a neutral skeleton when nothing was seeded (search/dashboard).
    if (preview?.title) {
      return (
        <div className="px-6 sm:px-16 md:px-24 py-16">
          <h1
            className="mb-4 font-serif text-black leading-[1.1]"
            style={{
              fontSize: "clamp(2.125rem, 4vw, 2.125rem)",
              fontWeight: 500,
              letterSpacing: "-0.025em",
            }}
          >
            {preview.title}
          </h1>
          {preview.summary && (
            <p className="font-serif text-xl text-grey-600 italic leading-relaxed mt-4 mb-2">
              {preview.summary}
            </p>
          )}
          <div className="slab-rule-4 mb-10 mt-6" />
          <div className="space-y-3 animate-pulse">
            <div className="h-4 bg-grey-100 rounded w-full" />
            <div className="h-4 bg-grey-100 rounded w-5/6" />
            <div className="h-4 bg-grey-100 rounded w-full" />
          </div>
        </div>
      );
    }
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

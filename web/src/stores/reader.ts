import { create } from "zustand";

// =============================================================================
// useReader — the unified reader-pane store (UNIVERSAL-POST-ADR §3.1 / Phase R)
//
// One overlay, two article kinds, backed by a real URL:
//   - native   → /article/<dTag>   (existing addressable page; ArticleReader)
//   - external → /read/<postId>  (addressable extract page; ExternalArticleReader)
//
// Opening pushes the article's real URL into history so the overlay is
// shareable and the browser Back button closes it; close() pops that entry.
// Direct visits to those URLs render the same inner readers full-page.
// =============================================================================

export type ReaderTarget =
  | {
      kind: "external";
      url: string;
      postId: string | null;
      title: string | null;
      siteName: string | null;
    }
  | {
      kind: "native";
      dTag: string;
      postId: string | null;
      // Instant preview seeded from the feed card's Post (performance audit #6):
      // the title + dek the card already holds, so the reader paints the
      // article's identity on the first frame instead of a blank skeleton while
      // the full article fetch (free body + gate metadata) is in flight. Absent
      // when opened from a surface that has no Post in hand (search, dashboard).
      preview?: { title: string | null; summary: string | null } | null;
    };

interface ReaderState {
  isOpen: boolean;
  target: ReaderTarget | null;
  /** True when open() pushed a history entry we must pop on close. */
  didPush: boolean;
  /** When opened from a feed card, that feed's wall colour (palette.walls,
   *  a `var(--ah-…)` string) — the reader pane frames itself with it. Null when
   *  opened from a feed-agnostic surface. */
  frameColor: string | null;

  /** Open an external article by URL (the extract reader). */
  openExternal: (
    url: string,
    opts?: {
      postId?: string | null;
      title?: string | null;
      siteName?: string | null;
      frameColor?: string | null;
    },
  ) => void;
  /** Open a native article by its d-tag (the ArticleReader). `preview` seeds an
   *  instant title+dek paint from the card's Post (audit #6); omit it when the
   *  caller has no Post in hand. */
  openNative: (
    dTag: string,
    opts?: {
      postId?: string | null;
      frameColor?: string | null;
      preview?: { title: string | null; summary: string | null } | null;
    },
  ) => void;
  /**
   * Back-compat alias for the legacy VesselCard call `open(url, title, site)`.
   * No postId ⇒ no addressable URL pushed (the flag-off path is not yet on the
   * Post model); the overlay still renders.
   */
  open: (url: string, title?: string, siteName?: string) => void;

  close: () => void;
  /** Clear overlay state without touching history — for when the reader is
   *  superseded by another Glasshouse (the newcomer owns the top history entry,
   *  so a history.back here would pop its URL, not ours). */
  dismiss: () => void;
  /** Internal — invoked by the overlay's popstate listener. */
  _handlePop: () => void;
}

// Push our reader URL, OR replace it if we already own a pushed entry. Opening a
// second article while the overlay is open (a link inside a reader, a stacked
// open) must not push a *second* entry — close() pops only one, so the extra
// would leak into history and the URL would desync from the overlay. Replacing
// keeps exactly one entry that close() reliably pops.
function pushReaderUrl(targetUrl: string, alreadyPushed: boolean): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (alreadyPushed) {
      window.history.replaceState({ allhausReader: true }, "", targetUrl);
    } else {
      window.history.pushState({ allhausReader: true }, "", targetUrl);
    }
    return true;
  } catch {
    return alreadyPushed;
  }
}

export const useReader = create<ReaderState>((set, get) => ({
  isOpen: false,
  target: null,
  didPush: false,
  frameColor: null,

  openExternal: (url, opts) => {
    const postId = opts?.postId ?? null;
    const reuse = get().didPush;
    // No postId ⇒ no addressable URL; keep whatever entry we already own.
    const didPush = postId
      ? pushReaderUrl(`/read/${postId}`, reuse)
      : reuse;
    set({
      isOpen: true,
      target: {
        kind: "external",
        url,
        postId,
        title: opts?.title ?? null,
        siteName: opts?.siteName ?? null,
      },
      didPush,
      frameColor: opts?.frameColor ?? null,
    });
  },

  openNative: (dTag, opts) => {
    const didPush = pushReaderUrl(`/article/${dTag}`, get().didPush);
    set({
      isOpen: true,
      target: {
        kind: "native",
        dTag,
        postId: opts?.postId ?? null,
        preview: opts?.preview ?? null,
      },
      didPush,
      frameColor: opts?.frameColor ?? null,
    });
  },

  open: (url, title, siteName) => get().openExternal(url, { title, siteName }),

  close: () => {
    if (get().didPush && typeof window !== "undefined") {
      // Pop our pushed entry; the popstate listener (_handlePop) finalises state
      // and restores the prior URL — one path for both Back and the close button.
      window.history.back();
    } else {
      set({ isOpen: false, target: null, didPush: false, frameColor: null });
    }
  },

  dismiss: () => {
    if (get().isOpen)
      set({ isOpen: false, target: null, didPush: false, frameColor: null });
  },

  _handlePop: () => {
    if (get().isOpen)
      set({ isOpen: false, target: null, didPush: false, frameColor: null });
  },
}));

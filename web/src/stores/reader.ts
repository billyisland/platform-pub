import { create } from "zustand";

// =============================================================================
// useReader — the unified reader-pane store (UNIVERSAL-POST-ADR §3.1 / Phase R)
//
// One overlay, two article kinds, backed by a real URL:
//   - native   → /article/<dTag>   (existing addressable page; ArticleReader)
//   - external → /reader/<postId>  (addressable extract page; ExternalArticleReader)
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
  | { kind: "native"; dTag: string; postId: string | null };

interface ReaderState {
  isOpen: boolean;
  target: ReaderTarget | null;
  /** True when open() pushed a history entry we must pop on close. */
  didPush: boolean;

  /** Open an external article by URL (the extract reader). */
  openExternal: (
    url: string,
    opts?: {
      postId?: string | null;
      title?: string | null;
      siteName?: string | null;
    },
  ) => void;
  /** Open a native article by its d-tag (the ArticleReader). */
  openNative: (dTag: string, opts?: { postId?: string | null }) => void;
  /**
   * Back-compat alias for the legacy VesselCard call `open(url, title, site)`.
   * No postId ⇒ no addressable URL pushed (the flag-off path is not yet on the
   * Post model); the overlay still renders.
   */
  open: (url: string, title?: string, siteName?: string) => void;

  close: () => void;
  /** Internal — invoked by the overlay's popstate listener. */
  _handlePop: () => void;
}

function pushReaderUrl(targetUrl: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.history.pushState({ allhausReader: true }, "", targetUrl);
    return true;
  } catch {
    return false;
  }
}

export const useReader = create<ReaderState>((set, get) => ({
  isOpen: false,
  target: null,
  didPush: false,

  openExternal: (url, opts) => {
    const postId = opts?.postId ?? null;
    const didPush = postId ? pushReaderUrl(`/reader/${postId}`) : false;
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
    });
  },

  openNative: (dTag, opts) => {
    const didPush = pushReaderUrl(`/article/${dTag}`);
    set({
      isOpen: true,
      target: { kind: "native", dTag, postId: opts?.postId ?? null },
      didPush,
    });
  },

  open: (url, title, siteName) => get().openExternal(url, { title, siteName }),

  close: () => {
    if (get().didPush && typeof window !== "undefined") {
      // Pop our pushed entry; the popstate listener (_handlePop) finalises state
      // and restores the prior URL — one path for both Back and the close button.
      window.history.back();
    } else {
      set({ isOpen: false, target: null, didPush: false });
    }
  },

  _handlePop: () => {
    if (get().isOpen) set({ isOpen: false, target: null, didPush: false });
  },
}));

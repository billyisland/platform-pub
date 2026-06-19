import { create } from "zustand";
import { postThread } from "../lib/api/post";

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
//
// Feed navigation (the skip "ears"): when the reader is launched from a feed
// card, the launcher hands over the feed's ordered article list (`nav`). The
// reader then exposes prev/next skip — the up/down ears on the Glasshouse frame
// jump article-to-article through that list without leaving the pane. Opens that
// carry no feed context (search, dashboard, library) leave `nav` null → no ears.
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

// One entry in the feed-skip list — enough to re-open any article in place.
// Mirrors the open args; `kind` selects native vs external on skip.
export type ReaderNavEntry =
  | {
      kind: "native";
      postId: string | null;
      dTag: string;
      preview?: { title: string | null; summary: string | null } | null;
    }
  | {
      kind: "external";
      postId: string | null;
      url: string;
      title: string | null;
      siteName: string | null;
    };

/** The ordered article list of the launching feed + the current position. */
interface ReaderNav {
  entries: ReaderNavEntry[];
  index: number;
}

interface ReaderState {
  isOpen: boolean;
  target: ReaderTarget | null;
  /** True when open() pushed a history entry we must pop on close. */
  didPush: boolean;
  /** When opened from a feed card, that feed's wall colour (palette.walls,
   *  a `var(--ah-…)` string) — the reader pane frames itself with it. Null when
   *  opened from a feed-agnostic surface. */
  frameColor: string | null;
  /** The launching feed's bar-text colour (palette.barText) — the contrast tone
   *  for the skip-ear arrows drawn on the frame. Null when feed-agnostic. */
  frameTextColor: string | null;
  /** The launching feed's article list + current index, for the skip ears.
   *  Null when opened without feed context (search/dashboard/library). */
  nav: ReaderNav | null;

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
  /** Reopen an external article from just its postId — the reload path for the
   *  standalone /read/<postId> page: resolve the origin URL/title via GET /thread
   *  (the same lookup the page does server-side), then open the overlay. Feed
   *  context (skip ears / frame) is gone after a cold reload, so it opens plain.
   *  Best-effort: a failed/unresolvable lookup leaves the workspace untouched. */
  openExternalById: (postId: string) => Promise<void>;
  /** Open the article at `index` in a feed's article list, wiring up the skip
   *  ears so the up/down arrows step through `entries` in place. */
  openFeedItem: (
    entries: ReaderNavEntry[],
    index: number,
    frame: { frameColor: string | null; frameTextColor: string | null },
  ) => void;
  /** Step to the previous / next article in the feed list (the ears). No-op
   *  when there's no nav, or already at the end in that direction. */
  skip: (delta: -1 | 1) => void;
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
// open, a skip-ear step) must not push a *second* entry — close() pops only one,
// so the extra would leak into history and the URL would desync from the
// overlay. Replacing keeps exactly one entry that close() reliably pops.
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

export const useReader = create<ReaderState>((set, get) => {
  // Open a single nav entry, reusing the current history entry. Shared by the
  // feed-launched open and the skip ears so both keep exactly one history entry.
  const openEntry = (
    entry: ReaderNavEntry,
    frame: {
      frameColor: string | null;
      frameTextColor: string | null;
      nav: ReaderNav | null;
    },
  ) => {
    if (entry.kind === "native") {
      const didPush = pushReaderUrl(`/article/${entry.dTag}`, get().didPush);
      set({
        isOpen: true,
        target: {
          kind: "native",
          dTag: entry.dTag,
          postId: entry.postId,
          preview: entry.preview ?? null,
        },
        didPush,
        frameColor: frame.frameColor,
        frameTextColor: frame.frameTextColor,
        nav: frame.nav,
      });
    } else {
      const reuse = get().didPush;
      const didPush = entry.postId
        ? pushReaderUrl(`/read/${entry.postId}`, reuse)
        : reuse;
      set({
        isOpen: true,
        target: {
          kind: "external",
          url: entry.url,
          postId: entry.postId,
          title: entry.title,
          siteName: entry.siteName,
        },
        didPush,
        frameColor: frame.frameColor,
        frameTextColor: frame.frameTextColor,
        nav: frame.nav,
      });
    }
  };

  return {
    isOpen: false,
    target: null,
    didPush: false,
    frameColor: null,
    frameTextColor: null,
    nav: null,

    openExternal: (url, opts) => {
      openEntry(
        {
          kind: "external",
          url,
          postId: opts?.postId ?? null,
          title: opts?.title ?? null,
          siteName: opts?.siteName ?? null,
        },
        { frameColor: opts?.frameColor ?? null, frameTextColor: null, nav: null },
      );
    },

    openNative: (dTag, opts) => {
      openEntry(
        {
          kind: "native",
          dTag,
          postId: opts?.postId ?? null,
          preview: opts?.preview ?? null,
        },
        { frameColor: opts?.frameColor ?? null, frameTextColor: null, nav: null },
      );
    },

    openExternalById: async (postId) => {
      try {
        const { focalId, posts } = await postThread(postId);
        const focal = posts.find((p) => p.id === focalId);
        // External article only — a note expands inline, a native article lives
        // at /article/<dTag>. Anything else: leave the workspace as it is.
        if (
          !focal ||
          focal.type !== "article" ||
          focal.origin.protocol === "nostr" ||
          !focal.origin.uri
        )
          return;
        get().openExternal(focal.origin.uri, {
          postId,
          title: focal.body.title,
          siteName: focal.origin.sourceName,
        });
      } catch {
        /* non-fatal — reopening is best-effort; the workspace stays open */
      }
    },

    openFeedItem: (entries, index, frame) => {
      const entry = entries[index];
      if (!entry) return;
      openEntry(entry, {
        frameColor: frame.frameColor,
        frameTextColor: frame.frameTextColor,
        nav: { entries, index },
      });
    },

    skip: (delta) => {
      const { nav, frameColor, frameTextColor } = get();
      if (!nav) return;
      const next = nav.index + delta;
      if (next < 0 || next >= nav.entries.length) return;
      openEntry(nav.entries[next], {
        frameColor,
        frameTextColor,
        nav: { entries: nav.entries, index: next },
      });
    },

    open: (url, title, siteName) => get().openExternal(url, { title, siteName }),

    close: () => {
      if (get().didPush && typeof window !== "undefined") {
        // Pop our pushed entry; the popstate listener (_handlePop) finalises
        // state and restores the prior URL — one path for Back and the close
        // button.
        window.history.back();
      } else {
        set({
          isOpen: false,
          target: null,
          didPush: false,
          frameColor: null,
          frameTextColor: null,
          nav: null,
        });
      }
    },

    dismiss: () => {
      if (get().isOpen)
        set({
          isOpen: false,
          target: null,
          didPush: false,
          frameColor: null,
          frameTextColor: null,
          nav: null,
        });
    },

    _handlePop: () => {
      if (get().isOpen)
        set({
          isOpen: false,
          target: null,
          didPush: false,
          frameColor: null,
          frameTextColor: null,
          nav: null,
        });
    },
  };
});

import { create } from "zustand";

// =============================================================================
// useSurfaceOverlay — the unified non-profile content-surface overlay.
//
// One overlay, three surface kinds, backed by a real URL (the profile/reader
// model, see stores/profileOverlay.ts):
//   - source      → /source/<id>     (external feed surface; SourceSurface)
//   - tag         → /tag/<name>      (tag browser; TagBrowser)
//   - publication → /pub/<slug>      (publication homepage; PublicationPanel)
//
// The publication kind carries a `view` (home/about/masthead/archive) so the
// publication's sub-routes (/pub/<slug>/{about,masthead,archive}) all render
// inside the same overlay instead of escaping the workspace full-page; the
// store pushes the matching real URL for each, and PublicationPanel renders the
// sub-view + an in-overlay nav to switch between them. Articles never get a
// surface view — a pub article row opens the reader overlay (useReader).
//
// Opening pushes the surface's real URL into history so the overlay is
// shareable and the browser Back button closes it; close() pops that entry.
// Direct visits to those URLs still render the same surfaces full-page. Mounted
// globally (LayoutShell) so a source/tag/publication link anywhere (e.g. the
// FeedComposer source rows) opens it without escaping the workspace to the
// black topbar.
// =============================================================================

/** Publication sub-views; each maps to a /pub/<slug>[/<view>] URL. */
export type PubView = "home" | "about" | "masthead" | "archive";

export type SurfaceTarget =
  | { kind: "source"; id: string }
  | { kind: "tag"; name: string }
  | { kind: "publication"; slug: string; view: PubView };

/** The canonical full-page URL for a surface target. */
export function surfaceUrl(target: SurfaceTarget): string {
  switch (target.kind) {
    case "source":
      return `/source/${encodeURIComponent(target.id)}`;
    case "tag":
      return `/tag/${encodeURIComponent(target.name)}`;
    case "publication": {
      const base = `/pub/${encodeURIComponent(target.slug)}`;
      return target.view === "home" ? base : `${base}/${target.view}`;
    }
  }
}

/** The surface's stable base path (ignoring a publication's sub-view). */
function surfaceBaseUrl(target: SurfaceTarget): string {
  if (target.kind === "publication")
    return `/pub/${encodeURIComponent(target.slug)}`;
  return surfaceUrl(target);
}

// True while `pathname` is still within the surface. Used by SurfaceOverlay to
// distinguish "a link navigated away → dismiss" from "the publication switched
// sub-view (home↔about↔masthead↔archive) → stay open" — the latter changes the
// pushed URL in lockstep with `target`, so an exact-URL check would falsely
// dismiss on the transient lag between replaceState and usePathname catching up.
export function surfacePathMatches(
  target: SurfaceTarget,
  pathname: string,
): boolean {
  const base = decodeURIComponent(surfaceBaseUrl(target));
  const current = decodeURIComponent(pathname);
  return current === base || current.startsWith(`${base}/`);
}

interface SurfaceState {
  isOpen: boolean;
  target: SurfaceTarget | null;
  /** True when open() pushed a history entry we must pop on close. */
  didPush: boolean;

  open: (target: SurfaceTarget) => void;
  openSource: (id: string) => void;
  openTag: (name: string) => void;
  openPublication: (slug: string, view?: PubView) => void;

  close: () => void;
  /** Clear overlay state without touching history — for when a link inside the
   *  overlay navigates the router away (the navigation owns the history entry). */
  dismiss: () => void;
  /** Internal — invoked by the overlay's popstate listener. */
  _handlePop: () => void;
}

// Push our surface URL, OR replace it if we already own a pushed entry. Opening
// a second surface while the overlay is open must not push a *second* entry —
// close() pops only one, so the extra would leak into history and the URL would
// desync. Replacing keeps exactly one entry that close() reliably pops. Mirrors
// stores/profileOverlay.ts::pushProfileUrl.
function pushSurfaceUrl(targetUrl: string, alreadyPushed: boolean): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (alreadyPushed) {
      window.history.replaceState({ allhausSurface: true }, "", targetUrl);
    } else {
      window.history.pushState({ allhausSurface: true }, "", targetUrl);
    }
    return true;
  } catch {
    return alreadyPushed;
  }
}

export const useSurfaceOverlay = create<SurfaceState>((set, get) => ({
  isOpen: false,
  target: null,
  didPush: false,

  open: (target) => {
    const didPush = pushSurfaceUrl(surfaceUrl(target), get().didPush);
    set({ isOpen: true, target, didPush });
  },

  openSource: (id) => get().open({ kind: "source", id }),
  openTag: (name) => get().open({ kind: "tag", name: name.replace(/^#/, "") }),
  openPublication: (slug, view = "home") =>
    get().open({ kind: "publication", slug, view }),

  close: () => {
    if (get().didPush && typeof window !== "undefined") {
      // Pop our pushed entry; the popstate listener (_handlePop) finalises state
      // and restores the prior URL — one path for both Back and the close button.
      window.history.back();
    } else {
      set({ isOpen: false, target: null, didPush: false });
    }
  },

  dismiss: () => {
    if (get().isOpen) set({ isOpen: false, target: null, didPush: false });
  },

  _handlePop: () => {
    if (get().isOpen) set({ isOpen: false, target: null, didPush: false });
  },
}));

// ---------------------------------------------------------------------------
// openSurfaceHref — the FeedComposer/byline counterpart to ProfileLink's
// openProfileHref. Classifies a non-profile in-app href into a surface target
// and opens the overlay in place; returns true if it handled the href (so the
// caller preventDefault's the link), false for anything that isn't one of the
// three surfaces (the caller lets the link navigate normally).
// ---------------------------------------------------------------------------
export function openSurfaceHref(href: string): boolean {
  const source = href.match(/^\/source\/([^/?#]+)/);
  if (source) {
    useSurfaceOverlay.getState().openSource(decodeURIComponent(source[1]));
    return true;
  }
  const tag = href.match(/^\/tag\/([^/?#]+)/);
  if (tag) {
    useSurfaceOverlay.getState().openTag(decodeURIComponent(tag[1]));
    return true;
  }
  // /pub/:slug and its named sub-routes (about · masthead · archive) open the
  // publication overlay on the matching view. A deeper /pub/:slug/:article
  // (anything else) is an article d-tag, not a surface — left to the caller's
  // reader-overlay path, so we don't claim it here.
  const pub = href.match(/^\/pub\/([^/?#]+)(?:\/([^/?#]+))?\/?(?:[?#]|$)/);
  if (pub) {
    const slug = decodeURIComponent(pub[1]);
    const sub = pub[2];
    if (!sub) {
      useSurfaceOverlay.getState().openPublication(slug, "home");
      return true;
    }
    if (sub === "about" || sub === "masthead" || sub === "archive") {
      useSurfaceOverlay.getState().openPublication(slug, sub);
      return true;
    }
  }
  return false;
}

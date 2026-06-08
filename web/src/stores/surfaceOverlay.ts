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
// Opening pushes the surface's real URL into history so the overlay is
// shareable and the browser Back button closes it; close() pops that entry.
// Direct visits to those URLs still render the same surfaces full-page. Mounted
// globally (LayoutShell) so a source/tag/publication link anywhere (e.g. the
// FeedComposer source rows) opens it without escaping the workspace to the
// black topbar.
// =============================================================================

export type SurfaceTarget =
  | { kind: "source"; id: string }
  | { kind: "tag"; name: string }
  | { kind: "publication"; slug: string };

/** The canonical full-page URL for a surface target. */
export function surfaceUrl(target: SurfaceTarget): string {
  switch (target.kind) {
    case "source":
      return `/source/${encodeURIComponent(target.id)}`;
    case "tag":
      return `/tag/${encodeURIComponent(target.name)}`;
    case "publication":
      return `/pub/${encodeURIComponent(target.slug)}`;
  }
}

interface SurfaceState {
  isOpen: boolean;
  target: SurfaceTarget | null;
  /** True when open() pushed a history entry we must pop on close. */
  didPush: boolean;

  open: (target: SurfaceTarget) => void;
  openSource: (id: string) => void;
  openTag: (name: string) => void;
  openPublication: (slug: string) => void;

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
  openPublication: (slug) => get().open({ kind: "publication", slug }),

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
  // /pub/:slug only — deeper /pub/:slug/:article (masthead, about, an article)
  // stay full-page navigations, not the homepage overlay.
  const pub = href.match(/^\/pub\/([^/?#]+)\/?$/);
  if (pub) {
    useSurfaceOverlay.getState().openPublication(decodeURIComponent(pub[1]));
    return true;
  }
  return false;
}

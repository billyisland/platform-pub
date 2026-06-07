import { create } from "zustand";

// =============================================================================
// useProfile — the unified profile-overlay store.
//
// One overlay, two profile kinds, backed by a real URL (the reader-pane model,
// see stores/reader.ts):
//   - native   → /<username>          (the WriterActivity profile; NativeProfilePanel)
//   - external → /author/<authorId>   (tier-A/B constructed profile; AuthorProfileView)
//
// Opening pushes the profile's real URL into history so the overlay is
// shareable and the browser Back button closes it; close() pops that entry.
// Direct visits to those URLs render the same profiles full-page. Mounted
// globally (LayoutShell) so any byline / profile link sitewide opens it without
// leaving the current surface.
// =============================================================================

export type ProfileTarget =
  | { kind: "native"; username: string }
  | { kind: "external"; authorId: string };

interface ProfileState {
  isOpen: boolean;
  target: ProfileTarget | null;
  /** True when open() pushed a history entry we must pop on close. */
  didPush: boolean;

  /** Open a native writer profile by username. */
  openNative: (username: string) => void;
  /** Open a tier-A/B external author profile by author id. */
  openExternal: (authorId: string) => void;

  close: () => void;
  /** Clear overlay state without touching history — for when a link inside the
   *  overlay navigates the router away (the navigation owns the history entry). */
  dismiss: () => void;
  /** Internal — invoked by the overlay's popstate listener. */
  _handlePop: () => void;
}

// Push our profile URL, OR replace it if we already own a pushed entry. Opening
// a second profile while the overlay is open (a byline inside the overlay) must
// not push a *second* entry — close() pops only one, so the extra would leak
// into history and the URL would desync. Replacing keeps exactly one entry that
// close() reliably pops. Mirrors stores/reader.ts::pushReaderUrl.
function pushProfileUrl(targetUrl: string, alreadyPushed: boolean): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (alreadyPushed) {
      window.history.replaceState({ allhausProfile: true }, "", targetUrl);
    } else {
      window.history.pushState({ allhausProfile: true }, "", targetUrl);
    }
    return true;
  } catch {
    return alreadyPushed;
  }
}

export const useProfile = create<ProfileState>((set, get) => ({
  isOpen: false,
  target: null,
  didPush: false,

  openNative: (username) => {
    const clean = username.replace(/^@/, "");
    const didPush = pushProfileUrl(`/${clean}`, get().didPush);
    set({ isOpen: true, target: { kind: "native", username: clean }, didPush });
  },

  openExternal: (authorId) => {
    const didPush = pushProfileUrl(
      `/author/${encodeURIComponent(authorId)}`,
      get().didPush,
    );
    set({ isOpen: true, target: { kind: "external", authorId }, didPush });
  },

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

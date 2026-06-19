import { create } from "zustand";

// =============================================================================
// usePaneRedirect — a one-bit signal that the current standalone page backs a
// workspace *pane* overlay (article/read · profile · source/tag/pub) and so
// carries a <WorkspacePaneRedirect>, which bounces a logged-in visitor into the
// workspace. LayoutShell reads it to suppress the retired black topbar during
// the auth-resolve → redirect window, so a member reloading such a page never
// sees a flash of the chrome they're about to leave. A resolved logged-out
// visitor isn't redirected, so the page keeps its full chrome (share/SEO view).
//
// The page *declares itself* via the redirect component (set on mount, cleared
// on unmount) rather than LayoutShell pattern-matching routes — the native
// profile lives at the /<username> catch-all, which no path prefix can isolate.
// =============================================================================

interface PaneRedirectState {
  active: boolean;
  setActive: (active: boolean) => void;
}

export const usePaneRedirect = create<PaneRedirectState>((set) => ({
  active: false,
  setActive: (active) => set({ active }),
}));

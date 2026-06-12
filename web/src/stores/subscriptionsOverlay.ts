import { create } from "zustand";

// =============================================================================
// useSubscriptionsOverlay — opens external-feed subscription management (RSS /
// Nostr / Bluesky / Mastodon CRUD via the omnivorous SubscribeInput) in a
// workspace Glasshouse (frosted overlay, ForallMenu stays crisp above).
// In-memory only: like the ledger and settings overlays, it pushes no shareable
// URL. Deep links arrive as /workspace?overlay=subscriptions (the retired
// /subscriptions route redirects into that), handled by the deep-link
// dispatcher in WorkspaceView.
// =============================================================================

interface SubscriptionsOverlayState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

export const useSubscriptionsOverlay = create<SubscriptionsOverlayState>(
  (set) => ({
    isOpen: false,
    open: () => set({ isOpen: true }),
    close: () => set({ isOpen: false }),
  }),
);

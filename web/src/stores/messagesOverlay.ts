import { create } from "zustand";

// =============================================================================
// useMessagesOverlay — opens the direct-messages surface in a workspace
// Glasshouse (frosted overlay, ForallMenu stays crisp above). In-memory only:
// unlike the reader, it pushes no shareable URL — the /messages page remains
// the addressable surface for deep links.
// =============================================================================

interface MessagesOverlayState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

export const useMessagesOverlay = create<MessagesOverlayState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));

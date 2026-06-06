import { create } from "zustand";

// =============================================================================
// useNotificationsOverlay — opens the notifications log in a workspace
// Glasshouse (frosted overlay, ForallMenu stays crisp above). In-memory only:
// it pushes no shareable URL. Deep links arrive as /workspace?overlay=
// notifications (the retired /notifications route redirects into that), handled
// by the deep-link dispatcher in WorkspaceView. The unread badge on the ∀ lives
// on the shared useUnreadCounts store, independent of this open/close state.
// =============================================================================

interface NotificationsOverlayState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

export const useNotificationsOverlay = create<NotificationsOverlayState>(
  (set) => ({
    isOpen: false,
    open: () => set({ isOpen: true }),
    close: () => set({ isOpen: false }),
  }),
);

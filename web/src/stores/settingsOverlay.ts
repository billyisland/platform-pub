import { create } from "zustand";

// =============================================================================
// useSettingsOverlay — opens account settings in a workspace Glasshouse
// (frosted overlay, ForallMenu stays crisp above). In-memory only: like the
// ledger and notifications overlays, it pushes no shareable URL. Deep links
// arrive as /reader?overlay=settings (the retired /settings route redirects
// into that), handled by the deep-link dispatcher in WorkspaceView.
//
// `linked` carries the OAuth-callback flag (mastodon/bluesky/error) the gateway
// appends when a social account connect returns to /settings?linked=…; the shim
// forwards it so the panel can show its connect banner inside the overlay.
// =============================================================================

interface SettingsOverlayState {
  isOpen: boolean;
  linked: string | null;
  open: (opts?: { linked?: string | null }) => void;
  close: () => void;
}

export const useSettingsOverlay = create<SettingsOverlayState>((set) => ({
  isOpen: false,
  linked: null,
  open: (opts) => set({ isOpen: true, linked: opts?.linked ?? null }),
  close: () => set({ isOpen: false, linked: null }),
}));

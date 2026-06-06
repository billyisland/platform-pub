"use client";

// =============================================================================
// NotificationsOverlay — the notifications log in a workspace Glasshouse.
// Mounted once in WorkspaceView; opened from the ForallMenu Notifications row,
// or via /workspace?overlay=notifications (the retired /notifications route
// redirects here). Wraps the shared NotificationsPanel in the canonical frosted
// overlay so the ForallMenu stays crisp above it.
// =============================================================================

import { useNotificationsOverlay } from "../../stores/notificationsOverlay";
import { Glasshouse } from "./Glasshouse";
import { NotificationsPanel } from "../notifications/NotificationsPanel";

export function NotificationsOverlay() {
  const { isOpen, close } = useNotificationsOverlay();
  if (!isOpen) return null;

  // 640px — the activity log is a single reading column. The inner scroll fills
  // the pane minus its 64px (my-8) vertical margin.
  return (
    <Glasshouse onClose={close} maxWidth={640} ariaLabel="Notifications">
      <div className="px-6 sm:px-10 py-12 h-[calc(100vh-64px)] min-h-[400px] flex flex-col">
        <NotificationsPanel className="flex-1 min-h-0" inOverlay onClose={close} />
      </div>
    </Glasshouse>
  );
}

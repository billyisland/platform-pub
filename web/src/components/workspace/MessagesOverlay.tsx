"use client";

// =============================================================================
// MessagesOverlay — direct messages in a workspace Glasshouse. Mounted once in
// WorkspaceView; opened from the ForallMenu Messages row via useMessagesOverlay.
// Wraps the shared MessagesPanel (also used by the /messages page) in the
// canonical frosted overlay so the ForallMenu stays crisp above it.
// =============================================================================

import { useMessagesOverlay } from "../../stores/messagesOverlay";
import { Glasshouse } from "./Glasshouse";
import { MessagesPanel } from "../messages/MessagesPanel";

export function MessagesOverlay() {
  const { isOpen, close } = useMessagesOverlay();
  if (!isOpen) return null;

  // 960px mirrors the /messages page's max-w-content. Height fills the pane
  // minus its 64px (my-8) vertical margin.
  return (
    <Glasshouse onClose={close} maxWidth={960} ariaLabel="Direct messages">
      <MessagesPanel className="h-[calc(100vh-64px)] min-h-[400px]" />
    </Glasshouse>
  );
}

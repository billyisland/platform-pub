"use client";

// =============================================================================
// SubscriptionsOverlay — external-feed subscription management in a workspace
// Glasshouse. Mounted once in WorkspaceView; opened from the ForallMenu
// Subscriptions row, or via /workspace?overlay=subscriptions (the retired
// /subscriptions route redirects here; see the deep-link dispatcher in
// WorkspaceView). Wraps SubscriptionsPanel in the canonical frosted overlay so
// the ForallMenu stays crisp above it.
// =============================================================================

import { useSubscriptionsOverlay } from "../../stores/subscriptionsOverlay";
import { Glasshouse } from "./Glasshouse";
import { SubscriptionsPanel } from "../subscriptions/SubscriptionsPanel";

export function SubscriptionsOverlay() {
  const { isOpen, close } = useSubscriptionsOverlay();
  if (!isOpen) return null;

  // 720px keeps the subscribe input + source list at a comfortable reading
  // rhythm; the inner scroll fills the pane minus its 64px (my-8) vertical
  // margin.
  return (
    <Glasshouse onClose={close} maxWidth={720} ariaLabel="External feeds" persistKey="subscriptions">
      <div className="overflow-y-auto max-h-[var(--gh-h)] px-6 sm:px-10 py-12">
        <SubscriptionsPanel inOverlay />
      </div>
    </Glasshouse>
  );
}

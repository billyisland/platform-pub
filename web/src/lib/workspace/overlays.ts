// =============================================================================
// Workspace overlay deep-link dispatcher.
//
// As routes retire into workspace Glasshouse overlays (dashboard, messages,
// notifications, …), they all funnel through the same address shape:
//   /workspace?overlay=<name>[&…seed params]
// This module is the single place that maps that shape to the matching overlay
// store's open(). Two entry points:
//   - openOverlayFromParams: used by WorkspaceView on mount (params read from
//     window.location) to open the requested overlay seeded from the query.
//   - routeToOverlay: used by in-workspace navigations (e.g. notification rows)
//     so a link to /workspace?overlay=… opens the overlay in place instead of a
//     no-op router.push to the same /workspace pathname. Returns true when it
//     handled the href, so the caller can skip its own router.push.
//
// PARAM_KEYS is the full set of query keys the overlays consume — WorkspaceView
// strips these after opening so the workspace URL stays clean.
// =============================================================================

import { useDashboardOverlay } from "../../stores/dashboardOverlay";
import { useMessagesOverlay } from "../../stores/messagesOverlay";
import { useNotificationsOverlay } from "../../stores/notificationsOverlay";

export const OVERLAY_PARAM_KEYS = [
  "overlay",
  "tab",
  "context",
  "conversation",
] as const;

/** Open the overlay named by `params.overlay`, seeded from the query. Returns
 *  true if an overlay was opened. */
export function openOverlayFromParams(params: URLSearchParams): boolean {
  switch (params.get("overlay")) {
    case "dashboard":
      useDashboardOverlay.getState().open({
        tab: params.get("tab"),
        context: params.get("context"),
      });
      return true;
    case "messages":
      useMessagesOverlay
        .getState()
        .open({ conversationId: params.get("conversation") });
      return true;
    case "notifications":
      useNotificationsOverlay.getState().open();
      return true;
    default:
      return false;
  }
}

/** If `href` targets a workspace overlay (/workspace?overlay=…), open it in
 *  place and return true; otherwise return false so the caller navigates. */
export function routeToOverlay(href: string): boolean {
  const qIndex = href.indexOf("?");
  if (qIndex === -1) return false;
  if (!href.startsWith("/workspace")) return false;
  // Drop any #hash before parsing the query.
  const query = href.slice(qIndex + 1).split("#")[0];
  return openOverlayFromParams(new URLSearchParams(query));
}

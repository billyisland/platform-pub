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
import { useLedgerOverlay } from "../../stores/ledgerOverlay";
import { useSettingsOverlay } from "../../stores/settingsOverlay";
import { useLibraryOverlay, type LibraryTab } from "../../stores/libraryOverlay";
import { useNetworkOverlay, type NetworkTab } from "../../stores/networkOverlay";
import { useSubscriptionsOverlay } from "../../stores/subscriptionsOverlay";
import { useEditorOverlay } from "../../stores/editorOverlay";

export const OVERLAY_PARAM_KEYS = [
  "overlay",
  "tab",
  "context",
  "conversation",
  "linked",
  "draft",
  "edit",
  "pub",
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
    case "ledger":
      useLedgerOverlay.getState().open();
      return true;
    case "settings":
      useSettingsOverlay.getState().open({ linked: params.get("linked") });
      return true;
    case "library":
      useLibraryOverlay
        .getState()
        .open({ tab: params.get("tab") as LibraryTab | null });
      return true;
    case "network":
      useNetworkOverlay
        .getState()
        .open({ tab: params.get("tab") as NetworkTab | null });
      return true;
    case "subscriptions":
      useSubscriptionsOverlay.getState().open();
      return true;
    case "editor":
      useEditorOverlay.getState().open({
        draftId: params.get("draft"),
        editEventId: params.get("edit"),
        publicationSlug: params.get("pub"),
      });
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

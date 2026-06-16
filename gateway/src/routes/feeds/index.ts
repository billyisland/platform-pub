import type { FastifyInstance } from "fastify";
import { registerFeedCrudRoutes } from "./crud.js";
import { registerFeedItemsRoutes } from "./items.js";
import { registerFeedSourcesRoutes } from "./sources.js";
import { registerAuthorVolumeRoutes } from "./author-volume.js";
import { registerFeedSavesRoutes } from "./saves.js";

// =============================================================================
// Workspace feeds (slices 3 + 4)
//
// Mounted at /api/v1/workspace (external-feeds.ts historically owned the
// /api/v1/feeds namespace; it now holds only admin diagnostics). External
// subscriptions are feed-derived — adding/removing an external source here is
// what creates/tears down the external_subscriptions row. Effective paths:
//
// GET    /workspace/feeds                       — list feeds owned by caller
// POST   /workspace/feeds                       — create { name }
// PATCH  /workspace/feeds/:id                   — rename { name }
// DELETE /workspace/feeds/:id                   — delete (cascade removes feed_sources)
// GET    /workspace/feeds/:id/items             — feed contents
// GET    /workspace/feeds/:id/sources           — list source rows (slice 4)
// POST   /workspace/feeds/:id/sources           — add a source (slice 4)
// PATCH  /workspace/feeds/:id/sources/:sid      — update weight/sampling/muted
// DELETE /workspace/feeds/:id/sources/:sid      — remove a source (slice 4)
//
// Slice 3 shipped schema + CRUD + an empty-sources placeholder for /items:
// when a feed has no feed_sources rows the route falls back to the caller's
// explore stream. Slice 4 wires source authoring + makes /items honour rows.
// Weight + sampling_mode are still ignored — the ranking story comes later.
//
// Authz: feeds are private to the owner. Every read and write asserts
// ownership before touching the row. There is no public-feed concept on this
// branch yet.
//
// This plugin is an internal split (item 4): each concern lives in its own
// module under routes/feeds/ and registers its routes into the shared `app`
// here, so the route table and prefix are unchanged. The sources module keeps
// addSource / the removeSource DELETE handler / markFollowListDirty co-located
// to preserve the feed-derived external_subscriptions invariant.
// =============================================================================

export async function feedsRoutes(app: FastifyInstance) {
  registerFeedCrudRoutes(app);
  registerFeedItemsRoutes(app);
  registerFeedSourcesRoutes(app);
  registerAuthorVolumeRoutes(app);
  registerFeedSavesRoutes(app);
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import { requireAuth } from "../../middleware/auth.js";
import logger from "@platform-pub/shared/lib/logger.js";
import {
  UUID_RE,
  type FeedRow,
  feedRowToResponse,
  loadFeed,
  tagged,
} from "./shared.js";
import { removeSource } from "./sources.js";

const createFeedSchema = z.object({
  name: z.string().trim().max(80).default(""),
});

// Curated per-feed colour schemes (migration 112). Must mirror the scheme ids
// in web/src/components/workspace/tokens.ts — adding a scheme touches both.
// The web client normalises unknown ids to the light default, so a stale
// client against a newer server degrades gracefully; the enum here just stops
// junk reaching the row. The colourful schemes have been replaced by the
// four-seasons family (DESIGN-TUNING-FINDINGS §3, superseding the
// FEED-SCHEME-REFRESH-ADR renames blush/sage/sand/slate → mata/cobalto →
// anil/vela/caju); rows still holding a retired id are migrated on read by the
// client's normalizeBrightness alias map, so no DB backfill is needed — only
// new ids are ever written back here.
// A feed scheme is a COLOURWAY (seasonal character); light/dark is the global
// per-device toggle, not the per-feed scheme. Must mirror SCHEME_OPTIONS in
// web/src/components/workspace/tokens.ts. The retired mode-fixed ids
// "primary"/"dark" stay accepted (they alias to "basic" on the client) so a
// feed PATCH that round-trips an old persisted value is not rejected.
const FEED_SCHEME_IDS = [
  "basic",
  "spring",
  "summer",
  "autumn",
  "winter",
  "primary",
  "dark",
] as const;

// Per-feed density (MOBILE-LAYOUT-ADR §VI): feed character like the scheme,
// stored as a second key in the same appearance JSONB — no DDL. Must mirror
// the Density type in web/src/components/workspace/tokens.ts.
const FEED_DENSITIES = ["compact", "standard", "full"] as const;

// PATCH accepts any of name + appearance + hidden. Appearance is merged into
// the existing JSONB (not replaced) so future appearance keys written by
// another surface survive a scheme-only update. `hidden` is feed character
// (MOBILE-LAYOUT-ADR §V): it travels with the feed, excludes it from the
// mobile rotation, and skips it in the 1..N numbering on both surfaces.
const patchFeedSchema = z
  .object({
    name: z.string().trim().max(80).optional(),
    appearance: z
      .object({
        scheme: z.enum(FEED_SCHEME_IDS).optional(),
        density: z.enum(FEED_DENSITIES).optional(),
      })
      .strict()
      .refine((a) => a.scheme !== undefined || a.density !== undefined, {
        message: "Empty appearance",
      })
      .optional(),
    hidden: z.boolean().optional(),
  })
  .refine(
    (b) =>
      b.name !== undefined ||
      b.appearance !== undefined ||
      b.hidden !== undefined,
    {
      message: "Nothing to update",
    },
  );

// ---------------------------------------------------------------------------
// Starter-feed seeding (FEED-RETIREMENT Slice 3, workstream B).
//
// A brand-new account follows nobody, so a bare reach:following vessel would be
// empty. Instead new accounts get a CLONE of each operator-designated template
// feed (feeds.is_starter_template = true): a real, fully-editable owned feed,
// not a special-cased default object. The clone copies the template's name,
// appearance and every feed_sources row, and records provenance in
// cloned_from_feed_id.
//
// An operator flags a template by hand:
//   UPDATE feeds SET is_starter_template = true WHERE id = '<feed-uuid>';
// PREREQ: until ≥1 feed is flagged, seeding is a no-op and a new account falls
// back to the client's empty-default-feed mint (unchanged legacy behaviour).
// ---------------------------------------------------------------------------

// Clone one template feed for a new owner inside an open transaction. Returns
// the new feed id. sortRank is supplied by the caller so a batch of clones gets
// a stable 1..N order.
async function cloneFeedForOwner(
  client: { query: typeof pool.query },
  templateId: string,
  ownerId: string,
  sortRank: number,
): Promise<string> {
  const {
    rows: [feed],
  } = await client.query<{ id: string }>(
    `INSERT INTO feeds (owner_id, name, appearance, sort_rank, cloned_from_feed_id)
     SELECT $2, t.name, t.appearance, $3, t.id
       FROM feeds t WHERE t.id = $1
     RETURNING id`,
    [templateId, ownerId, sortRank],
  );
  // Copy every source row verbatim (all five source_types, incl. reach), minus
  // the identity/parent columns. A fresh id + the new feed_id; weight, sampling,
  // exclude_replies and the polymorphic target all carry over.
  await client.query(
    `INSERT INTO feed_sources
       (feed_id, source_type, account_id, publication_id, external_source_id,
        tag_name, reach_kind, weight, sampling_mode, exclude_replies)
     SELECT $1, source_type, account_id, publication_id, external_source_id,
            tag_name, reach_kind, weight, sampling_mode, exclude_replies
       FROM feed_sources WHERE feed_id = $2`,
    [feed.id, templateId],
  );
  return feed.id;
}

// Idempotent: clone all flagged templates for an owner who has none of their
// own feeds yet. Guarded by a per-owner advisory lock so two concurrent first
// loads (e.g. signup racing the first workspace fetch) can't double-seed.
// Returns the number of feeds seeded (0 if the owner already has feeds or no
// template is flagged).
async function seedStarterFeeds(ownerId: string): Promise<number> {
  // Fast path: the overwhelming-common case is an owner who already has feeds.
  // A cheap unlocked COUNT keeps the per-request cost off the hot path — we
  // only open a transaction + take the advisory lock when there's nothing yet.
  const {
    rows: [{ count: pre }],
  } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM feeds WHERE owner_id = $1`,
    [ownerId],
  );
  if (parseInt(pre, 10) > 0) return 0;

  return withTransaction(async (client) => {
    // Serialise per owner. hashtextextended → bigint for the advisory key.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `feed-seed:${ownerId}`,
    ]);
    const {
      rows: [{ count }],
    } = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM feeds WHERE owner_id = $1`,
      [ownerId],
    );
    if (parseInt(count, 10) > 0) return 0;

    const { rows: templates } = await client.query<{ id: string }>(
      `SELECT id FROM feeds WHERE is_starter_template = true
       ORDER BY created_at ASC, id ASC`,
    );
    let rank = 1;
    for (const t of templates) {
      // A template owned by the new account would self-reference; skip (can't
      // happen for a brand-new account, but cheap and defensive).
      await cloneFeedForOwner(client, t.id, ownerId, rank);
      rank++;
    }
    return templates.length;
  });
}

// List the caller's feeds in rank order, seeding starter templates first for an
// owner with none (MOBILE-LAYOUT-ADR §VII: sort_rank is the persisted order
// behind the numeral and the mobile swipe sequence; created_at/id are
// deterministic tie-breaks). Returns the raw FeedRow[] (carrying source_count)
// so callers can both map to the wire shape AND branch the items query on
// source_count without a second round trip. Shared by GET /feeds and the
// /bootstrap aggregate (performance audit #3).
export async function listFeedsForOwner(ownerId: string): Promise<FeedRow[]> {
  // Zero-feeds guard (Slice 3, workstream B): seed starter-template clones on
  // first load for any owner with no feeds — covers fresh signups (both OAuth
  // and email paths) and pre-existing empty accounts uniformly, since every
  // workspace session reads this list. Idempotent + advisory-locked. No-op when
  // no template is flagged (the client then mints an empty feed).
  try {
    await seedStarterFeeds(ownerId);
  } catch (err) {
    // Never block the workspace on a seeding hiccup — log and serve whatever
    // feeds exist (possibly none, in which case the client mints a default).
    logger.error({ err, ownerId }, "Starter-feed seeding failed");
  }
  const { rows } = await pool.query<FeedRow>(
    `SELECT f.id, f.name, f.appearance, f.sort_rank, f.hidden, f.created_at, f.updated_at,
       (SELECT COUNT(*)::int FROM feed_sources fs WHERE fs.feed_id = f.id) AS source_count,
       EXISTS (SELECT 1 FROM feeds t
               WHERE t.id = f.cloned_from_feed_id AND t.is_starter_template) AS from_starter
     FROM feeds f
     WHERE f.owner_id = $1
     ORDER BY f.sort_rank ASC, f.created_at ASC, f.id ASC`,
    [ownerId],
  );
  return rows;
}

// Create a feed for an owner, ranked last (max+1 within the owner's set). A
// concurrent create can tie; ties are fine (read order falls back to
// created_at). Extracted from POST /feeds (FOLLOW-GRAPH-IMPORT-ADR §11.1) so
// the follow-import engine can mint the import's target feed through the same
// path. Returns the full FeedRow (source_count 0 by construction).
export async function createFeedForOwner(
  ownerId: string,
  name: string,
  db: { query: typeof pool.query } = pool,
): Promise<FeedRow> {
  const { rows } = await db.query<FeedRow>(
    `INSERT INTO feeds (owner_id, name, sort_rank)
     VALUES ($1, $2,
       (SELECT COALESCE(MAX(sort_rank), 0) + 1 FROM feeds WHERE owner_id = $1))
     RETURNING id, name, appearance, sort_rank, hidden, created_at, updated_at, 0::int AS source_count, false AS from_starter`,
    [ownerId, name],
  );
  return rows[0];
}

export function registerFeedCrudRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /feeds — list mine, in rank order
  // ---------------------------------------------------------------------------
  app.get("/feeds", { preHandler: requireAuth }, async (req, reply) => {
    const ownerId = req.session!.sub;
    const rows = await listFeedsForOwner(ownerId);
    return reply.send({ feeds: rows.map(feedRowToResponse) });
  });

  // ---------------------------------------------------------------------------
  // POST /feeds — create
  // ---------------------------------------------------------------------------
  app.post<{ Body: unknown }>(
    "/feeds",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub;
      const parsed = createFeedSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const feed = await createFeedForOwner(ownerId, parsed.data.name);
      return reply.status(201).send({ feed: feedRowToResponse(feed) });
    },
  );

  // ---------------------------------------------------------------------------
  // PATCH /feeds/:id — rename and/or set appearance (colour scheme)
  // ---------------------------------------------------------------------------
  app.patch<{ Params: { id: string }; Body: unknown }>(
    "/feeds/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub;
      const { id } = req.params;
      if (!UUID_RE.test(id))
        return reply.status(400).send({ error: "Invalid feed id" });

      const parsed = patchFeedSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "Invalid body", details: parsed.error.flatten() });
      }

      const sets: string[] = [];
      const vals: unknown[] = [];
      let paramIdx = 3; // $1=id, $2=ownerId
      if (parsed.data.name !== undefined) {
        sets.push(`name = $${paramIdx}`);
        vals.push(parsed.data.name);
        paramIdx++;
      }
      if (parsed.data.appearance !== undefined) {
        // JSONB merge, not replace — future appearance keys survive a
        // scheme-only update.
        sets.push(`appearance = appearance || $${paramIdx}::jsonb`);
        vals.push(JSON.stringify(parsed.data.appearance));
        paramIdx++;
      }
      if (parsed.data.hidden !== undefined) {
        sets.push(`hidden = $${paramIdx}`);
        vals.push(parsed.data.hidden);
        paramIdx++;
      }

      const { rows } = await pool.query<FeedRow>(
        `UPDATE feeds SET ${sets.join(", ")}
         WHERE id = $1 AND owner_id = $2
         RETURNING id, name, appearance, sort_rank, hidden, created_at, updated_at,
           (SELECT COUNT(*)::int FROM feed_sources fs WHERE fs.feed_id = feeds.id) AS source_count,
           EXISTS (SELECT 1 FROM feeds t
                   WHERE t.id = feeds.cloned_from_feed_id AND t.is_starter_template) AS from_starter`,
        [id, ownerId, ...vals],
      );
      if (rows.length === 0)
        return reply.status(404).send({ error: "Feed not found" });
      return reply.send({ feed: feedRowToResponse(rows[0]) });
    },
  );

  // ---------------------------------------------------------------------------
  // PUT /feeds/order — bulk re-rank (MOBILE-LAYOUT-ADR §VII.3)
  //
  // Body: { feedIds } — the caller's complete feed set in the desired order.
  // Ranks are plain integers rewritten in full on each reorder (feeds per
  // user are few; fractional keys are unjustified complexity). Requiring the
  // full set keeps a stale client from silently interleaving with a feed
  // created in another tab — on mismatch the client refetches and retries.
  // ---------------------------------------------------------------------------
  app.put<{ Body: unknown }>(
    "/feeds/order",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub;
      const parsed = z
        .object({ feedIds: z.array(z.string().uuid()).min(1).max(500) })
        .safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const ids = parsed.data.feedIds;
      if (new Set(ids).size !== ids.length)
        return reply.status(400).send({ error: "Duplicate feed ids" });

      const { rows: ownedRows } = await pool.query<{ id: string }>(
        `SELECT id FROM feeds WHERE owner_id = $1`,
        [ownerId],
      );
      const owned = new Set(ownedRows.map((r) => r.id));
      if (ids.length !== owned.size || ids.some((id) => !owned.has(id))) {
        return reply.status(409).send({
          error: "Feed list out of date — refresh and retry",
        });
      }

      await pool.query(
        `UPDATE feeds f
         SET sort_rank = x.rank
         FROM unnest($2::uuid[]) WITH ORDINALITY AS x(id, rank)
         WHERE f.id = x.id AND f.owner_id = $1`,
        [ownerId, ids],
      );

      const { rows } = await pool.query<FeedRow>(
        `SELECT f.id, f.name, f.appearance, f.sort_rank, f.hidden, f.created_at, f.updated_at,
           (SELECT COUNT(*)::int FROM feed_sources fs WHERE fs.feed_id = f.id) AS source_count,
           EXISTS (SELECT 1 FROM feeds t
                   WHERE t.id = f.cloned_from_feed_id AND t.is_starter_template) AS from_starter
         FROM feeds f
         WHERE f.owner_id = $1
         ORDER BY f.sort_rank ASC, f.created_at ASC, f.id ASC`,
        [ownerId],
      );
      return reply.send({ feeds: rows.map(feedRowToResponse) });
    },
  );

  // ---------------------------------------------------------------------------
  // DELETE /feeds/:id
  // ---------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    "/feeds/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub;
      const { id } = req.params;
      if (!UUID_RE.test(id))
        return reply.status(400).send({ error: "Invalid feed id" });

      const feed = await loadFeed(id, ownerId);
      if (!feed) return reply.status(404).send({ error: "Feed not found" });

      const {
        rows: [{ count }],
      } = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM feeds WHERE owner_id = $1`,
        [ownerId],
      );
      if (parseInt(count, 10) <= 1)
        return reply
          .status(409)
          .send({ error: "Cannot delete your only feed" });

      // Tear down external sources through removeSource FIRST (H6). A bare
      // DELETE cascades feed_sources away without passing through the
      // feed-derived-subscription teardown: the derived external_subscriptions
      // row would survive, so the source polls forever (the GC keys "orphaned"
      // on external_subscriptions), the author card stays "Following" with no
      // surface left to undo it, and a nostr_external follow stays on the
      // published kind-3. Each call handles its own last-feed check + advisory
      // lock. recordExclusion:false — deleting a feed isn't a curation edit, and
      // its feed_import_exclusions cascade away with it anyway.
      const { rows: extSources } = await pool.query<{ id: string }>(
        `SELECT id FROM feed_sources
          WHERE feed_id = $1 AND source_type = 'external_source'`,
        [id],
      );
      for (const s of extSources) {
        await removeSource(id, ownerId, s.id, { recordExclusion: false });
      }

      const { rowCount } = await pool.query(
        `DELETE FROM feeds WHERE id = $1 AND owner_id = $2`,
        [id, ownerId],
      );
      if (rowCount === 0)
        return reply.status(404).send({ error: "Feed not found" });
      return reply.status(204).send();
    },
  );

  // ---------------------------------------------------------------------------
  // POST /feeds/:id/merge — merge a source feed into this (target) feed
  //
  // Moves non-duplicate sources and saves from the source feed into the
  // target, then deletes the source feed. Both feeds must exist and be
  // owned by the caller.
  // ---------------------------------------------------------------------------
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/feeds/:id/merge",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub;
      const { id: targetId } = req.params;
      if (!UUID_RE.test(targetId))
        return reply.status(400).send({ error: "Invalid feed id" });

      const parsed = z
        .object({ sourceFeedId: z.string().uuid() })
        .safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const { sourceFeedId } = parsed.data;

      if (sourceFeedId === targetId) {
        return reply
          .status(400)
          .send({ error: "Cannot merge a feed into itself" });
      }

      try {
        await withTransaction(async (client) => {
          // 1. Verify both feeds exist and are owned by the caller.
          const { rows: feedRows } = await client.query<{
            id: string;
            owner_id: string;
          }>(`SELECT id, owner_id FROM feeds WHERE id = ANY($1::uuid[])`, [
            [targetId, sourceFeedId],
          ]);
          const targetFeed = feedRows.find((r) => r.id === targetId);
          const sourceFeed = feedRows.find((r) => r.id === sourceFeedId);

          if (!targetFeed) {
            throw tagged("NOT_FOUND_TARGET");
          }
          if (!sourceFeed) {
            throw tagged("NOT_FOUND_SOURCE");
          }
          if (targetFeed.owner_id !== ownerId) {
            throw tagged("FORBIDDEN_TARGET");
          }
          if (sourceFeed.owner_id !== ownerId) {
            throw tagged("FORBIDDEN_SOURCE");
          }

          // 2. Move non-duplicate sources from source → target.
          //    Exclude rows that would conflict with existing target sources
          //    by matching on type + FK.
          await client.query(
            `UPDATE feed_sources SET feed_id = $1
             WHERE feed_id = $2
               AND NOT EXISTS (
                 SELECT 1 FROM feed_sources t
                 WHERE t.feed_id = $1
                   AND t.source_type = feed_sources.source_type
                   AND (
                     (t.source_type = 'account' AND t.account_id = feed_sources.account_id)
                     OR (t.source_type = 'publication' AND t.publication_id = feed_sources.publication_id)
                     OR (t.source_type = 'external_source' AND t.external_source_id = feed_sources.external_source_id)
                     OR (t.source_type = 'tag' AND t.tag_name = feed_sources.tag_name)
                   )
               )`,
            [targetId, sourceFeedId],
          );

          // 3. Delete remaining orphaned source rows (duplicates that couldn't move).
          await client.query(`DELETE FROM feed_sources WHERE feed_id = $1`, [
            sourceFeedId,
          ]);

          // 4. Move non-duplicate saves.
          await client.query(
            `INSERT INTO feed_saves (id, feed_id, feed_item_id, created_at)
             SELECT gen_random_uuid(), $1, feed_item_id, created_at
             FROM feed_saves WHERE feed_id = $2
             ON CONFLICT (feed_id, feed_item_id) DO NOTHING`,
            [targetId, sourceFeedId],
          );

          // 5. Delete the source feed (cascades remaining feed_saves).
          await client.query(`DELETE FROM feeds WHERE id = $1`, [sourceFeedId]);
        });

        // 6. Return the updated target feed.
        const updatedFeed = await loadFeed(targetId, ownerId);
        if (!updatedFeed)
          return reply.status(404).send({ error: "Feed not found" });
        return reply.send({ feed: feedRowToResponse(updatedFeed) });
      } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        if (code === "NOT_FOUND_TARGET" || code === "NOT_FOUND_SOURCE") {
          return reply.status(404).send({ error: "Feed not found" });
        }
        if (code === "FORBIDDEN_TARGET" || code === "FORBIDDEN_SOURCE") {
          return reply.status(403).send({ error: "Feed not owned by you" });
        }
        logger.error({ err, targetId, sourceFeedId }, "Feed merge failed");
        return reply.status(500).send({ error: "Feed merge failed" });
      }
    },
  );
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { requireAuth } from "../middleware/auth.js";
import { UUID_RE } from "../lib/uuid.js";
import { createFeedForOwner } from "./feeds/crud.js";
import { feedRowToResponse } from "./feeds/shared.js";
import {
  followImportEnabled,
  importFeedName,
  readFollowGraph,
  kickFollowImportSweep,
  FOLLOW_IMPORT_CAP,
} from "../lib/follow-import.js";

// =============================================================================
// Follow-graph import runs (FOLLOW-GRAPH-IMPORT-ADR §11.3).
//
// POST /follow-imports — validate the origin, read the remote graph ONCE, cap
// it, and persist the run row (identities + cursor make the sweep restartable)
// plus the origin binding and the new feed, all in one transaction. The sweep
// (gateway scheduler / the immediate kick) then feeds each identity through
// the addSource core. GET /follow-imports/:id is the client's progress poll.
//
// Dark behind FOLLOW_IMPORT_ENABLED (routes 404 when off, like an unshipped
// feature). Imports are opt-in per run — nothing here fires automatically on
// account link (D7).
// =============================================================================

const createImportSchema = z.object({
  protocol: z.enum(["atproto", "nostr_external", "activitypub", "rss"]),
  originIdentity: z.string().trim().min(1).max(2048),
  feedName: z.string().trim().min(1).max(80).optional(),
});

interface FollowImportStatusRow {
  id: string;
  protocol: string;
  origin_identity: string;
  feed_id: string;
  status: string;
  total: number;
  imported: number;
  skipped: number;
  failed: number;
  error: string | null;
  created_at: Date;
  finished_at: Date | null;
}

function importRowToResponse(row: FollowImportStatusRow) {
  return {
    id: row.id,
    protocol: row.protocol,
    originIdentity: row.origin_identity,
    feedId: row.feed_id,
    status: row.status,
    total: row.total,
    imported: row.imported,
    skipped: row.skipped,
    failed: row.failed,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

export default async function followImportRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // POST /follow-imports — start an import run
  // ---------------------------------------------------------------------------
  app.post<{ Body: unknown }>(
    "/follow-imports",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!followImportEnabled())
        return reply.status(404).send({ error: "Not found" });
      const ownerId = req.session!.sub;

      const parsed = createImportSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const { protocol, originIdentity, feedName } = parsed.data;

      const graph = await readFollowGraph(protocol, originIdentity);
      if (!graph.ok) {
        if (graph.reason === "unsupported")
          return reply
            .status(400)
            .send({ error: "import_unsupported", message: graph.message });
        if (graph.reason === "malformed")
          return reply
            .status(400)
            .send({ error: "invalid_origin", message: graph.message });
        return reply
          .status(422)
          .send({ error: "origin_unreachable", message: graph.message });
      }
      if (graph.identities.length === 0) {
        // Reachable but nothing to import (an empty follow list). Distinct
        // from unreachable so the client can say so plainly.
        return reply.status(422).send({
          error: "empty_graph",
          message: "This account doesn't follow anyone we can import",
        });
      }

      const { feed, importId } = await withTransaction(async (client) => {
        const feedRow = await createFeedForOwner(
          ownerId,
          feedName ?? importFeedName(protocol),
          client,
        );
        // Origin binding recorded from Phase 1 (§6.3) so the feed is
        // sync-capable retroactively when Phase 2 ships.
        await client.query(
          `INSERT INTO feed_import_bindings (feed_id, protocol, origin_identity)
           VALUES ($1, $2, $3)`,
          [feedRow.id, protocol, graph.originIdentity],
        );
        const {
          rows: [run],
        } = await client.query<{ id: string }>(
          `INSERT INTO follow_imports
             (account_id, protocol, origin_identity, feed_id, total, identities)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)
           RETURNING id`,
          [
            ownerId,
            protocol,
            graph.originIdentity,
            feedRow.id,
            graph.identities.length,
            JSON.stringify(graph.identities),
          ],
        );
        return { feed: feedRow, importId: run.id };
      });

      // Start processing now rather than on the next scheduler tick. Best
      // effort — the scheduler sweep picks the row up regardless.
      kickFollowImportSweep().catch((err) =>
        logger.warn({ err, importId }, "follow import kick failed"));

      return reply.status(201).send({
        import: {
          id: importId,
          protocol,
          originIdentity: graph.originIdentity,
          originLabel: graph.originLabel,
          feedId: feed.id,
          status: "pending",
          total: graph.identities.length,
          imported: 0,
          skipped: 0,
          failed: 0,
          // No-silent-caps rule: the offer/summary states truncation.
          remoteTotal: graph.total,
          truncated: graph.truncated,
          cap: FOLLOW_IMPORT_CAP,
        },
        feed: feedRowToResponse(feed),
      });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /follow-imports/:id — progress poll
  // ---------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    "/follow-imports/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!followImportEnabled())
        return reply.status(404).send({ error: "Not found" });
      const ownerId = req.session!.sub;
      const { id } = req.params;
      if (!UUID_RE.test(id))
        return reply.status(400).send({ error: "Invalid import id" });

      const { rows } = await pool.query<FollowImportStatusRow>(
        `SELECT id, protocol, origin_identity, feed_id, status, total,
                imported, skipped, failed, error, created_at, finished_at
           FROM follow_imports
          WHERE id = $1 AND account_id = $2`,
        [id, ownerId],
      );
      if (rows.length === 0)
        return reply.status(404).send({ error: "Import not found" });
      return reply.send({ import: importRowToResponse(rows[0]) });
    },
  );
}

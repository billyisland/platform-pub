import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "@platform-pub/shared/db/client.js";
import { requireAuth } from "../middleware/auth.js";
import {
  markFollowListDirty,
  retractFollowList,
} from "../lib/discovery-publish.js";
import logger from "@platform-pub/shared/lib/logger.js";

// =============================================================================
// Privacy preferences
//
//   GET /me/privacy-preferences   — fetch privacy/sharing prefs
//   PUT /me/privacy-preferences   — update privacy/sharing prefs
//
// publish_follow_graph controls whether the user's follow list (internal +
// external Nostr) is published to the Nostr mesh as a kind-3 contact list.
// Default ON ("all means all"). Turning it OFF retracts the previously-published
// list (publishes an empty kind 3); turning it ON marks it dirty so the
// scheduler sweep republishes from current state. See
// docs/adr/NOSTR-OUTBOUND-INTEROP-ADR.md §5 (Risk #3).
// =============================================================================

const PrivacyPrefsSchema = z.object({
  publishFollowGraph: z.boolean(),
});

export async function privacyPreferencesRoutes(app: FastifyInstance) {
  app.get(
    "/me/privacy-preferences",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub;
      const { rows } = await pool.query<{ publish_follow_graph: boolean }>(
        "SELECT publish_follow_graph FROM accounts WHERE id = $1",
        [userId],
      );
      if (rows.length === 0) {
        return reply.status(404).send({ error: "Account not found" });
      }
      return reply.send({ publishFollowGraph: rows[0].publish_follow_graph });
    },
  );

  app.put(
    "/me/privacy-preferences",
    { preHandler: requireAuth },
    async (req, reply) => {
      const parsed = PrivacyPrefsSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const userId = req.session!.sub;
      const { publishFollowGraph } = parsed.data;

      await pool.query(
        "UPDATE accounts SET publish_follow_graph = $1, updated_at = now() WHERE id = $2",
        [publishFollowGraph, userId],
      );

      // Reflect the change on the mesh (no-op when discovery is disabled).
      if (publishFollowGraph) {
        // Opt-in: republish from current state on the next sweep cycle.
        markFollowListDirty(userId).catch((err) =>
          logger.warn({ err, userId }, "privacy: failed to mark follow list dirty"));
      } else {
        // Opt-out: retract immediately by publishing an empty kind 3.
        retractFollowList(userId).catch((err) =>
          logger.warn({ err, userId }, "privacy: failed to retract follow list"));
      }

      return reply.send({ ok: true, publishFollowGraph });
    },
  );
}

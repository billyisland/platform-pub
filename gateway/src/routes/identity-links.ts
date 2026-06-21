import type { FastifyInstance } from "fastify";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import { requireAuth } from "../middleware/auth.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { loadAuthorLinkSource } from "./author.js";

// =============================================================================
// Cross-source identity links — Slice 8 P2 ("Link to…" / "Unlink")
//
// A user_asserted link records one reader's claim that two external sources are
// the same identity cross-posting the same content — the input the dedup CTEs in
// sourceFilteredItems consume (drop the loser twin, surface "ALSO ON …"). Per
// the SLICE-8 plan's owner model these are OWNER-SCOPED (owner_id = asserter,
// confidence 1.0): an unverifiable claim suppresses content only in the
// asserter's own feed, never globally. Global automated links + the negative
// override are P3.
//
//   POST   /author/:authorId/links            { protocol, sourceUri } → create
//   DELETE /author/:authorId/links/:linkId                            → unlink
//
// source_a is the viewed author's backing source (derived server-side from
// authorId — never trusted from the client). source_b is the pasted target,
// upserted into external_sources so the link's FK resolves. The pair is stored
// LEAST/GREATEST-ordered to satisfy the table's `source_a_id < source_b_id`
// CHECK (A/B and B/A collapse to one row). At P2 every row is owner_id NOT NULL,
// so unlink is a plain owner-scoped DELETE — no NULL-owner branch, no tombstone.
// =============================================================================

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Protocols a link target can carry — mirrors addSource's per-protocol shape
// (sources.ts) and the client's FOLLOWABLE_PROTOCOLS. email is intentionally
// excluded (no stable subscribable identity to dedup against).
function validateTarget(protocol: string, sourceUri: string): boolean {
  switch (protocol) {
    case "rss":
      try {
        const u = new URL(sourceUri);
        return u.protocol === "http:" || u.protocol === "https:";
      } catch {
        return false;
      }
    case "activitypub":
      try {
        return new URL(sourceUri).protocol === "https:";
      } catch {
        return false;
      }
    case "atproto":
      return /^did:(plc|web):[a-zA-Z0-9.:_-]+$/.test(sourceUri);
    case "nostr_external":
      return /^[0-9a-f]{64}$/i.test(sourceUri);
    default:
      return false;
  }
}

export async function identityLinkRoutes(app: FastifyInstance) {
  // POST /author/:authorId/links — assert that this author is also `sourceUri`.
  app.post<{
    Params: { authorId: string };
    Body: { protocol?: string; sourceUri?: string };
  }>(
    "/author/:authorId/links",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const { authorId } = req.params;
      const viewerId = req.session!.sub;
      const protocol = req.body?.protocol;
      const sourceUri = req.body?.sourceUri;

      if (!UUID_RE.test(authorId)) {
        return reply.status(400).send({ error: "Invalid author id" });
      }
      if (!protocol || !sourceUri || !validateTarget(protocol, sourceUri)) {
        return reply.status(400).send({ error: "Invalid link target" });
      }

      try {
        // source_a — the viewed author's own backing source, server-derived.
        const srcA = await loadAuthorLinkSource(authorId);
        if (!srcA) {
          return reply
            .status(400)
            .send({ error: "Author has no linkable source" });
        }

        const result = await withTransaction(async (client) => {
          // Upsert source_b so the link FK resolves. Minimal SET (touch
          // updated_at only) — a link must NOT revive/reactivate an orphaned or
          // unsubscribed source (no subscription is implied by linking); the GC
          // is link-aware so the bare row survives (external-sources-gc.ts).
          const {
            rows: [srcBRow],
          } = await client.query<{
            id: string;
            display_name: string | null;
          }>(
            `INSERT INTO external_sources (protocol, source_uri)
             VALUES ($1::external_protocol, $2)
             ON CONFLICT (protocol, source_uri)
               DO UPDATE SET updated_at = now()
             RETURNING id, display_name`,
            [protocol, sourceUri],
          );
          const sourceBId = srcBRow.id;

          if (sourceBId === srcA.sourceId) {
            return { selfLink: true as const };
          }

          // Order the pair (the table CHECK requires source_a_id < source_b_id)
          // and insert the owner-scoped assertion. ON CONFLICT no-op update so a
          // re-assert returns the existing row's id rather than erroring.
          const {
            rows: [link],
          } = await client.query<{ id: string }>(
            // ::uuid so LEAST/GREATEST order by uuid (the CHECK's comparison),
            // not as text. Both inputs are lowercase canonical UUIDs so the two
            // orderings agree, but the cast makes that explicit and correct.
            `INSERT INTO external_identity_links
               (source_a_id, source_b_id, link_type, confidence, owner_id)
             VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid),
                     'user_asserted', 1.0, $3)
             ON CONFLICT (source_a_id, source_b_id, owner_id)
               WHERE owner_id IS NOT NULL
               DO UPDATE SET confidence = EXCLUDED.confidence
             RETURNING id`,
            [srcA.sourceId, sourceBId, viewerId],
          );

          return {
            selfLink: false as const,
            linkId: link.id,
            sourceBId,
            displayName: srcBRow.display_name,
          };
        });

        if (result.selfLink) {
          return reply
            .status(400)
            .send({ error: "Cannot link an author to itself" });
        }

        // The new chip the surface appends without a refetch.
        return reply.status(201).send({
          linkedSource: {
            linkId: result.linkId,
            protocol,
            sourceUri,
            displayName: result.displayName ?? undefined,
            sourceId: result.sourceBId,
          },
        });
      } catch (err) {
        logger.error({ err, authorId }, "Identity link create failed");
        return reply.status(500).send({ error: "Link failed" });
      }
    },
  );

  // DELETE /author/:authorId/links/:linkId — unlink.
  //   • the viewer's own user_asserted row → hard DELETE.
  //   • a global automated link (owner NULL, P3 detection) → can't delete a fact
  //     for everyone, so write an owner-scoped `user_unlinked` tombstone for the
  //     same ordered pair; the read path (dedup-sql.ts applicable_links)
  //     subtracts it for this viewer only.
  app.delete<{ Params: { authorId: string; linkId: string } }>(
    "/author/:authorId/links/:linkId",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const { linkId } = req.params;
      const viewerId = req.session!.sub;
      if (!UUID_RE.test(linkId)) {
        return reply.status(400).send({ error: "Invalid link id" });
      }

      try {
        // Look up the target link. Only the viewer's own assertion or a global
        // link is actionable (another reader's assertion is invisible/untouchable).
        const {
          rows: [link],
        } = await pool.query<{
          source_a_id: string;
          source_b_id: string;
          owner_id: string | null;
          link_type: string;
        }>(
          `SELECT source_a_id, source_b_id, owner_id, link_type
             FROM external_identity_links WHERE id = $1`,
          [linkId],
        );
        if (!link) {
          return reply.status(404).send({ error: "Link not found" });
        }

        if (link.owner_id === viewerId && link.link_type === "user_asserted") {
          await pool.query(
            `DELETE FROM external_identity_links WHERE id = $1`,
            [linkId],
          );
          return reply.status(204).send();
        }

        if (link.owner_id === null && link.link_type !== "user_unlinked") {
          // Tombstone the pair for this viewer. The pair is already ordered
          // (source_a_id < source_b_id) on the global row, so reuse it directly.
          // The DO UPDATE skips when the viewer's own owner-scoped row is already
          // a personal `user_asserted` link: the viewer both asserts this pair
          // and is tombstoning the global for it → the personal assertion wins,
          // the global stays (effectively) un-tombstoned for them (they assert it).
          await pool.query(
            `INSERT INTO external_identity_links
               (source_a_id, source_b_id, link_type, confidence, owner_id)
             VALUES ($1, $2, 'user_unlinked', 1.0, $3)
             ON CONFLICT (source_a_id, source_b_id, owner_id)
               WHERE owner_id IS NOT NULL
               DO UPDATE SET link_type = 'user_unlinked'
                 WHERE external_identity_links.link_type <> 'user_asserted'`,
            [link.source_a_id, link.source_b_id, viewerId],
          );
          return reply.status(204).send();
        }

        // Another reader's assertion, or already a tombstone → nothing to do.
        return reply.status(404).send({ error: "Link not found" });
      } catch (err) {
        logger.error({ err, linkId }, "Identity link delete failed");
        return reply.status(500).send({ error: "Unlink failed" });
      }
    },
  );
}

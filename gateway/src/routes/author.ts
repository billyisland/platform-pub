import type { FastifyInstance } from "fastify";
import { pool } from "@platform-pub/shared/db/client.js";
import { requireAuth } from "../middleware/auth.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { FEED_SELECT, FEED_JOINS, parseCursor } from "./timeline.js";
import { POST_SELECT, POST_JOINS, feedItemToPost } from "../lib/post-mapper.js";
import {
  type AuthorCardResponse,
  resolveNativeAuthor,
  fetchBlueskyProfile,
  fetchAPProfile,
} from "../lib/author-resolve.js";

// =============================================================================
// Constructed author profile — UNIVERSAL-POST-ADR Phase 4 (§4.4, §9, §VI.3)
//
// Two endpoints keyed on the PERSISTENT author identity (author.id) — native
// accounts.id or the tier-A/B external_authors.id minted in Phase 0b. Keying on
// the identity record (not a single external_item, as the legacy /author-card
// does) is what lets one profile aggregate an author's posts across every source
// that resolves to the same author.id.
//
//   GET /author/:authorId/profile  → AuthorCardResponse (bio + stats | none)
//   GET /author/:authorId/posts    → { items: Post[], nextCursor }
//
// Both share the id-space probe: external_authors by id first, else accounts.
// UUIDs do not collide across the two tables, so the probe is unambiguous.
//
// Tier scope: native + external A/B carry an identity record, so they resolve
// here. Tier-C/D external authors have no external_authors row (no stable
// handle) — their post.author.id is null, so the client never links to /author
// for them (plain-text byline) and a direct hit 404s.
//
// The /profile response is the SAME AuthorCardResponse shape the legacy
// /author-card emits (a documented, deliberate deviation from §9's literal
// `{ author, bio, stats }`): the shape already carries everything the hover
// modal + profile header need, so the shipped AuthorModal renders it unchanged —
// reuse over a parallel shape.
// =============================================================================

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ExternalAuthorRow {
  id: string;
  protocol: string;
  stable_handle: string;
  tier: "A" | "B";
  account_id: string | null;
  display_name: string | null;
  handle: string | null;
  handle_uri: string | null;
  avatar: string | null;
}

async function loadExternalAuthor(
  id: string,
): Promise<ExternalAuthorRow | null> {
  const { rows } = await pool.query<ExternalAuthorRow>(
    `SELECT id, protocol, stable_handle, tier, account_id,
            display_name, handle, handle_uri, avatar
     FROM external_authors WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

async function isNativeAccount(id: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM accounts WHERE id = $1 AND status = 'active') AS exists`,
    [id],
  );
  return rows[0]?.exists ?? false;
}

// Constructed external-author profile: stored identity fields + live-origin
// stats. A representative external_item gives the source (for add-as-source)
// and a host for the Mastodon REST fallback.
async function resolveExternalAuthorById(
  xa: ExternalAuthorRow,
  viewerId: string,
): Promise<AuthorCardResponse> {
  const { rows: repRows } = await pool.query<{
    source_id: string | null;
    source_item_uri: string | null;
    author_uri: string | null;
  }>(
    `SELECT ei.source_id, ei.source_item_uri, ei.author_uri
     FROM feed_items fi
     JOIN external_items ei ON ei.id = fi.external_item_id
     WHERE fi.external_author_id = $1 AND fi.deleted_at IS NULL
     ORDER BY fi.published_at DESC
     LIMIT 1`,
    [xa.id],
  );
  const rep = repRows[0] ?? null;

  // add-as-source target: the representative source (the author may span
  // several; "add this source" mirrors the legacy hover-card affordance).
  let followTarget: AuthorCardResponse["followTarget"];
  if (rep?.source_id) {
    const { rows: srcRows } = await pool.query<{
      protocol: string;
      source_uri: string;
    }>(`SELECT protocol, source_uri FROM external_sources WHERE id = $1`, [
      rep.source_id,
    ]);
    const src = srcRows[0];
    if (src) {
      const { rows: subRows } = await pool.query<{ exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM external_subscriptions
           WHERE subscriber_id = $1 AND source_id = $2
         ) AS exists`,
        [viewerId, rep.source_id],
      );
      followTarget = {
        type: "source",
        id: rep.source_id,
        isFollowing: subRows[0]?.exists ?? false,
        protocol: src.protocol,
        sourceUri: src.source_uri,
      };
    }
  }

  // Stored fields are the always-present base; live origin data overlays them.
  const base: AuthorCardResponse = {
    tier: xa.tier,
    displayName: xa.display_name ?? undefined,
    handle: xa.handle ?? undefined,
    avatarUrl: xa.avatar ?? undefined,
    sourceProtocol: xa.protocol,
    followTarget,
  };

  if (xa.protocol === "atproto") {
    const actor = xa.handle_uri ?? xa.stable_handle; // DID
    const profile = await fetchBlueskyProfile(actor);
    if (profile) {
      return {
        ...base,
        displayName: profile.displayName ?? profile.handle ?? base.displayName,
        handle: profile.handle ?? base.handle,
        avatarUrl: profile.avatar ?? base.avatarUrl,
        bio: profile.description ?? undefined,
        followerCount: profile.followersCount,
        followingCount: profile.followsCount,
        postCount: profile.postsCount,
      };
    }
    return { ...base, partial: true };
  }

  if (xa.protocol === "activitypub") {
    const actor = xa.handle_uri ?? xa.stable_handle; // actor URI
    const profile = await fetchAPProfile(actor, rep?.source_item_uri ?? actor);
    if (profile) {
      return {
        ...base,
        displayName: profile.displayName ?? base.displayName,
        handle: profile.handle ?? base.handle,
        avatarUrl: profile.avatar ?? base.avatarUrl,
        bio: profile.description ?? undefined,
        followerCount: profile.followersCount,
        followingCount: profile.followingCount,
        postCount: profile.postsCount,
        partial: profile.partial,
      };
    }
    return { ...base, partial: true };
  }

  // nostr_external: no live profile API — stored identity fields, no stats
  // (§4.4 "no stats available ⇒ show no stats").
  return base;
}

export async function authorRoutes(app: FastifyInstance) {
  // GET /author/:authorId/profile — hover modal + profile header.
  app.get<{ Params: { authorId: string } }>(
    "/author/:authorId/profile",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const { authorId } = req.params;
      const viewerId = req.session!.sub;
      if (!UUID_RE.test(authorId)) {
        return reply.status(400).send({ error: "Invalid author id" });
      }

      try {
        const xa = await loadExternalAuthor(authorId);
        if (xa) {
          return reply.send(await resolveExternalAuthorById(xa, viewerId));
        }
        if (await isNativeAccount(authorId)) {
          return reply.send(await resolveNativeAuthor(authorId, viewerId));
        }
        return reply.status(404).send({ error: "Author not found" });
      } catch (err) {
        logger.error({ err, authorId }, "Author profile fetch failed");
        return reply.status(500).send({ error: "Author profile fetch failed" });
      }
    },
  );

  // GET /author/:authorId/posts — chronological log, full-view Post[] (§9).
  app.get<{
    Params: { authorId: string };
    Querystring: { cursor?: string; limit?: string };
  }>(
    "/author/:authorId/posts",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const { authorId } = req.params;
      if (!UUID_RE.test(authorId)) {
        return reply.status(400).send({ error: "Invalid author id" });
      }

      const cursor = parseCursor(req.query.cursor);
      const limit = Math.min(
        parseInt(req.query.limit ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT,
        MAX_LIMIT,
      );

      try {
        // id-space probe → the author filter. external_author_id aggregates the
        // author across every source; native filters by author_id.
        const xa = await loadExternalAuthor(authorId);
        let authorFilter: string;
        if (xa) {
          authorFilter = "fi.external_author_id = $1";
        } else if (await isNativeAccount(authorId)) {
          authorFilter =
            "fi.author_id = $1 AND fi.item_type IN ('article', 'note')";
        } else {
          return reply.status(404).send({ error: "Author not found" });
        }

        const cursorClause = cursor
          ? `AND (fi.published_at, fi.id) < (to_timestamp($3), $4::uuid)`
          : "";
        const params: any[] = cursor
          ? [authorId, limit, cursor.ts, cursor.id]
          : [authorId, limit];

        const result = await pool.query<any>(
          `
          SELECT ${FEED_SELECT}${POST_SELECT}
          FROM feed_items fi
          ${FEED_JOINS}
          ${POST_JOINS}
          WHERE fi.deleted_at IS NULL
            AND ${authorFilter}
            AND (ei.is_context_only IS NOT TRUE)
            ${cursorClause}
          ORDER BY fi.published_at DESC, fi.id DESC
          LIMIT $2
          `,
          params,
        );

        const items = result.rows.map(feedItemToPost);
        const lastRow = result.rows[result.rows.length - 1];
        const nextCursor = lastRow
          ? `${Number(lastRow.published_at_epoch)}:${lastRow.fi_id}`
          : undefined;

        return reply.send({ items, nextCursor });
      } catch (err) {
        logger.error({ err, authorId }, "Author posts fetch failed");
        return reply.status(500).send({ error: "Author posts fetch failed" });
      }
    },
  );
}

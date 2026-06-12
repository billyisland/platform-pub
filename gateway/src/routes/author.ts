import type { FastifyInstance } from "fastify";
import { pool } from "@platform-pub/shared/db/client.js";
import { requireAuth } from "../middleware/auth.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { FEED_SELECT, FEED_JOINS, parseCursor } from "../lib/feed-sql.js";
import {
  POST_SELECT,
  POST_JOINS,
  feedItemToPost,
  commentToPost,
} from "../lib/post-mapper.js";
import {
  type AuthorCardResponse,
  resolveNativeAuthor,
  fetchBlueskyProfile,
  fetchAPProfile,
  buildExternalProfileUrl,
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

// The value the subscribe API expects as `sourceUri` for this author's own feed
// — and the source_uri an existing subscription to this author carries:
//   atproto        → bare DID (did:plc:… / did:web:…)
//   activitypub    → actor URI (https…)
//   nostr_external → 64-hex pubkey
// The stored handle is usually already in this shape, but hydration-only authors
// can carry a bsky.app profile URL — so for atproto we extract the embedded DID.
// Returns null when no subscribable identity can be derived (⇒ "not followed",
// and no subscribe affordance), which is the correct, safe default.
function authorFollowUri(xa: ExternalAuthorRow): string | null {
  const h = xa.handle_uri ?? xa.stable_handle;
  switch (xa.protocol) {
    case "atproto":
      return h.match(/did:(?:plc|web):[a-zA-Z0-9.:_-]+/)?.[0] ?? null;
    case "activitypub":
      return /^https:\/\//.test(h) ? h : null;
    case "nostr_external":
      return /^[0-9a-f]{64}$/i.test(xa.stable_handle)
        ? xa.stable_handle
        : null;
    default:
      return null;
  }
}

// Constructed external-author profile: stored identity fields + live-origin
// stats. Follow state is computed from the author's own identity
// (authorFollowUri); a representative external_item is used only for the
// activitypub Mastodon-REST host fallback.
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
  // `rep` is kept ONLY for the activitypub host fallback below (Mastodon REST
  // counts). It must NOT drive follow state: thread-context hydration files
  // every participant's post under the FOCAL author's source_id (see
  // routes/external-items.ts), so the representative item's source is the focal
  // author's source for anyone who appears only inside an expanded conversation.
  // Keying isFollowing off it made every participant in an external thread
  // inherit the focal author's "FOLLOWING" state.
  const rep = repRows[0] ?? null;

  // Follow state keys on the AUTHOR'S OWN IDENTITY, not where their items happen
  // to be stored. An external author is "followed" iff the viewer subscribes to
  // a source whose source_uri is this author's stable handle (the DID / actor
  // URI / pubkey — the exact value the subscribe API expects as sourceUri).
  const followUri = authorFollowUri(xa);
  let followTarget: AuthorCardResponse["followTarget"];
  if (followUri) {
    // `id` is the unfollow handle — the viewer's subscription-row id, since
    // DELETE /feeds/:id keys on external_subscriptions.id. Emit it when
    // subscribed so "FOLLOWING" → unsubscribe deletes the right row; when not
    // subscribed there's no row, so fall back to followUri — only the subscribe
    // path runs then, and it keys off protocol + sourceUri.
    const { rows: subRows } = await pool.query<{ id: string }>(
      `SELECT sub.id
         FROM external_subscriptions sub
         JOIN external_sources es ON es.id = sub.source_id
        WHERE sub.subscriber_id = $1
          AND es.protocol = $2::external_protocol
          AND es.source_uri = $3
        LIMIT 1`,
      [viewerId, xa.protocol, followUri],
    );
    const subId = subRows[0]?.id ?? null;
    followTarget = {
      type: "source",
      id: subId ?? followUri,
      isFollowing: subId !== null,
      protocol: xa.protocol,
      sourceUri: followUri,
    };
  }

  // Stored fields are the always-present base; live origin data overlays them.
  // profilePath is the internal constructed-profile route (the display-name link);
  // externalUrl is the origin-platform profile page (the @handle link).
  const base: AuthorCardResponse = {
    tier: xa.tier,
    displayName: xa.display_name ?? undefined,
    handle: xa.handle ?? undefined,
    avatarUrl: xa.avatar ?? undefined,
    sourceProtocol: xa.protocol,
    profilePath: `/author/${xa.id}`,
    externalUrl: buildExternalProfileUrl(xa.protocol, {
      handle: xa.handle,
      handleUri: xa.handle_uri,
      stableHandle: xa.stable_handle,
    }),
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
        // Live handle yields the prettier bsky.app/profile/<handle> URL.
        externalUrl: buildExternalProfileUrl("atproto", {
          handle: profile.handle,
          handleUri: xa.handle_uri,
          stableHandle: xa.stable_handle,
        }),
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
  //
  // ?kind=article|note narrows the native log to one item_type (the native
  // profile's Work / Social tabs consume it that way). Ignored for external
  // authors (no article/note distinction on the firehose).
  app.get<{
    Params: { authorId: string };
    Querystring: { cursor?: string; limit?: string; kind?: string };
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
      const kind =
        req.query.kind === "article" || req.query.kind === "note"
          ? req.query.kind
          : null;

      try {
        // id-space probe → the author filter. external_author_id aggregates the
        // author across every source; native filters by author_id.
        const xa = await loadExternalAuthor(authorId);
        let authorFilter: string;
        if (xa) {
          authorFilter = "fi.external_author_id = $1";
        } else if (await isNativeAccount(authorId)) {
          authorFilter = kind
            ? `fi.author_id = $1 AND fi.item_type = '${kind}'`
            : "fi.author_id = $1 AND fi.item_type IN ('article', 'note')";
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
        // Only hand out a cursor when the page was full — a short page is the
        // last page, so emitting one there would cost the client one extra
        // round-trip that returns nothing.
        const lastRow =
          result.rows.length === limit
            ? result.rows[result.rows.length - 1]
            : undefined;
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

  // GET /author/:authorId/replies — the native author's replies (kind-1111
  // comments) as full-view Post[] (§2.2 via commentToPost). Comments live in the
  // `comments` table, NOT feed_items, so they're outside /posts; this is their
  // chronological log. Each reply carries the deterministic derived post_id, so a
  // PostCard expands it into the unified thread (parent context above) exactly as
  // the workspace does. Native-only — external authors have no all.haus comments.
  app.get<{
    Params: { authorId: string };
    Querystring: { cursor?: string; limit?: string };
  }>(
    "/author/:authorId/replies",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const { authorId } = req.params;
      if (!UUID_RE.test(authorId)) {
        return reply.status(400).send({ error: "Invalid author id" });
      }
      if (!(await isNativeAccount(authorId))) {
        // External authors have no native comments; empty log (not a 404 — the
        // identity is valid, it just has no replies on all.haus).
        return reply.send({ items: [], nextCursor: undefined });
      }

      const cursor = parseCursor(req.query.cursor);
      const limit = Math.min(
        parseInt(req.query.limit ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT,
        MAX_LIMIT,
      );

      try {
        const cursorClause = cursor
          ? `AND (c.published_at, c.id) < (to_timestamp($3), $4::uuid)`
          : "";
        const params: any[] = cursor
          ? [authorId, limit, cursor.ts, cursor.id]
          : [authorId, limit];

        // root_post_id is the comment's root THING (derived from its
        // target_event_id) — commentToPost's rootPostId fallback for inReplyTo.
        const result = await pool.query<any>(
          `
          SELECT c.id,
                 feed_items_derive_post_id('nostr', c.nostr_event_id) AS derived_post_id,
                 c.nostr_event_id,
                 c.parent_comment_id,
                 feed_items_derive_post_id('nostr', p.nostr_event_id) AS parent_post_id,
                 feed_items_derive_post_id('nostr', c.target_event_id) AS root_post_id,
                 c.content,
                 EXTRACT(EPOCH FROM c.published_at)::bigint AS published_at_epoch,
                 c.deleted_at,
                 c.author_id,
                 acc.display_name AS acc_display_name,
                 acc.username AS acc_username,
                 acc.avatar_blossom_url AS acc_avatar,
                 acc.nostr_pubkey AS nostr_pubkey,
                 tl.pip_status AS pip_status,
                 vt.upvote_count AS vt_up, vt.downvote_count AS vt_down
            FROM comments c
            JOIN accounts acc ON acc.id = c.author_id
            LEFT JOIN trust_layer1 tl ON tl.user_id = c.author_id
            LEFT JOIN comments p ON p.id = c.parent_comment_id
            LEFT JOIN vote_tallies vt ON vt.target_nostr_event_id = c.nostr_event_id
           WHERE c.author_id = $1
             AND c.deleted_at IS NULL
             ${cursorClause}
           ORDER BY c.published_at DESC, c.id DESC
           LIMIT $2
          `,
          params,
        );

        const items = result.rows.map((c) =>
          commentToPost(c, c.root_post_id, new Set<string>()),
        );
        const lastRow =
          result.rows.length === limit
            ? result.rows[result.rows.length - 1]
            : undefined;
        const nextCursor = lastRow
          ? `${Number(lastRow.published_at_epoch)}:${lastRow.id}`
          : undefined;

        return reply.send({ items, nextCursor });
      } catch (err) {
        logger.error({ err, authorId }, "Author replies fetch failed");
        return reply.status(500).send({ error: "Author replies fetch failed" });
      }
    },
  );
}

import type { FastifyInstance } from "fastify";
import { pool } from "@platform-pub/shared/db/client.js";
import { requireAuth } from "../middleware/auth.js";
import {
  type AuthorCardResponse,
  computeTier,
  resolveNativeAuthor,
  fetchBlueskyProfile,
  fetchAPProfile,
} from "../lib/author-resolve.js";

const CACHE_TTL_MS = 5 * 60_000;
const authorCardCache = new Map<
  string,
  { data: AuthorCardResponse; expiresAt: number }
>();

export async function authorCardRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { type: string; id: string };
  }>(
    "/author-card",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const { type, id } = req.query;
      const viewerId = req.session!.sub;

      if (!type || !id) {
        return reply
          .status(400)
          .send({ error: "type and id are required query parameters" });
      }

      if (type !== "native" && type !== "external") {
        return reply
          .status(400)
          .send({ error: 'type must be "native" or "external"' });
      }

      const cacheKey = `${type}:${id}:${viewerId}`;
      const cached = authorCardCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return reply.send(cached.data);
      }

      let data: AuthorCardResponse;

      if (type === "native") {
        data = await resolveNativeAuthor(id, viewerId);
      } else {
        data = await resolveExternalAuthor(id, viewerId);
      }

      authorCardCache.set(cacheKey, {
        data,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });

      return reply.send(data);
    },
  );
}

// Item-keyed external resolution (the legacy hover card). The Phase-4
// constructed profile (routes/author.ts) keys on external_authors.id instead;
// both reuse the live-origin fetchers in lib/author-resolve.ts.
async function resolveExternalAuthor(
  externalItemId: string,
  viewerId: string,
): Promise<AuthorCardResponse> {
  const { rows } = await pool.query<{
    id: string;
    source_id: string;
    protocol: string;
    author_name: string | null;
    author_handle: string | null;
    author_avatar_url: string | null;
    author_uri: string | null;
    source_item_uri: string;
  }>(
    `SELECT id, source_id, protocol, author_name, author_handle,
            author_avatar_url, author_uri, source_item_uri
     FROM external_items WHERE id = $1 AND deleted_at IS NULL`,
    [externalItemId],
  );

  if (rows.length === 0) {
    return { tier: "D", partial: true };
  }

  const item = rows[0];
  const tier = computeTier(item.protocol, item.author_uri);

  const { rows: sourceRows } = await pool.query<{
    id: string;
    name: string | null;
    description: string | null;
    url: string | null;
    protocol: string;
    source_uri: string;
  }>(
    `SELECT id, name, description, url, protocol, source_uri FROM external_sources WHERE id = $1`,
    [item.source_id],
  );
  const source = sourceRows[0] ?? null;

  const { rows: subRows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(
      SELECT 1 FROM external_subscriptions
      WHERE subscriber_id = $1 AND source_id = $2
    ) AS exists`,
    [viewerId, item.source_id],
  );
  const isFollowing = subRows[0]?.exists ?? false;

  const followTarget = source
    ? {
        type: "source" as const,
        id: item.source_id,
        isFollowing,
        protocol: source.protocol,
        sourceUri: source.source_uri,
      }
    : undefined;

  if (tier === "A" && item.protocol === "atproto" && item.author_uri) {
    const profile = await fetchBlueskyProfile(item.author_uri);
    if (profile) {
      return {
        tier: "A",
        displayName: profile.displayName ?? profile.handle,
        handle: profile.handle,
        avatarUrl: profile.avatar,
        bio: profile.description,
        followerCount: profile.followersCount,
        followingCount: profile.followsCount,
        postCount: profile.postsCount,
        sourceProtocol: "atproto",
        followTarget,
      };
    }
  }

  if (tier === "A" && item.protocol === "nostr_external") {
    return {
      tier: "A",
      displayName: item.author_name ?? undefined,
      handle: item.author_handle ?? undefined,
      avatarUrl: item.author_avatar_url ?? undefined,
      sourceProtocol: "nostr_external",
      followTarget,
    };
  }

  if (
    (tier === "A" || tier === "B") &&
    item.protocol === "activitypub" &&
    item.author_uri
  ) {
    const profile = await fetchAPProfile(item.author_uri, item.source_item_uri);
    if (profile) {
      return {
        tier,
        displayName: profile.displayName ?? undefined,
        handle: profile.handle ?? undefined,
        avatarUrl: profile.avatar ?? undefined,
        bio: profile.description ?? undefined,
        followerCount: profile.followersCount,
        followingCount: profile.followingCount,
        postCount: profile.postsCount,
        sourceProtocol: "activitypub",
        followTarget,
        partial: profile.partial,
      };
    }
    return {
      tier,
      displayName: item.author_name ?? undefined,
      handle: item.author_handle ?? undefined,
      avatarUrl: item.author_avatar_url ?? undefined,
      sourceProtocol: "activitypub",
      followTarget,
      partial: true,
    };
  }

  if (tier === "C") {
    return {
      tier: "C",
      sourceName: source?.name ?? item.author_name ?? undefined,
      sourceDescription: source?.description ?? undefined,
      sourceUrl: source?.url ?? undefined,
      sourceProtocol: item.protocol,
      followTarget,
    };
  }

  return {
    tier: "D",
    displayName: item.author_name ?? undefined,
    sourceName: source?.name ?? undefined,
    sourceProtocol: item.protocol,
    followTarget,
  };
}

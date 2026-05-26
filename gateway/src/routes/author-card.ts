import type { FastifyInstance } from "fastify";
import { pool } from "@platform-pub/shared/db/client.js";
import { requireAuth } from "../middleware/auth.js";
import { getProfile } from "../lib/atproto-resolve.js";
import { fetchActorProfile } from "../lib/activitypub-resolve.js";
import logger from "@platform-pub/shared/lib/logger.js";

const CACHE_TTL_MS = 5 * 60_000;
const authorCardCache = new Map<
  string,
  { data: AuthorCardResponse; expiresAt: number }
>();

interface AuthorCardResponse {
  tier: "A" | "B" | "C" | "D";
  displayName?: string;
  handle?: string;
  avatarUrl?: string;
  bio?: string;
  followerCount?: number;
  followingCount?: number;
  postCount?: number;
  sourceName?: string;
  sourceDescription?: string;
  sourceUrl?: string;
  sourceProtocol?: string;
  partial?: boolean;
  followTarget?: {
    type: "user" | "source";
    id: string;
    isFollowing: boolean;
  };
}

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

async function resolveNativeAuthor(
  userId: string,
  viewerId: string,
): Promise<AuthorCardResponse> {
  const { rows } = await pool.query<{
    id: string;
    username: string;
    display_name: string | null;
    bio: string | null;
    avatar_blossom_url: string | null;
  }>(
    `SELECT id, username, display_name, bio, avatar_blossom_url
     FROM accounts WHERE id = $1 AND status = 'active'`,
    [userId],
  );

  if (rows.length === 0) {
    return { tier: "A", partial: true };
  }

  const account = rows[0];

  const [followerResult, followingResult, articleResult, isFollowingResult] =
    await Promise.all([
      pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM follows WHERE followee_id = $1`,
        [userId],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM follows WHERE follower_id = $1`,
        [userId],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM articles
       WHERE writer_id = $1 AND published_at IS NOT NULL AND deleted_at IS NULL`,
        [userId],
      ),
      pool.query<{ exists: boolean }>(
        `SELECT EXISTS(
        SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2
      ) AS exists`,
        [viewerId, userId],
      ),
    ]);

  return {
    tier: "A",
    displayName: account.display_name ?? account.username,
    handle: account.username,
    avatarUrl: account.avatar_blossom_url ?? undefined,
    bio: account.bio ?? undefined,
    followerCount: parseInt(followerResult.rows[0].count, 10),
    followingCount: parseInt(followingResult.rows[0].count, 10),
    postCount: parseInt(articleResult.rows[0].count, 10),
    followTarget: {
      type: "user",
      id: userId,
      isFollowing: isFollowingResult.rows[0].exists,
    },
  };
}

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
  }>(`SELECT id, name, description, url FROM external_sources WHERE id = $1`, [
    item.source_id,
  ]);
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
    ? { type: "source" as const, id: item.source_id, isFollowing }
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

function computeTier(
  protocol: string,
  authorUri: string | null,
): "A" | "B" | "C" | "D" {
  switch (protocol) {
    case "nostr_external":
    case "atproto":
      return "A";
    case "activitypub":
      return "B";
    case "rss":
    case "email":
      return authorUri ? "C" : "D";
    default:
      return "D";
  }
}

async function fetchBlueskyProfile(authorUri: string) {
  try {
    const didMatch = authorUri.match(
      /(?:did:(?:plc|web):[A-Za-z0-9._:-]+)|(?:\/profile\/(did:[^/]+))/,
    );
    const handleMatch = authorUri.match(/\/profile\/([^/]+)/);
    const actor = didMatch?.[1] ?? didMatch?.[0] ?? handleMatch?.[1];
    if (!actor) return null;

    return await getProfile(actor);
  } catch (err) {
    logger.debug({ err, authorUri }, "Bluesky profile fetch failed");
    return null;
  }
}

async function fetchAPProfile(
  authorUri: string,
  sourceItemUri: string,
): Promise<{
  displayName: string | null;
  handle: string | null;
  avatar: string | null;
  description: string | null;
  followersCount?: number;
  followingCount?: number;
  postsCount?: number;
  partial?: boolean;
} | null> {
  const actorProfile = await fetchActorProfile(authorUri);
  if (actorProfile) {
    if (
      actorProfile.followersCount != null ||
      actorProfile.followingCount != null
    ) {
      return actorProfile;
    }
    const restCounts = await fetchMastodonAccountCounts(
      authorUri,
      sourceItemUri,
    );
    return { ...actorProfile, ...restCounts };
  }

  return null;
}

async function fetchMastodonAccountCounts(
  authorUri: string,
  sourceItemUri: string,
): Promise<{
  followersCount?: number;
  followingCount?: number;
  postsCount?: number;
}> {
  try {
    let host: string;
    try {
      host = new URL(sourceItemUri).hostname;
    } catch {
      host = new URL(authorUri).hostname;
    }

    const handle = authorUri.match(/\/@([^/]+)/)?.[1];
    if (!handle) return {};

    const { safeFetch } =
      await import("@platform-pub/shared/lib/http-client.js");
    const res = await safeFetch(
      `https://${host}/api/v1/accounts/lookup?acct=${encodeURIComponent(handle)}`,
      { headers: { Accept: "application/json" } },
    );

    if (!res.ok) return {};
    const data = JSON.parse(res.text) as {
      followers_count?: number;
      following_count?: number;
      statuses_count?: number;
    };

    return {
      followersCount:
        typeof data.followers_count === "number"
          ? data.followers_count
          : undefined,
      followingCount:
        typeof data.following_count === "number"
          ? data.following_count
          : undefined,
      postsCount:
        typeof data.statuses_count === "number"
          ? data.statuses_count
          : undefined,
    };
  } catch {
    return {};
  }
}

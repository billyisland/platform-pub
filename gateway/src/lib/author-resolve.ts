import { pool } from "@platform-pub/shared/db/client.js";
import { nip19 } from "nostr-tools";
import { getProfile } from "./atproto-resolve.js";
import { fetchActorProfile } from "./activitypub-resolve.js";
import logger from "@platform-pub/shared/lib/logger.js";

// =============================================================================
// Shared author resolution — UNIVERSAL-POST-ADR §4.4 / §9
//
// The live-origin profile fetchers + the native-author resolver, shared by:
//   • routes/author-card.ts (the legacy hover card, keyed on external_item_id)
//   • routes/author.ts       (Phase 4, keyed on the persistent external_authors.id
//                             — lets a profile aggregate one author across sources)
//
// One definition of "what an origin profile looks like", so the two hover paths
// never drift. No logic change from the original author-card.ts privates.
// =============================================================================

export interface AuthorCardResponse {
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
  // Internal all.haus profile route the display name links to (native → /:username,
  // external A/B → /author/:authorId). Absent ⇒ name renders as plain text.
  profilePath?: string;
  // The author's profile page on the ORIGIN platform (Bluesky / Fediverse / Nostr),
  // linked from the @handle. Absent ⇒ handle renders as plain text.
  externalUrl?: string;
  partial?: boolean;
  followTarget?: {
    type: "user" | "source";
    id: string;
    isFollowing: boolean;
    protocol?: string;
    sourceUri?: string;
  };
}

export function computeTier(
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

function extractDid(s: string | null | undefined): string | null {
  if (!s) return null;
  return s.match(/did:(?:plc|web):[a-zA-Z0-9.:_-]+/)?.[0] ?? null;
}

// The author's profile page on the ORIGIN platform, for the @handle link.
// Returns undefined when no browser-resolvable URL can be derived (the handle
// then renders as plain text — the correct, safe default).
export function buildExternalProfileUrl(
  protocol: string,
  opts: {
    handle?: string | null;
    handleUri?: string | null;
    stableHandle?: string | null;
  },
): string | undefined {
  const { handle, handleUri, stableHandle } = opts;
  switch (protocol) {
    case "atproto": {
      // bsky.app/profile/<actor> resolves a human handle or a bare DID; prefer
      // the prettier handle, fall back to the DID embedded in the stored URI.
      const actor =
        handle?.replace(/^@/, "") ||
        extractDid(handleUri ?? stableHandle) ||
        stableHandle ||
        undefined;
      return actor ? `https://bsky.app/profile/${actor}` : undefined;
    }
    case "activitypub": {
      // The stored actor URI is itself a browser-resolvable profile page
      // (Mastodon and friends redirect /users/x → the public profile).
      const uri = handleUri ?? stableHandle ?? undefined;
      return uri && /^https:\/\//.test(uri) ? uri : undefined;
    }
    case "nostr_external": {
      // njump.me renders any nostr profile; encode the stored hex pubkey to npub.
      const hex = (stableHandle ?? "").match(/^[0-9a-f]{64}$/i)?.[0];
      if (!hex) return undefined;
      try {
        return `https://njump.me/${nip19.npubEncode(hex)}`;
      } catch {
        return undefined;
      }
    }
    default:
      return undefined;
  }
}

// Native all.haus author: account fields + live follow/article counts.
export async function resolveNativeAuthor(
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
    profilePath: `/${account.username}`,
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

// Bluesky (atproto) profile via the resolver. `actor` may be a DID, a handle,
// or a bsky.app /profile/<actor> URL — all accepted by getProfile.
export async function fetchBlueskyProfile(
  authorUri: string,
): Promise<Awaited<ReturnType<typeof getProfile>> | null> {
  try {
    const didMatch = authorUri.match(
      /(?:did:(?:plc|web):[A-Za-z0-9._:-]+)|(?:\/profile\/(did:[^/]+))/,
    );
    const handleMatch = authorUri.match(/\/profile\/([^/]+)/);
    const actor = didMatch?.[1] ?? didMatch?.[0] ?? handleMatch?.[1] ?? authorUri;
    if (!actor) return null;

    return await getProfile(actor);
  } catch (err) {
    logger.debug({ err, authorUri }, "Bluesky profile fetch failed");
    return null;
  }
}

// ActivityPub actor profile (+ Mastodon REST count fallback when the actor
// document omits follower/following counts).
export async function fetchAPProfile(
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

    const { safeFetch } = await import(
      "@platform-pub/shared/lib/http-client.js"
    );
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

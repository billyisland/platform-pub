import type { FastifyInstance } from "fastify";
import { pool } from "@platform-pub/shared/db/client.js";
import { requireAuth } from "../middleware/auth.js";
import logger from "@platform-pub/shared/lib/logger.js";
import {
  FEED_SELECT,
  FEED_JOINS,
  type CursorParts,
} from "./timeline.js";

// =============================================================================
// GET /feed/:feedId  — UNIVERSAL-POST-ADR Phase 1 (unified read endpoint)
//
// The Post-model feed. Coexists with the legacy GET /feed (timeline.ts), which
// stays live until Phase 5. This endpoint:
//   • gathers the SAME candidate THINGs as the legacy feed (content parity is a
//     Phase 1 Accept criterion — no items added or dropped), then
//   • scores them live with the §5 hotness number
//     (recencySeed + saturate(Σ trustWeight·timeDecay(boost age))), and
//   • dedups to ONE card per Post (grouped by the deterministic post_id), and
//   • attaches the repost-edge attribution set per Post.
//
// feedId ∈ { following, explore } — the legacy "reach" dial. There is no
// saved-feed concept yet; :feedId is the reach selector (ADR §9 GET /feed/:feedId).
//
// Score is computed at QUERY TIME, not materialised: the §5 decay is a function
// of now() and of repost_edges that change continuously, so a cron-materialised
// score would be stale. This supersedes the HN-gravity feed_scores_refresh score
// for THIS endpoint (the legacy feed still reads feed_items.score). Knobs live in
// platform_config (§9: half-life "tuned against live traffic, not guessed now").
//
// SCOPE NOTES (deliberate Phase 1 boundaries, not silent caps — CLAUDE.md):
//   • Boosts RE-FLOAT in-network candidates; they do NOT inject out-of-network
//     THINGs into the feed. Injection needs the follow↔external-identity bridge
//     and trust weighting (both deferred, §9/§11), and would break the Phase 1
//     candidate-parity Accept. A boosted-but-out-of-network THING surfaces once
//     that bridge lands.
//   • The legacy explore feed interleaves "new_user" cards; those are not Posts,
//     so this Post[] endpoint omits them. Re-add as a client-side presentation
//     layer if wanted.
// =============================================================================

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

type FeedId = "following" | "explore";
const VALID_FEED = new Set<FeedId>(["following", "explore"]);

// ── §5 score knobs (platform_config, with defaults) ──────────────────────────
interface ScoreConfig {
  recencyHalflifeHours: number; // recencySeed decay: how fast a direct post cools
  boostHalflifeHours: number; // boost timeDecay: "hot only while live"
  boostCeiling: number; // saturate() asymptote — max boost lift. > 1 so a saturated
  //                       boost pile CAN outrank a fresh direct post (§5 ceiling decision).
  boostHalfSat: number; // boost mass at which lift reaches half the ceiling (saturation point)
}

const SCORE_DEFAULTS: ScoreConfig = {
  recencyHalflifeHours: 12,
  boostHalflifeHours: 6,
  boostCeiling: 3,
  boostHalfSat: 3,
};

async function loadScoreConfig(): Promise<ScoreConfig> {
  const { rows } = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM platform_config WHERE key LIKE 'feed_recency_%' OR key LIKE 'feed_boost_%'`,
  );
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const num = (k: string, d: number) => {
    const v = parseFloat(map.get(k) ?? "");
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  return {
    recencyHalflifeHours: num(
      "feed_recency_halflife_hours",
      SCORE_DEFAULTS.recencyHalflifeHours,
    ),
    boostHalflifeHours: num(
      "feed_boost_halflife_hours",
      SCORE_DEFAULTS.boostHalflifeHours,
    ),
    boostCeiling: num("feed_boost_ceiling", SCORE_DEFAULTS.boostCeiling),
    boostHalfSat: num("feed_boost_half_sat", SCORE_DEFAULTS.boostHalfSat),
  };
}

// ── extra SELECT columns layered on top of timeline.ts's FEED_SELECT ──────────
// post_id/version/biddability_tier/external_author_id are the Phase 0a/0b columns;
// the derive_post_id() calls resolve a reply/quote parent to ITS deterministic
// post_id (the §2.3 derivation, same SQL function migration 098 uses) so the Post
// carries real inReplyTo/quotes edges resolvable by GET /thread.
//
// score_live is the §5 number. The boost CTE (b) supplies the decayed boost mass.
// NOTE: §5 writes "Σ saturate(...)" but the stated intent — "the tenth boost lifts
// far less than the second" — requires saturation over the ACCUMULATED mass, not
// per term (per-term sat is linear in the pile). So: mass = Σ trustWeight·decay,
// then lift = saturate(mass). Documented deviation from the loose notation.
const EXT_SELECT = `,
  fi.post_id AS post_id, fi.version AS version,
  fi.biddability_tier AS biddability_tier_persisted,
  fi.external_author_id AS external_author_id,
  acc.display_name AS acc_display_name, acc.username AS acc_username,
  acc.avatar_blossom_url AS acc_avatar,
  xa.account_id AS xa_account_id, xa.display_name AS xa_display_name,
  xa.handle AS xa_handle, xa.handle_uri AS xa_handle_uri, xa.avatar AS xa_avatar,
  vt.upvote_count AS vt_up, vt.downvote_count AS vt_down,
  COALESCE(b.boost_count, 0) AS boost_count,
  CASE
    WHEN n.reply_to_event_id IS NOT NULL THEN feed_items_derive_post_id('nostr', n.reply_to_event_id)
    WHEN ei.source_reply_uri IS NOT NULL THEN feed_items_derive_post_id(fi.source_protocol::text, ei.source_reply_uri)
  END AS in_reply_to_post_id,
  CASE
    WHEN n.quoted_event_id IS NOT NULL THEN feed_items_derive_post_id('nostr', n.quoted_event_id)
    WHEN ei.source_quote_uri IS NOT NULL THEN feed_items_derive_post_id(fi.source_protocol::text, ei.source_quote_uri)
  END AS quotes_post_id,
  (
    exp(-ln(2) * GREATEST(EXTRACT(EPOCH FROM (to_timestamp($7) - fi.published_at)), 0) / 3600.0 / $1)
    + COALESCE($3 * b.mass / (b.mass + $4), 0)
  ) AS score_live`;

const EXT_JOINS = `
  LEFT JOIN external_authors xa ON xa.id = fi.external_author_id
  LEFT JOIN vote_tallies vt ON vt.target_nostr_event_id = fi.nostr_event_id
  LEFT JOIN boost b ON b.target_post_id = fi.post_id`;

// boost mass CTE — decayed, trust-weighted boost mass + raw count per THING.
// $2 = boost half-life hours, $7 = pinned reference epoch (cursor-stable decay).
// Grouped by target_post_id so two sources boosting one THING resolve to one
// mass (the §5 cross-source dedup, edge side).
const BOOST_CTE = `
  boost AS (
    SELECT target_post_id,
      SUM(trust_weight * exp(-ln(2) * GREATEST(EXTRACT(EPOCH FROM (to_timestamp($7) - boosted_at)), 0) / 3600.0 / $2)) AS mass,
      COUNT(*) AS boost_count
    FROM repost_edges
    GROUP BY target_post_id
  )`;

// =============================================================================
// Post mapper (§2.2). Emits the unified Post shape Phase 2's PostCard consumes.
// Fields we don't yet have a cheap source for are nulled/zeroed with intent.
// =============================================================================
function feedItemToPost(row: any) {
  const isNative = row.item_type === "article" || row.item_type === "note";
  const isExternal = row.item_type === "external";

  // type discriminator: external long-form (has a title) → article, else note.
  // Provisional — drives the §3.1 reader-pane routing built in Phase R/2.
  const type: "article" | "note" = isExternal
    ? row.ei_title
      ? "article"
      : "note"
    : (row.item_type as "article" | "note");

  const accessMode: "free" | "gated" =
    row.item_type === "article" && row.access_mode === "paywalled"
      ? "gated"
      : "free";

  const author = isNative
    ? {
        id: row.author_id ?? null,
        accountId: row.author_id ?? null,
        displayName: row.acc_display_name ?? null,
        handle: row.acc_username ?? null,
        handleUri: null, // native profile is internal (/username); no origin link
        avatar: row.acc_avatar ?? null,
        pubkey: row.nostr_pubkey ?? null,
        pipStatus: row.pip_status ?? "unknown",
      }
    : {
        id: row.external_author_id ?? null, // null for tier C/D (plain-text byline)
        accountId: row.xa_account_id ?? null,
        displayName: row.xa_display_name ?? row.ei_author_name ?? null,
        handle: row.xa_handle ?? row.ei_author_handle ?? null,
        handleUri: row.xa_handle_uri ?? row.ei_author_uri ?? null,
        avatar: row.xa_avatar ?? row.ei_author_avatar_url ?? null,
        pubkey: null,
        pipStatus: "unknown" as const,
      };

  const origin = isNative
    ? {
        protocol: "nostr" as const,
        uri: row.nostr_event_id ?? "",
        sourceName: null,
      }
    : {
        protocol: row.source_protocol,
        uri: row.source_item_uri ?? "",
        sourceName: row.source_display_name ?? null,
      };

  const body = isNative
    ? row.item_type === "article"
      ? {
          text: row.content_free ?? null,
          html: null,
          title: row.title ?? null,
          summary: row.a_summary ?? null,
          media: row.media ?? [],
          contentWarning: null,
          poll: null,
        }
      : {
          text: row.note_content ?? null,
          html: null,
          title: null,
          summary: null,
          media: row.media ?? [],
          contentWarning: null,
          poll: null,
        }
    : {
        text: row.ei_content_text ?? null,
        html: row.ei_content_html ?? null,
        title: row.ei_title ?? null,
        summary: row.ei_summary ?? null,
        media: row.media ?? [],
        contentWarning: row.ei_content_warning ?? null,
        poll: row.ei_interaction_data?.poll ?? null,
      };

  return {
    id: row.post_id,
    version: row.version,
    origin,
    author,
    type,
    accessMode,
    body,
    inReplyTo: row.in_reply_to_post_id ?? null,
    quotes: row.quotes_post_id ?? null,
    // §6: native counts come from the canonical scoresheet (originCounts null);
    // external carry the origin platform's tallies.
    originCounts: isExternal
      ? {
          like: row.ei_like_count ?? 0,
          reply: row.ei_reply_count ?? 0,
          repost: row.ei_repost_count ?? 0,
        }
      : null,
    scoresheet: {
      up: row.vt_up ?? 0,
      down: row.vt_down ?? 0,
      reposts: Number(row.boost_count) || 0,
    },
    biddabilityTier: row.biddability_tier_persisted ?? "D",
    publishedAt: Number(row.published_at_epoch),
    score: row.score_live != null ? Number(row.score_live) : undefined,
    isContextOnly: false,
    isDeleted: false,
    isMuted: false,
    // legacy id retained transitionally for clients still keyed on feed_items.id
    feedItemId: row.fi_id,
  };
}

// =============================================================================
// Attribution: the §5 social-proof set per Post (most-recent booster first).
// Fetched only for the page's Posts, bounded to a sane per-Post slice.
// =============================================================================
const ATTRIBUTION_PER_POST = 25;

async function fetchAttribution(
  postIds: string[],
): Promise<Record<string, any[]>> {
  if (postIds.length === 0) return {};
  const { rows } = await pool.query<any>(
    `
    SELECT re.target_post_id, re.actor_handle, re.actor_external_author_id,
           re.trust_weight, re.origin_uri,
           EXTRACT(EPOCH FROM re.boosted_at)::bigint AS boosted_at_epoch,
           xa.display_name AS actor_display_name, xa.handle AS actor_handle_name,
           ROW_NUMBER() OVER (
             PARTITION BY re.target_post_id ORDER BY re.boosted_at DESC
           ) AS rn
    FROM repost_edges re
    LEFT JOIN external_authors xa ON xa.id = re.actor_external_author_id
    WHERE re.target_post_id = ANY($1)
    `,
    [postIds],
  );
  const out: Record<string, any[]> = {};
  for (const r of rows) {
    if (Number(r.rn) > ATTRIBUTION_PER_POST) continue;
    (out[r.target_post_id] ??= []).push({
      targetPostId: r.target_post_id,
      actorId: r.actor_external_author_id ?? null,
      actorHandle: r.actor_handle,
      actorDisplayName: r.actor_display_name ?? r.actor_handle_name ?? null,
      trustWeight: Number(r.trust_weight),
      timestamp: Number(r.boosted_at_epoch),
      originUri: r.origin_uri ?? null,
    });
  }
  return out;
}

// =============================================================================
// Cursor — score:ts:uuid:scoreNow
//
// The §5 hotness score is computed against a reference clock (timeDecay of
// now − boost/publish age). If that clock advanced between page requests, the
// boundary row's score would decay slightly BELOW the score snapshot embedded in
// the cursor, so it would satisfy the strict `<` keyset filter and reappear on
// the next page (observed: every page boundary duplicated its last row). So the
// reference clock is PINNED at first-page time and carried in the cursor's 4th
// field; all subsequent pages decay against that same `scoreNow`, making the
// keyset stable. The first page (no cursor) pins `scoreNow = now()`.
//
// NOTE: this is post-feed's own cursor format — NOT timeline.ts's shared
// parseCursor (which has no scoreNow component and stays the legacy contract).
// =============================================================================
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PostFeedCursor extends CursorParts {
  score: number;
  scoreNow: number; // pinned reference epoch (seconds) for decay across pages
}

function parsePostFeedCursor(raw: string | undefined): PostFeedCursor | undefined {
  if (!raw) return undefined;
  const parts = raw.split(":");
  if (parts.length !== 4) return undefined;
  const score = Number(parts[0]);
  const ts = parseInt(parts[1], 10);
  const id = parts[2];
  const scoreNow = parseInt(parts[3], 10);
  if (
    Number.isFinite(score) &&
    Number.isFinite(ts) &&
    Number.isFinite(scoreNow) &&
    UUID_RE.test(id)
  ) {
    return { score, ts, id, scoreNow };
  }
  return undefined;
}

// keyset clause over the deduped, live-scored result
function cursorClause(cursor: PostFeedCursor | undefined, base: number): string {
  return cursor
    ? `WHERE (d.score_live, d.published_at_epoch, d.fi_id) < ($${base}::numeric, $${base + 1}::bigint, $${base + 2}::uuid)`
    : "";
}

function buildNextCursor(rows: any[], scoreNow: number): string | undefined {
  const last = rows[rows.length - 1];
  return last
    ? `${Number(last.score_live)}:${Number(last.published_at_epoch)}:${last.fi_id}:${scoreNow}`
    : undefined;
}

// =============================================================================
// following — same membership as legacy followingFeed, re-scored + deduped.
// =============================================================================
async function followingPostFeed(
  cfg: ScoreConfig,
  readerId: string,
  cursor: PostFeedCursor | undefined,
  limit: number,
  scoreNow: number,
) {
  // params: $1 rhl $2 bhl $3 ceil $4 halfSat $5 readerId $6 limit $7 scoreNow
  //         [$8.. cursor]
  const params: any[] = [
    cfg.recencyHalflifeHours,
    cfg.boostHalflifeHours,
    cfg.boostCeiling,
    cfg.boostHalfSat,
    readerId,
    limit,
    scoreNow,
  ];
  if (cursor) params.push(cursor.score, cursor.ts, cursor.id);

  const sql = `
    WITH ${BOOST_CTE},
    capped_external AS (
      SELECT fi_inner.id AS feed_item_id,
             ROW_NUMBER() OVER (
               PARTITION BY fi_inner.source_id
               ORDER BY fi_inner.published_at DESC
             ) AS rn,
             COALESCE(es.daily_cap, 100) AS cap
      FROM feed_items fi_inner
      JOIN external_subscriptions es
        ON es.source_id = fi_inner.source_id
       AND es.subscriber_id = $5
       AND es.is_muted = FALSE
      WHERE fi_inner.item_type = 'external'
        AND fi_inner.deleted_at IS NULL
        AND fi_inner.published_at > now() - INTERVAL '30 days'
    ),
    scored AS (
      SELECT ${FEED_SELECT}${EXT_SELECT}
      FROM feed_items fi
      ${FEED_JOINS}
      ${EXT_JOINS}
      WHERE fi.deleted_at IS NULL
        AND (
          (fi.item_type IN ('article', 'note')
           AND (
             fi.author_id IN (SELECT followee_id FROM follows WHERE follower_id = $5)
             OR fi.author_id = $5
             OR fi.article_id IN (
               SELECT a2.id FROM articles a2
               JOIN publication_follows pf ON pf.publication_id = a2.publication_id
               WHERE pf.follower_id = $5
             )
           ))
          OR
          (fi.id IN (SELECT feed_item_id FROM capped_external WHERE rn <= cap))
        )
        AND NOT EXISTS (
          SELECT 1 FROM blocks WHERE blocker_id = $5 AND blocked_id = fi.author_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM mutes WHERE muter_id = $5 AND muted_id = fi.author_id
        )
        AND (fi.item_type != 'note' OR n.reply_to_event_id IS NULL)
        AND (fi.item_type != 'external' OR ei.is_context_only IS NOT TRUE)
    ),
    deduped AS (
      SELECT DISTINCT ON (post_id) *
      FROM scored
      ORDER BY post_id, score_live DESC, published_at_epoch DESC, fi_id DESC
    )
    SELECT * FROM deduped d
    ${cursorClause(cursor, 8)}
    ORDER BY d.score_live DESC, d.published_at_epoch DESC, d.fi_id DESC
    LIMIT $6
  `;
  const result = await pool.query<any>(sql, params);
  return result.rows;
}

// =============================================================================
// explore — same membership as legacy exploreFeed (native, 48h window, not self,
// not blocked/muted, top-level), re-scored + deduped. The 48h window is kept as a
// MEMBERSHIP filter for content parity; §5 retires it only as a SCORING regime.
// =============================================================================
async function explorePostFeed(
  cfg: ScoreConfig,
  readerId: string,
  cursor: PostFeedCursor | undefined,
  limit: number,
  scoreNow: number,
) {
  const params: any[] = [
    cfg.recencyHalflifeHours,
    cfg.boostHalflifeHours,
    cfg.boostCeiling,
    cfg.boostHalfSat,
    readerId,
    limit,
    scoreNow,
  ];
  if (cursor) params.push(cursor.score, cursor.ts, cursor.id);

  const sql = `
    WITH ${BOOST_CTE},
    scored AS (
      SELECT ${FEED_SELECT}${EXT_SELECT}
      FROM feed_items fi
      ${FEED_JOINS}
      ${EXT_JOINS}
      WHERE fi.deleted_at IS NULL
        AND fi.published_at > now() - INTERVAL '48 hours'
        AND fi.item_type IN ('article', 'note')
        AND fi.author_id != $5
        AND NOT EXISTS (
          SELECT 1 FROM blocks WHERE blocker_id = $5 AND blocked_id = fi.author_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM mutes WHERE muter_id = $5 AND muted_id = fi.author_id
        )
        AND (fi.item_type != 'note' OR n.reply_to_event_id IS NULL)
    ),
    deduped AS (
      SELECT DISTINCT ON (post_id) *
      FROM scored
      ORDER BY post_id, score_live DESC, published_at_epoch DESC, fi_id DESC
    )
    SELECT * FROM deduped d
    ${cursorClause(cursor, 8)}
    ORDER BY d.score_live DESC, d.published_at_epoch DESC, d.fi_id DESC
    LIMIT $6
  `;
  const result = await pool.query<any>(sql, params);
  return result.rows;
}

export async function postFeedRoutes(app: FastifyInstance) {
  app.get<{
    Params: { feedId: string };
    Querystring: { cursor?: string; limit?: string };
  }>("/feed/:feedId", { preHandler: requireAuth }, async (req, reply) => {
    const readerId = req.session!.sub;
    const feedId = req.params.feedId as FeedId;
    const cursor = parsePostFeedCursor(req.query.cursor);
    // Pin the §5 decay clock: reuse the cursor's reference epoch on later pages,
    // otherwise stamp now() for the first page. Keeps the keyset score-stable.
    const scoreNow = cursor?.scoreNow ?? Math.floor(Date.now() / 1000);
    const limit = Math.min(
      parseInt(req.query.limit ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT,
      MAX_LIMIT,
    );

    if (!VALID_FEED.has(feedId)) {
      return reply.status(400).send({
        error: `Invalid feedId: ${feedId}. Must be one of: ${[...VALID_FEED].join(", ")}`,
      });
    }

    try {
      const cfg = await loadScoreConfig();
      const rows =
        feedId === "following"
          ? await followingPostFeed(cfg, readerId, cursor, limit, scoreNow)
          : await explorePostFeed(cfg, readerId, cursor, limit, scoreNow);

      const items = rows.map(feedItemToPost);
      const attribution = await fetchAttribution(items.map((p) => p.id));
      const nextCursor = buildNextCursor(rows, scoreNow);

      return reply.send({ items, attribution, nextCursor });
    } catch (err) {
      logger.error({ err, feedId }, "Post feed fetch failed");
      return reply.status(500).send({ error: "Feed fetch failed" });
    }
  });
}

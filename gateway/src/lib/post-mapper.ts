// =============================================================================
// Shared Post model — UNIVERSAL-POST-ADR §2.2
//
// The single Post shape every unified read endpoint emits (the /feed slice in
// routes/post-feed.ts, the /thread slice in routes/post-thread.ts, and Phase 2's
// PostCard consumer). Extracted here so both endpoints share one mapper and one
// type — no duplicated §2.2 projection.
//
// `feedItemToPost` maps a feed_items-sourced row (article / note / external THING).
// Comment-sourced nodes (native replies, which live in the `comments` table, not
// feed_items) are projected separately in post-thread.ts::commentToPost, but emit
// this same Post type.
//
// POST_SELECT / POST_JOINS are the Post-bearing columns + joins layered on top of
// timeline.ts's FEED_SELECT / FEED_JOINS. They carry NO feed-only scoring machinery
// (the §5 score_live expression + the repost_edges boost join stay in post-feed.ts);
// the mapper tolerates their absence (boost_count defaults to 0).
// =============================================================================

export interface PostAuthor {
  id: string | null; // identity record (native author_id / external_author_id). NULL = tier C/D plain-text byline
  accountId: string | null; // lazy link to a real all.haus account
  displayName: string | null;
  handle: string | null;
  handleUri: string | null; // link to profile on origin (external)
  avatar: string | null;
  pubkey: string | null; // native only
  pipStatus: "known" | "partial" | "unknown" | "contested";
}

export interface PostOrigin {
  protocol: "nostr" | "atproto" | "activitypub" | "rss" | "email" | string;
  uri: string;
  sourceName: string | null;
}

export interface PostBody {
  text: string | null;
  html: string | null;
  title: string | null;
  summary: string | null;
  media: unknown[];
  contentWarning: string | null;
  poll: unknown | null;
}

export interface Post {
  id: string; // deterministic post_id (§2.3)
  version: string | null; // edit detector (§2.4)
  origin: PostOrigin;
  author: PostAuthor;
  type: "article" | "note";
  accessMode: "free" | "gated";
  body: PostBody;
  inReplyTo: string | null; // parent post_id
  quotes: string | null; // quoted post_id (depth-1)
  // Inline preview of a native note's quoted post (title/excerpt/author), carried
  // from the notes.quoted_* columns so the thread renders the rich quote card
  // rather than a bare "Quoted a post →" stub. External quotes hydrate async via
  // the host item id, so they leave this undefined.
  quotedPreview?: { title?: string; excerpt?: string; author?: string };
  originCounts: { like: number; reply: number; repost: number } | null; // external only; null native (§6)
  scoresheet: { up: number; down: number; reposts: number };
  biddabilityTier: "A" | "B" | "C" | "D";
  publishedAt: number;
  score?: number; // §5 hotness (feed only); undefined in thread
  isContextOnly: boolean;
  isDeleted: boolean;
  isMuted: boolean;
  feedItemId: string | null; // legacy id, transitional
  externalItemId: string | null; // external_items uuid — the origin interact-back key (like/repost/reply); null native
}

export interface RepostEdgeDTO {
  targetPostId: string;
  actorId: string | null;
  actorHandle: string | null;
  actorDisplayName: string | null;
  trustWeight: number;
  timestamp: number;
  originUri: string | null;
}

// ── Post-bearing columns layered on top of timeline.ts's FEED_SELECT ─────────
// post_id/version/biddability_tier/external_author_id are the Phase 0a/0b columns.
// The derive_post_id() calls resolve a reply/quote parent to ITS deterministic
// post_id (§2.3, the same SQL function migration 098 uses) so each Post carries
// real inReplyTo/quotes edges that GET /thread can resolve.
//
// Article-target resolution (UNIVERSAL-POST P1-2 fix): a native article's post_id is
// minted from its naddr COORDINATE '30023:<pubkey>:<dtag>' (migration 098), but a
// kind-1 reply/quote stores the article's raw EVENT id in reply_to_event_id /
// quoted_event_id. Deriving straight from the event id would mint a post_id that
// matches no THING → dangling edge → orphaned thread node. So when the stored event
// id is in fact an article's event id, resolve it to that article's coordinate before
// deriving; otherwise (a note target) fall through to the event id, which is correct.
// Read-side only — repairs existing rows with no migration / re-ingest.
export const nostrTargetPostId = (col: string) => `feed_items_derive_post_id('nostr', COALESCE(
    (SELECT '30023:' || ac2.nostr_pubkey || ':' || art2.nostr_d_tag
       FROM articles art2 JOIN accounts ac2 ON ac2.id = art2.writer_id
      WHERE art2.nostr_event_id = ${col}
        AND ac2.nostr_pubkey IS NOT NULL AND art2.nostr_d_tag IS NOT NULL),
    ${col}))`;

// Leading comma: appended directly after FEED_SELECT in `SELECT ${FEED_SELECT}${POST_SELECT}`.
export const POST_SELECT = `,
  fi.post_id AS post_id, fi.version AS version,
  fi.biddability_tier AS biddability_tier_persisted,
  fi.external_author_id AS external_author_id,
  acc.display_name AS acc_display_name, acc.username AS acc_username,
  acc.avatar_blossom_url AS acc_avatar,
  xa.account_id AS xa_account_id, xa.display_name AS xa_display_name,
  xa.handle AS xa_handle, xa.handle_uri AS xa_handle_uri, xa.avatar AS xa_avatar,
  vt.upvote_count AS vt_up, vt.downvote_count AS vt_down,
  CASE
    WHEN n.reply_to_event_id IS NOT NULL THEN ${nostrTargetPostId("n.reply_to_event_id")}
    WHEN ei.source_reply_uri IS NOT NULL THEN feed_items_derive_post_id(fi.source_protocol::text, ei.source_reply_uri)
  END AS in_reply_to_post_id,
  CASE
    WHEN n.quoted_event_id IS NOT NULL THEN ${nostrTargetPostId("n.quoted_event_id")}
    WHEN ei.source_quote_uri IS NOT NULL THEN feed_items_derive_post_id(fi.source_protocol::text, ei.source_quote_uri)
  END AS quotes_post_id`;

// Joins that back POST_SELECT (external author identity + native vote tallies).
// The feed-only repost_edges boost join is NOT here — it lives in post-feed.ts.
export const POST_JOINS = `
  LEFT JOIN external_authors xa ON xa.id = fi.external_author_id
  LEFT JOIN vote_tallies vt ON vt.target_nostr_event_id = fi.nostr_event_id`;

// =============================================================================
// Post mapper (§2.2). Emits the unified Post shape Phase 2's PostCard consumes.
// Fields without a cheap source yet are nulled/zeroed with intent.
// =============================================================================
export function feedItemToPost(row: any): Post {
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

  const author: PostAuthor = isNative
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
        pipStatus: "unknown",
      };

  const origin: PostOrigin = isNative
    ? {
        protocol: "nostr",
        uri: row.nostr_event_id ?? "",
        sourceName: null,
      }
    : {
        protocol: row.source_protocol,
        uri: row.source_item_uri ?? "",
        sourceName: row.source_display_name ?? null,
      };

  const body: PostBody = isNative
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
    version: row.version ?? null,
    origin,
    author,
    type,
    accessMode,
    body,
    inReplyTo: row.in_reply_to_post_id ?? null,
    quotes: row.quotes_post_id ?? null,
    // Native note quote preview from the notes.quoted_* columns (FEED_SELECT
    // already carries them). Mirrors the workspace adapter's mapNote so the same
    // quoted note reads identically in the feed and in an expanded thread.
    quotedPreview:
      !isExternal && row.quoted_event_id
        ? {
            title: row.quoted_title ?? undefined,
            excerpt: row.quoted_excerpt ?? undefined,
            author: row.quoted_author ?? undefined,
          }
        : undefined,
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
    feedItemId: row.fi_id ?? null,
    // external interact-back key: like/repost/reply dispatch to the origin via the
    // external_items row (FEED_SELECT carries fi.external_item_id). Null for native —
    // native engagement is the all.haus scoresheet, not an origin interact-back.
    externalItemId: isExternal ? (row.external_item_id ?? null) : null,
  };
}

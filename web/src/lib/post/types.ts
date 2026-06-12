// =============================================================================
// Client Post model — UNIVERSAL-POST-ADR §2.2
//
// The browser mirror of the gateway Post shape (gateway/src/lib/post-mapper.ts).
// Kept structurally identical so the same PostCard renders every feed payload with
// no re-mapping. All feed surfaces — sources, author, tags, thread, AND the
// workspace items endpoint (GET /workspace/feeds/:id/items) — now serve gateway
// Post[] directly; the client-side legacy-item adapter (map-feed-item.ts) was
// retired in FEED-RETIREMENT-PLAN Slice 6 item 4.
//
// A few fields are still marked "client transitional" (render-only ergonomics);
// the gateway now sources dTag/pricePence/externalSourceId too.
// =============================================================================

// The six render levels (§3 / §4 matrix). The level governs size/indent/gap/
// affordance-set — never which fields exist; every Post always carries everything.
export type Level =
  | "focal"
  | "feed"
  | "thread-parent"
  | "thread-reply"
  | "quoted"
  | "condensed";

export type BiddabilityTier = "A" | "B" | "C" | "D";

export type PipStatus = "known" | "partial" | "unknown" | "contested";

// Media shape as served by feed_items.media (matches the ndk MediaItem the
// workspace MediaBlock already consumes without translation).
export interface MediaItem {
  type: "image" | "video" | "audio" | "link";
  url: string;
  thumbnail?: string;
  alt?: string;
  width?: number;
  height?: number;
  title?: string;
  description?: string;
  duration_in_seconds?: number;
  size_in_bytes?: number;
}

// Poll shape as carried by external items (PollDisplay-compatible).
export interface Poll {
  options: Array<{ title: string; votesCount: number }>;
  multiple: boolean;
  expiresAt: string | null;
  closed: boolean;
}

export interface PostOrigin {
  // "nostr" for native all.haus content; the source protocol otherwise.
  protocol: "nostr" | "atproto" | "activitypub" | "rss" | "email" | string;
  uri: string; // permalink / at:// / status id / event id — the stable handle
  sourceName: string | null; // origin-site name shown in the tag
}

export interface PostAuthor {
  // Identity record id (native author_id / external_author_id). NULL for tier
  // C/D — no stable handle ⇒ no profile ⇒ plain-text byline.
  id: string | null;
  accountId: string | null; // lazy link to a real all.haus account
  displayName: string | null; // native: NULL here, resolved at render via useWriterName(pubkey)
  handle: string | null;
  handleUri: string | null; // link to profile on origin (external)
  avatar: string | null;
  pubkey: string | null; // native only — the useWriterName key + vote target
  pipStatus: PipStatus;
}

export interface PostBody {
  text: string | null;
  html: string | null;
  title: string | null; // articles
  summary: string | null;
  media: MediaItem[];
  contentWarning: string | null;
  poll: Poll | null;
}

export interface Post {
  id: string; // deterministic post_id (§2.3); client-side = origin handle until the unified endpoint lands
  version: string | null; // edit detector (§2.4); native = nostr event id (also the vote target)
  origin: PostOrigin;
  author: PostAuthor;
  type: "article" | "note";
  // Display discriminator only — gating economics stay in the gate-pass service (§3.1).
  accessMode: "free" | "gated" | "unlocked";
  body: PostBody;
  inReplyTo: string | null; // parent handle (origin id this phase; gateway resolves to post_id)
  quotes: string | null; // quoted handle (depth-1)
  originCounts: { like: number; reply: number; repost: number } | null; // external only; null native (§6)
  scoresheet: { up: number; down: number; reposts: number }; // all.haus reaction layer
  biddabilityTier: BiddabilityTier;
  publishedAt: number; // unix seconds
  score?: number; // §5 hotness (feed only); undefined in thread
  isContextOnly: boolean;
  isDeleted: boolean;
  isMuted: boolean;
  feedItemId: string | null; // client transitional: keys vote/quote/parent fetches
  // client transitional: the external_item id the interact-back endpoints key on
  // (externalItems.like/repost/reply/pollVote, engagement). Distinct from `id`
  // (the deterministic post_id) and `feedItemId`. NULL for native posts.
  externalItemId: string | null;
  // The all.haus external_sources id this card came from (external only; null
  // native). The workspace matches a card to its feed_source row for drag-to-move.
  externalSourceId?: string | null;
  pricePence?: number; // client transitional: gated-article CTA price
  // client transitional: native article d-tag — the reader-pane (§3.1 / Phase R)
  // opens native articles at /article/<dTag>. Null for notes + external.
  dTag?: string | null;
  // client transitional: native note quote preview (the gateway model resolves
  // `quotes` to a child Post via /thread; until that is wired, the workspace
  // payload carries an inline excerpt we render as the quoted-level mini).
  // `source` + `url` are set when the quoted post is external (migration 102):
  // the origin label (e.g. "BLUESKY") and the clickable public permalink.
  quotedPreview?: { title?: string; excerpt?: string; author?: string; source?: string; url?: string };
}

// Bare reposts are edges, not Posts (§2.2). Mirror of gateway RepostEdgeDTO.
export interface RepostEdge {
  targetPostId: string;
  actorId: string | null;
  actorHandle: string | null;
  actorDisplayName: string | null;
  trustWeight: number;
  timestamp: number;
  originUri: string | null;
}

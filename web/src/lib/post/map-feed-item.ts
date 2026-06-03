// =============================================================================
// mapFeedItemToPost — pure, sync adapter: legacy workspace FeedItem → Post
//
// UNIVERSAL-POST-ADR Phase 2 data path. The workspace feed still flows through
// /workspace/feeds/:id/items → mapApiItem (WorkspaceView) → FeedItem. This adapter
// maps that FeedItem into the §2.2 Post so PostCard can render it, WITHOUT wiring
// the new /feed/:feedId endpoint (a later phase). It is the only producer of the
// client Post until that endpoint lands.
//
// Invariants:
//  - PURE + SYNC: no hooks, no fetches. Native author display names are NOT in
//    the workspace payload — they resolve at render via useWriterName(pubkey),
//    exactly as Byline/VesselCard do today, so author.displayName stays null for
//    native here. (Calling a hook here would break purity.)
//  - Native vs external is discriminated by author.pubkey: non-null ⇒ native.
//  - biddabilityTier mirrors the gateway Phase 0b minting rule
//    (migrations/099_external_author_identity.sql).
// =============================================================================

import type { FeedItem, ArticleEvent, NoteEvent, ExternalFeedItem } from "../ndk";
import type { Post, BiddabilityTier, Poll } from "./types";

// External tier derivation — mirrors the server (§7 + migration 099):
//  atproto / nostr_external → A   (stable handle: DID / pubkey)
//  activitypub             → B   (actor URI)
//  rss / email             → C if author known, else D (no stable handle)
function deriveExternalTier(item: ExternalFeedItem): BiddabilityTier {
  // Prefer a server-persisted tier when present.
  if (item.biddabilityTier) return item.biddabilityTier;
  const proto = item.sourceProtocol;
  if (proto === "atproto" || proto === "nostr_external") return "A";
  if (proto === "activitypub") return "B";
  const authorKnown = !!(item.authorName || item.authorHandle || item.authorUri);
  return authorKnown ? "C" : "D";
}

function mapArticle(item: ArticleEvent): Post {
  return {
    // Post.id is the deterministic post_id when the gateway surfaces it
    // (Phase 3 bridge); the origin event id is the fallback for any legacy
    // payload that predates the column. The thread engine keys /thread on this.
    id: item.postId ?? item.id,
    version: item.id, // native: the nostr event id is both version and vote target
    origin: { protocol: "nostr", uri: item.id, sourceName: null },
    author: {
      id: item.authorId ?? null,
      accountId: null,
      displayName: null, // resolved at render via useWriterName(pubkey)
      handle: null,
      handleUri: null,
      avatar: null,
      pubkey: item.pubkey,
      pipStatus: item.pipStatus ?? "unknown",
    },
    type: "article",
    accessMode: item.isPaywalled ? "gated" : "free",
    body: {
      text: item.content ?? null,
      html: null,
      title: item.title,
      summary: item.summary,
      media: item.media ?? [],
      contentWarning: null,
      poll: null,
    },
    inReplyTo: null,
    quotes: null,
    originCounts: null, // native (§6 — scoresheet is canonical)
    scoresheet: { up: 0, down: 0, reposts: 0 },
    biddabilityTier: item.biddabilityTier ?? "A",
    publishedAt: item.publishedAt,
    isContextOnly: false,
    isDeleted: false,
    isMuted: false,
    feedItemId: item.feedItemId ?? null,
    externalItemId: null, // native
    pricePence: item.pricePence,
    // The reader pane opens native articles at /article/<dTag> (§3.1 / Phase R).
    dTag: item.dTag,
  };
}

function mapNote(item: NoteEvent): Post {
  return {
    id: item.postId ?? item.id, // post_id (Phase 3 bridge); see mapArticle
    version: item.id,
    origin: { protocol: "nostr", uri: item.id, sourceName: null },
    author: {
      id: item.authorId ?? null,
      accountId: null,
      displayName: null,
      handle: null,
      handleUri: null,
      avatar: null,
      pubkey: item.pubkey,
      pipStatus: item.pipStatus ?? "unknown",
    },
    type: "note",
    accessMode: "free",
    body: {
      // Note media lives inline in the text (image URLs); PostMedia/PostBody
      // extract + strip at render via extractNoteMedia/stripMediaUrls, matching
      // VesselCard. The adapter keeps the full text and an empty media array.
      text: item.content ?? null,
      html: null,
      title: null,
      summary: null,
      media: [],
      contentWarning: null,
      poll: null,
    },
    // Origin ids this phase (not yet resolved to post_ids); used only as hints.
    inReplyTo: item.replyToEventId ?? item.externalParentId ?? null,
    quotes: item.quotedEventId ?? item.quotedPostId ?? null,
    originCounts: null,
    scoresheet: { up: 0, down: 0, reposts: 0 },
    biddabilityTier: item.biddabilityTier ?? "A",
    publishedAt: item.publishedAt,
    isContextOnly: false,
    isDeleted: false,
    isMuted: false,
    feedItemId: item.feedItemId ?? null,
    externalItemId: null, // native
    quotedPreview:
      item.quotedEventId || item.quotedPostId
        ? {
            title: item.quotedTitle,
            excerpt: item.quotedExcerpt,
            author: item.quotedAuthor,
            // External quote (migration 102): origin label + clickable permalink.
            source: item.quotedSource,
            url: item.quotedUrl,
          }
        : undefined,
  };
}

function mapExternal(item: ExternalFeedItem): Post {
  const poll: Poll | null = item.poll ?? null;
  return {
    id: item.postId ?? item.id, // post_id (Phase 3 bridge); see mapArticle
    version: null, // external version (content hash) is server-side; unused at render
    origin: {
      protocol: item.sourceProtocol,
      uri: item.sourceItemUri,
      sourceName: item.sourceName,
    },
    author: {
      // tier-A/B external_authors id, now surfaced in the workspace payload (the
      // §4.4 byline id-bridge). Drives the /author/:id link + hover modal on the
      // collapsed feed card; null for tier C/D → plain-text byline, no hover.
      id: item.authorId ?? null,
      accountId: null,
      displayName: item.authorName,
      handle: item.authorHandle,
      handleUri: item.authorUri,
      avatar: item.authorAvatarUrl,
      pubkey: null,
      pipStatus: item.pipStatus ?? "unknown",
    },
    // An external item with a title is an article (routes to the reader pane);
    // otherwise a note (expands inline). Mirrors VesselCard's split.
    type: item.title ? "article" : "note",
    accessMode: "free",
    body: {
      text: item.contentText,
      html: item.contentHtml,
      title: item.title,
      summary: item.summary,
      media: item.media ?? [],
      contentWarning: item.contentWarning ?? null,
      poll,
    },
    inReplyTo: item.sourceReplyUri ?? null,
    quotes: item.sourceQuoteUri ?? null,
    originCounts: {
      like: item.likeCount ?? 0,
      reply: item.replyCount ?? 0,
      repost: item.repostCount ?? 0,
    },
    scoresheet: { up: 0, down: 0, reposts: 0 },
    biddabilityTier: deriveExternalTier(item),
    publishedAt: item.publishedAt,
    isContextOnly: false,
    isDeleted: false,
    isMuted: false,
    feedItemId: item.feedItemId ?? null,
    // The external_item id — the key for like/repost/reply/poll/engagement.
    // Distinct from `id` (post_id) once the gateway surfaces post_id.
    externalItemId: item.id,
  };
}

export function mapFeedItemToPost(item: FeedItem): Post {
  if (item.type === "external") return mapExternal(item);
  if (item.type === "note") return mapNote(item);
  // FeedItem's article arm is (ArticleEvent & { type: "article" }).
  return mapArticle(item);
}

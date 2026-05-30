import { request } from "./client";

// Workspace feeds — owner-private feed objects, one per ⊔ vessel. Slice 4
// adds source CRUD; the items endpoint now honours source rows.

export interface WorkspaceFeed {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  sourceCount: number;
}

type MediaItem = {
  type: "image" | "video" | "audio" | "link";
  url: string;
  thumbnail?: string;
  alt?: string;
  width?: number;
  height?: number;
  title?: string;
  description?: string;
};

type PipStatus = "known" | "partial" | "unknown" | "contested";
type SizeTier = "lead" | "standard" | "brief";

export interface WorkspaceFeedApiArticle {
  type: "article";
  feedItemId: string;
  authorId?: string;
  nostrEventId: string;
  pubkey: string;
  dTag: string;
  title: string;
  summary: string;
  contentFree: string;
  accessMode: string;
  isPaywalled: boolean;
  pricePence?: number;
  gatePositionPct?: number;
  publishedAt: number;
  score?: number;
  tags: string[];
  sizeTier: SizeTier;
  pipStatus: PipStatus;
  media?: MediaItem[];
  savedAt?: number;
}

export interface WorkspaceFeedApiNote {
  type: "note";
  feedItemId: string;
  authorId?: string;
  nostrEventId: string;
  pubkey: string;
  content: string;
  isQuoteComment?: boolean;
  quotedEventId?: string;
  quotedEventKind?: number;
  quotedExcerpt?: string;
  quotedTitle?: string;
  quotedAuthor?: string;
  publishedAt: number;
  score?: number;
  pipStatus: PipStatus;
  savedAt?: number;
  externalParentId?: string;
}

export interface WorkspaceFeedApiExternal {
  type: "external";
  feedItemId: string;
  externalSourceId?: string;
  id: string;
  sourceProtocol: string;
  sourceItemUri: string;
  authorName: string | null;
  authorHandle: string | null;
  authorAvatarUrl: string | null;
  authorUri: string | null;
  contentText: string | null;
  contentHtml: string | null;
  title: string | null;
  summary: string | null;
  sourceReplyUri?: string | null;
  sourceQuoteUri?: string | null;
  contentWarning?: string | null;
  poll?: {
    options: Array<{ title: string; votesCount: number }>;
    multiple: boolean;
    expiresAt: string | null;
    expired: boolean;
    votesCount: number;
    votersCount: number;
  } | null;
  likeCount: number;
  replyCount: number;
  repostCount: number;
  media: MediaItem[];
  publishedAt: number;
  sourceName: string | null;
  sourceAvatar: string | null;
  pipStatus: PipStatus;
  savedAt?: number;
}

export interface WorkspaceFeedApiNewUser {
  type: "new_user";
  username: string;
  displayName: string | null;
  avatar: string | null;
  joinedAt: number;
}

export interface WorkspaceFeedApiReplyGroup {
  type: "reply_group";
  sourceReplyUri: string;
  publishedAt: number;
  replies: WorkspaceFeedApiExternal[];
}

export type WorkspaceFeedApiItem =
  | WorkspaceFeedApiArticle
  | WorkspaceFeedApiNote
  | WorkspaceFeedApiExternal
  | WorkspaceFeedApiNewUser
  | WorkspaceFeedApiReplyGroup;

export interface WorkspaceFeedItemsResponse {
  feed: WorkspaceFeed;
  items: WorkspaceFeedApiItem[];
  nextCursor?: string;
  placeholder: boolean;
}

export type WorkspaceFeedSourceKind =
  | "account"
  | "publication"
  | "external_source"
  | "tag";

export interface WorkspaceFeedSource {
  id: string;
  sourceType: WorkspaceFeedSourceKind;
  accountId?: string;
  externalSourceId?: string;
  weight: number;
  samplingMode: "random" | "top";
  mutedAt: string | null;
  createdAt: string;
  display: {
    kind: WorkspaceFeedSourceKind;
    label: string;
    sublabel: string | null;
    avatar: string | null;
  };
}

export type AddWorkspaceFeedSourceInput =
  | { sourceType: "account"; accountId: string }
  | { sourceType: "publication"; publicationId: string }
  | { sourceType: "tag"; tagName: string }
  | { sourceType: "external_source"; externalSourceId: string }
  | {
      sourceType: "external_source";
      protocol: "rss" | "atproto" | "activitypub" | "nostr_external";
      sourceUri: string;
      displayName?: string;
      description?: string;
      avatarUrl?: string;
      relayUrls?: string[];
    };

export const workspaceFeeds = {
  list: () => request<{ feeds: WorkspaceFeed[] }>("/workspace/feeds"),

  create: (name: string) =>
    request<{ feed: WorkspaceFeed }>("/workspace/feeds", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  rename: (id: string, name: string) =>
    request<{ feed: WorkspaceFeed }>(`/workspace/feeds/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),

  remove: (id: string) =>
    request<void>(`/workspace/feeds/${id}`, { method: "DELETE" }),

  merge: (targetFeedId: string, sourceFeedId: string) =>
    request<{ feed: WorkspaceFeed }>(`/workspace/feeds/${targetFeedId}/merge`, {
      method: "POST",
      body: JSON.stringify({ sourceFeedId }),
    }),

  items: (id: string, opts?: { cursor?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (opts?.cursor) qs.set("cursor", opts.cursor);
    if (opts?.limit) qs.set("limit", String(opts.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<WorkspaceFeedItemsResponse>(
      `/workspace/feeds/${id}/items${suffix}`,
    );
  },

  // Slice 4: source authoring
  listSources: (id: string) =>
    request<{ sources: WorkspaceFeedSource[] }>(
      `/workspace/feeds/${id}/sources`,
    ),

  addSource: (id: string, input: AddWorkspaceFeedSourceInput) =>
    request<{ source: WorkspaceFeedSource }>(`/workspace/feeds/${id}/sources`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  removeSource: (id: string, sourceId: string) =>
    request<void>(`/workspace/feeds/${id}/sources/${sourceId}`, {
      method: "DELETE",
    }),

  moveSource: (sourceFeedId: string, sourceId: string, targetFeedId: string) =>
    request<{ ok: true }>(
      `/workspace/feeds/${sourceFeedId}/sources/${sourceId}/move`,
      {
        method: "POST",
        body: JSON.stringify({ targetFeedId }),
      },
    ),

  patchSource: (
    id: string,
    sourceId: string,
    body: { step?: number; sampling?: "random" | "top"; muted?: boolean },
  ) =>
    request<{ source: WorkspaceFeedSource }>(
      `/workspace/feeds/${id}/sources/${sourceId}`,
      {
        method: "PATCH",
        body: JSON.stringify(body),
      },
    ),

  // Slice 14: per-feed-per-author volume + sampling commitment surfaced from
  // the pip panel. step=null means "passive" (no row), step=0 mutes, 1..5 are
  // the committed levels mapped to feed_sources.weight server-side.
  getAuthorVolume: (feedId: string, pubkey: string) =>
    request<AuthorVolume>(`/workspace/feeds/${feedId}/author-volume/${pubkey}`),

  setAuthorVolume: (
    feedId: string,
    pubkey: string,
    body: { step: number; sampling: "random" | "top" },
  ) =>
    request<AuthorVolume>(
      `/workspace/feeds/${feedId}/author-volume/${pubkey}`,
      {
        method: "PUT",
        body: JSON.stringify(body),
      },
    ),

  clearAuthorVolume: (feedId: string, pubkey: string) =>
    request<void>(`/workspace/feeds/${feedId}/author-volume/${pubkey}`, {
      method: "DELETE",
    }),

  // Slice 20: per-feed saved-items list. Save key is feed_items.id (the
  // unified identifier); the BookmarkButton retires with the deprecated
  // chassis on merge, so the workspace's save story is solely this surface.
  listSaves: (id: string, opts?: { cursor?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (opts?.cursor) qs.set("cursor", opts.cursor);
    if (opts?.limit) qs.set("limit", String(opts.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<WorkspaceFeedSavesResponse>(
      `/workspace/feeds/${id}/saves${suffix}`,
    );
  },

  listSavedIds: (id: string) =>
    request<{ feedItemIds: string[] }>(`/workspace/feeds/${id}/saves/ids`),

  saveItem: (id: string, feedItemId: string) =>
    request<{ ok: true }>(`/workspace/feeds/${id}/saves`, {
      method: "POST",
      body: JSON.stringify({ feedItemId }),
    }),

  unsaveItem: (id: string, feedItemId: string) =>
    request<void>(`/workspace/feeds/${id}/saves/${feedItemId}`, {
      method: "DELETE",
    }),
};

export interface WorkspaceFeedSavesResponse {
  feed: WorkspaceFeed;
  items: WorkspaceFeedApiItem[];
  nextCursor?: string;
}

export interface AuthorVolume {
  authorPubkey: string;
  accountId: string | null;
  step: number | null;
  sampling: "random" | "top";
  muted: boolean;
}

// ---------------------------------------------------------------------------
// External item interactions (Phase 2 — live engagement + parent context)
// ---------------------------------------------------------------------------

export interface EngagementResponse {
  likeCount: number;
  replyCount: number;
  repostCount: number;
  protocol: string;
  fetchedAt: string;
}

export interface ParentContextResponse {
  parent: ParentItem | null;
  grandparentTag: { authorName: string; authorHandle: string } | null;
  // Server-signalled: a parent was expected but the source fetch failed/timed out.
  partial: boolean;
}

export interface ParentItem {
  id: string;
  sourceProtocol: string;
  sourceItemUri: string;
  authorName: string | null;
  authorHandle: string | null;
  authorAvatarUrl: string | null;
  authorUri: string | null;
  contentText: string | null;
  contentHtml: string | null;
  title: string | null;
  summary: string | null;
  likeCount: number;
  replyCount: number;
  repostCount: number;
  media: unknown[];
  publishedAt: number;
  sourceReplyUri: string | null;
}

export interface ExternalThreadEntry {
  id: string;
  authorName: string;
  authorHandle: string;
  authorUri: string;
  contentHtml: string;
  contentText: string;
  publishedAt: string;
  likeCount: number;
  replyCount: number;
  repostCount: number;
  parentId: string | null;
  protocol: string;
}

export interface ThreadResponse {
  ancestors: ExternalThreadEntry[];
  descendants: ExternalThreadEntry[];
  // Server-signalled: the source thread could not be reached/completed.
  partial: boolean;
}

export const externalItems = {
  engagement: (id: string) =>
    request<EngagementResponse>(`/external-items/${id}/engagement`),

  parent: (id: string) =>
    request<ParentContextResponse>(`/external-items/${id}/parent`),

  thread: (id: string) =>
    request<ThreadResponse>(`/external-items/${id}/thread`),
};

// External source surface (CARD-BEHAVIOUR-ADR §VI.2) — byline-click destination
export interface SourceMeta {
  id: string;
  protocol: string;
  sourceUri: string;
  displayName: string | null;
  avatarUrl: string | null;
  description: string | null;
}

export interface SourceSurfaceResponse {
  source: SourceMeta;
  // External feed items, same shape the timeline returns; mapped client-side.
  items: unknown[];
  nextCursor?: string;
}

export const sources = {
  get: (id: string, cursor?: string) =>
    request<SourceSurfaceResponse>(
      `/sources/${id}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    ),
};

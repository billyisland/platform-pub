// =============================================================================
// Unified Post endpoints — UNIVERSAL-POST-ADR §9
//
// The Phase-1 read endpoints over the Post model. Phase 3 consumes /thread. The
// workspace reads its own GET /workspace/feeds/:id/items, which now also emits
// gateway Post[] directly (FEED-RETIREMENT-PLAN Slice 6 item 4) — no client adapter.
// =============================================================================

import { request } from "./client";
import type { Post, RepostEdge } from "../post/types";

// GET /thread/:postId → ancestors-to-root + focal + first N descendants.
export interface PostThreadResponse {
  focalId: string;
  posts: Post[];
  repostEdges: RepostEdge[];
  replyCursor?: string; // present when more descendants remain (keyset)
  totalDescendants: number;
  paywallLocked?: boolean; // gated article, viewer has no access: only the focal
}

export function postThread(
  postId: string,
  opts?: { replyLimit?: number; replyCursor?: string },
): Promise<PostThreadResponse> {
  const params = new URLSearchParams();
  if (opts?.replyLimit) params.set("replyLimit", String(opts.replyLimit));
  if (opts?.replyCursor) params.set("replyCursor", opts.replyCursor);
  const qs = params.toString();
  return request<PostThreadResponse>(`/thread/${postId}${qs ? `?${qs}` : ""}`);
}

// =============================================================================
// Constructed author profile — Phase 4 (§4.4, §9). Keyed on the persistent
// author.id (native accounts.id / tier-A/B external_authors.id). The single
// source of truth for the author DTO; useAuthorCard re-exports it as
// AuthorCardData so the shipped AuthorModal renders it unchanged.
// =============================================================================
export interface AuthorProfile {
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
  // Internal all.haus profile route for the display-name link (native → /:username,
  // external A/B → /author/:authorId). Absent ⇒ name is plain text.
  profilePath?: string;
  // The author's profile page on the origin platform, for the @handle link.
  // Absent ⇒ handle is plain text.
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

// GET /author/:authorId/profile → hover modal + profile header.
export function authorProfile(authorId: string): Promise<AuthorProfile> {
  return request<AuthorProfile>(`/author/${authorId}/profile`);
}

// GET /author/:authorId/posts → chronological full-view Post log (paginated).
// `kind` narrows the native log to articles or notes (the profile Work / Social
// tabs); omit for the combined log (the constructed author profile).
export function authorPosts(
  authorId: string,
  cursor?: string,
  kind?: "article" | "note",
  limit?: number,
): Promise<{ items: Post[]; nextCursor?: string }> {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  if (kind) params.set("kind", kind);
  if (limit) params.set("limit", String(limit));
  const qs = params.toString();
  return request<{ items: Post[]; nextCursor?: string }>(
    `/author/${authorId}/posts${qs ? `?${qs}` : ""}`,
  );
}

// GET /tags/:name/posts → articles with this tag as full-view Post[] (tags are
// article-only), the same shape GET /author/:id/posts returns. `total` is kept
// for the surface's article-count header.
export function tagPosts(
  name: string,
  cursor?: string,
  limit?: number,
): Promise<{ tag: string; items: Post[]; total: number; nextCursor?: string }> {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  if (limit) params.set("limit", String(limit));
  const qs = params.toString();
  return request<{
    tag: string;
    items: Post[];
    total: number;
    nextCursor?: string;
  }>(`/tags/${encodeURIComponent(name)}/posts${qs ? `?${qs}` : ""}`);
}

// GET /author/:authorId/replies → the native author's replies (kind-1111
// comments) as full-view Post[]. Outside /posts because comments aren't
// feed_items; each expands into the unified thread like any Post.
export function authorReplies(
  authorId: string,
  cursor?: string,
  limit?: number,
): Promise<{ items: Post[]; nextCursor?: string }> {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  if (limit) params.set("limit", String(limit));
  const qs = params.toString();
  return request<{ items: Post[]; nextCursor?: string }>(
    `/author/${authorId}/replies${qs ? `?${qs}` : ""}`,
  );
}

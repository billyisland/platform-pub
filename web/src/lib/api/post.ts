// =============================================================================
// Unified Post endpoints — UNIVERSAL-POST-ADR §9
//
// The Phase-1 read endpoints over the Post model. Phase 3 consumes /thread; the
// /feed endpoint is wired in a later phase (the workspace still flows through
// /workspace/feeds/:id/items, mapped client-side by lib/post/map-feed-item.ts).
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
export function authorPosts(
  authorId: string,
  cursor?: string,
): Promise<{ items: Post[]; nextCursor?: string }> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return request<{ items: Post[]; nextCursor?: string }>(
    `/author/${authorId}/posts${qs}`,
  );
}

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

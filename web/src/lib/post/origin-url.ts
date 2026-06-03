import type { Post } from "./types";

// Public web permalink for an external post's origin, derived from its stable
// origin URI. atproto `at://` URIs are rewritten to their bsky.app web URL
// (mirrors PostOriginTag / VesselCard's atprotoWebUri); http(s) permalinks
// (activitypub status URLs, rss links) pass through; anything else (nostr event
// ids, malformed) yields null. Used for the origin tag's link-out and to embed
// a clickable reference when quoting an external post (migration 102).
export function originWebUrl(post: Post): string | null {
  const uri = post.origin.uri;
  if (!uri) return null;
  const at = uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/);
  if (at) return `https://bsky.app/profile/${at[1]}/post/${at[2]}`;
  if (/^https?:\/\//.test(uri)) return uri;
  return null;
}

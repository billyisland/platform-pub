"use client";

import React from "react";
import { Byline } from "../workspace/Byline";
import { TrustPip } from "../ui/TrustPip";
import { AuthorModal, useAuthorHover } from "../feed/AuthorModal";
import { PostResonance } from "./PostResonance";
import { useWriterName } from "../../hooks/useWriterName";
import type { VesselPalette } from "../workspace/tokens";
import type { Post } from "../../lib/post/types";
import type { PipOpen } from "./chassis";

// =============================================================================
// PostByline — the one byline for every Post, at every level.
//
// Native vs external is a stable property of a given Post, so we render one of
// two sub-components (each may call its own hooks without violating the rules of
// hooks): NativeByline resolves the display name via useWriterName(pubkey) — the
// workspace API never carries native names — while ExternalByline reads the
// name straight off the Post.
//
// Byline ROUTING (§4.4, flipped for tier A/B in Phase 4):
//  - native → /{username} when known (clickable profile)
//  - external A/B → /author/:authorId (the constructed external-author profile)
//  - external C/D → plain text (C: no reliable key; D: no author).
//
// HOVER (§4.4): every linked byline (native + tier A/B) anchors a debounced,
// session-cached profile preview (AuthorModal, type "author"). The 300 ms rest
// debounce + per-author cache live in useAuthorHover/useAuthorCard. Tier C/D and
// the quoted level (bylineProfile=false) have no linked byline, so no hover.
// =============================================================================

// Last-resort byline label when a post carries no author name, handle, or
// source name (a data gap in ingest — e.g. the historical atproto "EXTERNAL"
// bug). Derive a friendly label from the origin protocol rather than showing a
// bare "External", which reads as if the account were literally named EXTERNAL.
function protocolFallbackName(protocol: string): string {
  switch (protocol) {
    case "atproto":
      return "Bluesky user";
    case "activitypub":
      return "Fediverse user";
    case "nostr":
    case "nostr_external":
      return "Nostr user";
    case "rss":
      return "Web feed";
    case "email":
      return "Email";
    default:
      return "Unknown author";
  }
}

export function PostByline({
  post,
  palette,
  bylineProfile,
  showResonance,
  trailing,
  replyingTo,
  feedId,
}: {
  post: Post;
  palette: VesselPalette;
  bylineProfile: boolean;
  // D7: resolveSpec has already checked both that this level shows the glyph
  // and that the post carries a band >= 1.
  showResonance?: boolean;
  trailing?: React.ReactNode;
  replyingTo?: { name: string } | null;
  // Dormant: the pip panel is parked, so onPipOpen is accepted (callers still
  // thread it) but unused — the pip no longer opens a panel. See pipNode below.
  onPipOpen?: PipOpen;
  feedId?: string;
}) {
  // The glyph belongs to the metadata cluster, so it rides the trailing slot
  // immediately after the timestamp and ahead of any caller-supplied trailing
  // (price / protocol badge), which stays the rightmost element.
  const merged = showResonance ? (
    <>
      <PostResonance post={post} palette={palette} />
      {trailing}
    </>
  ) : (
    trailing
  );

  if (post.author.pubkey) {
    return (
      <NativeByline
        post={post}
        palette={palette}
        bylineProfile={bylineProfile}
        trailing={merged}
        replyingTo={replyingTo}
        feedId={feedId}
      />
    );
  }
  return (
    <ExternalByline
      post={post}
      palette={palette}
      bylineProfile={bylineProfile}
      trailing={merged}
      replyingTo={replyingTo}
      feedId={feedId}
    />
  );
}

// Pip panel parked: the pip is a non-interactive legibility dot. The author
// actions it used to host (Follow, per-feed VOLUME) now live in the byline
// hover panel (AuthorModal → SourceVolume). PipTrigger/PipPanel stay in the
// tree but dormant; restore by reinstating the PipTrigger branch + onPipOpen.
function pipNode(post: Post): React.ReactNode {
  return <TrustPip status={post.author.pipStatus} />;
}

function NativeByline({
  post,
  palette,
  bylineProfile,
  trailing,
  replyingTo,
  feedId,
}: {
  post: Post;
  palette: VesselPalette;
  bylineProfile: boolean;
  trailing?: React.ReactNode;
  replyingTo?: { name: string } | null;
  feedId?: string;
}) {
  const writer = useWriterName(post.author.pubkey!);
  const name = writer?.displayName ?? post.author.pubkey!.slice(0, 12) + "…";
  const nameHref =
    bylineProfile && writer?.username ? `/${writer.username}` : undefined;
  // Hover keys on the persistent author.id (accounts.id) — null disables it on
  // the quoted level / when there is no profile to link.
  const hover = useAuthorHover(
    "author",
    bylineProfile ? post.author.id : null,
  );
  return (
    <>
      <Byline
        pipNode={pipNode(post)}
        name={name}
        nameHref={nameHref}
        publishedAt={post.publishedAt}
        replyingTo={replyingTo}
        trailing={trailing}
        palette={palette}
        nameRef={hover.bylineRef}
        onNameMouseEnter={hover.onMouseEnter}
        onNameMouseLeave={hover.onMouseLeave}
        dataExplain="card.byline"
      />
      {hover.open && hover.id && (
        <AuthorModal
          type="author"
          id={hover.id}
          anchorRef={hover.bylineRef}
          onClose={hover.onModalClose}
          onMouseEnter={hover.onModalMouseEnter}
          onMouseLeave={hover.onModalMouseLeave}
          feedId={feedId}
          pubkey={post.author.pubkey ?? undefined}
          frameColor={palette.walls}
        />
      )}
    </>
  );
}

function ExternalByline({
  post,
  palette,
  bylineProfile,
  trailing,
  replyingTo,
  feedId,
}: {
  post: Post;
  palette: VesselPalette;
  bylineProfile: boolean;
  trailing?: React.ReactNode;
  replyingTo?: { name: string } | null;
  feedId?: string;
}) {
  const name =
    post.author.displayName ??
    post.author.handle ??
    post.origin.sourceName ??
    protocolFallbackName(post.origin.protocol);
  // Tier A/B carry an author.id (external_authors record) → link + hover to the
  // constructed profile. Tier C/D have author.id = null → plain text, no hover.
  const linkable = bylineProfile && !!post.author.id;
  const nameHref = linkable ? `/author/${post.author.id}` : undefined;
  const hover = useAuthorHover("author", linkable ? post.author.id : null);
  return (
    <>
      <Byline
        pipNode={<TrustPip status={post.author.pipStatus} />}
        name={name}
        nameHref={nameHref}
        publishedAt={post.publishedAt}
        replyingTo={replyingTo}
        trailing={trailing}
        palette={palette}
        nameRef={hover.bylineRef}
        onNameMouseEnter={hover.onMouseEnter}
        onNameMouseLeave={hover.onMouseLeave}
        dataExplain="card.byline"
      />
      {hover.open && hover.id && (
        <AuthorModal
          type="author"
          id={hover.id}
          anchorRef={hover.bylineRef}
          onClose={hover.onModalClose}
          onMouseEnter={hover.onModalMouseEnter}
          onMouseLeave={hover.onModalMouseLeave}
          feedId={feedId}
          frameColor={palette.walls}
        />
      )}
    </>
  );
}

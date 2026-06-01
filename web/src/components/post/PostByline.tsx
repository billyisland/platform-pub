"use client";

import React from "react";
import { Byline } from "../workspace/Byline";
import { PipTrigger } from "../workspace/PipTrigger";
import { TrustPip } from "../ui/TrustPip";
import { AuthorModal, useAuthorHover } from "../feed/AuthorModal";
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

export function PostByline({
  post,
  palette,
  bylineProfile,
  trailing,
  replyingTo,
  onPipOpen,
}: {
  post: Post;
  palette: VesselPalette;
  bylineProfile: boolean;
  trailing?: React.ReactNode;
  replyingTo?: { name: string } | null;
  onPipOpen?: PipOpen;
}) {
  if (post.author.pubkey) {
    return (
      <NativeByline
        post={post}
        palette={palette}
        bylineProfile={bylineProfile}
        trailing={trailing}
        replyingTo={replyingTo}
        onPipOpen={onPipOpen}
      />
    );
  }
  return (
    <ExternalByline
      post={post}
      palette={palette}
      bylineProfile={bylineProfile}
      trailing={trailing}
      replyingTo={replyingTo}
    />
  );
}

function pipNode(
  post: Post,
  palette: VesselPalette,
  onPipOpen?: PipOpen,
): React.ReactNode {
  if (post.author.pubkey && onPipOpen) {
    return (
      <PipTrigger
        pubkey={post.author.pubkey}
        pipStatus={post.author.pipStatus}
        opacity={palette.pipOpacity}
        onOpen={onPipOpen}
      />
    );
  }
  return <TrustPip status={post.author.pipStatus} />;
}

function NativeByline({
  post,
  palette,
  bylineProfile,
  trailing,
  replyingTo,
  onPipOpen,
}: {
  post: Post;
  palette: VesselPalette;
  bylineProfile: boolean;
  trailing?: React.ReactNode;
  replyingTo?: { name: string } | null;
  onPipOpen?: PipOpen;
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
        pipNode={pipNode(post, palette, onPipOpen)}
        name={name}
        nameHref={nameHref}
        publishedAt={post.publishedAt}
        replyingTo={replyingTo}
        trailing={trailing}
        palette={palette}
        nameRef={hover.bylineRef}
        onNameMouseEnter={hover.onMouseEnter}
        onNameMouseLeave={hover.onMouseLeave}
      />
      {hover.open && hover.id && (
        <AuthorModal
          type="author"
          id={hover.id}
          anchorRef={hover.bylineRef}
          onClose={hover.onModalClose}
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
}: {
  post: Post;
  palette: VesselPalette;
  bylineProfile: boolean;
  trailing?: React.ReactNode;
  replyingTo?: { name: string } | null;
}) {
  const name =
    post.author.displayName ??
    post.author.handle ??
    post.origin.sourceName ??
    "External";
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
      />
      {hover.open && hover.id && (
        <AuthorModal
          type="author"
          id={hover.id}
          anchorRef={hover.bylineRef}
          onClose={hover.onModalClose}
        />
      )}
    </>
  );
}

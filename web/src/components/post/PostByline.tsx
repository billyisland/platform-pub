"use client";

import React from "react";
import { Byline } from "../workspace/Byline";
import { PipTrigger } from "../workspace/PipTrigger";
import { TrustPip } from "../ui/TrustPip";
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
// Byline ROUTING (current-phase reading of §4.4):
//  - native → /{username} when known (clickable profile)
//  - external A/B → plain text THIS PHASE. §4.4 flips the rule to route A/B
//    bylines to /author/:id, but that profile route ships in Phase 4 — see TODO.
//  - external C/D → plain text (C: no reliable key; D: no author).
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
  return (
    <Byline
      pipNode={pipNode(post, palette, onPipOpen)}
      name={name}
      nameHref={nameHref}
      publishedAt={post.publishedAt}
      replyingTo={replyingTo}
      trailing={trailing}
      palette={palette}
    />
  );
}

function ExternalByline({
  post,
  palette,
  trailing,
  replyingTo,
}: {
  post: Post;
  palette: VesselPalette;
  trailing?: React.ReactNode;
  replyingTo?: { name: string } | null;
}) {
  const name =
    post.author.displayName ??
    post.author.handle ??
    post.origin.sourceName ??
    "External";
  // Phase 4: route tier-A/B external bylines to /author/${post.author.id}
  // (the constructed external-author profile, ADR §4.4 / §VI.3). Until that
  // route exists, external bylines stay plain text — never fabricate a link.
  return (
    <Byline
      pipNode={<TrustPip status={post.author.pipStatus} />}
      name={name}
      publishedAt={post.publishedAt}
      replyingTo={replyingTo}
      trailing={trailing}
      palette={palette}
    />
  );
}

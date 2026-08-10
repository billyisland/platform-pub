"use client";

import React from "react";
import type { Post } from "../../lib/post/types";
import { originWebUrl } from "../../lib/post/origin-url";
import { PlatformResonance } from "./PostResonance";
import type { VesselPalette } from "../workspace/tokens";

// =============================================================================
// PostOriginTag — the "handle@site → origin" provenance line (§4 matrix row).
//
// Adapted from VesselCard's SourceAttribution. This is the SINGLE route out to
// the content's original location (CARD-BEHAVIOUR-ADR §VI.4): the byline routes
// internally, only this tag links to the origin platform.
//
// Tier D degrades to source-name only (no handle/identifier). Native content is
// labelled ALL.HAUS and carries no outbound link (all.haus IS the origin).
// =============================================================================

const PROTOCOL_DISPLAY: Record<string, string> = {
  rss: "RSS",
  atproto: "BLUESKY",
  activitypub: "FEDIVERSE",
  nostr_external: "NOSTR",
  email: "EMAIL",
};

export function PostOriginTag({
  post,
  palette,
  sourceOnly,
  showPlatformMark,
}: {
  post: Post;
  palette: VesselPalette;
  sourceOnly: boolean; // tier D
  // D7 platform-scope resonance mark. It sits immediately after the network
  // name because ADJACENCY IS WHAT GIVES IT ITS SCOPE — the same triangle in
  // the byline means "popping for this author", here it means "popping for
  // this network". Moving it away from the name would strand the claim.
  showPlatformMark?: boolean;
}) {
  const isNative = post.origin.protocol === "nostr" && !!post.author.pubkey;
  const mark = showPlatformMark ? (
    <>
      {" "}
      <PlatformResonance post={post} palette={palette} />
    </>
  ) : null;

  // Slice 8 P1: "ALSO ON …" — the other linked sources cross-posting this content.
  const alsoOnLabels = (post.alsoOn ?? [])
    .map((p) => PROTOCOL_DISPLAY[p] ?? p.toUpperCase())
    .filter((v, i, a) => a.indexOf(v) === i);
  const alsoOn =
    alsoOnLabels.length > 0 ? (
      <TagText palette={palette}>ALSO ON {alsoOnLabels.join(" · ")}</TagText>
    ) : null;

  if (isNative) {
    return (
      <>
        <TagText palette={palette}>VIA ALL.HAUS{mark}</TagText>
        {alsoOn}
      </>
    );
  }

  const label = PROTOCOL_DISPLAY[post.origin.protocol] ?? post.origin.protocol.toUpperCase();
  const community = post.origin.sourceName ?? undefined;
  const identifier = sourceOnly ? undefined : post.author.handle ?? undefined;

  const text = (
    <>
      VIA {label}
      {mark}
      {community ? ` · ${community}` : ""}
      {identifier ? ` · ${identifier}` : ""}
    </>
  );

  const href = originWebUrl(post);
  if (!href)
    return (
      <>
        <TagText palette={palette}>{text}</TagText>
        {alsoOn}
      </>
    );

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          window.open(href, "_blank", "noopener,noreferrer");
        }}
        className="font-mono text-[0.625rem] uppercase tracking-[0.06em] mt-2 text-left hover:opacity-80"
        style={{
          color: palette.cardMeta,
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
        }}
      >
        {text} →
      </button>
      {alsoOn}
    </>
  );
}

function TagText({
  palette,
  children,
}: {
  palette: VesselPalette;
  children: React.ReactNode;
}) {
  return (
    <div
      className="font-mono text-[0.625rem] uppercase tracking-[0.06em] mt-2"
      style={{ color: palette.cardMeta }}
    >
      {children}
    </div>
  );
}

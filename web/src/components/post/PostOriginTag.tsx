"use client";

import React from "react";
import type { Post } from "../../lib/post/types";
import { originWebUrl } from "../../lib/post/origin-url";
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
}: {
  post: Post;
  palette: VesselPalette;
  sourceOnly: boolean; // tier D
}) {
  const isNative = post.origin.protocol === "nostr" && !!post.author.pubkey;
  if (isNative) {
    return <TagText palette={palette}>VIA ALL.HAUS</TagText>;
  }

  const label = PROTOCOL_DISPLAY[post.origin.protocol] ?? post.origin.protocol.toUpperCase();
  const community = post.origin.sourceName ?? undefined;
  const identifier = sourceOnly ? undefined : post.author.handle ?? undefined;

  const text = (
    <>
      VIA {label}
      {community ? ` · ${community}` : ""}
      {identifier ? ` · ${identifier}` : ""}
    </>
  );

  const href = originWebUrl(post);
  if (!href) return <TagText palette={palette}>{text}</TagText>;

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        window.open(href, "_blank", "noopener,noreferrer");
      }}
      className="font-mono text-[10px] uppercase tracking-[0.06em] mt-2 text-left hover:opacity-80"
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
      className="font-mono text-[10px] uppercase tracking-[0.06em] mt-2"
      style={{ color: palette.cardMeta }}
    >
      {children}
    </div>
  );
}

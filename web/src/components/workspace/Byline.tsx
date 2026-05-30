"use client";

import React from "react";
import Link from "next/link";
import { formatDateRelative } from "../../lib/format";
import type { VesselPalette } from "./tokens";

// Shared byline row for the workspace card family (task 9b). One visual
// treatment — mono `label-ui` pip · name · time — used by the main card, the
// expanded reply thread (playscript entries), reply groups, and parent tiles,
// so a reply byline reads identically to a main-card byline. Always meta-sized
// (mono); the per-feed text-size control governs prose, never the chrome.
//
// `replyingTo` renders the non-adjacent-parent "→ NAME" affordance ahead of the
// speaker, in the same byline idiom (no bold-sans, no colon convention).
export function Byline({
  pipNode,
  name,
  nameHref,
  publishedAt,
  replyingTo,
  trailing,
  palette,
  className = "mb-2",
}: {
  pipNode?: React.ReactNode;
  name: string;
  nameHref?: string;
  publishedAt: number;
  replyingTo?: { name: string } | null;
  trailing?: React.ReactNode;
  palette: VesselPalette;
  className?: string;
}) {
  return (
    <div
      className={`flex items-center gap-2 label-ui ${className}`}
      style={{ color: palette.cardMeta }}
    >
      {replyingTo && (
        <>
          <span>&rarr;</span>
          <span className="font-medium">{replyingTo.name}</span>
          <span aria-hidden="true" style={{ display: "inline-block", width: 8 }} />
        </>
      )}
      {pipNode}
      {nameHref ? (
        <Link
          href={nameHref}
          onClick={(e) => e.stopPropagation()}
          style={{ color: palette.cardTitle }}
          className="font-medium hover:underline"
        >
          {name}
        </Link>
      ) : (
        <span style={{ color: palette.cardTitle }} className="font-medium">
          {name}
        </span>
      )}
      <span>·</span>
      <time dateTime={new Date(publishedAt * 1000).toISOString()}>
        {formatDateRelative(publishedAt)}
      </time>
      {trailing}
    </div>
  );
}

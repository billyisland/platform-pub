"use client";

import React from "react";
import Link from "next/link";
import { formatDateRelative } from "../../lib/format";
import { openProfileHref, isModifiedClick } from "../ui/ProfileLink";
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
  nameRef,
  onNameMouseEnter,
  onNameMouseLeave,
}: {
  pipNode?: React.ReactNode;
  name: string;
  nameHref?: string;
  publishedAt: number;
  replyingTo?: { name: string } | null;
  trailing?: React.ReactNode;
  palette: VesselPalette;
  className?: string;
  // Byline-hover modal (§4.4): the author name anchors the profile preview.
  nameRef?: React.Ref<HTMLElement>;
  onNameMouseEnter?: () => void;
  onNameMouseLeave?: () => void;
}) {
  const nameHover = {
    onMouseEnter: onNameMouseEnter,
    onMouseLeave: onNameMouseLeave,
  };
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
          ref={nameRef as React.Ref<HTMLAnchorElement>}
          onClick={(e) => {
            // Don't let the card's own click handler fire.
            e.stopPropagation();
            // Plain left-click opens the profile overlay in place; modified
            // clicks (new tab) fall through to the real link.
            if (!isModifiedClick(e) && openProfileHref(nameHref)) {
              e.preventDefault();
            }
          }}
          style={{ color: palette.cardTitle }}
          className="font-medium hover:underline"
          {...nameHover}
        >
          {name}
        </Link>
      ) : (
        <span
          ref={nameRef as React.Ref<HTMLSpanElement>}
          style={{ color: palette.cardTitle }}
          className="font-medium"
          {...nameHover}
        >
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

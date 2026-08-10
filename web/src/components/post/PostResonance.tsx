"use client";

import React from "react";
import type { VesselPalette } from "../workspace/tokens";
import type { Post } from "../../lib/post/types";

// =============================================================================
// PostResonance — the D7 glyph (SOCIAL-PROOF-RESONANCE-ADR).
//
// One mark in the byline metadata cluster. It says one thing — this post drew
// more response than THIS AUTHOR usually draws — and it says it without a
// number, because a raw count across four protocols is exactly the
// incommensurable comparison the ADR exists to refuse.
//
// TWO STATES, NOT THREE. The stored band has four values, but the mark has two
// senses worth distinguishing at a glance: noticed (▴) and well above (▲).
// Bands 1-2 both mean "above this author's usual" at different strengths and
// read identically on a card, so they collapse; band 3 is the one that earns a
// louder mark. Retuning which posts land where is the band dials' job
// (resonance_band{1,2,3}_min), not this file's.
//
// WHY TRIANGLES, NOT DOTS. The mark used to be · / ·· / ··· — recessive, and
// sitting in a cluster whose FIRST element is also a dot (the parked TrustPip),
// so the two read as one run of punctuation. A filled triangle points, which is
// the actual claim ("up, relative to usual"), and cannot be mistaken for the
// pip at 11px. Aggression is carried by the palette's own text ramp — muted
// cardMeta for the modest state, full-strength cardTitle for the loud one —
// never by crimson, which means PAID on a card (the left bar) and would make
// a popular post look like a charged one.
//
// What it is NOT: a quality mark, a like count, or anything money touches (D8).
//
// Absence vs zero is load-bearing all the way up the stack: a null band means
// no band was computed (rss/email, dark nostr, unscored rows), NOT "quiet".
// Both render nothing here, but resolveSpec is where they collapse — this
// component is only ever mounted for band >= 1.
// =============================================================================

type Level = "noticed" | "high";

function levelFor(band: number): Level | null {
  if (band >= 3) return "high";
  if (band >= 1) return "noticed";
  return null;
}

const GLYPH: Record<Level, string> = {
  noticed: "▴",
  high: "▲",
};

// First clause — the author-relative half, which is what the resonance ratio
// actually measures, and the only half that decides whether a glyph shows.
const AUTHOR_CLAUSE: Record<Level, string> = {
  noticed: "Good engagement for",
  high: "High engagement for",
};

// Second clause — the platform half, read off ambient_pctl. Its cuts are the
// scorer's own landmarks rather than new thresholds: PCTL_EXPR maps 0.5 to the
// network median and 0.9 to p90, the same two points the band's ambient test
// uses. Below the median we say nothing rather than reaching for a word — the
// clause exists to add a fact, and "typical" adds none.
//
// The old gloss asserted this half unconditionally ("and non-trivial for
// Bluesky") off a band that never actually checked it: the ambient veto is
// structurally unreachable — a post 5.7× its author's baseline is already above
// a median the baseline was shrunk toward — and fired 0 times in 19,700 rows.
// A clause that is always true is not information. Now it is read from the
// axis that measures it, and omitted when there is nothing to say.
const PLATFORM_HIGH = 0.9;
const PLATFORM_DECENT = 0.5;

function platformClause(post: Post): string | null {
  const pctl = post.ambientPctl;
  if (pctl == null) return null;
  const where = networkLabel(post);
  if (pctl >= PLATFORM_HIGH) return `high for ${where}`;
  if (pctl >= PLATFORM_DECENT) return `decent for ${where}`;
  return null;
}

// The label names the CORPUS the band was measured against, and that axis is
// protocol alone: native rows are protocol "nostr" (external nostr is always
// "nostr_external"), scored against all.haus's own corpus — including a native
// row with a NULL custodial pubkey, which the old pubkey-first check let fall
// through to the open-Nostr gloss (§0i.9; isNativePost's pubkey conjunct is
// about byline routing, not baseline membership).
function networkLabel(post: Post): string {
  switch (post.origin.protocol) {
    case "nostr":
      return "all.haus";
    case "atproto":
      return "Bluesky";
    case "activitypub":
      return "the Fediverse";
    case "nostr_external":
      return "Nostr";
    default:
      return "this network";
  }
}

// The byline shows the author by display name where there is one; the gloss
// names the same person the reader is looking at, so it follows the same
// preference and falls back to the handle, then to a neutral phrase — never to
// an empty string, which would read as "High engagement for , decent for …".
function authorLabel(post: Post): string {
  const name = post.author.displayName?.trim();
  if (name) return name;
  const handle = post.author.handle?.trim();
  if (handle) return handle.startsWith("@") ? handle : `@${handle}`;
  return "this author";
}

export function PostResonance({
  post,
  palette,
}: {
  post: Post;
  palette: VesselPalette;
}) {
  const level = levelFor(post.resonanceBand ?? 0);
  if (!level) return null;

  const platform = platformClause(post);
  const gloss = platform
    ? `${AUTHOR_CLAUSE[level]} ${authorLabel(post)}, ${platform}.`
    : `${AUTHOR_CLAUSE[level]} ${authorLabel(post)}.`;

  return (
    <span
      // The glyph is meaningful, not decoration, so it carries the gloss to
      // assistive tech rather than being aria-hidden like the (parked) pip.
      // `title` is the hover tooltip; both read the same sentence.
      title={gloss}
      aria-label={gloss}
      role="img"
      data-explain="card.resonance"
      style={{
        // Full-strength text for the loud state, the muted metadata ramp for
        // the modest one — both palette fields, so this inverts with the feed's
        // light/dark variant instead of assuming a ground.
        color: level === "high" ? palette.cardTitle : palette.cardMeta,
        // The triangle is a small glyph in a row of caps; a hair of optical
        // size keeps it from disappearing between the middle dots.
        fontSize: "1.08em",
        lineHeight: 1,
      }}
      // cursor-default stops it reading as a link inside a byline full of them.
      className="cursor-default select-none"
    >
      {GLYPH[level]}
    </span>
  );
}

"use client";

import React from "react";
import type { VesselPalette } from "../workspace/tokens";
import type { Post } from "../../lib/post/types";

// =============================================================================
// PostResonance — the D7 glyph (SOCIAL-PROOF-RESONANCE-ADR).
//
// One typographic mark in the byline metadata cluster: nothing / · / ·· / ···
// for bands 0-3, in palette.cardMeta. It says one thing — this post drew more
// response than this author usually draws, and enough to be non-trivial on its
// own network — and it says it without a number, because a raw count across
// four protocols is exactly the incommensurable comparison the ADR exists to
// refuse.
//
// What it is NOT: a quality mark, a like count, or anything money touches (D8).
//
// Absence vs zero is load-bearing all the way up the stack: a null band means
// no band was computed (rss/email, dark nostr, unscored rows), NOT "quiet".
// Both render nothing here, but resolveSpec is where they collapse — this
// component is only ever mounted for band >= 1.
// =============================================================================

const BAND_GLYPH: Record<number, string> = {
  1: "·",
  2: "··",
  3: "···",
};

// First clause of the D4 two-clause gloss — the author-relative half, which is
// what the resonance ratio actually measures.
const BAND_CLAUSE: Record<number, string> = {
  1: "Getting more response than this author usually gets",
  2: "Well above this author's usual",
  3: "Far above this author's usual",
};

// Second clause — the ambient veto, phrased as the network it was checked
// against. Bands 1-2 clear the corpus median; band 3 clears the 90th centile,
// so it earns the stronger word.
function ambientClause(post: Post, band: number): string {
  const where = networkLabel(post);
  return band >= 3 ? `and high for ${where}` : `and non-trivial for ${where}`;
}

// A native post is protocol "nostr" WITH a pubkey — it was measured against
// all.haus's own corpus, not the open Nostr network's, so name it accordingly.
function networkLabel(post: Post): string {
  if (post.author.pubkey) return "all.haus";
  switch (post.origin.protocol) {
    case "atproto":
      return "Bluesky";
    case "activitypub":
      return "the Fediverse";
    case "nostr":
    case "nostr_external":
      return "Nostr";
    default:
      return "this network";
  }
}

export function PostResonance({
  post,
  palette,
}: {
  post: Post;
  palette: VesselPalette;
}) {
  const band = post.resonanceBand ?? 0;
  const glyph = BAND_GLYPH[band];
  if (!glyph) return null;

  const gloss = `${BAND_CLAUSE[band]}, ${ambientClause(post, band)}.`;

  return (
    <span
      // The glyph is meaningful, not decoration, so it carries the gloss to
      // assistive tech rather than being aria-hidden like the (parked) pip.
      // `title` is the hover tooltip; both read the same sentence.
      title={gloss}
      aria-label={gloss}
      role="img"
      data-explain="card.resonance"
      style={{ color: palette.cardMeta }}
      // Tracking opens the dots up so ·· and ··· stay countable at a glance;
      // cursor-default stops it reading as a link inside a byline full of them.
      className="cursor-default select-none tracking-[0.12em]"
    >
      {glyph}
    </span>
  );
}

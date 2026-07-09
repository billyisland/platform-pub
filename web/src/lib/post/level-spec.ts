// =============================================================================
// The §4 capability matrix + §7 biddability gate, as data.
//
// UNIVERSAL-POST-ADR §4 is "the centrepiece": every (level × affordance) cell is
// a value in LEVEL_SPEC. §7 then SUBTRACTS per biddability tier (tierCaps).
// resolveSpec(level, tier, post) intersects the two into a flat ResolvedSpec that
// PostCard hands to its dumb leaf components — so affordance logic is one table
// lookup + one mask, never scattered `if (protocol === 'rss')` chains.
//
// The matrix is the MAXIMUM per level; the tier mask only ever removes.
// =============================================================================

import type { Level, BiddabilityTier, Post } from "./types";

// "+1 step" of indentation. Matches the documented thread step-in (CLAUDE.md →
// "Thread step-in … indented 32px once (ml-8)"). Phase 3 owns the thread walk;
// here it only governs parent/reply offset in the harness.
const INDENT_STEP_PX = 32;

const GAP_PX = { feed: 8, tight: 5, none: 0 } as const; // CLAUDE feed/thread rhythm

type BodyMode = "expanded" | "full" | "one-line";
type MediaMode = "full-width" | "sized" | "single-thumbnail" | "none";
type VideoMode = "autoplay-unmute" | "static" | "none";
type HausMode = "full" | "numerals-only" | "none";
type CountersMode = "fresh-on-expand" | "static" | "inline-numerals" | "none";
type QuoteMode = "full-child" | "mini" | "stub" | "none";
type ClickAction = "collapse" | "expand-focal" | "reroot-focal" | "reader-pane" | "none";

interface LevelSpec {
  textScale: number; // × ctx.bodyPx
  indentStep: 0 | 1 | "host"; // "host" = rendered inside the quote container, no own indent
  gapBelow: keyof typeof GAP_PX;
  body: BodyMode;
  media: MediaMode;
  video: VideoMode;
  haus: HausMode; // all.haus vote/repost/save
  originTag: boolean;
  report: boolean; // further gated to native-only in resolveSpec
  originCounters: CountersMode;
  quoteEmbed: QuoteMode;
  click: ClickAction;
}

// One row per §4 column. Read the ADR §4 table top-to-bottom against this.
export const LEVEL_SPEC: Record<Level, LevelSpec> = {
  focal: {
    textScale: 1.0,
    indentStep: 0,
    gapBelow: "tight",
    body: "expanded",
    media: "full-width",
    video: "autoplay-unmute",
    haus: "full",
    originTag: true,
    report: true,
    originCounters: "fresh-on-expand",
    quoteEmbed: "full-child",
    click: "collapse",
  },
  feed: {
    textScale: 1.0,
    indentStep: 0,
    gapBelow: "feed",
    body: "full",
    media: "sized",
    video: "static",
    haus: "full",
    originTag: true,
    report: true,
    originCounters: "none",
    quoteEmbed: "mini",
    click: "expand-focal",
  },
  "thread-parent": {
    textScale: 0.9,
    indentStep: 1,
    gapBelow: "tight",
    body: "expanded",
    media: "sized",
    video: "static",
    haus: "full",
    originTag: true,
    report: true,
    originCounters: "static",
    quoteEmbed: "mini",
    click: "reroot-focal",
  },
  "thread-reply": {
    textScale: 0.9,
    indentStep: 1,
    gapBelow: "tight",
    body: "expanded",
    media: "sized",
    video: "static",
    haus: "full",
    originTag: true,
    report: true,
    originCounters: "static",
    quoteEmbed: "mini",
    click: "reroot-focal",
  },
  quoted: {
    textScale: 0.85,
    indentStep: "host",
    gapBelow: "none",
    body: "full",
    media: "single-thumbnail",
    video: "none",
    haus: "none",
    originTag: false,
    report: false,
    originCounters: "none",
    quoteEmbed: "stub",
    click: "reroot-focal",
  },
  condensed: {
    textScale: 0.85,
    indentStep: 0,
    gapBelow: "tight",
    body: "one-line",
    media: "none",
    video: "none",
    haus: "numerals-only",
    originTag: false,
    report: false,
    originCounters: "inline-numerals",
    quoteEmbed: "stub",
    click: "expand-focal",
  },
};

// §7 subtractive mask. all.haus actions (haus) are AVAILABLE AT EVERY TIER —
// the scoresheet is minted for every THING — so haus is never masked here.
export interface TierCaps {
  bylineProfile: boolean; // byline routes to a profile (author known: A/B/C) vs plain text (D)
  originCounters: boolean; // origin like/reply/repost exist (A/B) vs not (C/D)
  threads: boolean; // origin parents/replies exist (A/B) — informs click reachability (Phase 3)
  interactBack: boolean; // reply/like/repost to the origin (A/B)
  originTagSourceOnly: boolean; // tier D: origin tag degrades to source-name only
}

export function tierCaps(tier: BiddabilityTier): TierCaps {
  switch (tier) {
    case "A":
    case "B":
      return {
        bylineProfile: true,
        originCounters: true,
        threads: true,
        interactBack: true,
        originTagSourceOnly: false,
      };
    case "C":
      return {
        bylineProfile: true,
        originCounters: false,
        threads: false,
        interactBack: false,
        originTagSourceOnly: false,
      };
    case "D":
      return {
        bylineProfile: false,
        originCounters: false,
        threads: false,
        interactBack: false,
        originTagSourceOnly: true,
      };
  }
}

export interface ResolvedSpec {
  textScale: number;
  indentPx: number;
  insideHost: boolean; // quoted: laid out inside the host's quote container
  gapBelowPx: number;
  body: BodyMode;
  media: MediaMode;
  video: VideoMode;
  haus: HausMode;
  showOriginTag: boolean;
  originTagSourceOnly: boolean;
  showReport: boolean; // native-only AND level permits
  originCounters: CountersMode; // "none" once the tier has no origin counters
  quoteEmbed: QuoteMode;
  click: ClickAction; // articles override to "reader-pane"
  bylineProfile: boolean; // byline routes to a profile
  threads: boolean;
  interactBack: boolean;
}

// A Post is native iff it carries a nostr pubkey (external items never do).
export function isNativePost(post: Post): boolean {
  return post.origin.protocol === "nostr" && !!post.author.pubkey;
}

export function resolveSpec(
  level: Level,
  tier: BiddabilityTier,
  post: Post,
): ResolvedSpec {
  const spec = LEVEL_SPEC[level];
  const caps = tierCaps(tier);
  const native = isNativePost(post);

  return {
    textScale: spec.textScale,
    indentPx: spec.indentStep === 1 ? INDENT_STEP_PX : 0,
    insideHost: spec.indentStep === "host",
    gapBelowPx: GAP_PX[spec.gapBelow],
    body: spec.body,
    media: spec.media,
    video: spec.video,
    haus: spec.haus, // never tier-masked
    showOriginTag: spec.originTag,
    originTagSourceOnly: caps.originTagSourceOnly,
    // Report is native-only (§4 note); the level must also permit it.
    showReport: spec.report && native,
    // Origin counters require both the tier to expose them AND actual data
    // (native is null per §6, so it never shows origin counters).
    originCounters:
      caps.originCounters && post.originCounts ? spec.originCounters : "none",
    quoteEmbed: spec.quoteEmbed,
    // Articles open the reader pane instead of expanding inline (§3.1).
    click: post.type === "article" ? "reader-pane" : spec.click,
    bylineProfile: caps.bylineProfile,
    threads: caps.threads,
    interactBack: caps.interactBack,
  };
}

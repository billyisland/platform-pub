import { describe, it, expect } from "vitest";
import { resolveSpec, tierCaps, LEVEL_SPEC } from "./level-spec";
import type { Level, BiddabilityTier, Post } from "./types";

function makePost(over: Partial<Post> = {}): Post {
  return {
    id: "p1",
    version: "p1",
    origin: { protocol: "nostr", uri: "p1", sourceName: null },
    author: {
      id: null,
      accountId: null,
      displayName: null,
      handle: null,
      handleUri: null,
      avatar: null,
      pubkey: "pub-1",
      pipStatus: "known",
    },
    type: "note",
    accessMode: "free",
    body: { text: "x", html: null, title: null, summary: null, media: [], contentWarning: null, poll: null },
    inReplyTo: null,
    quotes: null,
    originCounts: null,
    scoresheet: { up: 0, down: 0, reposts: 0 },
    biddabilityTier: "A",
    publishedAt: 1,
    isContextOnly: false,
    isDeleted: false,
    isMuted: false,
    feedItemId: null,
    externalItemId: null,
    ...over,
  };
}

const native = makePost();
const external = (tier: BiddabilityTier) =>
  makePost({
    origin: { protocol: tier === "B" ? "activitypub" : "atproto", uri: "u", sourceName: "Src" },
    author: { ...native.author, pubkey: null, displayName: "Jane" },
    biddabilityTier: tier,
    originCounts: { like: 1, reply: 2, repost: 3 },
  });

const ALL_LEVELS: Level[] = ["focal", "feed", "thread-parent", "thread-reply", "quoted", "condensed"];

describe("LEVEL_SPEC table", () => {
  it("has a row for every level", () => {
    for (const lvl of ALL_LEVELS) expect(LEVEL_SPEC[lvl]).toBeTruthy();
  });
  it("text scale matches §4 (focal/feed 1.0, parent/reply .9, quoted/condensed .85)", () => {
    expect(LEVEL_SPEC.focal.textScale).toBe(1.0);
    expect(LEVEL_SPEC.feed.textScale).toBe(1.0);
    expect(LEVEL_SPEC["thread-parent"].textScale).toBe(0.9);
    expect(LEVEL_SPEC.quoted.textScale).toBe(0.85);
    expect(LEVEL_SPEC.condensed.textScale).toBe(0.85);
  });
});

describe("tierCaps — §7", () => {
  it("origin counters only for A/B", () => {
    expect(tierCaps("A").originCounters).toBe(true);
    expect(tierCaps("B").originCounters).toBe(true);
    expect(tierCaps("C").originCounters).toBe(false);
    expect(tierCaps("D").originCounters).toBe(false);
  });
  it("byline profile for A/B/C, plain text for D", () => {
    expect(tierCaps("C").bylineProfile).toBe(true);
    expect(tierCaps("D").bylineProfile).toBe(false);
  });
  it("tier D origin tag is source-name only", () => {
    expect(tierCaps("D").originTagSourceOnly).toBe(true);
    expect(tierCaps("A").originTagSourceOnly).toBe(false);
  });
});

describe("resolveSpec — quoted level", () => {
  const r = resolveSpec("quoted", "A", native);
  it("quoted shows byline+body only: no actions, no origin tag, no counters, stub quote", () => {
    expect(r.haus).toBe("none");
    expect(r.showOriginTag).toBe(false);
    expect(r.originCounters).toBe("none");
    expect(r.quoteEmbed).toBe("stub");
    expect(r.media).toBe("single-thumbnail");
    expect(r.insideHost).toBe(true);
  });
});

describe("resolveSpec — condensed level", () => {
  const r = resolveSpec("condensed", "A", native);
  it("condensed actions are numerals-only and counters inline", () => {
    expect(r.haus).toBe("numerals-only");
    expect(r.originCounters).toBe("none"); // native has no origin counters anyway
    expect(r.media).toBe("none");
    expect(r.body).toBe("one-line");
  });
});

describe("resolveSpec — all.haus available at every tier (§7)", () => {
  for (const t of ["A", "B", "C", "D"] as BiddabilityTier[]) {
    it(`tier ${t} keeps haus=full at feed level`, () => {
      expect(resolveSpec("feed", t, external(t)).haus).toBe("full");
    });
  }
});

describe("resolveSpec — report is native-only", () => {
  it("native feed shows report", () => {
    expect(resolveSpec("feed", "A", native).showReport).toBe(true);
  });
  it("external tier-A feed does NOT show report", () => {
    expect(resolveSpec("feed", "A", external("A")).showReport).toBe(false);
  });
});

describe("resolveSpec — origin counters gate by tier", () => {
  it("external A/B parent level shows static counters", () => {
    expect(resolveSpec("thread-parent", "B", external("B")).originCounters).toBe("static");
  });
  it("external C parent level has no counters", () => {
    expect(resolveSpec("thread-parent", "C", external("C")).originCounters).toBe("none");
  });
});

describe("resolveSpec — articles override click to reader-pane", () => {
  it("article at feed level → reader-pane (not expand-focal)", () => {
    expect(resolveSpec("feed", "A", makePost({ type: "article" })).click).toBe("reader-pane");
  });
  it("note at feed level → expand-focal", () => {
    expect(resolveSpec("feed", "A", native).click).toBe("expand-focal");
  });
});

// SOCIAL-PROOF-RESONANCE-ADR D7 — the glyph is level-gated AND data-gated.
describe("resonance glyph (D7)", () => {
  const banded = (band: number | null | undefined) =>
    makePost({ resonanceBand: band });

  it("shows at feed and thread-focal levels only", () => {
    for (const lvl of ALL_LEVELS) {
      const shown = resolveSpec(lvl, "A", banded(2)).showResonance;
      expect(shown).toBe(lvl === "feed" || lvl === "focal");
    }
  });

  it("shows for bands 1-3 and never for band 0", () => {
    expect(resolveSpec("feed", "A", banded(1)).showResonance).toBe(true);
    expect(resolveSpec("feed", "A", banded(2)).showResonance).toBe(true);
    expect(resolveSpec("feed", "A", banded(3)).showResonance).toBe(true);
    expect(resolveSpec("feed", "A", banded(0)).showResonance).toBe(false);
  });

  // Absence is not zero (D4): an unscored / rss / dark-nostr row carries no
  // band at all. It renders nothing, same as band 0, but must never throw or
  // be coerced into a band by a stray COALESCE upstream.
  it("treats a missing band as no glyph", () => {
    expect(resolveSpec("feed", "A", banded(null)).showResonance).toBe(false);
    expect(resolveSpec("feed", "A", banded(undefined)).showResonance).toBe(false);
    expect(resolveSpec("feed", "A", makePost()).showResonance).toBe(false);
  });

  // Resonance measures response, not identity — so it is NOT tier-masked the
  // way origin counters are. Silence for rss/email comes from no band being
  // computed, not from a mask here.
  it("is not tier-masked", () => {
    for (const tier of ["A", "B", "C", "D"] as BiddabilityTier[]) {
      expect(resolveSpec("feed", tier, banded(3)).showResonance).toBe(true);
    }
  });
});

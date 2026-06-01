"use client";

// =============================================================================
// /dev/postcard — PostCard six-level parity harness (UNIVERSAL-POST-ADR Phase 2).
//
// The Accept-check surface: one sample Post rendered at all six levels, across
// tier samples (A native / B fediverse / C rss / D anonymous / article), so the
// matrix deltas (text scale, indent, missing origin tag on quoted/condensed,
// numerals-only condensed actions, byline+body-only quoted, article→reader-pane
// click) are inspectable side by side. Dev-only; trivially deletable.
// =============================================================================

import React, { useState } from "react";
import { PostCard } from "../../../components/post/PostCard";
import type { CardContext } from "../../../components/post/chassis";
import type { Level, Post, BiddabilityTier } from "../../../lib/post/types";
import {
  PALETTES,
  type Brightness,
  type Density,
  type TextSize,
  TEXT_SIZE_PX,
} from "../../../components/workspace/tokens";
import { usePostCardFlag, setPostCardFlag } from "../../../lib/post/flags";

const LEVELS: Level[] = [
  "focal",
  "feed",
  "thread-parent",
  "thread-reply",
  "quoted",
  "condensed",
];

const SAMPLE_IMG =
  "https://images.unsplash.com/photo-1499750310107-5fef28a66643?w=900";

function basePost(over: Partial<Post>): Post {
  return {
    id: "sample-1",
    version: "sample-1",
    origin: { protocol: "nostr", uri: "sample-1", sourceName: null },
    author: {
      id: null,
      accountId: null,
      displayName: null,
      handle: null,
      handleUri: null,
      avatar: null,
      pubkey: null,
      pipStatus: "known",
    },
    type: "note",
    accessMode: "free",
    body: {
      text: "The quiet revolution in how we read is not about screens — it is about ownership. When the byline is the address, the reader follows the writer, not the platform. This is a longer note so the collapse-truncate at feed level and the single-line clamp at condensed level are both visible against the untruncated focal body. https://example.com/photo.jpg",
      html: null,
      title: null,
      summary: null,
      media: [{ type: "image", url: SAMPLE_IMG, alt: "sample" }],
      contentWarning: null,
      poll: null,
    },
    inReplyTo: null,
    quotes: "quoted-target-1",
    originCounts: null,
    scoresheet: { up: 7, down: 1, reposts: 2 },
    biddabilityTier: "A",
    publishedAt: Math.floor(Date.now() / 1000) - 3600,
    isContextOnly: false,
    isDeleted: false,
    isMuted: false,
    feedItemId: "fi-sample-1",
    quotedPreview: {
      author: "PRIOR VOICE",
      title: "On the address as identity",
      excerpt: "A short excerpt from the quoted post that the mini embed renders beneath the byline.",
    },
    ...over,
  };
}

const SAMPLES: Record<string, Post> = {
  "A · native note": basePost({}),
  "B · fediverse": basePost({
    origin: { protocol: "activitypub", uri: "https://mastodon.social/@x/123", sourceName: "mastodon.social" },
    author: { id: "ext-1", accountId: null, displayName: "Ada Fedi", handle: "@ada@mastodon.social", handleUri: "https://mastodon.social/@ada", avatar: null, pubkey: null, pipStatus: "partial" },
    biddabilityTier: "B",
    originCounts: { like: 12, reply: 3, repost: 5 },
    quotedPreview: undefined,
    quotes: null,
  }),
  "C · rss (author known)": basePost({
    origin: { protocol: "rss", uri: "https://blog.example.com/post", sourceName: "Example Blog" },
    author: { id: null, accountId: null, displayName: "Jane Writer", handle: null, handleUri: null, avatar: null, pubkey: null, pipStatus: "unknown" },
    biddabilityTier: "C",
    originCounts: null,
    quotes: null,
    quotedPreview: undefined,
  }),
  "D · rss (anonymous)": basePost({
    origin: { protocol: "rss", uri: "https://news.example.com/wire", sourceName: "Wire Service" },
    author: { id: null, accountId: null, displayName: null, handle: null, handleUri: null, avatar: null, pubkey: null, pipStatus: "unknown" },
    biddabilityTier: "D",
    originCounts: null,
    quotes: null,
    quotedPreview: undefined,
  }),
  "article": basePost({
    type: "article",
    accessMode: "gated",
    pricePence: 250,
    body: {
      text: null,
      html: null,
      title: "The Address Is the Audience",
      summary: "Why owning your byline changes the economics of reading, and what a reader-owned tab means for the people who write.",
      media: [{ type: "image", url: SAMPLE_IMG, alt: "cover" }],
      contentWarning: null,
      poll: null,
    },
    quotes: null,
    quotedPreview: undefined,
  }),
};

export default function PostCardHarness() {
  const [brightness, setBrightness] = useState<Brightness>("medium");
  const [density, setDensity] = useState<Density>("standard");
  const [textSize, setTextSize] = useState<TextSize>(3);
  const [sample, setSample] = useState<string>("A · native note");
  const flagOn = usePostCardFlag();

  const ctx: CardContext = {
    density,
    palette: PALETTES[brightness],
    bodyPx: TEXT_SIZE_PX[textSize],
  };
  const post = SAMPLES[sample];

  return (
    <div style={{ minHeight: "100vh", background: "#1A1A18", padding: 24 }}>
      <div style={{ maxWidth: 820, margin: "0 auto" }}>
        <h1 className="font-mono uppercase tracking-[0.06em]" style={{ color: "#E6E5E0", fontSize: 13, marginBottom: 16 }}>
          PostCard · six-level parity harness
        </h1>

        <div className="flex flex-wrap gap-2" style={{ marginBottom: 20 }}>
          <Selector label="Sample" value={sample} options={Object.keys(SAMPLES)} onChange={setSample} />
          <Selector label="Brightness" value={brightness} options={["primary", "medium", "dim"]} onChange={(v) => setBrightness(v as Brightness)} />
          <Selector label="Density" value={density} options={["compact", "standard", "full"]} onChange={(v) => setDensity(v as Density)} />
          <Selector label="Text" value={String(textSize)} options={["1", "2", "3", "4", "5"]} onChange={(v) => setTextSize(Number(v) as TextSize)} />
          <button
            type="button"
            onClick={() => setPostCardFlag(!flagOn)}
            className="font-mono uppercase tracking-[0.06em]"
            style={{ fontSize: 11, padding: "4px 10px", background: flagOn ? "#B5242A" : "#2A2A27", color: "#E6E5E0", border: "none", cursor: "pointer" }}
          >
            Workspace flag: {flagOn ? "ON" : "OFF"}
          </button>
        </div>

        <div className="flex flex-col gap-[40px]">
          {LEVELS.map((level) => (
            <div key={level}>
              <div className="font-mono uppercase tracking-[0.06em]" style={{ color: "#8A8880", fontSize: 11, marginBottom: 8 }}>
                {level} · tier {post.biddabilityTier as BiddabilityTier}
              </div>
              <div style={{ background: ctx.palette.interior, padding: 16 }}>
                <PostCard
                  post={post}
                  level={level}
                  ctx={ctx}
                  onExpand={() => console.log("expand", level)}
                  onCollapse={() => console.log("collapse", level)}
                  onReroot={() => console.log("reroot", level)}
                  onOpenReader={() => console.log("open reader", level)}
                  onReply={() => console.log("reply", level)}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Selector({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="font-mono uppercase tracking-[0.06em]" style={{ color: "#8A8880", fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}>
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ background: "#2A2A27", color: "#E6E5E0", padding: "4px 8px", fontSize: 11 }}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

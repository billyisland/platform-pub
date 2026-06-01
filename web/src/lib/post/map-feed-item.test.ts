import { describe, it, expect } from "vitest";
import { mapFeedItemToPost } from "./map-feed-item";
import type { ArticleEvent, NoteEvent, ExternalFeedItem } from "../ndk";

const article: ArticleEvent & { type: "article" } = {
  type: "article",
  id: "evt-article-1",
  feedItemId: "fi-1",
  authorId: "acct-1",
  pubkey: "pub-abc",
  dTag: "my-essay",
  title: "An Essay",
  summary: "A summary.",
  content: "Body text.",
  publishedAt: 1700000000,
  tags: [],
  isPaywalled: true,
  pricePence: 250,
  pipStatus: "known",
};

const note: NoteEvent = {
  type: "note",
  id: "evt-note-1",
  feedItemId: "fi-2",
  pubkey: "pub-def",
  content: "hello https://example.com/a.jpg",
  publishedAt: 1700000100,
  quotedEventId: "evt-quoted-9",
  replyToEventId: "evt-parent-7",
  pipStatus: "partial",
};

function ext(overrides: Partial<ExternalFeedItem>): ExternalFeedItem {
  return {
    type: "external",
    id: "ext-1",
    sourceProtocol: "atproto",
    sourceItemUri: "at://did:plc:x/app.bsky.feed.post/abc",
    authorName: "Jane",
    authorHandle: "jane.bsky.social",
    authorAvatarUrl: null,
    authorUri: "https://bsky.app/profile/jane.bsky.social",
    contentText: "external post",
    contentHtml: null,
    title: null,
    summary: null,
    likeCount: 5,
    replyCount: 2,
    repostCount: 1,
    media: [],
    publishedAt: 1700000200,
    sourceName: "Bluesky",
    sourceAvatar: null,
    pipStatus: "unknown",
    ...overrides,
  };
}

describe("mapFeedItemToPost — native", () => {
  it("maps an article, leaving displayName null (resolved at render)", () => {
    const p = mapFeedItemToPost(article);
    expect(p.type).toBe("article");
    expect(p.id).toBe("evt-article-1");
    expect(p.version).toBe("evt-article-1"); // native: event id is version + vote target
    expect(p.origin.protocol).toBe("nostr");
    expect(p.author.pubkey).toBe("pub-abc");
    expect(p.author.displayName).toBeNull();
    expect(p.accessMode).toBe("gated"); // isPaywalled
    expect(p.pricePence).toBe(250);
    expect(p.biddabilityTier).toBe("A");
    expect(p.originCounts).toBeNull(); // native (§6)
    expect(p.body.title).toBe("An Essay");
    expect(p.dTag).toBe("my-essay"); // Phase R: reader pane opens /article/<dTag>
  });

  it("maps a note, keeping full text and empty media (extracted at render)", () => {
    const p = mapFeedItemToPost(note);
    expect(p.type).toBe("note");
    expect(p.accessMode).toBe("free");
    expect(p.body.text).toContain("https://example.com/a.jpg");
    expect(p.body.media).toEqual([]);
    expect(p.quotes).toBe("evt-quoted-9");
    expect(p.inReplyTo).toBe("evt-parent-7");
    expect(p.author.pubkey).toBe("pub-def");
    expect(p.biddabilityTier).toBe("A");
  });

  it("leaves externalItemId null for native posts", () => {
    expect(mapFeedItemToPost(article).externalItemId).toBeNull();
    expect(mapFeedItemToPost(note).externalItemId).toBeNull();
  });
});

describe("mapFeedItemToPost — external tier derivation (§7 / migration 099)", () => {
  it("atproto / nostr_external → A", () => {
    expect(mapFeedItemToPost(ext({ sourceProtocol: "atproto" })).biddabilityTier).toBe("A");
    expect(
      mapFeedItemToPost(ext({ sourceProtocol: "nostr_external" })).biddabilityTier,
    ).toBe("A");
  });

  it("activitypub → B", () => {
    expect(
      mapFeedItemToPost(ext({ sourceProtocol: "activitypub" })).biddabilityTier,
    ).toBe("B");
  });

  it("rss/email with a known author → C", () => {
    expect(
      mapFeedItemToPost(
        ext({ sourceProtocol: "rss", authorName: "Some Blog", authorHandle: null, authorUri: null }),
      ).biddabilityTier,
    ).toBe("C");
  });

  it("rss/email with no author → D", () => {
    expect(
      mapFeedItemToPost(
        ext({ sourceProtocol: "rss", authorName: null, authorHandle: null, authorUri: null }),
      ).biddabilityTier,
    ).toBe("D");
  });

  it("prefers a server-persisted tier when present", () => {
    expect(
      mapFeedItemToPost(ext({ sourceProtocol: "rss", biddabilityTier: "A" })).biddabilityTier,
    ).toBe("A");
  });

  it("carries origin counts and identifies article-vs-note by title", () => {
    const p = mapFeedItemToPost(ext({ title: "Headline" }));
    expect(p.type).toBe("article");
    expect(p.originCounts).toEqual({ like: 5, reply: 2, repost: 1 });
    const n = mapFeedItemToPost(ext({ title: null }));
    expect(n.type).toBe("note");
  });

  it("surfaces externalItemId as the external_item id, distinct from post_id", () => {
    const p = mapFeedItemToPost(ext({ id: "ext-99", postId: "deadbeef".repeat(8) }));
    expect(p.id).toBe("deadbeef".repeat(8)); // post_id (the /thread key)
    expect(p.externalItemId).toBe("ext-99"); // the interact-back key
  });
});

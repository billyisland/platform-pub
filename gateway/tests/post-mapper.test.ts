import { describe, it, expect } from "vitest";
import { nostrTargetPostId, POST_SELECT } from "../src/lib/post-mapper.js";

// These guard the P1-2 fix: a native kind-1 reply/quote stores the target's raw
// nostr EVENT id, but a native article's deterministic post_id is minted from its
// naddr COORDINATE '30023:<pubkey>:<dtag>' (migration 098). Deriving straight from
// the event id therefore dangles the edge for article targets. The fix routes both
// nostr branches through nostrTargetPostId(), which resolves an article event id to
// its coordinate before deriving (falling back to the event id for note targets).
//
// The runtime behaviour was validated against the dev DB; these tests are a
// structural regression guard against silently reverting to the naive derivation.

describe("nostrTargetPostId (P1-2 article-coordinate resolution)", () => {
  const sql = nostrTargetPostId("n.reply_to_event_id");

  it("derives under the 'nostr' protocol", () => {
    expect(sql).toContain("feed_items_derive_post_id('nostr',");
  });

  it("resolves an article event id to its naddr coordinate", () => {
    expect(sql).toContain("'30023:'");
    expect(sql).toContain("FROM articles");
    expect(sql).toContain("JOIN accounts");
    // looks up the article by the stored event id
    expect(sql).toContain("nostr_event_id = n.reply_to_event_id");
  });

  it("falls back to the raw event id for non-article (note) targets", () => {
    expect(sql).toContain("COALESCE(");
    // the column appears both in the lookup predicate and as the COALESCE fallback
    const occurrences = sql.split("n.reply_to_event_id").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("guards the coordinate against null pubkey/dtag", () => {
    expect(sql).toContain("nostr_pubkey IS NOT NULL");
    expect(sql).toContain("nostr_d_tag IS NOT NULL");
  });
});

describe("POST_SELECT routes nostr reply/quote edges through the resolver", () => {
  it("does NOT derive the reply edge naively from the raw event id", () => {
    // the pre-fix form — its reintroduction is the regression we guard against
    expect(POST_SELECT).not.toContain(
      "feed_items_derive_post_id('nostr', n.reply_to_event_id)",
    );
    expect(POST_SELECT).not.toContain(
      "feed_items_derive_post_id('nostr', n.quoted_event_id)",
    );
  });

  it("resolves both the reply and quote nostr branches via the article coordinate", () => {
    expect(POST_SELECT).toContain("nostr_event_id = n.reply_to_event_id");
    expect(POST_SELECT).toContain("nostr_event_id = n.quoted_event_id");
  });

  it("leaves the external (non-nostr) reply/quote derivation unchanged", () => {
    expect(POST_SELECT).toContain(
      "feed_items_derive_post_id(fi.source_protocol::text, ei.source_reply_uri)",
    );
    expect(POST_SELECT).toContain(
      "feed_items_derive_post_id(fi.source_protocol::text, ei.source_quote_uri)",
    );
  });
});

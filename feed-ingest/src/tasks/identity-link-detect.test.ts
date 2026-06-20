import { describe, it, expect, vi } from "vitest";

// The task module imports the shared pool / logger at top level; the pure helpers
// under test don't touch the DB, so stub the modules so importing is offline.
vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {},
  withTransaction: vi.fn(),
}));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { registrableDomain, ownedDomains, domainMatchPairs, MAX_SOURCES_PER_DOMAIN } =
  await import("./identity-link-detect.js");

type Row = Parameters<typeof ownedDomains>[0];
const row = (p: Partial<Row> & Pick<Row, "source_id" | "protocol">): Row => ({
  source_uri: "",
  website: null,
  handle: null,
  ...p,
});

describe("registrableDomain", () => {
  it("takes the last two labels and strips www", () => {
    expect(registrableDomain("www.example.com")).toBe("example.com");
    expect(registrableDomain("blog.example.com")).toBe("example.com");
    expect(registrableDomain("EXAMPLE.COM")).toBe("example.com");
  });
  it("uses three labels for known multi-part suffixes", () => {
    expect(registrableDomain("alice.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("example.com.au")).toBe("example.com.au");
  });
  it("rejects IPs, single labels, and empty", () => {
    expect(registrableDomain("127.0.0.1")).toBeNull();
    expect(registrableDomain("localhost")).toBeNull();
    expect(registrableDomain("")).toBeNull();
    expect(registrableDomain(null)).toBeNull();
  });
});

describe("ownedDomains", () => {
  it("derives an RSS feed's host", () => {
    expect(
      ownedDomains(row({ source_id: "s", protocol: "rss", source_uri: "https://blog.alice.com/feed.xml" })),
    ).toEqual(["alice.com"]);
  });
  it("derives a custom atproto handle host but not a bsky.social handle", () => {
    expect(
      ownedDomains(row({ source_id: "s", protocol: "atproto", handle: "alice.com" })),
    ).toEqual(["alice.com"]);
    expect(
      ownedDomains(row({ source_id: "s", protocol: "atproto", handle: "alice.bsky.social" })),
    ).toEqual([]); // platform handle → denylisted
  });
  it("derives the author website for any protocol", () => {
    expect(
      ownedDomains(row({ source_id: "s", protocol: "activitypub", website: "https://alice.com" })),
    ).toEqual(["alice.com"]);
  });
  it("drops platform domains entirely", () => {
    expect(
      ownedDomains(row({ source_id: "s", protocol: "rss", source_uri: "https://alice.substack.com/feed" })),
    ).toEqual([]);
  });
  it("dedupes when feed host and website share a domain", () => {
    expect(
      ownedDomains(
        row({
          source_id: "s",
          protocol: "rss",
          source_uri: "https://www.alice.com/feed",
          website: "https://blog.alice.com",
        }),
      ),
    ).toEqual(["alice.com"]);
  });
});

describe("domainMatchPairs", () => {
  it("links two sources that share a custom domain", () => {
    const pairs = domainMatchPairs([
      row({ source_id: "a", protocol: "rss", source_uri: "https://alice.com/feed" }),
      row({ source_id: "b", protocol: "atproto", handle: "alice.com" }),
    ]);
    expect(pairs).toHaveLength(1);
    const [pa, pb] = pairs[0];
    expect(pa < pb).toBe(true); // ordered to satisfy the table CHECK
    expect(new Set(pairs[0])).toEqual(new Set(["a", "b"]));
  });

  it("does NOT link sources on a shared platform domain", () => {
    expect(
      domainMatchPairs([
        row({ source_id: "a", protocol: "rss", source_uri: "https://a.substack.com/feed" }),
        row({ source_id: "b", protocol: "rss", source_uri: "https://b.substack.com/feed" }),
      ]),
    ).toEqual([]);
  });

  it("count guard: a domain shared by more than MAX sources is treated as a platform", () => {
    const rows = Array.from({ length: MAX_SOURCES_PER_DOMAIN + 1 }, (_, i) =>
      row({ source_id: `s${i}`, protocol: "rss", source_uri: `https://blog${i}.shared.com/feed` }),
    );
    expect(domainMatchPairs(rows)).toEqual([]); // shared.com over the cap → dropped
  });

  it("links all pairs within a small same-domain cluster, deduped", () => {
    const pairs = domainMatchPairs([
      row({ source_id: "a", protocol: "rss", source_uri: "https://alice.com/feed" }),
      row({ source_id: "b", protocol: "atproto", handle: "alice.com" }),
      row({ source_id: "c", protocol: "activitypub", website: "https://alice.com" }),
    ]);
    expect(pairs).toHaveLength(3); // a-b, a-c, b-c
    const keys = new Set(pairs.map((p) => p.join("|")));
    expect(keys.size).toBe(3); // no dupes
  });

  it("ignores a domain owned by a single source", () => {
    expect(
      domainMatchPairs([row({ source_id: "a", protocol: "rss", source_uri: "https://alice.com/feed" })]),
    ).toEqual([]);
  });
});

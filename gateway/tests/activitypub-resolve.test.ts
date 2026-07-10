import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  extractFromMastodonUrl,
  extractFromThreadiverseUrl,
  resolveApSourceUri,
} from "../src/lib/activitypub-resolve.js";

// safeFetch is only exercised by resolveApSourceUri's webfinger path — the
// extract* functions are pure.
const mockSafeFetch = vi.fn();

vi.mock("@platform-pub/shared/lib/http-client.js", () => ({
  safeFetch: (...a: any[]) => mockSafeFetch(...a),
  pinnedWebSocketOptions: vi.fn(),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe("extractFromMastodonUrl", () => {
  it("extracts acct from /@user path", () => {
    const result = extractFromMastodonUrl(
      new URL("https://mastodon.social/@alice"),
    );
    expect(result).toEqual({ acct: "alice@mastodon.social" });
  });

  it("extracts acct from /@user@remote path", () => {
    const result = extractFromMastodonUrl(
      new URL("https://mastodon.social/@alice@other.host"),
    );
    expect(result).toEqual({ acct: "alice@other.host" });
  });

  it("extracts actorUri from /users/name path", () => {
    const result = extractFromMastodonUrl(
      new URL("https://mastodon.social/users/alice"),
    );
    expect(result).toEqual({
      actorUri: "https://mastodon.social/users/alice",
    });
  });

  it("returns null for unknown paths", () => {
    expect(
      extractFromMastodonUrl(new URL("https://mastodon.social/about")),
    ).toBeNull();
  });
});

describe("extractFromThreadiverseUrl", () => {
  it("extracts acct from Lemmy /c/community path", () => {
    const result = extractFromThreadiverseUrl(
      new URL("https://lemmy.world/c/technology"),
    );
    expect(result).toEqual({ acct: "technology@lemmy.world" });
  });

  it("extracts acct from Lemmy /u/user path", () => {
    const result = extractFromThreadiverseUrl(
      new URL("https://lemmy.ml/u/admin"),
    );
    expect(result).toEqual({ acct: "admin@lemmy.ml" });
  });

  it("extracts acct from Mbin /m/magazine path", () => {
    const result = extractFromThreadiverseUrl(
      new URL("https://fedia.io/m/linux"),
    );
    expect(result).toEqual({ acct: "linux@fedia.io" });
  });

  it("handles trailing slash", () => {
    const result = extractFromThreadiverseUrl(
      new URL("https://lemmy.world/c/technology/"),
    );
    expect(result).toEqual({ acct: "technology@lemmy.world" });
  });

  it("returns null for Lemmy post paths", () => {
    expect(
      extractFromThreadiverseUrl(new URL("https://lemmy.world/post/12345")),
    ).toBeNull();
  });

  it("returns null for non-threadiverse paths", () => {
    expect(
      extractFromThreadiverseUrl(new URL("https://example.com/about")),
    ).toBeNull();
  });

  it("returns null for Mastodon-style paths", () => {
    expect(
      extractFromThreadiverseUrl(new URL("https://mastodon.social/@alice")),
    ).toBeNull();
  });
});

// =============================================================================
// resolveApSourceUri — addSource's acct-tolerant AP sourceUri normalisation
// (RESOLVER-DISCOVERY-ADR §5.2 pick-path). Discovery candidates nominate
// canonical accts; this webfingers them to the actor URI addSource requires.
// =============================================================================

describe("resolveApSourceUri", () => {
  const ACTOR = "https://mastodon.social/users/alice";

  function webfingerOk(href: string | null) {
    mockSafeFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: JSON.stringify({
        links: href
          ? [{ rel: "self", type: "application/activity+json", href }]
          : [],
      }),
      headers: { get: () => null },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockSafeFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: "",
      headers: { get: () => null },
    });
  });

  it("passes an https actor URI through unchanged, without webfinger", async () => {
    expect(await resolveApSourceUri(ACTOR)).toBe(ACTOR);
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it("rejects a non-https URL", async () => {
    expect(await resolveApSourceUri("http://mastodon.social/users/alice")).toBeNull();
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it("webfingers an acct shape to its actor URI", async () => {
    webfingerOk(ACTOR);

    expect(await resolveApSourceUri("alice@mastodon.social")).toBe(ACTOR);
    expect(String(mockSafeFetch.mock.calls[0][0])).toContain(
      "https://mastodon.social/.well-known/webfinger?resource=acct%3Aalice%40mastodon.social",
    );
  });

  it("accepts a leading @ on the acct", async () => {
    webfingerOk(ACTOR);

    expect(await resolveApSourceUri("@alice@mastodon.social")).toBe(ACTOR);
  });

  it("returns null when webfinger finds no self link (the caller's 404)", async () => {
    webfingerOk(null);

    expect(await resolveApSourceUri("alice@mastodon.social")).toBeNull();
  });

  it("returns null when webfinger fails", async () => {
    mockSafeFetch.mockRejectedValue(new Error("connect ECONNREFUSED"));

    expect(await resolveApSourceUri("alice@mastodon.social")).toBeNull();
  });

  it("returns null when the resolved actor URI is not https", async () => {
    webfingerOk("http://mastodon.social/users/alice");

    expect(await resolveApSourceUri("alice@mastodon.social")).toBeNull();
  });

  it("rejects input that is neither URL nor acct", async () => {
    expect(await resolveApSourceUri("just a name")).toBeNull();
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });
});

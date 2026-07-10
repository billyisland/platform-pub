import { describe, it, expect, vi, beforeEach } from "vitest";

// =============================================================================
// Resolver orchestration harness (RESOLVER-DISCOVERY-ADR Phase 0, audit F8).
//
// Exercises resolve()/resolveAsync() through their public surface — resolve()
// plus getAsyncResult() over a faked resolver_async_results table — with every
// network chain mocked at its module seam. No live I/O. Covers:
//   - Phase A → Phase B assembly (local matches survive into the async row,
//     Phase B enriches them)
//   - discover / skipExternal / context gating matrix (invite/dm never
//     register discovery chains)
//   - incremental partial persistence order (catalog lands before network
//     branches)
//   - initiator scoping + missing-initiator fallback (Phase B skipped)
//   - per-chain failure isolation (one chain throwing never fails the resolve
//     or strands the row in 'pending')
//
// This harness is the safety net for the resolver.ts decomposition
// (CONSOLIDATED-TODO §8.5) and for the discovery-expansion phases that follow.
// =============================================================================

// --- chain mocks (deferred-deref pattern, per auth-middleware.test.ts) -------

const mockGetProfile = vi.fn();
const mockResolveHandle = vi.fn();
const mockSearchActors = vi.fn();
const mockExtractFromBskyUrl = vi.fn();
const mockIsDid = vi.fn();

vi.mock("../src/lib/atproto-resolve.js", () => ({
  getProfile: (...a: any[]) => mockGetProfile(...a),
  resolveHandle: (...a: any[]) => mockResolveHandle(...a),
  searchActors: (...a: any[]) => mockSearchActors(...a),
  extractFromBskyUrl: (...a: any[]) => mockExtractFromBskyUrl(...a),
  isDid: (...a: any[]) => mockIsDid(...a),
}));

const mockResolveWebFinger = vi.fn();
const mockFetchActorProfile = vi.fn();
const mockExtractFromMastodonUrl = vi.fn();
const mockExtractFromThreadiverseUrl = vi.fn();

vi.mock("../src/lib/activitypub-resolve.js", () => ({
  resolveWebFinger: (...a: any[]) => mockResolveWebFinger(...a),
  fetchActorProfile: (...a: any[]) => mockFetchActorProfile(...a),
  extractFromMastodonUrl: (...a: any[]) => mockExtractFromMastodonUrl(...a),
  extractFromThreadiverseUrl: (...a: any[]) =>
    mockExtractFromThreadiverseUrl(...a),
}));

const mockSearchCatalog = vi.fn();

vi.mock("../src/lib/discovery-catalog.js", () => ({
  searchCatalog: (...a: any[]) => mockSearchCatalog(...a),
}));

const mockFetchNostrProfile = vi.fn();
const mockSearchNostrProfiles = vi.fn();

vi.mock("../src/lib/nostr-search.js", () => ({
  fetchNostrProfile: (...a: any[]) => mockFetchNostrProfile(...a),
  searchNostrProfiles: (...a: any[]) => mockSearchNostrProfiles(...a),
  parseNostrProfileContent: vi.fn(),
}));

const mockSafeFetch = vi.fn();

vi.mock("@platform-pub/shared/lib/http-client.js", () => ({
  safeFetch: (...a: any[]) => mockSafeFetch(...a),
  pinnedWebSocketOptions: vi.fn(),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// --- fake resolver_async_results + accounts store ----------------------------

interface StoredRow {
  initiatorId: string;
  result: any;
}
const asyncRows = new Map<string, StoredRow>();
// Every upserted result snapshot, in write order — the persistence-order probe.
const storeLog: any[] = [];
const byUsername = new Map<string, any>();
const byPubkey = new Map<string, any>();
const byEmail = new Map<string, any>();
let fuzzyAccounts: any[] = [];

const mockQuery = vi.fn();

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (...a: any[]) => mockQuery(...a) },
}));

function fakeQuery(sql: string, params?: any[]) {
  if (sql.includes("INSERT INTO resolver_async_results")) {
    const [requestId, initiatorId, resultJson] = params!;
    const result = JSON.parse(resultJson);
    asyncRows.set(requestId, { initiatorId, result });
    storeLog.push(result);
    return Promise.resolve({ rows: [] });
  }
  if (sql.includes("DELETE FROM resolver_async_results")) {
    return Promise.resolve({ rows: [] });
  }
  if (sql.includes("FROM resolver_async_results")) {
    const [requestId, initiatorId] = params!;
    const row = asyncRows.get(requestId);
    return Promise.resolve({
      rows:
        row && row.initiatorId === initiatorId ? [{ result: row.result }] : [],
    });
  }
  if (sql.includes("WHERE username = $1")) {
    const row = byUsername.get(params![0]);
    return Promise.resolve({ rows: row ? [row] : [] });
  }
  if (sql.includes("WHERE nostr_pubkey = $1")) {
    const row = byPubkey.get(params![0]);
    return Promise.resolve({ rows: row ? [row] : [] });
  }
  if (sql.includes("WHERE email = $1")) {
    const row = byEmail.get(params![0]);
    return Promise.resolve({ rows: row ? [row] : [] });
  }
  if (sql.includes("ILIKE")) {
    return Promise.resolve({ rows: fuzzyAccounts });
  }
  return Promise.resolve({ rows: [] });
}

const { resolve, getAsyncResult } = await import("../src/lib/resolver.js");

const INITIATOR = "11111111-1111-4111-8111-111111111111";
const HEX_PUBKEY = "ab".repeat(32);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// resolveAsync is fire-and-forget from resolve(); wait for its final
// status:'complete' write to land in the fake table.
async function waitComplete(requestId: string, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = asyncRows.get(requestId);
    if (row?.result?.status === "complete") return row.result;
    await sleep(5);
  }
  throw new Error(`async result for ${requestId} never reached 'complete'`);
}

beforeEach(() => {
  vi.clearAllMocks();
  asyncRows.clear();
  storeLog.length = 0;
  byUsername.clear();
  byPubkey.clear();
  byEmail.clear();
  fuzzyAccounts = [];

  mockQuery.mockImplementation(fakeQuery);
  mockGetProfile.mockResolvedValue(null);
  mockResolveHandle.mockResolvedValue(null);
  mockSearchActors.mockResolvedValue([]);
  mockExtractFromBskyUrl.mockReturnValue(null);
  mockIsDid.mockImplementation((s: string) => s.startsWith("did:"));
  mockResolveWebFinger.mockResolvedValue(null);
  mockFetchActorProfile.mockResolvedValue(null);
  mockExtractFromMastodonUrl.mockReturnValue(null);
  mockExtractFromThreadiverseUrl.mockReturnValue(null);
  mockSearchCatalog.mockReturnValue([]);
  mockFetchNostrProfile.mockResolvedValue(null);
  mockSearchNostrProfiles.mockResolvedValue([]);
  mockSafeFetch.mockResolvedValue({
    ok: false,
    status: 404,
    text: "",
    headers: { get: () => null },
  });
});

// =============================================================================
// Phase A → Phase B assembly
// =============================================================================

describe("Phase A → Phase B assembly", () => {
  it("hex pubkey: Phase A returns native + external match, Phase B enriches in place", async () => {
    byPubkey.set(HEX_PUBKEY, {
      id: "acc-1",
      username: "guardian",
      display_name: "The Guardian",
      avatar_blossom_url: null,
    });
    mockFetchNostrProfile.mockResolvedValue({
      displayName: "Guardian on Nostr",
      about: "News.",
      picture: "https://example.com/g.png",
    });

    const res = await resolve(HEX_PUBKEY, "general", INITIATOR);

    expect(res.inputType).toBe("hex_pubkey");
    expect(res.status).toBe("pending");
    expect(res.requestId).toBeDefined();
    expect(res.pendingResolutions).toEqual(["nostr_profile"]);
    // Phase A: native account + exact external source, immediately.
    expect(res.matches).toHaveLength(2);
    expect(res.matches[0].type).toBe("native_account");
    expect(res.matches[0].account?.username).toBe("guardian");
    expect(res.matches[1].externalSource?.protocol).toBe("nostr_external");
    expect(res.matches[1].confidence).toBe("exact");

    // Seed row is stored before Phase B completes.
    expect(storeLog[0].status).toBe("pending");

    // Phase B enriches the external match with kind-0 metadata.
    const final = await waitComplete(res.requestId!);
    const ext = final.matches.find(
      (m: any) => m.externalSource?.protocol === "nostr_external",
    );
    expect(ext.externalSource.displayName).toBe("Guardian on Nostr");
    expect(ext.externalSource.description).toBe("News.");
    expect(ext.externalSource.avatar).toBe("https://example.com/g.png");
    // The Phase A native match survives into the final row.
    expect(
      final.matches.some((m: any) => m.account?.username === "guardian"),
    ).toBe(true);
  });

  it("missing initiator: Phase B is skipped entirely, Phase A returned complete", async () => {
    const res = await resolve("someone.bsky.social", "general", undefined);

    expect(res.inputType).toBe("bluesky_handle");
    expect(res.status).toBe("complete");
    expect(res.requestId).toBeUndefined();
    await sleep(20);
    expect(mockGetProfile).not.toHaveBeenCalled();
    expect(storeLog).toHaveLength(0);
  });
});

// =============================================================================
// Gating matrix — discover / skipExternal / context
// =============================================================================

describe("discovery gating matrix", () => {
  const CATALOG_HIT = [
    {
      feedUrl: "https://www.theguardian.com/rss",
      title: "The Guardian",
      description: "News",
    },
  ];
  const BSKY_HIT = [
    {
      did: "did:plc:guardian",
      handle: "guardian.bsky.social",
      displayName: "The Guardian",
    },
  ];
  const NOSTR_HIT = [{ pubkey: HEX_PUBKEY, displayName: "guardian" }];

  it("free_text + discover + subscribe: all three discovery branches run and land", async () => {
    mockSearchCatalog.mockReturnValue(CATALOG_HIT);
    mockSearchActors.mockResolvedValue(BSKY_HIT);
    mockSearchNostrProfiles.mockResolvedValue(NOSTR_HIT);

    const res = await resolve("the guardian news", "subscribe", INITIATOR, true);

    expect(res.inputType).toBe("free_text");
    expect(res.status).toBe("pending");
    expect(res.pendingResolutions).toEqual([
      "catalog_discovery",
      "bluesky_discovery",
      "nostr_discovery",
    ]);

    const final = await waitComplete(res.requestId!);
    const protocols = final.matches.map(
      (m: any) => m.externalSource?.protocol ?? m.type,
    );
    expect(protocols).toContain("rss_feed");
    expect(protocols).toContain("atproto");
    expect(protocols).toContain("nostr_external");
    // Discovery nominations are speculative, never exact.
    for (const m of final.matches) {
      expect(m.confidence).toBe("speculative");
    }
  });

  it("free_text without discover: no discovery chains, resolve completes in Phase A", async () => {
    const res = await resolve("the guardian news", "subscribe", INITIATOR);

    expect(res.status).toBe("complete");
    expect(res.requestId).toBeUndefined();
    await sleep(20);
    expect(mockSearchCatalog).not.toHaveBeenCalled();
    expect(mockSearchActors).not.toHaveBeenCalled();
    expect(mockSearchNostrProfiles).not.toHaveBeenCalled();
  });

  it.each(["invite", "dm"] as const)(
    "%s context never registers discovery chains even with discover=true",
    async (context) => {
      mockSearchCatalog.mockReturnValue(CATALOG_HIT);

      const res = await resolve("the guardian news", context, INITIATOR, true);

      expect(res.status).toBe("complete");
      expect(res.requestId).toBeUndefined();
      await sleep(20);
      expect(mockSearchCatalog).not.toHaveBeenCalled();
      expect(mockSearchActors).not.toHaveBeenCalled();
      expect(mockSearchNostrProfiles).not.toHaveBeenCalled();
    },
  );

  it("platform_username with an exact hit short-circuits discovery", async () => {
    byUsername.set("guardian", {
      id: "acc-1",
      username: "guardian",
      display_name: "The Guardian",
      avatar_blossom_url: null,
    });

    const res = await resolve("guardian", "general", INITIATOR, true);

    expect(res.status).toBe("complete");
    expect(res.requestId).toBeUndefined();
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0].confidence).toBe("exact");
    await sleep(20);
    expect(mockSearchActors).not.toHaveBeenCalled();
  });

  it("platform_username with no exact hit falls back to discovery", async () => {
    const res = await resolve("guardian", "general", INITIATOR, true);

    expect(res.status).toBe("pending");
    expect(res.pendingResolutions).toEqual([
      "catalog_discovery",
      "bluesky_discovery",
      "nostr_discovery",
    ]);
    await waitComplete(res.requestId!);
  });

  it("ambiguous_at in invite context: NIP-05 runs (can find native accounts), WebFinger does not", async () => {
    const res = await resolve("someone@example.com", "invite", INITIATOR);

    expect(res.inputType).toBe("ambiguous_at");
    expect(res.pendingResolutions).toEqual(["nip05_resolution"]);

    const final = await waitComplete(res.requestId!);
    expect(final.status).toBe("complete");
    expect(mockResolveWebFinger).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Incremental partial persistence order
// =============================================================================

describe("incremental partial persistence", () => {
  it("catalog partial lands before the network discovery branches", async () => {
    mockSearchCatalog.mockReturnValue([
      { feedUrl: "https://g.example/rss", title: "Guardian" },
    ]);
    mockSearchActors.mockImplementation(async () => {
      await sleep(20);
      return [{ did: "did:plc:g", handle: "g.bsky.social" }];
    });

    const res = await resolve("the guardian news", "general", INITIATOR, true);
    await waitComplete(res.requestId!);

    const hasRss = (snap: any) =>
      snap.matches.some((m: any) => m.type === "rss_feed");
    const hasAtproto = (snap: any) =>
      snap.matches.some((m: any) => m.externalSource?.protocol === "atproto");

    const firstRss = storeLog.findIndex(hasRss);
    const firstAtproto = storeLog.findIndex(hasAtproto);
    expect(firstRss).toBeGreaterThanOrEqual(0);
    expect(firstAtproto).toBeGreaterThan(firstRss);
    // The catalog partial is still 'pending' — a poll mid-flight sees it.
    expect(storeLog[firstRss].status).toBe("pending");
    // The last write is the complete row carrying everything.
    const last = storeLog[storeLog.length - 1];
    expect(last.status).toBe("complete");
    expect(hasRss(last) && hasAtproto(last)).toBe(true);
  });
});

// =============================================================================
// Initiator scoping
// =============================================================================

describe("initiator scoping", () => {
  it("getAsyncResult returns the row only to its initiator", async () => {
    const res = await resolve(HEX_PUBKEY, "general", INITIATOR);
    await waitComplete(res.requestId!);

    const other = await getAsyncResult(
      res.requestId!,
      "22222222-2222-4222-8222-222222222222",
    );
    expect(other).toBeNull();

    const mine = await getAsyncResult(res.requestId!, INITIATOR);
    expect(mine?.status).toBe("complete");
  });

  it("rejects non-UUID request ids without touching the DB", async () => {
    const result = await getAsyncResult("not-a-uuid", INITIATOR);
    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Per-chain failure isolation
// =============================================================================

describe("per-chain failure isolation", () => {
  it("a throwing discovery branch never fails the resolve or drops its siblings", async () => {
    mockSearchActors.mockRejectedValue(new Error("bsky appview down"));
    mockSearchNostrProfiles.mockResolvedValue([
      { pubkey: HEX_PUBKEY, displayName: "guardian" },
    ]);

    const res = await resolve("the guardian news", "general", INITIATOR, true);
    const final = await waitComplete(res.requestId!);

    expect(final.status).toBe("complete");
    expect(
      final.matches.some(
        (m: any) => m.externalSource?.protocol === "nostr_external",
      ),
    ).toBe(true);
    expect(
      final.matches.some((m: any) => m.externalSource?.protocol === "atproto"),
    ).toBe(false);
  });

  it("a throwing profile chain still lands a complete (empty) result", async () => {
    mockGetProfile.mockRejectedValue(new Error("plc directory down"));

    const res = await resolve("did:plc:abcdef", "general", INITIATOR);
    const final = await waitComplete(res.requestId!);

    expect(final.status).toBe("complete");
    expect(final.matches).toHaveLength(0);
  });

  it("a throwing enrichment chain keeps the Phase A matches intact", async () => {
    mockFetchNostrProfile.mockRejectedValue(new Error("relay refused"));

    const res = await resolve(HEX_PUBKEY, "general", INITIATOR);
    const final = await waitComplete(res.requestId!);

    expect(final.status).toBe("complete");
    const ext = final.matches.find(
      (m: any) => m.externalSource?.protocol === "nostr_external",
    );
    expect(ext).toBeDefined();
    expect(ext.confidence).toBe("exact");
  });
});

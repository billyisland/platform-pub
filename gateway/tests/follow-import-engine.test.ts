import { describe, it, expect, vi, beforeEach } from "vitest";

// =============================================================================
// FOLLOW-GRAPH-IMPORT-ADR §11.3 — engine coverage: batching + restartable
// resume (kill mid-run, re-sweep), idempotent re-import (DUPLICATE → skipped),
// per-source failure never failing the run, the >50-source sampled-volume
// default, and the mid-run feed-deletion abort.
//
// The engine's DB surface is mocked with a small SQL-pattern router; addSource
// is mocked so the test asserts the exact call contract (skipProbe +
// enqueueRunAt) without dragging in the real write path.
// =============================================================================

const mockPoolQuery = vi.fn();
vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
    connect: vi.fn(),
  },
  withTransaction: vi.fn(),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const addSource = vi.fn();
vi.mock("../src/routes/feeds/sources.js", () => ({
  addSource: (...args: unknown[]) => addSource(...args),
}));

// Graph readers aren't exercised by the sweep — mock them so the module graph
// stays inert (no sockets, no env reads).
vi.mock("../src/lib/atproto-resolve.js", () => ({
  getProfile: vi.fn(),
  getFollows: vi.fn(),
}));
vi.mock("../src/lib/nostr-relay.js", () => ({
  fetchNostrContacts: vi.fn(),
}));
vi.mock("../src/lib/nostr-search.js", () => ({
  getDefaultProfileRelays: vi.fn(() => []),
}));
vi.mock("@platform-pub/shared/lib/http-client.js", () => ({
  safeFetch: vi.fn(),
}));

import { runFollowImportSweep } from "../src/lib/follow-import.js";

const RUN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const FEED_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const ACCOUNT_ID = "cccccccc-0000-4000-8000-000000000003";

interface FakeRun {
  id: string;
  account_id: string;
  protocol: string;
  feed_id: string;
  identities: Array<{ uri: string; displayName?: string }>;
  cursor: number;
  imported: number;
  skipped: number;
  failed: number;
}

function makeRun(overrides: Partial<FakeRun> = {}): FakeRun {
  return {
    id: RUN_ID,
    account_id: ACCOUNT_ID,
    protocol: "atproto",
    feed_id: FEED_ID,
    identities: [
      { uri: "did:plc:one", displayName: "@one" },
      { uri: "did:plc:two", displayName: "@two" },
      { uri: "did:plc:three", displayName: "@three" },
    ],
    cursor: 0,
    imported: 0,
    skipped: 0,
    failed: 0,
    ...overrides,
  };
}

// Route pool.query calls by SQL shape. Claim returns the run once, then
// nothing (the sweep's loop-until-empty).
function primePool(run: FakeRun, opts: { counterRowCount?: number } = {}) {
  let claimed = false;
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  mockPoolQuery.mockImplementation((sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes("SET status = 'running'")) {
      if (claimed) return Promise.resolve({ rows: [], rowCount: 0 });
      claimed = true;
      return Promise.resolve({ rows: [run], rowCount: 1 });
    }
    if (sql.includes("SET imported =")) {
      return Promise.resolve({
        rows: [],
        rowCount: opts.counterRowCount ?? 1,
      });
    }
    return Promise.resolve({ rows: [], rowCount: 1 });
  });
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FOLLOW_IMPORT_ENABLED = "1";
});

describe("runFollowImportSweep", () => {
  it("does nothing when the master switch is off", async () => {
    process.env.FOLLOW_IMPORT_ENABLED = "0";
    await runFollowImportSweep();
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("imports every identity through addSource with the D6/§6.4b contract", async () => {
    const run = makeRun();
    const calls = primePool(run);
    addSource.mockResolvedValue({
      source: {},
      ensured: { externalSourceId: "xs-1", subscriptionId: "sub-1" },
    });

    await runFollowImportSweep();

    expect(addSource).toHaveBeenCalledTimes(3);
    const [feedId, ownerId, input, opts] = addSource.mock.calls[0];
    expect(feedId).toBe(FEED_ID);
    expect(ownerId).toBe(ACCOUNT_ID);
    expect(input).toMatchObject({
      sourceType: "external_source",
      protocol: "atproto",
      sourceUri: "did:plc:one",
      displayName: "@one",
    });
    // The liveness probe is skipped (graph membership is liveness evidence)
    // and the ingest job is deferred (stampede brake).
    expect(opts.skipProbe).toBe(true);
    expect(opts.enqueueRunAt).toBeInstanceOf(Date);
    expect(opts.enqueueRunAt.getTime()).toBeGreaterThan(Date.now());

    // Counters persisted, run marked done, poll stagger applied to the
    // freshly minted sources.
    const counterCall = calls.find((c) => c.sql.includes("SET imported ="));
    expect(counterCall!.params).toEqual([RUN_ID, 3, 0, 0, 3]);
    expect(calls.some((c) => c.sql.includes("SET status = 'done'"))).toBe(true);
    const stagger = calls.find((c) =>
      c.sql.includes("UPDATE external_sources"),
    );
    expect(stagger).toBeDefined();
    expect(stagger!.sql).toContain("last_fetched_at IS NULL");
    // 3 identities ≤ the sampled-volume threshold — no bulk weight rewrite.
    expect(calls.some((c) => c.sql.includes("UPDATE feed_sources"))).toBe(
      false,
    );
  });

  it("counts DUPLICATE as skipped and other failures as failed, never failing the run", async () => {
    const run = makeRun();
    const calls = primePool(run);
    addSource
      .mockResolvedValueOnce({
        source: {},
        ensured: { externalSourceId: "xs-1", subscriptionId: "s1" },
      })
      .mockRejectedValueOnce(
        Object.assign(new Error("DUPLICATE"), { code: "DUPLICATE" }),
      )
      .mockRejectedValueOnce(new Error("network down"));

    await runFollowImportSweep();

    const counterCall = calls.find((c) => c.sql.includes("SET imported ="));
    // imported=1, skipped=1, failed=1, cursor=3
    expect(counterCall!.params).toEqual([RUN_ID, 1, 1, 1, 3]);
    expect(calls.some((c) => c.sql.includes("SET status = 'done'"))).toBe(true);
    expect(calls.some((c) => c.sql.includes("SET status = 'failed'"))).toBe(
      false,
    );
  });

  it("resumes a killed run from its cursor without re-adding earlier identities", async () => {
    // A restart mid-run leaves status='running', cursor=2, counters at 2 —
    // the re-sweep claims it and processes only the tail.
    const run = makeRun({ cursor: 2, imported: 2 });
    const calls = primePool(run);
    addSource.mockResolvedValue({
      source: {},
      ensured: { externalSourceId: "xs-3", subscriptionId: "s3" },
    });

    await runFollowImportSweep();

    expect(addSource).toHaveBeenCalledTimes(1);
    expect(addSource.mock.calls[0][2]).toMatchObject({
      sourceUri: "did:plc:three",
    });
    const counterCall = calls.find((c) => c.sql.includes("SET imported ="));
    expect(counterCall!.params).toEqual([RUN_ID, 3, 0, 0, 3]);
    expect(calls.some((c) => c.sql.includes("SET status = 'done'"))).toBe(true);
  });

  it("completes a run already past its last identity (killed between batch and done)", async () => {
    const run = makeRun({ cursor: 3, imported: 3 });
    const calls = primePool(run);

    await runFollowImportSweep();

    expect(addSource).not.toHaveBeenCalled();
    expect(calls.some((c) => c.sql.includes("SET status = 'done'"))).toBe(true);
  });

  it("stops when the run row vanishes mid-run (feed deleted, cascade)", async () => {
    const run = makeRun();
    const calls = primePool(run, { counterRowCount: 0 });
    addSource.mockResolvedValue({ source: {}, ensured: null });

    await runFollowImportSweep();

    expect(calls.some((c) => c.sql.includes("SET status = 'done'"))).toBe(
      false,
    );
    expect(
      calls.some((c) => c.sql.includes("feed_import_bindings")),
    ).toBe(false);
  });

  it("applies the sampled-volume default above the threshold", async () => {
    const identities = Array.from({ length: 60 }, (_, i) => ({
      uri: `did:plc:n${i}`,
    }));
    const run = makeRun({ identities });
    const calls = primePool(run);
    addSource.mockResolvedValue({
      source: {},
      ensured: { externalSourceId: "xs", subscriptionId: "s" },
    });

    await runFollowImportSweep();

    expect(addSource).toHaveBeenCalledTimes(60);
    const volume = calls.find((c) => c.sql.includes("UPDATE feed_sources"));
    expect(volume).toBeDefined();
    // Only rows still at the 4.0 show-everything default are rewritten.
    expect(volume!.sql).toContain("weight = 4.0");
    expect(volume!.params).toEqual([FEED_ID, 1.0]);
    // Batched at 25: counter updates at cursor 25, 50, 60.
    const cursors = calls
      .filter((c) => c.sql.includes("SET imported ="))
      .map((c) => c.params[4]);
    expect(cursors).toEqual([25, 50, 60]);
  });

  it("keeps the liveness probe ON for rss runs (OPML, the D6 exception) and reports dead entries as failed", async () => {
    const run = makeRun({
      protocol: "rss",
      identities: [
        { uri: "https://alive.example/rss", displayName: "Alive" },
        { uri: "https://dead.example/rss", displayName: "Dead" },
      ],
    });
    const calls = primePool(run);
    addSource
      .mockResolvedValueOnce({
        source: {},
        ensured: { externalSourceId: "xs-1", subscriptionId: "s1" },
      })
      // What addSource throws when verifySourceLiveness fails the probe.
      .mockRejectedValueOnce(
        Object.assign(new Error("The feed URL could not be fetched"), {
          code: "SOURCE_UNREACHABLE",
        }),
      );

    await runFollowImportSweep();

    expect(addSource).toHaveBeenCalledTimes(2);
    // rss = probe on (reader exports rot); every other protocol skips it.
    expect(addSource.mock.calls[0][3].skipProbe).toBe(false);
    const counterCall = calls.find((c) => c.sql.includes("SET imported ="));
    // imported=1, skipped=0, failed=1 (the dead entry, reported not silent)
    expect(counterCall!.params).toEqual([RUN_ID, 1, 0, 1, 2]);
    expect(calls.some((c) => c.sql.includes("SET status = 'done'"))).toBe(true);
  });

  it("marks the run failed when processing throws wholesale", async () => {
    const run = makeRun({ identities: "junk" as never });
    // Array.isArray guard turns junk into [] → completes as done; instead
    // simulate a DB failure on the counter update path by making the stagger
    // update throw.
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    let claimed = false;
    mockPoolQuery.mockImplementation((sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("SET status = 'running'")) {
        if (claimed) return Promise.resolve({ rows: [], rowCount: 0 });
        claimed = true;
        return Promise.resolve({
          rows: [makeRun()],
          rowCount: 1,
        });
      }
      if (sql.includes("UPDATE external_sources"))
        return Promise.reject(new Error("db exploded"));
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    addSource.mockResolvedValue({
      source: {},
      ensured: { externalSourceId: "xs", subscriptionId: "s" },
    });

    await runFollowImportSweep();

    const failed = calls.find((c) => c.sql.includes("SET status = 'failed'"));
    expect(failed).toBeDefined();
    expect(failed!.params![1]).toBe("db exploded");
    void run;
  });
});

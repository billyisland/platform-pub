import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// POST /workspace/feeds/:id/merge — the starter-template guard.
//
// Merge is asymmetric and destructive: it moves the SOURCE feed's sources into
// the target and then DELETEs the source feed. A feed flagged
// is_starter_template is the row seedStarterFeeds clones for every new account,
// so merging one away destroys new-user seeding platform-wide — silently, and
// only visibly on the NEXT signup (which then falls through to the client's
// empty "Founder's feed" mint). This happened on prod 2026-07-22.
//
// The contract under test:
//   - source flagged            → 409, and NOTHING is written (no source move,
//                                 no saves copy, and above all no DELETE FROM
//                                 feeds — the whole point).
//   - target flagged            → allowed (the template SURVIVES a merge into
//                                 it; it only grows).
//   - neither flagged           → the ordinary merge still runs end to end.
// =============================================================================

let txCalls: Array<{ sql: string; params: unknown[] }> = [];
let feedRows: Array<Record<string, unknown>> = [];

const mockPoolQuery = vi.fn();

function scriptedQuery(sql: string, params: unknown[] = []) {
  txCalls.push({ sql, params });
  if (sql.includes("FROM feeds WHERE id = ANY"))
    return Promise.resolve({ rows: feedRows, rowCount: feedRows.length });
  return Promise.resolve({ rows: [], rowCount: 1 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  withTransaction: (cb: (client: { query: typeof scriptedQuery }) => Promise<unknown>) =>
    cb({ query: scriptedQuery }),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const OWNER = "00000000-0000-4000-8000-00000000aaaa";
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: OWNER };
  },
}));

import { registerFeedCrudRoutes } from "../src/routes/feeds/crud.js";

const TARGET = "11111111-0000-4000-8000-000000000001";
const SOURCE = "22222222-0000-4000-8000-000000000002";

const LOADED_FEED = {
  id: TARGET,
  name: "Target",
  appearance: {},
  sort_rank: 1,
  hidden: false,
  created_at: new Date(),
  updated_at: new Date(),
  source_count: 3,
  from_starter: false,
};

function feed(id: string, isTemplate: boolean) {
  return { id, owner_id: OWNER, is_starter_template: isTemplate };
}

async function buildApp() {
  const app = Fastify();
  registerFeedCrudRoutes(app);
  await app.ready();
  return app;
}

async function merge() {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: `/feeds/${TARGET}/merge`,
    payload: { sourceFeedId: SOURCE },
  });
  await app.close();
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  txCalls = [];
  // loadFeed (step 6's re-read) — always resolves.
  mockPoolQuery.mockImplementation(() =>
    Promise.resolve({ rows: [LOADED_FEED], rowCount: 1 }),
  );
});

describe("feed merge — starter-template guard", () => {
  it("refuses to merge a starter template away, and writes nothing", async () => {
    feedRows = [feed(TARGET, false), feed(SOURCE, true)];

    const res = await merge();

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: "starter_template_source",
      message: expect.stringContaining("starter template"),
    });
    // The guard must fire BEFORE any mutation — most of all the feed DELETE.
    expect(txCalls.some((c) => c.sql.includes("DELETE FROM feeds"))).toBe(false);
    expect(
      txCalls.some((c) => c.sql.includes("UPDATE feed_sources SET feed_id")),
    ).toBe(false);
    expect(
      txCalls.some((c) => c.sql.includes("DELETE FROM feed_sources")),
    ).toBe(false);
    expect(txCalls.some((c) => c.sql.includes("feed_saves"))).toBe(false);
  });

  it("allows merging INTO a starter template (the template survives and grows)", async () => {
    feedRows = [feed(TARGET, true), feed(SOURCE, false)];

    const res = await merge();

    expect(res.statusCode).toBe(200);
    expect(txCalls.some((c) => c.sql.includes("DELETE FROM feeds"))).toBe(true);
  });

  it("leaves an ordinary merge untouched", async () => {
    feedRows = [feed(TARGET, false), feed(SOURCE, false)];

    const res = await merge();

    expect(res.statusCode).toBe(200);
    const deleteFeed = txCalls.find((c) => c.sql.includes("DELETE FROM feeds"));
    expect(deleteFeed?.params).toEqual([SOURCE]);
    expect(
      txCalls.some((c) => c.sql.includes("UPDATE feed_sources SET feed_id")),
    ).toBe(true);
  });
});

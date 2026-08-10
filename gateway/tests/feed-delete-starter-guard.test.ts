import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// DELETE /workspace/feeds/:id — the starter-template guard (§0l.2).
//
// The merge path has refused to destroy a flagged feed since the 2026-07-22
// prod incident; DELETE was the identical global damage by another route, and
// went unguarded until 2026-08-10. A feed flagged is_starter_template is the
// row seedStarterFeeds clones for every new account, so deleting the last one
// silently ends new-user seeding platform-wide — visible only on the NEXT
// signup, which then falls through to the client's empty "Founder's feed" mint.
//
// The contract under test:
//   - flagged                → 409, and NOTHING is torn down. Ordering is the
//                              substance here, not decoration: the route calls
//                              removeSource per external source BEFORE the
//                              DELETE, so a guard placed after it would answer
//                              409 having already stripped the template of the
//                              subscriptions its clones depend on.
//   - unflagged              → 204, and the DELETE still carries the flag
//                              predicate (the fail-closed backstop).
//   - flagged mid-flight     → the backstop refuses, and reports 409 rather
//                              than a misleading 404.
//   - genuinely absent       → still 404.
//   - only feed              → the pre-existing 409 wins, before either.
// =============================================================================

let calls: Array<{ sql: string; params: unknown[] }> = [];
let feedCount = 3;
let flagReads: Array<boolean | null> = [false];
let externalSources: Array<{ id: string }> = [];
let deleteRowCount = 1;

const removeSourceMock = vi.fn(() => Promise.resolve(undefined));

function nextFlag(): boolean | null {
  // Shift while more than one remains, so a single-element script is a constant
  // and a two-element one models "unflagged at the guard, flagged by the write".
  return flagReads.length > 1 ? (flagReads.shift() as boolean | null) : flagReads[0];
}

function scripted(sql: string, params: unknown[] = []) {
  calls.push({ sql, params });
  // loadFeed — the only SELECT carrying the derived source_count column.
  if (sql.includes("source_count"))
    return Promise.resolve({
      rows: [
        {
          id: FEED,
          name: "A feed",
          appearance: {},
          sort_rank: 1,
          hidden: false,
          created_at: new Date(),
          updated_at: new Date(),
          source_count: 2,
          from_starter: false,
        },
      ],
      rowCount: 1,
    });
  if (sql.includes("COUNT(*) AS count FROM feeds"))
    return Promise.resolve({ rows: [{ count: String(feedCount) }], rowCount: 1 });
  if (sql.includes("SELECT is_starter_template FROM feeds")) {
    const flag = nextFlag();
    return Promise.resolve({
      rows: flag === null ? [] : [{ is_starter_template: flag }],
      rowCount: flag === null ? 0 : 1,
    });
  }
  if (sql.includes("FROM feed_sources"))
    return Promise.resolve({
      rows: externalSources,
      rowCount: externalSources.length,
    });
  if (sql.includes("DELETE FROM feeds"))
    return Promise.resolve({ rows: [], rowCount: deleteRowCount });
  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, params: unknown[]) => scripted(sql, params) },
  withTransaction: (cb: (c: { query: typeof scripted }) => Promise<unknown>) =>
    cb({ query: scripted }),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/routes/feeds/sources.js", () => ({
  removeSource: (...args: unknown[]) => removeSourceMock(...(args as [])),
}));

const OWNER = "00000000-0000-4000-8000-00000000aaaa";
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: OWNER };
  },
}));

import { registerFeedCrudRoutes } from "../src/routes/feeds/crud.js";

const FEED = "11111111-0000-4000-8000-000000000001";

async function del() {
  const app = Fastify();
  registerFeedCrudRoutes(app);
  await app.ready();
  const res = await app.inject({ method: "DELETE", url: `/feeds/${FEED}` });
  await app.close();
  return res;
}

const deletedFeed = () => calls.some((c) => c.sql.includes("DELETE FROM feeds"));

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  feedCount = 3;
  flagReads = [false];
  externalSources = [{ id: "aaaaaaaa-0000-4000-8000-00000000000a" }];
  deleteRowCount = 1;
});

describe("DELETE /feeds/:id — starter-template guard", () => {
  it("refuses to delete a starter template, and tears nothing down", async () => {
    flagReads = [true];

    const res = await del();

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: "starter_template_source",
      message: expect.stringContaining("starter template"),
    });
    // The whole point: no DELETE, and — because the route strips external
    // subscriptions before it deletes — no teardown either.
    expect(deletedFeed()).toBe(false);
    expect(removeSourceMock).not.toHaveBeenCalled();
  });

  it("deletes an ordinary feed, and the DELETE still guards the flag", async () => {
    const res = await del();

    expect(res.statusCode).toBe(204);
    const del1 = calls.find((c) => c.sql.includes("DELETE FROM feeds"));
    expect(del1).toBeDefined();
    // Structural pin: only Postgres can evaluate the predicate, but its absence
    // is what reopens the race, so assert it is in the SQL that was issued.
    expect(del1!.sql).toContain("is_starter_template = FALSE");
    expect(removeSourceMock).toHaveBeenCalledTimes(1);
  });

  it("backstop: flagged between the guard and the write refuses, not 404s", async () => {
    // Unflagged when the guard reads it, flagged by the time the DELETE runs —
    // so the DELETE matches nothing.
    flagReads = [false, true];
    deleteRowCount = 0;

    const res = await del();

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("starter_template_source");
  });

  it("still 404s when the feed genuinely went away", async () => {
    flagReads = [false, null];
    deleteRowCount = 0;

    const res = await del();

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Feed not found" });
  });

  it("the only-feed refusal still wins, before any flag read", async () => {
    feedCount = 1;
    flagReads = [true];

    const res = await del();

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "Cannot delete your only feed" });
    expect(
      calls.some((c) => c.sql.includes("SELECT is_starter_template")),
    ).toBe(false);
  });
});

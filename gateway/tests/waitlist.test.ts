import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// POST /waitlist — closed-beta waiting list (CLOSED-BETA-ADR Phase 2, D2/D3).
//
// The contract under test:
//   - a valid email is captured with a single ON CONFLICT DO NOTHING upsert,
//     lower-cased and trimmed, and the publish-interest opt-in threaded through
//     (defaulting to false when omitted — D3's reader-default).
//   - the endpoint is ENUMERATION-SAFE: a new email and an already-present one
//     return the byte-identical acknowledgement, so the list never reveals who
//     is already on it (D2/D5). The upsert is what makes a repeat a no-op; the
//     route never branches on the result, which this test pins by asserting the
//     ON CONFLICT clause is present and the response is invariant.
//   - a malformed email is rejected (400) before any write.
// =============================================================================

let insertCalls: Array<{ sql: string; params: unknown[] }> = [];
let failNextInsert = false;

function query(sql: string, params: unknown[] = []) {
  if (sql.includes("INSERT INTO waitlist")) {
    insertCalls.push({ sql, params });
    if (failNextInsert) return Promise.reject(new Error("db down"));
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, params?: unknown[]) => query(sql, params) },
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { waitlistRoutes } from "../src/routes/waitlist.js";

async function buildApp() {
  const app = Fastify();
  await app.register(waitlistRoutes, { prefix: "/api/v1" });
  return app;
}

async function join(payload: unknown) {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/waitlist",
    payload: payload as object,
  });
  await app.close();
  return res;
}

beforeEach(() => {
  insertCalls = [];
  failNextInsert = false;
});

describe("POST /waitlist", () => {
  it("captures a valid email, lower-cased and trimmed, reader by default", async () => {
    const res = await join({ email: "  New@Example.COM  " });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].sql).toContain("ON CONFLICT (email) DO NOTHING");
    // email normalised; publish_interest defaults to false (D3 reader-default)
    expect(insertCalls[0].params).toEqual(["new@example.com", false]);
  });

  it("threads the publish-interest opt-in through", async () => {
    const res = await join({ email: "writer@example.com", publishInterest: true });

    expect(res.statusCode).toBe(200);
    expect(insertCalls[0].params).toEqual(["writer@example.com", true]);
  });

  it("is enumeration-safe: a repeat returns the identical acknowledgement", async () => {
    const first = await join({ email: "dup@example.com" });
    const second = await join({ email: "dup@example.com" });

    // Same status and same body — the route never reveals list membership.
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.body).toBe(first.body);
    // Both take the same upsert path; the DB's ON CONFLICT makes the 2nd a no-op.
    expect(insertCalls.every((c) => c.sql.includes("ON CONFLICT"))).toBe(true);
  });

  it("rejects a malformed email before any write", async () => {
    const res = await join({ email: "not-an-email" });

    expect(res.statusCode).toBe(400);
    expect(insertCalls).toHaveLength(0);
  });

  it("rejects a missing email before any write", async () => {
    const res = await join({});

    expect(res.statusCode).toBe(400);
    expect(insertCalls).toHaveLength(0);
  });

  it("surfaces a storage failure as a 500 (client can retry)", async () => {
    failNextInsert = true;
    const res = await join({ email: "boom@example.com" });

    expect(res.statusCode).toBe(500);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// Ingest liveness on the owner dashboard (prod incident 2026-08-11).
//
// feed-ingest took a stray SIGTERM at 14:07 UTC and nothing restarted it. Every
// container reported healthy, /health was green, every number on the overview
// page was fine, and no content was ingested for 21 hours — found only because
// the operator noticed their own feeds were stale. This block is the answer,
// and what it must get right is the shape of the signal rather than the
// plumbing:
//
//   · the alarm is derived from an ABSENCE (a heartbeat the worker stamps every
//     60s), so a stopped worker cannot report itself alive — unlike
//     jetstream_healthy, a self-declared boolean that sat at `true` for the
//     whole outage because the process that owns it was gone;
//   · a heartbeat that has NEVER been written is `down`, not "unknown" — the
//     reassuring reading of an absence is the bug class this repo keeps
//     re-learning;
//   · the threshold is a dial, and a dial with no reader is not a dial, so the
//     seeded value must be shown to actually reach the verdict;
//   · per-protocol times are context, NOT alarms, and a never-fetched protocol
//     must survive as null rather than becoming a zero.
//
// The mock answers from the SQL it is handed: the two ingest queries are
// matched on their own text, so a route that stopped selecting the heartbeat
// would fail here rather than pass against a fixture.
// =============================================================================

process.env.PAYMENT_SERVICE_URL ??= "http://payment-service.test";
process.env.INTERNAL_SERVICE_TOKEN ??= "test-token";

let heartbeat: string | null = null;
let alertSeconds: string | null = null;
let protocols: Array<{
  protocol: string;
  active_sources: number;
  last_fetched_at: Date | null;
}> = [];

function query(sql: string) {
  if (sql.includes("feed_ingest_heartbeat")) {
    return Promise.resolve({
      rows: [{ heartbeat, alert_seconds: alertSeconds }],
      rowCount: 1,
    });
  }
  if (sql.includes("FROM external_sources") && sql.includes("GROUP BY protocol")) {
    return Promise.resolve({ rows: protocols, rowCount: protocols.length });
  }
  // Every other panel on this route. One empty object, not zero rows: the
  // handler destructures `.rows[0]` for most of them, and this test is about
  // the ingest block, not about them.
  return Promise.resolve({ rows: [{}], rowCount: 1 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string) => query(sql) },
  withTransaction: vi.fn(),
  loadConfig: async () => ({ tabSettlementThresholdPence: 500 }),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/middleware/admin.js", () => ({
  requireAdmin: (req: any, _reply: any, done: any) => {
    req.session = { sub: "admin-id" };
    done();
  },
  getAdminIds: () => Promise.resolve(["admin-id"]),
}));

const { adminDashboardRoutes } = await import("../src/routes/admin-dashboard.js");

async function ingest() {
  const app = Fastify({ logger: false });
  await app.register(adminDashboardRoutes);
  const res = await app.inject({
    method: "GET",
    url: "/admin/dashboard/overview",
  });
  await app.close();
  expect(res.statusCode).toBe(200);
  return res.json().ingest;
}

const secondsAgo = (n: number) => new Date(Date.now() - n * 1000).toISOString();

beforeEach(() => {
  heartbeat = null;
  alertSeconds = null;
  protocols = [];
});

describe("ingest worker liveness", () => {
  it("reads a recent heartbeat as running", async () => {
    heartbeat = secondsAgo(30);
    const i = await ingest();
    expect(i.worker.down).toBe(false);
    expect(i.worker.ageSeconds).toBeGreaterThanOrEqual(29);
    expect(i.worker.ageSeconds).toBeLessThan(60);
  });

  it("reads a stale heartbeat as DOWN", async () => {
    // 21 hours — the actual outage.
    heartbeat = secondsAgo(21 * 3600);
    const i = await ingest();
    expect(i.worker.down).toBe(true);
  });

  it("treats a heartbeat that has NEVER been written as down, not unknown", async () => {
    // The whole point. An absent signal is the loud verdict, not the quiet one:
    // the only ways to reach this state on a live database are a worker that
    // has never run and one that stopped writing, and both want an operator
    // looking at it.
    heartbeat = null;
    const i = await ingest();
    expect(i.worker.heartbeatAt).toBeNull();
    expect(i.worker.ageSeconds).toBeNull();
    expect(i.worker.down).toBe(true);
  });

  it("honours the seeded dial rather than the in-code fallback", async () => {
    // A dial with no reader is not a dial. Chosen so the two answers DIFFER:
    // 90s is inside the 600s fallback (would read as running) and outside a
    // seeded 60s — so this passes only if the seeded row reached the verdict.
    heartbeat = secondsAgo(90);
    alertSeconds = "60";
    const tightened = await ingest();
    expect(tightened.worker.alertSeconds).toBe(60);
    expect(tightened.worker.down).toBe(true);

    alertSeconds = null;
    const fallback = await ingest();
    expect(fallback.worker.alertSeconds).toBe(600);
    expect(fallback.worker.down).toBe(false);
  });

  it("falls back rather than trusting junk in the row", async () => {
    heartbeat = secondsAgo(30);
    for (const junk of ["", "not-a-number", "0", "-5"]) {
      alertSeconds = junk;
      const i = await ingest();
      // A NaN threshold compares false against everything, so the alarm would
      // never fire; a 0 threshold fires permanently. Both are worse than the
      // default.
      expect(i.worker.alertSeconds).toBe(600);
      expect(i.worker.down).toBe(false);
    }
  });
});

describe("per-protocol freshness — context, not an alarm", () => {
  it("passes each protocol through with its own last fetch", async () => {
    heartbeat = secondsAgo(10);
    protocols = [
      { protocol: "atproto", active_sources: 623, last_fetched_at: new Date() },
      { protocol: "rss", active_sources: 4, last_fetched_at: new Date() },
    ];
    const i = await ingest();
    expect(i.protocols).toHaveLength(2);
    expect(i.protocols[0]).toMatchObject({ protocol: "atproto", activeSources: 623 });
  });

  it("keeps a never-fetched protocol as null, never as zero", async () => {
    // email is push-delivered and never sets last_fetched_at at all. Rendering
    // that as a timestamp of 0 (1970) or as "stale" would put a permanent false
    // alarm on the page, which is how a real one stops being read.
    heartbeat = secondsAgo(10);
    protocols = [{ protocol: "email", active_sources: 1, last_fetched_at: null }];
    const i = await ingest();
    expect(i.protocols[0].lastFetchedAt).toBeNull();
    expect(i.protocols[0].activeSources).toBe(1);
    // And it does not drag the worker verdict down with it.
    expect(i.worker.down).toBe(false);
  });

  it("says nothing at all when there are no active sources", async () => {
    heartbeat = secondsAgo(10);
    protocols = [];
    const i = await ingest();
    expect(i.protocols).toEqual([]);
  });
});

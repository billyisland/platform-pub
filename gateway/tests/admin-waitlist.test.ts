import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// GET /admin/dashboard/waitlist — the read half of the waitlist panel
// (CLOSED-BETA-ADR §XI.2).
//
// The contract under test:
//   · it is behind requireAdmin — the list is prospects' email addresses, and
//     the enumeration-safety that protects POST /waitlist is worth nothing if
//     the whole table is readable without a session;
//   · newest first, because an operator picking a cohort reads down from the
//     most recent;
//   · the counts are the demand signal D2 promised and nobody has yet seen;
//   · a capped response says so (`truncated`), because a silent LIMIT reads as
//     "that's everyone" precisely when it isn't;
//   · it does NOT filter disposable domains — that is an operator's call, and
//     a route that quietly dropped rows would hide people who are waiting.
// =============================================================================

process.env.PAYMENT_SERVICE_URL ??= "http://payment-service.test";
process.env.INTERNAL_SERVICE_TOKEN ??= "test-token";

let waitlistRows: Array<{
  email: string;
  publish_interest: boolean;
  created_at: Date;
}> = [];
let configValue: string | null = null;
let failNext = false;
let adminAllowed = true;

function query(sql: string, params: unknown[] = []) {
  if (failNext) return Promise.reject(new Error("db down"));
  if (sql.includes("COUNT(*)") && sql.includes("FROM waitlist")) {
    return Promise.resolve({
      rows: [
        {
          total: String(waitlistRows.length),
          joined_7d: String(waitlistRows.length),
          publish_interest: String(
            waitlistRows.filter((r) => r.publish_interest).length,
          ),
        },
      ],
      rowCount: 1,
    });
  }
  if (sql.includes("FROM waitlist")) {
    const limit = Number(params[0] ?? 1000);
    // Honour the ORDER BY the route actually wrote. A mock that always sorted
    // newest-first would let a route flipped to ASC pass the ordering test —
    // the same blind spot that let a missing ::timestamptz cast through in the
    // digest's suite. Where the mock CAN read the SQL, it should.
    const desc = /ORDER BY created_at DESC/i.test(sql);
    const rows = [...waitlistRows]
      .sort((a, b) =>
        desc
          ? b.created_at.getTime() - a.created_at.getTime()
          : a.created_at.getTime() - b.created_at.getTime(),
      )
      .slice(0, limit);
    return Promise.resolve({ rows, rowCount: rows.length });
  }
  if (sql.includes("platform_config")) {
    return Promise.resolve({
      rows: configValue === null ? [] : [{ value: configValue }],
      rowCount: configValue === null ? 0 : 1,
    });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, params?: unknown[]) => query(sql, params) },
  withTransaction: vi.fn(),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/middleware/admin.js", () => ({
  requireAdmin: (req: any, reply: any, done: any) => {
    if (!adminAllowed) return reply.status(403).send({ error: "forbidden" });
    req.session = { sub: "admin-id" };
    done();
  },
  getAdminIds: () => Promise.resolve(["admin-id"]),
}));

const { adminDashboardRoutes } = await import(
  "../src/routes/admin-dashboard.js"
);

async function build() {
  const app = Fastify({ logger: false });
  await app.register(adminDashboardRoutes);
  return app;
}

const T = (iso: string) => new Date(iso);

beforeEach(() => {
  failNext = false;
  adminAllowed = true;
  configValue = null;
  waitlistRows = [
    {
      email: "early@example.com",
      publish_interest: false,
      created_at: T("2026-07-27T08:47:00Z"),
    },
    {
      email: "middle@thenerve.news",
      publish_interest: true,
      created_at: T("2026-07-27T08:55:00Z"),
    },
    {
      email: "throwaway@candaba.com",
      publish_interest: false,
      created_at: T("2026-07-27T16:13:00Z"),
    },
  ];
});

describe("GET /admin/dashboard/waitlist", () => {
  it("requires admin", async () => {
    adminAllowed = false;
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/admin/dashboard/waitlist",
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("returns every entry, newest first, with the counts", async () => {
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/admin/dashboard/waitlist",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries.map((e: any) => e.email)).toEqual([
      "throwaway@candaba.com",
      "middle@thenerve.news",
      "early@example.com",
    ]);
    expect(body.totals).toEqual({
      total: 3,
      joinedLast7d: 3,
      publishInterest: 1,
    });
    expect(body.entries[1].publishInterest).toBe(true);
    expect(body.truncated).toBe(false);
    await app.close();
  });

  it("does not filter disposable domains — that is an operator's call", async () => {
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/admin/dashboard/waitlist",
    });

    // A route that quietly dropped these would hide someone who IS waiting,
    // and the operator would have no way to know the difference.
    expect(res.json().entries.map((e: any) => e.email)).toContain(
      "throwaway@candaba.com",
    );
    await app.close();
  });

  it("flags a capped list instead of silently truncating it", async () => {
    waitlistRows = Array.from({ length: 501 }, (_, i) => ({
      email: `person${i}@example.com`,
      publish_interest: false,
      created_at: T(`2026-07-27T00:00:00Z`),
    }));
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/admin/dashboard/waitlist",
    });

    const body = res.json();
    expect(body.truncated).toBe(true);
    expect(body.shown).toBe(500);
    expect(body.entries).toHaveLength(500);
    // The count is the WHOLE list, so the panel can say how many are hidden.
    expect(body.totals.total).toBe(501);
    await app.close();
  });

  it("reports when the operator was last told, and null when never", async () => {
    const app = await build();
    expect(
      (
        await app.inject({ method: "GET", url: "/admin/dashboard/waitlist" })
      ).json().lastDigestAt,
    ).toBeNull();

    configValue = "2026-07-27T09:00:00.000Z";
    expect(
      (
        await app.inject({ method: "GET", url: "/admin/dashboard/waitlist" })
      ).json().lastDigestAt,
    ).toBe("2026-07-27T09:00:00.000Z");
    await app.close();
  });

  it("500s rather than rendering a half-read list", async () => {
    failNext = true;
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/admin/dashboard/waitlist",
    });
    expect(res.statusCode).toBe(500);
    await app.close();
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";

// =============================================================================
// idx_notifications_dedup × grant-mode subscription offers (migration 172).
//
// Every `INSERT INTO notifications` in the codebase is a bare
// `ON CONFLICT DO NOTHING` — 22 sites, none naming an inference target — so
// which notifications collapse into one is decided ENTIRELY by that unique
// index. Before 172 it keyed on (recipient, actor, type, article, note,
// comment) with the NULL references COALESCEd to a sentinel, and a grant
// notification sets none of those three: so a writer's SECOND gift to the same
// reader was silently dropped, and `DO NOTHING` did not even reopen the first
// (already-read) row. The one person the offer exists for was never told.
//
// Only Postgres can evaluate this — the index is a unique constraint over
// COALESCE expressions, and a mocked pool.query would be pinning the mock's
// idea of collision rather than the database's. The route-level test
// (subscription-offers-grant.test.ts) pins that offer_id is BOUND; this pins
// what binding it BUYS.
//
// Fixtures live inside a transaction that is ALWAYS rolled back, so the target
// DB is never mutated. Skipped without a DB URL so the no-Postgres CI job stays
// green. Run locally:
//   TEST_DATABASE_URL=postgresql://platformpub:password@localhost:5432/platformpub \
//     npx vitest run tests/notification-dedup-integration.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!DB_URL)("notification dedup × subscription offers", () => {
  let client: pg.Client;
  let writer: string;
  let reader: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("BEGIN");
    writer = await account("notif-dedup-writer");
    reader = await account("notif-dedup-reader");
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  async function account(slug: string): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc)
       VALUES ($1, $2) RETURNING id`,
      [`fixture-${slug}-${process.hrtime.bigint().toString(16)}`, "fixture-enc"],
    );
    return rows[0].id;
  }

  async function offer(label: string): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO subscription_offers
         (writer_id, label, mode, discount_pct, recipient_id, code)
       VALUES ($1, $2, 'grant', 100, $3, $4) RETURNING id`,
      [writer, label, reader, `fixture-${process.hrtime.bigint().toString(16)}`],
    );
    return rows[0].id;
  }

  /** The route's own statement: bare ON CONFLICT DO NOTHING, as every site is. */
  async function notify(offerId: string | null): Promise<number> {
    const res = await client.query(
      `INSERT INTO notifications (recipient_id, actor_id, type, offer_id)
       VALUES ($1, $2, 'subscription_offer', $3)
       ON CONFLICT DO NOTHING`,
      [reader, writer, offerId],
    );
    return res.rowCount ?? 0;
  }

  it("two gifts from one writer to one reader are two notifications", async () => {
    // Mutant: drop COALESCE(offer_id, …) from idx_notifications_dedup — the
    // second insert returns rowCount 0 and this fails, which is exactly the
    // shipped behaviour before 172.
    expect(await notify(await offer("first gift"))).toBe(1);
    expect(await notify(await offer("second, better gift"))).toBe(1);

    const { rows } = await client.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM notifications
        WHERE recipient_id = $1 AND type = 'subscription_offer'`,
      [reader],
    );
    expect(parseInt(rows[0].cnt, 10)).toBe(2);
  });

  it("the SAME offer notified twice still collapses to one", async () => {
    // The dedup index is doing real work, not merely disabled by the new
    // column: a redelivery of the same offer must not mint a second row.
    const only = await offer("one gift, delivered twice");
    expect(await notify(only)).toBe(1);
    expect(await notify(only)).toBe(0);
  });

  it("still dedups notification types that carry no offer at all", async () => {
    // The sentinel COALESCE keeps every pre-existing type's behaviour: two
    // offer_id-less rows of the same (recipient, actor, type) remain one.
    // Widening the index must not quietly stop deduping everything else.
    expect(await notify(null)).toBe(1);
    expect(await notify(null)).toBe(0);
  });

  it("a hard-deleted offer takes its notification with it", async () => {
    // ON DELETE CASCADE, matching the other reference columns: offers are
    // normally revoked (soft), so this only fires on a genuine delete, where a
    // notification pointing at a row that is gone is worse than none.
    const doomed = await offer("about to be deleted");
    await notify(doomed);
    await client.query(`DELETE FROM subscription_offers WHERE id = $1`, [doomed]);

    const { rows } = await client.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM notifications WHERE offer_id = $1`,
      [doomed],
    );
    expect(parseInt(rows[0].cnt, 10)).toBe(0);
  });
});

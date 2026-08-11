import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import pg from "pg";
import { cloneFeedForOwner } from "../src/routes/feeds/crud.js";

// =============================================================================
// cloneFeedForOwner — a seeded clone must carry the feed-derived subscription
// (§0l.1b, CLAUDE.md "feed-derived external subscriptions").
//
// The clone writes feed_sources DIRECTLY, bypassing addSource, and until
// 2026-08-10 it stopped there. That left every seeded member holding feed rows
// pointing at external sources they had no external_subscriptions row for —
// silently, on every signup, for as long as starter seeding has worked.
//
// Why that is not cosmetic: external-sources-gc's orphan test is GLOBAL
// (`NOT EXISTS` any subscriber), so the cloned source survives only while the
// TEMPLATE owner keeps it in one of their own feeds. The day they remove it
// from their last one it falls to zero subscribers, is orphaned, and past the
// cull window hard-deleted — and feed_sources.external_source_id is ON DELETE
// CASCADE, so it vanishes out of every member feed that cloned it along with
// its external_items and feed_items. A member loses content because the
// operator tidied up, with nothing linking cause to effect.
//
// Only Postgres can evaluate this: the claim spans four tables and the whole
// point is the row's EXISTENCE under the GC's own predicate, which a mocked
// pool.query would answer from the mock rather than from the database. The
// mocked route tests pin that seeding runs; this pins what it leaves behind.
//
// Fixtures live in a transaction that is ALWAYS rolled back, so the target DB
// is never mutated. Skipped without a DB URL so the no-Postgres CI job stays
// green. Run locally:
//   TEST_DATABASE_URL=postgresql://platformpub:password@localhost:5432/platformpub \
//     npx vitest run tests/feed-clone-subscriptions.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!DB_URL)("cloneFeedForOwner — derived subscriptions", () => {
  let client: pg.Client;
  let operator: string;
  let member: string;
  let sourceId: string;
  let templateId: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });

  async function account(slug: string): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc)
       VALUES ($1, $2) RETURNING id`,
      [`fixture-${slug}-${process.hrtime.bigint().toString(16)}`, "fixture-enc"],
    );
    return rows[0].id;
  }

  beforeEach(async () => {
    await client.query("BEGIN");
    operator = await account("clone-operator");
    member = await account("clone-member");

    const { rows: src } = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri, is_active)
       VALUES ('rss', $1, TRUE) RETURNING id`,
      [`https://fixture.example/${process.hrtime.bigint().toString(16)}.xml`],
    );
    sourceId = src[0].id;

    const { rows: feed } = await client.query<{ id: string }>(
      `INSERT INTO feeds (owner_id, name, sort_rank, is_starter_template)
       VALUES ($1, 'Fixture template', 1, TRUE) RETURNING id`,
      [operator],
    );
    templateId = feed[0].id;

    // The template carries one external source and one tag, so the test also
    // proves the subscription insert selects ONLY external rows.
    await client.query(
      `INSERT INTO feed_sources (feed_id, source_type, external_source_id)
       VALUES ($1, 'external_source', $2)`,
      [templateId, sourceId],
    );
    await client.query(
      `INSERT INTO feed_sources (feed_id, source_type, tag_name)
       VALUES ($1, 'tag', 'fixture-tag')`,
      [templateId],
    );

    // Subscribe the operator, as addSource would have when they built it.
    await client.query(
      `INSERT INTO external_subscriptions (subscriber_id, source_id)
       VALUES ($1, $2)`,
      [operator, sourceId],
    );
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  it("gives the cloned owner their own subscription row", async () => {
    await cloneFeedForOwner(client as never, templateId, member, 1);

    const { rows } = await client.query(
      `SELECT 1 FROM external_subscriptions
        WHERE subscriber_id = $1 AND source_id = $2`,
      [member, sourceId],
    );
    expect(rows).toHaveLength(1);
  });

  it("survives the GC's orphan predicate once the operator lets go", async () => {
    // The actual failure mode, run end to end: the operator drops their own
    // subscription (as removeSource does when the source leaves their last
    // feed), and the member's clone must still hold the source open.
    await cloneFeedForOwner(client as never, templateId, member, 1);
    await client.query(
      `DELETE FROM external_subscriptions WHERE subscriber_id = $1`,
      [operator],
    );

    // external-sources-gc phase 0, verbatim in shape.
    const { rows } = await client.query(
      `SELECT 1 FROM external_sources es
        WHERE es.id = $1
          AND NOT EXISTS (SELECT 1 FROM external_subscriptions s
                           WHERE s.source_id = es.id)`,
      [sourceId],
    );
    expect(rows).toHaveLength(0); // not orphanable — the member holds it
  });

  it("subscribes to external rows only, not tag rows", async () => {
    await cloneFeedForOwner(client as never, templateId, member, 1);

    const { rows } = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM external_subscriptions
        WHERE subscriber_id = $1`,
      [member],
    );
    expect(rows[0].count).toBe("1");
  });

  it("revives a source the GC had already deactivated", async () => {
    await client.query(
      `UPDATE external_sources
          SET is_active = FALSE, orphaned_at = now() - INTERVAL '30 days'
        WHERE id = $1`,
      [sourceId],
    );

    await cloneFeedForOwner(client as never, templateId, member, 1);

    const { rows } = await client.query<{
      is_active: boolean;
      orphaned_at: Date | null;
    }>(`SELECT is_active, orphaned_at FROM external_sources WHERE id = $1`, [
      sourceId,
    ]);
    expect(rows[0].is_active).toBe(true);
    expect(rows[0].orphaned_at).toBeNull();
  });

  it("is idempotent across two templates carrying the same source", async () => {
    // seedStarterFeeds loops every flagged template; two of them sharing a
    // source must not raise on unique_subscription.
    const { rows: second } = await client.query<{ id: string }>(
      `INSERT INTO feeds (owner_id, name, sort_rank, is_starter_template)
       VALUES ($1, 'Second template', 2, TRUE) RETURNING id`,
      [operator],
    );
    await client.query(
      `INSERT INTO feed_sources (feed_id, source_type, external_source_id)
       VALUES ($1, 'external_source', $2)`,
      [second[0].id, sourceId],
    );

    await cloneFeedForOwner(client as never, templateId, member, 1);
    await expect(
      cloneFeedForOwner(client as never, second[0].id, member, 2),
    ).resolves.toBeTruthy();
  });
});

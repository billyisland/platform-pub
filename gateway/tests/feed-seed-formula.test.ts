import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";
import Fastify from "fastify";

// =============================================================================
// The default seed — what a brand-new account receives (FEED-FORMULAS-ADR D6/
// D11, Phase 2), and the admin act that decides it.
//
// DB-BACKED, and not by preference. What must hold spans feed_formulas →
// feeds → feed_sources → external_subscriptions, and three of the guarantees
// are Postgres's own: the partial unique index that caps designation at one,
// the CHECK that forbids revoking a designated row, and the BEFORE DELETE
// trigger that turns the author-account CASCADE into a refused delete. A
// mocked pool.query would answer "is exactly one row designated?" from the
// mock's idea of a unique index.
//
// THIS FILE MUTATES GLOBAL STATE — designation is a single platform-wide slot,
// so the suite parks any incumbent in beforeAll and puts it back in afterAll.
// Cleanup order matters: undesignate BEFORE deleting the fixture accounts, or
// the D11 trigger refuses the CASCADE and the fixtures survive the run.
//
// Run locally (both vars: the fixtures use their own client, the code under
// test uses the shared pool, which reads DATABASE_URL):
//   DATABASE_URL=postgresql://platformpub:PASSWORD@localhost:5432/platformpub \
//   TEST_DATABASE_URL=$DATABASE_URL npx vitest run tests/feed-seed-formula.test.ts
// =============================================================================

process.env.PAYMENT_SERVICE_URL ??= "http://payment-service.test";
process.env.INTERNAL_SERVICE_TOKEN ??= "test-token";

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const uniq = () => process.hrtime.bigint().toString(16);

// Who requireAdmin says is calling. A fixture account minted at run time, so
// the mock reads it rather than closing over a literal.
let adminId = "unset";
vi.mock("../src/middleware/admin.js", () => ({
  requireAdmin: (req: any, _reply: any, done: any) => {
    req.session = { sub: adminId };
    done();
  },
  getAdminIds: () => Promise.resolve([adminId]),
}));

const { seedStarterFeeds } = await import("../src/routes/feeds/crud.js");
const { listFeedsForOwner } = await import("../src/routes/feeds/crud.js");
const { redeemFormulaForOwner } = await import(
  "../src/routes/feeds/formulas.js"
);
const { adminDashboardRoutes } = await import(
  "../src/routes/admin-dashboard.js"
);

describe.skipIf(!DB_URL)("the default seed", () => {
  let client: pg.Client;
  let app: Awaited<ReturnType<typeof build>>;
  const cleanupAccounts: string[] = [];
  const cleanupSources: string[] = [];
  /** The incumbent designation, parked for the length of the run. */
  let parked: string | null = null;

  async function build() {
    const a = Fastify({ logger: false });
    await a.register(adminDashboardRoutes);
    return a;
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    const { rows } = await client.query<{ id: string }>(
      `UPDATE feed_formulas SET is_default_seed = FALSE
        WHERE is_default_seed RETURNING id`,
    );
    parked = rows[0]?.id ?? null;
    const admin = await account("seed-admin");
    adminId = admin.id;
    app = await build();
  });

  afterAll(async () => {
    // Undesignate FIRST — a designated formula cannot be deleted, and it
    // cascades from its author, so leaving one designated turns the account
    // cleanup below into a refused delete.
    await client.query(
      `UPDATE feed_formulas SET is_default_seed = FALSE WHERE is_default_seed`,
    );
    if (cleanupAccounts.length)
      await client.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [
        cleanupAccounts,
      ]);
    if (cleanupSources.length)
      await client.query(
        `DELETE FROM external_sources WHERE id = ANY($1::uuid[])`,
        [cleanupSources],
      );
    if (parked)
      await client.query(
        `UPDATE feed_formulas SET is_default_seed = TRUE WHERE id = $1`,
        [parked],
      );
    await app?.close();
    await client.end();
  });

  async function account(slug: string): Promise<{ id: string; pubkey: string }> {
    const pubkey = `fixture-${slug}-${uniq()}`;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc, display_name)
       VALUES ($1, 'fixture-enc', $2) RETURNING id`,
      [pubkey, `Fixture ${slug}`],
    );
    cleanupAccounts.push(rows[0].id);
    return { id: rows[0].id, pubkey };
  }

  /** A source addSource's known-healthy short-circuit will not probe. */
  async function healthyRssSource(): Promise<{ id: string; uri: string }> {
    const uri = `https://fixture.example/${uniq()}.xml`;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO external_sources
         (protocol, source_uri, display_name, is_active, error_count, last_fetched_at)
       VALUES ('rss', $1, 'Fixture RSS', TRUE, 0, now()) RETURNING id`,
      [uri],
    );
    cleanupSources.push(rows[0].id);
    return { id: rows[0].id, uri };
  }

  /** A formula holding one account source and one healthy RSS source. */
  async function formula(
    authorId: string,
    opts: { designate?: boolean; name?: string } = {},
  ): Promise<{ id: string; followeeId: string; sourceId: string }> {
    const followee = await account(`seed-followee-${uniq()}`);
    const rss = await healthyRssSource();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO feed_formulas
         (author_id, name, appearance, token, source_count)
       VALUES ($1, $2, '{"scheme":"autumn"}'::jsonb, $3, 2) RETURNING id`,
      [authorId, opts.name ?? "House Starter", `tok-${uniq()}`],
    );
    const id = rows[0].id;
    await client.query(
      `INSERT INTO feed_formula_sources
         (formula_id, position, tag_kind, tag_value, source_type)
       VALUES ($1, 0, 'p', $2, 'account')`,
      [id, followee.pubkey],
    );
    await client.query(
      `INSERT INTO feed_formula_sources
         (formula_id, position, tag_kind, tag_value, source_type, protocol)
       VALUES ($1, 1, 'r', $2, 'external_source', 'rss')`,
      [id, rss.uri],
    );
    if (opts.designate)
      await client.query(
        `UPDATE feed_formulas SET is_default_seed = TRUE WHERE id = $1`,
        [id],
      );
    return { id, followeeId: followee.id, sourceId: rss.id };
  }

  /** A flagged legacy template feed carrying one account source. */
  async function flaggedTemplate(ownerId: string): Promise<string> {
    const followee = await account(`tmpl-followee-${uniq()}`);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO feeds (owner_id, name, sort_rank, is_starter_template)
       VALUES ($1, 'Legacy Template', 1, TRUE) RETURNING id`,
      [ownerId],
    );
    await client.query(
      `INSERT INTO feed_sources (feed_id, source_type, account_id)
       VALUES ($1, 'account', $2)`,
      [rows[0].id, followee.id],
    );
    return rows[0].id;
  }

  async function undesignateAll() {
    await client.query(
      `UPDATE feed_formulas SET is_default_seed = FALSE WHERE is_default_seed`,
    );
  }

  async function unflagAll() {
    await client.query(
      `UPDATE feeds SET is_starter_template = FALSE WHERE is_starter_template`,
    );
  }

  // ---------------------------------------------------------------------------
  // Seeding
  // ---------------------------------------------------------------------------

  it("seeds a new account from the designated formula, with the brake OFF", async () => {
    // The brake is the point of this assertion, not scenery (§6). The seed
    // path and the share path share a mechanism and must NOT share a flag:
    // gating this on FEED_FORMULAS_ENABLED would mean turning the flag off
    // silently ends new-account seeding — the §0l outage from the other side.
    const previousFlag = process.env.FEED_FORMULAS_ENABLED;
    delete process.env.FEED_FORMULAS_ENABLED;
    try {
      await undesignateAll();
      await unflagAll();
      const author = await account("seed-author");
      const seed = await formula(author.id, { designate: true });
      const member = await account("seed-member");

      expect(await seedStarterFeeds(member.id)).toBe(1);

      const { rows: feeds } = await client.query<{
        id: string;
        from_formula_id: string | null;
        appearance: Record<string, unknown>;
      }>(`SELECT id, from_formula_id, appearance FROM feeds WHERE owner_id = $1`, [
        member.id,
      ]);
      expect(feeds).toHaveLength(1);
      expect(feeds[0].from_formula_id).toBe(seed.id);
      // The composition arrives styled (§5) and whole.
      expect(feeds[0].appearance).toEqual({ scheme: "autumn" });
      const { rows: sources } = await client.query(
        `SELECT source_type FROM feed_sources WHERE feed_id = $1 ORDER BY source_type`,
        [feeds[0].id],
      );
      expect(sources.map((r: any) => r.source_type)).toEqual([
        "account",
        "external_source",
      ]);
      // THE property redemption exists to keep: the member holds their own
      // subscription, so the GC's global orphan test cannot cull the source
      // out from under them the day the author lets go of it.
      const { rows: subs } = await client.query(
        `SELECT 1 FROM external_subscriptions WHERE subscriber_id = $1 AND source_id = $2`,
        [member.id, seed.sourceId],
      );
      expect(subs).toHaveLength(1);
    } finally {
      if (previousFlag === undefined) delete process.env.FEED_FORMULAS_ENABLED;
      else process.env.FEED_FORMULAS_ENABLED = previousFlag;
    }
  });

  it("prefers the formula over a still-flagged legacy template", async () => {
    // The cutover itself. Both mechanisms are live on a database mid-move, and
    // a member must receive ONE feed — the designated composition — not one of
    // each.
    await undesignateAll();
    await unflagAll();
    const author = await account("both-author");
    const seed = await formula(author.id, { designate: true });
    await flaggedTemplate(author.id);
    const member = await account("both-member");

    expect(await seedStarterFeeds(member.id)).toBe(1);
    const { rows } = await client.query<{
      from_formula_id: string | null;
      cloned_from_feed_id: string | null;
    }>(
      `SELECT from_formula_id, cloned_from_feed_id FROM feeds WHERE owner_id = $1`,
      [member.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].from_formula_id).toBe(seed.id);
    expect(rows[0].cloned_from_feed_id).toBeNull();
  });

  it("still clones the flagged template while nothing is designated", async () => {
    // The fallback is what makes the ordering safe: this ships BEFORE anything
    // is designated on a live database, so the day it deploys the flag must
    // still be carrying seeding. Dropping it in the same step re-opens the
    // outage the whole phase exists to close.
    await undesignateAll();
    await unflagAll();
    const operator = await account("legacy-operator");
    const templateId = await flaggedTemplate(operator.id);
    const member = await account("legacy-member");

    expect(await seedStarterFeeds(member.id)).toBe(1);
    const { rows } = await client.query<{ cloned_from_feed_id: string | null }>(
      `SELECT cloned_from_feed_id FROM feeds WHERE owner_id = $1`,
      [member.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].cloned_from_feed_id).toBe(templateId);
  });

  it("is a no-op for an owner who already has a feed", async () => {
    await undesignateAll();
    await unflagAll();
    const author = await account("idem-author");
    await formula(author.id, { designate: true });
    const member = await account("idem-member");

    expect(await seedStarterFeeds(member.id)).toBe(1);
    expect(await seedStarterFeeds(member.id)).toBe(0);
    const { rows } = await client.query(
      `SELECT id FROM feeds WHERE owner_id = $1`,
      [member.id],
    );
    expect(rows).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Provenance — from_starter and origin are now DIFFERENT questions
  // ---------------------------------------------------------------------------

  it("reads a seeded feed as from_starter, with no origin attribution", async () => {
    await undesignateAll();
    await unflagAll();
    const author = await account("prov-author");
    await formula(author.id, { designate: true });
    const member = await account("prov-member");
    await seedStarterFeeds(member.id);

    const feeds = await listFeedsForOwner(member.id);
    expect(feeds).toHaveLength(1);
    expect(feeds[0].from_starter).toBe(true);
    // NOT "from Fixture prov-author's House Starter". The seed is the
    // platform's, and answering both questions would put an author's name on
    // every new member's first feed as though they had chosen it.
    expect(feeds[0].origin_formula_name).toBeNull();
    expect(feeds[0].origin_author_name).toBeNull();
  });

  it("reads a redeemed ordinary formula as origin, and NOT as from_starter", async () => {
    await undesignateAll();
    await unflagAll();
    const author = await account("share-author");
    const shared = await formula(author.id, { name: "Long Reads" });
    const member = await account("share-member");
    await redeemFormulaForOwner(shared.id, member.id);

    const feeds = await listFeedsForOwner(member.id);
    const redeemed = feeds.find((f) => f.origin_formula_name !== null);
    expect(redeemed?.origin_formula_name).toBe("Long Reads");
    expect(redeemed?.origin_author_name).toContain("share-author");
    expect(redeemed?.from_starter).toBe(false);
  });

  it("keeps a legacy clone's provenance after the template is unflagged", async () => {
    // The old spelling was EXISTS(… AND t.is_starter_template), so merely
    // UNFLAGGING the template retroactively unmade the provenance of every
    // member ever seeded from it. What a member's feed came from is a fact
    // about their feed, not about what the operator still keeps flagged.
    await undesignateAll();
    await unflagAll();
    const operator = await account("gone-operator");
    const templateId = await flaggedTemplate(operator.id);
    const member = await account("gone-member");
    await seedStarterFeeds(member.id);
    expect((await listFeedsForOwner(member.id))[0].from_starter).toBe(true);

    await client.query(
      `UPDATE feeds SET is_starter_template = FALSE WHERE id = $1`,
      [templateId],
    );
    expect((await listFeedsForOwner(member.id))[0].from_starter).toBe(true);

    // DELETING it is a different matter, and no SQL spelling can save it:
    // feeds_cloned_from_feed_id_fkey is ON DELETE SET NULL, so the column that
    // holds the provenance is cleared by the delete itself. Pinned as the
    // known limit of the legacy arm — and as the sharpest argument for D6,
    // since a formula has no `feeds` row for anyone to delete.
    await client.query(`DELETE FROM feeds WHERE id = $1`, [templateId]);
    expect((await listFeedsForOwner(member.id))[0].from_starter).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Designation — the admin surface that replaced the hand-run UPDATE
  // ---------------------------------------------------------------------------

  async function designatedId(): Promise<string | null> {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM feed_formulas WHERE is_default_seed`,
    );
    // Length is asserted, not assumed: "exactly one" is the guarantee.
    expect(rows.length).toBeLessThanOrEqual(1);
    return rows[0]?.id ?? null;
  }

  it("swaps the designation rather than adding a second one", async () => {
    await undesignateAll();
    const first = await formula(adminId, { name: "First Seed" });
    const second = await formula(adminId, { name: "Second Seed" });
    await client.query(
      `UPDATE feed_formulas SET is_default_seed = TRUE WHERE id = $1`,
      [first.id],
    );

    const res = await app.inject({
      method: "POST",
      url: "/admin/dashboard/seed-formula",
      payload: { formulaId: second.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().replaced.id).toBe(first.id);
    expect(await designatedId()).toBe(second.id);
  });

  it("refuses a revoked formula and leaves the incumbent in place", async () => {
    await undesignateAll();
    const live = await formula(adminId, { name: "Live Seed" });
    const dead = await formula(adminId, { name: "Dead Seed" });
    await client.query(
      `UPDATE feed_formulas SET is_default_seed = TRUE WHERE id = $1`,
      [live.id],
    );
    await client.query(
      `UPDATE feed_formulas SET revoked_at = now() WHERE id = $1`,
      [dead.id],
    );

    const res = await app.inject({
      method: "POST",
      url: "/admin/dashboard/seed-formula",
      payload: { formulaId: dead.id },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("formula_revoked");
    expect(await designatedId()).toBe(live.id);
  });

  it("refuses a sourceless formula — a seeded empty feed shows the platform stream", async () => {
    await undesignateAll();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO feed_formulas (author_id, name, token, source_count)
       VALUES ($1, 'Hollow', $2, 0) RETURNING id`,
      [adminId, `tok-${uniq()}`],
    );
    const res = await app.inject({
      method: "POST",
      url: "/admin/dashboard/seed-formula",
      payload: { formulaId: rows[0].id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("formula_empty");
    expect(await designatedId()).toBeNull();
  });

  it("cuts one of the admin's own feeds into a new designated formula", async () => {
    await undesignateAll();
    const followee = await account("cut-followee");
    const { rows: feed } = await client.query<{ id: string }>(
      `INSERT INTO feeds (owner_id, name, sort_rank, appearance)
       VALUES ($1, 'House Feed', 9, '{"scheme":"winter"}'::jsonb) RETURNING id`,
      [adminId],
    );
    await client.query(
      `INSERT INTO feed_sources (feed_id, source_type, account_id)
       VALUES ($1, 'account', $2)`,
      [feed[0].id, followee.id],
    );

    const res = await app.inject({
      method: "POST",
      url: "/admin/dashboard/seed-formula",
      payload: { feedId: feed[0].id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().minted).toBe(true);
    const nowSeed = await designatedId();
    expect(nowSeed).toBe(res.json().designated.id);
    // Frozen by portable identity, not by row id (D4).
    const { rows: frozen } = await client.query<{
      tag_value: string;
      source_type: string;
    }>(
      `SELECT tag_value, source_type FROM feed_formula_sources WHERE formula_id = $1`,
      [nowSeed],
    );
    expect(frozen).toHaveLength(1);
    expect(frozen[0].source_type).toBe("account");
    expect(frozen[0].tag_value).toBe(
      (
        await client.query<{ nostr_pubkey: string }>(
          `SELECT nostr_pubkey FROM accounts WHERE id = $1`,
          [followee.id],
        )
      ).rows[0].nostr_pubkey,
    );
  });

  it("refuses to cut a feed the admin does not own", async () => {
    // Freezing writes author_id from the caller, and a designated formula's
    // author cannot delete their account (D11 through the CASCADE). Making
    // somebody else's account undeletable must not be reachable by typing a
    // uuid.
    await undesignateAll();
    const stranger = await account("stranger");
    const { rows: feed } = await client.query<{ id: string }>(
      `INSERT INTO feeds (owner_id, name, sort_rank) VALUES ($1, 'Theirs', 1) RETURNING id`,
      [stranger.id],
    );
    const res = await app.inject({
      method: "POST",
      url: "/admin/dashboard/seed-formula",
      payload: { feedId: feed[0].id },
    });
    expect(res.statusCode).toBe(404);
    expect(await designatedId()).toBeNull();
  });

  it("reports both mechanisms, so neither is invisible mid-move", async () => {
    await undesignateAll();
    await unflagAll();
    const seed = await formula(adminId, { name: "Reported Seed" });
    await client.query(
      `UPDATE feed_formulas SET is_default_seed = TRUE WHERE id = $1`,
      [seed.id],
    );
    const operator = await account("report-operator");
    await flaggedTemplate(operator.id);

    const res = await app.inject({
      method: "GET",
      url: "/admin/dashboard/seed-formula",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.designated.id).toBe(seed.id);
    expect(body.designated.authorIsSelf).toBe(true);
    // The legacy flag is still out there and the panel says so — an operator
    // who cannot see what is load-bearing is how it got deleted twice.
    expect(body.legacyTemplates.length).toBeGreaterThanOrEqual(1);
    expect(body.candidates.some((c: any) => c.id === seed.id)).toBe(true);
  });
});

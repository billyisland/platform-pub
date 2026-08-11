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
import {
  freezeFeedIntoFormula,
  freezeSource,
  redeemFormulaForOwner,
} from "../src/routes/feeds/formulas.js";

// =============================================================================
// Feed formulas — freeze and redeem (FEED-FORMULAS-ADR Phase 1).
//
// DB-backed because what must hold spans feed_formulas → feed_formula_sources →
// feeds → feed_sources → external_subscriptions → external_sources, and the
// interesting half is what does NOT make it across: a mocked pool.query would
// answer "was the email source excluded?" from the mock's own fixture rather
// than from the allow-list the code actually applies.
//
// TWO regimes, deliberately:
//
//   "freeze"  — client-threaded, so its fixtures live in a transaction that is
//               ALWAYS rolled back and the target DB is never mutated.
//   "redeem"  — CANNOT be, and this is a property of the design rather than a
//               shortcut: redemption is deliberately not one transaction (§6),
//               because N sources means N addSource calls each taking the
//               per-owner advisory lock, and wrapping the loop would serialise
//               the whole account. addSource therefore opens its own
//               transactions on the shared pool and cannot see an uncommitted
//               fixture. So that half COMMITS and cleans up after itself in a
//               finally, keyed on the two fixture accounts (feeds,
//               feed_sources, external_subscriptions and feed_formulas all
//               CASCADE from accounts; external_sources is owner-less and is
//               deleted explicitly).
//
// Skipped without a DB URL so the no-Postgres CI job stays green. Run locally:
//   TEST_DATABASE_URL=postgresql://platformpub:password@localhost:5432/platformpub \
//     npx vitest run tests/formula-integration.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const uniq = () => process.hrtime.bigint().toString(16);

// -----------------------------------------------------------------------------
// freezeSource is pure, so the branches the database cannot produce are driven
// directly. The dangling-target branches are the point: accounts.nostr_pubkey is
// NOT NULL and feed_sources.account_id is a real FK, so a NULL pubkey can only
// arise from a LEFT JOIN that missed — unreachable through the schema, and
// exactly the shape that would ship a dangling identity if it ever weren't.
// -----------------------------------------------------------------------------
describe("freezeSource — the portability rules, without a database", () => {
  const base = {
    weight: "4.0",
    sampling_mode: "chronological",
    exclude_replies: false,
    tag_name: null,
    account_pubkey: null,
    account_display_name: null,
    account_username: null,
    account_avatar: null,
    publication_pubkey: null,
    publication_name: null,
    publication_avatar: null,
    external_protocol: null,
    external_source_uri: null,
    external_display_name: null,
    external_avatar: null,
    external_relay_urls: null,
  };

  it("excludes an account whose target has gone", () => {
    expect(
      freezeSource({ ...base, source_type: "account", account_pubkey: null }),
    ).toBeNull();
  });

  it("excludes a publication whose target has gone", () => {
    expect(
      freezeSource({ ...base, source_type: "publication" }),
    ).toBeNull();
  });

  it("carries a nostr relay hint in the hint slot, never in the identity", () => {
    const f = freezeSource({
      ...base,
      source_type: "external_source",
      external_protocol: "nostr_external",
      external_source_uri: "abc123def456",
      external_relay_urls: ["wss://relay.example", "wss://other.example"],
    });
    // tag_value stays the BARE pubkey — the relay-free-identity invariant bans
    // hints from identity fields, because two relays would otherwise mint two
    // different identities for one person.
    expect(f?.tagValue).toBe("abc123def456");
    expect(f?.tagKind).toBe("p");
    expect(f?.tagHint).toBe("wss://relay.example");
  });

  it("gives an rss source no hint even if the row somehow carries relays", () => {
    const f = freezeSource({
      ...base,
      source_type: "external_source",
      external_protocol: "rss",
      external_source_uri: "https://example.com/feed.xml",
      external_relay_urls: ["wss://relay.example"],
    });
    expect(f?.tagKind).toBe("r");
    expect(f?.tagHint).toBeNull();
  });

  it("fails closed on a protocol nobody has thought about yet", () => {
    // The allow-list is the whole of D5-as-amended: external_protocol already
    // carries farcaster/matrix/telegram with no composer path, and a future
    // protocol must not leak into formulas by simply existing.
    for (const p of ["email", "farcaster", "matrix", "telegram", "whatever"]) {
      expect(
        freezeSource({
          ...base,
          source_type: "external_source",
          external_protocol: p,
          external_source_uri: "x",
        }),
      ).toBeNull();
    }
  });
});

describe.skipIf(!DB_URL)("freeze — a feed becomes a formula", () => {
  let client: pg.Client;
  let owner: string;
  let feedId: string;
  let memberPubkey: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });

  async function account(slug: string): Promise<{ id: string; pubkey: string }> {
    const pubkey = `fixture-${slug}-${uniq()}`;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc, display_name)
       VALUES ($1, 'fixture-enc', $2) RETURNING id`,
      [pubkey, `Fixture ${slug}`],
    );
    return { id: rows[0].id, pubkey };
  }

  async function externalSource(
    protocol: string,
    uri: string,
    extra: { ingest_address?: string } = {},
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri, display_name, is_active, ingest_address)
       VALUES ($1::external_protocol, $2, $3, TRUE, $4) RETURNING id`,
      [protocol, uri, `${protocol} source`, extra.ingest_address ?? null],
    );
    return rows[0].id;
  }

  const freeze = (overrides: Record<string, unknown> = {}) =>
    freezeFeedIntoFormula(client as never, {
      feedId,
      ownerId: owner,
      name: "Long Reads",
      description: "A test composition",
      appearance: { scheme: "autumn" },
      maxSources: 200,
      ...overrides,
    });

  beforeEach(async () => {
    await client.query("BEGIN");
    const o = await account("freeze-owner");
    owner = o.id;
    const m = await account("freeze-member");
    memberPubkey = m.pubkey;

    const { rows: feed } = await client.query<{ id: string }>(
      `INSERT INTO feeds (owner_id, name, sort_rank, appearance)
       VALUES ($1, 'Long Reads', 1, '{"scheme":"autumn"}'::jsonb) RETURNING id`,
      [owner],
    );
    feedId = feed[0].id;

    // Sources inserted with EXPLICIT ascending created_at so composer order is
    // a real assertion and not an accident of insertion speed.
    const rss = await externalSource("rss", `https://fixture.example/${uniq()}.xml`);
    const email = await externalSource("email", `inbox-${uniq()}`, {
      ingest_address: `secret-alias-${uniq()}@in.all.haus`,
    });
    await client.query(
      `INSERT INTO feed_sources (feed_id, source_type, account_id, created_at, weight, sampling_mode, exclude_replies)
       VALUES ($1, 'account', $2, now() - INTERVAL '4 min', 2.0, 'scored', TRUE)`,
      [feedId, m.id],
    );
    await client.query(
      `INSERT INTO feed_sources (feed_id, source_type, external_source_id, created_at)
       VALUES ($1, 'external_source', $2, now() - INTERVAL '3 min')`,
      [feedId, rss],
    );
    await client.query(
      `INSERT INTO feed_sources (feed_id, source_type, tag_name, created_at)
       VALUES ($1, 'tag', 'longform', now() - INTERVAL '2 min')`,
      [feedId],
    );
    // The one that must NOT travel: ingest_address is a per-subscriber secret.
    await client.query(
      `INSERT INTO feed_sources (feed_id, source_type, external_source_id, created_at)
       VALUES ($1, 'external_source', $2, now() - INTERVAL '1 min')`,
      [feedId, email],
    );
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  it("carries the three portable sources and excludes the email one", async () => {
    const r = await freeze();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sourceCount).toBe(3);
    // Counted, not silently dropped — an author who cannot see this believes
    // they published their whole feed (D5).
    expect(r.excludedCount).toBe(1);
  });

  it("never writes the email source's secret alias into the formula", async () => {
    const r = await freeze();
    if (!r.ok) throw new Error("freeze refused");
    const { rows } = await client.query<{ tag_value: string; protocol: string }>(
      `SELECT tag_value, protocol::text AS protocol FROM feed_formula_sources WHERE formula_id = $1`,
      [r.formulaId],
    );
    expect(rows.map((x) => x.protocol)).not.toContain("email");
    for (const row of rows) expect(row.tag_value).not.toContain("in.all.haus");
  });

  it("stores each source by portable identity, in composer order", async () => {
    const r = await freeze();
    if (!r.ok) throw new Error("freeze refused");
    const { rows } = await client.query<{
      position: number;
      tag_kind: string;
      tag_value: string;
      source_type: string;
    }>(
      `SELECT position, tag_kind, tag_value, source_type
         FROM feed_formula_sources WHERE formula_id = $1 ORDER BY position`,
      [r.formulaId],
    );
    expect(rows.map((x) => [x.position, x.tag_kind, x.source_type])).toEqual([
      [0, "p", "account"],
      [1, "r", "external_source"],
      [2, "t", "tag"],
    ]);
    // The account travels as a PUBKEY, never as its local row id (D4).
    expect(rows[0].tag_value).toBe(memberPubkey);
    expect(rows[0].tag_value).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(rows[2].tag_value).toBe("longform");
  });

  it("carries the tuning, because the composition is the formula", async () => {
    const r = await freeze();
    if (!r.ok) throw new Error("freeze refused");
    const { rows } = await client.query<{
      weight: string;
      sampling_mode: string;
      exclude_replies: boolean;
    }>(
      `SELECT weight, sampling_mode, exclude_replies FROM feed_formula_sources
        WHERE formula_id = $1 AND position = 0`,
      [r.formulaId],
    );
    expect(Number(rows[0].weight)).toBe(2);
    expect(rows[0].sampling_mode).toBe("scored");
    expect(rows[0].exclude_replies).toBe(true);
  });

  it("refuses a feed whose every source is unshareable", async () => {
    await client.query(
      `DELETE FROM feed_sources WHERE feed_id = $1 AND source_type <> 'external_source'`,
      [feedId],
    );
    await client.query(
      `DELETE FROM feed_sources fs USING external_sources xs
        WHERE fs.external_source_id = xs.id AND fs.feed_id = $1 AND xs.protocol = 'rss'`,
      [feedId],
    );
    const r = await freeze();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // "empty", not "published an empty formula": redeeming one would mint a
    // sourceless feed, which auto-serves the explore placeholder — the
    // recipient would open a stranger's curation and be shown the platform
    // stream (§2.7).
    expect(r.reason).toBe("empty");
    expect(r.excludedCount).toBe(1);
  });

  it("refuses a feed over the cap, and writes nothing when it does", async () => {
    const r = await freeze({ maxSources: 2 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("too_large");
    expect(r.sourceCount).toBe(3);
    const { rows } = await client.query(
      `SELECT 1 FROM feed_formulas WHERE source_feed_id = $1`,
      [feedId],
    );
    expect(rows).toHaveLength(0);
  });
});

describe.skipIf(!DB_URL)("redeem — a formula becomes a feed", () => {
  let client: pg.Client;
  const cleanupAccounts: string[] = [];
  const cleanupSources: string[] = [];

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    // Committed fixtures, so cleanup is not optional. feeds, feed_sources,
    // external_subscriptions and feed_formulas all CASCADE from accounts;
    // external_sources are owner-less and go explicitly.
    if (cleanupAccounts.length)
      await client.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [
        cleanupAccounts,
      ]);
    if (cleanupSources.length)
      await client.query(`DELETE FROM external_sources WHERE id = ANY($1::uuid[])`, [
        cleanupSources,
      ]);
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

  // Build a formula directly, so the redeem tests do not depend on freeze
  // passing. `healthy` matters: addSource's known-healthy short-circuit is what
  // keeps the probe (and therefore the network) out of this test.
  async function formulaWith(
    authorId: string,
    sources: Array<{
      source_type: string;
      tag_kind: string;
      tag_value: string;
      protocol?: string;
      weight?: number;
      sampling_mode?: string;
      exclude_replies?: boolean;
    }>,
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO feed_formulas (author_id, name, description, appearance, token, source_count)
       VALUES ($1, 'Redeemed Reads', 'x', '{"scheme":"winter"}'::jsonb, $2, $3)
       RETURNING id`,
      [authorId, `tok-${uniq()}`, sources.length],
    );
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      await client.query(
        `INSERT INTO feed_formula_sources
           (formula_id, position, tag_kind, tag_value, source_type, protocol,
            weight, sampling_mode, exclude_replies)
         VALUES ($1, $2, $3, $4, $5, $6::external_protocol, $7, $8, $9)`,
        [
          rows[0].id,
          i,
          s.tag_kind,
          s.tag_value,
          s.source_type,
          s.protocol ?? null,
          s.weight ?? 4.0,
          s.sampling_mode ?? "chronological",
          s.exclude_replies ?? false,
        ],
      );
    }
    return rows[0].id;
  }

  async function healthyRssSource(): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO external_sources
         (protocol, source_uri, display_name, is_active, error_count, last_fetched_at)
       VALUES ('rss', $1, 'Fixture RSS', TRUE, 0, now()) RETURNING id`,
      [`https://fixture.example/${uniq()}.xml`],
    );
    cleanupSources.push(rows[0].id);
    return rows[0].id;
  }

  it("gives the redeemer their own subscription for every external source", async () => {
    // THE property. A redeemed feed holding feed_sources rows with no
    // external_subscriptions row is the GC-orphan bug the clone path shipped
    // for years: the source survives only while somebody else keeps it, and
    // vanishes out of this member's feed the day they let go.
    const author = await account("redeem-author");
    const redeemer = await account("redeem-redeemer");
    const sourceId = await healthyRssSource();
    const { rows: src } = await client.query<{ source_uri: string }>(
      `SELECT source_uri FROM external_sources WHERE id = $1`,
      [sourceId],
    );
    const formulaId = await formulaWith(author.id, [
      {
        source_type: "external_source",
        tag_kind: "r",
        tag_value: src[0].source_uri,
        protocol: "rss",
      },
    ]);

    const result = await redeemFormulaForOwner(formulaId, redeemer.id);
    expect(result.added).toBe(1);
    expect(result.failed).toEqual([]);

    const { rows } = await client.query(
      `SELECT 1 FROM external_subscriptions WHERE subscriber_id = $1 AND source_id = $2`,
      [redeemer.id, sourceId],
    );
    expect(rows).toHaveLength(1);

    // …and it survives the GC's own orphan predicate, which is the failure this
    // property actually prevents.
    const { rows: orphanable } = await client.query(
      `SELECT 1 FROM external_sources es
        WHERE es.id = $1
          AND NOT EXISTS (SELECT 1 FROM external_subscriptions s WHERE s.source_id = es.id)`,
      [sourceId],
    );
    expect(orphanable).toHaveLength(0);
  });

  it("resolves an account by pubkey and applies the frozen tuning", async () => {
    const author = await account("tune-author");
    const redeemer = await account("tune-redeemer");
    const followee = await account("tune-followee");
    const formulaId = await formulaWith(author.id, [
      {
        source_type: "account",
        tag_kind: "p",
        tag_value: followee.pubkey,
        weight: 0.5,
        sampling_mode: "scored",
        exclude_replies: true,
      },
    ]);

    const result = await redeemFormulaForOwner(formulaId, redeemer.id);
    expect(result.added).toBe(1);

    const { rows } = await client.query<{
      account_id: string;
      weight: string;
      sampling_mode: string;
      exclude_replies: boolean;
    }>(
      `SELECT account_id, weight, sampling_mode, exclude_replies
         FROM feed_sources WHERE feed_id = $1`,
      [result.feedId],
    );
    expect(rows[0].account_id).toBe(followee.id);
    expect(Number(rows[0].weight)).toBe(0.5);
    expect(rows[0].sampling_mode).toBe("scored");
    expect(rows[0].exclude_replies).toBe(true);
  });

  it("arrives styled, and says where it came from", async () => {
    const author = await account("origin-author");
    const redeemer = await account("origin-redeemer");
    const followee = await account("origin-followee");
    const formulaId = await formulaWith(author.id, [
      { source_type: "account", tag_kind: "p", tag_value: followee.pubkey },
    ]);
    const result = await redeemFormulaForOwner(formulaId, redeemer.id);

    const { rows } = await client.query<{
      appearance: Record<string, unknown>;
      from_formula_id: string;
    }>(`SELECT appearance, from_formula_id FROM feeds WHERE id = $1`, [
      result.feedId,
    ]);
    expect(rows[0].appearance).toEqual({ scheme: "winter" });
    expect(rows[0].from_formula_id).toBe(formulaId);
  });

  it("leaves a usable feed when a source cannot be resolved, and reports it", async () => {
    // A partial redeem is a real outcome, not an error state (§6): the member
    // keeps everything that worked and is TOLD what did not, rather than
    // silently receiving a shorter version of the author's composition.
    const author = await account("partial-author");
    const redeemer = await account("partial-redeemer");
    const followee = await account("partial-followee");
    const formulaId = await formulaWith(author.id, [
      { source_type: "account", tag_kind: "p", tag_value: followee.pubkey },
      {
        source_type: "account",
        tag_kind: "p",
        tag_value: "pubkey-of-nobody-at-all",
      },
      { source_type: "tag", tag_kind: "t", tag_value: `fx-${uniq()}` },
    ]);

    const result = await redeemFormulaForOwner(formulaId, redeemer.id);
    expect(result.added).toBe(2);
    expect(result.failed).toEqual([
      { position: 1, label: "pubkey-of-nobody-at-all", reason: "unresolvable" },
    ]);

    const { rows } = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM feed_sources WHERE feed_id = $1`,
      [result.feedId],
    );
    expect(rows[0].count).toBe("2");
  });

  it("refuses a revoked formula, and touches nothing when it does", async () => {
    const author = await account("revoke-author");
    const redeemer = await account("revoke-redeemer");
    const followee = await account("revoke-followee");
    const formulaId = await formulaWith(author.id, [
      { source_type: "account", tag_kind: "p", tag_value: followee.pubkey },
    ]);
    await client.query(
      `UPDATE feed_formulas SET revoked_at = now() WHERE id = $1`,
      [formulaId],
    );

    await expect(
      redeemFormulaForOwner(formulaId, redeemer.id),
    ).rejects.toMatchObject({ code: "FORMULA_REVOKED" });

    // D10 — revoking stops FUTURE redemptions and nothing else. In particular
    // the refusal must happen before the feed is minted, or a revoked formula
    // leaves empty feeds behind on every attempt.
    const { rows } = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM feeds WHERE owner_id = $1`,
      [redeemer.id],
    );
    expect(rows[0].count).toBe("0");
  });

  it("is idempotent about a formula naming the same target twice", async () => {
    const author = await account("dupe-author");
    const redeemer = await account("dupe-redeemer");
    const followee = await account("dupe-followee");
    const formulaId = await formulaWith(author.id, [
      { source_type: "account", tag_kind: "p", tag_value: followee.pubkey },
      { source_type: "account", tag_kind: "p", tag_value: followee.pubkey },
    ]);

    const result = await redeemFormulaForOwner(formulaId, redeemer.id);
    // The second is a no-op, NOT a reported failure — the source is on the feed
    // either way, and calling it a failure would tell the member something is
    // wrong when nothing is.
    expect(result.failed).toEqual([]);
    const { rows } = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM feed_sources WHERE feed_id = $1`,
      [result.feedId],
    );
    expect(rows[0].count).toBe("1");
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import {
  DEDUP_CTES,
  DEDUP_SUPPRESS_FILTER,
  DEDUP_PROVENANCE_LATERAL,
} from "../src/lib/dedup-sql.js";

// =============================================================================
// Slice 8 P1/P2 — cross-source dedup integration test.
//
// Exercises the *real* dedup SQL (lib/dedup-sql.ts — the same constants the live
// feed query in feeds/items.ts splices in) against a live Postgres, seeding
// fixtures inside a transaction that is ALWAYS rolled back, so it never mutates
// the target DB. Covers the matrix the P1/P2 ship notes deferred: winner
// selection across tiers, cross-page (whole-candidate-set) suppression,
// canonical-URL vs text-hash grouping, the zero-link fast path, owner-scoped
// visibility, and the `also_on` provenance lateral.
//
// Skipped unless a DB URL is supplied, so the no-Postgres CI `test` job stays
// green. Run locally against the dev DB:
//   TEST_DATABASE_URL=postgresql://platformpub:password@localhost:5432/platformpub \
//     npx vitest run tests/dedup-integration.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// `matched` is the host query's pre-LIMIT candidate set; here we feed it the
// seeded feed_items directly so the dedup CTEs run over exactly our fixtures.
const SUPPRESSED_SQL = `
  WITH RECURSIVE matched AS (
    SELECT id AS fi_id FROM feed_items WHERE id = ANY($2::uuid[])
  ),
  ${DEDUP_CTES}
  SELECT fi_id FROM suppressed
`;

// Survivors + their provenance, exercising the real suppress filter + lateral.
const SURVIVORS_SQL = `
  WITH RECURSIVE matched AS (
    SELECT id AS fi_id FROM feed_items WHERE id = ANY($2::uuid[])
  ),
  ${DEDUP_CTES},
  scored AS (
    SELECT fi.id AS fi_id, fi.source_id, ei.dedup_fingerprint AS fp
    FROM feed_items fi
    JOIN matched m ON m.fi_id = fi.id
    JOIN external_items ei ON ei.id = fi.external_item_id
    WHERE TRUE ${DEDUP_SUPPRESS_FILTER}
  )
  SELECT scored.fi_id, prov.also_on
  FROM scored
  ${DEDUP_PROVENANCE_LATERAL}
`;

describe.skipIf(!DB_URL)("dedup integration (Slice 8 P1/P2)", () => {
  let client: pg.Client;
  // Two readers + a pool of fixture ids built per-test, all rolled back.
  let readerA: string;
  let readerB: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("BEGIN");
    // Owner accounts for owner-scoped link tests. accounts needs only an id +
    // the NOT NULL columns; insert a minimal row and capture the generated id.
    readerA = await insertAccount(client, "dedup-reader-a");
    readerB = await insertAccount(client, "dedup-reader-b");
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  // --- helpers --------------------------------------------------------------

  /** Insert an external source, returns its id. */
  async function source(protocol: string, uri: string): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri)
       VALUES ($1::external_protocol, $2) RETURNING id`,
      [protocol, uri],
    );
    return rows[0].id;
  }

  /**
   * Insert an external_item + its wrapping feed_item. `tier` is the biddability
   * tier (A/B/C/D) that drives the winner rule; `protocol`/`contentTier` satisfy
   * external_items' protocol_tier_consistency CHECK. Supply EITHER canonicalUrl
   * (URL-identity fingerprint) OR contentText (text-hash fingerprint).
   */
  async function item(opts: {
    sourceId: string;
    protocol: string; // external_protocol
    contentTier: string; // content_tier (tier2/tier3/tier4)
    tier: string; // biddability A/B/C/D
    canonicalUrl?: string;
    contentText?: string;
    publishedAt: string; // ISO
    uri: string;
  }): Promise<string> {
    const ext = await client.query<{ id: string }>(
      `INSERT INTO external_items
         (source_id, protocol, tier, source_item_uri, canonical_url, content_text, published_at)
       VALUES ($1, $2::external_protocol, $3::content_tier, $4, $5, $6, $7)
       RETURNING id`,
      [
        opts.sourceId,
        opts.protocol,
        opts.contentTier,
        opts.uri,
        opts.canonicalUrl ?? null,
        opts.contentText ?? null,
        opts.publishedAt,
      ],
    );
    const extId = ext.rows[0].id;
    const fi = await client.query<{ id: string }>(
      `INSERT INTO feed_items
         (item_type, external_item_id, author_name, published_at,
          source_protocol, source_id, biddability_tier, post_id)
       VALUES ('external', $1, 'fixture', $2, $3, $4, $5, $6)
       RETURNING id`,
      [extId, opts.publishedAt, opts.protocol, opts.sourceId, opts.tier, opts.uri],
    );
    return fi.rows[0].id;
  }

  /** Link two sources; ordering normalised to satisfy the table CHECK. */
  async function link(
    sourceX: string,
    sourceY: string,
    linkType: string,
    ownerId: string | null,
  ): Promise<void> {
    await client.query(
      `INSERT INTO external_identity_links
         (source_a_id, source_b_id, link_type, owner_id)
       VALUES (LEAST($1::uuid,$2::uuid), GREATEST($1::uuid,$2::uuid), $3, $4)`,
      [sourceX, sourceY, linkType, ownerId],
    );
  }

  async function suppressed(reader: string, ids: string[]): Promise<Set<string>> {
    const { rows } = await client.query<{ fi_id: string }>(SUPPRESSED_SQL, [
      reader,
      ids,
    ]);
    return new Set(rows.map((r) => r.fi_id));
  }

  async function survivors(
    reader: string,
    ids: string[],
  ): Promise<Map<string, string[] | null>> {
    const { rows } = await client.query<{ fi_id: string; also_on: string[] | null }>(
      SURVIVORS_SQL,
      [reader, ids],
    );
    return new Map(rows.map((r) => [r.fi_id, r.also_on]));
  }

  // --- tests ----------------------------------------------------------------

  it("verifies the fingerprint trigger: canonical URL identity, text-hash floor", async () => {
    const s = await source("rss", "https://fp.example/feed");
    const byUrl = await item({
      sourceId: s, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: "https://fp.example/post/1", uri: "u1",
      publishedAt: "2026-01-01T00:00:00Z",
    });
    const longText = await item({
      sourceId: s, protocol: "rss", contentTier: "tier4", tier: "C",
      contentText: "this is a sufficiently long body to clear the 32 char floor",
      uri: "u2", publishedAt: "2026-01-01T00:00:00Z",
    });
    const shortText = await item({
      sourceId: s, protocol: "rss", contentTier: "tier4", tier: "C",
      contentText: "too short", uri: "u3", publishedAt: "2026-01-01T00:00:00Z",
    });
    const { rows } = await client.query<{ id: string; dedup_fingerprint: string | null }>(
      `SELECT ei.id, ei.dedup_fingerprint
         FROM external_items ei JOIN feed_items fi ON fi.external_item_id = ei.id
        WHERE fi.id = ANY($1::uuid[])`,
      [[byUrl, longText, shortText]],
    );
    const fp = new Map(
      (
        await client.query<{ fi: string; fp: string | null }>(
          `SELECT fi.id AS fi, ei.dedup_fingerprint AS fp
             FROM feed_items fi JOIN external_items ei ON ei.id = fi.external_item_id
            WHERE fi.id = ANY($1::uuid[])`,
          [[byUrl, longText, shortText]],
        )
      ).rows.map((r) => [r.fi, r.fp]),
    );
    expect(fp.get(byUrl)).toBe("https://fp.example/post/1"); // canonical URL wins
    expect(fp.get(longText)?.startsWith("h:")).toBe(true); // text hash
    expect(fp.get(shortText)).toBeNull(); // below the 32-char floor → never deduped
    expect(rows.length).toBe(3);
  });

  it("suppresses the lower biddability tier (A beats C) across linked sources", async () => {
    const sA = await source("atproto", "did:plc:winner");
    const sC = await source("rss", "https://loser.example/feed");
    const url = "https://shared.example/article";
    const winner = await item({
      sourceId: sA, protocol: "atproto", contentTier: "tier3", tier: "A",
      canonicalUrl: url, uri: "a1", publishedAt: "2026-02-02T10:00:00Z",
    });
    const loser = await item({
      sourceId: sC, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: url, uri: "c1", publishedAt: "2026-02-01T10:00:00Z",
    });
    await link(sA, sC, "user_asserted", readerA);

    const sup = await suppressed(readerA, [winner, loser]);
    expect(sup.has(loser)).toBe(true);
    expect(sup.has(winner)).toBe(false);

    const surv = await survivors(readerA, [winner, loser]);
    expect(surv.has(winner)).toBe(true);
    expect(surv.has(loser)).toBe(false);
    // Provenance: the survivor advertises the loser's protocol.
    expect(surv.get(winner)).toContain("rss");
  });

  it("breaks a same-tier tie by earlier published_at", async () => {
    const s1 = await source("rss", "https://t1.example/feed");
    const s2 = await source("rss", "https://t2.example/feed");
    const url = "https://tie.example/post";
    const earlier = await item({
      sourceId: s1, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: url, uri: "e1", publishedAt: "2026-03-01T00:00:00Z",
    });
    const later = await item({
      sourceId: s2, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: url, uri: "l1", publishedAt: "2026-03-02T00:00:00Z",
    });
    await link(s1, s2, "user_asserted", readerA);

    const sup = await suppressed(readerA, [earlier, later]);
    expect(sup.has(later)).toBe(true);
    expect(sup.has(earlier)).toBe(false);
  });

  it("groups by text hash when there is no canonical URL", async () => {
    const s1 = await source("activitypub", "https://m1.example/users/x");
    const s2 = await source("activitypub", "https://m2.example/users/y");
    const body = "a long shared post body that comfortably exceeds the thirty-two character floor";
    const a = await item({
      sourceId: s1, protocol: "activitypub", contentTier: "tier3", tier: "B",
      contentText: body, uri: "h1", publishedAt: "2026-04-01T00:00:00Z",
    });
    const b = await item({
      sourceId: s2, protocol: "activitypub", contentTier: "tier3", tier: "B",
      contentText: body, uri: "h2", publishedAt: "2026-04-02T00:00:00Z",
    });
    await link(s1, s2, "user_asserted", readerA);

    const sup = await suppressed(readerA, [a, b]);
    expect(sup.size).toBe(1);
    expect(sup.has(b)).toBe(true); // later published_at loses
  });

  it("does not group distinct content (different fingerprints) even when linked", async () => {
    const s1 = await source("rss", "https://d1.example/feed");
    const s2 = await source("rss", "https://d2.example/feed");
    const a = await item({
      sourceId: s1, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: "https://d1.example/post/a", uri: "d1", publishedAt: "2026-05-01T00:00:00Z",
    });
    const b = await item({
      sourceId: s2, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: "https://d2.example/post/b", uri: "d2", publishedAt: "2026-05-02T00:00:00Z",
    });
    await link(s1, s2, "user_asserted", readerA);

    const sup = await suppressed(readerA, [a, b]);
    expect(sup.size).toBe(0); // distinct fingerprints → nothing suppressed
  });

  it("zero-link fast path: identical twins survive when no link joins their sources", async () => {
    const s1 = await source("rss", "https://z1.example/feed");
    const s2 = await source("rss", "https://z2.example/feed");
    const url = "https://nolink.example/post";
    const a = await item({
      sourceId: s1, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: url, uri: "z1", publishedAt: "2026-06-01T00:00:00Z",
    });
    const b = await item({
      sourceId: s2, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: url, uri: "z2", publishedAt: "2026-06-02T00:00:00Z",
    });
    // No link() call.
    const sup = await suppressed(readerA, [a, b]);
    expect(sup.size).toBe(0);
    const surv = await survivors(readerA, [a, b]);
    expect(surv.size).toBe(2);
    expect(surv.get(a)).toBeNull(); // no also_on without a link
  });

  it("owner-scoped links are private to the asserter; global links apply to all", async () => {
    const s1 = await source("rss", "https://o1.example/feed");
    const s2 = await source("rss", "https://o2.example/feed");
    const url = "https://owned.example/post";
    const early = await item({
      sourceId: s1, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: url, uri: "o1", publishedAt: "2026-07-01T00:00:00Z",
    });
    const late = await item({
      sourceId: s2, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: url, uri: "o2", publishedAt: "2026-07-02T00:00:00Z",
    });
    // readerA asserts the link; readerB does not.
    await link(s1, s2, "user_asserted", readerA);

    expect((await suppressed(readerA, [early, late])).has(late)).toBe(true);
    // readerB must not inherit readerA's private assertion.
    expect((await suppressed(readerB, [early, late])).size).toBe(0);

    // A global (owner NULL) link applies to readerB too.
    await link(s1, s2, "domain_match", null);
    expect((await suppressed(readerB, [early, late])).has(late)).toBe(true);
  });

  it("P3: a user_unlinked tombstone subtracts a global link for that reader only", async () => {
    const s1 = await source("rss", "https://tomb1.example/feed");
    const s2 = await source("rss", "https://tomb2.example/feed");
    const url = "https://tombstoned.example/post";
    const early = await item({
      sourceId: s1, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: url, uri: "tb1", publishedAt: "2026-08-01T00:00:00Z",
    });
    const late = await item({
      sourceId: s2, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: url, uri: "tb2", publishedAt: "2026-08-02T00:00:00Z",
    });
    // A global automated link suppresses for everyone.
    await link(s1, s2, "domain_match", null);
    expect((await suppressed(readerA, [early, late])).has(late)).toBe(true);
    expect((await suppressed(readerB, [early, late])).has(late)).toBe(true);

    // readerA tombstones the pair (unlinks the detected link). The override is
    // owner-scoped: readerA stops deduping it, readerB is unaffected.
    await link(s1, s2, "user_unlinked", readerA);
    expect((await suppressed(readerA, [early, late])).size).toBe(0);
    expect((await suppressed(readerA, [early, late])).has(late)).toBe(false);
    expect((await suppressed(readerB, [early, late])).has(late)).toBe(true);

    // And the survivor's also_on drops for readerA too (no applicable link).
    const survA = await survivors(readerA, [early, late]);
    expect(survA.get(early)).toBeNull();
    expect(survA.get(late)).toBeNull();
  });

  it("transitive chain (s1–s2, s2–s3, no s1–s3): collapses to one survivor", async () => {
    // The same article cross-posted to three sources the reader has linked as a
    // CHAIN, not a clique: s1–s2 and s2–s3, but never s1–s3. Pairwise suppression
    // leaks here — if the connecting node s2 is the loser it gets suppressed by
    // both ends, leaving s1 and s3 (same fingerprint, not directly linked) BOTH
    // surviving. Connectivity must be transitive: one component → one survivor.
    const s1 = await source("rss", "https://chain1.example/feed");
    const s2 = await source("rss", "https://chain2.example/feed");
    const s3 = await source("rss", "https://chain3.example/feed");
    const url = "https://chain.example/article";
    // s1 earliest (the rightful winner), s3 middle, s2 latest (the loser that
    // would be suppressed by both — the articulation point of the chain).
    const i1 = await item({
      sourceId: s1, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: url, uri: "ch1", publishedAt: "2026-09-01T00:00:00Z",
    });
    const i2 = await item({
      sourceId: s2, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: url, uri: "ch2", publishedAt: "2026-09-03T00:00:00Z",
    });
    const i3 = await item({
      sourceId: s3, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: url, uri: "ch3", publishedAt: "2026-09-02T00:00:00Z",
    });
    await link(s1, s2, "user_asserted", readerA);
    await link(s2, s3, "user_asserted", readerA);
    // no s1–s3 link

    const sup = await suppressed(readerA, [i1, i2, i3]);
    // Exactly one survivor — the earliest (s1) — and the other two suppressed.
    expect(sup.has(i2)).toBe(true);
    expect(sup.has(i3)).toBe(true);
    expect(sup.has(i1)).toBe(false);

    const surv = await survivors(readerA, [i1, i2, i3]);
    expect(surv.size).toBe(1);
    expect(surv.has(i1)).toBe(true);
  });

  it("star (centre linked to two leaves, leaves not linked): one survivor", async () => {
    // The same content on three sources linked as a STAR: a central source linked
    // to two leaves, but the leaves never linked to each other (the bridge shape —
    // a native mirrored to two bridges, each bridge linked to the native, not to
    // the other bridge). When the CENTRE is the loser it gets suppressed by both
    // leaves, and the two leaves — same fingerprint, not directly linked — both
    // leak under pairwise suppression. So the centre must rank worst: biddability
    // tier is derived from protocol by a trigger (rss→C, atproto/nostr→A), so the
    // rss centre (C) loses to its two tier-A leaves. Transitive connectivity
    // collapses the star to one survivor.
    const centre = await source("rss", "https://star-centre.example/feed");
    const leafA = await source("atproto", "did:plc:starleafa");
    const leafB = await source("nostr_external", "npub1starleafb");
    const url = "https://star.example/post";
    // leafA earliest → the rightful winner among the two tier-A leaves.
    const iLeafA = await item({
      sourceId: leafA, protocol: "atproto", contentTier: "tier3", tier: "A",
      canonicalUrl: url, uri: "st-a", publishedAt: "2026-10-01T00:00:00Z",
    });
    const iLeafB = await item({
      sourceId: leafB, protocol: "nostr_external", contentTier: "tier2", tier: "A",
      canonicalUrl: url, uri: "st-b", publishedAt: "2026-10-02T00:00:00Z",
    });
    const iCentre = await item({
      sourceId: centre, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: url, uri: "st-c", publishedAt: "2026-10-03T00:00:00Z",
    });
    await link(centre, leafA, "bridge", null);
    await link(centre, leafB, "bridge", null);
    // no leafA–leafB link — under pairwise suppression both leaves leak.

    const sup = await suppressed(readerA, [iLeafA, iLeafB, iCentre]);
    expect(sup.size).toBe(2); // exactly one survives
    expect(sup.has(iCentre)).toBe(true); // worst tier — suppressed
    expect(sup.has(iLeafB)).toBe(true); // the non-winning leaf — would leak under pairwise
    expect(sup.has(iLeafA)).toBe(false); // earliest tier-A leaf wins

    const surv = await survivors(readerA, [iLeafA, iLeafB, iCentre]);
    expect(surv.size).toBe(1);
    expect(surv.has(iLeafA)).toBe(true);
    // The lone survivor advertises both other networks via the component.
    expect(surv.get(iLeafA)).toEqual(
      expect.arrayContaining(["rss", "nostr_external"]),
    );
  });
});

async function insertAccount(client: pg.Client, slug: string): Promise<string> {
  // accounts requires a unique nostr_pubkey; generate a unique-ish placeholder.
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc)
     VALUES ($1, $2) RETURNING id`,
    [`fixture-${slug}-${randHex()}`, "fixture-enc"],
  );
  return rows[0].id;
}

function randHex(): string {
  // Avoid Math.random reliance for determinism concerns; time-based is fine for
  // a rolled-back fixture handle that only needs intra-test uniqueness.
  return process.hrtime.bigint().toString(16);
}

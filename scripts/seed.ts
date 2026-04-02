/**
 * Seed script — populates the database with realistic dummy data.
 *
 * Usage:
 *   DATABASE_URL=postgres://platformpub:... npx tsx scripts/seed.ts
 *   # or via docker:
 *   docker compose exec gateway npx tsx /app/scripts/seed.ts
 *
 * Options:
 *   --clean   Wipe seeded data before re-seeding (deletes everything!)
 *   --writers N   Number of writers (default 15)
 *   --readers N   Number of reader-only accounts (default 25)
 *   --articles N  Articles per writer, max (default 6)
 */

import pg from "pg";
import { faker } from "@faker-js/faker";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const param = (name: string, def: number) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? parseInt(args[i + 1], 10) : def;
};

const CLEAN = flag("clean");
const NUM_WRITERS = param("writers", 15);
const NUM_READERS = param("readers", 25);
const MAX_ARTICLES_PER_WRITER = param("articles", 6);

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://platformpub:platformpub@localhost:5432/platformpub";

const pool = new pg.Pool({ connectionString: DATABASE_URL });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakePubkey(): string {
  return crypto.randomBytes(32).toString("hex");
}

function fakeEventId(): string {
  return crypto.randomBytes(32).toString("hex");
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

/** Generate a few paragraphs of realistic article content. */
function articleBody(paragraphs: number): string {
  return faker.lorem.paragraphs(paragraphs, "\n\n");
}

/** Random date within the last N days. */
function recentDate(days: number): Date {
  return faker.date.recent({ days });
}

/** Pick N random items from an array. */
function sample<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, arr.length));
}

// ---------------------------------------------------------------------------
// Seed functions
// ---------------------------------------------------------------------------

interface Account {
  id: string;
  username: string;
  is_writer: boolean;
  nostr_pubkey: string;
}

async function clean(client: pg.PoolClient) {
  console.log("Cleaning existing data...");
  // Order matters due to FK constraints
  const tables = [
    "content_key_issuances",
    "vault_keys",
    "feed_engagement",
    "moderation_reports",
    "comments",
    "notes",
    "read_events",
    "tab_settlements",
    "writer_payouts",
    "reading_tabs",
    "follows",
    "blocks",
    "mutes",
    "media_uploads",
    "article_drafts",
    "articles",
    "accounts",
  ];
  for (const t of tables) {
    await client.query(`DELETE FROM ${t}`);
  }
  console.log("  Done.");
}

async function seedWriters(client: pg.PoolClient): Promise<Account[]> {
  console.log(`Creating ${NUM_WRITERS} writers...`);
  const writers: Account[] = [];

  for (let i = 0; i < NUM_WRITERS; i++) {
    const firstName = faker.person.firstName();
    const lastName = faker.person.lastName();
    const username = faker.internet
      .username({ firstName, lastName })
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "");
    const pubkey = fakePubkey();

    const { rows } = await client.query(
      `INSERT INTO accounts (username, display_name, bio, nostr_pubkey, is_writer, is_reader, status, created_at)
       VALUES ($1, $2, $3, $4, TRUE, TRUE, 'active', $5)
       ON CONFLICT (username) DO NOTHING
       RETURNING id, username, is_writer, nostr_pubkey`,
      [
        username,
        `${firstName} ${lastName}`,
        faker.person.bio(),
        pubkey,
        recentDate(90),
      ]
    );

    if (rows.length) writers.push(rows[0]);
  }

  console.log(`  Created ${writers.length} writers.`);
  return writers;
}

async function seedReaders(client: pg.PoolClient): Promise<Account[]> {
  console.log(`Creating ${NUM_READERS} readers...`);
  const readers: Account[] = [];

  for (let i = 0; i < NUM_READERS; i++) {
    const firstName = faker.person.firstName();
    const lastName = faker.person.lastName();
    const username = faker.internet
      .username({ firstName, lastName })
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "");
    const pubkey = fakePubkey();

    const { rows } = await client.query(
      `INSERT INTO accounts (username, display_name, bio, nostr_pubkey, is_writer, is_reader, status,
                             stripe_customer_id, free_allowance_remaining_pence, created_at)
       VALUES ($1, $2, $3, $4, FALSE, TRUE, 'active', $5, $6, $7)
       ON CONFLICT (username) DO NOTHING
       RETURNING id, username, is_writer, nostr_pubkey`,
      [
        username,
        `${firstName} ${lastName}`,
        faker.person.bio(),
        pubkey,
        `cus_fake_${crypto.randomBytes(8).toString("hex")}`,
        faker.number.int({ min: 0, max: 500 }),
        recentDate(60),
      ]
    );

    if (rows.length) readers.push(rows[0]);
  }

  console.log(`  Created ${readers.length} readers.`);
  return readers;
}

interface Article {
  id: string;
  writer_id: string;
  nostr_event_id: string;
  access_mode: string;
  price_pence: number | null;
}

async function seedArticles(
  client: pg.PoolClient,
  writers: Account[]
): Promise<Article[]> {
  console.log("Creating articles...");
  const articles: Article[] = [];

  for (const writer of writers) {
    const count = faker.number.int({ min: 1, max: MAX_ARTICLES_PER_WRITER });

    for (let i = 0; i < count; i++) {
      const title = faker.lorem.sentence({ min: 3, max: 8 }).replace(/\.$/, "");
      const slug = slugify(title);
      const eventId = fakeEventId();
      const dTag = `${writer.username}-${slug}`.slice(0, 100);
      const wordCount = faker.number.int({ min: 300, max: 3000 });
      const isPaywalled = faker.datatype.boolean(0.7); // 70% paywalled
      const pricePence = isPaywalled
        ? faker.helpers.arrayElement([25, 50, 75, 100, 150, 200])
        : null;
      const gatePct = isPaywalled
        ? faker.number.int({ min: 10, max: 50 })
        : null;
      const freeContent = articleBody(faker.number.int({ min: 1, max: 3 }));

      const { rows } = await client.query(
        `INSERT INTO articles
           (writer_id, nostr_event_id, nostr_d_tag, title, slug, summary,
            content_free, word_count, access_mode, price_pence, gate_position_pct,
            published_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
         RETURNING id, writer_id, nostr_event_id, access_mode, price_pence`,
        [
          writer.id,
          eventId,
          dTag,
          title,
          slug,
          faker.lorem.sentence(),
          freeContent,
          wordCount,
          isPaywalled ? "paywalled" : "public",
          pricePence,
          gatePct,
          recentDate(60),
        ]
      );

      if (rows.length) articles.push(rows[0]);
    }
  }

  console.log(`  Created ${articles.length} articles.`);
  return articles;
}

async function seedNotes(client: pg.PoolClient, writers: Account[]) {
  console.log("Creating notes...");
  let count = 0;

  for (const writer of writers) {
    const n = faker.number.int({ min: 0, max: 8 });
    for (let i = 0; i < n; i++) {
      const content = faker.lorem.sentences({ min: 1, max: 3 });
      await client.query(
        `INSERT INTO notes (author_id, nostr_event_id, content, char_count, published_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [writer.id, fakeEventId(), content, content.length, recentDate(30)]
      );
      count++;
    }
  }

  console.log(`  Created ${count} notes.`);
}

async function seedFollows(
  client: pg.PoolClient,
  writers: Account[],
  readers: Account[]
) {
  console.log("Creating follows...");
  const everyone = [...writers, ...readers];
  let count = 0;

  for (const follower of everyone) {
    // Each user follows 3–10 writers
    const targets = sample(
      writers.filter((w) => w.id !== follower.id),
      faker.number.int({ min: 3, max: 10 })
    );
    for (const target of targets) {
      await client.query(
        `INSERT INTO follows (follower_id, followee_id, followed_at)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [follower.id, target.id, recentDate(60)]
      );
      count++;
    }
  }

  console.log(`  Created ${count} follows.`);
}

async function seedComments(
  client: pg.PoolClient,
  articles: Article[],
  everyone: Account[]
) {
  console.log("Creating comments...");
  let count = 0;

  for (const article of sample(articles, Math.ceil(articles.length * 0.6))) {
    const n = faker.number.int({ min: 1, max: 5 });
    for (let i = 0; i < n; i++) {
      const author = faker.helpers.arrayElement(everyone);
      const content = faker.lorem.sentences({ min: 1, max: 3 });
      await client.query(
        `INSERT INTO comments (author_id, nostr_event_id, target_event_id, target_kind, content, published_at)
         VALUES ($1, $2, $3, 30023, $4, $5)`,
        [
          author.id,
          fakeEventId(),
          article.nostr_event_id,
          content,
          recentDate(30),
        ]
      );
      count++;
    }
  }

  console.log(`  Created ${count} comments.`);
}

async function seedReadingActivity(
  client: pg.PoolClient,
  readers: Account[],
  articles: Article[]
) {
  console.log("Creating reading tabs and read events...");
  const paywalledArticles = articles.filter((a) => a.access_mode === "paywalled");
  let tabCount = 0;
  let readCount = 0;

  for (const reader of readers) {
    // Create a reading tab
    const balance = faker.number.int({ min: 0, max: 600 });
    const { rows: tabRows } = await client.query(
      `INSERT INTO reading_tabs (reader_id, balance_pence, last_read_at, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (reader_id) DO NOTHING
       RETURNING id`,
      [reader.id, balance, recentDate(14), recentDate(60)]
    );
    if (!tabRows.length) continue;
    const tabId = tabRows[0].id;
    tabCount++;

    // Each reader reads 2–8 paywalled articles
    const readArticles = sample(
      paywalledArticles,
      faker.number.int({ min: 2, max: 8 })
    );
    for (const article of readArticles) {
      const onFree = faker.datatype.boolean(0.3);
      await client.query(
        `INSERT INTO read_events
           (reader_id, article_id, writer_id, tab_id, amount_pence, state,
            on_free_allowance, read_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          reader.id,
          article.id,
          article.writer_id,
          tabId,
          article.price_pence,
          onFree ? "provisional" : "accrued",
          onFree,
          recentDate(30),
        ]
      );
      readCount++;
    }
  }

  console.log(`  Created ${tabCount} reading tabs, ${readCount} read events.`);
}

async function seedEngagement(
  client: pg.PoolClient,
  articles: Article[],
  everyone: Account[]
) {
  console.log("Creating feed engagement...");
  let count = 0;
  const types = ["reaction", "quote_comment", "reply", "gate_pass"];

  for (const article of sample(articles, Math.ceil(articles.length * 0.5))) {
    const n = faker.number.int({ min: 1, max: 6 });
    for (let i = 0; i < n; i++) {
      const actor = faker.helpers.arrayElement(everyone);
      await client.query(
        `INSERT INTO feed_engagement (actor_id, target_nostr_event_id, target_author_id, engagement_type, engaged_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          actor.id,
          article.nostr_event_id,
          article.writer_id,
          faker.helpers.arrayElement(types),
          recentDate(30),
        ]
      );
      count++;
    }
  }

  console.log(`  Created ${count} engagement signals.`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (CLEAN) await clean(client);

    const writers = await seedWriters(client);
    const readers = await seedReaders(client);
    const articles = await seedArticles(client, writers);
    await seedNotes(client, writers);
    await seedFollows(client, writers, readers);
    const everyone = [...writers, ...readers];
    await seedComments(client, articles, everyone);
    await seedReadingActivity(client, readers, articles);
    await seedEngagement(client, articles, everyone);

    await client.query("COMMIT");
    console.log("\nSeed complete!");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Seed failed, rolled back:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();

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
 *   --writers N   Number of writers (default 200)
 *   --readers N   Number of reader-only accounts (default 800)
 *   --articles N  Articles per writer, max (default 8)
 *   --small       Use small defaults (15 writers, 25 readers, 6 articles)
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
const SMALL = flag("small");
const NUM_WRITERS = param("writers", SMALL ? 15 : 200);
const NUM_READERS = param("readers", SMALL ? 25 : 800);
const MAX_ARTICLES_PER_WRITER = param("articles", SMALL ? 6 : 8);

// The real user account on staging that should receive DMs, follows, etc.
const MY_USERNAME = "billyisland";

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

function articleBody(paragraphs: number): string {
  return faker.lorem.paragraphs(paragraphs, "\n\n");
}

function recentDate(days: number): Date {
  return faker.date.recent({ days });
}

function sample<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, arr.length));
}

/** Build a parameterised multi-row INSERT and execute it in chunks. */
async function batchInsert(
  client: pg.PoolClient,
  table: string,
  columns: string[],
  rows: unknown[][],
  chunkSize = 500,
  returning?: string
): Promise<any[]> {
  const results: any[] = [];
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const colCount = columns.length;
    const placeholders = chunk
      .map(
        (_, rowIdx) =>
          `(${columns.map((_, colIdx) => `$${rowIdx * colCount + colIdx + 1}`).join(",")})`
      )
      .join(",");
    const values = chunk.flat();
    const ret = returning ? ` RETURNING ${returning}` : "";
    const { rows: returned } = await client.query(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES ${placeholders}${ret}`,
      values
    );
    results.push(...returned);
  }
  return results;
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

interface Article {
  id: string;
  writer_id: string;
  nostr_event_id: string;
  access_mode: string;
  price_pence: number | null;
}

async function clean(client: pg.PoolClient) {
  console.log("Cleaning existing data...");
  const tables = [
    "pledges",
    "pledge_drives",
    "direct_messages",
    "conversation_members",
    "conversations",
    "dm_pricing",
    "vote_charges",
    "votes",
    "vote_tallies",
    "notifications",
    "content_key_issuances",
    "vault_keys",
    "feed_engagement",
    "moderation_reports",
    "comments",
    "notes",
    "subscription_events",
    "subscriptions",
    "article_unlocks",
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
  ];
  for (const t of tables) {
    await client.query(`DELETE FROM ${t}`);
  }
  // Delete all accounts EXCEPT the real user
  await client.query(`DELETE FROM accounts WHERE username != $1`, [MY_USERNAME]);
  console.log(`  Done (preserved account '${MY_USERNAME}').`);
}

async function getMyAccount(client: pg.PoolClient): Promise<Account | null> {
  const { rows } = await client.query(
    `SELECT id, username, is_writer, nostr_pubkey FROM accounts WHERE username = $1`,
    [MY_USERNAME]
  );
  return rows.length ? rows[0] : null;
}

async function seedWriters(client: pg.PoolClient): Promise<Account[]> {
  console.log(`Creating ${NUM_WRITERS} writers...`);
  const usedUsernames = new Set<string>();
  const rows: unknown[][] = [];

  for (let i = 0; i < NUM_WRITERS; i++) {
    const firstName = faker.person.firstName();
    const lastName = faker.person.lastName();
    let username = faker.internet
      .username({ firstName, lastName })
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "");
    // Ensure unique
    while (usedUsernames.has(username) || username === MY_USERNAME) {
      username += faker.number.int({ min: 0, max: 99 });
    }
    usedUsernames.add(username);

    rows.push([
      username,
      `${firstName} ${lastName}`,
      faker.person.bio(),
      fakePubkey(),
      true,
      true,
      "active",
      faker.number.int({ min: 300, max: 1500 }),
      faker.number.int({ min: 0, max: 30 }),
      recentDate(120),
    ]);
  }

  const results = await batchInsert(
    client,
    "accounts",
    [
      "username", "display_name", "bio", "nostr_pubkey",
      "is_writer", "is_reader", "status",
      "subscription_price_pence", "annual_discount_pct",
      "created_at",
    ],
    rows,
    200,
    "id, username, is_writer, nostr_pubkey"
  );

  console.log(`  Created ${results.length} writers.`);
  return results;
}

async function seedReaders(client: pg.PoolClient): Promise<Account[]> {
  console.log(`Creating ${NUM_READERS} readers...`);
  const usedUsernames = new Set<string>();
  const rows: unknown[][] = [];

  for (let i = 0; i < NUM_READERS; i++) {
    const firstName = faker.person.firstName();
    const lastName = faker.person.lastName();
    let username = faker.internet
      .username({ firstName, lastName })
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "");
    while (usedUsernames.has(username) || username === MY_USERNAME) {
      username += faker.number.int({ min: 0, max: 99 });
    }
    usedUsernames.add(username);

    rows.push([
      username,
      `${firstName} ${lastName}`,
      faker.person.bio(),
      fakePubkey(),
      false,
      true,
      "active",
      `cus_fake_${crypto.randomBytes(8).toString("hex")}`,
      faker.number.int({ min: 0, max: 500 }),
      recentDate(90),
    ]);
  }

  const results = await batchInsert(
    client,
    "accounts",
    [
      "username", "display_name", "bio", "nostr_pubkey",
      "is_writer", "is_reader", "status",
      "stripe_customer_id", "free_allowance_remaining_pence",
      "created_at",
    ],
    rows,
    200,
    "id, username, is_writer, nostr_pubkey"
  );

  console.log(`  Created ${results.length} readers.`);
  return results;
}

async function seedArticles(
  client: pg.PoolClient,
  writers: Account[]
): Promise<Article[]> {
  console.log("Creating articles...");
  const rows: unknown[][] = [];

  for (const writer of writers) {
    const count = faker.number.int({ min: 1, max: MAX_ARTICLES_PER_WRITER });

    for (let i = 0; i < count; i++) {
      const title = faker.lorem.sentence({ min: 3, max: 8 }).replace(/\.$/, "");
      const slug = slugify(title);
      const eventId = fakeEventId();
      const dTag = `${writer.username}-${slug}`.slice(0, 100);
      const wordCount = faker.number.int({ min: 300, max: 3000 });
      const isPaywalled = faker.datatype.boolean(0.7);
      const pricePence = isPaywalled
        ? faker.helpers.arrayElement([25, 50, 75, 100, 150, 200])
        : null;
      const gatePct = isPaywalled
        ? faker.number.int({ min: 10, max: 50 })
        : null;
      const freeContent = articleBody(faker.number.int({ min: 1, max: 3 }));

      rows.push([
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
        recentDate(90),
      ]);
    }
  }

  const results = await batchInsert(
    client,
    "articles",
    [
      "writer_id", "nostr_event_id", "nostr_d_tag", "title", "slug", "summary",
      "content_free", "word_count", "access_mode", "price_pence", "gate_position_pct",
      "published_at",
    ],
    rows,
    200,
    "id, writer_id, nostr_event_id, access_mode, price_pence"
  );

  console.log(`  Created ${results.length} articles.`);
  return results;
}

async function seedNotes(client: pg.PoolClient, writers: Account[]) {
  console.log("Creating notes...");
  const rows: unknown[][] = [];

  for (const writer of writers) {
    const n = faker.number.int({ min: 0, max: 10 });
    for (let i = 0; i < n; i++) {
      const content = faker.lorem.sentences({ min: 1, max: 3 });
      rows.push([writer.id, fakeEventId(), content, content.length, recentDate(45)]);
    }
  }

  await batchInsert(
    client,
    "notes",
    ["author_id", "nostr_event_id", "content", "char_count", "published_at"],
    rows
  );

  console.log(`  Created ${rows.length} notes.`);
}

async function seedFollows(
  client: pg.PoolClient,
  writers: Account[],
  readers: Account[],
  myAccount: Account | null
) {
  console.log("Creating follows...");
  const everyone = [...writers, ...readers];
  const rows: unknown[][] = [];
  const seen = new Set<string>();

  // Everyone follows some writers
  for (const follower of everyone) {
    const targets = sample(
      writers.filter((w) => w.id !== follower.id),
      faker.number.int({ min: 2, max: 15 })
    );
    for (const target of targets) {
      const key = `${follower.id}-${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push([follower.id, target.id, recentDate(90)]);
    }
  }

  // Many people follow me
  if (myAccount) {
    const myFollowers = sample(everyone, Math.min(400, everyone.length));
    for (const f of myFollowers) {
      const key = `${f.id}-${myAccount.id}`;
      if (seen.has(key) || f.id === myAccount.id) continue;
      seen.add(key);
      rows.push([f.id, myAccount.id, recentDate(90)]);
    }
    // I follow some writers back
    const iFollow = sample(writers, 30);
    for (const w of iFollow) {
      const key = `${myAccount.id}-${w.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push([myAccount.id, w.id, recentDate(90)]);
    }
  }

  await batchInsert(
    client,
    "follows",
    ["follower_id", "followee_id", "followed_at"],
    rows
  );

  console.log(`  Created ${rows.length} follows.`);
}

async function seedSubscriptions(
  client: pg.PoolClient,
  writers: Account[],
  readers: Account[],
  myAccount: Account | null
) {
  console.log("Creating subscriptions...");
  const rows: unknown[][] = [];
  const seen = new Set<string>();

  // Some readers subscribe to writers
  for (const reader of sample(readers, Math.ceil(readers.length * 0.3))) {
    const targets = sample(writers, faker.number.int({ min: 1, max: 4 }));
    for (const writer of targets) {
      const key = `${reader.id}-${writer.id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const isAnnual = faker.datatype.boolean(0.2);
      const period = isAnnual ? "annual" : "monthly";
      const price = faker.helpers.arrayElement([300, 500, 700, 1000, 1500]);
      const status = faker.helpers.weightedArrayElement([
        { value: "active", weight: 70 },
        { value: "cancelled", weight: 20 },
        { value: "expired", weight: 10 },
      ]);
      const startedAt = recentDate(120);
      const periodStart = recentDate(30);
      const periodEnd = new Date(periodStart.getTime() + (isAnnual ? 365 : 30) * 86400000);

      rows.push([
        reader.id, writer.id, price, status, true, period, false, false,
        startedAt, periodStart, periodEnd,
        status === "cancelled" ? recentDate(14) : null,
      ]);
    }
  }

  // Some people subscribe to me
  if (myAccount?.is_writer) {
    const subscribers = sample([...writers, ...readers], 50);
    for (const sub of subscribers) {
      const key = `${sub.id}-${myAccount.id}`;
      if (seen.has(key) || sub.id === myAccount.id) continue;
      seen.add(key);

      const startedAt = recentDate(90);
      const periodStart = recentDate(30);
      const periodEnd = new Date(periodStart.getTime() + 30 * 86400000);
      rows.push([
        sub.id, myAccount.id, 500, "active", true, "monthly", false, false,
        startedAt, periodStart, periodEnd, null,
      ]);
    }
  }

  await batchInsert(
    client,
    "subscriptions",
    [
      "reader_id", "writer_id", "price_pence", "status", "auto_renew",
      "subscription_period", "is_comp", "hidden",
      "started_at", "current_period_start", "current_period_end", "cancelled_at",
    ],
    rows
  );

  console.log(`  Created ${rows.length} subscriptions.`);
}

async function seedComments(
  client: pg.PoolClient,
  articles: Article[],
  everyone: Account[]
) {
  console.log("Creating comments...");
  const rows: unknown[][] = [];

  for (const article of sample(articles, Math.ceil(articles.length * 0.5))) {
    const n = faker.number.int({ min: 1, max: 8 });
    for (let i = 0; i < n; i++) {
      const author = faker.helpers.arrayElement(everyone);
      const content = faker.lorem.sentences({ min: 1, max: 4 });
      rows.push([
        author.id,
        fakeEventId(),
        article.nostr_event_id,
        30023,
        content,
        recentDate(45),
      ]);
    }
  }

  await batchInsert(
    client,
    "comments",
    ["author_id", "nostr_event_id", "target_event_id", "target_kind", "content", "published_at"],
    rows
  );

  console.log(`  Created ${rows.length} comments.`);
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

  // Batch create tabs first
  const tabRows: unknown[][] = readers.map((r) => [
    r.id,
    faker.number.int({ min: 0, max: 800 }),
    recentDate(14),
    recentDate(90),
  ]);

  const tabs = await batchInsert(
    client,
    "reading_tabs",
    ["reader_id", "balance_pence", "last_read_at", "created_at"],
    tabRows,
    200,
    "id, reader_id"
  );
  tabCount = tabs.length;

  const tabByReader = new Map(tabs.map((t: any) => [t.reader_id, t.id]));

  // Read events
  const readRows: unknown[][] = [];
  for (const reader of readers) {
    const tabId = tabByReader.get(reader.id);
    if (!tabId) continue;

    const readArticles = sample(
      paywalledArticles,
      faker.number.int({ min: 1, max: 10 })
    );
    for (const article of readArticles) {
      const onFree = faker.datatype.boolean(0.25);
      readRows.push([
        reader.id,
        article.id,
        article.writer_id,
        tabId,
        article.price_pence,
        onFree ? "provisional" : "accrued",
        onFree,
        recentDate(45),
      ]);
    }
  }

  await batchInsert(
    client,
    "read_events",
    [
      "reader_id", "article_id", "writer_id", "tab_id", "amount_pence",
      "state", "on_free_allowance", "read_at",
    ],
    readRows
  );
  readCount = readRows.length;

  console.log(`  Created ${tabCount} reading tabs, ${readCount} read events.`);
}

async function seedEngagement(
  client: pg.PoolClient,
  articles: Article[],
  everyone: Account[]
) {
  console.log("Creating feed engagement...");
  const rows: unknown[][] = [];
  const types = ["reaction", "quote_comment", "reply", "gate_pass"];

  for (const article of sample(articles, Math.ceil(articles.length * 0.6))) {
    const n = faker.number.int({ min: 1, max: 8 });
    for (let i = 0; i < n; i++) {
      const actor = faker.helpers.arrayElement(everyone);
      rows.push([
        actor.id,
        article.nostr_event_id,
        article.writer_id,
        faker.helpers.arrayElement(types),
        recentDate(45),
      ]);
    }
  }

  await batchInsert(
    client,
    "feed_engagement",
    ["actor_id", "target_nostr_event_id", "target_author_id", "engagement_type", "engaged_at"],
    rows
  );

  console.log(`  Created ${rows.length} engagement signals.`);
}

async function seedVotes(
  client: pg.PoolClient,
  articles: Article[],
  everyone: Account[]
) {
  console.log("Creating votes and tallies...");
  const voteRows: unknown[][] = [];
  const tallies = new Map<string, { up: number; down: number }>();

  for (const article of sample(articles, Math.ceil(articles.length * 0.5))) {
    const n = faker.number.int({ min: 1, max: 12 });
    const voters = sample(everyone, n);

    let tally = tallies.get(article.nostr_event_id);
    if (!tally) {
      tally = { up: 0, down: 0 };
      tallies.set(article.nostr_event_id, tally);
    }

    for (let seq = 0; seq < voters.length; seq++) {
      const dir = faker.datatype.boolean(0.85) ? "up" : "down";
      if (dir === "up") tally.up++;
      else tally.down++;

      voteRows.push([
        voters[seq].id,
        article.nostr_event_id,
        article.writer_id,
        dir,
        seq + 1,
        0,
        false,
        recentDate(45),
      ]);
    }
  }

  await batchInsert(
    client,
    "votes",
    [
      "voter_id", "target_nostr_event_id", "target_author_id",
      "direction", "sequence_number", "cost_pence", "on_free_allowance", "created_at",
    ],
    voteRows
  );

  // Tallies
  const tallyRows: unknown[][] = [];
  for (const [eventId, t] of tallies) {
    tallyRows.push([eventId, t.up, t.down, t.up - t.down]);
  }
  if (tallyRows.length) {
    await batchInsert(
      client,
      "vote_tallies",
      ["target_nostr_event_id", "upvote_count", "downvote_count", "net_score"],
      tallyRows
    );
  }

  console.log(`  Created ${voteRows.length} votes, ${tallyRows.length} tallies.`);
}

async function seedDirectMessages(
  client: pg.PoolClient,
  everyone: Account[],
  myAccount: Account | null
) {
  console.log("Creating DM conversations...");
  let convCount = 0;
  let msgCount = 0;

  // Helper to create a conversation between two users with some messages
  async function createConversation(
    userA: Account,
    userB: Account,
    messageCount: number
  ) {
    const { rows: convRows } = await client.query(
      `INSERT INTO conversations (created_by, last_message_at, created_at)
       VALUES ($1, $2, $3) RETURNING id`,
      [userA.id, recentDate(7), recentDate(60)]
    );
    const convId = convRows[0].id;
    convCount++;

    await client.query(
      `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`,
      [convId, userA.id, userB.id]
    );

    const msgRows: unknown[][] = [];
    for (let i = 0; i < messageCount; i++) {
      const sender = faker.datatype.boolean() ? userA : userB;
      const recipient = sender.id === userA.id ? userB : userA;
      const content = faker.lorem.sentences({ min: 1, max: 3 });
      msgRows.push([
        convId,
        sender.id,
        recipient.id,
        content, // content_enc — in staging we just store plaintext
        fakeEventId(),
        faker.datatype.boolean(0.6) ? recentDate(7) : null, // read_at
        recentDate(30),
      ]);
    }
    msgCount += msgRows.length;

    await batchInsert(
      client,
      "direct_messages",
      ["conversation_id", "sender_id", "recipient_id", "content_enc", "nostr_event_id", "read_at", "created_at"],
      msgRows
    );
  }

  // Random conversations between users
  const randomPairs = new Set<string>();
  const pairCount = Math.min(150, Math.floor(everyone.length * 0.15));
  for (let i = 0; i < pairCount; i++) {
    const a = faker.helpers.arrayElement(everyone);
    const b = faker.helpers.arrayElement(everyone);
    if (a.id === b.id) continue;
    const key = [a.id, b.id].sort().join("-");
    if (randomPairs.has(key)) continue;
    randomPairs.add(key);
    await createConversation(a, b, faker.number.int({ min: 2, max: 12 }));
  }

  // DMs TO my account — the main request
  if (myAccount) {
    const dmSenders = sample(
      everyone.filter((u) => u.id !== myAccount.id),
      Math.min(40, everyone.length)
    );
    for (const sender of dmSenders) {
      const key = [sender.id, myAccount.id].sort().join("-");
      if (randomPairs.has(key)) continue;
      randomPairs.add(key);
      await createConversation(sender, myAccount, faker.number.int({ min: 1, max: 15 }));
    }
  }

  console.log(`  Created ${convCount} conversations, ${msgCount} messages.`);
}

async function seedNotifications(
  client: pg.PoolClient,
  articles: Article[],
  everyone: Account[],
  myAccount: Account | null
) {
  console.log("Creating notifications...");
  if (!myAccount) {
    console.log("  Skipped — no target account found.");
    return;
  }

  const rows: unknown[][] = [];
  const types = ["follow", "comment", "reaction", "subscription", "dm"];

  // Generate a mix of notifications for my account
  const actors = sample(everyone, Math.min(80, everyone.length));
  for (const actor of actors) {
    if (actor.id === myAccount.id) continue;
    const type = faker.helpers.arrayElement(types);
    const isRead = faker.datatype.boolean(0.5);
    const articleId =
      type === "comment" || type === "reaction"
        ? faker.helpers.arrayElement(articles)?.id ?? null
        : null;

    rows.push([
      myAccount.id,
      actor.id,
      type,
      articleId,
      isRead,
      recentDate(30),
    ]);
  }

  // Some notifications for other users too (to make the DB realistic)
  for (let i = 0; i < 200; i++) {
    const recipient = faker.helpers.arrayElement(everyone);
    const actor = faker.helpers.arrayElement(everyone);
    if (recipient.id === actor.id) continue;
    const type = faker.helpers.arrayElement(types);
    const articleId =
      type === "comment" || type === "reaction"
        ? faker.helpers.arrayElement(articles)?.id ?? null
        : null;

    rows.push([
      recipient.id,
      actor.id,
      type,
      articleId,
      faker.datatype.boolean(0.7),
      recentDate(30),
    ]);
  }

  // Insert one at a time due to the dedup unique index
  let count = 0;
  for (const row of rows) {
    try {
      await client.query(
        `INSERT INTO notifications (recipient_id, actor_id, type, article_id, read, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        row
      );
      count++;
    } catch {
      // skip constraint violations
    }
  }

  console.log(`  Created ${count} notifications.`);
}

async function seedPledgeDrives(
  client: pg.PoolClient,
  writers: Account[],
  everyone: Account[]
) {
  console.log("Creating pledge drives...");
  const driveWriters = sample(writers, Math.min(20, writers.length));
  let driveCount = 0;
  let pledgeCount = 0;

  for (const writer of driveWriters) {
    const targetPence = faker.helpers.arrayElement([2000, 5000, 10000, 20000]);
    const status = faker.helpers.weightedArrayElement([
      { value: "open" as const, weight: 50 },
      { value: "funded" as const, weight: 20 },
      { value: "expired" as const, weight: 15 },
      { value: "cancelled" as const, weight: 15 },
    ]);

    const { rows: driveRows } = await client.query(
      `INSERT INTO pledge_drives
         (creator_id, origin, target_writer_id, title, description,
          funding_target_pence, current_total_pence, suggested_price_pence,
          status, deadline, created_at)
       VALUES ($1, 'crowdfund', $1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        writer.id,
        faker.lorem.sentence({ min: 4, max: 8 }).replace(/\.$/, ""),
        faker.lorem.paragraph(),
        targetPence,
        status === "funded" ? targetPence : faker.number.int({ min: 0, max: targetPence }),
        faker.helpers.arrayElement([100, 200, 500]),
        status,
        new Date(Date.now() + faker.number.int({ min: -30, max: 60 }) * 86400000),
        recentDate(60),
      ]
    );
    driveCount++;

    if (!driveRows.length) continue;
    const driveId = driveRows[0].id;

    // Add pledges
    const pledgers = sample(everyone, faker.number.int({ min: 2, max: 15 }));
    const pledgeRows: unknown[][] = pledgers
      .filter((p) => p.id !== writer.id)
      .map((p) => [
        driveId,
        p.id,
        faker.helpers.arrayElement([100, 200, 500, 1000]),
        status === "expired" || status === "cancelled" ? "void" : "active",
        recentDate(30),
      ]);

    await batchInsert(
      client,
      "pledges",
      ["drive_id", "pledger_id", "amount_pence", "status", "created_at"],
      pledgeRows
    );
    pledgeCount += pledgeRows.length;
  }

  console.log(`  Created ${driveCount} pledge drives, ${pledgeCount} pledges.`);
}

async function seedVaultKeys(
  client: pg.PoolClient,
  articles: Article[]
) {
  const KMS_KEY_HEX = process.env.KMS_MASTER_KEY_HEX;
  if (!KMS_KEY_HEX) {
    console.log("Skipping vault keys — KMS_MASTER_KEY_HEX not set.");
    console.log("  (Paywalled articles will not be unlockable until vault keys exist.)");
    return;
  }

  const kmsMasterKey = Buffer.from(KMS_KEY_HEX, "hex");
  if (kmsMasterKey.length !== 32) {
    console.log("Skipping vault keys — KMS_MASTER_KEY_HEX must be 32 bytes (64 hex chars).");
    return;
  }

  const paywalledArticles = articles.filter((a) => a.access_mode === "paywalled");
  console.log(`Creating vault keys for ${paywalledArticles.length} paywalled articles...`);

  const rows: unknown[][] = [];

  for (const article of paywalledArticles) {
    // Generate random 32-byte content key
    const contentKey = crypto.randomBytes(32);

    // Envelope-encrypt content key with KMS master key (AES-256-GCM)
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", kmsMasterKey, iv);
    const encrypted = Buffer.concat([cipher.update(contentKey), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const contentKeyEnc = Buffer.concat([iv, authTag, encrypted]).toString("base64");

    // Encrypt a placeholder paywalled body with AES-256-GCM
    const paywallBody = faker.lorem.paragraphs({ min: 3, max: 8 }, "\n\n");
    const bodyIv = crypto.randomBytes(12);
    const bodyCipher = crypto.createCipheriv("aes-256-gcm", contentKey, bodyIv);
    const bodyEnc = Buffer.concat([bodyCipher.update(Buffer.from(paywallBody, "utf8")), bodyCipher.final()]);
    const bodyAuthTag = bodyCipher.getAuthTag();
    const ciphertext = Buffer.concat([bodyIv, bodyAuthTag, bodyEnc]).toString("base64");

    rows.push([
      article.id,
      article.nostr_event_id,
      contentKeyEnc,
      "aes-256-gcm",
      ciphertext,
    ]);
  }

  await batchInsert(
    client,
    "vault_keys",
    ["article_id", "nostr_article_event_id", "content_key_enc", "algorithm", "ciphertext"],
    rows,
    200
  );

  console.log(`  Created ${rows.length} vault keys.`);
}

async function seedBlocksAndMutes(
  client: pg.PoolClient,
  everyone: Account[]
) {
  console.log("Creating blocks and mutes...");
  const blockRows: unknown[][] = [];
  const muteRows: unknown[][] = [];

  // ~20 blocks and ~50 mutes scattered around
  for (let i = 0; i < 20; i++) {
    const a = faker.helpers.arrayElement(everyone);
    const b = faker.helpers.arrayElement(everyone);
    if (a.id !== b.id) blockRows.push([a.id, b.id, recentDate(60)]);
  }
  for (let i = 0; i < 50; i++) {
    const a = faker.helpers.arrayElement(everyone);
    const b = faker.helpers.arrayElement(everyone);
    if (a.id !== b.id) muteRows.push([a.id, b.id, recentDate(60)]);
  }

  if (blockRows.length) {
    for (const row of blockRows) {
      try {
        await client.query(
          `INSERT INTO blocks (blocker_id, blocked_id, blocked_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          row
        );
      } catch { /* skip dupes */ }
    }
  }
  if (muteRows.length) {
    for (const row of muteRows) {
      try {
        await client.query(
          `INSERT INTO mutes (muter_id, muted_id, muted_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          row
        );
      } catch { /* skip dupes */ }
    }
  }

  console.log(`  Created ${blockRows.length} blocks, ${muteRows.length} mutes.`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (CLEAN) await clean(client);

    const myAccount = await getMyAccount(client);
    if (myAccount) {
      console.log(`Found your account: ${myAccount.username} (${myAccount.id})`);
    } else {
      console.log(`Warning: account '${MY_USERNAME}' not found — DMs/follows to you will be skipped.`);
    }

    const writers = await seedWriters(client);
    const readers = await seedReaders(client);
    const everyone = [...writers, ...readers, ...(myAccount ? [myAccount] : [])];
    const articles = await seedArticles(client, writers);
    await seedVaultKeys(client, articles);
    await seedNotes(client, writers);
    await seedFollows(client, writers, readers, myAccount);
    await seedSubscriptions(client, writers, readers, myAccount);
    await seedComments(client, articles, everyone);
    await seedReadingActivity(client, readers, articles);
    await seedEngagement(client, articles, everyone);
    await seedVotes(client, articles, everyone);
    await seedDirectMessages(client, everyone, myAccount);
    await seedNotifications(client, articles, everyone, myAccount);
    await seedPledgeDrives(client, writers, everyone);
    await seedBlocksAndMutes(client, everyone);

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

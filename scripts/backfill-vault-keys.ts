/**
 * Backfill vault_keys for paywalled articles that are missing them.
 *
 * Usage:
 *   KMS_MASTER_KEY_HEX=... DATABASE_URL=... npx tsx scripts/backfill-vault-keys.ts
 */

import pg from "pg";
import crypto from "node:crypto";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://platformpub:platformpub@localhost:5432/platformpub";
const KMS_KEY_HEX = process.env.KMS_MASTER_KEY_HEX;

if (!KMS_KEY_HEX) {
  console.error("KMS_MASTER_KEY_HEX is required");
  process.exit(1);
}

const kmsMasterKey = Buffer.from(KMS_KEY_HEX, "hex");
if (kmsMasterKey.length !== 32) {
  console.error("KMS_MASTER_KEY_HEX must be 32 bytes (64 hex chars)");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    // Find paywalled articles without vault keys
    const { rows } = await client.query<{ id: string; nostr_event_id: string }>(
      `SELECT a.id, a.nostr_event_id
       FROM articles a
       LEFT JOIN vault_keys vk ON vk.article_id = a.id
       WHERE a.access_mode = 'paywalled'
         AND a.deleted_at IS NULL
         AND vk.id IS NULL`
    );

    if (rows.length === 0) {
      console.log("All paywalled articles already have vault keys.");
      return;
    }

    console.log(`Backfilling ${rows.length} vault keys...`);

    let count = 0;
    for (const article of rows) {
      const contentKey = crypto.randomBytes(32);

      // Envelope-encrypt content key
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", kmsMasterKey, iv);
      const encrypted = Buffer.concat([cipher.update(contentKey), cipher.final()]);
      const authTag = cipher.getAuthTag();
      const contentKeyEnc = Buffer.concat([iv, authTag, encrypted]).toString("base64");

      // Encrypt placeholder body
      const body = "This is placeholder paywalled content for seeded data.";
      const bodyIv = crypto.randomBytes(12);
      const bodyCipher = crypto.createCipheriv("aes-256-gcm", contentKey, bodyIv);
      const bodyEnc = Buffer.concat([bodyCipher.update(Buffer.from(body, "utf8")), bodyCipher.final()]);
      const bodyAuthTag = bodyCipher.getAuthTag();
      const ciphertext = Buffer.concat([bodyIv, bodyAuthTag, bodyEnc]).toString("base64");

      await client.query(
        `INSERT INTO vault_keys (article_id, nostr_article_event_id, content_key_enc, algorithm, ciphertext)
         VALUES ($1, $2, $3, 'aes-256-gcm', $4)
         ON CONFLICT (nostr_article_event_id) DO NOTHING`,
        [article.id, article.nostr_event_id, contentKeyEnc, ciphertext]
      );
      count++;
    }

    console.log(`Done. Backfilled ${count} vault keys.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});

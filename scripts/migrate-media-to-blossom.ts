/**
 * One-off: migrate existing on-disk media blobs into the Blossom blob store.
 *
 * For every media_uploads row, read ${MEDIA_DIR}/<sha256>.webp off the still-
 * mounted media_data volume, sign a BUD-02 kind-24242 authorization event as the
 * ORIGINAL uploader (via key-custody), and PUT it to Blossom. Blossom dedups by
 * hash, so the script is idempotent — safe to re-run (e.g. to sweep blobs written
 * to disk between the first run and the cutover deploy). It HEAD-checks each blob
 * first and skips ones Blossom already has.
 *
 * Must run somewhere the media_data volume is mounted AND key-custody + Blossom
 * are reachable — i.e. inside the compose network. Typical invocation:
 *
 *   docker compose run --rm \
 *     -e KEY_CUSTODY_URL=http://key-custody:3004 \
 *     -e INTERNAL_SECRET=... \
 *     -e BLOSSOM_URL=http://blossom:3003 \
 *     -e MEDIA_DIR=/app/media \
 *     -e DATABASE_URL=... \
 *     -v "$PWD/scripts:/app/scripts:ro" \
 *     gateway npx tsx scripts/migrate-media-to-blossom.ts
 *
 * See docs/adr/ADR-blossom-migration.md §4 / Phase 2.
 */

import pg from "pg";
import fs from "node:fs/promises";
import path from "node:path";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://platformpub:platformpub@localhost:5432/platformpub";
const MEDIA_DIR = process.env.MEDIA_DIR ?? "/app/media";
const BLOSSOM_URL = process.env.BLOSSOM_URL ?? "http://blossom:3003";
const KEY_CUSTODY_URL = process.env.KEY_CUSTODY_URL;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

if (!KEY_CUSTODY_URL) {
  console.error("KEY_CUSTODY_URL is required (e.g. http://key-custody:3004)");
  process.exit(1);
}
if (!INTERNAL_SECRET) {
  console.error("INTERNAL_SECRET is required (same secret key-custody expects)");
  process.exit(1);
}

type SignedEvent = {
  id: string;
  pubkey: string;
  sig: string;
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
};

// Sign a Nostr event as `signerId`'s custodial account key — the same contract
// gateway/src/lib/key-custody-client.ts::signEvent uses.
async function signEvent(
  signerId: string,
  event: { kind: number; content: string; tags: string[][] },
): Promise<SignedEvent> {
  const res = await fetch(`${KEY_CUSTODY_URL}/api/v1/keypairs/sign`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": INTERNAL_SECRET!,
    },
    body: JSON.stringify({ signerId, signerType: "account", event }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`key-custody sign failed: ${res.status} ${detail}`);
  }
  return (await res.json()) as SignedEvent;
}

// Does Blossom already have this blob? BUD-01 HEAD /<sha256>.
async function blossomHas(sha256: string): Promise<boolean> {
  try {
    const res = await fetch(`${BLOSSOM_URL}/${sha256}`, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

async function uploadToBlossom(
  uploaderId: string,
  sha256: string,
  buffer: Buffer,
): Promise<void> {
  const authTemplate = {
    kind: 24242,
    content: `Upload ${sha256}.webp`,
    tags: [
      ["t", "upload"],
      ["x", sha256],
      ["expiration", String(Math.floor(Date.now() / 1000) + 60)],
    ],
  };
  const signed = await signEvent(uploaderId, authTemplate);
  const authHeader = `Nostr ${Buffer.from(JSON.stringify(signed)).toString("base64")}`;

  const res = await fetch(`${BLOSSOM_URL}/upload`, {
    method: "PUT",
    headers: { Authorization: authHeader, "Content-Type": "image/webp" },
    // Uint8Array (a BodyInit) — Node's fetch types don't accept Buffer directly.
    body: new Uint8Array(buffer),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`blossom upload ${res.status}: ${detail}`);
  }
  const descriptor = (await res.json().catch(() => ({}))) as { sha256?: string };
  if (descriptor.sha256 !== sha256) {
    throw new Error(`blossom hash mismatch: expected ${sha256}, got ${descriptor.sha256}`);
  }
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function main() {
  const { rows } = await pool.query<{ uploader_id: string; sha256: string }>(
    `SELECT uploader_id, sha256 FROM media_uploads ORDER BY uploaded_at ASC`,
  );
  console.log(`Found ${rows.length} media_uploads rows to migrate.`);

  let migrated = 0;
  let alreadyPresent = 0;
  let missingBlob = 0;
  let failed = 0;

  for (const row of rows) {
    const { uploader_id, sha256 } = row;
    try {
      if (await blossomHas(sha256)) {
        alreadyPresent++;
        continue;
      }

      const filepath = path.join(MEDIA_DIR, `${sha256}.webp`);
      let buffer: Buffer;
      try {
        buffer = await fs.readFile(filepath);
      } catch {
        missingBlob++;
        console.warn(`  MISSING on disk: ${filepath} (row kept — nothing to migrate)`);
        continue;
      }

      await uploadToBlossom(uploader_id, sha256, buffer);
      migrated++;
      if (migrated % 25 === 0) console.log(`  ...migrated ${migrated}`);
    } catch (err) {
      failed++;
      console.error(`  FAILED sha256=${sha256} uploader=${uploader_id}:`, (err as Error).message);
    }
  }

  console.log("\nMigration summary:");
  console.log(`  migrated:        ${migrated}`);
  console.log(`  already present: ${alreadyPresent}`);
  console.log(`  missing on disk: ${missingBlob}`);
  console.log(`  failed:          ${failed}`);

  await pool.end();
  // Non-zero exit only on genuine upload/sign failures — a partial run is safe
  // to resume (idempotent + hash-deduped). Missing-on-disk rows are pre-existing
  // orphans, not migration failures.
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Migration crashed:", err);
  process.exit(1);
});

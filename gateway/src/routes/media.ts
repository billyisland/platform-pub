import sharp from "sharp";
import fs from "fs/promises";
import type { FastifyInstance } from "fastify";
import { pool } from "@platform-pub/shared/db/client.js";
import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
import { requireAuth, optionalAuth } from "../middleware/auth.js";
import { signEvent } from "../lib/key-custody-client.js";
import logger from "@platform-pub/shared/lib/logger.js";

// =============================================================================
// Media Routes
//
// POST /media/upload       — Upload image (Sharp crunch → Blossom BUD-02)
// GET  /media/oembed       — Proxy oEmbed lookups
//
// Images are crunched to WebP, then uploaded to the internal Blossom blob store
// via BUD-02 PUT /upload — the gateway signs the kind-24242 authorization event
// server-side with the uploader's custodial key. nginx proxies
// /media/<sha256>.webp → Blossom's /<sha256>.webp. The stored/public URL scheme
// (PUBLIC_MEDIA_URL/<sha256>.webp) is backend-independent, so swapping the store
// again needs no URL rewrites. See docs/adr/ADR-blossom-migration.md.
// =============================================================================

const MEDIA_DIR = process.env.MEDIA_DIR ?? "/app/media";
const PUBLIC_MEDIA_URL =
  process.env.PUBLIC_MEDIA_URL ?? "https://all.haus/media";
// Internal Blossom blob store (BUD-02). Fixed service hop — see the deliberate
// safeFetch exemption at the upload call site.
const BLOSSOM_URL = process.env.BLOSSOM_URL ?? "http://blossom:3003";
const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

// oEmbed provider endpoints
const OEMBED_PROVIDERS: Record<string, string> = {
  "youtube.com": "https://www.youtube.com/oembed",
  "youtu.be": "https://www.youtube.com/oembed",
  "vimeo.com": "https://vimeo.com/api/oembed.json",
  "twitter.com": "https://publish.twitter.com/oembed",
  "x.com": "https://publish.twitter.com/oembed",
  "open.spotify.com": "https://open.spotify.com/oembed",
};

// Ensure the media directory exists on startup
async function ensureMediaDir() {
  try {
    await fs.mkdir(MEDIA_DIR, { recursive: true });
  } catch (err) {
    logger.error({ err, dir: MEDIA_DIR }, "Failed to create media directory");
  }
}

export async function mediaRoutes(app: FastifyInstance) {
  await ensureMediaDir();

  // ---------------------------------------------------------------------------
  // POST /media/upload — upload an image
  //
  // Pipeline:
  //   1. Read multipart file into buffer
  //   2. Crunch with Sharp (resize 1200px wide, convert to WebP quality 80)
  //   3. SHA-256 hash the crunched buffer (content-addressed filename)
  //   4. Check for duplicate in DB → return existing URL if found
  //   5. Sign a kind-24242 auth + PUT the blob to Blossom (BUD-02), verify hash
  //   6. Record in media_uploads table
  //   7. Return public URL
  // ---------------------------------------------------------------------------

  app.post(
    "/media/upload",
    { preHandler: requireAuth, bodyLimit: 12 * 1024 * 1024 },
    async (req, reply) => {
      const uploaderId = req.session!.sub;

      try {
        // Parse multipart body
        const data = await req.file();
        if (!data) {
          return reply.status(400).send({ error: "No file uploaded" });
        }

        // Validate MIME type
        if (!ALLOWED_TYPES.has(data.mimetype)) {
          return reply.status(400).send({
            error: `Unsupported file type: ${data.mimetype}. Allowed: JPEG, PNG, GIF, WebP`,
          });
        }

        // 1. Read into buffer
        const originalBuffer = await data.toBuffer();

        // 2. Crunch with Sharp
        // .rotate() with no args reads EXIF orientation and applies it,
        // fixing upside-down/rotated photos from phones
        const fileBuffer = await sharp(originalBuffer)
          .rotate()
          .resize(1200, null, { withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer();

        // 3. SHA-256 hash
        const { createHash } = await import("crypto");
        const sha256 = createHash("sha256").update(fileBuffer).digest("hex");

        // 4. Check for duplicate — always return current PUBLIC_MEDIA_URL
        const existing = await pool.query<{ id: string }>(
          "SELECT id FROM media_uploads WHERE sha256 = $1 LIMIT 1",
          [sha256],
        );
        if (existing.rows.length > 0) {
          return reply.status(200).send({
            url: `${PUBLIC_MEDIA_URL}/${sha256}.webp`,
            sha256,
            duplicate: true,
          });
        }

        const filename = `${sha256}.webp`;

        // 5. Upload the crunched blob to Blossom (BUD-02). Sign a kind-24242
        //    authorization event server-side with the uploader's custodial key
        //    (the same signEvent path used across the codebase).
        const nowSec = Math.floor(Date.now() / 1000);
        const authTemplate = {
          kind: 24242,
          content: `Upload ${filename}`,
          tags: [
            ["t", "upload"],
            ["x", sha256],
            ["expiration", String(nowSec + 60)],
          ],
          created_at: nowSec,
        };
        const signed = await signEvent(uploaderId, authTemplate, "account");
        const authHeader = `Nostr ${Buffer.from(JSON.stringify(signed)).toString("base64")}`;

        // Deliberate safeFetch exemption: BLOSSOM_URL is a fixed internal
        // service hop (Docker hostname → private 172.x), not an
        // attacker-influenceable host. safeFetch unconditionally rejects private
        // IPs (shared/lib/http-client.ts), so it CANNOT reach Blossom — same
        // reason key-custody-client.ts uses plain fetch. Do not "harden" this.
        const blossomRes = await fetch(`${BLOSSOM_URL}/upload`, {
          method: "PUT",
          headers: { Authorization: authHeader, "Content-Type": "image/webp" },
          // Uint8Array (a BodyInit) — Node's fetch types don't accept Buffer directly.
          body: new Uint8Array(fileBuffer),
        });
        if (!blossomRes.ok) {
          const detail = await blossomRes.text().catch(() => "");
          logger.error(
            { uploaderId, sha256, status: blossomRes.status, detail },
            "Blossom upload failed",
          );
          return reply.status(500).send({ error: "Upload failed" });
        }
        // Blossom hashes the body independently — verify it stored what we sent
        // before recording the row. Mismatch ⇒ abort, no INSERT.
        const descriptor = (await blossomRes.json().catch(() => ({}))) as {
          sha256?: string;
        };
        if (descriptor.sha256 !== sha256) {
          logger.error(
            { uploaderId, sha256, returned: descriptor.sha256 },
            "Blossom returned a mismatched hash — aborting insert",
          );
          return reply.status(500).send({ error: "Upload failed" });
        }

        // 6. Build the public URL (backend-independent; nginx proxies
        //    /media/<sha256>.webp → Blossom).
        const publicUrl = `${PUBLIC_MEDIA_URL}/${filename}`;

        // 7. Record in DB
        await pool.query(
          `INSERT INTO media_uploads (uploader_id, blossom_url, sha256, mime_type, size_bytes)
         VALUES ($1, $2, $3, $4, $5)`,
          [uploaderId, publicUrl, sha256, "image/webp", fileBuffer.length],
        );

        logger.info(
          { uploaderId, sha256, size: fileBuffer.length },
          "Media uploaded",
        );

        return reply.status(201).send({
          url: publicUrl,
          sha256,
          mimeType: "image/webp",
          size: fileBuffer.length,
        });
      } catch (err) {
        logger.error({ err, uploaderId }, "Media upload error");
        return reply.status(500).send({ error: "Upload failed" });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /media/oembed?url=... — proxy oEmbed lookups
  // ---------------------------------------------------------------------------

  app.get("/media/oembed", { preHandler: optionalAuth }, async (req, reply) => {
    const url = (req.query as { url?: string }).url;
    if (!url) {
      return reply.status(400).send({ error: "Missing url parameter" });
    }

    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.replace(/^www\./, "");

      const oembedEndpoint = OEMBED_PROVIDERS[hostname];
      if (!oembedEndpoint) {
        return reply.status(400).send({ error: "Unsupported embed provider" });
      }

      const oembedUrl = `${oembedEndpoint}?url=${encodeURIComponent(url)}&format=json&maxwidth=680`;

      const res = await safeFetch(oembedUrl, {
        headers: { "User-Agent": "Platform/1.6 (+https://all.haus)" },
        timeout: 5000,
      });

      if (!res.ok) {
        return reply.status(res.status).send({ error: "oEmbed lookup failed" });
      }

      const oembedData = JSON.parse(res.text);

      return reply.status(200).send({
        type: oembedData.type,
        title: oembedData.title,
        authorName: oembedData.author_name,
        authorUrl: oembedData.author_url,
        providerName: oembedData.provider_name,
        providerUrl: oembedData.provider_url,
        thumbnailUrl: oembedData.thumbnail_url,
        thumbnailWidth: oembedData.thumbnail_width,
        thumbnailHeight: oembedData.thumbnail_height,
        html: oembedData.html,
        width: oembedData.width,
        height: oembedData.height,
      });
    } catch (err) {
      logger.error({ err, url }, "oEmbed lookup error");
      return reply.status(500).send({ error: "oEmbed lookup failed" });
    }
  });
}

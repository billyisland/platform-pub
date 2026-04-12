import sharp from 'sharp'
import fs from 'fs/promises'
import path from 'path'
import type { FastifyInstance } from 'fastify'
import { pool } from '../../shared/src/db/client.js'
import { requireAuth, optionalAuth } from '../middleware/auth.js'
import logger from '../../shared/src/lib/logger.js'

// =============================================================================
// Media Routes
//
// POST /media/upload       — Upload image (Sharp crunch → local disk)
// GET  /media/oembed       — Proxy oEmbed lookups
//
// At launch, images are stored on a local Docker volume and served directly
// by nginx at /media/<sha256>.webp. This avoids the complexity of the Blossom
// BUD-02 auth protocol while delivering the same outcome: content-addressed
// image hosting.
//
// Post-launch, migrate to Blossom or S3 by changing where fileBuffer is
// written — the public URL scheme stays the same.
// =============================================================================

const MEDIA_DIR = process.env.MEDIA_DIR ?? '/app/media'
const PUBLIC_MEDIA_URL = process.env.PUBLIC_MEDIA_URL ?? 'https://all.haus/media'
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

// oEmbed provider endpoints
const OEMBED_PROVIDERS: Record<string, string> = {
  'youtube.com': 'https://www.youtube.com/oembed',
  'youtu.be': 'https://www.youtube.com/oembed',
  'vimeo.com': 'https://vimeo.com/api/oembed.json',
  'twitter.com': 'https://publish.twitter.com/oembed',
  'x.com': 'https://publish.twitter.com/oembed',
  'open.spotify.com': 'https://open.spotify.com/oembed',
}

// Ensure the media directory exists on startup
async function ensureMediaDir() {
  try {
    await fs.mkdir(MEDIA_DIR, { recursive: true })
  } catch (err) {
    logger.error({ err, dir: MEDIA_DIR }, 'Failed to create media directory')
  }
}

export async function mediaRoutes(app: FastifyInstance) {

  await ensureMediaDir()

  // ---------------------------------------------------------------------------
  // POST /media/upload — upload an image
  //
  // Pipeline:
  //   1. Read multipart file into buffer
  //   2. Crunch with Sharp (resize 1200px wide, convert to WebP quality 80)
  //   3. SHA-256 hash the crunched buffer (content-addressed filename)
  //   4. Check for duplicate in DB → return existing URL if found
  //   5. Write to local disk at MEDIA_DIR/<sha256>.webp
  //   6. Record in media_uploads table
  //   7. Return public URL
  // ---------------------------------------------------------------------------

  app.post('/media/upload', { preHandler: requireAuth, bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
    const uploaderId = req.session!.sub!

    try {
      // Parse multipart body
      const data = await req.file()
      if (!data) {
        return reply.status(400).send({ error: 'No file uploaded' })
      }

      // Validate MIME type
      if (!ALLOWED_TYPES.has(data.mimetype)) {
        return reply.status(400).send({
          error: `Unsupported file type: ${data.mimetype}. Allowed: JPEG, PNG, GIF, WebP`,
        })
      }

      // 1. Read into buffer
      const originalBuffer = await data.toBuffer()

      // 2. Crunch with Sharp
      // .rotate() with no args reads EXIF orientation and applies it,
      // fixing upside-down/rotated photos from phones
      const fileBuffer = await sharp(originalBuffer)
        .rotate()
        .resize(1200, null, { withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer()

      // 3. SHA-256 hash
      const { createHash } = await import('crypto')
      const sha256 = createHash('sha256').update(fileBuffer).digest('hex')

      // 4. Check for duplicate — always return current PUBLIC_MEDIA_URL
      const existing = await pool.query<{ id: string }>(
        'SELECT id FROM media_uploads WHERE sha256 = $1 LIMIT 1',
        [sha256]
      )
      if (existing.rows.length > 0) {
        return reply.status(200).send({
          url: `${PUBLIC_MEDIA_URL}/${sha256}.webp`,
          sha256,
          duplicate: true,
        })
      }

      // 5. Write to disk
      const filename = `${sha256}.webp`
      const filepath = path.join(MEDIA_DIR, filename)
      await fs.writeFile(filepath, fileBuffer)

      // 6. Build URLs
      const publicUrl = `${PUBLIC_MEDIA_URL}/${filename}`

      // 7. Record in DB
      await pool.query(
        `INSERT INTO media_uploads (uploader_id, blossom_url, sha256, mime_type, size_bytes)
         VALUES ($1, $2, $3, $4, $5)`,
        [uploaderId, publicUrl, sha256, 'image/webp', fileBuffer.length]
      )

      logger.info({ uploaderId, sha256, size: fileBuffer.length, path: filepath }, 'Media uploaded')

      return reply.status(201).send({
        url: publicUrl,
        sha256,
        mimeType: 'image/webp',
        size: fileBuffer.length,
      })
    } catch (err) {
      logger.error({ err, uploaderId }, 'Media upload error')
      return reply.status(500).send({ error: 'Upload failed' })
    }
  })

  // ---------------------------------------------------------------------------
  // GET /media/oembed?url=... — proxy oEmbed lookups
  // ---------------------------------------------------------------------------

  app.get('/media/oembed', { preHandler: optionalAuth }, async (req, reply) => {
    const url = (req.query as { url?: string }).url
    if (!url) {
      return reply.status(400).send({ error: 'Missing url parameter' })
    }

    try {
      const parsed = new URL(url)
      const hostname = parsed.hostname.replace(/^www\./, '')

      const oembedEndpoint = OEMBED_PROVIDERS[hostname]
      if (!oembedEndpoint) {
        return reply.status(400).send({ error: 'Unsupported embed provider' })
      }

      const oembedUrl = `${oembedEndpoint}?url=${encodeURIComponent(url)}&format=json&maxwidth=680`

      const res = await fetch(oembedUrl, {
        headers: { 'User-Agent': 'Platform/1.6 (+https://all.haus)' },
        signal: AbortSignal.timeout(5000),
      })

      if (!res.ok) {
        return reply.status(res.status).send({ error: 'oEmbed lookup failed' })
      }

      const oembedData = await res.json() as any

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
      })
    } catch (err) {
      logger.error({ err, url }, 'oEmbed lookup error')
      return reply.status(500).send({ error: 'oEmbed lookup failed' })
    }
  })
}

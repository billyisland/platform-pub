import crypto from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { BeaconPayloadSchema, type BeaconPayload } from '../types/beacon.js'
import { resolvePieceId } from '../lib/piece-resolver.js'
import { lookupGeo } from '../lib/geo.js'
import { parseUA } from '../lib/ua-parser.js'
import { touch, remove } from '../lib/concurrent-tracker.js'
import { pool } from '@platform-pub/shared/db/client.js'
import { requireEnv } from '@platform-pub/shared/lib/env.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// POST /beacon — receives session data from the page script
//
// Returns 204 immediately. DB writes happen asynchronously after the response.
// Three beacon types:
//   init      — first beacon on page load (creates session row)
//   heartbeat — periodic update (scroll depth, reading time)
//   unload    — final beacon on page leave
// =============================================================================

const IP_HASH_SALT = requireEnv('IP_HASH_SALT')

function hashIp(ip: string): string {
  return crypto.createHash('sha256').update(ip + IP_HASH_SALT).digest('hex')
}

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

function deviceTypeFromScreenWidth(screenWidth: number | undefined, uaDeviceType: string): string {
  // UA parser is authoritative; screen width is a supplementary signal
  if (uaDeviceType !== 'desktop') return uaDeviceType
  if (screenWidth !== undefined && screenWidth < 768) return 'mobile'
  return 'desktop'
}

async function processInit(data: BeaconPayload, ip: string, userAgent: string | undefined): Promise<void> {
  const pieceId = await resolvePieceId(data.articleId)
  if (!pieceId) return

  const ipHash = hashIp(ip)
  const geo = lookupGeo(ip)
  const ua = parseUA(userAgent)
  const deviceType = deviceTypeFromScreenWidth(data.screenWidth, ua.deviceType)
  const referrerDomain = data.referrerUrl ? extractDomain(data.referrerUrl) : null

  await pool.query(
    `INSERT INTO traffology.sessions
       (piece_id, session_token, ip_hash, referrer_url, referrer_domain,
        utm_source, utm_medium, utm_campaign, country, city,
        device_type, browser_family, subscriber_status,
        scroll_depth, reading_time_seconds)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (session_token, piece_id)
     DO UPDATE SET
       started_at = now(),
       last_beacon_at = now(),
       scroll_depth = COALESCE($14, 0),
       reading_time_seconds = COALESCE($15, 0),
       is_bounce = TRUE`,
    [
      pieceId,
      data.sessionToken,
      ipHash,
      data.referrerUrl ?? null,
      referrerDomain,
      data.utmSource ?? null,
      data.utmMedium ?? null,
      data.utmCampaign ?? null,
      geo.country,
      geo.city,
      deviceType,
      ua.browserFamily,
      data.subscriberStatus ?? 'anonymous',
      data.scrollDepth ?? 0,
      data.readingTimeSeconds ?? 0,
    ],
  )

  touch(pieceId, data.sessionToken)
}

async function processUpdate(data: BeaconPayload): Promise<void> {
  const pieceId = await resolvePieceId(data.articleId)
  if (!pieceId) return

  const scrollDepth = data.scrollDepth ?? 0
  const readingTime = data.readingTimeSeconds ?? 0
  const isBounce = scrollDepth < 0.1 && readingTime < 15

  await pool.query(
    `UPDATE traffology.sessions
     SET scroll_depth = GREATEST(scroll_depth, $1),
         reading_time_seconds = GREATEST(reading_time_seconds, $2),
         last_beacon_at = now(),
         is_bounce = $3
     WHERE session_token = $4 AND piece_id = $5`,
    [scrollDepth, readingTime, isBounce, data.sessionToken, pieceId],
  )

  if (data.type === 'heartbeat') {
    touch(pieceId, data.sessionToken)
  } else {
    // unload — session is over
    remove(pieceId, data.sessionToken)
  }
}

export async function beaconRoutes(app: FastifyInstance) {
  app.post('/beacon', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const parsed = BeaconPayloadSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send()
    }

    const data = parsed.data
    const ip = req.ip
    const userAgent = req.headers['user-agent']

    // Reply immediately — don't make the client wait for DB writes
    reply.status(204).send()

    try {
      if (data.type === 'init') {
        await processInit(data, ip, userAgent)
      } else {
        await processUpdate(data)
      }
    } catch (err) {
      logger.error({ err, sessionToken: data.sessionToken, type: data.type }, 'Beacon processing failed')
    }
  })
}

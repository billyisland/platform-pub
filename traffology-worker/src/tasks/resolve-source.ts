import { type Task } from 'graphile-worker'
import { pool } from '@platform-pub/shared/db/client.js'
import logger from '@platform-pub/shared/lib/logger.js'
import {
  KNOWN_DOMAINS,
  SHORTENER_DOMAINS,
  SHORTENER_FALLBACKS,
} from '../lib/known-domains.js'

// =============================================================================
// resolve_source task
//
// Called in two modes:
//   1. Batch mode (no payload) — scans for unresolved sessions and resolves them
//   2. Single mode (payload.sessionId) — resolves a specific session
//
// Resolution pipeline (ADR Section 4.1):
//   1. Platform-internal (all.haus URLs → writer name + piece title)
//   2. Nostr (npub → profile display name) — deferred to Phase 2
//   3. Known domain lookup table
//   4. Shortener redirect following (t.co, bit.ly → destination domain)
//   5. Raw domain fallback
// =============================================================================

interface ResolvePayload {
  sessionId?: string
}

interface UnresolvedSession {
  id: string
  piece_id: string
  referrer_url: string | null
  referrer_domain: string | null
  utm_source: string | null
  utm_medium: string | null
  writer_id: string
}

export const resolveSource: Task = async (payload, helpers) => {
  const { sessionId } = (payload ?? {}) as ResolvePayload

  const sessions = sessionId
    ? await fetchSession(sessionId)
    : await fetchUnresolvedSessions()

  if (sessions.length === 0) return

  helpers.logger.info(`Resolving sources for ${sessions.length} sessions`)

  let resolved = 0
  for (const session of sessions) {
    try {
      const sourceId = await resolveSession(session)
      if (sourceId) {
        await pool.query(
          'UPDATE traffology.sessions SET resolved_source_id = $1 WHERE id = $2',
          [sourceId, session.id]
        )
        resolved++
      }
    } catch (err) {
      logger.error({ err, sessionId: session.id }, 'Failed to resolve source for session')
    }
  }

  helpers.logger.info(`Resolved ${resolved}/${sessions.length} sessions`)
}

async function fetchSession(sessionId: string): Promise<UnresolvedSession[]> {
  const { rows } = await pool.query<UnresolvedSession>(
    `SELECT s.id, s.piece_id, s.referrer_url, s.referrer_domain,
            s.utm_source, s.utm_medium, p.writer_id
     FROM traffology.sessions s
     JOIN traffology.pieces p ON p.id = s.piece_id
     WHERE s.id = $1 AND s.resolved_source_id IS NULL`,
    [sessionId]
  )
  return rows
}

async function fetchUnresolvedSessions(): Promise<UnresolvedSession[]> {
  const { rows } = await pool.query<UnresolvedSession>(
    `SELECT s.id, s.piece_id, s.referrer_url, s.referrer_domain,
            s.utm_source, s.utm_medium, p.writer_id
     FROM traffology.sessions s
     JOIN traffology.pieces p ON p.id = s.piece_id
     WHERE s.resolved_source_id IS NULL
     ORDER BY s.started_at DESC
     LIMIT 1000`
  )
  return rows
}

async function resolveSession(session: UnresolvedSession): Promise<string | null> {
  const { referrer_domain, referrer_url, utm_source, utm_medium, writer_id } = session

  // No referrer at all → direct traffic
  if (!referrer_domain && !utm_source) {
    return findOrCreateSource(writer_id, {
      sourceType: 'direct',
      domain: null,
      displayName: 'Direct',
    })
  }

  // UTM source hint for mailing list
  if (utm_medium === 'email' || utm_source === 'newsletter') {
    const displayName = utm_source && utm_source !== 'newsletter'
      ? utm_source
      : 'Email / newsletter'
    return findOrCreateSource(writer_id, {
      sourceType: 'mailing-list',
      domain: referrer_domain,
      displayName,
    })
  }

  if (!referrer_domain) {
    return findOrCreateSource(writer_id, {
      sourceType: 'direct',
      domain: null,
      displayName: utm_source ? `${utm_source} (UTM)` : 'Direct',
    })
  }

  // Step 1: Platform-internal (all.haus URLs)
  if (referrer_domain === 'all.haus' || referrer_domain === 'www.all.haus') {
    return resolvePlatformInternal(writer_id, referrer_url)
  }

  // Step 2: Nostr — deferred to Phase 2 (handled by known Nostr client domains for now)

  // Step 3: Known domain lookup
  const known = KNOWN_DOMAINS[referrer_domain]
  if (known) {
    return findOrCreateSource(writer_id, {
      sourceType: known.sourceType,
      domain: referrer_domain,
      displayName: known.displayName,
    })
  }

  // Step 4: Shortener redirect following
  if (SHORTENER_DOMAINS.has(referrer_domain)) {
    return resolveShortener(writer_id, referrer_url, referrer_domain)
  }

  // Step 5: Raw domain fallback
  return findOrCreateSource(writer_id, {
    sourceType: 'link',
    domain: referrer_domain,
    displayName: referrer_domain,
  })
}

// =============================================================================
// Step 1: Platform-internal resolution
// =============================================================================

async function resolvePlatformInternal(
  writerId: string,
  referrerUrl: string | null
): Promise<string> {
  // Try to extract the referring writer's slug from the URL
  // all.haus URLs: /username/piece-slug or /username
  let displayName = 'all.haus'
  let allhausWriterId: string | null = null

  if (referrerUrl) {
    const match = referrerUrl.match(/all\.haus\/(@?[\w-]+)/)
    if (match) {
      const slug = match[1].replace(/^@/, '')
      // Look up the referring writer
      const { rows } = await pool.query<{ id: string; display_name: string }>(
        `SELECT id, display_name FROM public.accounts WHERE username = $1`,
        [slug]
      )
      if (rows.length > 0) {
        displayName = rows[0].display_name || slug
        allhausWriterId = rows[0].id
      } else {
        displayName = slug
      }
    }
  }

  return findOrCreateSource(writerId, {
    sourceType: 'platform-internal',
    domain: 'all.haus',
    displayName,
    allhausWriterId,
  })
}

// =============================================================================
// Step 4: Shortener redirect following
// =============================================================================

async function resolveShortener(
  writerId: string,
  referrerUrl: string | null,
  shortenerDomain: string
): Promise<string> {
  if (referrerUrl) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 3000)

      const response = await fetch(referrerUrl, {
        method: 'HEAD',
        redirect: 'manual',
        signal: controller.signal,
      })
      clearTimeout(timeout)

      const location = response.headers.get('location')
      if (location) {
        const destDomain = extractDomain(location)
        if (destDomain) {
          // Check if destination is a known domain
          const known = KNOWN_DOMAINS[destDomain]
          if (known) {
            return findOrCreateSource(writerId, {
              sourceType: known.sourceType,
              domain: destDomain,
              displayName: known.displayName,
            })
          }
          // Use destination domain as display name
          return findOrCreateSource(writerId, {
            sourceType: 'link',
            domain: destDomain,
            displayName: destDomain,
          })
        }
      }
    } catch {
      // Redirect failed or timed out — fall through to fallback
    }
  }

  // Fallback: use known shortener mapping or raw domain
  const fallback = SHORTENER_FALLBACKS[shortenerDomain]
  return findOrCreateSource(writerId, {
    sourceType: 'link',
    domain: shortenerDomain,
    displayName: fallback ?? shortenerDomain,
  })
}

// =============================================================================
// Source upsert
// =============================================================================

interface SourceParams {
  sourceType: string
  domain: string | null
  displayName: string
  allhausWriterId?: string | null
}

async function findOrCreateSource(
  writerId: string,
  params: SourceParams
): Promise<string> {
  const { sourceType, domain, displayName, allhausWriterId } = params

  // Try to find existing source for this writer with matching type + domain
  const { rows: existing } = await pool.query<{ id: string }>(
    `SELECT id FROM traffology.sources
     WHERE writer_id = $1 AND source_type = $2
       AND (domain = $3 OR (domain IS NULL AND $3 IS NULL))
       AND display_name = $4
     LIMIT 1`,
    [writerId, sourceType, domain, displayName]
  )

  if (existing.length > 0) {
    return existing[0].id
  }

  // Create new source
  const { rows: created } = await pool.query<{ id: string }>(
    `INSERT INTO traffology.sources
       (writer_id, source_type, domain, display_name, allhaus_writer_id, is_new_for_writer)
     VALUES ($1, $2, $3, $4, $5, TRUE)
     RETURNING id`,
    [writerId, sourceType, domain, displayName, allhausWriterId ?? null]
  )

  logger.info(
    { writerId, sourceType, domain, displayName },
    'New source created'
  )

  return created[0].id
}

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

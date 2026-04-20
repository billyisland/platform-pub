import type { FastifyInstance } from 'fastify'
import { createHmac } from 'crypto'
import { pool } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../../middleware/auth.js'
import { checkArticleAccess, recordSubscriptionRead, recordPurchaseUnlock } from '../../services/access.js'
import logger from '@platform-pub/shared/lib/logger.js'
import {
  KEY_SERVICE_URL,
  PAYMENT_SERVICE_URL,
  READER_HASH_KEY,
  INTERNAL_SERVICE_TOKEN,
  proxyToService,
} from './shared.js'

// =============================================================================
// Vault/key proxies + full gate-pass orchestration
//
// POST  /articles/:nostrEventId/vault      — Proxy to key service (vault create)
// PATCH /articles/:nostrEventId/vault      — Proxy to key service (vault ID update)
// POST  /articles/:nostrEventId/key        — Proxy to key service (key issuance)
// POST  /articles/:nostrEventId/gate-pass  — Record gate pass + proxy to payment
// =============================================================================

export async function articleGatePassRoutes(app: FastifyInstance) {
  app.post<{ Params: { nostrEventId: string } }>(
    '/articles/:nostrEventId/vault',
    { preHandler: requireAuth },
    async (req, reply) => {
      // Inject writer identity so the key service can verify ownership
      req.headers['x-writer-id'] = req.session!.sub!
      return proxyToService(
        `${KEY_SERVICE_URL}/api/v1/articles/${req.params.nostrEventId}/vault`,
        'POST',
        req,
        reply
      )
    }
  )

  app.patch<{ Params: { nostrEventId: string } }>(
    '/articles/:nostrEventId/vault',
    { preHandler: requireAuth },
    async (req, reply) => {
      // Inject writer identity so the key service can verify ownership
      req.headers['x-writer-id'] = req.session!.sub!
      return proxyToService(
        `${KEY_SERVICE_URL}/api/v1/articles/${req.params.nostrEventId}/vault`,
        'PATCH',
        req,
        reply
      )
    }
  )

  app.post<{ Params: { nostrEventId: string } }>(
    '/articles/:nostrEventId/key',
    { preHandler: requireAuth },
    async (req, reply) => {
      return proxyToService(
        `${KEY_SERVICE_URL}/api/v1/articles/${req.params.nostrEventId}/key`,
        'POST',
        req,
        reply
      )
    }
  )

  // ---------------------------------------------------------------------------
  // POST /articles/:nostrEventId/gate-pass
  //
  // The full gate-pass flow. Called by the web client when a reader passes
  // a paywall gate. Orchestrates:
  //   1. Look up article + reader tab info
  //   2. Call payment service /gate-pass to record the read
  //   3. If successful, call key service to issue the content key
  //   4. Return the encrypted key to the client
  //
  // This is the single call the web client makes on gate pass — it doesn't
  // need to know about the internal service split.
  // ---------------------------------------------------------------------------

  app.post<{ Params: { nostrEventId: string } }>(
    '/articles/:nostrEventId/gate-pass',
    { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const readerId = req.session!.sub!
      const readerPubkey = req.session!.pubkey
      const { nostrEventId } = req.params

      try {
        // Step 1: Look up article and reader tab
        const articleRow = await pool.query<{
          id: string
          writer_id: string
          price_pence: number
          access_mode: string
          publication_id: string | null
        }>(
          `SELECT id, writer_id, price_pence, access_mode, publication_id
           FROM articles WHERE nostr_event_id = $1`,
          [nostrEventId]
        )

        if (articleRow.rows.length === 0) {
          return reply.status(404).send({ error: 'Article not found' })
        }

        const article = articleRow.rows[0]
        if (article.access_mode === 'public') {
          return reply.status(400).send({ error: 'Article is not gated' })
        }

        // Check for free access (own content, permanent unlock, subscription)
        const access = await checkArticleAccess(readerId, article.id, article.writer_id, article.publication_id)
        if (access.hasAccess) {
          // If subscription read, record the zero-cost read + permanent unlock
          if (access.reason === 'subscription' && access.subscriptionId) {
            await recordSubscriptionRead(readerId, article.id, article.writer_id, access.subscriptionId)
          }

          // Issue content key without charging (idempotent — covers retry after
          // a previous gate-pass that charged but crashed before unlock was recorded)
          const keyRes = await fetch(
            `${KEY_SERVICE_URL}/api/v1/articles/${nostrEventId}/key`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-reader-id': readerId,
                'x-reader-pubkey': readerPubkey,
              },
              body: JSON.stringify({}),
            }
          )

          if (!keyRes.ok) {
            return reply.status(502).send({ error: 'Key issuance failed' })
          }

          const keyResult = await keyRes.json() as any
          return reply.status(200).send({
            readEventId: null,
            readState: access.reason,
            encryptedKey: keyResult.encryptedKey,
            algorithm: keyResult.algorithm,
            isReissuance: access.reason === 'already_unlocked',
            ciphertext: keyResult.ciphertext ?? undefined,
          })
        }

        // Invitation-only articles cannot be purchased — access is by author grant only
        if (article.access_mode === 'invitation_only') {
          return reply.status(403).send({
            error: 'invitation_required',
            message: 'This is a private article. Contact the author to request access.',
          })
        }

        // Get or create reader's tab
        let tabRow = await pool.query<{ id: string }>(
          'SELECT id FROM reading_tabs WHERE reader_id = $1',
          [readerId]
        )

        if (tabRow.rows.length === 0) {
          tabRow = await pool.query<{ id: string }>(
            `INSERT INTO reading_tabs (reader_id)
             VALUES ($1)
             ON CONFLICT (reader_id) DO NOTHING
             RETURNING id`,
            [readerId]
          )
          if (tabRow.rows.length === 0) {
            tabRow = await pool.query<{ id: string }>(
              'SELECT id FROM reading_tabs WHERE reader_id = $1',
              [readerId]
            )
          }
        }

        const tabId = tabRow.rows[0].id

        // Compute reader pubkey hash (keyed HMAC for privacy)
        if (!READER_HASH_KEY) {
          logger.error('READER_HASH_KEY not set — cannot compute reader pubkey hash')
          return reply.status(500).send({ error: 'Server misconfiguration: READER_HASH_KEY not set' })
        }
        const readerPubkeyHash = createHmac('sha256', READER_HASH_KEY)
          .update(readerPubkey)
          .digest('hex')

        // Step 2: Record gate pass via payment service
        const paymentRes = await fetch(`${PAYMENT_SERVICE_URL}/api/v1/gate-pass`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-token': INTERNAL_SERVICE_TOKEN,
          },
          body: JSON.stringify({
            readerId,
            articleId: article.id,
            writerId: article.writer_id,
            amountPence: article.price_pence,
            readerPubkey,
            readerPubkeyHash,
            tabId,
          }),
        })

        if (!paymentRes.ok) {
          const body = await paymentRes.json().catch(() => null) as any
          const status = paymentRes.status

          if (status === 402) {
            return reply.status(402).send({
              error: body?.error ?? 'payment_required',
              message: 'Payment required.',
            })
          }

          logger.error({ status, body }, 'Payment service gate-pass failed')
          return reply.status(500).send({ error: 'Gate pass recording failed' })
        }

        const paymentResult = await paymentRes.json() as any

        // Record permanent unlock immediately after payment succeeds.
        // This ensures a retry (if key issuance fails below) hits
        // checkArticleAccess → 'already_unlocked' and skips re-charging.
        await recordPurchaseUnlock(readerId, article.id)

        // Step 3: Request content key from key service
        const keyRes = await fetch(
          `${KEY_SERVICE_URL}/api/v1/articles/${nostrEventId}/key`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-reader-id': readerId,
              'x-reader-pubkey': readerPubkey,
            },
            body: JSON.stringify({}),
          }
        )

        if (!keyRes.ok) {
          const keyBody = await keyRes.json().catch(() => null)
          logger.error(
            { status: keyRes.status, body: keyBody, readerId, nostrEventId },
            'Key service issuance failed after gate pass'
          )
          // Payment recorded and unlock persisted — retry will skip payment
          // and go straight to key issuance via the 'already_unlocked' path.
          return reply.status(502).send({
            error: 'Key issuance failed — the read has been recorded. Retry to get the content key.',
            readEventId: paymentResult.readEventId,
          })
        }

        const keyResult = await keyRes.json() as any

        logger.info(
          { readerId, nostrEventId, readEventId: paymentResult.readEventId },
          'Gate pass complete — key issued'
        )

        return reply.status(200).send({
          readEventId: paymentResult.readEventId,
          readState: paymentResult.state,
          encryptedKey: keyResult.encryptedKey,
          algorithm: keyResult.algorithm,
          isReissuance: keyResult.isReissuance,
          allowanceJustExhausted: paymentResult.allowanceJustExhausted ?? false,
          ciphertext: keyResult.ciphertext ?? undefined,
        })
      } catch (err: any) {
        logger.error({ err, readerId, nostrEventId }, 'Gate pass orchestration failed')
        // Distinguish service-connectivity errors from other failures
        const isNetworkError = err?.cause?.code === 'ECONNREFUSED' ||
          err?.cause?.code === 'ENOTFOUND' ||
          err?.code === 'ECONNREFUSED' ||
          err?.message?.includes('fetch failed')
        if (isNetworkError) {
          return reply.status(502).send({ error: 'Payment or key service unreachable' })
        }
        return reply.status(500).send({ error: 'Internal error' })
      }
    }
  )
}

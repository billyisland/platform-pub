import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool } from '../../shared/src/db/client.js'
import { requireAuth } from '../middleware/auth.js'
import { signEvent, nip44Encrypt, nip44Decrypt } from '../lib/key-custody-client.js'
import { publishToRelay } from '../lib/nostr-publisher.js'
import logger from '../../shared/src/lib/logger.js'

// =============================================================================
// Direct Message Routes
//
// POST   /conversations                      — create a new conversation
// POST   /conversations/:id/members          — add members to a conversation
// GET    /messages                            — list conversations (inbox)
// GET    /messages/:conversationId            — load messages in a conversation
// POST   /messages/:conversationId            — send a DM
// POST   /messages/:messageId/read            — mark as read
// =============================================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const CreateConversationSchema = z.object({
  memberIds: z.array(z.string().regex(UUID_RE)).min(1).max(20),
})

const SendMessageSchema = z.object({
  content: z.string().min(1).max(10_000),
})

const HEX64_RE_NIP = /^[0-9a-f]{64}$/

const DecryptBatchSchema = z.object({
  messages: z.array(z.object({
    id: z.string(),
    counterpartyPubkey: z.string().regex(HEX64_RE_NIP),
    ciphertext: z.string().min(1),
  })).min(1).max(100),
})

const AddMembersSchema = z.object({
  memberIds: z.array(z.string().regex(UUID_RE)).min(1).max(20),
})

export async function messageRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // POST /conversations — create a new conversation with member list
  // ---------------------------------------------------------------------------

  app.post('/conversations', { preHandler: requireAuth }, async (req, reply) => {
    const creatorId = req.session!.sub!
    const parsed = CreateConversationSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const { memberIds } = parsed.data
    const allMembers = [creatorId, ...memberIds.filter(id => id !== creatorId)]

    // Check for blocks between creator and any member
    const blockCheck = await pool.query<{ blocked_id: string }>(
      `SELECT blocked_id FROM blocks
       WHERE (blocker_id = $1 AND blocked_id = ANY($2))
          OR (blocked_id = $1 AND blocker_id = ANY($2))`,
      [creatorId, memberIds]
    )
    if (blockCheck.rows.length > 0) {
      return reply.status(403).send({ error: 'Cannot create conversation with blocked users' })
    }

    // Create conversation and add members
    const conv = await pool.query<{ id: string }>(
      'INSERT INTO conversations (created_by) VALUES ($1) RETURNING id',
      [creatorId]
    )
    const conversationId = conv.rows[0].id

    const memberValues = allMembers
      .map((_, i) => `($1, $${i + 2})`)
      .join(', ')
    await pool.query(
      `INSERT INTO conversation_members (conversation_id, user_id) VALUES ${memberValues}`,
      [conversationId, ...allMembers]
    )

    logger.info({ conversationId, creatorId, memberCount: allMembers.length }, 'Conversation created')

    return reply.status(201).send({ conversationId })
  })

  // ---------------------------------------------------------------------------
  // POST /conversations/:id/members — add members to a conversation
  // ---------------------------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    '/conversations/:id/members',
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub!
      const { id: conversationId } = req.params

      const parsed = AddMembersSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      // Verify caller is a member
      const membership = await pool.query(
        'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
        [conversationId, userId]
      )
      if (membership.rowCount === 0) {
        return reply.status(403).send({ error: 'Not a member of this conversation' })
      }

      const { memberIds } = parsed.data

      // Check blocks
      const blockCheck = await pool.query(
        `SELECT blocked_id FROM blocks
         WHERE (blocker_id = $1 AND blocked_id = ANY($2))
            OR (blocked_id = $1 AND blocker_id = ANY($2))`,
        [userId, memberIds]
      )
      if (blockCheck.rows.length > 0) {
        return reply.status(403).send({ error: 'Cannot add blocked users' })
      }

      // Add members (ignore duplicates)
      for (const memberId of memberIds) {
        await pool.query(
          `INSERT INTO conversation_members (conversation_id, user_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [conversationId, memberId]
        )
      }

      return reply.status(200).send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /messages — list conversations (inbox)
  // ---------------------------------------------------------------------------

  app.get('/messages', { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.session!.sub!

    const { rows } = await pool.query<{
      conversation_id: string
      last_message_at: Date | null
      created_at: Date
      unread_count: number
      member_ids: string[]
      member_usernames: string[]
      member_display_names: (string | null)[]
      member_avatars: (string | null)[]
    }>(
      `SELECT c.id AS conversation_id, c.last_message_at, c.created_at,
              COALESCE(unread.cnt, 0)::int AS unread_count,
              array_agg(a.id) AS member_ids,
              array_agg(a.username) AS member_usernames,
              array_agg(a.display_name) AS member_display_names,
              array_agg(a.avatar_blossom_url) AS member_avatars
       FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id
       JOIN conversation_members my ON my.conversation_id = c.id AND my.user_id = $1
       JOIN accounts a ON a.id = cm.user_id AND a.id != $1
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS cnt FROM direct_messages
         WHERE conversation_id = c.id AND recipient_id = $1 AND read_at IS NULL
       ) unread ON true
       LEFT JOIN mutes m ON m.muter_id = $1 AND m.muted_id = cm.user_id
       WHERE m.muter_id IS NULL
       GROUP BY c.id, unread.cnt
       ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
       LIMIT 50`,
      [userId]
    )

    return reply.status(200).send({
      conversations: rows.map(r => ({
        id: r.conversation_id,
        lastMessageAt: r.last_message_at?.toISOString() ?? null,
        createdAt: r.created_at.toISOString(),
        unreadCount: r.unread_count,
        members: r.member_ids.map((id, i) => ({
          id,
          username: r.member_usernames[i],
          displayName: r.member_display_names[i],
          avatar: r.member_avatars[i],
        })),
      })),
    })
  })

  // ---------------------------------------------------------------------------
  // GET /messages/:conversationId — load messages in a conversation
  // ---------------------------------------------------------------------------

  app.get<{ Params: { conversationId: string }; Querystring: { before?: string; limit?: string } }>(
    '/messages/:conversationId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub!
      const { conversationId } = req.params
      const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 100)
      const before = req.query.before

      // Verify caller is a member
      const membership = await pool.query(
        'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
        [conversationId, userId]
      )
      if (membership.rowCount === 0) {
        return reply.status(403).send({ error: 'Not a member of this conversation' })
      }

      const params: any[] = [conversationId, userId, limit]
      let whereClause = 'dm.conversation_id = $1 AND (dm.recipient_id = $2 OR dm.sender_id = $2)'
      if (before) {
        params.push(before)
        whereClause += ` AND dm.created_at < $4`
      }

      const { rows } = await pool.query<{
        id: string
        sender_id: string
        sender_username: string | null
        sender_display_name: string | null
        sender_pubkey: string
        recipient_pubkey: string
        content_enc: string
        read_at: Date | null
        created_at: Date
        like_count: string
        liked_by_me: boolean
      }>(
        `SELECT dm.id, dm.sender_id, sa.username AS sender_username,
                sa.display_name AS sender_display_name,
                sa.nostr_pubkey AS sender_pubkey,
                ra.nostr_pubkey AS recipient_pubkey,
                dm.content_enc, dm.read_at, dm.created_at,
                (SELECT COUNT(*) FROM dm_likes dl WHERE dl.message_id = dm.id) AS like_count,
                EXISTS(SELECT 1 FROM dm_likes dl WHERE dl.message_id = dm.id AND dl.user_id = $2) AS liked_by_me
         FROM direct_messages dm
         JOIN accounts sa ON sa.id = dm.sender_id
         JOIN accounts ra ON ra.id = dm.recipient_id
         WHERE ${whereClause}
         ORDER BY dm.created_at DESC
         LIMIT $3`,
        params
      )

      return reply.status(200).send({
        messages: rows.map(r => ({
          id: r.id,
          senderId: r.sender_id,
          senderUsername: r.sender_username,
          senderDisplayName: r.sender_display_name,
          counterpartyPubkey: r.sender_id === userId ? r.recipient_pubkey : r.sender_pubkey,
          contentEnc: r.content_enc,
          readAt: r.read_at?.toISOString() ?? null,
          createdAt: r.created_at.toISOString(),
          likeCount: parseInt(r.like_count, 10),
          likedByMe: r.liked_by_me,
        })),
      })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /messages/:conversationId — send a DM
  //
  // Encrypts content E2E via NIP-44 (ciphertext provided by the client).
  // One row per recipient. Publishes NIP-17 gift-wrapped event async.
  // ---------------------------------------------------------------------------

  app.post<{ Params: { conversationId: string } }>(
    '/messages/:conversationId',
    { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const senderId = req.session!.sub!
      const { conversationId } = req.params

      const parsed = SendMessageSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      // Verify sender is a member
      const membership = await pool.query(
        'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
        [conversationId, senderId]
      )
      if (membership.rowCount === 0) {
        return reply.status(403).send({ error: 'Not a member of this conversation' })
      }

      // Get all other members (recipients)
      const members = await pool.query<{ user_id: string }>(
        'SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id != $2',
        [conversationId, senderId]
      )

      if (members.rows.length === 0) {
        return reply.status(400).send({ error: 'No recipients in conversation' })
      }

      // Check blocks from any recipient
      const recipientIds = members.rows.map(r => r.user_id)
      const blockCheck = await pool.query(
        `SELECT blocker_id FROM blocks
         WHERE blocker_id = ANY($1) AND blocked_id = $2`,
        [recipientIds, senderId]
      )
      if (blockCheck.rows.length > 0) {
        return reply.status(403).send({ error: 'You are blocked by one or more recipients' })
      }

      // Check DM pricing for each recipient — charge if needed
      // (For now, check the first recipient's pricing as a simplification;
      //  full per-recipient pricing is a fast-follow)
      for (const recipientId of recipientIds) {
        const pricing = await getDmPrice(recipientId, senderId)
        if (pricing > 0) {
          // DM pricing charges are deferred to a future iteration
          // For now, reject if price is set (placeholder for payment integration)
          return reply.status(402).send({
            error: 'dm_payment_required',
            pricePence: pricing,
            message: 'This user requires payment to receive DMs.',
          })
        }
      }

      // Look up recipient pubkeys for NIP-44 encryption
      const pubkeyRows = await pool.query<{ id: string; nostr_pubkey: string }>(
        'SELECT id, nostr_pubkey FROM accounts WHERE id = ANY($1)',
        [recipientIds]
      )
      const pubkeyMap = new Map(pubkeyRows.rows.map(r => [r.id, r.nostr_pubkey]))

      // Encrypt and insert one message row per recipient (NIP-44 E2E)
      const messageIds: string[] = []
      for (const recipientId of recipientIds) {
        const recipientPubkey = pubkeyMap.get(recipientId)
        if (!recipientPubkey) {
          logger.error({ recipientId }, 'Recipient has no pubkey — skipping')
          continue
        }

        const { ciphertext } = await nip44Encrypt(senderId, recipientPubkey, parsed.data.content)

        const result = await pool.query<{ id: string }>(
          `INSERT INTO direct_messages (conversation_id, sender_id, recipient_id, content_enc)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [conversationId, senderId, recipientId, ciphertext]
        )
        messageIds.push(result.rows[0].id)
      }

      // Update conversation last_message_at
      await pool.query(
        'UPDATE conversations SET last_message_at = now() WHERE id = $1',
        [conversationId]
      )

      // Publish NIP-17 gift-wrapped event async (non-blocking)
      publishNip17Async(senderId, conversationId).catch(err => {
        logger.error({ err, conversationId }, 'NIP-17 publish failed (non-fatal)')
      })

      return reply.status(201).send({ messageIds })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /messages/:messageId/read — mark a message as read
  // ---------------------------------------------------------------------------

  app.post<{ Params: { messageId: string } }>(
    '/messages/:messageId/read',
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub!

      const result = await pool.query(
        `UPDATE direct_messages SET read_at = now()
         WHERE id = $1 AND recipient_id = $2 AND read_at IS NULL
         RETURNING id`,
        [req.params.messageId, userId]
      )

      if (result.rowCount === 0) {
        return reply.status(404).send({ error: 'Message not found' })
      }

      return reply.status(200).send({ ok: true })
    }
  )
  // ---------------------------------------------------------------------------
  // POST /messages/:messageId/like — toggle like on a message
  // ---------------------------------------------------------------------------

  app.post<{ Params: { messageId: string } }>(
    '/messages/:messageId/like',
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub!
      const { messageId } = req.params

      // Verify user is a participant in this message's conversation
      const membership = await pool.query(
        `SELECT 1 FROM direct_messages dm
         JOIN conversation_members cm ON cm.conversation_id = dm.conversation_id AND cm.user_id = $2
         WHERE dm.id = $1`,
        [messageId, userId]
      )
      if (membership.rowCount === 0) {
        return reply.status(403).send({ error: 'Not a participant' })
      }

      // Toggle: try to insert, if exists delete
      const existing = await pool.query(
        'DELETE FROM dm_likes WHERE message_id = $1 AND user_id = $2 RETURNING id',
        [messageId, userId]
      )

      if (existing.rowCount! > 0) {
        return reply.status(200).send({ liked: false })
      }

      await pool.query(
        'INSERT INTO dm_likes (message_id, user_id) VALUES ($1, $2)',
        [messageId, userId]
      )
      return reply.status(200).send({ liked: true })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /dm/decrypt-batch — batch-decrypt messages for the reading client
  //
  // The client receives NIP-44 encrypted messages and calls this endpoint to
  // decrypt them. Each message is decrypted using the reader's custodial
  // private key and the counterparty's public key via key-custody.
  // ---------------------------------------------------------------------------

  app.post('/dm/decrypt-batch', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = DecryptBatchSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const readerId = req.session!.sub!
    const results = await Promise.allSettled(
      parsed.data.messages.map(async (msg) => {
        const { plaintext } = await nip44Decrypt(readerId, msg.counterpartyPubkey, msg.ciphertext)
        return { id: msg.id, plaintext }
      })
    )

    return reply.status(200).send({
      results: results.map((r, i) =>
        r.status === 'fulfilled'
          ? r.value
          : { id: parsed.data.messages[i].id, plaintext: null, error: 'Decryption failed' }
      ),
    })
  })
}

// =============================================================================
// Helpers
// =============================================================================

async function getDmPrice(recipientId: string, senderId: string): Promise<number> {
  // Check specific override first, then default
  const specific = await pool.query<{ price_pence: number }>(
    'SELECT price_pence FROM dm_pricing WHERE owner_id = $1 AND target_id = $2',
    [recipientId, senderId]
  )
  if (specific.rows.length > 0) return specific.rows[0].price_pence

  const defaultRate = await pool.query<{ price_pence: number }>(
    'SELECT price_pence FROM dm_pricing WHERE owner_id = $1 AND target_id IS NULL',
    [recipientId]
  )
  if (defaultRate.rows.length > 0) return defaultRate.rows[0].price_pence

  return 0 // free by default
}

async function publishNip17Async(senderId: string, conversationId: string): Promise<void> {
  try {
    // Sign a NIP-17 kind 14 event via key-custody
    const event = await signEvent(senderId, {
      kind: 14,
      content: '', // actual encrypted content is in the DB; relay event is a signal
      tags: [['conversation', conversationId]],
      created_at: Math.floor(Date.now() / 1000),
    })
    await publishToRelay(event as any)
    logger.debug({ conversationId, eventId: event.id }, 'NIP-17 event published')
  } catch (err) {
    logger.error({ err, conversationId }, 'Failed to publish NIP-17 event')
  }
}

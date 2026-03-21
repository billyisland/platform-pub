import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool } from '../../shared/src/db/client.js'
import { requireAuth } from '../middleware/auth.js'
import logger from '../../shared/src/lib/logger.js'

// =============================================================================
// Follow Routes
//
// POST   /follows/:writerId    — follow a writer
// DELETE /follows/:writerId    — unfollow a writer
// GET    /follows/pubkeys      — list followed writer pubkeys (for feed filter)
// GET    /follows              — list followed writers with display info
//
// Follow relationships are stored in the platform DB (follows table) and
// also published as kind 3 contact list events to the relay. The DB is the
// source of truth for feed assembly; the relay events enable portability.
// =============================================================================

export async function followRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // POST /follows/:writerId — follow a writer
  // ---------------------------------------------------------------------------

  app.post<{ Params: { writerId: string } }>(
    '/follows/:writerId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const followerId = req.session!.sub!
      const { writerId } = req.params

      if (followerId === writerId) {
        return reply.status(400).send({ error: 'Cannot follow yourself' })
      }

      // Verify the target is a writer
      const writerCheck = await pool.query<{ id: string }>(
        `SELECT id FROM accounts WHERE id = $1 AND is_writer = TRUE AND status = 'active'`,
        [writerId]
      )

      if (writerCheck.rows.length === 0) {
        return reply.status(404).send({ error: 'Writer not found' })
      }

      // Upsert — idempotent
      await pool.query(
        `INSERT INTO follows (follower_id, followee_id)
         VALUES ($1, $2)
         ON CONFLICT (follower_id, followee_id) DO NOTHING`,
        [followerId, writerId]
      )

      logger.info({ followerId, writerId }, 'Follow created')

      return reply.status(200).send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // DELETE /follows/:writerId — unfollow a writer
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { writerId: string } }>(
    '/follows/:writerId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const followerId = req.session!.sub!
      const { writerId } = req.params

      await pool.query(
        'DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2',
        [followerId, writerId]
      )

      logger.info({ followerId, writerId }, 'Follow removed')

      return reply.status(200).send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /follows/pubkeys — list followed writer pubkeys
  //
  // Used by the feed to filter relay queries. Returns just the hex pubkeys
  // for minimal payload size.
  // ---------------------------------------------------------------------------

  app.get(
    '/follows/pubkeys',
    { preHandler: requireAuth },
    async (req, reply) => {
      const followerId = req.session!.sub!

      const { rows } = await pool.query<{ nostr_pubkey: string }>(
        `SELECT a.nostr_pubkey
         FROM follows f
         JOIN accounts a ON a.id = f.followee_id
         WHERE f.follower_id = $1 AND a.status = 'active'`,
        [followerId]
      )

      return reply.status(200).send({
        pubkeys: rows.map((r) => r.nostr_pubkey),
      })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /follows — list followed writers with display info
  //
  // Used by the settings/profile page to show who the reader follows.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // GET /follows/followers — list accounts who follow you
  // ---------------------------------------------------------------------------

  app.get(
    '/follows/followers',
    { preHandler: requireAuth },
    async (req, reply) => {
      const followeeId = req.session!.sub!

      const { rows } = await pool.query<{
        id: string
        username: string
        display_name: string | null
        avatar_blossom_url: string | null
        nostr_pubkey: string
        is_writer: boolean
        followed_at: Date
      }>(
        `SELECT a.id, a.username, a.display_name, a.avatar_blossom_url,
                a.nostr_pubkey, a.is_writer, f.followed_at
         FROM follows f
         JOIN accounts a ON a.id = f.follower_id
         WHERE f.followee_id = $1 AND a.status = 'active'
         ORDER BY f.followed_at DESC`,
        [followeeId]
      )

      const followers = rows.map((r) => ({
        id: r.id,
        username: r.username,
        displayName: r.display_name,
        avatar: r.avatar_blossom_url,
        pubkey: r.nostr_pubkey,
        isWriter: r.is_writer,
        followedAt: r.followed_at.toISOString(),
      }))

      return reply.status(200).send({ followers })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /follows — list followed writers with display info
  //
  // Used by the settings/profile page to show who the reader follows.
  // ---------------------------------------------------------------------------

  app.get(
    '/follows',
    { preHandler: requireAuth },
    async (req, reply) => {
      const followerId = req.session!.sub!

      const { rows } = await pool.query<{
        id: string
        username: string
        display_name: string | null
        avatar_blossom_url: string | null
        nostr_pubkey: string
        followed_at: Date
      }>(
        `SELECT a.id, a.username, a.display_name, a.avatar_blossom_url,
                a.nostr_pubkey, f.followed_at
         FROM follows f
         JOIN accounts a ON a.id = f.followee_id
         WHERE f.follower_id = $1 AND a.status = 'active'
         ORDER BY f.followed_at DESC`,
        [followerId]
      )

      const writers = rows.map((r) => ({
        id: r.id,
        username: r.username,
        displayName: r.display_name,
        avatar: r.avatar_blossom_url,
        pubkey: r.nostr_pubkey,
        followedAt: r.followed_at.toISOString(),
      }))

      return reply.status(200).send({ writers })
    }
  )
}

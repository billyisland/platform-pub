import type { FastifyInstance } from "fastify";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import { requireAuth } from "../../middleware/auth.js";
import { signSubscriptionEvent } from "../../lib/nostr-publisher.js";
import { enqueueRelayPublish } from "@platform-pub/shared/lib/relay-outbox.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { logSubscriptionCharge } from "./shared.js";

// =============================================================================
// Publication subscriptions
//
// POST   /subscriptions/publication/:id — Subscribe to a publication
// DELETE /subscriptions/publication/:id — Cancel publication subscription
// =============================================================================

export async function subscriptionPublicationRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string }; Body: { period?: string } }>(
    "/subscriptions/publication/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      const readerId = req.session!.sub;
      const { id: publicationId } = req.params;
      const body = req.body as { period?: string };
      const period = body?.period === "annual" ? "annual" : "monthly";

      return withTransaction(async (client) => {
        const { rows: pubs } = await client.query<{
          subscription_price_pence: number;
          annual_discount_pct: number;
          name: string;
          nostr_pubkey: string;
        }>(
          `SELECT subscription_price_pence, annual_discount_pct, name, nostr_pubkey
           FROM publications WHERE id = $1 AND status = 'active'`,
          [publicationId],
        );
        if (pubs.length === 0) {
          return reply.status(404).send({ error: "Publication not found" });
        }

        const pub = pubs[0];
        const pricePence =
          period === "annual"
            ? Math.round(
                pub.subscription_price_pence *
                  12 *
                  (1 - pub.annual_discount_pct / 100),
              )
            : pub.subscription_price_pence;

        const existing = await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM subscriptions
           WHERE reader_id = $1 AND publication_id = $2`,
          [readerId, publicationId],
        );

        const now = new Date();
        const periodDays = period === "annual" ? 365 : 30;
        const periodEnd = new Date(
          now.getTime() + periodDays * 24 * 60 * 60 * 1000,
        );
        const readerPubkey = req.session!.pubkey;

        if (existing.rows.length > 0) {
          const sub = existing.rows[0];
          if (sub.status === "active") {
            return reply.status(409).send({ error: "Already subscribed" });
          }

          await client.query(
            `UPDATE subscriptions
             SET status = 'active', auto_renew = TRUE, cancelled_at = NULL,
                 current_period_start = $1, current_period_end = $2,
                 price_pence = $3, subscription_period = $5, updated_at = now()
             WHERE id = $4`,
            [now, periodEnd, pricePence, sub.id, period],
          );

          await client.query(
            `UPDATE accounts SET free_allowance_remaining_pence = free_allowance_remaining_pence - $1, updated_at = now() WHERE id = $2`,
            [pricePence, readerId],
          );
          await logSubscriptionCharge(
            client,
            sub.id,
            readerId,
            null,
            pricePence,
            now,
            periodEnd,
            publicationId,
          );

          const reactivateEvent = signSubscriptionEvent({
            subscriptionId: sub.id,
            readerPubkey,
            writerPubkey: pub.nostr_pubkey,
            status: "active",
            pricePence,
            periodStart: now,
            periodEnd,
          });
          await client.query(
            `UPDATE subscriptions SET nostr_event_id = $1 WHERE id = $2`,
            [reactivateEvent.id, sub.id],
          );
          await enqueueRelayPublish(client, {
            entityType: "subscription",
            entityId: sub.id,
            signedEvent: reactivateEvent,
          });

          pool
            .query(
              `INSERT INTO notifications (recipient_id, actor_id, type)
               SELECT pm.account_id, $1, 'pub_new_subscriber'
               FROM publication_members pm
               WHERE pm.publication_id = $2 AND pm.can_manage_finances = TRUE
                 AND pm.removed_at IS NULL
               ON CONFLICT DO NOTHING`,
              [readerId, publicationId],
            )
            .catch((err) =>
              logger.warn({ err }, "Failed to notify pub_new_subscriber"),
            );

          return reply
            .status(200)
            .send({ subscriptionId: sub.id, status: "active", pricePence });
        }

        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO subscriptions (reader_id, publication_id, price_pence, status,
             current_period_start, current_period_end, subscription_period)
           VALUES ($1, $2, $3, 'active', $4, $5, $6)
           RETURNING id`,
          [readerId, publicationId, pricePence, now, periodEnd, period],
        );
        const subscriptionId = rows[0].id;

        await client.query(
          `UPDATE accounts SET free_allowance_remaining_pence = free_allowance_remaining_pence - $1, updated_at = now() WHERE id = $2`,
          [pricePence, readerId],
        );
        await logSubscriptionCharge(
          client,
          subscriptionId,
          readerId,
          null,
          pricePence,
          now,
          periodEnd,
          publicationId,
        );

        const createEvent = signSubscriptionEvent({
          subscriptionId,
          readerPubkey,
          writerPubkey: pub.nostr_pubkey,
          status: "active",
          pricePence,
          periodStart: now,
          periodEnd,
        });
        await client.query(
          `UPDATE subscriptions SET nostr_event_id = $1 WHERE id = $2`,
          [createEvent.id, subscriptionId],
        );
        await enqueueRelayPublish(client, {
          entityType: "subscription",
          entityId: subscriptionId,
          signedEvent: createEvent,
        });

        pool
          .query(
            `INSERT INTO notifications (recipient_id, actor_id, type)
             SELECT pm.account_id, $1, 'pub_new_subscriber'
             FROM publication_members pm
             WHERE pm.publication_id = $2 AND pm.can_manage_finances = TRUE
               AND pm.removed_at IS NULL
             ON CONFLICT DO NOTHING`,
            [readerId, publicationId],
          )
          .catch((err) =>
            logger.warn({ err }, "Failed to notify pub_new_subscriber"),
          );

        logger.info(
          { readerId, publicationId, subscriptionId },
          "Publication subscription created",
        );
        return reply.status(201).send({
          subscriptionId,
          status: "active",
          pricePence,
          publicationName: pub.name,
          currentPeriodEnd: periodEnd.toISOString(),
        });
      });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/subscriptions/publication/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      const readerId = req.session!.sub;
      const { id: publicationId } = req.params;

      const result = await pool.query(
        `UPDATE subscriptions
         SET status = 'cancelled', auto_renew = FALSE, cancelled_at = now(), updated_at = now()
         WHERE reader_id = $1 AND publication_id = $2 AND status = 'active'
         RETURNING id`,
        [readerId, publicationId],
      );

      if (result.rowCount === 0) {
        return reply
          .status(404)
          .send({ error: "No active subscription found" });
      }

      return reply.send({ ok: true });
    },
  );
}

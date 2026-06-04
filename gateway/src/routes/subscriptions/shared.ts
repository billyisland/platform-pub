import { loadConfig } from '@platform-pub/shared/db/client.js'

// =============================================================================
// Helper — log subscription charge and earning events
//
// The hourly renewal/expiry worker lives in workers/subscription-expiry.ts
// and imports logSubscriptionCharge from this file (via the directory index).
// =============================================================================

// A subscription targets a writer (writerId) XOR a publication (publicationId);
// the event's writer_id / publication_id mirrors that. subscription_events
// requires at least one target (migration 103).
export async function logSubscriptionCharge(
  client: any,
  subscriptionId: string,
  readerId: string,
  writerId: string | null,
  pricePence: number,
  periodStart: Date,
  periodEnd: Date,
  publicationId: string | null = null,
) {
  const { platformFeeBps } = await loadConfig()
  const platformFeePence = Math.round((pricePence * platformFeeBps) / 10000)
  const writerEarningPence = pricePence - platformFeePence
  const feePct = (platformFeeBps / 100).toFixed(platformFeeBps % 100 === 0 ? 0 : 2)

  // Debit event for reader
  await client.query(
    `INSERT INTO subscription_events
       (subscription_id, event_type, reader_id, writer_id, publication_id, amount_pence, period_start, period_end, description)
     VALUES ($1, 'subscription_charge', $2, $3, $4, $5, $6, $7, $8)`,
    [subscriptionId, readerId, writerId, publicationId, pricePence, periodStart, periodEnd,
     `Subscription charge`]
  )

  // Credit event for writer/publication (after platform fee)
  await client.query(
    `INSERT INTO subscription_events
       (subscription_id, event_type, reader_id, writer_id, publication_id, amount_pence, period_start, period_end, description)
     VALUES ($1, 'subscription_earning', $2, $3, $4, $5, $6, $7, $8)`,
    [subscriptionId, readerId, writerId, publicationId, writerEarningPence, periodStart, periodEnd,
     `Subscriber income (after ${feePct}% fee)`]
  )
}

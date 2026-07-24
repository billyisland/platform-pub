import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool, loadConfig, withTransaction } from '@platform-pub/shared/db/client.js'
import { zodValidationError } from '@platform-pub/shared/lib/validation.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { requireEnv } from '@platform-pub/shared/lib/env.js'
import { requireAdmin } from '../middleware/admin.js'

// =============================================================================
// Owner dashboard — operator visibility over the money pipeline, users,
// content, config, and regulatory thresholds. Spec:
// planning-archive/OWNER-DASHBOARD-SPEC.md (adapted to the shipped ledger
// views and the post-145 schema — no is_writer column; earnings are the
// ledger_writer_earned − ledger_writer_earnings difference).
//
// GET  /admin/dashboard/overview    — money pipeline stage-by-stage
// GET  /admin/dashboard/users       — account totals, growth, KYC-stuck writers
// GET  /admin/dashboard/content     — publishing activity + system health
// GET  /admin/dashboard/config      — all platform_config rows
// PATCH /admin/dashboard/config     — update existing keys (never insert)
// GET  /admin/dashboard/regulatory  — revenue vs UK tax thresholds, custody
// POST /admin/dashboard/trigger-settlements — proxy to payment-service
// POST /admin/dashboard/trigger-payouts     — proxy to payment-service
//
// All numbers are computed live; at launch scale that is fine (spec §1).
// =============================================================================

const PAYMENT_SERVICE_URL = requireEnv('PAYMENT_SERVICE_URL')
const INTERNAL_SERVICE_TOKEN = requireEnv('INTERNAL_SERVICE_TOKEN')

const num = (v: unknown): number => Number(v ?? 0)

// Runtime-state keys that live in platform_config but are not operator dials —
// shown read-only in the config editor, never editable through it.
// (payouts_halted is presence-means-halted and is DELETEd to resume;
// jetstream_healthy is written by the ingest listener.)
const STATE_KEYS = new Set(['payouts_halted', 'jetstream_healthy'])

// The regulatory tax thresholds. Canonical values live in
// shared/src/db/config-defaults.sql; these fallbacks are tripwired against it
// by gateway/tests/admin-dashboard.test.ts (the §0h.7 parity pattern).
export const REGULATORY_DIAL_DEFAULTS = {
  tax_trading_allowance_pence: 100_000,
  tax_vat_threshold_pence: 9_000_000,
  tax_vat_warning_pct: 80,
  tax_corp_small_profits_pence: 5_000_000,
  tax_corp_main_rate_pence: 25_000_000,
  regulatory_holding_warning_days: 14,
} as const
type RegulatoryDial = keyof typeof REGULATORY_DIAL_DEFAULTS

const NUMERIC_RE = /^-?\d+(\.\d+)?$/

const PatchConfigSchema = z.object({
  updates: z
    .array(
      z.object({
        key: z.string().min(1).max(200),
        value: z.string().max(10_000),
      })
    )
    .min(1)
    .max(50),
})

// UK financial (tax) year runs 6 April → 5 April.
export function ukFinancialYear(now: Date): { start: string; end: string; daysRemaining: number } {
  const y = now.getUTCFullYear()
  const thisYearStart = Date.UTC(y, 3, 6) // 6 April (month is 0-based)
  const inNewTaxYear = now.getTime() >= thisYearStart
  const startMs = inNewTaxYear ? thisYearStart : Date.UTC(y - 1, 3, 6)
  const endMs = inNewTaxYear ? Date.UTC(y + 1, 3, 5) : Date.UTC(y, 3, 5)
  const daysRemaining = Math.max(0, Math.ceil((endMs - now.getTime()) / 86_400_000))
  return {
    start: new Date(startMs).toISOString().slice(0, 10),
    end: new Date(endMs).toISOString().slice(0, 10),
    daysRemaining,
  }
}

async function callPaymentService(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${PAYMENT_SERVICE_URL}/api/v1${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-token': INTERNAL_SERVICE_TOKEN,
    },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({}),
  })
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = { error: 'Upstream returned a non-JSON response' }
  }
  return { status: res.status, body }
}

export async function adminDashboardRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /admin/dashboard/overview — the money pipeline
  // ---------------------------------------------------------------------------
  app.get('/admin/dashboard/overview', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      const config = await loadConfig()
      const nearThresholdPence = Math.floor(config.tabSettlementThresholdPence * 0.8)

      const [tabs, readStates, settlements, payouts, outstanding, halt, revenue, custody, counts, holdingDial] =
        await Promise.all([
          pool.query(
            `SELECT
               COUNT(*) FILTER (WHERE balance_pence > 0) AS active_tab_count,
               COALESCE(SUM(balance_pence) FILTER (WHERE balance_pence > 0), 0) AS total_accrued_pence,
               COALESCE(-SUM(balance_pence) FILTER (WHERE balance_pence < 0), 0) AS total_credit_pence,
               COUNT(*) FILTER (WHERE balance_pence >= $1) AS near_threshold_tabs
             FROM reading_tabs`,
            [nearThresholdPence]
          ),
          pool.query(
            `SELECT state, COUNT(*) AS n, COALESCE(SUM(amount_pence), 0) AS total_pence
             FROM read_events GROUP BY state`
          ),
          pool.query(
            `SELECT
               COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
               COALESCE(SUM(amount_pence) FILTER (WHERE status = 'pending'), 0) AS pending_pence,
               MIN(created_at) FILTER (WHERE status = 'pending') AS oldest_pending_at,
               COUNT(*) FILTER (WHERE status = 'completed') AS completed_count,
               COALESCE(SUM(amount_pence) FILTER (WHERE status = 'completed'), 0) AS completed_pence,
               MAX(settled_at) FILTER (WHERE status = 'completed') AS last_completed_at,
               COUNT(*) FILTER (WHERE status = 'failed') AS failed_count
             FROM tab_settlements`
          ),
          pool.query(
            `SELECT status, COUNT(*) AS n, COALESCE(SUM(amount_pence), 0) AS total_pence,
                    MAX(triggered_at) AS last_at
             FROM writer_payouts GROUP BY status`
          ),
          // Money the platform owes writers: modeled earning minus paid-out,
          // per account, summed over positive balances (the two ledger views).
          pool.query(
            `SELECT
               COUNT(*) FILTER (WHERE outstanding_pence > 0) AS writers_awaiting,
               COALESCE(SUM(outstanding_pence) FILTER (WHERE outstanding_pence > 0), 0) AS outstanding_pence
             FROM (
               SELECT COALESCE(e.earned_pence, 0) - COALESCE(p.earned_pence, 0) AS outstanding_pence
               FROM ledger_writer_earned e
               FULL OUTER JOIN ledger_writer_earnings p USING (account_id)
             ) q`
          ),
          pool.query(
            `SELECT value, description, updated_at FROM platform_config WHERE key = 'payouts_halted'`
          ),
          pool.query(
            `SELECT
               COALESCE(SUM(platform_fee_pence), 0) AS all_time,
               COALESCE(SUM(platform_fee_pence) FILTER (WHERE settled_at > now() - interval '30 days'), 0) AS last_30d,
               COALESCE(SUM(platform_fee_pence) FILTER (WHERE settled_at > now() - interval '7 days'), 0) AS last_7d,
               COALESCE(SUM(platform_fee_pence) FILTER (WHERE settled_at > now() - interval '1 day'), 0) AS today
             FROM tab_settlements WHERE status = 'completed'`
          ),
          pool.query(
            `SELECT COUNT(*) AS held_read_count,
                    COALESCE(SUM(amount_pence), 0) AS total_held_pence,
                    MIN(read_at) AS oldest_held_read_at
             FROM read_events
             WHERE state = 'platform_settled' AND writer_payout_id IS NULL`
          ),
          pool.query(
            `SELECT
               (SELECT COUNT(*) FROM accounts WHERE status <> 'deleted') AS total_accounts,
               (SELECT COUNT(*) FROM accounts WHERE status = 'active') AS active_accounts,
               (SELECT COUNT(*) FROM accounts WHERE status <> 'deleted' AND stripe_customer_id IS NOT NULL) AS readers_with_card,
               (SELECT COUNT(DISTINCT writer_id) FROM articles WHERE published_at IS NOT NULL AND deleted_at IS NULL) AS publishing_writers,
               (SELECT COUNT(DISTINCT reader_id) FROM read_events) AS readers_ever,
               (SELECT COUNT(*) FROM moderation_reports WHERE status IN ('open', 'under_review')) AS open_report_count`
          ),
          pool.query<{ value: string }>(
            `SELECT value FROM platform_config WHERE key = 'regulatory_holding_warning_days'`
          ),
        ])

      const stateRow = (state: string) => {
        const r = readStates.rows.find((x: any) => x.state === state)
        return { count: num(r?.n), totalPence: num(r?.total_pence) }
      }
      const payoutRow = (status: string) => {
        const r = payouts.rows.find((x: any) => x.status === status)
        return { count: num(r?.n), totalPence: num(r?.total_pence), lastAt: r?.last_at ?? null }
      }

      const t = tabs.rows[0]
      const s = settlements.rows[0]
      const o = outstanding.rows[0]
      const r = revenue.rows[0]
      const cu = custody.rows[0]
      const c = counts.rows[0]
      const haltRow = halt.rows[0]
      const oldestHeld = cu.oldest_held_read_at ? new Date(cu.oldest_held_read_at) : null

      const provisional = stateRow('provisional')
      const accrued = stateRow('accrued')
      const chargedBack = stateRow('charged_back')
      const initiated = payoutRow('initiated')
      const pendingPayouts = payoutRow('pending')
      const completedPayouts = payoutRow('completed')
      const failedPayouts = payoutRow('failed')
      const reversedPayouts = payoutRow('reversed')

      return reply.send({
        accrual: {
          activeTabCount: num(t.active_tab_count),
          totalAccruedPence: num(t.total_accrued_pence),
          totalCreditPence: num(t.total_credit_pence),
          nearThresholdTabs: num(t.near_threshold_tabs),
          settlementThresholdPence: config.tabSettlementThresholdPence,
          provisionalReadCount: provisional.count,
          provisionalTotalPence: provisional.totalPence,
          accruedReadCount: accrued.count,
          accruedTotalPence: accrued.totalPence,
        },
        settlement: {
          pendingCount: num(s.pending_count),
          pendingPence: num(s.pending_pence),
          oldestPendingAt: s.oldest_pending_at ?? null,
          completedCount: num(s.completed_count),
          completedPence: num(s.completed_pence),
          lastCompletedAt: s.last_completed_at ?? null,
          failedCount: num(s.failed_count),
          chargedBackReadCount: chargedBack.count,
          chargedBackPence: chargedBack.totalPence,
        },
        payout: {
          writersAwaitingPayout: num(o.writers_awaiting),
          outstandingEarningsPence: num(o.outstanding_pence),
          pendingCount: pendingPayouts.count,
          pendingPence: pendingPayouts.totalPence,
          initiatedCount: initiated.count,
          initiatedPence: initiated.totalPence,
          completedCount: completedPayouts.count,
          completedPence: completedPayouts.totalPence,
          failedCount: failedPayouts.count,
          failedPence: failedPayouts.totalPence,
          reversedCount: reversedPayouts.count,
          reversedPence: reversedPayouts.totalPence,
          lastPayoutAt: completedPayouts.lastAt,
          halted: haltRow?.value === 'true',
          haltReason: haltRow?.description ?? null,
          haltedSince: haltRow?.updated_at ?? null,
        },
        revenue: {
          allTimePlatformFeePence: num(r.all_time),
          last30DaysPlatformFeePence: num(r.last_30d),
          last7DaysPlatformFeePence: num(r.last_7d),
          todayPlatformFeePence: num(r.today),
        },
        custody: {
          heldReadCount: num(cu.held_read_count),
          totalHeldPence: num(cu.total_held_pence),
          oldestHeldReadAt: cu.oldest_held_read_at ?? null,
          holdingDurationDays: oldestHeld
            ? Math.floor((Date.now() - oldestHeld.getTime()) / 86_400_000)
            : 0,
          // The dial the regulatory page honours — served here too so the
          // Overview tile's warn state can't drift from a retuned threshold
          // (same fallback discipline as the regulatory endpoint's dial()).
          holdingWarningDays: (() => {
            const v = Number(holdingDial.rows[0]?.value)
            return Number.isFinite(v)
              ? v
              : REGULATORY_DIAL_DEFAULTS.regulatory_holding_warning_days
          })(),
        },
        counts: {
          totalAccounts: num(c.total_accounts),
          activeAccounts: num(c.active_accounts),
          readersWithCard: num(c.readers_with_card),
          publishingWriters: num(c.publishing_writers),
          readersEver: num(c.readers_ever),
          openReportCount: num(c.open_report_count),
        },
      })
    } catch (err) {
      req.log.error({ err }, 'admin dashboard overview failed')
      return reply.status(500).send({ error: 'Failed to load overview' })
    }
  })

  // ---------------------------------------------------------------------------
  // GET /admin/dashboard/users — account metrics + KYC-stuck writers
  // ---------------------------------------------------------------------------
  app.get('/admin/dashboard/users', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      const [totals, kyc, funnel] = await Promise.all([
        pool.query(
          `SELECT
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE status = 'active') AS active,
             COUNT(*) FILTER (WHERE status = 'suspended') AS suspended,
             COUNT(*) FILTER (WHERE status = 'moderated') AS moderated,
             COUNT(*) FILTER (WHERE status = 'deactivated') AS deactivated,
             COUNT(*) FILTER (WHERE stripe_customer_id IS NOT NULL) AS with_card,
             COUNT(*) FILTER (WHERE stripe_customer_id IS NULL AND free_allowance_remaining_pence > 0) AS on_free_allowance,
             COUNT(*) FILTER (WHERE stripe_customer_id IS NULL AND free_allowance_remaining_pence <= 0) AS allowance_exhausted,
             COUNT(*) FILTER (WHERE card_action_required_at IS NOT NULL) AS card_action_required,
             COUNT(*) FILTER (WHERE created_at > now() - interval '7 days') AS signups_7d,
             COUNT(*) FILTER (WHERE created_at > now() - interval '30 days') AS signups_30d
           FROM accounts WHERE status <> 'deleted'`
        ),
        // Writers holding modeled-but-unpaid earnings who cannot receive a
        // payout: KYC incomplete (or Connect never started). The outstanding
        // figure is the ledger pair difference — earned minus paid out.
        pool.query(
          `SELECT a.id, a.username, a.display_name,
                  (a.stripe_connect_id IS NOT NULL) AS connect_started,
                  COALESCE(e.earned_pence, 0) - COALESCE(p.earned_pence, 0) AS pending_earnings_pence
           FROM accounts a
           LEFT JOIN ledger_writer_earned e ON e.account_id = a.id
           LEFT JOIN ledger_writer_earnings p ON p.account_id = a.id
           WHERE a.status <> 'deleted'
             AND a.stripe_connect_kyc_complete = FALSE
             AND COALESCE(e.earned_pence, 0) - COALESCE(p.earned_pence, 0) > 0
           ORDER BY pending_earnings_pence DESC
           LIMIT 50`
        ),
        pool.query(
          `SELECT
             (SELECT COUNT(DISTINCT reader_id) FROM read_events) AS readers_ever,
             (SELECT COUNT(*) FROM accounts WHERE status <> 'deleted' AND free_allowance_remaining_pence <= 0) AS exhausted_allowance,
             (SELECT COUNT(*) FROM accounts WHERE status <> 'deleted' AND stripe_customer_id IS NOT NULL) AS connected_card`
        ),
      ])

      const t = totals.rows[0]
      const f = funnel.rows[0]
      const exhausted = num(f.exhausted_allowance)
      const connected = num(f.connected_card)

      return reply.send({
        totals: {
          accounts: num(t.total),
          active: num(t.active),
          suspended: num(t.suspended),
          moderated: num(t.moderated),
          deactivated: num(t.deactivated),
          readersWithCard: num(t.with_card),
          readersOnFreeAllowance: num(t.on_free_allowance),
          readersAllowanceExhausted: num(t.allowance_exhausted),
          cardActionRequired: num(t.card_action_required),
        },
        growth: {
          signupsLast7d: num(t.signups_7d),
          signupsLast30d: num(t.signups_30d),
        },
        kycIncomplete: {
          count: kyc.rows.length,
          writers: kyc.rows.map((w: any) => ({
            id: w.id,
            username: w.username,
            displayName: w.display_name ?? null,
            connectStarted: Boolean(w.connect_started),
            pendingEarningsPence: num(w.pending_earnings_pence),
          })),
        },
        conversionFunnel: {
          totalReadersEver: num(f.readers_ever),
          exhaustedAllowance: exhausted,
          connectedCard: connected,
          conversionRate: exhausted > 0 ? connected / exhausted : null,
        },
      })
    } catch (err) {
      req.log.error({ err }, 'admin dashboard users failed')
      return reply.status(500).send({ error: 'Failed to load user metrics' })
    }
  })

  // ---------------------------------------------------------------------------
  // GET /admin/dashboard/content — publishing activity + system health
  // ---------------------------------------------------------------------------
  app.get('/admin/dashboard/content', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      const [articles, notes, engagement, drives, health] = await Promise.all([
        pool.query(
          `SELECT
             COUNT(*) AS total_published,
             COUNT(*) FILTER (WHERE published_at > now() - interval '7 days') AS published_7d,
             COUNT(*) FILTER (WHERE published_at > now() - interval '30 days') AS published_30d,
             COUNT(*) FILTER (WHERE access_mode = 'paywalled') AS paywalled,
             COUNT(*) FILTER (WHERE access_mode <> 'paywalled') AS free,
             ROUND(AVG(price_pence) FILTER (WHERE access_mode = 'paywalled')) AS avg_price_pence
           FROM articles WHERE published_at IS NOT NULL AND deleted_at IS NULL`
        ),
        pool.query(
          `SELECT COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE published_at > now() - interval '7 days') AS last_7d,
                  COUNT(*) FILTER (WHERE published_at > now() - interval '30 days') AS last_30d
           FROM notes`
        ),
        pool.query(
          `SELECT
             (SELECT COUNT(*) FROM read_events) AS reads_total,
             (SELECT COUNT(*) FROM read_events WHERE read_at > now() - interval '7 days') AS reads_7d,
             (SELECT COUNT(*) FROM comments WHERE deleted_at IS NULL) AS comments_total,
             (SELECT COUNT(*) FROM comments WHERE deleted_at IS NULL AND published_at > now() - interval '7 days') AS comments_7d,
             (SELECT COUNT(*) FROM votes) AS votes_total,
             (SELECT COUNT(*) FROM votes WHERE created_at > now() - interval '7 days') AS votes_7d`
        ),
        // Pledge drives are parked behind PLEDGES_ENABLED — counts stay
        // visible here (operator surface) so parked money is never invisible.
        pool.query(
          `SELECT status, COUNT(*) AS n FROM pledge_drives GROUP BY status`
        ),
        pool.query(
          `SELECT
             (SELECT MAX(scored_at) FROM feed_scores) AS feed_scores_refreshed_at,
             (SELECT value FROM platform_config WHERE key = 'jetstream_healthy') AS jetstream_healthy,
             (SELECT COUNT(*) FROM relay_outbox WHERE status = 'pending') AS outbox_pending,
             (SELECT MIN(created_at) FROM relay_outbox WHERE status = 'pending') AS outbox_oldest_pending_at,
             (SELECT COUNT(*) FROM relay_outbox WHERE status IN ('failed', 'abandoned')) AS outbox_failed`
        ),
      ])

      const a = articles.rows[0]
      const n = notes.rows[0]
      const e = engagement.rows[0]
      const h = health.rows[0]
      const driveRow = (status: string) => num(drives.rows.find((x: any) => x.status === status)?.n)
      const pledged = await pool.query(
        `SELECT COALESCE(SUM(current_total_pence), 0) AS total FROM pledge_drives WHERE status IN ('open', 'funded')`
      )
      const refreshedAt = h.feed_scores_refreshed_at ? new Date(h.feed_scores_refreshed_at) : null

      return reply.send({
        articles: {
          totalPublished: num(a.total_published),
          publishedLast7d: num(a.published_7d),
          publishedLast30d: num(a.published_30d),
          paywalledCount: num(a.paywalled),
          freeCount: num(a.free),
          avgPricePence: a.avg_price_pence === null ? null : num(a.avg_price_pence),
        },
        notes: {
          total: num(n.total),
          last7d: num(n.last_7d),
          last30d: num(n.last_30d),
        },
        engagement: {
          totalReadEvents: num(e.reads_total),
          readEventsLast7d: num(e.reads_7d),
          totalComments: num(e.comments_total),
          commentsLast7d: num(e.comments_7d),
          totalVotes: num(e.votes_total),
          votesLast7d: num(e.votes_7d),
        },
        drives: {
          openCount: driveRow('open'),
          fundedCount: driveRow('funded'),
          publishedCount: driveRow('published'),
          fulfilledCount: driveRow('fulfilled'),
          activePledgedPence: num(pledged.rows[0].total),
        },
        health: {
          feedScoresRefreshedAt: h.feed_scores_refreshed_at ?? null,
          feedScoresStalenessMinutes: refreshedAt
            ? Math.floor((Date.now() - refreshedAt.getTime()) / 60_000)
            : null,
          jetstreamHealthy: h.jetstream_healthy === null ? null : h.jetstream_healthy === 'true',
          relayOutboxPending: num(h.outbox_pending),
          relayOutboxOldestPendingAt: h.outbox_oldest_pending_at ?? null,
          relayOutboxFailed: num(h.outbox_failed),
        },
      })
    } catch (err) {
      req.log.error({ err }, 'admin dashboard content failed')
      return reply.status(500).send({ error: 'Failed to load content metrics' })
    }
  })

  // ---------------------------------------------------------------------------
  // GET /admin/dashboard/config — every platform_config row
  // ---------------------------------------------------------------------------
  app.get('/admin/dashboard/config', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      const { rows } = await pool.query(
        `SELECT key, value, description, updated_at FROM platform_config ORDER BY key`
      )
      return reply.send({
        config: rows.map((r: any) => ({
          key: r.key,
          value: r.value,
          description: r.description ?? null,
          updatedAt: r.updated_at,
          readOnly: STATE_KEYS.has(r.key),
        })),
      })
    } catch (err) {
      req.log.error({ err }, 'admin dashboard config read failed')
      return reply.status(500).send({ error: 'Failed to load config' })
    }
  })

  // ---------------------------------------------------------------------------
  // PATCH /admin/dashboard/config — update existing keys only
  //
  // Never inserts: new dials go through shared/src/db/config-defaults.sql
  // (the platform_config invariant). Numeric keys must stay numeric; *_bps
  // keys must stay within 0..10000; runtime-state keys are not editable.
  // ---------------------------------------------------------------------------
  app.patch('/admin/dashboard/config', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = PatchConfigSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error))
    }
    const adminId = (req as any).session!.sub as string

    try {
      const keys = parsed.data.updates.map((u) => u.key)
      const { rows: existing } = await pool.query<{ key: string; value: string }>(
        `SELECT key, value FROM platform_config WHERE key = ANY($1)`,
        [keys]
      )
      const existingByKey = new Map(existing.map((r) => [r.key, r.value]))

      // Validate the whole batch before touching anything
      for (const u of parsed.data.updates) {
        if (STATE_KEYS.has(u.key)) {
          return reply
            .status(400)
            .send({ error: `'${u.key}' is runtime state, not an operator dial` })
        }
        const current = existingByKey.get(u.key)
        if (current === undefined) {
          return reply.status(400).send({
            error: `Unknown config key '${u.key}' — new dials are added via config-defaults.sql, not the dashboard`,
          })
        }
        if (NUMERIC_RE.test(current) && !NUMERIC_RE.test(u.value)) {
          return reply
            .status(400)
            .send({ error: `'${u.key}' is numeric; got a non-numeric value` })
        }
        if (u.key.endsWith('_bps')) {
          const v = Number(u.value)
          if (!Number.isInteger(v) || v < 0 || v > 10_000) {
            return reply
              .status(400)
              .send({ error: `'${u.key}' must be an integer between 0 and 10000` })
          }
        }
        if (u.key.endsWith('_pct')) {
          const v = Number(u.value)
          if (!Number.isFinite(v) || v < 0 || v > 100) {
            return reply.status(400).send({ error: `'${u.key}' must be between 0 and 100` })
          }
        }
      }

      // One transaction: a mid-batch failure rolls the whole batch back
      // instead of leaving an unreported partial apply. rowCount is checked
      // even though existence was pre-validated above — a key DELETEd between
      // the check and the write would otherwise no-op silently (the bare-
      // UPDATE-matches-zero-rows hazard the platform_config invariant names).
      const applied: { key: string; oldValue: string | undefined; newValue: string }[] = []
      await withTransaction(async (client) => {
        for (const u of parsed.data.updates) {
          const oldValue = existingByKey.get(u.key)
          if (oldValue === u.value) continue
          const result = await client.query(
            `UPDATE platform_config SET value = $2, updated_at = now() WHERE key = $1`,
            [u.key, u.value]
          )
          if (result.rowCount !== 1) {
            throw new Error(`config key '${u.key}' vanished mid-update`)
          }
          applied.push({ key: u.key, oldValue, newValue: u.value })
        }
      })
      // Log after commit so a rolled-back batch leaves no "changed" lines.
      for (const entry of applied) {
        logger.info(
          { adminId, ...entry },
          'platform_config changed via owner dashboard'
        )
      }

      return reply.send({ ok: true, updated: applied.length })
    } catch (err) {
      req.log.error({ err }, 'admin dashboard config update failed')
      return reply.status(500).send({ error: 'Failed to update config' })
    }
  })

  // ---------------------------------------------------------------------------
  // GET /admin/dashboard/regulatory — revenue vs UK thresholds, custody
  // ---------------------------------------------------------------------------
  app.get('/admin/dashboard/regulatory', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      const [cfg, revenue, custody] = await Promise.all([
        pool.query<{ key: string; value: string }>(
          `SELECT key, value FROM platform_config WHERE key = ANY($1)`,
          [Object.keys(REGULATORY_DIAL_DEFAULTS)]
        ),
        pool.query(
          `SELECT
             COALESCE(SUM(platform_fee_pence) FILTER (WHERE settled_at > now() - interval '12 months'), 0) AS rolling_12m,
             COALESCE(SUM(platform_fee_pence) FILTER (WHERE settled_at >= date_trunc('month', now())), 0) AS current_month
           FROM tab_settlements WHERE status = 'completed'`
        ),
        pool.query(
          `SELECT COALESCE(SUM(amount_pence), 0) AS total_held_pence,
                  MIN(read_at) AS oldest_held_read_at
           FROM read_events
           WHERE state = 'platform_settled' AND writer_payout_id IS NULL`
        ),
      ])

      const dial = (key: RegulatoryDial): number => {
        const row = cfg.rows.find((r) => r.key === key)
        const v = row ? Number(row.value) : NaN
        return Number.isFinite(v) ? v : REGULATORY_DIAL_DEFAULTS[key]
      }

      const tradingAllowancePence = dial('tax_trading_allowance_pence')
      const vatThresholdPence = dial('tax_vat_threshold_pence')
      const vatWarningPct = dial('tax_vat_warning_pct')
      const corpSmallProfitsPence = dial('tax_corp_small_profits_pence')
      const corpMainRatePence = dial('tax_corp_main_rate_pence')
      const holdingWarningDays = dial('regulatory_holding_warning_days')

      const rolling12m = num(revenue.rows[0].rolling_12m)
      const currentMonth = num(revenue.rows[0].current_month)
      const cu = custody.rows[0]
      const oldestHeld = cu.oldest_held_read_at ? new Date(cu.oldest_held_read_at) : null
      const oldestHeldDays = oldestHeld
        ? Math.floor((Date.now() - oldestHeld.getTime()) / 86_400_000)
        : 0

      const vatPct = vatThresholdPence > 0 ? (rolling12m / vatThresholdPence) * 100 : 0

      return reply.send({
        rolling12MonthRevenuePence: rolling12m,
        currentMonthRevenuePence: currentMonth,
        annualisedRunRatePence: currentMonth * 12,
        thresholds: {
          tradingAllowance: {
            thresholdPence: tradingAllowancePence,
            currentPence: rolling12m,
            percentUsed:
              tradingAllowancePence > 0 ? (rolling12m / tradingAllowancePence) * 100 : 0,
            status: rolling12m > tradingAllowancePence ? 'exceeded' : 'within',
          },
          vatRegistration: {
            thresholdPence: vatThresholdPence,
            warningPct: vatWarningPct,
            currentPence: rolling12m,
            percentUsed: vatPct,
            status:
              vatPct >= 100 ? 'exceeded' : vatPct >= vatWarningPct ? 'approaching' : 'clear',
          },
          corporationTax: {
            smallProfitsThresholdPence: corpSmallProfitsPence,
            mainRateThresholdPence: corpMainRatePence,
            // Revenue, not profit — the UI labels this caveat.
            currentRevenuePence: rolling12m,
            status:
              rolling12m > corpMainRatePence
                ? 'main_rate'
                : rolling12m > corpSmallProfitsPence
                  ? 'marginal_relief'
                  : 'below_small_profits',
          },
        },
        custody: {
          totalHeldPence: num(cu.total_held_pence),
          oldestHeldDays,
          warningThresholdDays: holdingWarningDays,
          status: oldestHeldDays > holdingWarningDays ? 'warning' : 'normal',
        },
        financialYear: ukFinancialYear(new Date()),
      })
    } catch (err) {
      req.log.error({ err }, 'admin dashboard regulatory failed')
      return reply.status(500).send({ error: 'Failed to load regulatory metrics' })
    }
  })

  // ---------------------------------------------------------------------------
  // Trigger proxies — payment-service internal endpoints (x-internal-token)
  // ---------------------------------------------------------------------------
  app.post(
    '/admin/dashboard/trigger-settlements',
    { preHandler: requireAdmin },
    async (req, reply) => {
      try {
        const adminId = (req as any).session!.sub as string
        logger.info({ adminId }, 'owner dashboard: monthly settlement check triggered')
        const { status, body } = await callPaymentService('/settlement-check/monthly')
        return reply.status(status).send(body)
      } catch (err) {
        req.log.error({ err }, 'trigger-settlements proxy failed')
        return reply.status(502).send({ error: 'Payment service unreachable' })
      }
    }
  )

  app.post(
    '/admin/dashboard/trigger-payouts',
    { preHandler: requireAdmin },
    async (req, reply) => {
      try {
        const adminId = (req as any).session!.sub as string
        logger.info({ adminId }, 'owner dashboard: payout cycle triggered')
        const { status, body } = await callPaymentService('/payout-cycle')
        return reply.status(status).send(body)
      } catch (err) {
        req.log.error({ err }, 'trigger-payouts proxy failed')
        return reply.status(502).send({ error: 'Payment service unreachable' })
      }
    }
  )
}

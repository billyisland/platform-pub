# Owner Dashboard — Design Specification

**Platform:** all.haus (platform.pub)
**Version:** 0.1 — April 2026
**Status:** Draft

---

## 1. Purpose

The owner dashboard gives the operator of an all.haus instance a single surface for monitoring the platform's financial, operational, and regulatory health. It is not a general analytics product. Its job is to make the most consequential numbers impossible to ignore and the most common interventions available without touching SQL or Stripe directly.

The design assumes a single-operator platform at launch scale (hundreds to low thousands of users), with queries running live against the transactional database. If the platform reaches a scale where these queries become expensive, a periodic snapshot worker should be introduced — but that is out of scope for this spec.

---

## 2. Existing Infrastructure

The codebase already provides the foundation for admin access:

**Authentication and authorisation.** The `platform_config` table contains an `admin_account_ids` key (comma-separated UUIDs). The gateway's `moderation.ts` exports a `requireAdmin` middleware that checks the logged-in user's UUID against this list, with a 1-minute cache. The `/auth/me` response already includes an `isAdmin` boolean, and the Zustand auth store exposes it to the frontend.

**Moderation routes.** Four admin routes exist: `GET /admin/reports`, `PATCH /admin/reports/:reportId`, `POST /admin/suspend/:accountId`, and `POST /reports` (public, for submitting reports). These are registered in `gateway/src/routes/moderation.ts`.

**Frontend shell.** A Next.js page exists at `web/src/app/admin/page.tsx` that redirects admins to `/admin/reports`. The reports page at `web/src/app/admin/reports/page.tsx` is functional.

**Payment pipeline.** The three-stage money flow (accrual → settlement → payout) is fully implemented across the payment service, with internal HTTP endpoints for triggering settlement checks and payout cycles.

**Platform configuration.** The `platform_config` table stores all tunable parameters as key-value pairs. There is no admin UI for editing these values.

---

## 3. Dashboard Structure

The dashboard is organised into five panels, ordered by operational urgency. Each panel corresponds to a backend route group and a frontend tab.

### 3.1 URL and navigation scheme

| Route | Tab label | Description |
|---|---|---|
| `/admin` | — | Redirect to `/admin/overview` |
| `/admin/overview` | Overview | Money pipeline + key metrics |
| `/admin/reports` | Reports | Existing moderation queue (already built) |
| `/admin/users` | Users | Account metrics and interventions |
| `/admin/content` | Content | Publishing activity and system health |
| `/admin/config` | Config | Platform configuration editor |
| `/admin/regulatory` | Regulatory | Tax and compliance thresholds |

All routes are protected by the existing `isAdmin` check in the auth store (frontend) and `requireAdmin` middleware (backend).

---

## 4. Panel Specifications

### 4.1 Overview — the money pipeline

This is the panel the owner sees on login. Its job is to answer: "Is money flowing correctly through the system, and how much is where?"

#### 4.1.1 Backend route

`GET /admin/dashboard/overview`

Returns a single JSON object assembled from several queries against existing tables. No new tables required.

#### 4.1.2 Data model

```
{
  // Stage 1 — Accrual (money owed by readers, not yet charged)
  accrual: {
    activeTabCount: number        // reading_tabs WHERE balance_pence > 0
    totalAccruedPence: number     // SUM(balance_pence) from reading_tabs
    provisionalReadCount: number  // read_events WHERE state = 'provisional'
    provisionalTotalPence: number // SUM(amount_pence) WHERE state = 'provisional'
    accruedReadCount: number      // read_events WHERE state = 'accrued'
    accruedTotalPence: number     // SUM(amount_pence) WHERE state = 'accrued'
    nearThresholdTabs: number     // tabs WHERE balance >= threshold * 0.8
  }

  // Stage 2 — Settlement (reader charged, platform holds funds)
  settlement: {
    pendingConfirmationCount: number  // tab_settlements WHERE stripe_charge_id IS NULL
    pendingConfirmationPence: number
    confirmedTotalPence: number       // tab_settlements WHERE stripe_charge_id IS NOT NULL
    confirmedCount: number
    lastConfirmedAt: string | null    // MAX(settled_at) of confirmed settlements
    failedCount: number               // inferred from settlements without confirmation
                                      // older than 1 hour
  }

  // Stage 3 — Payout (platform pays writers)
  payout: {
    pendingPayoutWriters: number      // distinct writers with platform_settled reads
    pendingPayoutTotalPence: number   // net amount awaiting payout
    initiatedPayouts: number          // writer_payouts WHERE status = 'initiated'
    initiatedPayoutsPence: number
    completedPayoutsAllTime: number
    completedPayoutsAllTimePence: number
    failedPayouts: number             // writer_payouts WHERE status = 'failed'
    failedPayoutsPence: number
    lastPayoutCycleAt: string | null
  }

  // Platform revenue
  revenue: {
    allTimePlatformFeePence: number       // SUM(platform_fee_pence) confirmed
    last30DaysPlatformFeePence: number
    last7DaysPlatformFeePence: number
    todayPlatformFeePence: number
  }

  // Custodial exposure — money the platform is holding
  custody: {
    totalHeldPence: number           // SUM of platform_settled reads not yet paid out
    oldestHeldReadAt: string | null  // oldest platform_settled read without payout
    holdingDurationDays: number      // days between oldest held read and now
  }

  // Quick counts
  counts: {
    totalAccounts: number
    totalWriters: number
    totalReaders: number             // accounts with at least one read_event
    readersWithCard: number          // accounts WHERE stripe_customer_id IS NOT NULL
    openReportCount: number          // moderation_reports WHERE status = 'open'
  }
}
```

#### 4.1.3 Queries

All queries hit indexed columns on existing tables. The most complex is the custodial exposure calculation:

```sql
-- Custodial exposure: money held between settlement confirmation and writer payout
SELECT
  COUNT(*) AS held_read_count,
  COALESCE(SUM(amount_pence), 0) AS total_held_pence,
  MIN(read_at) AS oldest_held_read_at
FROM read_events
WHERE state = 'platform_settled'
  AND writer_payout_id IS NULL;
```

Platform revenue:

```sql
SELECT
  COALESCE(SUM(platform_fee_pence), 0) AS all_time,
  COALESCE(SUM(platform_fee_pence) FILTER (
    WHERE settled_at > now() - interval '30 days'), 0) AS last_30d,
  COALESCE(SUM(platform_fee_pence) FILTER (
    WHERE settled_at > now() - interval '7 days'), 0) AS last_7d,
  COALESCE(SUM(platform_fee_pence) FILTER (
    WHERE settled_at > now() - interval '1 day'), 0) AS today
FROM tab_settlements
WHERE stripe_charge_id IS NOT NULL;
```

#### 4.1.4 Frontend layout

The overview panel is a single scrollable page, not a grid of cards. Numbers are displayed as plain figures with labels, grouped under the three pipeline stages. Colours are used sparingly — only for warning states:

- **Red (crimson):** Failed settlements or payouts exist. Custodial holding exceeds 14 days.
- **Amber (grey-600 + border-left accent):** Pending confirmations older than 1 hour. Writers with incomplete KYC holding earned funds.
- **No colour otherwise.** The default state is calm.

At the bottom of the overview, two action buttons:

- **Trigger monthly settlement check** — calls `POST /admin/dashboard/trigger-settlements`
- **Trigger payout cycle** — calls `POST /admin/dashboard/trigger-payouts`

Both confirm before executing and display the result (number of settlements/payouts triggered).

---

### 4.2 Reports — moderation queue

Already built. No changes to the backend. The only integration work is adding the reports page into the new admin navigation shell and surfacing the open report count as a badge on the tab.

---

### 4.3 Users — account metrics and interventions

#### 4.3.1 Backend route

`GET /admin/dashboard/users`

#### 4.3.2 Data model

```
{
  totals: {
    accounts: number
    writers: number
    readers: number
    readersWithCard: number
    readersOnFreeAllowance: number    // no stripe_customer_id, allowance > 0
    readersAllowanceExhausted: number // no stripe_customer_id, allowance = 0
    suspendedAccounts: number
  }

  growth: {
    signupsLast7d: number
    signupsLast30d: number
    writerSignupsLast30d: number
  }

  // Writers earning money but unable to receive payouts
  kycIncomplete: {
    count: number
    writers: Array<{
      id: string
      username: string
      displayName: string | null
      pendingEarningsPence: number    // platform_settled reads for this writer
    }>
  }

  // Free allowance conversion funnel
  conversionFunnel: {
    totalReadersEver: number
    exhaustedAllowance: number       // readers who hit £0
    connectedCard: number            // readers who added a card
    conversionRate: number           // connectedCard / exhaustedAllowance
  }
}
```

#### 4.3.3 KYC-incomplete writers query

This surfaces a genuine business risk — money that cannot be paid out accumulates as a liability:

```sql
SELECT
  a.id, a.username, a.display_name,
  COALESCE(SUM(r.amount_pence - FLOOR(r.amount_pence * cfg.fee / 10000)), 0)
    AS pending_earnings_pence
FROM accounts a
JOIN read_events r ON r.writer_id = a.id AND r.state = 'platform_settled'
CROSS JOIN (
  SELECT value::int AS fee FROM platform_config WHERE key = 'platform_fee_bps'
) cfg
WHERE a.is_writer = TRUE
  AND a.stripe_connect_kyc_complete = FALSE
  AND a.stripe_connect_id IS NOT NULL
GROUP BY a.id, a.username, a.display_name
ORDER BY pending_earnings_pence DESC;
```

#### 4.3.4 Interventions

The users panel includes a search box (reusing the existing `pg_trgm` search on `accounts.username` and `accounts.display_name`) and, for each account, the existing suspend action (`POST /admin/suspend/:accountId`).

No new intervention routes are needed at launch. Future additions might include: unsuspend, force password reset (not applicable — magic links), grant complimentary subscription, adjust free allowance.

---

### 4.4 Content — publishing activity and system health

#### 4.4.1 Backend route

`GET /admin/dashboard/content`

#### 4.4.2 Data model

```
{
  articles: {
    totalPublished: number
    publishedLast7d: number
    publishedLast30d: number
    paywalledCount: number
    freeCount: number
    avgPricePence: number | null     // average of paywalled article prices
  }

  notes: {
    total: number
    last7d: number
    last30d: number
  }

  drives: {
    openCount: number
    fundedCount: number
    publishedCount: number
    fulfilledCount: number
    totalPledgedPence: number        // SUM(current_total_pence) across active drives
  }

  engagement: {
    totalReadEvents: number
    readEventsLast7d: number
    totalComments: number
    commentsLast7d: number
    totalVotes: number
    votesLast7d: number
  }

  // System health signals
  health: {
    feedScoresLastRefreshed: string | null   // MAX(scored_at) from feed_scores
    feedScoresStalenessMinutes: number
    relayReachable: boolean                  // simple TCP check to strfry port
  }
}
```

#### 4.4.3 Feed scorer staleness

The feed scorer runs every 5 minutes via advisory lock. If `MAX(scored_at)` is more than 10 minutes old, the dashboard should flag it as stale. This is a proxy for "is the gateway process running and healthy?"

```sql
SELECT
  MAX(scored_at) AS last_refreshed,
  EXTRACT(EPOCH FROM (now() - MAX(scored_at))) / 60 AS staleness_minutes
FROM feed_scores;
```

---

### 4.5 Config — platform configuration editor

#### 4.5.1 Backend routes

- `GET /admin/dashboard/config` — returns all rows from `platform_config`
- `PATCH /admin/dashboard/config` — updates one or more key-value pairs

#### 4.5.2 Data model

```
// GET response
{
  config: Array<{
    key: string
    value: string
    description: string | null
    updatedAt: string
  }>
}

// PATCH request body
{
  updates: Array<{
    key: string
    value: string
  }>
}
```

#### 4.5.3 Editable parameters

All existing `platform_config` keys are displayed and editable. The frontend groups them by domain:

| Group | Keys |
|---|---|
| Money | `free_allowance_pence`, `tab_settlement_threshold_pence`, `monthly_fallback_minimum_pence`, `writer_payout_threshold_pence`, `platform_fee_bps`, `monthly_fallback_days` |
| Feed | `feed_gravity`, `feed_weight_reaction`, `feed_weight_reply`, `feed_weight_quote_comment`, `feed_weight_gate_pass` |
| Content limits | `note_char_limit`, `comment_char_limit`, `media_max_size_bytes` |
| Access control | `admin_account_ids` |
| Regulatory thresholds | (new keys — see §4.6) |

#### 4.5.4 Validation

The PATCH route validates that numeric keys receive numeric values and that basis-point values are within sane ranges (0–10000). It rejects unknown keys — new config keys must be added via migration, not via the dashboard.

#### 4.5.5 Audit

Every config change is logged via the existing `logger.info` with the admin's account ID, the key changed, the old value, and the new value. At launch, structured logging is sufficient. A dedicated `config_audit_log` table is a future addition.

---

### 4.6 Regulatory — tax and compliance thresholds

This panel is an awareness tool, not a tax calculator. It displays the platform's current revenue position against UK tax and regulatory thresholds and flags when those thresholds are approaching. The specific numbers should be verified with an accountant; the dashboard's job is to make them visible.

#### 4.6.1 New platform_config keys

Added via migration:

```sql
INSERT INTO platform_config (key, value, description) VALUES
  ('tax_trading_allowance_pence', '100000',
   'UK trading income allowance (£1,000). Platform fee revenue below this needs no reporting.'),
  ('tax_sa_threshold_pence', '100000',
   'Self-assessment reporting threshold. Same as trading allowance — once exceeded, SA return required.'),
  ('tax_vat_threshold_pence', '9000000',
   'UK VAT registration threshold (£90,000 rolling 12-month revenue). Compulsory registration above this.'),
  ('tax_vat_warning_pct', '80',
   'Percentage of VAT threshold at which to show a warning (default 80%).'),
  ('tax_corp_small_profits_pence', '5000000',
   'Corporation tax small profits rate threshold (£50,000). 19% rate below, marginal relief above.'),
  ('tax_corp_main_rate_pence', '25000000',
   'Corporation tax main rate threshold (£250,000). 25% rate above.'),
  ('regulatory_holding_warning_days', '14',
   'Days of custodial holding before the dashboard shows a warning.');
```

#### 4.6.2 Backend route

`GET /admin/dashboard/regulatory`

#### 4.6.3 Data model

```
{
  // Rolling 12-month platform fee revenue
  rolling12MonthRevenuePence: number

  // Current month extrapolated to annual
  currentMonthRevenuePence: number
  annualisedRunRatePence: number   // currentMonthRevenuePence * 12

  // Threshold positions
  thresholds: {
    tradingAllowance: {
      thresholdPence: number
      currentPence: number         // rolling 12-month
      percentUsed: number
      status: 'within' | 'exceeded'
    }
    vatRegistration: {
      thresholdPence: number
      warningPct: number
      currentPence: number
      percentUsed: number
      status: 'clear' | 'approaching' | 'exceeded'
    }
    corporationTax: {
      smallProfitsThresholdPence: number
      mainRateThresholdPence: number
      currentRevenuePence: number   // this is revenue, not profit — noted in UI
      status: 'below_small_profits' | 'marginal_relief' | 'main_rate'
    }
  }

  // Custodial exposure
  custody: {
    totalHeldPence: number
    oldestHeldDays: number
    warningThresholdDays: number
    status: 'normal' | 'warning'
  }

  // Financial year context
  financialYear: {
    start: string                  // UK tax year starts 6 April
    end: string
    daysRemaining: number
  }
}
```

#### 4.6.4 UK tax thresholds — reference table

These are the thresholds as of April 2026, stored in `platform_config` so they can be updated without code changes. **These values should be verified with an accountant before operational use.**

| Threshold | Amount | What it means for all.haus | Gross reader spend at 8% fee |
|---|---|---|---|
| Trading income allowance | £1,000/year | Below this, no reporting required. Revenue is tax-free. | ~£12,500/year |
| Self-assessment | £1,000/year | Above this, file a self-assessment return. Income tax + NI apply. | ~£12,500/year |
| VAT registration | £90,000/year | Compulsory VAT registration. Must charge VAT on the platform fee. Affects pricing structure. | ~£1,125,000/year |
| Corporation tax (small profits) | £50,000/year profit | 19% rate on profits. Note: this is profit, not revenue — expenses reduce the figure. | N/A (profit-based) |
| Corporation tax (main rate) | £250,000/year profit | 25% rate on profits above this. Marginal relief applies between £50k–£250k. | N/A (profit-based) |

#### 4.6.5 VAT implications

VAT registration is the threshold most likely to change platform behaviour. When the platform's rolling 12-month fee revenue approaches £90,000:

1. The platform must register for VAT with HMRC.
2. VAT (currently 20%) must be charged on the platform fee — meaning the effective take becomes 8% + VAT, or the platform absorbs the VAT from the existing 8%.
3. The writer's net share is unaffected (VAT is on the platform's fee, not the writer's earnings).
4. Reader pricing may need adjustment depending on whether the platform absorbs or passes through.

The dashboard should surface this at 80% of the threshold (configurable via `tax_vat_warning_pct`) with a clear message: "At current run rate, VAT registration threshold will be reached in approximately N months."

#### 4.6.6 Custodial exposure and FCA considerations

The platform holds reader money between settlement (Stage 2) and writer payout (Stage 3). This creates custodial exposure. The regulatory panel displays:

- Total funds currently held (platform_settled reads not yet paid out).
- Duration of longest-held funds.
- A warning when holding duration exceeds the configurable threshold (default 14 days).

At higher volumes, the FCA's Payment Services Regulations 2017 or Electronic Money Regulations 2011 may apply. The specific triggers depend on total volume, holding duration, and whether the platform is considered to be issuing e-money. **This requires legal advice and is flagged here as an awareness item, not a determination.**

The dashboard should include a static note: "If total held funds regularly exceed £X or holding durations exceed Y days, consult a financial services lawyer about PSR/EMR obligations."

#### 4.6.7 Frontend layout

The regulatory panel is deliberately austere — no charts, no visualisations. It displays:

1. A single headline number: rolling 12-month platform revenue.
2. A threshold ladder showing the current position against each threshold, rendered as a simple labelled progress indicator (not a colourful chart — this is serious information, not a gamification exercise).
3. The custodial exposure block.
4. A "last updated" timestamp (these numbers are computed live on page load).
5. A footer caveat: "These thresholds are indicative. Consult an accountant for tax advice and a financial services lawyer for regulatory obligations."

---

## 5. Backend Implementation

### 5.1 New files

| File | Purpose |
|---|---|
| `gateway/src/routes/admin-dashboard.ts` | All new admin API routes |
| `web/src/app/admin/overview/page.tsx` | Overview panel |
| `web/src/app/admin/users/page.tsx` | Users panel |
| `web/src/app/admin/content/page.tsx` | Content panel |
| `web/src/app/admin/config/page.tsx` | Config editor |
| `web/src/app/admin/regulatory/page.tsx` | Regulatory panel |
| `web/src/app/admin/layout.tsx` | Shared admin layout with tab navigation |
| `web/src/lib/admin-api.ts` | Typed frontend API client for admin routes |
| `migrations/036_regulatory_config.sql` | New platform_config keys for tax thresholds |

### 5.2 Route registration

In `gateway/src/index.ts`, register the new routes:

```typescript
import { adminDashboardRoutes } from './routes/admin-dashboard.js'
// ...
app.register(adminDashboardRoutes, { prefix: '/api/v1' })
```

### 5.3 Route structure

All routes in `admin-dashboard.ts` use `{ preHandler: requireAdmin }` from the existing moderation module. The `requireAdmin` function and `isAdmin` helper should be extracted from `moderation.ts` into a shared `middleware/admin.ts` file so both route files can import them without circular dependencies.

### 5.4 Trigger routes

These proxy to the payment service's existing internal endpoints:

```
POST /admin/dashboard/trigger-settlements
  → POST http://payment-service:3001/api/v1/settlement-check/monthly
    (with x-internal-token header)

POST /admin/dashboard/trigger-payouts
  → POST http://payment-service:3001/api/v1/payout-cycle
    (with x-internal-token header)
```

Both return the upstream response to the frontend.

---

## 6. Frontend Implementation

### 6.1 Design language

The admin dashboard follows the existing all.haus design system. No new colours, no new fonts, no new components. Specifically:

- **Typography:** Jost (sans) for UI labels and numbers. Literata (serif) for section headings. IBM Plex Mono for monetary figures and config values.
- **Colours:** Black (#111) on white (#FFF). Grey-400 for secondary text. Crimson for error/warning states only.
- **Layout:** Single-column, max-width `content` (960px). No sidebar. Tab navigation at the top of the admin area using the existing pill-tab pattern from the reports page.
- **Spacing:** Consistent with the rest of the application. No cards with shadows — use horizontal rules (`border-b border-grey-200`) to separate groups.

### 6.2 Admin layout shell

`web/src/app/admin/layout.tsx` provides the shared chrome:

- Page title: "Site owner" (set in Literata, `text-2xl font-light tracking-tight`, matching the existing "Reports" heading style).
- Tab row: Overview · Reports · Users · Content · Config · Regulatory.
- The Reports tab shows a badge with the open report count (fetched once on layout mount).
- Auth guard: if `!user?.isAdmin`, redirect to `/feed`.

### 6.3 Data loading pattern

Each panel page fetches its data on mount using `useEffect` + the typed API client, with a loading skeleton matching the existing pattern (grey pulsing blocks). No SWR or React Query — the existing codebase uses plain fetch, and consistency matters more than optimisation at this scale.

### 6.4 Monetary display

All monetary values are stored in pence (integers) and displayed as pounds with two decimal places. The existing `web/src/lib/format.ts` likely has a formatter; if not, add one:

```typescript
export function formatPence(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`
}
```

Figures over £1,000 should use locale-appropriate grouping: `£1,234.56`.

---

## 7. Migration

### 7.1 Migration 036: regulatory config keys

```sql
-- 036_regulatory_config.sql

INSERT INTO platform_config (key, value, description) VALUES
  ('tax_trading_allowance_pence', '100000',
   'UK trading income allowance (£1,000). Platform fee revenue below this needs no reporting.'),
  ('tax_vat_threshold_pence', '9000000',
   'UK VAT registration threshold (£90,000 rolling 12-month revenue).'),
  ('tax_vat_warning_pct', '80',
   'Percentage of VAT threshold at which to show a dashboard warning.'),
  ('tax_corp_small_profits_pence', '5000000',
   'Corporation tax small profits threshold (£50,000 profit).'),
  ('tax_corp_main_rate_pence', '25000000',
   'Corporation tax main rate threshold (£250,000 profit).'),
  ('regulatory_holding_warning_days', '14',
   'Days of custodial holding before the dashboard shows a warning.')
ON CONFLICT (key) DO NOTHING;
```

### 7.2 Schema.sql update

Add the new keys to the `INSERT INTO platform_config` block in `schema.sql` and bump the `_migrations` seed to include `036_regulatory_config.sql`.

---

## 8. Security Considerations

- All admin routes are protected by `requireAdmin`, which verifies the session JWT and checks the account UUID against `platform_config.admin_account_ids`.
- The config editor can modify `admin_account_ids`, which means an admin can add or remove other admins. At single-operator scale this is acceptable. At multi-operator scale, this key should be env-var-only.
- The trigger routes proxy to internal services using `INTERNAL_SERVICE_TOKEN`. The admin never sees or handles this token — the gateway adds it server-side.
- No new data is exposed to non-admin users. All new routes return 403 for non-admins.

---

## 9. What This Spec Does Not Cover

- **Historical trend data.** All numbers are computed live. Adding time-series snapshots (for charts showing revenue over time, growth curves, etc.) requires a periodic snapshot worker writing to a new `admin_metrics_snapshots` table. This is a natural follow-on but is not needed at launch.
- **Email alerts.** The dashboard is pull-only. Push notifications (e.g. "settlement failed", "approaching VAT threshold") would require a notification service or integration with an external alerting tool.
- **Multi-operator access control.** The current model is binary: you're in `admin_account_ids` or you're not. Role-based access (e.g. a bookkeeper who can see financials but not suspend accounts) is a future concern.
- **Stripe dashboard deep links.** Linking directly to relevant Stripe dashboard pages (e.g. a failed payment intent) would be useful but requires storing Stripe dashboard URLs or constructing them from IDs. Deferred.
- **Writer-facing analytics.** The existing writer dashboard (`/dashboard`) shows earnings and per-article breakdowns. Enhancing that is a separate workstream.

---

## 10. Implementation Order

1. **Extract admin middleware** — move `requireAdmin` and `isAdmin` from `moderation.ts` to `middleware/admin.ts`.
2. **Migration 036** — add regulatory config keys.
3. **Backend routes** — implement `admin-dashboard.ts` with all six route groups.
4. **Admin layout shell** — build the shared layout with tab navigation.
5. **Overview panel** — the most operationally critical view; build first.
6. **Config editor** — high leverage; allows tuning without SQL access.
7. **Regulatory panel** — important for awareness but lower urgency than money visibility.
8. **Users panel** — useful but less urgent than financial visibility.
9. **Content panel** — lowest priority; mostly informational.
10. **Integrate existing reports page** into the new admin layout.

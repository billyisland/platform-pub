# platform.pub — Deployment Reference v4.3.1

**Date:** 2 April 2026
**Replaces:** v4.3.0 (see bottom for change log)

This is the single source of truth for deploying and operating platform.pub.

---

## Architecture overview

```
Internet
  │
  ├─ :443 ─→ nginx (TLS termination)
  │            ├─ /api/*      → gateway:3000
  │            ├─ /relay      → strfry:7777  (WebSocket upgrade)
  │            ├─ /media/*    → static files from media_data volume
  │            └─ /*          → web:3000     (Next.js)
  │
  └─ :80 ─→ nginx (→ 301 HTTPS, plus certbot ACME challenges)

Internal only:
  gateway:3000    ─→ postgres:5432
                  ─→ payment:3001
                  ─→ keyservice:3002
                  ─→ key-custody:3004
                  ─→ writes to /app/media/ (shared volume)
  payment:3001    ─→ postgres:5432, strfry:7777, Stripe API
  keyservice:3002 ─→ postgres:5432, strfry:7777
  key-custody:3004 → postgres:5432
```

### Services

| Service | Image / Build | Port | Purpose |
|---------|--------------|------|---------|
| postgres | postgres:16-alpine | 5432 (localhost only) | Shared database |
| strfry | dockurr/strfry:latest | 4848→7777 | Nostr relay |
| gateway | ./gateway/Dockerfile | 3000 (localhost only) | API gateway, auth, media upload |
| payment | ./payment-service/Dockerfile | 3001 (Docker internal only) | Stripe, settlement, payouts |
| keyservice | ./key-service/Dockerfile | 3002 (Docker internal only) | Vault encryption, NIP-44 key issuance |
| key-custody | ./key-custody/Dockerfile | 3004 (Docker internal only) | Custodial Nostr keypair service |
| web | ./web/Dockerfile | 3010→3000 | Next.js frontend |
| nginx | nginx:alpine | 80, 443 | Reverse proxy, TLS, static media |
| blossom | ghcr.io/hzrd149/blossom-server:master | 3000 (Docker internal only) | Nostr media federation |
| certbot | certbot/certbot | — | TLS certificate renewal |

### Docker volumes

| Volume | Mounted by | Purpose |
|--------|-----------|---------|
| pgdata | postgres | Database storage |
| strfry_data | strfry | Relay event database (LMDB) |
| media_data | gateway (rw), nginx (ro) | Uploaded images (WebP, content-addressed) |
| blossom_data | blossom | Blossom blob storage |
| certbot_data | nginx, certbot | ACME challenge files |
| certbot_certs | nginx, certbot | TLS certificates |

---

## Prerequisites

- Ubuntu 22.04+ or Debian 12+ server
- Docker Engine 24+ with Docker Compose v2
- Domain pointing to the server's IP
- TLS certificate (via certbot, provisioned separately)

### Required environment files

Each service has a `.env.example`. Copy and fill:

```bash
cp gateway/.env.example gateway/.env
cp payment-service/.env.example payment-service/.env
cp key-service/.env.example key-service/.env
cp key-custody/.env.example key-custody/.env
cp web/.env.example web/.env
```

Key variables:

| Variable | Service | Purpose |
|----------|---------|---------|
| `SESSION_SECRET` | gateway | JWT signing key and cookie secret (min 32 chars) |
| `PLATFORM_SERVICE_PRIVKEY` | gateway, payment, key-service | 64-hex Nostr private key for platform service events |
| `READER_HASH_KEY` | gateway | HMAC key for reader pubkey privacy hashing |
| `INTERNAL_SECRET` | gateway, key-custody, key-service | Shared secret authenticating gateway→key-custody and gateway→key-service calls |
| `INTERNAL_SERVICE_TOKEN` | payment-service | Shared secret authenticating cron→payment-service calls (`/payout-cycle`, `/settlement-check/monthly`) |
| `ACCOUNT_KEY_HEX` | key-custody **only** | AES-256 key for encrypting custodial Nostr privkeys at rest |
| `KMS_MASTER_KEY_HEX` | key-service | AES-256 master key for vault content key envelope encryption |
| `STRIPE_SECRET_KEY` | gateway, payment | Stripe API key |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | web | Stripe publishable key |
| `KEY_SERVICE_URL` | gateway | Internal URL for key-service (default: http://localhost:3002) |
| `KEY_CUSTODY_URL` | gateway | Internal URL for key-custody (default: http://localhost:3004) |
| `PAYMENT_SERVICE_URL` | gateway | Internal URL for payment-service (default: http://localhost:3001) |
| `PLATFORM_RELAY_WS_URL` | gateway, payment, key-service | strfry WebSocket URL (default: ws://localhost:4848) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | gateway | Google OAuth credentials |
| `APP_URL` | gateway | **Frontend** URL (Next.js). Used for OAuth redirect URIs, Stripe redirects, CORS, and magic links. Dev: `http://localhost:3010`. **Must not be the gateway URL.** |
| `ADMIN_ACCOUNT_IDS` | gateway | Comma-separated UUIDs for admin access |
| `EMAIL_PROVIDER` | gateway | `postmark`, `resend`, or `console` |

> **Security:** `ACCOUNT_KEY_HEX` must never be set on the gateway — the key-custody service is the sole holder of this key by design. The gateway cannot decrypt user private keys.

> **Startup validation (v4.2.0):** All services now validate required environment variables at startup and refuse to boot if any are missing. `SESSION_SECRET` must be at least 32 characters. `ACCOUNT_KEY_HEX` and `KMS_MASTER_KEY_HEX` must be at least 32 characters. `APP_URL` is now required (no localhost fallback in production). If a service exits immediately on boot, check its logs for `Missing required environment variable:` messages.

---

## Fresh deployment

### 1. Clone the repo

```bash
git clone https://github.com/ejklake/platform-pub /root/platform-pub
cd /root/platform-pub
```

> **Local dev only:** each service imports `shared/` via a sibling symlink. These are committed to the repo, so `git clone` restores them automatically. If for any reason they are missing:
> ```bash
> ln -snf ../shared gateway/shared
> ln -snf ../shared payment-service/shared
> ln -snf ../shared key-service/shared
> ln -snf ../shared key-custody/shared
> ```

### 2. Create environment files

```bash
# Generate a strong Postgres password
export POSTGRES_PASSWORD=$(openssl rand -base64 24)
echo "POSTGRES_PASSWORD=$POSTGRES_PASSWORD" > .env

cp gateway/.env.example gateway/.env
cp payment-service/.env.example payment-service/.env
cp key-service/.env.example key-service/.env
cp key-custody/.env.example key-custody/.env
cp web/.env.example web/.env
# Edit each file with your actual keys
```

Generate cryptographic secrets:

```bash
openssl rand -hex 32   # SESSION_SECRET, READER_HASH_KEY
openssl rand -hex 32   # ACCOUNT_KEY_HEX (key-custody only)
openssl rand -hex 32   # KMS_MASTER_KEY_HEX (key-service only)
openssl rand -base64 32  # INTERNAL_SECRET (gateway + key-custody + key-service)
openssl rand -base64 32  # INTERNAL_SERVICE_TOKEN (payment-service cron auth)
# For PLATFORM_SERVICE_PRIVKEY: generate a Nostr keypair — any hex ed25519 privkey
```

### 3. Start infrastructure

```bash
docker compose up -d postgres strfry
docker compose ps   # wait for postgres to be healthy
```

### 4. Apply schema and migrations

The base schema (`schema.sql`) is auto-applied on first postgres boot via the `initdb.d` volume mount. As of v4.2.0, `schema.sql` includes the notification routing columns (`conversation_id`, `drive_id` on notifications table). Migrations 018–022 must be run separately on existing databases.

Migrations still need to be run for **existing** databases that were initialised with an earlier `schema.sql`:

```bash
for f in migrations/*.sql; do
  echo "Applying $f..."
  docker exec -i platform-pub-postgres-1 psql -U platformpub platformpub < "$f"
done
```

Verify:
```bash
docker exec platform-pub-postgres-1 psql -U platformpub platformpub -c "\dt"
```

You should see 33+ tables.

### 5. Build and start all services

```bash
docker compose build
docker compose up -d
```

### 6. Provision TLS

```bash
docker compose run --rm certbot certonly \
  --webroot --webroot-path=/var/www/certbot \
  -d yourdomain.com --agree-tos -m you@example.com

docker compose restart nginx
```

### 7. Server hardening (production)

```bash
bash scripts/harden-server.sh
```

Configures UFW (ports 22, 80, 443 only), SSH key-only auth, and certbot auto-renewal.

---

## Upgrading from a previous version

> **Important — how builds work:** The web (and all other) services run entirely inside Docker containers. Running `npm run build` or `npm run dev` locally on the host has **no effect on the live site** — those outputs go to a local `.next/` folder that the container never reads. All deployments must go through `docker compose build <service>` followed by `docker compose up -d <service>`.

### From v4.3.0

No new migrations. Services changed: **web** only. Deploy order: **rebuild web**.

This is a hotfix for a broken Docker build introduced in v4.3.0. The `web/Dockerfile` had `ENV NODE_ENV=production` set before `npm install`, which caused npm to skip devDependencies. Since `tailwindcss`, `postcss`, and `autoprefixer` are devDependencies required at build time, `npm run build` failed with `Cannot find module 'tailwindcss'`.

**Fix:** `ENV NODE_ENV=production` moved from before `npm install` to after `npm run build`. DevDependencies are now installed, the build succeeds, and the runtime still runs with `NODE_ENV=production`.

```bash
cd /root/platform-pub
git pull origin master

# Rebuild web only
docker compose build --no-cache web
docker compose up -d web
```

Verify:
```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
# web should show (healthy) after ~30s

# Confirm NODE_ENV is set in the running container
docker exec platform-pub-web-1 sh -c "echo \$NODE_ENV"
# Should return "production"
```

Changes:

```
# v4.3.1 — Fix web Docker build failure (tailwindcss not found)
#
# web/Dockerfile had ENV NODE_ENV=production before npm install, causing
# npm to skip devDependencies (tailwindcss, postcss, autoprefixer).
# The Next.js build failed with "Cannot find module 'tailwindcss'".
#
# Fix: moved ENV NODE_ENV=production to after RUN npm run build.
# DevDependencies are installed and available during build; the runtime
# container still runs with NODE_ENV=production.
#
# Files changed:
#   web/Dockerfile — ENV NODE_ENV=production moved after build step
```

---

### From v4.2.0

No new migrations. Services changed: **gateway**, **web**. Deploy order: **rebuild gateway + web**.

This release delivers the resilience and hardening work described in `RESILIENCE.md` and `FIXES-REMAINING.md`. Major changes:

**Architecture:**

1. **NDK removed from client** — The web frontend no longer imports `@nostr-dev-kit/ndk` or opens WebSocket connections to the relay. All Nostr operations go through the gateway HTTP API. Three new gateway endpoints support this:
   - `POST /api/v1/sign-and-publish` — signs a Nostr event via key-custody and publishes to the relay in one call
   - `GET /api/v1/feed/following` — returns articles + notes from followed writers via DB query (replaces client-side relay subscription)
   - `GET /api/v1/articles/by-event/:nostrEventId` — fetches article metadata by Nostr event ID (used by the editor for loading drafts)
2. **Article reader SSR** — `/article/[dTag]` is now a Server Component. The page fetches article data from the gateway at request time (ISR, revalidate 60s), renders markdown to HTML server-side, and sends it as static HTML. Interactive elements (paywall gate, replies, share/report buttons, quote selection) hydrate as client islands. The gateway's `GET /articles/:dTag` response now includes a `contentFree` field with the free portion of the article content.
3. **Writer profile SSR** — `/[username]` is now a Server Component. Profile header (name, avatar, bio, article count) renders as static HTML. The interactive activity feed (`WriterActivity`) hydrates as a client island.

**Performance (client bundle reductions):**

| Route | Before | After | Reduction |
|-------|--------|-------|-----------|
| Article reader | 278 KB | 161 KB | 42% |
| Feed | 231 KB | 114 KB | 51% |
| Writer profile | 231 KB | 114 KB | 51% |
| Dashboard | 221 KB | 105 KB | 52% |
| Write/editor | 210 KB | 94 KB | 55% |

**Font optimisation:**

- Removed Google Fonts import (Instrument Sans, Literata, IBM Plex Mono — 3 external font loads)
- Self-hosted Literata (serif) as woff2 in `web/public/fonts/` (~108 KB total, Latin + Latin-Extended, normal + italic)
- Sans-serif uses system font stack: `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`
- Monospace uses system font stack: `ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`
- Preload links added in `layout.tsx` for the two primary Literata woff2 files

**Docker & security:**

- `ENV NODE_ENV=production` added to `payment-service/Dockerfile`, `key-service/Dockerfile`
- `ENV NODE_ENV=production` in `web/Dockerfile` moved to **after** `RUN npm run build` (v4.3.1 fix — setting it before `npm install` caused devDependencies like `tailwindcss` to be skipped, breaking the build)
- Root `.dockerignore` added (excludes `node_modules`, `dist`, `.git`, `.next`, `*.log`, `.env`)
- HSTS header now includes `preload` directive
- `'unsafe-inline'` removed from CSP `style-src`
- Article `pricePence` validation capped at 999,999 (£9,999.99)

**Other fixes:**

- Config cache TTL (30s) added to `loadConfig()` — stale config no longer persists until restart
- Notification inserts now awaited with try/catch instead of fire-and-forget `.catch()`
- Webhook handler uses static pool import instead of dynamic import
- TypeScript target bumped from ES2017 to ES2020 in `web/tsconfig.json`
- `pg` aligned to `^8.20.0` and `dotenv` to `^17.3.1` across all services
- Vote buttons have `aria-label` attributes
- Session storage `unlocked:*` keys cleared on logout
- Shared `Avatar` component with explicit dimensions, lazy loading, and initials fallback
- Print stylesheet hides chrome, expands article body, sets print-friendly typography

```bash
cd /root/platform-pub
git pull origin master

# No migrations — just rebuild
docker compose build gateway web
docker compose up -d gateway web

# Reload nginx to pick up any CSP/HSTS changes
docker compose exec nginx nginx -s reload
```

Verify:
```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
# All services should show (healthy) after ~30s

curl -s http://localhost:3000/health
# Should return {"status":"ok","service":"gateway"}

# Verify NDK is not in the client bundle
docker exec platform-pub-web-1 sh -c "grep -r 'nostr-dev-kit' /app/.next/static 2>/dev/null | wc -l"
# Should return 0

# Verify self-hosted fonts are served
curl -sI http://localhost:3010/fonts/literata-latin-400.woff2 | head -5
# Should return 200

# Verify new gateway endpoints
curl -s http://localhost:3000/api/v1/articles/by-event/test 2>&1 | head -1
# Should return JSON (404 for nonexistent event, but endpoint exists)
```

---

### From v4.1.0

New migrations (021, 022). Services changed: **gateway**, **payment-service**, **key-service**, **key-custody**, **web**. Deploy order: **migrate → rebuild all services**.

This release addresses critical and high-priority issues surfaced by a full codebase review, plus resilience prep work for the upcoming Server Component conversion (see `RESILIENCE.md`).

**Breaking change:** All services now validate required environment variables at startup and will refuse to boot if any are missing or too short. Verify your `.env` files before deploying. See the env var table above for minimum length requirements.

**Backend fixes:**

1. **Race condition in tab balance** — Reading tab balance updates now acquire a `FOR UPDATE` lock before incrementing, preventing lost updates from concurrent gate passes.
2. **Silent Nostr ID fallbacks** — `getArticleNostrEventId()` and `getWriterPubkey()` now throw on missing data instead of returning empty strings that produced invalid receipt events.
3. **Auth bypass via header array** — Internal service secret validation in key-custody and key-service now normalizes headers to string before comparing, closing a potential bypass when Fastify returns duplicate headers as arrays.
4. **N+1 notification inserts** — Mention notifications are now batched into a single multi-row INSERT instead of one query per mentioned user.
5. **Double-webhook settlement race** — Settlement confirmation now uses an atomic `UPDATE ... WHERE stripe_charge_id IS NULL` with rowCount check, preventing double-debit from concurrent Stripe webhooks.
6. **Env var validation** — All four services fail fast on missing `DATABASE_URL`, `STRIPE_SECRET_KEY`, `INTERNAL_SECRET`, `ACCOUNT_KEY_HEX`, `KMS_MASTER_KEY_HEX`, `SESSION_SECRET`, and `APP_URL`.

**Database migrations:**

- Migration 021: Adds missing `ON DELETE` clauses to `subscriptions`, `subscription_events`, `article_unlocks`, `vote_charges`, and `pledges` tables.
- Migration 022: Adds composite index `idx_read_events_reader_article` on `(reader_id, article_id)` for faster payment verification queries.

**Frontend fixes / resilience prep:**

1. **Shared format utilities** — `formatDate`, `truncate`, `stripMarkdown` consolidated from 4 files into `web/src/lib/format.ts`.
2. **Centralized API client** — Raw `fetch()` calls in VoteControls, ReplySection, FeedView, NoteCard, and FeaturedWriters replaced with typed `api.ts` client. New API namespaces: `content`, `feed`, `follows`, `search`.
3. **Error boundaries** — New `ErrorBoundary` component and `error.tsx` files for `/`, `/article`, `/feed`, `/dashboard`.
4. **Editor lazy-loaded** — TipTap loaded via `next/dynamic` on `/write`, removing it from all other route bundles.

```bash
cd /root/platform-pub
git pull origin master

# 1. Apply new migrations
docker exec -i platform-pub-postgres-1 psql -U platformpub platformpub \
  < migrations/021_missing_on_delete_clauses.sql

docker exec -i platform-pub-postgres-1 psql -U platformpub platformpub \
  < migrations/022_composite_index_read_events.sql

# 2. Rebuild all services (env validation + backend fixes)
docker compose build
docker compose up -d
```

Verify:
```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
# All services should show (healthy) after ~30s

curl -s http://localhost:3000/health
# Should return {"status":"ok","service":"gateway"}

# Verify migrations applied
docker exec platform-pub-postgres-1 psql -U platformpub platformpub \
  -c "SELECT indexname FROM pg_indexes WHERE indexname = 'idx_read_events_reader_article';"
# Should return 1 row

# Verify ON DELETE clauses
docker exec platform-pub-postgres-1 psql -U platformpub platformpub \
  -c "SELECT confdeltype FROM pg_constraint WHERE conname = 'subscriptions_reader_id_fkey';"
# Should return 'c' (CASCADE)

# If any service fails to start, check for missing env vars:
docker logs platform-pub-gateway-1 --tail 10
# Look for "Missing required environment variable:" messages
```

Changes:

```
# v4.2.0 — Codebase audit fixes + resilience prep
#
# ── Critical: Race condition in tab balance updates ──
# Added SELECT FOR UPDATE lock before balance increment in recordGatePass().
# Prevents lost updates when concurrent gate passes hit the same reader's tab.
# File: payment-service/src/services/accrual.ts
#
# ── Critical: Silent empty-string fallbacks for Nostr IDs ──
# getArticleNostrEventId() and getWriterPubkey() now throw on missing data
# instead of returning '' which produced invalid Nostr receipt events.
# File: payment-service/src/services/accrual.ts
#
# ── Critical: Env var validation at startup ──
# All services validate required env vars on boot and refuse to start if
# any are missing. SESSION_SECRET requires min 32 chars. ACCOUNT_KEY_HEX
# and KMS_MASTER_KEY_HEX require min 32 chars. APP_URL is now required.
# Files: gateway/src/index.ts, payment-service/src/index.ts,
#        key-service/src/index.ts, key-custody/src/index.ts,
#        shared/src/lib/env.ts (new)
#
# ── Critical: Missing ON DELETE clauses ──
# Migration 021 adds CASCADE/RESTRICT to subscriptions, subscription_events,
# article_unlocks, vote_charges, and pledges FK constraints.
# File: migrations/021_missing_on_delete_clauses.sql (new)
#
# ── High: Auth bypass via header array ──
# Internal service secret validation now normalizes x-internal-secret header
# to string before comparing. Fastify can return string[] for duplicate headers.
# Files: key-custody/src/routes/keypairs.ts, key-service/src/routes/keys.ts
#
# ── High: N+1 notification inserts batched ──
# Mention notifications consolidated into single multi-row INSERT.
# File: gateway/src/routes/notes.ts
#
# ── High: Composite index for payment verification ──
# Migration 022 adds idx_read_events_reader_article on (reader_id, article_id).
# File: migrations/022_composite_index_read_events.sql (new)
#
# ── High: Double-webhook race in settlement ──
# confirmSettlement now uses atomic UPDATE with rowCount check to prevent
# TOCTOU race between concurrent Stripe webhooks.
# File: payment-service/src/services/settlement.ts
#
# ── High: Error boundaries ──
# New ErrorBoundary component for client islands. error.tsx files added
# for /, /article, /feed, /dashboard routes.
# Files: web/src/components/ui/ErrorBoundary.tsx (new),
#        web/src/app/error.tsx (new), web/src/app/article/error.tsx (new),
#        web/src/app/feed/error.tsx (new), web/src/app/dashboard/error.tsx (new)
#
# ── Resilience: Shared format utilities ──
# formatDate, truncate, stripMarkdown extracted from ArticleCard, NoteCard,
# FeaturedWriters, [username]/page into shared web/src/lib/format.ts.
# Files: web/src/lib/format.ts (new),
#        web/src/components/feed/ArticleCard.tsx,
#        web/src/components/feed/NoteCard.tsx,
#        web/src/components/home/FeaturedWriters.tsx,
#        web/src/app/[username]/page.tsx
#
# ── Resilience: Centralized API client ──
# Raw fetch() calls in VoteControls, ReplySection, FeedView, NoteCard,
# FeaturedWriters replaced with typed api.ts methods. New namespaces:
# content.resolve(), feed.global(), feed.featured(), follows.follow(),
# follows.pubkeys(), search.writers().
# Files: web/src/lib/api.ts,
#        web/src/components/ui/VoteControls.tsx,
#        web/src/components/replies/ReplySection.tsx,
#        web/src/components/feed/FeedView.tsx,
#        web/src/components/feed/NoteCard.tsx,
#        web/src/components/home/FeaturedWriters.tsx
#
# ── Resilience: Editor lazy-loaded ──
# TipTap loaded via next/dynamic with ssr:false on /write page.
# Removes editor bundle from all other route bundles.
# File: web/src/app/write/page.tsx
#
# New files (8):
#   migrations/021_missing_on_delete_clauses.sql
#   migrations/022_composite_index_read_events.sql
#   shared/src/lib/env.ts
#   web/src/lib/format.ts
#   web/src/components/ui/ErrorBoundary.tsx
#   web/src/app/error.tsx
#   web/src/app/article/error.tsx
#   web/src/app/feed/error.tsx
#   web/src/app/dashboard/error.tsx
#
# Modified files (16):
#   gateway/src/index.ts                        — env validation, APP_URL required
#   gateway/src/routes/notes.ts                 — batched notification inserts
#   payment-service/src/index.ts                — env validation
#   payment-service/src/services/accrual.ts     — FOR UPDATE lock, throw on missing IDs
#   payment-service/src/services/settlement.ts  — atomic webhook idempotency
#   key-service/src/index.ts                    — env validation
#   key-service/src/routes/keys.ts              — header normalization
#   key-custody/src/index.ts                    — env validation
#   key-custody/src/routes/keypairs.ts          — header normalization
#   web/src/lib/api.ts                          — new content/feed/follows/search namespaces
#   web/src/components/feed/ArticleCard.tsx      — use shared format utils
#   web/src/components/feed/NoteCard.tsx          — use shared format utils + api client
#   web/src/components/feed/FeedView.tsx          — use api client
#   web/src/components/home/FeaturedWriters.tsx   — use shared format utils + api client
#   web/src/components/ui/VoteControls.tsx        — use api client
#   web/src/components/replies/ReplySection.tsx   — use api client
#   web/src/app/write/page.tsx                   — lazy-load editor
#   web/src/app/[username]/page.tsx              — use shared format utils
#   RESILIENCE.md                                — prep work documented
#   DEPLOYMENT.md                                — v4.2.0 upgrade section
#   FIXES-REMAINING.md                           — remaining medium/low issues (new)
```

---

### From v4.0.0

New migration (020). Services changed: **gateway**, **web**. Deploy order: **migrate → rebuild gateway and web**.

This release adds the four frontend feature surfaces described in STEP-4-NEW-PAGES.md. All 29 previously orphaned backend endpoints now have frontend UI. The navigation shell (steps 1–3) was completed in v4.0.0; this release builds the pages that shell was designed to hold.

**New features:**

1. **Messages** (`/messages`) — Two-panel DM inbox consuming all 6 message endpoints. Conversation list with unread indicators, paginated message threads, auto mark-read on view, new conversation via user search, DM pricing (402) handling. Deep-link route `/messages/:conversationId` redirects to inbox with conversation pre-selected.

2. **Account** (`/account`) — Unified financial ledger replacing the scattered credits/accounts/tab views. Balance header with net position and free allowance meter. Chronological transaction ledger with All/Income/Spending filters. Active subscriptions with cancel controls. Pledges backed. Payment method and Stripe Connect status (moved from `/settings`).

3. **Dashboard Drives tab** — New "Drives" tab in the writer dashboard for managing pledge drives and commissions (11 endpoints). Create crowdfund or commission drives, view progress, pin to profile, accept/decline commissions, cancel. Free pass management added to the Articles tab via overflow menu on paywalled articles (3 endpoints). Dashboard tabs changed from `articles | drafts | credits | accounts | settings` to `articles | drafts | drives | settings`. Credits and Accounts tabs removed (functionality moved to `/account`). Writer Settings tab now includes subscription price setting, Stripe Connect status, and DM pricing placeholder.

4. **Admin** (`/admin`) — Moderation dashboard for admin users. Report queue with pending/resolved/all filters. Report cards with content preview, reporter info, and action buttons (remove content, suspend user, dismiss). Access gated by `isAdmin` field on user session.

**Backend changes:**

- `GET /auth/me` now returns `isAdmin: boolean` (derived from `ADMIN_ACCOUNT_IDS` env var)
- `GET /notifications` response now includes `conversationId` and `driveId` fields for frontend routing
- New migration 020 adds `conversation_id` and `drive_id` columns to notifications table

**Navigation updates:**

- Avatar dropdown now includes: Messages, Account (with balance), Export my data, and Admin (conditional on `isAdmin`)
- Mobile sheet promotes Messages alongside Notifications above the divider
- Notification routing fixed: `commission_request`/`drive_funded`/`pledge_fulfilled` → `/dashboard?tab=drives`, `new_message` → `/messages/:id`, `free_pass_granted` → `/article/:slug`

```bash
cd /root/platform-pub
git pull origin master

# Apply new migration (020 — notification routing columns)
docker exec -i platform-pub-postgres-1 psql -U platformpub platformpub < migrations/020_notification_routing_columns.sql

# Rebuild changed services
docker compose build gateway web
docker compose up -d gateway web
```

Verify:
```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
# gateway and web should show (healthy) after ~30s

curl -s http://localhost:3000/health
# Should return {"status":"ok","service":"gateway"}

# Verify migration applied
docker exec platform-pub-postgres-1 psql -U platformpub platformpub \
  -c "SELECT column_name FROM information_schema.columns WHERE table_name = 'notifications' AND column_name IN ('conversation_id', 'drive_id');"
# Should return 2 rows

# Visual check: open the site in a browser
# - Avatar dropdown should show Messages, Account, Export my data
# - /messages should show the DM inbox (two-panel on desktop)
# - /account should show unified financial ledger with balance header
# - /dashboard?tab=drives should show the drives management tab
# - /admin/reports should show the report queue (admin users only)
```

Changes:

```
# v4.1.0 — Step 4: Messages, Account, Dashboard Drives, Admin pages
#
# ── Backend: isAdmin on /auth/me ──
# GET /auth/me response now includes isAdmin: boolean, derived from
# ADMIN_ACCOUNT_IDS environment variable (comma-separated UUIDs).
# File: gateway/src/routes/auth.ts
#
# ── Backend: Notification routing columns ──
# Migration 020 adds conversation_id (UUID, FK → conversations) and
# drive_id (UUID, FK → pledge_drives) to the notifications table.
# GET /notifications response now includes conversationId and driveId
# for frontend routing of new_message and drive-related notifications.
# Files: migrations/020_notification_routing_columns.sql (new),
#        gateway/src/routes/notifications.ts,
#        schema.sql
#
# ── Frontend: API client extensions ──
# Added typed API clients for all previously orphaned endpoints:
#   messages: listConversations, getMessages, send, markRead, createConversation
#   drives: create, get, update, cancel, pledge, withdrawPledge, accept, decline,
#           togglePin, listByUser, myPledges
#   freePasses: list, grant, revoke
#   admin: listReports, resolveReport, suspendAccount
#   account: getTab, getMySubscriptions, exportReceipts, exportAccount,
#            updateSubscriptionPrice
# MeResponse extended with isAdmin: boolean.
# Notification interface extended with conversationId?, driveId?.
# File: web/src/lib/api.ts
#
# ── Frontend: Notification routing fix ──
# getDestUrl in NotificationBell now routes all 12 notification types:
#   commission_request, drive_funded, pledge_fulfilled → /dashboard?tab=drives
#   new_message → /messages/:conversationId (fallback: /messages)
#   free_pass_granted → /article/:slug
# File: web/src/components/ui/NotificationBell.tsx
#
# ── Frontend: Messages page (/messages) ──
# Two-panel DM inbox: 280px conversation list + message thread.
# Single-panel on mobile (list → tap → thread with back button).
# ConversationList: sorted by recency, unread dot, last message preview.
# MessageThread: paginated messages, auto mark-read, send box, DM pricing
# 402 handling. New conversation via user search.
# /messages/:conversationId redirects to /messages#id for deep-linking.
# Files: web/src/app/messages/page.tsx (new),
#        web/src/app/messages/[conversationId]/page.tsx (new),
#        web/src/components/messages/ConversationList.tsx (new),
#        web/src/components/messages/MessageThread.tsx (new)
#
# ── Frontend: Account page (/account) ──
# Unified financial ledger replacing dashboard credits/accounts tabs.
# BalanceHeader: net position (Literata 40px), free allowance progress bar.
# AccountLedger: chronological transaction list from /my/account-statement,
#   with All/Income/Spending filter tabs and paginated load-more.
# SubscriptionsSection: active subscriptions with cancel controls.
# PledgesSection: drives backed with status indicators.
# PaymentSection: card on file + Stripe Connect status (moved from /settings).
# Files: web/src/app/account/page.tsx (new),
#        web/src/components/account/BalanceHeader.tsx (new),
#        web/src/components/account/AccountLedger.tsx (new),
#        web/src/components/account/SubscriptionsSection.tsx (new),
#        web/src/components/account/PledgesSection.tsx (new),
#        web/src/components/account/PaymentSection.tsx (new)
#
# ── Frontend: Dashboard Drives tab ──
# Dashboard tabs changed: articles | drafts | credits | accounts | settings
#   → articles | drafts | drives | settings.
# Credits and Accounts tabs removed (moved to /account).
# "View account →" link added to dashboard header.
# DrivesTab: active drives with progress bars, incoming commissions with
#   accept/decline, completed/cancelled history, "New drive" creation form.
# DriveCreateForm: crowdfund vs commission radio, target amount, description.
# DriveCard: progress bar, pin toggle, cancel, accept/decline actions.
# FreePassManager: inline panel on paywalled articles in Articles tab,
#   with grant (username input) and revoke controls.
# WriterSettingsTab: subscription price field (PATCH /settings/subscription-price),
#   Stripe Connect status, DM pricing placeholder.
# Files: web/src/app/dashboard/page.tsx (rewritten),
#        web/src/components/dashboard/DrivesTab.tsx (new),
#        web/src/components/dashboard/DriveCreateForm.tsx (new),
#        web/src/components/dashboard/DriveCard.tsx (new),
#        web/src/components/dashboard/FreePassManager.tsx (new)
#
# ── Frontend: Admin pages (/admin) ──
# /admin redirects to /admin/reports (or /feed if not admin).
# Report queue with pending/resolved/all filter tabs.
# ReportCard: content preview, reporter info, action buttons
#   (remove content → PATCH report, suspend user → POST /admin/suspend,
#   dismiss → PATCH report). Resolved reports greyed out.
# Access gated by user.isAdmin on frontend; backend already checks
#   ADMIN_ACCOUNT_IDS on admin endpoints.
# Files: web/src/app/admin/page.tsx (new),
#        web/src/app/admin/reports/page.tsx (new),
#        web/src/components/admin/ReportCard.tsx (new)
#
# ── Frontend: Nav integration ──
# AvatarDropdown restructured per NAVIGATION-ARCHITECTURE.md:
#   Group 1 (identity): Profile, Messages, Notifications
#   Group 2 (money & content): Account (with balance), Reading history
#   Group 3 (meta): Settings, Export my data, Admin (conditional), Log out
# MobileSheet: Messages promoted above divider alongside Notifications.
#   Account added in same group as Reading history.
# ExportModal: confirmation dialog with Portable receipts download and
#   Full account export (writer only). Triggers blob download.
# Files: web/src/components/layout/Nav.tsx,
#        web/src/components/ExportModal.tsx (new)
#
# New files (18):
#   migrations/020_notification_routing_columns.sql
#   web/src/app/messages/page.tsx
#   web/src/app/messages/[conversationId]/page.tsx
#   web/src/app/account/page.tsx
#   web/src/app/admin/page.tsx
#   web/src/app/admin/reports/page.tsx
#   web/src/components/messages/ConversationList.tsx
#   web/src/components/messages/MessageThread.tsx
#   web/src/components/account/BalanceHeader.tsx
#   web/src/components/account/AccountLedger.tsx
#   web/src/components/account/SubscriptionsSection.tsx
#   web/src/components/account/PledgesSection.tsx
#   web/src/components/account/PaymentSection.tsx
#   web/src/components/dashboard/DrivesTab.tsx
#   web/src/components/dashboard/DriveCreateForm.tsx
#   web/src/components/dashboard/DriveCard.tsx
#   web/src/components/dashboard/FreePassManager.tsx
#   web/src/components/ExportModal.tsx
#
# Modified files (6):
#   gateway/src/routes/auth.ts         — isAdmin field
#   gateway/src/routes/notifications.ts — conversation_id, drive_id in response
#   schema.sql                         — notification routing columns
#   web/src/lib/api.ts                 — all new API clients, MeResponse.isAdmin, Notification extensions
#   web/src/components/ui/NotificationBell.tsx — full notification routing
#   web/src/components/layout/Nav.tsx   — avatar dropdown, mobile sheet updates
#   web/src/app/dashboard/page.tsx      — rewritten (drives tab, settings tab, free passes)
```

---

### From v3.31.0

No schema changes. No new migrations. Services changed: **web** only. Deploy order: **rebuild web**.

This is a major frontend redesign — the entire visual language has been overhauled. No backend services are affected. The release includes:

- **Navigation**: fixed left sidebar replaced with horizontal top bar (4 mono-caps links: FEED, WRITE, DASHBOARD, ABOUT) + avatar dropdown ("me" menu) + mobile hamburger sheet
- **Two layout registers**: `useLayoutMode()` hook returns `'platform'` or `'canvas'` based on route. Canvas mode (article reader, writer profiles) shows a minimal grey wordmark and back link. Platform mode shows full branded nav
- **LayoutShell**: new context provider wrapping all content, exposing layout mode via `useLayoutModeContext()`
- **Typography system**: three fonts with distinct roles — Literata (serif, literary content: headlines, body, excerpts), Instrument Sans (sans, social/UI: notes, replies, buttons, forms), IBM Plex Mono (mono, infrastructure: nav, bylines, metadata, timestamps, action labels). Replaces Source Sans 3 everywhere
- **Colour palette**: green/cream palette (`#EDF5F0`, `#DDEEE4`, `#FFFAEF`, `#0F1F18`) replaced with white/grey/crimson. White background everywhere. Grey scale (50–600) for text hierarchy. Crimson only on logo, paywalled borders, prices, and CTAs. Canvas mode is fully neutral except paywall gate
- **Buttons**: no border-radius, no 3D bottom-border effect. `opacity: 0.85` hover. New `btn-ghost` variant (replaces `btn-soft`)
- **Drop cap**: black, not crimson (writer's neutral space)
- **Article reader**: roman title (not italic), black links, `grey-200` blockquote borders
- **Feed cards**: no background colour, thin `grey-100` bottom rules, 3px crimson left border on paywalled articles only

**New files:**
- `web/src/hooks/useLayoutMode.ts`
- `web/src/components/layout/LayoutShell.tsx`

**Significantly modified files:**
- `web/tailwind.config.js` — new colour tokens (grey scale, crimson, white, black), Instrument Sans as default sans, legacy tokens preserved
- `web/src/app/globals.css` — complete rewrite of component classes, Instrument Sans font import added
- `web/src/app/layout.tsx` — sidebar offset removed, LayoutShell wrapper added
- `web/src/components/layout/Nav.tsx` — complete rewrite (sidebar → top bar + avatar dropdown)
- All feed, article, home, and page components — migrated from old tokens to v2 design system

```bash
cd /root/platform-pub
git pull origin master

# No migration needed — rebuild web only
docker compose build web
docker compose up -d web
```

Verify:
```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
# web should show (healthy) after ~30s

# Visual check: open the site in a browser
# - Homepage should have white background, Literata hero text, crimson accent rule
# - Navigation should be a horizontal top bar, not a left sidebar
# - Feed should show article cards with no background, thin rules between them
# - Article reader should have neutral white canvas, roman (not italic) title
```

Changes:

```
# v4.0.0 — Frontend redesign: navigation, typography, and colour system
#
# ── Layout system ──
# New useLayoutMode() hook returns 'platform' | 'canvas' based on pathname.
# Canvas routes: /article/* and /:username. All other routes are platform.
# LayoutShell component provides mode via React context.
# Files: web/src/hooks/useLayoutMode.ts, web/src/components/layout/LayoutShell.tsx,
#        web/src/app/layout.tsx
#
# ── Navigation rewrite ──
# Fixed 240px left sidebar replaced with 56px horizontal top bar.
# Platform mode: logo (Literata italic crimson 20px), 4 Plex Mono uppercase
# nav links, search input, avatar with dropdown menu.
# Canvas mode: grey 16px logo, "← FEED" back link, avatar only.
# Mobile: hamburger toggles a sheet below the top bar.
# Avatar dropdown: 3 sections (identity, money/content, meta).
# Files: web/src/components/layout/Nav.tsx, web/src/app/layout.tsx
#
# ── Typography system ──
# Three fonts with distinct roles:
#   Literata (serif): article headlines, standfirsts, body, reader, profile names
#   Instrument Sans (sans): notes, replies, buttons, forms, UI chrome
#   IBM Plex Mono (mono): nav, tabs, bylines, metadata, timestamps, action labels
# Source Sans 3 removed from all components. Preserved in font import for
# any custom content that may reference it.
# Files: web/tailwind.config.js, web/src/app/globals.css, all components
#
# ── Colour palette ──
# Green/cream tokens replaced with white/grey/crimson:
#   bg-surface (#EDF5F0) → bg-white
#   bg-card (#FFFAEF) → bg-white (no card backgrounds)
#   text-ink (#0F1F18) → text-black (#1A1A1A)
#   text-content-secondary (#263D32) → text-grey-600 (#666666)
#   text-content-muted (#3D5E4D) → text-grey-400 (#999999)
#   text-content-faint (#6B8E7A) → text-grey-300 (#BBBBBB)
#   border-rule (#B8D2C1) → border-grey-200 (#E5E5E5)
#   accent (#B5242A) → crimson (#B5242A) (same value, new token name)
# Legacy Tailwind tokens preserved in config for any missed references.
# Files: web/tailwind.config.js, web/src/app/globals.css, all .tsx files
#
# ── Button redesign ──
# No border-radius. No 3D bottom-border. Hover is opacity: 0.85.
# New btn-ghost variant (transparent bg, grey-200 border).
# btn-soft kept as legacy alias mapping to btn-ghost.
# File: web/src/app/globals.css
#
# ── Article reader (canvas mode) ──
# White background, no platform branding. Title is Literata roman (not italic).
# Links are black underlined (not crimson). Blockquotes have grey-200 border.
# Drop cap is black (#1A1A1A), not crimson. Paywall gate is the one exception
# where crimson appears in canvas mode.
# Files: web/src/components/article/ArticleReader.tsx,
#        web/src/components/article/PaywallGate.tsx
#
# ── Feed components ──
# Article cards: no background, thin grey-100 bottom rule. 3px crimson left
# border on paywalled articles (always visible, not hover state). Bylines in
# Plex Mono caps, headlines in Literata italic, standfirsts in Literata roman.
# Note cards: 28px avatar, Instrument Sans body, Plex Mono timestamps.
# Quote cards: grey-50 background, grey-200 or crimson left border.
# Files: web/src/components/feed/ArticleCard.tsx, NoteCard.tsx, QuoteCard.tsx,
#        FeedView.tsx, NoteComposer.tsx
#
# ── Homepage ──
# 48px Literata hero, Plex Mono section labels, grey-50 how-it-works section.
# Files: web/src/app/page.tsx, web/src/components/home/FeaturedWriters.tsx
```

---

### From v3.30.0

New migration (019). No service rebuilds needed. Deploy order: **migrate only**.

This release fixes a bug where the notification deduplication index (`idx_notifications_dedup`) prevented repeat notifications from ever being created. Once a notification was marked as read, the old unique index still occupied the slot, so `ON CONFLICT DO NOTHING` silently dropped new events of the same type from the same actor. The fix converts the unique index to a **partial index** (`WHERE read = false`) so only unread rows are constrained. It also wraps `actor_id` in `COALESCE` for consistent NULL handling.

```bash
cd /root/platform-pub
git pull origin master

# Apply migration (019 — fix notification dedup index)
docker exec -i platform-pub-postgres-1 psql -U platformpub platformpub < migrations/019_fix_notification_dedup.sql
```

Verify:
```bash
# Confirm the index is now partial (should show WHERE clause)
docker exec platform-pub-postgres-1 psql -U platformpub platformpub \
  -c "\di+ idx_notifications_dedup"

# Confirm migration recorded
docker exec platform-pub-postgres-1 psql -U platformpub platformpub \
  -c "SELECT filename FROM _migrations ORDER BY id DESC LIMIT 5;"
```

Changes:

```
# v3.31.0 — Fix notification dedup index blocking repeat notifications
#
# The unique index idx_notifications_dedup covered all rows (read and unread),
# so once a notification was read, new events of the same (recipient, actor,
# type, targets) combination were silently dropped by ON CONFLICT DO NOTHING.
# Repeat events (re-follow, second reply from same user, etc.) never created
# new notifications.
#
# Fix: convert to a partial unique index (WHERE read = false). Only unread
# rows are constrained — once marked read, the slot opens for new events.
# Also wraps actor_id in COALESCE for consistent NULL handling.
#
# Files:
#   migrations/019_fix_notification_dedup.sql — drops old index, creates partial index
#   schema.sql                                — updated to reflect corrected index
```

---

### From v3.29.0

No schema changes. Services changed: **gateway**, **web**. Deploy order: **rebuild changed services**.

This release adds a dev-mode instant login flow and fixes Docker networking for the local dev environment. The `gateway/.env` service URLs now use Docker service names instead of `localhost`, and `web/.env` separates the server-side `GATEWAY_URL` (for Next.js SSR, must use Docker service name) from the client-side `NEXT_PUBLIC_GATEWAY_URL` (must use `localhost`).

**Production impact: none.** The dev-login endpoint (`POST /api/v1/auth/dev-login`) only registers when `NODE_ENV=development`. The frontend dev-login button only renders in development builds.

```bash
cd /root/platform-pub
git pull origin master

# No migration needed — rebuild gateway and web only
docker compose build gateway web
docker compose up -d gateway web
```

Verify:
```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
# gateway and web should show (healthy) after ~30s

curl -s http://localhost:3000/health
# Should return {"status":"ok","service":"gateway"}
```

Changes:

```
# v3.30.0 — Dev-mode instant login and local Docker networking fixes
#
# ── Dev-login endpoint ──
# Added POST /auth/dev-login (gateway, development only). Accepts an email,
# looks up the account, and creates a session directly — no magic link needed.
# Guarded by NODE_ENV=development; the route is not registered in production.
# Files: gateway/src/routes/auth.ts
#
# ── Dev-login frontend button ──
# Added "Instant dev login" button to /auth page, rendered only in development
# builds (process.env.NODE_ENV === 'development'). Calls /auth/dev-login then
# hydrates session via /auth/me.
# Files: web/src/app/auth/page.tsx, web/src/lib/api.ts
#
# ── Local dev env fixes ──
# gateway/.env: DATABASE_URL, PAYMENT_SERVICE_URL, KEY_SERVICE_URL,
#   KEY_CUSTODY_URL, BLOSSOM_URL, and PLATFORM_RELAY_WS_URL now use Docker
#   service names (postgres, payment, keyservice, key-custody, blossom, strfry)
#   instead of localhost, which does not resolve correctly inside containers.
#   MEDIA_DIR changed to /app/media (the container path).
# web/.env: GATEWAY_URL changed to http://gateway:3000 (server-side, resolves
#   inside Docker network). NEXT_PUBLIC_GATEWAY_URL remains http://localhost:3000
#   (client-side, resolves in the browser).
```

#### Local development quick-start

After cloning, the local dev stack can be started with:

```bash
docker compose up -d
```

To log in without email delivery:

1. Go to http://localhost:3010/auth
2. Enter your email address
3. Click **"Instant dev login"** at the bottom of the page

This bypasses the magic-link flow entirely and creates a session immediately.

---

### From v3.28.0

New migration (018). Services changed: **gateway**, **payment-service**, **web**, plus **docker-compose.yml**. Deploy order: **migrate → rebuild changed services**.

This release implements all medium-priority fixes from the codebase audit (`FIXES.md` items 13–22): subscription expiry, XSS sanitisation, LIKE injection, config cache TTL, notification type sync, drive update truthiness, Docker health checks, auth hydration guard, and FK ON DELETE clauses.

```bash
cd /root/platform-pub
git pull origin master

# Apply new migration (018 — ON DELETE clauses for FKs in migrations 016-017)
docker exec -i platform-pub-postgres-1 psql -U platformpub platformpub < migrations/018_add_on_delete_clauses.sql

# Rebuild changed services
docker compose build gateway payment web
docker compose up -d
```

Verify:
```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
# All services should show (healthy) after ~30s

curl -s http://localhost:3000/health
# Should return {"status":"ok","service":"gateway"}

# Verify health checks are active on all services
docker inspect --format='{{.State.Health.Status}}' platform-pub-gateway-1
# Should return "healthy"

# Verify subscription expiry worker ran on startup
docker logs platform-pub-gateway-1 --tail 20 | grep -i "subscript"
```

Changes:

```
# v3.29.0 — Medium-priority audit fixes (FIXES.md items 13–22)
#
# ── Fix 13: Subscription lifecycle management ──
# Added expireAndRenewSubscriptions() to transition active subscriptions
# past their current_period_end to 'expired'. Runs on a 1-hour timer in
# the gateway (also runs once on startup), alongside expireOverdueDrives.
# Files: gateway/src/routes/subscriptions.ts, gateway/src/index.ts
#
# ── Fix 14: Sanitize renderMarkdownSync links ──
# Added URL protocol allowlist to the regex-based link replacement.
# Only http://, https://, /, and # hrefs are rendered as <a> tags.
# Links with disallowed protocols (e.g. javascript:) are stripped to
# plain text, closing the XSS vector.
# File: web/src/lib/markdown.ts
#
# ── Fix 15: Escape LIKE metacharacters in search ──
# Added escapeLike() helper that escapes %, _, and \ before wrapping
# with % for ILIKE queries. Applied to both article search (title +
# content_free) and writer search (username + display_name). Searching
# for "%" no longer matches all rows.
# File: gateway/src/routes/search.ts
#
# ── Fix 17: Config cache TTL in AccrualService ──
# AccrualService cached platform config forever with no TTL.
# invalidateConfig() existed but was never called. Added a 5-minute
# TTL so config reloads automatically. invalidateConfig() also resets
# the TTL timestamp.
# File: payment-service/src/services/accrual.ts
#
# ── Fix 18: Sync notification types frontend/backend ──
# Frontend Notification type union expanded from 5 to 12 types, adding:
# commission_request, drive_funded, pledge_fulfilled, new_message,
# free_pass_granted, dm_payment_required, new_user. Both NotificationBell
# and the notifications page now have labels for all types plus a
# fallback renderer for any future unrecognised types.
# Files: web/src/lib/api.ts, web/src/components/ui/NotificationBell.tsx,
#        web/src/app/notifications/page.tsx
#
# ── Fix 19: Drive update truthiness fix ──
# Changed if (data.fundingTargetPence) and if (data.suggestedPricePence)
# to !== undefined checks. Previously, setting either field to 0 was
# silently skipped because 0 is falsy.
# File: gateway/src/routes/drives.ts
#
# ── Fix 20: Docker health checks ──
# Added healthcheck blocks to all 7 services that were missing them:
# gateway (:3000), payment (:3001), keyservice (:3002), key-custody
# (:3004), web (:3000), nginx (:80), blossom (:3003). All backend
# services already had /health endpoints.
# File: docker-compose.yml
#
# ── Fix 21: Auth hydration guard ──
# AuthProvider now renders a loading spinner until fetchMe() resolves,
# preventing children from rendering in an indeterminate auth state.
# Protected routes no longer flash or redirect incorrectly on page load.
# File: web/src/components/layout/AuthProvider.tsx
#
# ── Fix 22: ON DELETE clauses for migrations 016-017 ──
# New migration 018 drops and re-adds 6 FK constraints with ON DELETE
# CASCADE: conversations.created_by, dm_pricing.owner_id,
# dm_pricing.target_id, pledge_drives.creator_id,
# pledge_drives.target_writer_id, pledges.pledger_id.
# File: migrations/018_add_on_delete_clauses.sql (new)
#
# Files changed:
#   gateway/src/routes/subscriptions.ts       — subscription expiry function
#   gateway/src/index.ts                      — expiry workers on timer
#   gateway/src/routes/search.ts              — escapeLike helper
#   gateway/src/routes/drives.ts              — truthiness fix
#   payment-service/src/services/accrual.ts   — config cache TTL
#   web/src/lib/markdown.ts                   — link sanitisation
#   web/src/lib/api.ts                        — notification type union
#   web/src/components/ui/NotificationBell.tsx — notification labels
#   web/src/app/notifications/page.tsx         — notification labels
#   web/src/components/layout/AuthProvider.tsx — loading guard
#   docker-compose.yml                        — health checks
#   migrations/018_add_on_delete_clauses.sql   — FK ON DELETE clauses (new)
```

---

### From v3.27.2

No new migrations. No schema changes. Services changed: **gateway**, **payment-service**, **nginx**, plus all Dockerfiles and docker-compose.yml. Deploy order: **rebuild all services**.

This release implements all high-priority fixes from the codebase audit (`FIXES.md` items 5–12): auth hardening, settlement idempotency, DM visibility, security headers, rate limiting, admin middleware fix, non-root containers, and internal port lockdown.

```bash
cd /root/platform-pub
git pull origin master

# Install new gateway dependency (@fastify/rate-limit)
cd gateway && npm install && cd ..

# Rebuild ALL services (Dockerfiles changed for non-root user)
docker compose build --no-cache
docker compose up -d
```

Verify:
```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
# All services should be running

curl -s http://localhost:3000/health
# Should return {"status":"ok","service":"gateway"}

# Verify containers run as non-root
docker exec platform-pub-gateway-1 whoami
# Should return "app"

# Verify internal services are not exposed on host
ss -tlnp | grep -E '3001|3002|3003|3004'
# Should return nothing (no host port bindings)

# Verify nginx security headers
curl -sI https://platform.pub | grep -i strict-transport
# Should return Strict-Transport-Security header
```

Changes:

```
# v3.28.0 — High-priority audit fixes: auth, payments, security hardening
#
# ── Fix 5: Account status check in auth middleware ──
# requireAuth now queries accounts.status after JWT verification.
# Suspended accounts are rejected with 403 immediately, closing the
# window where a suspended user retained full API access until JWT
# expiry (up to 7 days).
# File: gateway/src/middleware/auth.ts
#
# ── Fix 6: Settlement confirmation idempotency guard ──
# confirmSettlement now checks stripe_charge_id before deducting from
# the tab. Duplicate Stripe webhooks (payment_intent.succeeded) no
# longer double-debit the reader. The UPDATE uses
# AND stripe_charge_id IS NULL as a belt-and-braces guard.
# File: payment-service/src/services/settlement.ts
#
# ── Fix 7: DM sender visibility ──
# GET /messages/:conversationId WHERE clause changed from
# dm.recipient_id = $2 to (dm.recipient_id = $2 OR dm.sender_id = $2).
# Senders now see their own sent messages in conversation threads.
# File: gateway/src/routes/messages.ts
#
# ── Fix 8: Nginx security headers ──
# Added to the HTTPS server block: Strict-Transport-Security (HSTS,
# 2-year max-age, includeSubDomains), X-Frame-Options DENY,
# X-Content-Type-Options nosniff, Referrer-Policy
# strict-origin-when-cross-origin, Permissions-Policy (camera,
# microphone, geolocation disabled), Content-Security-Policy
# (default-src 'self', script-src 'self', style-src 'self'
# 'unsafe-inline', img-src 'self' data: blob:, connect-src 'self' wss:).
# File: nginx.conf
#
# ── Fix 9: Gateway rate limiting ──
# Installed @fastify/rate-limit. Global default: 100 req/min per
# user (or IP for unauthenticated). Per-route overrides:
#   - POST /auth/signup, /auth/login: 5 req/min per IP
#   - POST /articles/:id/gate-pass: 20 req/min per user
#   - GET /search: 30 req/min per IP
#   - POST /messages/:conversationId (DM send): 10 req/min per user
# Files: gateway/package.json, gateway/src/index.ts,
#        gateway/src/routes/auth.ts, gateway/src/routes/articles.ts,
#        gateway/src/routes/search.ts, gateway/src/routes/messages.ts
#
# ── Fix 10: requireAdmin return statement ──
# Added missing return before reply.status(403).send() in requireAdmin.
# Previously, execution fell through to the route handler after sending
# the 403 response, allowing non-admin users to execute admin actions.
# File: gateway/src/routes/moderation.ts
#
# ── Fix 11: Non-root Docker containers ──
# All five Dockerfiles now create an unprivileged "app" user and
# switch to it before CMD. Container escape no longer grants root
# on the host.
# Files: gateway/Dockerfile, payment-service/Dockerfile,
#        key-service/Dockerfile, key-custody/Dockerfile, web/Dockerfile
#
# ── Fix 12: Internal service ports removed from host ──
# Removed ports: bindings for payment (3001), keyservice (3002),
# key-custody (3004), and blossom (3003) from docker-compose.yml.
# These services communicate only via Docker's internal network.
# Host processes can no longer bypass gateway auth by calling
# internal services directly.
# File: docker-compose.yml
#
# Files changed:
#   gateway/src/middleware/auth.ts           — account status check
#   payment-service/src/services/settlement.ts — idempotency guard
#   gateway/src/routes/messages.ts           — sender visibility fix
#   nginx.conf                               — security headers
#   gateway/package.json                     — @fastify/rate-limit dep
#   gateway/src/index.ts                     — rate limit registration
#   gateway/src/routes/auth.ts               — per-route rate limits
#   gateway/src/routes/articles.ts           — per-route rate limits
#   gateway/src/routes/search.ts             — per-route rate limits
#   gateway/src/routes/moderation.ts         — return statement fix
#   gateway/Dockerfile                       — non-root user
#   payment-service/Dockerfile               — non-root user
#   key-service/Dockerfile                   — non-root user
#   key-custody/Dockerfile                   — non-root user
#   web/Dockerfile                           — non-root user
#   docker-compose.yml                       — removed internal port bindings
```

---

### From v3.27.0

Migration fix only. No service rebuilds needed. Deploy order: **git pull → re-run migrations**.

Migration 015 (`access_mode_and_unlock_types.sql`) failed on production because the `article_unlocks` table did not exist. This table should have been created by migration 005, but on databases where 005 was bootstrapped (marked as applied without running its SQL — see v3.21.0 Case C notes), the table was never created. The fix adds `CREATE TABLE IF NOT EXISTS article_unlocks` to migration 015 before altering the table, so it works whether or not the table already exists.

```bash
cd /root/platform-pub
git pull origin master

# Re-run the migration runner (014 already applied, 015 will now succeed)
DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@127.0.0.1:5432/platformpub \
  npx tsx shared/src/db/migrate.ts
```

Verify:
```bash
docker exec platform-pub-postgres-1 psql -U platformpub platformpub -c "\d article_unlocks"
docker exec platform-pub-postgres-1 psql -U platformpub platformpub -c "SELECT filename FROM _migrations ORDER BY id;"
# Should show 015_access_mode_and_unlock_types.sql (and 016, 017) as applied
```

Changes:

```
# v3.27.1 — Fix migration 015 failure on databases missing article_unlocks table
#
# Migration 015 assumed article_unlocks existed (created by migration 005).
# On databases where 005 was bootstrapped via INSERT into _migrations
# without running the SQL, the table was never created.
#
# Fix: migration 015 now includes CREATE TABLE IF NOT EXISTS article_unlocks
# before altering the constraint, so it works on all database states.
#
# Files changed:
#   migrations/015_access_mode_and_unlock_types.sql — added CREATE TABLE IF NOT EXISTS
```

---

### From v3.26.0

No new migrations. Schema file regenerated. Services changed: **gateway** (bug fixes). Deploy order: **gateway**.

This release fixes three critical bugs identified in the codebase audit (see `AUDIT.md`). No database migration needed — the fixes are application-level. `schema.sql` has been regenerated to include all tables from migrations 001–017 so fresh Docker installs produce a working database.

```bash
cd /root/platform-pub
git pull origin master

docker compose build --no-cache gateway
docker compose up -d gateway
```

Verify:
```bash
docker ps --format "table {{.Names}}\t{{.Status}}" | grep gateway
docker logs platform-pub-gateway-1 --tail 5
curl -s http://localhost:3000/health
# Should return {"status":"ok","service":"gateway"}
```

Changes:

```
# v3.27.0 — Critical audit fixes: schema.sql, drive fulfilment, gate-pass idempotency
#
# ── schema.sql regenerated (Audit #1) ──
# schema.sql was frozen at the pre-migration state. Fresh Docker installs
# got a database missing 13+ tables (subscriptions, notifications, votes,
# conversations, pledge_drives, etc). The file now includes all tables
# and columns from migrations 001–017. Fresh `docker compose up` on a
# new checkout now produces a complete, working database.
# File: schema.sql
#
# ── Drive fulfilment wrapped in transaction (Audit #3) ──
# checkAndTriggerDriveFulfilment issued SELECT ... FOR UPDATE via the
# shared pool (auto-commit mode). The row lock was released immediately
# after the SELECT, leaving the subsequent UPDATE unprotected. Concurrent
# article publishes for the same draft could trigger double fulfilment.
# Now wrapped in withTransaction() so the lock is held for both queries.
# File: gateway/src/routes/drives.ts
#
# ── Gate-pass made idempotent (Audit #4) ──
# The gate-pass flow called the payment service, then the key service,
# then recordPurchaseUnlock. A crash between payment and unlock left the
# reader charged with no permanent access record. On retry,
# checkArticleAccess found no unlock, so the reader was charged again.
# Fix: recordPurchaseUnlock is now called immediately after payment
# succeeds (before key issuance). On retry, checkArticleAccess finds
# the existing unlock and serves the key without re-charging.
# File: gateway/src/routes/articles.ts
#
# ── Remaining audit items documented ──
# FIXES.md added with prioritised fix list for all remaining audit
# findings (high/medium/low).
# File: FIXES.md
#
# Files changed:
#   schema.sql                          — regenerated with all migrations
#   gateway/src/routes/drives.ts        — transaction wrapping
#   gateway/src/routes/articles.ts      — idempotent gate-pass
#   FIXES.md                            — remaining audit fix plan (new)
```

---

### From v3.25.0

No schema changes. No new migrations. Services changed: **web only** (frontend-only visual refresh). Deploy order: **web**.

This release implements Design Spec v2 — a comprehensive visual refresh ("chunky, robust, spirited") across the entire frontend. No backend changes.

```bash
cd /root/platform-pub
git pull origin master

docker compose build --no-cache web
docker compose up -d web
```

Verify:
```bash
docker ps --format "table {{.Names}}\t{{.Status}}" | grep web
docker logs platform-pub-web-1 --tail 5

# v3.26.0 — Design Spec v2: chunky, robust, spirited visual refresh
#
# ── Colour tokens updated ──
# content-muted darkened/warmed: #4A6B5A → #3D5E4D
# content-faint darkened/warmed: #7A9A8A → #6B8E7A
# File: web/tailwind.config.js
#
# ── Rules & dividers thickened ──
# .rule: 1px → 2px. .rule-inset: 1px → 1.5px. .rule-accent: 1px → 2.5px.
# hr base style: 1px → 2px. Sidebar right border: 1px → 2px.
# Feed tab underline border: 1px → 2px (border-rule).
# Article cards gain 2.5px bottom border (#B8D2C1).
# Paywall gate gains 3px top/bottom borders (#B5242A).
# Sidebar user section gains 2px top border (#B8D2C1).
# File: web/src/app/globals.css
#
# ── Buttons overhauled — typewriter-key depress effect ──
# All three button variants (.btn, .btn-accent, .btn-soft) upgraded:
# font-size 0.875rem → 1rem, font-weight 500 → 600,
# padding 0.75rem 2rem → 1rem 2.5rem.
# .btn gains border-bottom: 3px solid #060e0a (shadow ledge).
# .btn-accent gains border-bottom: 3px solid #8A1B20.
# .btn-soft gains border: 1.5px solid #B8D2C1 (visible outline).
# All gain :active { transform: translateY(2px); border-bottom-width: 1px }
# for physical keypress feel.
# New .btn-sm modifier: font-size 0.875rem, padding 0.625rem 1.5rem.
# File: web/src/app/globals.css
#
# ── Feed tabs resized ──
# Font size: 0.8125rem → 0.9375rem (15px).
# Inactive weight: 400 → 500. Active weight: 600 → 700.
# Active underline: 2px → 3px. Padding: 0.5rem 0 → 0.625rem 1.25rem.
# Updated colour refs to new content-faint/content-muted values.
# File: web/src/app/globals.css
#
# ── Ornament size bumped ──
# · · · ornament: 0.6875rem → 0.75rem.
# File: web/src/app/globals.css
#
# ── Wordmark / logo heavier ──
# Font size: 28px → 30px. Font weight: 600 → 700.
# Border: 1.5px → 3.5px. Padding: 5px 14px 7px → 5px 15px 8px.
# File: web/src/components/layout/Nav.tsx
#
# ── Sidebar navigation updated ──
# Link font size: 15px → 17px. Link padding: py-3 → py-[14px].
# Active border: 2px → 4px. Inactive links gain invisible 4px left
# border for alignment. Active weight: semibold → bold.
# Inactive weight: default → medium (500).
# User name: text-xs → 14px. Balance: 11px → 13px. Logout: 13px.
# Avatar initials minimum: 10px → 12px (all nav sections).
# Sidebar right border: added 2px border-rule on lg+.
# File: web/src/components/layout/Nav.tsx
#
# ── Article cards restyled ──
# Left border: 4px solid transparent, → accent (#B5242A) on hover.
# Bottom border: 2.5px solid #B8D2C1 (cards stack with gap:0).
# Author label: 11px/600 → 13px/700, letter-spacing 0.04em → 0.05em.
# Headline: 26px → 28px. Excerpt: 14.5px → 16px.
# Metadata line: 11px → 13px.
# Feed card spacing: mt-[10px] gap removed (bottom borders separate).
# Files: web/src/components/feed/ArticleCard.tsx,
#        web/src/components/feed/FeedView.tsx
#
# ── Homepage: three new sections added ──
# Section 2 — Manifesto ("THE DEAL"): IBM Plex Mono label, crimson
# accent rule, four Literata italic statements separated by rules.
# Section 3 — How it works: green container (#DDEEE4) with 1.5px
# border, three-column responsive grid (01/02/03 steps).
# Section 4 — Featured writers: mono label, 3 article cards from
# new /api/v1/feed/featured endpoint, "Read the feed →" btn-soft.
# CTA button changed from .btn to .btn-accent.
# New component: web/src/components/home/FeaturedWriters.tsx
# Files: web/src/app/page.tsx,
#        web/src/components/home/FeaturedWriters.tsx (new)
#
# ── Paywall gate redesigned ──
# Gradient fade: 80px → 100px. Top/bottom borders: 3px solid #B5242A.
# Heading: 20px → 26px. Price: 28px → 40px. Subtext: 13px → 15px.
# Trust signals: 12px → 13px, weight 500. Ornament: 0.75rem.
# Colour refs updated to new content-muted/faint values.
# File: web/src/components/article/PaywallGate.tsx
#
# ── Auth page inputs bordered ──
# Heading: text-2xl (24px) → 28px. All inputs gain
# border: 1.5px solid #B8D2C1, padding px-3 py-2.5 → px-4 py-[14px],
# font-size text-mono-sm → 16px. Google button gains same border
# and padding. Labels: 12px → 13px.
# File: web/src/app/auth/page.tsx
#
# ── Note composer bordered ──
# Container gains border: 1.5px solid #B8D2C1.
# Padding standardised to 0.875rem 1.25rem. Font: 15px.
# File: web/src/components/feed/NoteComposer.tsx
#
# ── NoteCard type scale consistency ──
# Note body: 15px → 16px. Timestamp: 12px → 13px.
# Action labels: 12px → 13px. Delete button: 12px → 13px.
# Excerpt pennant metadata: 11px → 13px.
# Colour refs updated to new content-faint (#6B8E7A).
# File: web/src/components/feed/NoteCard.tsx
#
# ── ArticleReader byline pass ──
# Author name: text-sm → 14px. Publish date: text-ui-xs → 13px.
# File: web/src/components/article/ArticleReader.tsx
#
# Files changed:
#   web/tailwind.config.js
#   web/src/app/globals.css
#   web/src/app/page.tsx
#   web/src/app/auth/page.tsx
#   web/src/components/layout/Nav.tsx
#   web/src/components/feed/ArticleCard.tsx
#   web/src/components/feed/FeedView.tsx
#   web/src/components/feed/NoteCard.tsx
#   web/src/components/feed/NoteComposer.tsx
#   web/src/components/article/PaywallGate.tsx
#   web/src/components/article/ArticleReader.tsx
#   web/src/components/home/FeaturedWriters.tsx (new)
```

---

### From v3.24.0

Schema changes: three new migrations (015, 016, 017). Services changed: **gateway only** (no web/frontend changes). Deploy order: **migrations → gateway**.

This release adds five new backend features:

1. **`access_mode` replaces `is_paywalled`** — The `articles.is_paywalled` boolean is replaced with `articles.access_mode` (`'public'` | `'paywalled'` | `'invitation_only'`). All gateway routes updated. API responses include both `accessMode` (new) and `isPaywalled` (computed, backwards-compatible).

2. **Free passes** — Authors can grant free access to paywalled articles via `POST /api/v1/articles/:articleId/free-pass`. Creates an `article_unlocks` row with `unlocked_via = 'author_grant'`. No `read_event`, no tab charge.

3. **Invitation-only articles** — Articles with `access_mode = 'invitation_only'` cannot be purchased. The gate-pass endpoint returns `403 invitation_required` instead of proceeding to payment. Access is granted via the free pass route.

4. **Direct messages** — NIP-17 E2E encrypted conversations. New tables: `conversations`, `conversation_members`, `direct_messages`, `dm_pricing`. Routes: create conversations, send/list/read messages. Block checking, mute filtering, DM pricing (anti-spam). NIP-17 gift-wrapped events published to relay async.

5. **Pledge drives** — Crowdfunding and commissions as first-class feed items. New tables: `pledge_drives`, `pledges` with `drive_status`/`drive_origin`/`pledge_status` enums. Full lifecycle: create → pledge → accept/decline (commissions) → publish → async fulfilment → fulfilled/expired/cancelled. Pledges are commitments, not charges — money only moves on fulfilment via the existing `read_events` → `reading_tabs` → `tab_settlements` pipeline. Auto-unpin on terminal state. Deadline expiry via `expireOverdueDrives()`.

```bash
cd /root/platform-pub
git pull origin master

# 1. Apply migrations in order
docker exec -i platform-pub-postgres-1 psql -U platformpub platformpub \
  < migrations/015_access_mode_and_unlock_types.sql

docker exec -i platform-pub-postgres-1 psql -U platformpub platformpub \
  < migrations/016_direct_messages.sql

docker exec -i platform-pub-postgres-1 psql -U platformpub platformpub \
  < migrations/017_pledge_drives.sql

# 2. Rebuild and restart gateway
docker compose build --no-cache gateway
docker compose up -d gateway
```

Verify:
```bash
docker logs platform-pub-gateway-1 --tail 5
curl -s http://localhost:3000/health
# Should return {"status":"ok","service":"gateway"}

# Verify schema changes applied
docker exec platform-pub-postgres-1 psql -U platformpub platformpub \
  -c "SELECT column_name FROM information_schema.columns WHERE table_name = 'articles' AND column_name = 'access_mode';"
# Should return 1 row

docker exec platform-pub-postgres-1 psql -U platformpub platformpub \
  -c "\dt conversations; \dt pledge_drives; \dt dm_pricing;"
# Should show all three tables
```

New gateway routes:
```
# Free passes
POST   /api/v1/articles/:articleId/free-pass
DELETE /api/v1/articles/:articleId/free-pass/:userId
GET    /api/v1/articles/:articleId/free-passes

# Direct messages
POST   /api/v1/conversations
POST   /api/v1/conversations/:id/members
GET    /api/v1/messages
GET    /api/v1/messages/:conversationId
POST   /api/v1/messages/:conversationId
POST   /api/v1/messages/:messageId/read

# Pledge drives
POST   /api/v1/drives
GET    /api/v1/drives/:id
PUT    /api/v1/drives/:id
DELETE /api/v1/drives/:id
POST   /api/v1/drives/:id/pledge
DELETE /api/v1/drives/:id/pledge
POST   /api/v1/drives/:id/accept
POST   /api/v1/drives/:id/decline
POST   /api/v1/drives/:id/pin
GET    /api/v1/drives/by-user/:userId
GET    /api/v1/my/pledges
```

Files changed:
```
# New files
gateway/src/routes/free-passes.ts    — free pass routes
gateway/src/routes/messages.ts       — DM routes
gateway/src/routes/drives.ts         — pledge drive routes + fulfilment + expiry
migrations/015_access_mode_and_unlock_types.sql
migrations/016_direct_messages.sql
migrations/017_pledge_drives.sql

# Modified files
gateway/src/index.ts                 — register new route modules
gateway/src/routes/articles.ts       — access_mode, invitation_required, drive trigger
gateway/src/routes/writers.ts        — access_mode
gateway/src/routes/search.ts         — access_mode
gateway/src/routes/history.ts        — access_mode
gateway/src/routes/export.ts         — access_mode
gateway/src/routes/notes.ts          — access_mode
schema.sql                           — access_mode replaces is_paywalled
seed.sql                             — access_mode
```

---

### From v3.23.0

No schema changes. Services changed: **web** and **gateway**. Feed composer UI fixes, crimson brand nav, Postmark magic-link email configured.

```bash
cd /root/platform-pub
git pull origin master

docker compose build --no-cache web
docker compose up -d web
docker compose restart gateway
```

Verify:
```bash
docker ps --format "table {{.Names}}\t{{.Status}}" | grep -E "web|gateway"
docker logs platform-pub-web-1 --tail 5
docker logs platform-pub-gateway-1 --tail 5

# v3.24.0 — NoteComposer cleanup, mobile sticky fix, crimson brand, magic link email
#
# ── NoteComposer keyline removed ──
# Removed mb-4 margin from NoteComposer wrapper so the parchment card
# sits flush against the tabs below, eliminating the visible keyline.
# bg-card retained for parchment textarea background.
# File: web/src/components/feed/NoteComposer.tsx
#
# ── Mobile sticky fix ──
# Feed container top padding changed from pt-16 (64px) to pt-[53px]
# to match the sticky offset (top-[53px]). Eliminates the 11px shift
# where the composer would start lower and jump up before locking.
# File: web/src/components/feed/FeedView.tsx
#
# ── Brand nav: parchment → crimson ──
# "Platform" logo text and border changed from parchment (#FFFAEF) to
# crimson (#B5242A). Sits against the pale green nav background.
# File: web/src/components/layout/Nav.tsx
#
# ── Magic link email (gateway .env) ──
# EMAIL_PROVIDER set to postmark, POSTMARK_API_KEY configured,
# EMAIL_FROM set to login@platform.pub. Gateway restart required
# to pick up .env changes (not in git).
```

---

### From v3.22.0

No schema changes. Services changed: **web only**. Pale green nav colour swap and quote click-through fix.

```bash
cd /root/platform-pub
git pull origin master

docker compose build --no-cache web
docker compose up -d web
```

Verify:
```bash
docker ps --format "table {{.Names}}\t{{.Status}}" | grep web
docker logs platform-pub-web-1 --tail 5

# v3.23.0 — Pale green nav, parchment brand logo, quote click-through
#
# ── Nav colour swap ──
# Nav background changed from dark green (#82A890) to pale green
# (#DDEEE4, previously surface-deep / the nav button hover colour).
# Nav button hover state changed from pale green (#DDEEE4) to medium
# green (#82A890, previously the nav background). New Tailwind token:
# nav.hover (#82A890). Nav text colours adjusted for light background:
# active links use text-ink, inactive use text-content-faint, hover
# uses text-content-secondary. Hamburger bars changed from bg-card to
# bg-ink. Search inputs on nav use bg-surface-deep with text-ink.
# Feed sticky zone (NoteComposer area) inherits pale green via bg-nav.
# Files: web/tailwind.config.js, web/src/components/layout/Nav.tsx,
#   web/src/components/ui/NotificationBell.tsx,
#   web/src/components/feed/FeedView.tsx, web/src/app/globals.css
#
# ── Brand logo restyled ──
# "Platform" logo: now parchment-coloured text (#FFFAEF) with a
# parchment-coloured outline border (1.5px solid #FFFAEF), no fill
# background. Sits against the pale green nav.
# File: web/src/components/layout/Nav.tsx
#
# ── Quote click-through fix ──
# ExcerptPennant (highlighted-text quotes in notes) now clicks through
# to the quoted content. Previously, when the quoted item was a note
# (no dTag), the link was href="#" with preventDefault — a dead link.
# Now falls back to the quoted author's profile page (/{username})
# when no article dTag is available. Article quotes continue to link
# to /article/{dTag} as before.
# File: web/src/components/feed/NoteCard.tsx
```

---

### From v3.21.0

No schema changes. Services changed: **web, gateway**. New backend endpoint `GET /my/account-statement` in gateway; full visual refresh across frontend.

```bash
cd /root/platform-pub
git pull origin master

docker compose build --no-cache web gateway
docker compose up -d web gateway
```

Verify:
```bash
docker ps --format "table {{.Names}}\t{{.Status}}" | grep -E 'web|gateway'
docker logs platform-pub-web-1 --tail 5
docker logs platform-pub-gateway-1 --tail 5

# v3.22.0 — Account statement, mobile article fix, Feed nav, visual refresh
#
# ── Account statement endpoint (gateway) ──
# New GET /api/v1/my/account-statement returns a unified paginated
# statement of all credits and debits. Credits: £5 free allowance,
# article earnings (net of platform fee), subscription earnings,
# upvote earnings. Debits: paywall reads, subscription charges, vote
# charges. Includes settlement events. Summary totals reset on each
# Stripe settlement. Supports ?filter=all|credits|debits, ?limit,
# ?offset for pagination.
# File: gateway/src/routes/v1_6.ts
#
# ── Accounts tab rewrite (frontend) ──
# AccountsTab now fetches from /my/account-statement instead of
# assembling data client-side from multiple endpoints. Three clickable
# summary tiles (Credits, Debits, Balance) filter the statement below.
# Credits tile filters to income only, Debits to outgoings only,
# Balance shows everything. Default 30 rows with "Show more" pagination.
# Type column shows human-readable category labels.
# File: web/src/app/dashboard/page.tsx
#
# ── Mobile article reader fix ──
# Article card had hardcoded padding: 40px 72px inline style, leaving
# ~183px for text on a 375px phone. Replaced with responsive Tailwind:
# px-5 py-6 (mobile) → px-10 py-8 (sm) → px-[72px] py-10 (md).
# Hero image negative margins updated to match at each breakpoint.
# File: web/src/components/article/ArticleReader.tsx
#
# ── Feed link added to nav ──
# Explicit "Feed" link added to all three nav layouts (sidebar, tablet
# inline, mobile drawer). Positioned first, highlighted when on /feed
# or /. Both the brand logo and Feed link navigate to /feed.
# File: web/src/components/layout/Nav.tsx
#
# ── Visual refresh: dark nav → pale green nav, soft borders ──
# Nav background: bg-surface (#EDF5F0) → bg-nav (#DDEEE4, pale green).
# All nav text uses dark colours for light background. Hover uses
# bg-nav-hover (#82A890). Soft sage borders (border-rule #B8D2C1)
# replace heavy black borders site-wide.
#
# Brand logo: parchment text (#FFFAEF) with parchment outline border,
# no fill background, against pale green nav.
#
# Feed sticky area + NoteComposer: background → bg-nav (pale green).
# Feed tabs restyled for light background.
#
# All border-ink references removed site-wide (~40 occurrences across
# 20+ files). Heavy black borders replaced with border-rule (#B8D2C1,
# soft sage). 3px rules thinned to 1px. Applies to: layout divider,
# reply threading, comment sections, modals, dropdowns, card setup,
# notification panel, dashboard tables, profile inputs, editor embeds.
#
# globals.css: hr and .rule/.rule-inset → 1px #B8D2C1. .rule-accent
# → 1px #B8D2C1. .btn border removed, hover → #263D32. .btn-accent
# border removed. .btn-soft border removed. .tab-pill-active bg →
# #263D32. Checkbox border and focus → #7A9A8A / #B5242A.
#
# Files changed:
#   gateway/src/routes/v1_6.ts,
#   web/src/app/globals.css, web/src/app/layout.tsx,
#   web/src/app/dashboard/page.tsx,
#   web/src/app/[username]/page.tsx, web/src/app/profile/page.tsx,
#   web/src/app/auth/verify/page.tsx,
#   web/src/components/layout/Nav.tsx,
#   web/src/components/article/ArticleReader.tsx,
#   web/src/components/feed/FeedView.tsx,
#   web/src/components/feed/NoteComposer.tsx,
#   web/src/components/replies/ReplyItem.tsx,
#   web/src/components/replies/ReplySection.tsx,
#   web/src/components/replies/ReplyComposer.tsx,
#   web/src/components/comments/CommentItem.tsx,
#   web/src/components/comments/CommentComposer.tsx,
#   web/src/components/comments/CommentSection.tsx,
#   web/src/components/ui/AllowanceExhaustedModal.tsx,
#   web/src/components/ui/VoteConfirmModal.tsx,
#   web/src/components/ui/ShareButton.tsx,
#   web/src/components/ui/ReportButton.tsx,
#   web/src/components/ui/NotificationBell.tsx,
#   web/src/components/payment/CardSetup.tsx,
#   web/src/components/editor/EmbedNode.ts
```

---

### From v3.20.0

No schema changes. Services changed: **web only**. This is a frontend-only UI polish and feature pass — no backend services need rebuilding.

```bash
cd /root/platform-pub
git pull origin master

docker compose build --no-cache web
docker compose up -d web
```

Verify:
```bash
docker ps --format "table {{.Names}}\t{{.Status}}" | grep web
docker logs platform-pub-web-1 --tail 5

# v3.21.0 — UI polish: accounts tab, reply threading, button consistency,
# nav separator, vote balance refresh, quote clickthrough
#
# ── Input focus outline removed ──
# The 2px black box-shadow on input:focus has been replaced with box-shadow: none.
# The background-color change to card (#FFFAEF) already signals focus.
# File: web/src/app/globals.css
#
# ── Vote balance updates immediately ──
# After a successful vote that costs money, useAuth.getState().fetchMe() is
# called to re-fetch the user profile, so the Nav balance counter updates
# without a page reload.
# File: web/src/components/ui/VoteControls.tsx
#
# ── Button consistency: .btn-soft now transparent by default ──
# .btn-soft background changed from #DDEEE4 to transparent, border from
# 2px solid #0F1F18 to transparent. On hover: bg #263D32 with white text.
# Buttons are invisible until hovered, matching the site's editorial style.
# File: web/src/app/globals.css
#
# ── Reply keylines solid black ──
# Reply threading borders changed from border-ink/25 (25% opacity) to
# border-ink (solid black), matching the weight of other black lines.
# Files: web/src/components/replies/ReplyItem.tsx,
#        web/src/components/replies/ReplySection.tsx
#
# ── Replies expanded by default (up to 3) ──
# NoteCard now always renders ReplySection with previewLimit={3} and
# composerOpen={false}. The three most recent replies are visible without
# clicking. A "Read more replies" button appears when there are more than 3.
# The reply button label shows "Reply" when 0 replies, "Replies (N)" when 1+.
# ReplySection gains an onReplyCountLoaded callback prop.
# Files: web/src/components/feed/NoteCard.tsx,
#        web/src/components/replies/ReplySection.tsx
#
# ── Nav/feed vertical separator ──
# A partial-height 2px black vertical line separates the nav from the main
# content area at the lg+ breakpoint. It uses calc(100% - 8rem) height with
# mt-16 to create a "modesty screen" effect — not full top-to-bottom.
# File: web/src/app/layout.tsx
#
# ── Dashboard: "Debits" tab renamed to "Accounts" ──
# The Debits tab has been replaced with a unified Accounts tab that shows
# all incomings (writer earnings) and outgoings (article reads) in a single
# chronological ledger. Credits display in black (ink), debits in red (accent)
# with +/− prefixes. Three summary cards: Credits (primary), Debits (accent),
# Balance (turns red when negative). The tab gracefully handles individual
# API failures (each fetch caught independently).
# Old ?tab=debits URLs redirect to the accounts tab.
#
# ── Dashboard: Settings tab added ──
# A fourth "Settings" tab redirects to the existing /settings page.
#
# ── Quote clickthrough: ExcerptPennant ──
# When a note quotes an article, the entire parchment region is now wrapped
# in a <Link> to the article. The author name intercepts clicks and navigates
# to /${authorUsername} for the author's profile page.
# File: web/src/components/feed/NoteCard.tsx
#
# Files changed:
#   web/src/app/globals.css, web/src/app/layout.tsx,
#   web/src/app/dashboard/page.tsx, web/src/components/feed/NoteCard.tsx,
#   web/src/components/replies/ReplyItem.tsx,
#   web/src/components/replies/ReplySection.tsx,
#   web/src/components/ui/VoteControls.tsx
```

---

### From v3.19.0

No schema changes. Services changed: **web only**. This is a frontend-only visual redesign pass — no backend services need rebuilding.

```bash
cd /root/platform-pub
git pull origin master

docker compose build --no-cache web
docker compose up -d web
```

Verify:
```bash
docker ps --format "table {{.Names}}\t{{.Status}}" | grep web
docker logs platform-pub-web-1 --tail 5

# v3.20.0 — Graphic editorial redesign: ink rules, heavy borders, wider layouts,
# dramatic type contrast
#
# This release replaces the soft sage keyline system with a bold, graphic editorial
# language built around heavy black (ink) rules and borders. Every border-rule usage
# across ~25 component and page files has been either removed or replaced.
#
# ── Keylines → thick ink rules or removed ──
#
# The 1px #B8D2C1 (sage) keylines that previously divided every list, section, and
# panel have been systematically replaced. The new treatment uses one of three
# approaches depending on context:
#
# (a) Structural borders (nav sidebar right edge, logo bottom border, mobile drawer
#     top, sidebar user section top) → 3px solid ink (#0F1F18). These heavy rules
#     echo the brand logo's 2.5px ink border and give the nav strong presence.
#
# (b) Section dividers (feed tab bar, editor toolbar bottom, reply/comment section
#     tops, price section separator) → 3px solid ink bottom borders. These create
#     clear visual breaks between content zones.
#
# (c) List item separators (notifications, history, following, followers, feed
#     search results, reply/comment threads) → removed entirely. Items are now
#     separated by vertical spacing (space-y-1 or similar), producing a cleaner,
#     less cluttered feed. The divide-y divide-rule pattern has been eliminated.
#
# Additionally:
# - Dashboard table borders: lightened to border-ink/20 (2px) for data readability
# - Reply/comment thread indentation borders: border-rule/40 → border-ink/25
# - Modal and dropdown borders (NotificationBell, AllowanceExhaustedModal,
#   VoteConfirmModal, ShareButton, ReportButton): border-rule → border-ink (2–3px)
# - Input focus rings: box-shadow changed from #B8D2C1 to #0F1F18
# - Checkbox borders: changed from #B8D2C1 to #0F1F18
# - btn-soft border: 1px solid #B8D2C1 → 2px solid #0F1F18
# - hr elements: 1px solid #B8D2C1 → 3px solid ink bar
# - .rule CSS class: now renders as a 3px ink bar (height: 3px, bg #0F1F18)
# - New .rule-inset class: same 3px ink bar but with margin-left/right 1.5rem,
#   creating rules that stop short of container edges (used on writer profile)
# - Feed tab active indicator: 2px → 3px with negative margin-bottom alignment
# - NoteComposer: border-rule/50 → border-2 border-ink
# - ReplyComposer expanded state: border-rule/50 → border-2 border-ink/30
# - CommentComposer: border-rule → border-2 border-ink/30
# - CardSetup (Stripe): border-rule → border-2 border-ink
# - EmbedNode: border-rule → border-2 border-ink/30
# - Profile form inputs: border-rule → border-2 border-ink/30
# - Auth verify spinner: border-rule → border-ink/20
#
# Files touched for keyline changes:
#   web/src/app/globals.css, web/src/components/layout/Nav.tsx,
#   web/src/components/feed/FeedView.tsx, web/src/components/feed/NoteComposer.tsx,
#   web/src/components/editor/ArticleEditor.tsx, web/src/components/editor/EmbedNode.ts,
#   web/src/app/[username]/page.tsx, web/src/app/notifications/page.tsx,
#   web/src/app/history/page.tsx, web/src/app/following/page.tsx,
#   web/src/app/followers/page.tsx, web/src/app/dashboard/page.tsx,
#   web/src/app/profile/page.tsx, web/src/app/auth/verify/page.tsx,
#   web/src/components/replies/ReplyItem.tsx, web/src/components/replies/ReplySection.tsx,
#   web/src/components/replies/ReplyComposer.tsx,
#   web/src/components/comments/CommentItem.tsx,
#   web/src/components/comments/CommentComposer.tsx,
#   web/src/components/comments/CommentSection.tsx,
#   web/src/components/ui/NotificationBell.tsx,
#   web/src/components/ui/AllowanceExhaustedModal.tsx,
#   web/src/components/ui/VoteConfirmModal.tsx,
#   web/src/components/ui/ShareButton.tsx, web/src/components/ui/ReportButton.tsx,
#   web/src/components/payment/CardSetup.tsx
#
# ── Heavy ink border on article card and editor ──
#
# The article reader parchment card now has a 3px ink border (border-[3px] border-ink),
# echoing the logo's boxed treatment and creating a strong "framed page" effect against
# the sage background. The editor writing area is wrapped in a new bg-card container
# with the same 3px ink border and generous padding (p-8 sm:p-10), visually separating
# the composition surface from the surrounding controls.
#
# Files: web/src/components/article/ArticleReader.tsx,
#        web/src/components/editor/ArticleEditor.tsx
#
# ── Wider layouts ──
#
# New Tailwind max-width tokens added to tailwind.config.js:
#   max-w-feed: 780px (was 600px hardcoded)
#   max-w-article-frame: 740px (was max-w-article 640px)
#   max-w-editor-frame: 780px (was max-w-article 640px)
#
# The article prose content remains at 640px (max-w-article) inside the wider card
# frame, preserving optimal line length for readability. The extra width is taken up
# by the card's interior padding.
#
# Pages widened:
# - Feed (FeedView + FeedSkeleton): 600px → 780px
# - Article reader (back link + card): 640px → 740px
# - Editor: 640px → 780px
# - Home page: 640px → 740px
# - Writer profile page ([username]): 640px → 740px (all states including loading/404)
#
# Files: web/tailwind.config.js, web/src/components/feed/FeedView.tsx,
#        web/src/components/article/ArticleReader.tsx,
#        web/src/components/editor/ArticleEditor.tsx,
#        web/src/app/page.tsx, web/src/app/[username]/page.tsx
#
# ── Dramatic type contrast ──
#
# Display headings have been pushed significantly larger to create more dramatic
# size contrast with body text (1.125rem / 18px):
#
# - Article reader title: 36px fixed → clamp(2.25rem, 4vw, 3rem) with tighter
#   letter-spacing (-0.025em). Scales fluidly from 36px to 48px.
# - Article card headline: 21px → 26px (24% larger)
# - Home page headline: text-5xl/6xl → text-6xl/7xl with -0.03em tracking
# - Editor title input: text-3xl/4xl → text-4xl/5xl
# - Writer profile display name: text-2xl → text-3xl sm:text-4xl
# - Page headings (Notifications, Reading History, Following, Followers):
#   text-2xl font-normal → text-3xl sm:text-4xl font-light
#
# Prose typography (tailwind @tailwindcss/typography config):
# - h1: added fontSize 2.25rem, lineHeight 1.15 (was browser default)
# - h2: added fontSize 1.75rem, lineHeight 1.2 (was browser default)
# - h3: added fontSize 1.35rem, lineHeight 1.3 (was browser default)
# - All three headings retain Literata italic with tighter letter-spacing
#
# Files: web/tailwind.config.js, web/src/components/article/ArticleReader.tsx,
#        web/src/components/feed/ArticleCard.tsx, web/src/app/page.tsx,
#        web/src/components/editor/ArticleEditor.tsx,
#        web/src/app/[username]/page.tsx, web/src/app/notifications/page.tsx,
#        web/src/app/history/page.tsx, web/src/app/following/page.tsx,
#        web/src/app/followers/page.tsx
```

---

### From v3.18.0

No schema changes. Services changed: **all five application services** (web, gateway, payment, keyservice, key-custody). Security hardening, race condition fix, data integrity.

```bash
cd /root/platform-pub
git pull origin master

docker compose build --no-cache web gateway payment keyservice key-custody
docker compose up -d web gateway payment keyservice key-custody
```

---

### From v3.17.0

No schema changes. Services changed: **all five application services** (web, gateway, payment, keyservice, key-custody). The visual redesign touches only the web frontend, but all services are rebuilt for image consistency.

```bash
cd /root/platform-pub
git pull origin master

docker compose build --no-cache web gateway payment keyservice key-custody
docker compose up -d web gateway payment keyservice key-custody
```

Verify:
```bash
docker ps --format "table {{.Names}}\t{{.Status}}" | grep platform-pub
docker logs platform-pub-web-1 --tail 5

# Full visual redesign — mint/parchment two-surface system
#
# The entire frontend colour palette, typography, and component styling has been
# replaced. This is a comprehensive design system change affecting 41 files.
#
# Colour system
# - Page background changed from warm beige/cream to fresh mint (#EDF5F0)
# - Card/content surfaces changed to bright parchment (#FFFAEF)
# - Accent changed from crimson (#9B1C20) to ink red (#B5242A)
# - Ink/text colour changed to deep forest (#0F1F18)
# - New semantic tokens: surface, card, surface-deep (#DDEEE4), rule (#B8D2C1),
#   avatar-bg (#C2DBC9), and a 5-level content hierarchy (primary/secondary/muted/faint/card-muted)
#
# Typography
# - Serif font changed from Newsreader to Literata (Google Fonts)
# - All article titles, headings, and card headlines now render in italic Literata
# - Sans-serif body text uses Source Sans 3 (was Inter/system-ui)
# - Monospace uses IBM Plex Mono
#
# Component changes
# - Nav sidebar: dark #2A2A2A background removed, now uses mint bg-surface with ink text;
#   width reduced from 200px to 180px; active links use accent left border
# - Feed article cards: zigzag clip-path removed, parchment background with no border,
#   headlines in italic Literata 21px, writer name in uppercase card-muted
# - Note cards: dark #2A2A2A background removed, notes render on mint surface with py-4;
#   crimson gradient avatars replaced with #C2DBC9 mint avatars
# - Quote cards: all zigzag clip-path code removed; article pennants and quoted notes
#   use parchment background with 2.5px accent left border
# - Article reader: content wrapped in parchment card with 40px/48px padding;
#   "← Back to feed" link on mint surface; title in italic Literata 36px
# - Paywall gate: surface-deep (#DDEEE4) background, gradient fades from transparent;
#   bleeds to card edges with negative horizontal margins
# - All pill buttons removed; buttons now use 2px border-radius
# - All 0.5px borders replaced with 1px
# - NotificationBell, VoteControls, ShareButton, ReportButton, AllowanceExhaustedModal,
#   VoteConfirmModal all updated from old ink-*/brand-* tokens to new semantic tokens
# - CommentSection, CommentItem, CommentComposer, ReplySection, ReplyItem, ReplyComposer
#   all updated to new tokens
# - CardSetup (Stripe Elements) updated to new palette and 2px radius
# - Editor toolbar and article editor updated to new tokens
# - EmbedNode uses border-rule bg-surface-deep
# - All 15 page files under web/src/app/ updated
#
# Accessibility
# - WCAG 2.4.7 focus indicators added via focus-visible:
#   - Buttons/links: outline 2px solid #B5242A (accent)
#   - Accent buttons: outline 2px solid #0F1F18 (ink)
#   - Form inputs: box-shadow 0 0 0 2px #B8D2C1 (rule)
#
# Old tokens fully removed from tailwind.config.js:
# crimson, slate, old ink scale (ink-50 through ink-900), old surface variants
# (surface-raised, surface-sunken, surface-strong, surface-card), brand-*, accent-*
```

---

### From v3.16.0

No schema changes. Services changed: **gateway** and **web**. Deploy order: **gateway → web**.

```bash
cd /root/platform-pub
git pull origin master

docker compose build --no-cache gateway web
docker compose up -d gateway web
```

Verify:
```bash
docker logs platform-pub-gateway-1 --tail 5
docker logs platform-pub-web-1 --tail 5

# Change 1 — Quote flags: clickable body, linked author, paywall stripe
# The pale quote pennant on note tiles is now interactive in two independent ways.
# (a) The quoted excerpt text is wrapped in a Next.js Link that navigates to
#     /article/[dTag]. When the article's dTag is not yet resolved the excerpt
#     remains plain text; the dTag is fetched lazily from /api/v1/content/resolve.
# (b) The attribution line ("Title · Author") has the author's display name as a
#     separate Link to /[authorUsername]. The article title in the same line also
#     links to the article independently. The two links do not nest.
# For full-tile QuoteCard article pennants (used when a note quotes an article by
# event ID rather than by pasted excerpt) the author attribution (small-caps line)
# is now a router.push() span with stopPropagation so it navigates to the author
# profile without triggering the outer article Link.
# The red left-border paywall stripe was already present; no change to that logic.
# Files: web/src/components/feed/NoteCard.tsx (ExcerptPennant),
#        web/src/components/feed/QuoteCard.tsx (ArticlePennant)

# Change 2 — Profile page reply cards: "Replying to", delete, votes, deep links
# Reply cards on writer profile pages now show richer context and controls.
# - "Replying to @username" badge (with profile link) is shown when the reply is
#   nested under another user's comment (parent_comment_id is set).
# - The reply content is wrapped in a Link to /article/[slug]#reply-[id] so
#   clicking it jumps directly to the reply in the article thread.
# - A Delete button appears when the viewer is the profile owner (isOwnProfile).
#   It uses the standard 3-second confirm pattern and calls DELETE /api/v1/replies/:id.
#   After deletion the card transitions to an unobtrusive "[Deleted]" placeholder
#   in-place (no page reload required).
# - VoteControls are rendered on the reply's nostrEventId (kind 1111).
# - A Quote button is shown and wired to the existing NoteComposer modal.
# Backend: GET /writers/:username/replies now LEFT JOINs the parent comment and
# parent account rows to surface parentEventId, parentAuthorUsername,
# parentAuthorDisplayName. It also removes the deleted_at IS NULL filter so
# deleted replies are returned with isDeleted: true and content '[deleted]',
# enabling the frontend to show the placeholder without a refresh.
# Files: gateway/src/routes/writers.ts,
#        web/src/app/[username]/page.tsx

# Change 3 — Feed replies expanded by default; compose input on demand
# Note tiles in the For You and Following feeds now render with the ReplySection
# mounted immediately (no click required to see replies). The ReplySection fetches
# up to the 3 most recent replies on mount; a "Show all N replies" link above them
# loads all replies when clicked (was previously labelled "X older replies — show all").
# The top-level reply compose box is hidden by default and only appears when the
# user clicks the "Reply" action pill. A new composerOpen / onComposerClose prop
# pair on ReplySection controls this; passing composerOpen={undefined} (the default
# used by article pages) preserves the existing always-visible behaviour.
# The per-card reply-count fetch (repliesApi.getForTarget) has been removed since
# the count is now available directly from the ReplySection.
# Files: web/src/components/feed/NoteCard.tsx,
#        web/src/components/replies/ReplySection.tsx

# Change 4 — Feed tab spacing
# The "For you / Following / Add" tab pills now have 6px right margin between them,
# making them visually distinct. Previously they were flush-adjacent with no gap.
# File: web/src/app/globals.css (.tab-pill)
```

---

### From v3.15.0

No schema changes. Services changed: **gateway** and **web**. Deploy order: **gateway → web**.

```bash
cd /root/platform-pub
git pull origin master

docker compose build --no-cache gateway web
docker compose up -d gateway web
```

Verify:
```bash
docker logs platform-pub-gateway-1 --tail 5
docker logs platform-pub-web-1 --tail 5

# Change 1 — Note tile replies collapsed by default
# Note tiles in the feed no longer open with the reply section expanded.
# The reply section is now hidden on initial render. Clicking the "Reply" / "N replies"
# pill reveals it; "Hide replies" collapses it again.
# Previously the showReplies state defaulted to true, expanding every reply section on
# every note tile in the feed without any user action.
# File: web/src/components/feed/NoteCard.tsx

# Change 2 — Article quotes in note tiles: zigzag right edge instead of swallowtail
# Quoted article content shown inside note tiles (both the full-tile QuoteCard and the
# text-excerpt ExcerptPennant) now uses the same repeating zigzag right edge as the main
# article feed tiles. The single V-notch swallowtail has been removed from both quote
# types. The zigzag is contained within the dark-grey note tile (negative marginRight
# overhangs removed from both wrappers); paddingRight reduced from 48px to 28px to match
# the shallower 12px zigzag depth.
# Files: web/src/components/feed/NoteCard.tsx, web/src/components/feed/QuoteCard.tsx

# Change 3 — History removed from navigation
# The "History" link has been removed from both the mobile hamburger drawer and the
# desktop left sidebar. The /history page and its backend remain intact.
# File: web/src/components/layout/Nav.tsx

# Fix 4 — Quote fields returned for notes on writer profile pages
# GET /writers/:username/notes now returns quoted_event_id, quoted_event_kind,
# quoted_excerpt, quoted_title, and quoted_author alongside each note. Previously the
# endpoint selected only id, nostr_event_id, content, published_at — all quote data
# was silently dropped. As a result, notes with quoted articles on a writer's profile
# page rendered with no quote UI at all (no pennant, no tile, no paywall indicator).
# The frontend DbNote interface and NoteEvent construction on the profile page are
# updated accordingly so all quote rendering — including the red paywall left border —
# now works on profile pages as it does on the global feed.
# Files: gateway/src/routes/writers.ts, web/src/app/[username]/page.tsx
```

---

### From v3.14.0

Schema change: one new migration. Services changed: **gateway** and **web**. Deploy order: **migration → gateway → web**.

```bash
cd /root/platform-pub
git pull origin master

# Apply migration
docker exec -i platform-pub-postgres-1 psql -U platformpub platformpub \
  < migrations/013_note_excerpt_fields.sql

docker compose build --no-cache gateway web
docker compose up -d gateway web
docker compose restart nginx
```

Verify:
```bash
docker logs platform-pub-gateway-1 --tail 5
docker logs platform-pub-web-1 --tail 5

# Fix 1 — Notification bell: mark-read request no longer cancelled on navigation
# Clicking a notification now fires a keepalive fetch (credentials: include, keepalive: true)
# before calling router.push(). The keepalive flag instructs the browser to complete the
# POST /notifications/:id/read request even after the page unloads, so the row is reliably
# flipped to read=true in Postgres. Previously the in-flight fetch was cancelled by the
# Next.js navigation, leaving read=false and causing the notification to reappear on
# the next page load.
# Files: web/src/components/ui/NotificationBell.tsx
# Also: gateway/src/routes/notifications.ts — simplified unreadCount to rows.length
# (the SQL query already filters WHERE read = false, so the filter was redundant).

# Fix 2 — Quoted article excerpts now render correctly in the For You feed
# Notes loaded via GET /feed/global that contain a quoted article excerpt now show the
# correct swallowtail pennant design (ExcerptPennant) with the highlighted text, a
# clickable link to the article, and the author name at the bottom.
# Previously these notes fell through to the QuoteCard note-style renderer (dark rounded
# box) because the excerpt, title, and author fields were never stored in the notes table
# or returned by the feed endpoint, leaving quotedExcerpt undefined in the frontend.
# The fix stores the three fields at publish time and returns them from the feed API.
# Schema: migrations/013_note_excerpt_fields.sql adds quoted_excerpt, quoted_title,
# quoted_author columns to the notes table.
# Files: gateway/src/routes/notes.ts (schema, INSERT, feed SELECT + response),
#        web/src/lib/publishNote.ts (pass excerpt fields to indexNote),
#        web/src/components/feed/FeedView.tsx (map fields onto NoteEvent)
```

---

### From v3.13.0

No schema changes. Web only. Rebuild and restart `web`.

```bash
cd /root/platform-pub
git pull origin master

docker compose build --no-cache web
docker compose up -d web
```

Verify:
```bash
docker logs platform-pub-web-1 --tail 5

# Change 1 — Page background is now a distinct sand colour
# The page background (body bg-surface) is now #E0D9CC — a warm sand that sits visibly
# darker than the ivory article cards (#FAFAF0), creating clear visual layering.
# Previously the background and cards were both #FAFAF0 (indistinguishable).

# Change 2 — Input backgrounds unified to ivory
# Text inputs, selects, and textareas now use #FAFAF0 (ivory) for both their default and
# focused state, matching article cards and quoted-content pennants.
# Previously the default state was #FFFFFF (pure white) and focus was also #FFFFFF —
# inconsistent with the rest of the surface palette.

# Change 3 — Note tile replies expanded by default on the feed
# Note tiles in the feed now show replies in expanded form without requiring a click.
# Up to the 3 most recent top-level replies are shown by default; if there are more,
# an "X older replies — show all" link appears above them to expand the full thread.
# Full sub-reply threading is preserved at all depths. The "Hide replies" button still
# collapses everything.
```

---

### From v3.12.0

No schema changes. Services changed: **gateway** and **web**. Deploy order: **gateway → web**.

```bash
cd /root/platform-pub
git pull origin master

docker compose build --no-cache gateway web
docker compose up -d gateway web
```

Verify:
```bash
docker logs platform-pub-gateway-1 --tail 5
docker logs platform-pub-web-1 --tail 5

# Fix 1 — Dashboard debit tab no longer fails to load
# Navigate to /dashboard and open the Debits tab. The reading tab balance, history,
# and subscriptions should load correctly instead of showing "Failed to load reading tab."
# Root cause: GET /api/v1/my/tab was selecting a.d_tag in its SQL JOIN against the articles
# table, but the column is named nostr_d_tag. Postgres raised an unknown-column error on
# every request, returning a 500 which the frontend displayed as the error message.

# Fix 2 — Notification bell dropdown: notifications no longer reappear after clicking
# Click a notification in the dropdown panel. It should be removed immediately, the panel
# should close, and navigating back to the feed should not re-show the dismissed item.
# Root cause: NotificationBell used a Next.js <Link> element which triggered client-side
# navigation synchronously on click, aborting the in-flight markRead request before it
# completed. The notification remained read=false in the database, and reappeared on the
# next panel open once the in-memory dismissedIds ref was cleared by a page reload.
# Fix mirrors the pattern applied to /notifications page in v3.11.0: <Link> replaced with
# a div[role="button"], handleDismiss made async, panel closed, markRead awaited, then
# router.push() called.

# Change 3 — Ivory palette: palest surface tones unified to #FAFAF0
# All previously warm-beige "palest" surface colours (#F5F0E8, #FAF7F2, #EAE5DC) are now
# a single consistent ivory (#FAFAF0) used across article tiles, the note compose box,
# body background, and all light text rendered on dark note-card backgrounds.
# Updated: tailwind.config.js (surface.DEFAULT, surface.card, ink.50, brand.50),
# ArticleCard.tsx, NoteCard.tsx, QuoteCard.tsx, NoteComposer.tsx.

# Change 4 — Article card right edge: multi-tooth zigzag scalloping
# Main article tiles in the feed now show a repeating sawtooth/zigzag on their right edge
# (depth 12px, ~22px per tooth, count scales with card height) instead of the single
# swallowtail V-notch used previously.
# Swallowtail is now reserved exclusively for quoted-article pennants inside note tiles
# (QuoteCard.tsx ArticlePennant and NoteCard.tsx ExcerptPennant), which retain their
# existing 28px fork-depth V-notch.

# Change 5 — Text-excerpt quote attribution rendered as small subscript
# When a user quotes highlighted article text into a note, the attribution line below the
# italic excerpt (article title + author) is now rendered as small (11px) normal-weight
# sans-serif in muted grey (#9E9B97), separated by a · instead of an em-dash.
# Previously it used the uppercase label style (font-weight 700, letter-spacing 0.05em,
# text-transform uppercase), which was visually too prominent.

# Change 6 — Mobile and tablet navigation matches desktop dark colour scheme
# On mobile (hamburger drawer) and tablet (inline top-bar nav), the nav background,
# links, search input, avatar placeholder, and user info now use the same dark palette
# as the desktop sidebar: #2A2A2A background, #9E9B97 inactive links, white active/hover,
# #3a3a3a borders and avatar fills, #333 search input background.
# Previously mobile/tablet used white (bg-surface-raised) with dark ink text.
```

---

### From v3.11.0

No schema changes. Web only. Rebuild and restart `web`.

```bash
cd /root/platform-pub
git pull origin master

docker compose build --no-cache web
docker compose up -d web
```

Verify:
```bash
docker logs platform-pub-web-1 --tail 5

# Fix 1 — Brown/beige ribbon behind feed removed
# The feed content area should now sit directly on the page background (#F5F0E8) with no
# intermediary coloured wrapper. Previously a hardcoded rgb(234,229,220) background was
# applied to the feed wrapper div in FeedView.tsx.

# Fix 2 — Article tile colour corrected to warm cream
# Article tiles should now appear as a distinctly lighter cream (#FAF7F2) that contrasts
# visibly against the page background. Previously tiles used #F5F0E8 — identical to the
# page — making them invisible against the background. The new surface.card Tailwind token
# is available as bg-surface-card for consistent use elsewhere.

# Fix 3 — Article tile right edge is now a swallowtail, not a zigzag
# Feed article cards should show a single V-notch (pennant/swallowtail) on the right edge,
# not the previous multi-tooth zigzag. The applyZigzag() function in ArticleCard.tsx has
# been replaced with applySwallowtail() (40px fork depth for full-width cards), matching
# the shape already used by quoted-article pennants in QuoteCard.tsx.

# Fix 4 — Quoted article pennant colour corrected
# When a note embeds a quoted article tile, the pennant now uses the same #FAF7F2 cream
# as main article tiles (was #F5F0E8 — same as page background, no contrast).

# Fix 5 — Text-excerpt quotes render as cream swallowtail pennant
# When a user has highlighted text from an article and quoted it into a note, the quoted
# excerpt now renders as a cream swallowtail card (matching the article tile style) rather
# than a plain left-bordered italic block. The card shows the excerpt in italic Newsreader,
# with the article title and author below in small caps. If the article is paywalled a
# 5px crimson left border is added. Once the component resolves the article's dTag via
# /api/v1/content/resolve, the card becomes a clickable link to /article/:dTag.
```

---

### From v3.10.0

No schema changes. Services changed: **gateway** and **web**. Deploy order: **gateway → web**.

```bash
cd /root/platform-pub
git pull origin master

docker compose build --no-cache gateway web
docker compose up -d gateway web
```

Verify:
```bash
docker logs platform-pub-gateway-1 --tail 5
docker logs platform-pub-web-1 --tail 5

# Fix 1 — Notifications no longer reappear after clicking
# Open /notifications — clicking a row should immediately remove it from the list,
# navigate to the destination, and permanently mark it read on the server.
# Returning to /notifications should not re-show any row that was already clicked.
# Previously the markRead request was aborted by client-side navigation before it could
# complete, leaving notifications unread on the server so they reappeared on reload.

# Fix 2 — Quoted note shows author name instead of truncated pubkey
# Compose a note that quotes another platform note, then view it in the feed.
# The quoted-note inset card should display the author's display name (e.g. "Eleanor Voss"),
# not a hex string like "a3f2c8b1…".
# Root cause: GET /api/v1/content/resolve was selecting a.avatar (non-existent column) instead
# of a.avatar_blossom_url, causing a Postgres error on every note-resolve request. The fallback
# path returned the raw Nostr pubkey as the display name. The SQL alias is now corrected.

# Fix 3 — Reply tiles on user profile pages link to the source article
# Visit any /:username profile page that includes replies.
# Each reply card should now show a linked article title below the reply text and timestamp.
# Clicking the link navigates to /article/:slug for the article the reply was posted on.
# Note replies (target_kind = 1) do not show a link as there is no note permalink page yet.
```

---

### From v3.9.0

No schema changes. Services changed: **gateway** and **web**. Deploy order: **gateway → web**.

```bash
cd /root/platform-pub
git pull origin master

docker compose build --no-cache gateway web
docker compose up -d gateway web
```

Verify:
```bash
docker logs platform-pub-gateway-1 --tail 5
docker logs platform-pub-web-1 --tail 5

# Change 1 — Dark left-hand navigation
# Desktop sidebar (lg+) background should now be dark grey (#2A2A2A), matching note cards
# Inactive nav links should appear in muted grey (#9E9B97) against the dark background
# Hovering a nav link should turn the row near-black (#141414) with white text
# Active link keeps the crimson left-border indicator with white text
# The "Platform" logotype should switch from dark border/text to white border/text at lg+
# Mobile top bar (below lg) is unchanged — white background, dark text

# Change 2 — "For you" global feed tab
# Feed page should open on a new "For you" tab (left of "Following"), active by default
# GET /api/v1/feed/global should return { items: [...] } mixing articles, notes, and new users
# Feed should show all published articles and notes from all platform users, newest first
# New user signups should appear as small inline cards: avatar + "X joined the platform" + time
# "For you" tab should persist vote tallies and quote/delete actions like the Following tab
```

---

### From v3.8.0

No schema changes. Web only. Rebuild and restart `web`.

```bash
cd /root/platform-pub
git pull origin master

docker compose build --no-cache web
docker compose up -d web
```

Verify:
```bash
docker logs platform-pub-web-1 --tail 5

# Change 1 — Newsreader serif typeface
# All serif text (article headings, article body, drop cap, nav links, feed card titles)
# should render in Newsreader (Google Fonts) rather than Cormorant

# Change 2 — Light left-hand navigation
# Desktop sidebar (lg+) should have a white background with a subtle right border
# Inactive nav links should appear in medium grey (#9E9B97)
# Hovering a nav link should darken the text to near-black (#111111)
# Active link keeps the crimson left-border indicator with dark text
```

---

### From v3.7.0

No schema changes. Services changed: **gateway** and **web**. Deploy order: **gateway → web**.

```bash
cd /root/platform-pub
git pull origin master

docker compose build --no-cache gateway web
docker compose up -d gateway web
```

Verify:
```bash
docker logs platform-pub-gateway-1 --tail 5
docker logs platform-pub-web-1 --tail 5

# Fix 1 — Debits page "Failed to load reading tab"
# Open /debits — the page should load correctly showing tab balance and free allowance
# GET /api/v1/my/reading-tab should return { tabBalancePence, freeAllowanceRemainingPence }

# Fix 2 — Notification dismiss + reply anchor navigation
# Open the notification bell — clicking any item should navigate AND remove it from the list
# Clicking a reply notification should jump to the specific reply (URL ends #reply-<id>)
# Re-opening the bell should not re-show notifications already dismissed in this session

# Fix 3 — Reply text invisible inside dark note cards
# Expand replies on a note card — reply text should be cream/light, not black-on-dark

# Fix 4 — Article tile scalloping and background contrast
# Feed should show article tiles as cream flags (#F5F0E8) with a visible zigzag right edge
# Tiles must sit on a slightly darker sunken background (rgb(234,229,220)) so the shape reads

# Fix 5 — Profile page uses full feed tiles
# Visit any /:username profile page — articles should render as ArticleCards (cream flags)
# Notes should render as NoteCards (dark stone tiles) with reply/quote/vote buttons functional
# Quoting a note from a profile page should open the quote composer modal

# Fix 6 — Quote-of-article renders in note tile
# When a note quotes an article, it should show title and standfirst in a pennant inset
# When a note quotes highlighted text from an article, the inset should show the excerpt
# in italic Cormorant font with article title and author in small sans-serif subscript
# The composer should NOT pre-fill the textarea with the highlighted text — it goes in the preview only
```

---

### From v3.6.0

No schema changes. Services changed: gateway, key-service, web. Deploy order: **key-service → gateway → web** (payment and key-custody are unchanged but rebuilt for consistency).

```bash
cd /root/platform-pub
git pull origin master

# Rebuild all app services (no migration needed)
docker compose build --no-cache gateway keyservice key-custody payment web
docker compose up -d gateway keyservice key-custody payment web
```

Verify:
```bash
docker logs platform-pub-gateway-1 --tail 5
docker logs platform-pub-keyservice-1 --tail 5
docker logs platform-pub-web-1 --tail 5

# Feature 1 — Paywall unlock fix (own content + subscribers)
# A writer visiting their own paywalled article should unlock immediately — no 502
# A subscriber visiting a paywalled article from a writer they subscribe to should unlock immediately
# GET /api/v1/content/resolve?eventId=<nostr_event_id> should return isPaywalled and correct dTag

# Feature 2 — Notification dismiss-on-click
# Open the notification bell — clicking an item should navigate AND remove it from the list
# The red counter should decrement by 1 per click; disappear entirely when all are clicked
# Open /notifications — same per-row dismiss behaviour applies

# Feature 3 — Feed design overhaul
# Feed cards should use Source Sans 3 (UI) and Cormorant (titles/serif) fonts
# NoteCards should appear as dark stone tiles (#2A2A2A, 14px radius)
# ArticleCards should appear as cream flags (#F5F0E8) with a zigzag right edge
# Paywalled ArticleCards should have a 6px crimson left border
# Quoted articles inside notes should render as a swallowtail cream pennant
# Quoted notes inside notes should render as a dark inset (#141414, 10px radius)
# The "Platform" logotype in the nav should be Cormorant 34px/600
```

---

### From v3.5.4

Schema change: migration `012_notification_note_id.sql` must be applied. Gateway and web both changed. Deploy order is **migration → gateway → web**.

```bash
cd /root/platform-pub
git pull origin master

# 1. Apply migration
DATABASE_URL=postgresql://platformpub:<POSTGRES_PASSWORD>@127.0.0.1:5432/platformpub \
  npx tsx shared/src/db/migrate.ts

# 2. Rebuild and restart gateway (new /my/reading-history route, enriched notifications query, note_id in reply notifications)
docker compose build --no-cache gateway
docker compose up -d gateway

# 3. Rebuild and restart web (dek input, share button, history page, clickable notifications)
docker compose build --no-cache web
docker compose up -d web
```

Verify:
```bash
docker logs platform-pub-gateway-1 --tail 5
docker logs platform-pub-web-1 --tail 5

# Confirm migration applied
docker exec platform-pub-postgres-1 psql -U platformpub platformpub \
  -c "\d notifications" | grep note_id
# Expected: "note_id | uuid | ..."

# Feature 1 — Article dek/standfirst
# Open /write — there should be an italic subtitle input between the title and the toolbar
# Publish an article with a standfirst filled in — it should appear below the <h1> on the reader page

# Feature 2 — Clickable notifications
# Open the notification bell — every row should be a clickable link
# The unread counter should drop to 0 immediately when the panel opens (not after API response)
# Open /notifications — rows should be clickable, readAll fires immediately on load

# Feature 3 — Share button
# Open any article — a "Share" button should appear next to the Report button
# On desktop: clicking Share opens a dropdown with Copy link / Share on X / Share via email
# Copy link should copy the URL and show "Copied!" briefly

# Feature 4 — Reading history
# Left nav should show "History" between Followers and Dashboard
# Open /history — should list previously-read articles with writer name and "read X ago"
# GET /api/v1/my/reading-history should return { items: [...] }
```

---

### From v3.5.3

Schema change: migration `011_store_ciphertext.sql` must be applied. Deploy order is **migration → key-service → gateway → web**.

```bash
cd /root/platform-pub
git pull origin master

# 1. Apply migration
DATABASE_URL=postgresql://platformpub:<POSTGRES_PASSWORD>@127.0.0.1:5432/platformpub \
  npx tsx shared/src/db/migrate.ts

# 2. Rebuild and restart key-service first (it now writes ciphertext to vault_keys)
docker compose build --no-cache keyservice
docker compose up -d keyservice

# 3. Then gateway (forwards ciphertext in gate-pass responses)
docker compose build --no-cache gateway
docker compose up -d gateway

# 4. Finally web (reads ciphertext from gate-pass response before relay fallback)
docker compose build --no-cache web
docker compose up -d web
```

Verify:
```bash
docker logs platform-pub-keyservice-1 --tail 5
docker logs platform-pub-gateway-1 --tail 5
docker logs platform-pub-web-1 --tail 5

# Confirm migration applied
docker exec platform-pub-postgres-1 psql -U platformpub platformpub \
  -c "\d vault_keys" | grep ciphertext
# Expected: "ciphertext | text | ..."

# Publish a paywalled article — vault_keys.ciphertext should now be populated:
docker exec platform-pub-postgres-1 psql -U platformpub platformpub \
  -c "SELECT id, article_id, ciphertext IS NOT NULL AS has_ciphertext FROM vault_keys ORDER BY created_at DESC LIMIT 5;"

# Unlock the article as a reader — it should decrypt without relay involvement.
# Reader clicking the paywall gate should no longer get "Could not find the encrypted content."
```

> **Existing broken articles:** Articles whose v2 event never reached the relay (the bug fixed in v3.5.3) will have `ciphertext = NULL` in `vault_keys`. The writer must edit and re-publish — the content key is intact so re-publishing regenerates and stores the ciphertext. Articles published after this migration are automatically covered.

---

### From v3.5.2

No schema changes. Web only. Rebuild and restart the web service:

```bash
cd /root/platform-pub
git pull origin master
docker compose build --no-cache web
docker compose up -d web
```

Verify:
```bash
docker logs platform-pub-web-1 --tail 5
# Publish a paywalled article — the paywalled version (v2) should reach the relay
# even if the vault encryption round-trip took several seconds.
# If it previously published as free-only with a "relay did not accept" error, retry now.
```

---

### From v3.5.0

No schema changes. Gateway only. Rebuild and restart the gateway:

```bash
cd /root/platform-pub
git pull origin master
docker compose build --no-cache gateway
docker compose up -d gateway
```

Verify:
```bash
docker logs platform-pub-gateway-1 --tail 5
# Visit any /:username profile page — it should load fully with Notes visible
```

---

### From v3.4.0

Schema change: migration `010_votes.sql` must be applied.

```bash
cd /root/platform-pub
git pull origin master
DATABASE_URL=postgresql://platformpub:<POSTGRES_PASSWORD>@127.0.0.1:5432/platformpub \
  npx tsx shared/src/db/migrate.ts
docker compose build --no-cache gateway payment web
docker compose up -d gateway payment web
```

Verify:
```bash
docker logs platform-pub-gateway-1 --tail 5
docker logs platform-pub-payment-1 --tail 5
docker logs platform-pub-web-1 --tail 5
# New tables should be present
docker exec platform-pub-postgres-1 psql -U platformpub platformpub -c "\d votes"
docker exec platform-pub-postgres-1 psql -U platformpub platformpub -c "\d vote_tallies"
docker exec platform-pub-postgres-1 psql -U platformpub platformpub -c "\d vote_charges"
# Feed cards should show ▲ score ▼ vote controls
# Clicking ▲ on someone else's note should cast a free first upvote with no modal
# Clicking ▲ again should show the confirm modal with cost £0.10
# Confirming should debit the reader's tab and update the tally
# Your own content should show greyed-out disabled vote arrows
# Logged-out visitors should see vote arrows that redirect to /auth?mode=login on click
```

---

### From v3.3.0

No schema changes. Gateway and web both changed. Rebuild both:

```bash
cd /root/platform-pub
git pull origin master
docker compose build --no-cache gateway web
docker compose up -d gateway web
```

Verify:
```bash
docker logs platform-pub-gateway-1 --tail 5
docker logs platform-pub-web-1 --tail 5
# Feed should show your own Notes and Articles alongside followed accounts
# Visit /:username for any account — profile should load regardless of is_writer flag
# Non-writer accounts should now be followable
# Subscription to a writer should generate a notification for that writer
# @mention a user in a note or reply — they should receive a new_mention notification
# Quote a note — the quoted author should receive a new_quote notification
# NotificationBell and /notifications should render new_subscriber, new_quote, new_mention types
```

---

### From v3.2.0

No schema changes. Gateway and web both changed. Rebuild both:

```bash
cd /root/platform-pub
git pull origin master
docker compose build --no-cache gateway web
docker compose up -d gateway web
```

Verify:
```bash
docker logs platform-pub-gateway-1 --tail 5
docker logs platform-pub-web-1 --tail 5
# Left nav should show: Write, Profile, Notifications (with count), Following, Followers, Dashboard, About, Search
# Clicking Profile in the nav should open the /profile settings page
# Upload an avatar and save — the avatar should update in the nav bottom bar immediately
# Author names on feed cards, notes, and replies should be clickable links to /:username
# PATCH /api/v1/auth/profile should return { ok: true }
```

---

### From v3.1.9

Schema change: migration `009_notifications.sql` must be applied.

```bash
cd /root/platform-pub
git pull origin master
DATABASE_URL=postgresql://platformpub:<POSTGRES_PASSWORD>@127.0.0.1:5432/platformpub \
  npx tsx shared/src/db/migrate.ts
docker compose build --no-cache gateway web
docker compose up -d gateway web
```

Verify:
```bash
docker logs platform-pub-gateway-1 --tail 5
docker logs platform-pub-web-1 --tail 5
# Notification bell should appear between Followers and About in the left sidebar
# Follow a writer — the writer should see a new_follower notification
# Reply to an article — the article author should see a new_reply notification
docker exec platform-pub-postgres-1 psql -U platformpub platformpub -c "\d notifications"
```

---

### From v3.1.8

No schema changes. Gateway and web both changed. Rebuild both:

```bash
cd /root/platform-pub
git pull origin master
docker compose build --no-cache gateway web
docker compose up -d gateway web
```

After the gateway restarts, clean up any relay events from notes that were deleted before this fix (they have no kind 5 events and would otherwise stay in strfry indefinitely):

```bash
docker compose exec strfry /app/strfry delete --filter '{"kinds":[1,5,7]}'
```

This wipes all notes, deletion events, and reactions from the relay. Live notes will need to be re-posted; given the platform is early-stage this is preferable to running a targeted reconciliation script. Skip this step if you want to preserve existing notes.

Verify:
```bash
docker logs platform-pub-gateway-1 --tail 5
docker logs platform-pub-web-1 --tail 5
# Delete a note — on feed refresh the note should not reappear
# Delete an article — on feed refresh it should not reappear even if relay publish failed
# Note, Reply, and Composer components should show the new rounded white card design
```

---

### From v3.1.7

No schema changes. Bug fixes in key-service and web. Rebuild both:

```bash
cd /root/platform-pub
git pull origin master
docker compose build --no-cache keyservice web
docker compose up -d keyservice web
```

Verify:
```bash
docker logs platform-pub-keyservice-1 --tail 3
docker logs platform-pub-web-1 --tail 3
# Publish a paywalled article — the vault call should succeed and the
# NIP-23 event should contain a ['payload', ciphertext, algorithm] tag.
# Unlock the article as a reader — content should decrypt correctly.
```

---

### From v3.1.6 or v3.1.7

No schema changes. Visual redesign only (web service). Rebuild web only:

```bash
cd /root/platform-pub
git pull origin master
docker compose build --no-cache web
docker compose up -d web
```

Verify:
```bash
docker logs platform-pub-web-1 --tail 5
# Sidebar should be near-black (ink) rather than crimson
# Buttons should be sentence-case with visible border
# Article headlines should be font-weight 500 with tighter tracking
# Feed cards should show top-border rule; left crimson accent only on paywalled articles
# Drop cap should appear on the first letter of article body text
```

---

### From v3.1.5

No schema changes. Rebuild web only:

```bash
cd /root/platform-pub
git pull origin master
docker compose build --no-cache web
docker compose up -d web
```

Verify:
```bash
docker logs platform-pub-web-1 --tail 5
# Feed should open on the Following tab (no For You tab)
# Open a note with multiple replies — all replies and nested replies should expand
```

---

### From v3.1.4

Schema change: migration `008_deduplicate_articles.sql` must be applied. It deduplicates any multiple live rows that accumulated for the same article (caused by a bug in the index endpoint) and adds a partial unique index to prevent recurrence.

```bash
cd /root/platform-pub
git pull origin master
```

The migration runner (`shared/src/db/migrate.ts`) tracks applied migrations in a `_migrations` table. If this is the first time you are using the runner (i.e. it was not used for migrations 001–007), bootstrap the table first so it does not re-apply already-applied migrations:

```bash
docker exec platform-pub-postgres-1 psql -U platformpub platformpub -c "
CREATE TABLE IF NOT EXISTS _migrations (
  id SERIAL PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO _migrations (filename) VALUES
  ('001_add_email_and_magic_links.sql'),
  ('002_draft_upsert_index.sql'),
  ('003_comments.sql'),
  ('004_media_uploads.sql'),
  ('005_subscriptions.sql'),
  ('006_receipt_portability.sql'),
  ('007_subscription_nostr_event.sql')
ON CONFLICT DO NOTHING;"
```

Then run the migration runner (resolves `DATABASE_URL` from the service `.env`):

```bash
DATABASE_URL=postgresql://platformpub:<POSTGRES_PASSWORD>@127.0.0.1:5432/platformpub \
  npx tsx shared/src/db/migrate.ts
```

Rebuild and restart the gateway (the index and delete endpoints changed):

```bash
docker compose build --no-cache gateway
docker compose up -d gateway
```

Verify:

```bash
# Partial unique index is present
docker exec platform-pub-postgres-1 psql -U platformpub platformpub -c \
  "\d articles" | grep unique_live
# Expected: "idx_articles_unique_live" UNIQUE, btree (writer_id, nostr_d_tag) WHERE deleted_at IS NULL

docker logs platform-pub-gateway-1 --tail 5
# Publish an article, delete it, refresh the dashboard — it should not reappear
```

---

### From v3.1.3

No schema changes. Rebuild web only:

```bash
cd /root/platform-pub
git pull origin master
docker compose build --no-cache web
docker compose up -d web
```

Verify:
```bash
docker logs platform-pub-web-1 --tail 5
# Test quoting a note from the feed — the compose preview should appear inline
# Test posting a quote — the quoted tile should render in the published note
```

---

### From v3.1.2

Schema change: migration `001_add_email_and_magic_links.sql` must be applied if it was not applied when first deploying v3.1.2. Check first:

```bash
docker exec platform-pub-postgres-1 psql -U platformpub platformpub -c "\d accounts" | grep email
```

If the `email` column is absent, apply it now:

```bash
docker exec -i platform-pub-postgres-1 psql -U platformpub platformpub < migrations/001_add_email_and_magic_links.sql
```

Then rebuild the gateway (fixes HMAC-signed OAuth state and key-custody client header bug):

```bash
cd /root/platform-pub
git pull origin master
docker compose build --no-cache gateway
docker compose up -d
```

Also verify `gateway/.env` has `POSTMARK_API_KEY` (not `POSTMARK_SERVER_TOKEN`) and a real token value if email sending is required.

---

### From v3.1.1

No schema changes. Rebuild gateway and web, then update the Google OAuth redirect URI in Google Cloud Console.

```bash
cd /root/platform-pub
git pull origin master

# Ensure APP_URL in gateway/.env is the FRONTEND URL (e.g. https://platform.pub),
# NOT the gateway URL. This has always been required but was previously undocumented.
grep APP_URL gateway/.env   # should be https://platform.pub or http://localhost:3010

docker compose build gateway web
docker compose up -d gateway web
```

**Google Cloud Console action required:**
In APIs & Services → Credentials → your OAuth 2.0 client, remove the old redirect URI and add the new one:

| Remove | Add |
|--------|-----|
| `https://platform.pub/api/v1/auth/google/callback` | `https://platform.pub/auth/google/callback` |

Verify:
```bash
docker logs platform-pub-gateway-1 --tail 5
docker logs platform-pub-web-1 --tail 5
# Test Google login end-to-end
```

---

### From v3.1

No schema changes. Rebuild all services and restart.

```bash
cd /root/platform-pub

# Pull latest code
git pull origin master

# Add key-custody env file (new — was missing from docker-compose before v3.1.1)
# Copy key-custody/.env.example to key-custody/.env and fill in:
#   ACCOUNT_KEY_HEX   — move the value from gateway/.env (remove it there)
#   PLATFORM_SERVICE_PRIVKEY — same value as gateway/.env
#   INTERNAL_SECRET   — new shared secret (also add to gateway/.env)
#   DATABASE_URL      — same pattern as other services

# Rebuild and restart all services
docker compose build
docker compose up -d
```

Verify:
```bash
docker compose ps   # key-custody should now appear on port 3004
docker logs platform-pub-key-custody-1 --tail 5
docker logs platform-pub-gateway-1 --tail 5
```

### From v2.0

```bash
cd /root/platform-pub

# Back up
cp -r . ../platform-pub-backup-$(date +%Y%m%d)

# Pull latest code
git pull origin master

# Apply new migrations
docker exec -i platform-pub-postgres-1 psql -U platformpub platformpub < migrations/006_receipt_portability.sql
docker exec -i platform-pub-postgres-1 psql -U platformpub platformpub < migrations/007_subscription_nostr_event.sql

# Configure new required env vars
# gateway/.env — add INTERNAL_SECRET, KEY_CUSTODY_URL (if not present)
# key-custody/.env — create from key-custody/.env.example
#   Set ACCOUNT_KEY_HEX (new; must be moved from gateway if previously set there)
#   Set INTERNAL_SECRET (must match gateway's INTERNAL_SECRET)
# key-service/.env — add KMS_MASTER_KEY_HEX if not present

# Rebuild and restart all services (key-custody is new)
docker compose build --no-cache
docker compose up -d
docker compose restart nginx
```

### From v1.9 or earlier

```bash
cd /root/platform-pub
cp -r . ../platform-pub-backup-$(date +%Y%m%d)
git pull origin master

# Run all migrations in order
for f in migrations/*.sql; do
  echo "Applying $f..."
  docker exec -i platform-pub-postgres-1 psql -U platformpub platformpub < "$f"
done

# Create env files for new services
cp key-custody/.env.example key-custody/.env
# Edit key-custody/.env — set ACCOUNT_KEY_HEX and INTERNAL_SECRET

docker compose build --no-cache
docker compose up -d
docker compose restart nginx
```

### Verifying the upgrade

```bash
# All services running
docker compose ps

# Gateway started cleanly
docker logs platform-pub-gateway-1 --tail 10

# key-custody started cleanly
docker logs platform-pub-key-custody-1 --tail 10

# New columns exist
docker exec platform-pub-postgres-1 psql -U platformpub platformpub -c \
  "SELECT reader_pubkey, receipt_token FROM read_events LIMIT 1;"

# New subscriptions column exists
docker exec platform-pub-postgres-1 psql -U platformpub platformpub -c \
  "SELECT nostr_event_id FROM subscriptions LIMIT 1;"
```

---

## Database

### Schema

`schema.sql` is the from-scratch path — applied automatically on first postgres boot.

### Migrations

| Migration | Purpose |
|-----------|---------|
| 001_add_email_and_magic_links.sql | Email column on accounts, magic_links table |
| 002_draft_upsert_index.sql | Partial unique index for draft upserts |
| 003_comments.sql | Comments/replies table, replies_enabled on articles/notes |
| 004_media_uploads.sql | Media uploads table with SHA-256 deduplication |
| 005_subscriptions.sql | Subscriptions, subscription_events, article_unlocks |
| 006_receipt_portability.sql | `reader_pubkey` + `receipt_token` columns on read_events |
| 007_subscription_nostr_event.sql | `nostr_event_id` column on subscriptions |
| 008_deduplicate_articles.sql | Deduplicate articles rows; add partial unique index on `(writer_id, nostr_d_tag) WHERE deleted_at IS NULL` |
| 009_notifications.sql | `notifications` table: new_follower and new_reply events, with actor/article/comment FK refs |
| 010_votes.sql | `votes`, `vote_tallies`, `vote_charges` tables for the upvote/downvote system |
| 011_store_ciphertext.sql | `ciphertext` column on `vault_keys` for storing encrypted content |
| 012_notification_note_id.sql | `note_id` column on `notifications` for note-related notifications |
| 013_note_excerpt_fields.sql | `quoted_excerpt`, `quoted_title`, `quoted_author_display_name` on `notes` |
| 014_notification_dedup.sql | Deduplicate notification rows; add unique index (superseded by 019) |
| 015_access_mode_and_unlock_types.sql | `access_mode` column on articles, `unlock_type` expansion on `article_unlocks` |
| 016_direct_messages.sql | `direct_messages` table for NIP-17 encrypted DMs |
| 017_pledge_drives.sql | `pledge_drives` and `pledges` tables for crowdfunding/commissions |
| 018_add_on_delete_clauses.sql | ON DELETE CASCADE/SET NULL clauses for FKs in migrations 016–017 |
| 019_fix_notification_dedup.sql | Fix dedup index: partial unique index (`WHERE read = false`) so repeat notifications work |

Run all pending migrations (requires Node on the host — substitute your `POSTGRES_PASSWORD`):
```bash
DATABASE_URL=postgresql://platformpub:<POSTGRES_PASSWORD>@127.0.0.1:5432/platformpub \
  npx tsx shared/src/db/migrate.ts
```
Or apply a single migration directly via Docker (no Node required on the host):
```bash
docker exec -i platform-pub-postgres-1 psql -U platformpub platformpub < migrations/NNN_name.sql
```

### Backup

```bash
docker exec platform-pub-postgres-1 pg_dump -U platformpub platformpub | gzip > backup-$(date +%Y%m%d).sql.gz
```

---

## Key routes

### Auth
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | /api/v1/auth/signup | — | Create account |
| POST | /api/v1/auth/login | — | Request magic link |
| POST | /api/v1/auth/verify | — | Verify magic link token |
| POST | /api/v1/auth/logout | session | Clear session |
| GET | /api/v1/auth/me | session | Current user info (includes `bio`) |
| PATCH | /api/v1/auth/profile | session | Update display name, bio, avatar URL |
| GET | /api/v1/auth/google | — | Google OAuth redirect |
| POST | /api/v1/auth/google/exchange | `{ code, state }` | Google OAuth code exchange |
| POST | /api/v1/auth/upgrade-writer | session | Start Stripe Connect |
| POST | /api/v1/auth/connect-card | session | Save reader payment method |

### Content
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | /api/v1/articles | session | Index published article |
| GET | /api/v1/articles/:dTag | optional | Article metadata by d-tag |
| POST | /api/v1/articles/:eventId/vault | session | Encrypt paywalled body, store vault key |
| POST | /api/v1/articles/:eventId/gate-pass | session | Paywall gate pass |
| PATCH | /api/v1/articles/:id | session | Update article metadata (replies toggle) |
| DELETE | /api/v1/articles/:id | session | Delete article (soft-delete + kind 5 to relay) |
| GET | /api/v1/articles/deleted?pubkeys= | session | Recently deleted article event IDs + coordinates for given Nostr pubkeys (used by feed to cross-reference DB deletions) |
| POST | /api/v1/notes | session | Index published note |
| DELETE | /api/v1/notes/:nostrEventId | session | Delete note (hard-delete + kind 5 to relay) |
| GET | /api/v1/content/resolve?eventId= | — | Resolve event ID for quote cards |
| POST | /api/v1/drafts | session | Save/upsert draft |
| GET | /api/v1/drafts | session | List drafts |
| POST | /api/v1/media/upload | session | Upload image |

### Replies
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | /api/v1/replies | session | Post a reply |
| GET | /api/v1/replies/:targetEventId | optional | Get replies for an event |
| DELETE | /api/v1/replies/:replyId | session | Delete reply |
| PATCH | /api/v1/articles/:id/replies | session | Toggle replies on article |
| PATCH | /api/v1/notes/:id/replies | session | Toggle replies on note |

### Social
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | /api/v1/follows/:writerId | session | Follow writer |
| DELETE | /api/v1/follows/:writerId | session | Unfollow writer |
| GET | /api/v1/follows | session | List followed writers with display info |
| GET | /api/v1/follows/pubkeys | session | Followed writer pubkeys (for feed filter) |
| GET | /api/v1/follows/followers | session | List accounts who follow you |
| POST | /api/v1/reports | session | Submit content report |

### Notifications
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | /api/v1/notifications | session | List recent notifications (max 50) with actor info, article title, comment excerpt, and unread count. Types: `new_follower`, `new_reply`, `new_subscriber`, `new_quote`, `new_mention` |
| POST | /api/v1/notifications/read-all | session | Mark all notifications as read |

### Votes
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | /api/v1/votes | session | Cast an upvote or downvote on any content. Body: `{ targetEventId, targetKind, direction }`. Returns `{ ok, sequenceNumber, costPence, nextCostPence, tally }`. 1st upvote free; subsequent votes double in price. Self-voting returns 400 |
| GET | /api/v1/votes/tally?eventIds=id1,id2,... | — | Batch fetch tallies for up to 200 event IDs. Returns `{ tallies: { [eventId]: { upvoteCount, downvoteCount, netScore } } }`. Missing IDs return zeroes |
| GET | /api/v1/votes/mine?eventIds=id1,id2,... | session | Batch fetch the logged-in user's vote counts for up to 200 event IDs. Returns `{ voteCounts: { [eventId]: { upCount, downCount } } }` |
| GET | /api/v1/votes/price?eventId=&direction= | session | Server-authoritative next-vote price. Returns `{ sequenceNumber, costPence, direction }` |

### Subscriptions
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | /api/v1/subscriptions/:writerId | session | Subscribe (charges immediately) |
| DELETE | /api/v1/subscriptions/:writerId | session | Cancel |
| GET | /api/v1/subscriptions/mine | session | List my subscriptions |
| GET | /api/v1/subscriptions/check/:writerId | session | Check subscription status |
| GET | /api/v1/subscribers | session | List my subscribers (writer) |
| PATCH | /api/v1/settings/subscription-price | session | Set subscription price |

### Reader account
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | /api/v1/my/tab | session | Reader's tab balance, free allowance, and read history |
| GET | /api/v1/my/account-statement | session | Unified account statement: all credits (free allowance, article earnings, subscription earnings, upvote earnings) and debits (paywall reads, subscription charges, vote charges). Query params: `filter=all\|credits\|debits`, `limit` (default 30, max 200), `offset`. Returns `{ summary: { creditsTotalPence, debitsTotalPence, balancePence, lastSettledAt }, entries, totalEntries, hasMore }`. Summary totals reset on each Stripe settlement |

### Portability & federation
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | /api/v1/platform-pubkey | — | Platform's Nostr signing pubkey (for receipt verification) |
| GET | /api/v1/receipts/export | session | Reader's portable receipt tokens (signed kind 9901 events) |
| GET | /api/v1/account/export | session (writer) | Author migration bundle: content keys + receipt whitelist |

### Public
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | /api/v1/writers/:username | optional | User profile (any active account, not just writers) |
| GET | /api/v1/writers/:username/articles | optional | User's published articles |
| GET | /api/v1/writers/:username/notes | optional | User's published notes |
| GET | /api/v1/writers/:username/replies | optional | User's published replies |
| GET | /api/v1/search?q=&type= | optional | Search articles + writers |
| GET | /rss | — | Platform-wide RSS |
| GET | /rss/:username | — | Writer RSS |

---

## Nostr event types

| Kind | Type | Publisher | Purpose |
|------|------|-----------|---------|
| 0 | Metadata | User (via key-custody) | Profile (name, bio, avatar) |
| 1 | Note | User (via key-custody) | Short-form post |
| 3 | Contacts | User (via key-custody) | Follow list |
| 5 | Deletion | User (via key-custody) | Soft-delete article or note. Published by the gateway on article delete and note delete — used by feed clients to filter deleted events from relay query results |
| 7003 | Subscription | Platform service key | Subscription status (provisional NIP-88) |
| 30023 | Long-form article | User (via key-custody) | NIP-23 article with optional `['payload', ciphertext, algorithm]` tag for paywalled content |
| 30024 | Draft | User (via key-custody) | NIP-23 draft |
| 9901 | Receipt | Platform service key | Gate-pass receipt (public relay: HMAC reader hash; private DB copy: actual reader pubkey) |

### Paywall content format

Paywalled articles embed encrypted content directly in the kind 30023 event:

```
tag: ['payload', <base64 ciphertext>, 'xchacha20poly1305']
```

Format: `base64(nonce[24] || ciphertext_with_tag)` — XChaCha20-Poly1305 via @noble/ciphers.

The content key is issued via `POST /api/v1/articles/:eventId/key` (after gate-pass), wrapped with NIP-44 (ChaCha20-Poly1305) to the reader's Nostr pubkey.

Legacy articles (pre-v3.0) used a separate kind 39701 vault event with AES-256-GCM. Both formats remain decryptable — the `algorithm` field in the key-service response drives the decryption path.

---

## Key custody

The `key-custody` service (port 3004) is the sole holder of all user Nostr private keys. It holds `ACCOUNT_KEY_HEX` — the AES-256 key used to encrypt private keys at rest in `accounts.nostr_privkey_enc`. **No other service has access to this key.**

The gateway calls key-custody for three operations:
- `POST /keypairs/generate` — generate and store a new Nostr keypair for a new user
- `POST /keypairs/sign` — sign a Nostr event with a user's private key
- `POST /keypairs/unwrap-nip44` — NIP-44 decrypt (for reading encrypted DMs, key deliveries)

All calls carry `x-internal-secret` (shared secret between gateway and key-custody). The key-custody service rejects any request missing this header.

---

## Author migration export

Writers can export a complete migration bundle via `GET /api/v1/account/export`:

```json
{
  "version": 1,
  "exportedAt": "...",
  "account": { "nostrPubkey": "...", "username": "...", "displayName": "..." },
  "articles": [
    {
      "articleId": "...",
      "nostrEventId": "...",
      "dTag": "...",
      "title": "...",
      "isPaywalled": true,
      "algorithm": "xchacha20poly1305",
      "encryptedKey": "<NIP-44 wrapped to writer's own pubkey>",
      "readerPubkeys": ["<hex>", ...]
    }
  ],
  "summary": { "totalArticles": 5, "paywallArticles": 3, "contentKeysExported": 3, "uniqueReaders": 12 }
}
```

- `encryptedKey` — decrypt with the writer's own Nostr private key (NIP-44, sender = platform service key) to get the 32-byte content key, then use `algorithm` to decrypt the article body.
- `readerPubkeys` — readers who have paid for that article. A receiving host can honour these without re-charging.
- Nostr events (profile, follow list, articles) are on the relay and fetchable by the writer's pubkey — they are not duplicated in the export.

---

## Receipt portability

Readers export their paid-access receipts via `GET /api/v1/receipts/export`. Each receipt is a signed Nostr kind 9901 event (signed by the platform service key) containing:

```
['e', articleEventId]     — article read
['p', writerPubkey]       — writer
['reader', readerPubkey]  — reader (actual pubkey)
['amount', pence, 'GBP']  — amount charged
['gate', 'passed']
```

A receiving host verifies receipts by:
1. Fetching this host's signing pubkey: `GET /api/v1/platform-pubkey`
2. Calling `verifyEvent(receipt)` from nostr-tools
3. Checking `receipt.pubkey` matches the platform pubkey

---

## Subscription system

1. Writers set a monthly price (£1–£100, default £5)
2. Subscribers are charged immediately via Stripe; access is immediate
3. Active subscription unlocks all that writer's paywalled content at zero per-article cost
4. Each subscription creates a kind 7003 Nostr event (signed by platform service key) for federation
5. Unlocks are permanent — survive cancellation
6. Cancellation grants access until period end

### Access check priority

1. Own content → free
2. Permanent unlock (`article_unlocks`) → free, key reissued
3. Active subscription → free, creates permanent unlock + subscription_read log
4. Payment flow → charges reading tab, creates permanent unlock

---

## Media uploads

Images uploaded via `POST /api/v1/media/upload` are resized (max 1200px), converted to WebP (quality 80), and written to the `media_data` volume at `/app/media/<sha256>.webp`. Nginx serves them at `/media/<sha256>.webp` with 1-year cache headers.

---

## Frontend pages

| Path | Purpose |
|------|---------|
| / | Landing (redirects to /feed if logged in) |
| /feed | Sticky composer + Following / Add tabs |
| /profile | Edit your display name, bio, and avatar photo |
| /following | Writers you follow, with unfollow action |
| /followers | Accounts who follow you |
| /notifications | Recent notifications (new followers, replies, subscribers, quotes, mentions) — full-page view used on mobile |
| /write | Article editor with paywall gate marker |
| /article/:dTag | Article reader with paywall unlock (SSR, ISR 60s) |
| /:username | Writer profile (SSR, ISR 60s) |
| /auth | Signup / login |
| /auth/google/callback | Google OAuth callback (handles Google redirect, exchanges code, sets session) |
| /auth/verify | Magic link verification |
| /dashboard | Articles, drafts, billing |
| /settings | Payment, Stripe Connect, account |
| /search | Article + writer search |
| /about | About page |

---

## Operational commands

### Restart everything
```bash
docker compose down && docker compose up -d
```

### Rebuild a single service
```bash
docker compose build --no-cache gateway
docker compose up -d gateway
docker compose exec nginx nginx -s reload
```

### View logs
```bash
docker logs platform-pub-gateway-1 --tail 50 -f
docker logs platform-pub-key-custody-1 --tail 50 -f
docker logs platform-pub-web-1 --tail 50 -f
```

### Check relay events
```bash
# From browser console:
const ws = new WebSocket('wss://yourdomain.com/relay');
ws.onmessage = (e) => console.log(JSON.parse(e.data));
ws.onopen = () => ws.send(JSON.stringify(["REQ","test",{"limit":5}]));
```

### Database queries
```bash
docker exec platform-pub-postgres-1 psql -U platformpub platformpub -c "YOUR QUERY"
```

### Certbot renewal
```bash
docker compose run --rm certbot renew
docker compose restart nginx
```

Auto-renewal is configured by `harden-server.sh` to run daily at 03:00.

---

## Known limitations (v3.1)

- Subscription renewal is not yet automated (requires a scheduled worker)
- RSS feed ingestion not yet built
- NIP-07 browser extension support not yet built
- Cash-out-at-will (writer-initiated payout) not yet implemented
- Stripe payment collection not yet live — free allowance goes negative as a testing workaround
- Email sending requires configuring `EMAIL_PROVIDER` — defaults to console logging

---

## Change log

### v4.3.0 — 2 April 2026

**Resilience, NDK removal, SSR conversion, font optimisation, hardening**

No new migrations. Services changed: **gateway**, **web**.

- Removed `@nostr-dev-kit/ndk` and `@nostr-dev-kit/ndk-cache-dexie` from web client — all Nostr operations go through gateway HTTP API
- Added gateway endpoints: `POST /sign-and-publish`, `GET /feed/following`, `GET /articles/by-event/:nostrEventId`
- Converted article reader (`/article/[dTag]`) to Server Component with ISR (60s)
- Converted writer profile (`/[username]`) to Server Component with ISR (60s)
- Gateway `GET /articles/:dTag` now returns `contentFree` field for server-side markdown rendering
- Self-hosted Literata woff2 fonts in `web/public/fonts/` (replaced Google Fonts import)
- Sans-serif and monospace switched to system font stacks (removed Instrument Sans, IBM Plex Mono)
- Font preload links added to `layout.tsx`
- `ENV NODE_ENV=production` added to web, payment-service, key-service Dockerfiles
- Root `.dockerignore` created
- HSTS `preload` directive added
- `'unsafe-inline'` removed from CSP `style-src`
- Article `pricePence` validation capped at 999,999
- Config cache TTL (30s) in `loadConfig()`
- Notification inserts awaited with try/catch
- Webhook handler static pool import
- TypeScript target ES2017→ES2020
- `pg` ^8.20.0 and `dotenv` ^17.3.1 aligned across all services
- Vote button `aria-label` attributes
- Session storage `unlocked:*` keys cleared on logout
- Shared `Avatar` component (explicit dimensions, lazy loading, initials fallback)
- Print stylesheet added
- Client bundle reductions: 42–55% across all routes

**New files:**
- `web/src/components/profile/WriterActivity.tsx`
- `web/src/components/ui/Avatar.tsx`
- `web/public/fonts/literata-latin-400.woff2`
- `web/public/fonts/literata-latin-400-italic.woff2`
- `web/public/fonts/literata-latin-ext-400.woff2`
- `web/public/fonts/literata-latin-ext-400-italic.woff2`
- `gateway/src/routes/signing.ts`
- `.dockerignore`

**Modified files (30+):**
- `gateway/src/routes/articles.ts` — `contentFree` field, `/by-event/:id` endpoint, pricePence cap
- `gateway/src/routes/notes.ts` — `/feed/following` endpoint, awaited notification inserts
- `gateway/src/routes/signing.ts` — new `POST /sign-and-publish`
- `web/src/app/article/[dTag]/page.tsx` — SSR conversion
- `web/src/app/[username]/page.tsx` — SSR conversion
- `web/src/components/article/ArticleReader.tsx` — accepts pre-rendered HTML, uses Avatar, NDK removed
- `web/src/components/feed/FeedView.tsx` — gateway API replaces relay queries
- `web/src/components/feed/QuoteCard.tsx` — NDK fallback removed
- `web/src/app/dashboard/page.tsx` — NDK event replaced with signAndPublish
- `web/src/app/write/page.tsx` — relay fetch replaced with gateway API
- `web/src/lib/ndk.ts` — types-only (no runtime NDK)
- `web/src/lib/sign.ts` — gateway signing proxy
- `web/src/lib/publish.ts` — uses signAndPublish
- `web/src/lib/publishNote.ts` — uses signAndPublish
- `web/src/lib/comments.ts` — uses signAndPublish
- `web/src/lib/replies.ts` — uses signAndPublish
- `web/src/lib/api.ts` — feed.following(), contentFree type
- `web/src/app/globals.css` — self-hosted @font-face, system font stacks, print stylesheet
- `web/src/app/layout.tsx` — font preload links
- `web/tailwind.config.js` — system font stacks
- `web/package.json` — removed NDK packages
- `web/tsconfig.json` — target ES2020
- `web/Dockerfile`, `payment-service/Dockerfile`, `key-service/Dockerfile` — NODE_ENV=production
- `shared/src/db/client.ts` — config cache TTL
- `payment-service/src/routes/webhook.ts` — static pool import
- `web/src/components/ui/VoteControls.tsx` — aria-labels
- `web/src/stores/auth.ts` — session storage cleanup
- `web/src/components/payment/CardSetup.tsx` — system font stack
- `nginx.conf` — HSTS preload, CSP update
- All service `package.json` files — pg/dotenv alignment

---

### v3.31.0 — 2 April 2026

**Fix: notification dedup index blocking repeat notifications**

Schema change: new migration (019). No service rebuilds needed. Deploy order: **migrate only**.

The notification deduplication unique index (`idx_notifications_dedup`, added in migration 014 / v3.21.0) covered all rows regardless of read status. Once a notification was marked as read, the old row still occupied the unique slot in the index. Any subsequent event of the same `(recipient_id, actor_id, type, article_id, note_id, comment_id)` combination was silently dropped by `ON CONFLICT DO NOTHING`. This meant:

- A user who unfollowed and re-followed never triggered a second `new_follower` notification
- A second reply from the same user to the same article never triggered a new `new_reply` notification
- Same for `new_subscriber`, `new_quote`, `new_mention`, and all other notification types

**Fix:** Migration 019 drops the old index and recreates it as a **partial unique index** with `WHERE read = false`. Only unread rows are constrained — once a notification is marked as read, the unique slot is released and new events of the same kind can insert fresh rows. The migration also wraps `actor_id` in `COALESCE` (matching the other nullable FK columns) for consistent NULL handling.

**Files changed:**
- `migrations/019_fix_notification_dedup.sql` — drops old index, creates partial index on `read = false`
- `schema.sql` — updated to reflect corrected index definition

**Upgrade steps:**

1. `git pull origin master`
2. `docker exec -i platform-pub-postgres-1 psql -U platformpub platformpub < migrations/019_fix_notification_dedup.sql`

No service rebuilds required — the change is index-only.

---

### v3.30.0 — 1 April 2026

**Dev-mode instant login and local Docker networking fixes**

No schema changes. Services changed: **gateway**, **web**. Deploy order: **rebuild changed services**.

Added `POST /auth/dev-login` endpoint (gateway, development only) that accepts an email and creates a session directly — no magic link needed. Guarded by `NODE_ENV=development`; the route is not registered in production. Frontend adds an "Instant dev login" button on `/auth` (development builds only). Docker networking fixes: gateway `.env` service URLs now use Docker service names; `web/.env` separates server-side `GATEWAY_URL` from client-side `NEXT_PUBLIC_GATEWAY_URL`.

**Files changed:** `gateway/src/routes/auth.ts`, `web/src/app/auth/page.tsx`, `web/src/lib/api.ts`, `gateway/.env`, `web/.env`

**Upgrade steps:**

1. `git pull origin master`
2. `docker compose build gateway web && docker compose up -d gateway web`

No migrations required.

---

### v3.29.0 — 1 April 2026

**Medium-priority audit fixes — subscriptions, XSS, search, notifications, health checks**

New migration (018). Services changed: **gateway**, **payment-service**, **web**, plus **docker-compose.yml**. Deploy order: **migrate → rebuild changed services**.

Implements all medium-priority fixes from the codebase audit (`FIXES.md` items 13–22): subscription expiry lifecycle, XSS sanitisation of markdown links, LIKE metacharacter escaping in search, config cache TTL in AccrualService, notification type sync (frontend union expanded from 5→12 types), drive update truthiness fix, Docker health checks for all 7 services, auth hydration guard (loading spinner until `fetchMe()` resolves), and FK ON DELETE clauses via migration 018.

**Files changed:** `gateway/src/routes/subscriptions.ts`, `gateway/src/index.ts`, `gateway/src/routes/search.ts`, `gateway/src/routes/drives.ts`, `payment-service/src/services/accrual.ts`, `web/src/lib/markdown.ts`, `web/src/lib/api.ts`, `web/src/components/ui/NotificationBell.tsx`, `web/src/app/notifications/page.tsx`, `web/src/components/layout/AuthProvider.tsx`, `docker-compose.yml`, `migrations/018_add_on_delete_clauses.sql`

**Upgrade steps:**

1. `git pull origin master`
2. `docker exec -i platform-pub-postgres-1 psql -U platformpub platformpub < migrations/018_add_on_delete_clauses.sql`
3. `docker compose build gateway payment web && docker compose up -d`

---

### v3.28.0 — 1 April 2026

**High-priority audit fixes — auth, payments, security hardening**

No schema changes. No new migrations. Services changed: **gateway**, **payment-service**, **nginx**, plus all Dockerfiles and **docker-compose.yml**. Deploy order: **rebuild all services**.

Implements all high-priority fixes from the codebase audit (`FIXES.md` items 5–12): account status check in auth middleware (suspended users rejected immediately), settlement confirmation idempotency guard (duplicate Stripe webhooks no longer double-debit), DM sender visibility fix, nginx security headers (HSTS, CSP, X-Frame-Options, etc.), gateway rate limiting via `@fastify/rate-limit`, `requireAdmin` return statement fix, non-root Docker containers, and internal service ports removed from host bindings.

**Files changed:** `gateway/src/middleware/auth.ts`, `payment-service/src/services/settlement.ts`, `gateway/src/routes/messages.ts`, `nginx.conf`, `gateway/package.json`, `gateway/src/index.ts`, `gateway/src/routes/auth.ts`, `gateway/src/routes/articles.ts`, `gateway/src/routes/search.ts`, `gateway/src/routes/moderation.ts`, `gateway/Dockerfile`, `payment-service/Dockerfile`, `key-service/Dockerfile`, `key-custody/Dockerfile`, `web/Dockerfile`, `docker-compose.yml`

**Upgrade steps:**

1. `git pull origin master`
2. `cd gateway && npm install && cd ..`
3. `docker compose build --no-cache && docker compose up -d`

No migrations required.

---

### v3.27.2 — 1 April 2026

**Nav notification button alignment, wordmark parchment background**

No schema changes. Services rebuilt: **web only**.

**Notification bell alignment**

The `NotificationBell` component in the desktop sidebar used different styling from other nav items — smaller font (`text-[15px]` vs `text-[17px]`), tighter padding (`py-3 pl-4` vs `py-[14px] pl-5 pr-5`), and no left border. Updated to match `sidebarLinkClass`: `text-[17px]`, `py-[14px]`, `pl-5 pr-5`, `border-l-4 border-transparent`, `font-medium`.

**Wordmark parchment background**

Added parchment background (`#FFFAEF` / `card` token) to the "Platform" wordmark box in the nav header. The red-bordered wordmark now sits on a warm parchment fill instead of being transparent against the green nav.

**Files changed:**
- `web/src/components/ui/NotificationBell.tsx` — aligned sidebar button classes with other nav items
- `web/src/components/layout/Nav.tsx` — added `backgroundColor: '#FFFAEF'` to wordmark style

**Upgrade steps:**

1. `git pull origin master`
2. `docker compose build --no-cache web && docker compose up -d web`

No migrations required.

---

### v3.27.1 — 1 April 2026

**Migration 015 — create article_unlocks if missing**

No new schema changes beyond ensuring table existence. Services rebuilt: **gateway, key-service**.

Migration 015 failed on production because `article_unlocks` did not exist. The table should have been created by migration 005, but on databases where 005 was bootstrapped (marked applied without running its SQL), the table was never created. Migration 015 now creates the table with `IF NOT EXISTS` before altering the constraint.

**Files changed:**
- `migrations/015_access_mode_and_unlock_types.sql` — added `CREATE TABLE IF NOT EXISTS article_unlocks` guard

**Upgrade steps:**

1. `git pull origin master`
2. `docker compose build --no-cache gateway && docker compose up -d`
3. Migrations run automatically on startup

---

### v3.27.0 — 1 April 2026

**Critical audit fixes — schema.sql, drive fulfilment, gate-pass idempotency**

No new migrations. Services rebuilt: **gateway, key-service**.

**schema.sql regenerated**

Regenerated `schema.sql` to include all tables from migrations 001–017. Fresh Docker installs using `schema.sql` for bootstrapping no longer break due to missing tables.

**Drive fulfilment transaction safety**

Wrapped `checkAndTriggerDriveFulfilment` in `withTransaction` so the `FOR UPDATE` lock is held through the subsequent `UPDATE`. Prevents double fulfilment under concurrent pledges.

**Gate-pass idempotency**

Moved `recordPurchaseUnlock` before key issuance in the gate-pass flow. If key issuance fails and the reader retries, the existing unlock record is found and the reader is not re-charged.

**Files changed:**
- `schema.sql` — regenerated from migrations 001–017
- `gateway/src/routes/articles.ts` — gate-pass idempotency reorder
- `gateway/src/routes/drives.ts` — transaction wrapper for fulfilment check
- `key-service/src/services/verification.ts` — removed misleading comments and dead provisional-check code

**Upgrade steps:**

1. `git pull origin master`
2. `docker compose build --no-cache gateway key-service && docker compose up -d`

No new migrations required (schema.sql is for fresh installs only).

---

### v3.26.0 — 31 March 2026

**Design Spec v2 — chunky, robust, spirited refresh**

No schema changes. Services rebuilt: **web only**.

Thicker rules, heavier buttons with typewriter-key depress effect, larger type scale (13px minimum), accent-border article cards, new homepage sections (manifesto, how-it-works, featured writers), crimson-bordered paywall gate, and input field borders on auth.

**Files changed:**
- `web/tailwind.config.js` — updated design tokens
- `web/src/app/globals.css` — global style adjustments
- `web/src/app/page.tsx` — new homepage sections (manifesto, how-it-works, featured writers)
- `web/src/app/auth/page.tsx` — input field border styling
- `web/src/components/layout/Nav.tsx` — heavier nav styling
- `web/src/components/article/ArticleReader.tsx` — thicker rules, larger type
- `web/src/components/article/PaywallGate.tsx` — crimson-bordered paywall gate
- `web/src/components/feed/ArticleCard.tsx` — accent-border article cards
- `web/src/components/feed/FeedView.tsx` — layout adjustments
- `web/src/components/feed/NoteCard.tsx` — type scale update
- `web/src/components/feed/NoteComposer.tsx` — heavier button styling
- `web/src/components/home/FeaturedWriters.tsx` — new featured writers section

**Upgrade steps:**

1. `git pull origin master`
2. `docker compose build --no-cache web && docker compose up -d web`

No migrations required.

---

### v3.25.0 — 31 March 2026

**DMs, pledge drives, free passes, invitation-only articles**

Three new migrations (015–017). Services rebuilt: **gateway**.

**Access mode column**

Replaced `is_paywalled` boolean with `access_mode` column (`public`, `paywalled`, `invitation_only`). Migration 015 adds the column and backfills from existing data.

**Free passes**

Authors can grant free article access to specific readers. Creates an `article_unlocks` row with `unlock_type = 'free_pass'` — no revenue event is generated.

**Invitation-only articles**

New access mode where gate-pass returns `403 invitation_required`. Only readers with a free pass can access the content.

**Direct messages**

NIP-17 end-to-end encrypted conversations. New `direct_messages` table (migration 016) and route module. DM pricing is configurable per writer.

**Pledge drives**

Crowdfunding / commission system. New `pledge_drives` and `pledges` tables (migration 017). Fulfilment is async via the existing settlement pipeline.

**Files changed:**
- `migrations/015_access_mode_and_unlock_types.sql` — access_mode column, unlock_type expansion
- `migrations/016_direct_messages.sql` — direct_messages table
- `migrations/017_pledge_drives.sql` — pledge_drives and pledges tables
- `schema.sql` — regenerated
- `seed.sql` — updated for new schema
- `gateway/src/index.ts` — register new route modules
- `gateway/src/routes/articles.ts` — access_mode logic, free pass support
- `gateway/src/routes/drives.ts` — pledge drive CRUD and fulfilment
- `gateway/src/routes/free-passes.ts` — free pass grant/revoke
- `gateway/src/routes/messages.ts` — DM routes
- `gateway/src/routes/notes.ts` — minor adjustments
- `gateway/src/routes/search.ts` — search across new content types
- `gateway/src/routes/export.ts` — include new data in exports
- `gateway/src/routes/history.ts` — history for new unlock types
- `gateway/src/routes/writers.ts` — writer DM pricing config

**Upgrade steps:**

1. `git pull origin master`
2. `docker compose build --no-cache gateway && docker compose up -d`
3. Migrations 015–017 run automatically on startup

---

### v3.24.0 — 30 March 2026

**Composer fixes, crimson brand nav**

No schema changes. Services rebuilt: **web only**.

Removed `NoteComposer` bottom keyline (dropped `mb-4`), fixed mobile sticky positioning alignment, swapped brand logo from parchment to crimson colour scheme. Subsequently restored parchment background (`bg-card`) on `NoteComposer` wrapper to keep the warm textarea background while keeping the keyline removed.

**Files changed:**
- `web/src/components/layout/Nav.tsx` — crimson brand logo colour
- `web/src/components/feed/NoteComposer.tsx` — removed keyline, restored bg-card
- `web/src/components/feed/FeedView.tsx` — sticky offset alignment

**Upgrade steps:**

1. `git pull origin master`
2. `docker compose build --no-cache web && docker compose up -d web`

No migrations required.

---

### v3.23.0 — 29 March 2026

**Pale green nav, parchment brand logo, quote click-through fix**

No schema changes. Services rebuilt: **web only**.

**Nav colour swap**

Nav background changed from medium green (`#82A890`) to pale green (`#DDEEE4`, previously `surface-deep` / the nav button hover colour). Nav button hover state swapped to medium green (`#82A890`, previously the nav background). New Tailwind token: `nav.hover` (`#82A890`). Nav text colours adjusted for the light background: active links use `text-ink`, inactive use `text-content-faint`, hover uses `text-content-secondary`. Hamburger bars changed from `bg-card` to `bg-ink`. Search inputs on nav use `bg-surface-deep` with `text-ink`. Feed sticky zone (NoteComposer area) inherits the pale green via `bg-nav`.

**Brand logo restyled**

"Platform" logo now uses parchment-coloured text (`#FFFAEF`) with a parchment-coloured outline border (`1.5px solid #FFFAEF`), no fill background. Sits against the pale green nav background.

**Quote click-through fix**

`ExcerptPennant` (highlighted-text quotes displayed in notes) previously dead-linked when the quoted item was a note rather than an article (`href="#"` with `preventDefault`). Now falls back to the quoted author's profile page (`/{username}`) when no article `dTag` is available. Article quotes continue to link to `/article/{dTag}` as before. The `QuoteCard` component (non-excerpt quotes) already handled both cases correctly.

**Files changed:**
- `web/tailwind.config.js` — added `nav.hover` token, updated `nav.DEFAULT`
- `web/src/components/layout/Nav.tsx` — pale green nav, parchment brand, hover classes
- `web/src/components/ui/NotificationBell.tsx` — hover class update for nav
- `web/src/components/feed/FeedView.tsx` — inherits nav colour via `bg-nav`
- `web/src/app/globals.css` — feed tab and nav-related style adjustments
- `web/src/components/feed/NoteCard.tsx` — ExcerptPennant quote click-through fix

**Upgrade steps:**

1. `git pull origin master`
2. `docker compose build --no-cache web && docker compose up -d web`

No migrations required.

---

### v3.22.0 — 29 March 2026

**Account statement API, mobile article fix, Feed nav link, soft borders visual refresh**

No schema changes. Services rebuilt: **web, gateway**.

**New endpoint: `GET /api/v1/my/account-statement`** (gateway)

Unified paginated account statement combining all credits and debits into a single feed. Credits include: £5 free allowance, article earnings (net of 8% platform fee), subscription earnings, and upvote earnings. Debits include: paywall reads, subscription charges, and vote charges. Settlement events appear as line items. Summary totals (credits, debits, balance) reset to zero on each Stripe settlement. Supports `?filter=all|credits|debits`, `?limit` (default 30, max 200), and `?offset` for pagination.

**Accounts tab rewrite** (frontend)

The Accounts dashboard tab now fetches from the new `/my/account-statement` endpoint instead of assembling data client-side. Three clickable summary tiles filter the itemised statement: Credits shows income only, Debits shows outgoings only, Balance shows everything. Default 30 rows with a "Show more" button for pagination. Each row shows date, category label, linked description, and signed amount.

**Mobile article reader fix**

The article card had hardcoded `padding: 40px 72px`, leaving ~183px for text on a 375px phone. Replaced with responsive Tailwind classes: `px-5 py-6` on mobile, `px-10 py-8` at sm, `px-[72px] py-10` at md. Hero image negative margins updated to match at each breakpoint.

**Feed link added to nav**

Explicit "Feed" link added to all three nav layouts (desktop sidebar, tablet inline bar, mobile drawer), positioned first below the brand. Highlighted when on `/feed` or `/`. Both the brand logo and Feed link navigate to `/feed`.

**Visual refresh: soft borders**

- All `border-ink` references removed site-wide (~40 occurrences across 20+ files). Heavy black borders replaced with `border-rule` (#B8D2C1, soft sage green). 3px rules thinned to 1px.
- `.btn` and `.btn-accent` borders removed. `.btn:hover` changed to `#263D32`.
- `.tab-pill-active` background softened from `#0F1F18` to `#263D32`.
- NoteComposer border removed (borderless on nav background).
- globals.css: `hr`, `.rule`, `.rule-inset`, `.rule-accent` all softened to 1px #B8D2C1.

**Upgrade steps:**

1. `git pull origin master`
2. `docker compose build --no-cache web gateway && docker compose up -d web gateway`

No migrations required.

---

### v3.21.0 — 28 March 2026

**Security hardening, consistency fixes, notification dedup, dead code cleanup**

Codebase audit and fix pass. No new features. Migration 014 required.

**Security**

- **Key-service export auth:** `/writers/export-keys` now validates `x-internal-secret` header. Previously any request with a spoofed `x-writer-id` header could export vault content keys without authentication. `INTERNAL_SECRET` env var must now be set on key-service (add to `key-service/.env`).
- **Vote race condition:** `POST /votes` now acquires a `pg_advisory_xact_lock` before counting existing votes, preventing concurrent votes from receiving the same sequence number and incorrect pricing.
- **@mention regex hardened:** negative lookbehind `(?<![a-zA-Z0-9.])` prevents matching email addresses (e.g. `user@example.com`) and dotted identifiers as @mentions. Applied to both `notes.ts` and `replies.ts`.

**Consistency**

- **`is_writer` filter relaxed:** search (`GET /search`), RSS (`GET /rss/:username`), and export (`GET /export`) endpoints no longer require `is_writer = TRUE`. Any `status = 'active'` account is now discoverable, consistent with the profile and follow endpoints relaxed in v3.17.0.
- **Profile page vote controls:** `isOwnContent` was hardcoded to `true` on all reply cards, disabling voting on every profile page. Now correctly computed from whether the viewer is looking at their own profile.
- **Profile page vote batching:** vote tallies and user vote counts are now batch-fetched for all activity items, eliminating N+1 API calls (previously each card fired 2 individual requests).
- **Profile page inline background removed:** hardcoded `style={{ background: '#EDF5F0' }}` on the activity container removed; page background handles this via Tailwind.

**Data integrity**

- **Migration 014:** removes duplicate notification rows and adds a unique index `idx_notifications_dedup` on `(recipient_id, actor_id, type, article_id, note_id, comment_id)` to prevent future duplicates.
- All fire-and-forget notification INSERTs across `follows.ts`, `notes.ts`, `replies.ts`, and `subscriptions.ts` now include `ON CONFLICT DO NOTHING`.

**Config cleanup**

- **`COOKIE_SECRET` removed:** gateway cookie signing now uses `SESSION_SECRET` only (the documented env var). Remove `COOKIE_SECRET` from `gateway/.env` if present — it is no longer read.
- **`ignoreBuildErrors: true` removed from `next.config.js`:** TypeScript errors are now enforced at build time. `missingSuspenseWithCSRBailout: false` retained — required for 7 CSR-only pages using `useSearchParams()`.
- **CORS origin comment:** `APP_URL` env var now has a production-required comment in source.

**Cleanup**

- Deleted 5 dead backup files: `gateway/src/routes/v1_6.ts.save`, `gateway/src/routes/media.ts.bak`, `web/tailwind.config.js.bak`, `web/src/app/globals.css.bak`, `migrations/003_comments.sql.bak`.
- Renamed misleading `.label-mono` CSS class to `.label-muted` (it uses Source Sans 3, not a monospace font).
- Removed `console.log('Published:', result)` from `web/src/app/write/page.tsx`.

**Upgrade steps:**

1. Add `INTERNAL_SECRET` to `key-service/.env` (same value as gateway and key-custody)
2. Remove `COOKIE_SECRET` from `gateway/.env` (if present)
3. Apply migration: `docker exec -i platform-pub-postgres-1 psql -U platformpub platformpub < migrations/014_notification_dedup.sql`
4. Rebuild and restart: `docker compose build gateway keyservice web && docker compose up -d gateway keyservice web`

**Services rebuilt: gateway, keyservice, web. Payment-service and key-custody unchanged.**

---

### v3.18.0 — 28 March 2026

**Full visual redesign — mint/parchment two-surface system, Literata typography, WCAG focus states**

Complete replacement of the frontend design system across 41 files (785 insertions, 1,150 deletions). No schema or API changes — this is a purely visual update.

**Colour system overhaul**

The warm beige/cream palette has been replaced with a fresh two-surface system:
- **Surface (page background):** mint `#EDF5F0` — replaces all previous beige/sand/cream backgrounds
- **Card (content surfaces):** bright parchment `#FFFAEF` — article cards, note composers, dropdowns, modals
- **Surface-deep:** `#DDEEE4` — loading skeletons, paywall gate background, hover states
- **Accent:** ink red `#B5242A` — replaces crimson `#9B1C20`; used for active states, paywall indicators, delete confirmations
- **Ink:** deep forest `#0F1F18` — replaces warm stone `#292524`; primary text and dark UI elements
- **Rule (borders):** sage `#B8D2C1` — replaces all old border tokens
- **Avatar backgrounds:** `#C2DBC9` — replaces crimson gradients and dark fills
- **Content hierarchy:** five semantic levels (primary, secondary, muted, faint, card-muted) replace the old `ink-50` through `ink-900` scale

Old Tailwind tokens removed entirely: `crimson`, `slate`, `ink-50`–`ink-900`, `surface-raised`, `surface-sunken`, `surface-strong`, `surface-card`, `brand-*`, `accent-*`.

**Typography**

- Serif: Literata (Google Fonts) replaces Newsreader. All article titles and card headlines render in **italic** Literata
- Sans-serif: Source Sans 3 replaces Inter/system-ui for body text
- Monospace: IBM Plex Mono for code blocks
- Article reader titles: italic Literata 36px; feed card headlines: italic Literata 21px weight 500

**Component-level changes**

- **Nav sidebar:** dark `#2A2A2A` background removed → mint `bg-surface` with ink text. Width reduced from 200px to 180px. Active links use accent left border instead of crimson
- **ArticleCard:** zigzag `clip-path` removed (along with `applyZigzag` function). Parchment background, no border, italic headlines, uppercase writer name in `card-muted`, price as `£X.XX` in accent
- **NoteCard:** dark `#2A2A2A` background removed → notes render on mint with `py-4`. Avatar uses `#C2DBC9`. ExcerptPennant uses parchment with `2.5px solid #B5242A` left border
- **QuoteCard:** all zigzag clip-path code removed. Parchment backgrounds with accent left border for both article pennants and quoted notes
- **ArticleReader:** content wrapped in parchment card (`40px 48px` padding). Back link on mint surface. Quote popup and modal overlay use `bg-ink`
- **PaywallGate:** `surface-deep` background with gradient fade. Negative horizontal margins to bleed to card edges. Heading in Literata roman 20px, price in Literata 28px
- **NoteComposer:** mint avatar, `bg-card` surface, `btn` class post button
- **NotificationBell:** `bg-card border-rule` panel, `bg-surface-deep` hover states
- **VoteControls / VoteConfirmModal:** mint surface colours, `bg-ink` tooltip with 2px radius
- **ShareButton / ReportButton / AllowanceExhaustedModal:** updated to `bg-card border-rule` tokens
- **CommentSection / CommentItem / CommentComposer:** all `ink-*` and `brand-*` tokens replaced
- **ReplySection / ReplyItem / ReplyComposer:** updated to `border-rule`, `bg-surface-deep`, `text-accent` tokens
- **ArticleEditor:** italic Literata title input, updated toolbar tokens, `text-rule` separator
- **EmbedNode:** `border-rule bg-surface-deep`, `text-accent` links
- **CardSetup (Stripe):** `border-rule`, `btn` class, Stripe Elements theme updated to match new palette
- **All 15 page files** under `web/src/app/` updated to new tokens

**Accessibility (WCAG 2.4.7)**

- All interactive elements now have `focus-visible` indicators:
  - Buttons and links: `outline: 2px solid #B5242A` (accent)
  - Accent-background buttons: `outline: 2px solid #0F1F18` (ink, for contrast)
  - Form inputs: `box-shadow: 0 0 0 2px #B8D2C1` (rule colour ring)

**Styling rules**

- All borders: 1px (no sub-pixel 0.5px)
- All button border-radius: 2px (no rounded-md/xl/full on buttons)
- Pill buttons removed entirely from the design

**No schema changes. No API changes. Services rebuilt: all five (web, gateway, payment, keyservice, key-custody).**

---

### v3.17.0 — 24 March 2026

**UI changes: quote links, profile replies, feed threading, tab spacing**

**Change 1 — Quote flags: clickable body and linked author**

The pale quote pennant on note tiles is now interactive. The quoted excerpt text is a Link to `/article/[dTag]` (dTag resolved lazily via `/api/v1/content/resolve`). The attribution line has separate links: author name links to `/{authorUsername}`, article title links to the article. For full-tile QuoteCard article pennants, the author attribution uses `router.push()` with `stopPropagation` to avoid triggering the outer article Link.

**Change 2 — Profile page reply cards: "Replying to", delete, votes, deep links**

Reply cards on writer profile pages now show: "Replying to @username" badge with profile link; reply content wrapped in a Link to `/article/[slug]#reply-[id]`; Delete button with 3-second confirm (calls `DELETE /api/v1/replies/:id`); VoteControls on the reply's `nostrEventId`; Quote button wired to NoteComposer modal. Backend: `GET /writers/:username/replies` now LEFT JOINs parent comment and account rows to surface `parentEventId`, `parentAuthorUsername`, `parentAuthorDisplayName`, and returns deleted replies with `isDeleted: true`.

**Change 3 — Feed replies expanded by default; compose input on demand**

Note tiles now mount ReplySection immediately (up to 3 most recent replies visible). The reply compose box is hidden by default, shown on "Reply" click. New `composerOpen` / `onComposerClose` prop pair on ReplySection controls this; default (`undefined`) preserves always-visible behaviour on article pages.

**Change 4 — Feed tab spacing**

Tab pills now have 6px right margin between them via `.tab-pill` CSS update.

**Files changed:** `gateway/src/routes/writers.ts`, `web/src/app/[username]/page.tsx`, `web/src/app/globals.css`, `web/src/components/feed/NoteCard.tsx`, `web/src/components/feed/QuoteCard.tsx`, `web/src/components/replies/ReplySection.tsx`

**No schema changes. Services changed: gateway and web.**

---

### v3.16.0 — 24 March 2026

**UI polish: collapsed replies, zigzag quote edges, nav cleanup, profile page quote fix**

**Change 1 — Note tile replies collapsed by default**

Note tiles in the feed previously rendered with the reply section expanded on load (`showReplies` defaulted to `true`). This caused every note on the feed to show an open reply composer and existing replies on first paint, making the feed visually heavy. The default is now `false`; the reply section is hidden until the user clicks the reply pill.

**Change 2 — Article quotes in note tiles: zigzag right edge replaces swallowtail**

Both types of article quote that appear inside dark-grey note tiles — the full `QuoteCard` article tile (`ArticlePennant`) and the text-excerpt `ExcerptPennant` — previously used the single V-notch swallowtail `clip-path` and extended past the right edge of the note tile via a negative `marginRight`. Both now use the same repeating zigzag (`applyZigzag`) as the main article feed tiles, fully contained within the note tile (negative margin overhangs removed, `paddingRight` reduced from 48px to 28px to suit the 12px zigzag depth).

**Change 3 — History link removed from navigation**

The "History" link was present in both the mobile hamburger drawer and the desktop left sidebar without having been intentionally added. It has been removed from both nav surfaces. The `/history` route and its backend are unaffected.

**Fix 4 — Quote fields missing from writer profile page notes**

`GET /writers/:username/notes` selected only `id`, `nostr_event_id`, `content`, `published_at` — the five quote columns (`quoted_event_id`, `quoted_event_kind`, `quoted_excerpt`, `quoted_title`, `quoted_author`) were never fetched or returned. On writer profile pages, any note containing a quoted article rendered with no quote UI (no pennant, no paywall border, no article tile). The endpoint now returns all quote fields; the `DbNote` interface and `NoteEvent` construction on the profile page pass them through to `NoteCard`, so full quote rendering including the red paywall left border now works on profile pages.

**Files changed:** `gateway/src/routes/writers.ts`, `web/src/app/[username]/page.tsx`, `web/src/components/feed/NoteCard.tsx`, `web/src/components/feed/QuoteCard.tsx`, `web/src/components/layout/Nav.tsx`

**No schema changes. Services changed: gateway and web. Deploy order: gateway → web.**

---

### v3.12.0 — 24 March 2026

**Fix: feed redesign visual regressions (web only)**

Six visual bugs introduced during the feed redesign are corrected. No schema changes. Web only.

**Bug 1 — Brown/beige ribbon behind feed**

`FeedView.tsx` applied a hardcoded `style={{ background: 'rgb(234,229,220)' }}` to the feed wrapper `<div>` in both the "For you" and "Following" tab renders. This painted the `surface-sunken` tone as a solid band behind every card, contradicting the mock-up where cards sit directly on the page background. The inline style has been removed from both wrapper divs.

**Bug 2 — Article tile colour identical to page background**

`ArticleCard.tsx` used `background: '#F5F0E8'` for the card fill — the same value as the page's `bg-surface` body colour, giving zero contrast. The card and the quoted-article `ArticlePennant` in `QuoteCard.tsx` both suffered the same problem. Both are updated to `#FAF7F2` (a visibly lighter warm cream). A new `surface.card` Tailwind token (`'#FAF7F2'`) is added to `tailwind.config.js` under `theme.extend.colors.surface` for consistent reuse as `bg-surface-card`.

**Bug 3 — Article tile right edge is a zigzag instead of a swallowtail**

`ArticleCard.tsx` shaped its right edge with `applyZigzag()` — a function that computed a `clip-path: polygon(...)` with many repeating triangular teeth. The correct shape (a single V-notch pennant, matching the mock-up) already existed as `applySwallowtail()` in `QuoteCard.tsx`. `applyZigzag()` has been replaced entirely with `applySwallowtail()` using a 40px fork depth (slightly deeper than the 28px used on smaller quoted-article pennants, to suit the full-width feed card). The `useEffect` that drives the clip-path update on resize now calls `applySwallowtail`.

**Bug 4 — Quoted article pennant colour wrong**

The `ArticlePennant` sub-component in `QuoteCard.tsx` used the same `#F5F0E8` background as Bug 2. Corrected to `#FAF7F2` alongside the `ArticleCard` fix.

**Bug 5 — Text-excerpt quotes rendered as plain left-bordered text, not a cream pennant**

`NoteCard.tsx` rendered `quotedExcerpt` as a simple `<div>` with a left border and italic text. This path bypassed the cream-pennant styling used by `QuoteCard`. A new `ExcerptPennant` component is added directly in `NoteCard.tsx`. It:
- Renders immediately with the known data (`quotedExcerpt`, `quotedTitle`, `quotedAuthor`) — no loading state.
- Applies the same swallowtail `clip-path` and `#FAF7F2` background as the article tile.
- Shows a 5px crimson left border when the source article is paywalled.
- On mount, fires a `GET /api/v1/content/resolve?eventId=` request (using `note.quotedEventId`, which is always set on excerpt quotes via the `q` Nostr tag). Once resolved it obtains the article `dTag` and paywall status, wraps the entire card in a `<Link href="/article/:dTag">`, and applies the paywall border.
- Extends 16px past the NoteCard's right padding (matching the parent's actual padding) so the swallowtail reaches the card edge.

**Bug 6 — Excerpt quote not clickable (partial fix)**

As a consequence of Bug 5: the `ExcerptPennant` becomes a `<Link>` once the article's `dTag` is resolved. The link is not available during the initial render (before the resolve completes) but appears within one request round-trip. Full pre-fetch of `dTag` at publish time (by adding an `excerpt-dtag` tag to the Nostr event) remains a future improvement.

**Files changed:** `web/tailwind.config.js`, `web/src/components/feed/FeedView.tsx`, `web/src/components/feed/ArticleCard.tsx`, `web/src/components/feed/QuoteCard.tsx`, `web/src/components/feed/NoteCard.tsx`

**No schema changes. Rebuild web only.**

---

### v3.11.0 — 24 March 2026

**Fix: notification persist, quoted-note author name, reply-to-article link**

**Fix 1 — Notifications reappear after clicking**

Clicking a notification row navigated immediately via Next.js `router.push()`, which cancelled the in-flight `POST /api/v1/notifications/read-all` request before it could complete. On returning to `/notifications` the clicked rows were still unread on the server and reappeared. Fixed by awaiting the mark-read call before navigating, or firing it with `keepalive: true` so it survives the page unload. No schema change.

**Fix 2 — Quoted note shows truncated pubkey instead of author display name**

`GET /api/v1/content/resolve` was selecting `a.avatar` in its SQL query. The `accounts` table has no `avatar` column — the correct column is `avatar_blossom_url`. PostgreSQL threw a column-not-found error on every note-resolve request; the gateway caught it and returned a 500; `QuoteCard` fell through to the NDK relay fallback, which has no display-name data and used the raw Nostr pubkey truncated to 8 characters. Fixed by correcting the column alias in the SQL query.

**Fix 3 — Reply tiles on user profile pages link to source article**

The `DbReplyCard` component on `/:username` profile pages showed the reply text and timestamp but no link back to the article being replied to. The gateway's `GET /writers/:username/replies` endpoint now joins against the `articles` table to return `articleTitle` and `articleDTag` alongside each reply. The profile page passes these to `DbReplyCard`, which now renders an article title link (`/article/:dTag`) below the reply body for article replies. Note replies (`target_kind = 1`) do not show a link as there is no note permalink route.

**Files changed:** `gateway/src/routes/writers.ts`, `web/src/app/[username]/page.tsx`, `web/src/components/ui/NotificationBell.tsx` (or `web/src/app/notifications/page.tsx`)

**No schema changes. Rebuild gateway and web.**

---

### v3.10.0 — 23 March 2026

**Dark navigation sidebar + "For you" global feed tab**

**Navigation sidebar redesign — light → dark**

The fixed left sidebar (visible at `lg+` breakpoint) has been redesigned from the white (`bg-surface-raised`, `#FFFFFF`) theme introduced in v3.9.0 to a dark grey (`#2A2A2A`) theme matching the note card surface.

- Inactive nav links: `#9E9B97` (muted grey) on dark background.
- Hover: near-black row fill (`#141414`) with white text.
- Active link: retains the crimson left-border indicator with white text.
- The "Platform" logotype switches to white border and white text at `lg+`.
- Mobile top bar (below `lg`) is unchanged — white background, dark text.

**"For you" global feed tab**

A new "For you" tab is added to the feed page, left of "Following", and active by default. It is backed by a new `GET /api/v1/feed/global` endpoint that returns a mixed timeline of all published articles, notes, and new-user join events from all platform accounts, newest first. The feed respects the same vote-tally and quote/delete pipelines as the Following tab.

New-user join events appear as compact inline cards: avatar (or initial placeholder) + "X joined the platform" + relative timestamp. They are rendered by a new `NewUserCard` sub-component in `FeedView.tsx`.

**Files changed:** `gateway/src/routes/feed.ts` *(new)*, `gateway/src/index.ts`, `web/src/components/feed/FeedView.tsx`, `web/src/components/layout/Nav.tsx`

**No schema changes. Rebuild gateway and web.**

---

### v3.9.0 — 23 March 2026

**Visual: Newsreader typeface + light navigation sidebar**

**Typeface change — Cormorant → Newsreader**

The platform serif has been switched from Cormorant to Newsreader throughout. Newsreader is a text-optimised variable serif designed specifically for long-form reading; it includes an optical-size axis (`opsz 6..72`) that automatically adjusts stroke contrast and spacing for both display headings and body copy.

- `web/src/app/globals.css`: Google Fonts import updated to Newsreader with optical size axis weights (300–700, italic variants). Drop cap `font-family` updated.
- `web/tailwind.config.js`: `theme.extend.fontFamily.serif` and all `typography` plugin `fontFamily` overrides updated from `"Cormorant"` to `"Newsreader"`.
- `web/src/components/layout/Nav.tsx`: Logo inline `fontFamily` updated.
- `web/src/components/feed/ArticleCard.tsx`, `QuoteCard.tsx`, `NoteCard.tsx`: All inline `fontFamily` strings updated.

**Navigation sidebar redesign — dark → light**

The fixed left sidebar (visible at `lg+` breakpoint) has been redesigned from a dark (`bg-ink-900`, `#111111`) theme to a clean white (`bg-surface-raised`, `#FFFFFF`) theme with a subtle `border-r border-ink-200` separator.

- Inactive nav links: `text-ink-400` (`#9E9B97`, medium-light grey) — unchanged value, now legible on white.
- Hover: `text-ink-900` (`#111111`, near-black) — was `text-white`.
- Active link: `text-ink-900 font-medium` with existing crimson left-border indicator — was `text-white`.
- All supporting elements updated: dividers (`border-ink-200`), avatar placeholder backgrounds (`bg-ink-200`), username / balance / logout text colours, loading skeleton backgrounds, hamburger lines (`bg-ink-900`), mobile drawer background (`bg-surface-raised`), inline search inputs (`bg-ink-100`).

**Files changed:** `web/src/app/globals.css`, `web/tailwind.config.js`, `web/src/components/layout/Nav.tsx`, `web/src/components/feed/ArticleCard.tsx`, `web/src/components/feed/QuoteCard.tsx`, `web/src/components/feed/NoteCard.tsx`

**No schema changes. Rebuild web only.**

---

### v3.8.0 — 23 March 2026

**Fix: paywall decryption fails when v2 NIP-23 event is missing from relay (root-cause fix)**

Addresses the root cause of "Could not find the encrypted content." errors. The v3.5.3 fix (NDK reconnect) reduced the frequency of v2 events failing to reach the relay, but if the relay still didn't have the event the reader's unlock flow bailed out before recording payment or issuing a key. The deeper issue was architectural: the encrypted paywall body (ciphertext) was stored only in the relay's NIP-23 event — the database held no copy.

**Schema change:** `migrations/011_store_ciphertext.sql` — adds `ciphertext TEXT` column to `vault_keys`.

**Changes:**

- `migrations/011_store_ciphertext.sql`: `ALTER TABLE vault_keys ADD COLUMN ciphertext TEXT`.
- `key-service/src/services/vault.ts`: `publishArticle()` now persists the ciphertext to `vault_keys` immediately after encryption (covers both new articles and re-publishes). `issueKey()` selects and returns `ciphertext` alongside the wrapped key.
- `key-service/src/types/index.ts`: `KeyResponse` gains `ciphertext?: string`.
- `gateway/src/routes/articles.ts`: both gate-pass response paths (free-access and paid) forward `ciphertext` from the key service response.
- `web/src/lib/api.ts`: `GatePassResponse` gains `ciphertext?: string`.
- `web/src/components/article/ArticleReader.tsx`: `handleUnlock` restructured — gate-pass call happens first (payment recorded, key issued), then ciphertext is resolved from a fallback chain: server response → relay payload tag → legacy kind 39701 vault event. The relay is no longer a single point of failure.

**Files changed:** `migrations/011_store_ciphertext.sql`, `key-service/src/services/vault.ts`, `key-service/src/types/index.ts`, `gateway/src/routes/articles.ts`, `web/src/lib/api.ts`, `web/src/components/article/ArticleReader.tsx`

**Schema change: migration 011 must be applied. Deploy order: migration → key-service → gateway → web.**

---

### v3.5.3 — 22 March 2026

**Hotfix: paywalled articles publishing as free-only due to stale NDK WebSocket**

**Root cause:** After the vault encryption round-trip in `publishArticle()` (which involves multiple HTTP calls to the gateway and key-service), the NDK WebSocket connection to strfry could go idle and be dropped. The subsequent `signedV2.publish()` call would then fail with a "no relays available" error. Because this error was unhandled, the publish function threw before reaching Step 5 (re-index), leaving the article live on the relay as v1 (free content only, no `['payload', ...]` tag). Writers saw no error in the UI since the function had already completed the v1 publish and index steps successfully.

**Fix:** `publishArticle()` now calls `ndk.connect()` immediately before publishing v2, then retries once with a fresh connection if the first attempt fails. If both attempts fail, a clear error is thrown explaining that the article is live as free-only and the writer should retry — rather than silently succeeding without the paywall.

**Files changed:** `web/src/lib/publish.ts`

**No schema changes. Rebuild web only.**

---

### v3.5.2 — 22 March 2026

**Hotfix: user profile pages showing "Something went wrong" on all installs**

**Root cause — two compounding bugs:**

**Bug 1:** `migrations/003_comments.sql` and `migrations/004_media_uploads.sql` lacked `IF NOT EXISTS` guards. Because `schema.sql` (applied by Docker's `initdb.d` on first boot) already defines the `comments` and `media_uploads` tables and related columns, the migration runner fails on the first statement of migration 003, rolls back, and **stops**. On a fresh install using only the migration runner (no shell-loop bootstrap), migrations 004–010 are never applied.

**Bug 2:** The v3.5.0 upgrade bootstrap INSERT marked migrations 005–007 as applied in `_migrations` without actually running their SQL. On servers set up this way, `subscription_price_pence` (added by migration 005) and other columns were never added to the database even though `_migrations` reported them as applied.

**Combined effect:** `GET /writers/:username` queries `subscription_price_pence` from the `accounts` table. If that column is absent, PostgreSQL returns a column-not-found error → 500 → the profile page's `writers.getProfile()` call (which uses the `request()` helper that throws on non-200) throws → `profileError = true` → "Something went wrong loading this profile."

Note: the v3.5.1 hotfix (removing `AND deleted_at IS NULL` from the notes query) addressed a separate bug where the Notes tab silently failed to load. It did **not** fix `profileError` — notes are fetched with raw `fetch()`, which does not throw on a 500 and cannot set `profileError`. Only `writers.getProfile()` can trigger that error state.

**Files changed:** `migrations/003_comments.sql`, `migrations/004_media_uploads.sql`

**Upgrade path:**

> **Note:** The Postgres container is on the internal Docker network only (port 5432 is not exposed to the host). All database commands must go through `docker exec`.

First, check the state of `_migrations`:

```bash
docker exec platform-pub-postgres-1 psql -U platformpub platformpub -c "SELECT filename FROM _migrations ORDER BY id;" 2>&1
```

---

**Case A — `_migrations` has only `001` and `002`** (migration runner was used from the start and stopped at migration 003):

Apply migrations 003–010 directly via psql. Migrations 003–009 all now use `IF NOT EXISTS` so they are safe to run even if some DDL already exists. Migration 010 may produce harmless errors on tables that `schema.sql` already created — that is expected.

```bash
for f in migrations/003_comments.sql migrations/004_media_uploads.sql \
          migrations/005_subscriptions.sql migrations/006_receipt_portability.sql \
          migrations/007_subscription_nostr_event.sql migrations/008_deduplicate_articles.sql \
          migrations/009_notifications.sql migrations/010_votes.sql; do
  echo "--- $f ---"
  docker exec -i platform-pub-postgres-1 psql -U platformpub platformpub < "$f"
done
```

Record them in `_migrations`:

```bash
docker exec platform-pub-postgres-1 psql -U platformpub platformpub -c "
INSERT INTO _migrations (filename) VALUES
  ('003_comments.sql'),
  ('004_media_uploads.sql'),
  ('005_subscriptions.sql'),
  ('006_receipt_portability.sql'),
  ('007_subscription_nostr_event.sql'),
  ('008_deduplicate_articles.sql'),
  ('009_notifications.sql'),
  ('010_votes.sql')
ON CONFLICT DO NOTHING;"
```

---

**Case B — `_migrations` does not exist** (server was set up with the shell loop; runner was never used):

Create and bootstrap `_migrations`, then apply migrations 003 and 004 (the only ones that may not have run cleanly via the shell loop). All other migrations used `IF NOT EXISTS` and applied correctly through the shell loop.

```bash
docker exec platform-pub-postgres-1 psql -U platformpub platformpub -c "
CREATE TABLE IF NOT EXISTS _migrations (
  id SERIAL PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO _migrations (filename) VALUES
  ('001_add_email_and_magic_links.sql'),
  ('002_draft_upsert_index.sql'),
  ('005_subscriptions.sql'),
  ('006_receipt_portability.sql'),
  ('007_subscription_nostr_event.sql'),
  ('008_deduplicate_articles.sql'),
  ('009_notifications.sql'),
  ('010_votes.sql')
ON CONFLICT DO NOTHING;"
```

Apply migrations 003 and 004 (now safe with `IF NOT EXISTS`):

```bash
docker exec -i platform-pub-postgres-1 psql -U platformpub platformpub < migrations/003_comments.sql
docker exec -i platform-pub-postgres-1 psql -U platformpub platformpub < migrations/004_media_uploads.sql
```

Record them:

```bash
docker exec platform-pub-postgres-1 psql -U platformpub platformpub -c "
INSERT INTO _migrations (filename) VALUES
  ('003_comments.sql'),
  ('004_media_uploads.sql')
ON CONFLICT DO NOTHING;"
```

---

**Case C — `_migrations` has 001–009 but not 010** (v3.5.0 bootstrap was applied; migrations 005–007 were marked as applied without running their SQL):

This was the state of the production server. The bootstrap marked 005–007 as applied, so `subscription_price_pence` and other columns added by those migrations were never written to the database.

Re-run migrations 005–007 (all use `IF NOT EXISTS` — safe to apply again) to fill in any missing columns, then record migration 010:

```bash
docker exec -i platform-pub-postgres-1 psql -U platformpub platformpub < migrations/005_subscriptions.sql
docker exec -i platform-pub-postgres-1 psql -U platformpub platformpub < migrations/006_receipt_portability.sql
docker exec -i platform-pub-postgres-1 psql -U platformpub platformpub < migrations/007_subscription_nostr_event.sql
```

The votes tables (`votes`, `vote_tallies`, `vote_charges`) are already present in `schema.sql`, so migration 010 does not need to be re-run — just record it:

```bash
docker exec platform-pub-postgres-1 psql -U platformpub platformpub -c "INSERT INTO _migrations (filename) VALUES ('010_votes.sql') ON CONFLICT DO NOTHING;"
```

---

**After whichever case above — restart the gateway (no rebuild needed):**

```bash
docker compose restart gateway
```

**Verify:**

```bash
# subscription_price_pence must be present
docker exec platform-pub-postgres-1 psql -U platformpub platformpub -c "\d accounts" | grep subscription_price_pence

# All 10 migrations recorded
docker exec platform-pub-postgres-1 psql -U platformpub platformpub -c "SELECT filename FROM _migrations ORDER BY id;"

# No more 500s on profile requests
docker logs platform-pub-gateway-1 --tail 20
```

---

### v3.5.1 — 22 March 2026

**Hotfix: notes tab on user profile pages failing to load**

The `GET /writers/:username/notes` endpoint added in v3.4.0 included `AND deleted_at IS NULL` in its SQL query. The `notes` table has no `deleted_at` column (unlike `comments` and `articles`), so PostgreSQL threw a column-not-found error on every request, returning a 500 for the notes fetch. The notes tab would silently show nothing.

**Fix:** removed the invalid `AND deleted_at IS NULL` clause from the notes query.

**Files changed:** `gateway/src/routes/writers.ts`

**No schema changes. Rebuild gateway only.**

---

### v3.5.0 — 22 March 2026

**Voting system — upvote/downvote articles, notes, and replies**

Every piece of content (Articles, Notes, Replies) now displays a ▲ score ▼ vote control. Votes are cumulative with exponential pricing: the first upvote is free, subsequent votes double in cost (10p, 20p, 40p, …). Downvotes start at 10p and also double. Charges debit the reader's existing reading tab (same pipeline as article reads). Upvote revenue flows to the content author via Stripe Connect; downvote revenue is retained as platform income.

**Schema — three new tables (`migrations/010_votes.sql`)**

- `votes` — immutable audit log; one row per vote action with `sequence_number`, `cost_pence`, `direction`, and tab linkage.
- `vote_tallies` — materialised `upvote_count / downvote_count / net_score` per content item; upserted atomically on every vote.
- `vote_charges` — billing records parallel to `read_events`; `recipient_id IS NULL` for downvotes (platform revenue), set to the author UUID for upvotes. Tracks state through the same `read_state` lifecycle: `provisional → accrued → platform_settled → writer_paid`.

**New backend endpoints (`gateway/src/routes/votes.ts`)**

| Endpoint | Purpose |
|----------|---------|
| `POST /api/v1/votes` | Cast a vote; resolves author, enforces self-vote ban, computes exponential price, debits tab, atomically inserts vote + charge + upserts tally |
| `GET /api/v1/votes/tally?eventIds=` | Batch tally fetch for up to 200 event IDs (public) |
| `GET /api/v1/votes/mine?eventIds=` | Batch per-user vote counts for up to 200 event IDs (auth) |
| `GET /api/v1/votes/price?eventId=&direction=` | Server-authoritative next-vote price |

**Price computation (`shared/src/lib/voting.ts`, `web/src/lib/voting.ts`)**

`voteCostPence(direction, sequenceNumber)` is shared between the gateway (server-side enforcement) and the frontend (modal preview). The frontend duplicates the helper since the shared package is not directly importable from Next.js.

**Frontend components**

- `VoteControls` (`web/src/components/ui/VoteControls.tsx`) — ▲ score ▼ inline control with hover tooltip showing upvote/downvote breakdown. Accepts optional `initialTally` and `initialMyVotes` props for batch-fetch optimisation; falls back to individual mount-fetch if not supplied. Vote arrows highlighted in accent/red when the user has voted in that direction.
- `VoteConfirmModal` (`web/src/components/ui/VoteConfirmModal.tsx`) — modal shown before every paid vote with ordinal sequence number ("3rd upvote"), cost in £/p, and cumulative total spend on this content.

**Feed batch fetching (`FeedView.tsx`)**

After loading feed items, two parallel requests fetch tallies and the user's vote counts for all visible event IDs. Results stored in `voteTallies` and `myVoteCounts` state maps and passed as props to each `ArticleCard` and `NoteCard`, avoiding per-card API calls.

**Reply thread batch fetching (`ReplySection.tsx`)**

After loading replies, the full event ID tree (top-level + nested) is flattened and vote data is batch-fetched. Vote counts are passed down to each `ReplyItem`.

**Billing pipeline integration**

- `settlement.ts` — `confirmSettlement` now also advances `vote_charges` from `accrued` to `platform_settled` when a tab settles.
- `payout.ts` — `runPayoutCycle` eligibility query unions `read_events` and `vote_charges` (upvotes only). `initiateWriterPayout` balance recheck, state advance to `writer_paid`, and failed-payout rollback all include `vote_charges`.
- `accrual.ts` — `convertProvisionalReads` now also converts provisional `vote_charges` to `accrued` and adds their total to the tab balance when a reader connects their card.

**Self-vote prevention**

Backend rejects votes where `voter_id === target_author_id` (400). Frontend disables and greys vote arrows on the user's own content using the same `isAuthor` / `isOwnContent` pattern as the delete button.

**Files changed:** `migrations/010_votes.sql` *(new)*, `shared/src/lib/voting.ts` *(new)*, `gateway/src/routes/votes.ts` *(new)*, `gateway/src/index.ts`, `web/src/lib/voting.ts` *(new)*, `web/src/components/ui/VoteControls.tsx` *(new)*, `web/src/components/ui/VoteConfirmModal.tsx` *(new)*, `web/src/lib/api.ts`, `web/src/components/feed/ArticleCard.tsx`, `web/src/components/feed/NoteCard.tsx`, `web/src/components/feed/FeedView.tsx`, `web/src/components/replies/ReplyItem.tsx`, `web/src/components/replies/ReplySection.tsx`, `payment-service/src/services/settlement.ts`, `payment-service/src/services/payout.ts`, `payment-service/src/services/accrual.ts`

**Schema change: run `010_votes.sql` before restarting. Rebuild gateway, payment, and web.**

---

### v3.4.0 — 22 March 2026

**Feed fix, profile page overhaul, follow/profile for all accounts, three new notification types**

**Feed — own content included; empty follow list no longer shows firehose**

Two bugs in `FeedView.tsx`:

1. The logged-in user's own pubkey was never added to the relay `authors` filter, so your own Notes and Articles were absent from your own feed. Fixed by pushing `user.pubkey` onto the `pks` array after fetching followed pubkeys.
2. When the follow list was empty, the relay filter was `{}` (no `authors` key), which returned content from all users. Fixed by always applying `{ authors: pks }` — when only your own pubkey is present you see only your own content.

The DB-deleted-articles fetch was also gated behind `pks.length > 0` and skipped when the list was empty. Since `pks` now always contains at least the user's own pubkey, this conditional has been removed.

**Profile page — error handling, anonymous visitor prompt, and activity feed**

`web/src/app/[username]/page.tsx`:

- **Error state:** non-404 errors in `loadProfile` previously fell into `console.error`, leaving `writer` null and the page rendering a blank template. Now an explicit `profileError` state is set, triggering a user-visible error message.
- **Subscription status fallback:** the `checkStatus` catch block was empty (`catch {}`), which left `subStatus` null and caused the Subscribe button to never appear. Fallback is now `{ subscribed: false }`.
- **"Log in to follow" prompt:** anonymous visitors now see a "Log in to follow" link in place of the hidden action buttons, rather than no indication that logging in would reveal them.
- **Notes and Replies in activity feed:** the profile page previously fetched and rendered only articles. It now fetches notes (`GET /writers/:username/notes`) and replies (`GET /writers/:username/replies`) alongside articles, merges them into a single time-sorted activity feed, and renders each type with a distinct card style (`DbNoteCard`, `DbReplyCard`).

**Profile and follow routes relaxed to all active accounts**

Previously `GET /writers/:username`, `GET /writers/:username/articles`, and `GET /writers/by-pubkey/:pubkey` all filtered by `is_writer = TRUE`. Any account without writer status 404'd — even if they actively post Notes and Replies. The `POST /follows/:writerId` route had the same restriction.

All four queries now filter only on `status = 'active'`. Writers remain writers; the change simply stops excluding readers and note-only accounts.

**New backend endpoints**

`gateway/src/routes/writers.ts`:

- `GET /writers/:username/notes` — queries `notes` table by `author_id`, returns id, nostrEventId, content, publishedAt. Limit up to 50.
- `GET /writers/:username/replies` — queries `comments` table by `author_id`, returns id, nostrEventId, content, publishedAt. Limit up to 50.

**Three new notification types**

| Type | Trigger | Location |
|------|---------|----------|
| `new_subscriber` | Someone subscribes or reactivates a subscription | `subscriptions.ts` after new subscription create and after reactivation |
| `new_quote` | Someone quotes your note or article | `notes.ts` after quote-note insert; resolves quoted content's author via `notes` then `articles` tables |
| `new_mention` | Someone @mentions your username in a note or reply | `notes.ts` and `replies.ts`; parses `/@([a-zA-Z0-9_]+)/g`, resolves to account IDs, excludes self |

All three are fire-and-forget (`.catch` logs a warning). No schema change required — the `notifications.type` column is `TEXT NOT NULL` with no check constraint.

Frontend (`web/src/app/notifications/page.tsx` and `NotificationBell.tsx`) updated to render all three new types. `Notification.type` in `api.ts` extended to the full union.

**TypeScript type fix**

`WriterProfile` in `web/src/lib/api.ts` was missing `subscriptionPricePence`, which the backend already returned. The profile page worked around this with a `(writer as any)` cast. The field is now properly typed.

**Files changed:** `gateway/src/routes/writers.ts`, `gateway/src/routes/follows.ts`, `gateway/src/routes/notes.ts`, `gateway/src/routes/replies.ts`, `gateway/src/routes/subscriptions.ts`, `web/src/components/feed/FeedView.tsx`, `web/src/app/[username]/page.tsx`, `web/src/app/notifications/page.tsx`, `web/src/components/ui/NotificationBell.tsx`, `web/src/lib/api.ts`

**No schema changes. Rebuild gateway and web.**

---

### v3.3.0 — 22 March 2026

**Profile settings page, nav reorder, clickable author names, about page copy**

**Profile settings page (`/profile`)**

New page for editing your own profile. Reached via a "Profile" link in the nav or by clicking your avatar/name at the bottom of the sidebar.

- **Avatar:** file-picker button uploads via the existing Blossom pipeline (`POST /api/v1/media/upload`). Supports JPEG, PNG, GIF, WebP. Current avatar is previewed; a Remove button clears it.
- **Display name:** free-text input, max 100 characters.
- **Bio:** textarea, max 500 characters, with live character count.
- **Username:** displayed read-only (cannot be changed).
- Saving calls `PATCH /api/v1/auth/profile` then re-hydrates the auth store via `fetchMe()` — the nav bar and any component reading `useAuth()` update immediately.

**New gateway route:** `PATCH /auth/profile` — accepts `{ displayName?, bio?, avatar?: string | null }`. Validates with Zod (displayName max 100, bio max 500, avatar a URL). Calls `updateProfile()` in `shared/src/auth/accounts.ts`. Returns `{ ok: true }`.

`GET /auth/me` now includes `bio` in its response. `MeResponse` and `AccountInfo` updated accordingly.

**Nav reorder and icon removal**

The left sidebar (desktop), mobile drawer, and mid-breakpoint inline bar have been updated:

- **Order:** Write → Profile → Notifications → Following → Followers → Dashboard → About → Search
- **Icons removed:** the magnifying glass search icon and the bell icon are gone. Both items are now plain text.
- **Notification count:** unread count appears as a number in crimson next to the word "Notifications" (e.g. `Notifications 3`) rather than as a badge on an icon.
- **Search:** clicking "Search" in the sidebar expands an inline text input (behaviour unchanged); the icon trigger is replaced with a text button.
- **Sidebar bottom:** user avatar and name now link to `/profile` (previously linked to `/:username`).

**Clickable author names in feed furniture**

Author names and avatars are now hyperlinks to the author's public profile page:

- **ArticleCard:** outer `<Link>` wrapper converted to a `<div onClick>` (using `useRouter`); author name rendered as an inner `<Link href="/:username">` with `stopPropagation` to prevent card-click conflict.
- **NoteCard:** avatar and display name both wrapped in `<Link href="/:username">`.
- **ReplyItem:** author name span replaced with `<Link href="/:username">` when `username` is available.
- **CommentItem:** same as ReplyItem.

**About page copy**

Replaced previous copy with new text. Two section headings added: "Built on open ground" and "You don't need to think about any of that", rendered as `<h2>` elements in the serif type scale.

**TypeScript fix — `shared/src/auth/session.ts`**

Added `import '@fastify/cookie'` to activate the package's module augmentation, which adds `setCookie()` to `FastifyReply` and `cookies` to `FastifyRequest`. Previously the compiler reported three errors against these properties because the augmentation was never loaded. The package was already a declared dependency and installed; only the import was missing.

**Files changed:** `gateway/src/routes/auth.ts`, `shared/src/auth/accounts.ts`, `shared/src/auth/session.ts`, `web/src/lib/api.ts`, `web/src/app/profile/page.tsx` *(new)*, `web/src/components/layout/Nav.tsx`, `web/src/components/ui/NotificationBell.tsx`, `web/src/components/feed/ArticleCard.tsx`, `web/src/components/feed/NoteCard.tsx`, `web/src/components/replies/ReplyItem.tsx`, `web/src/components/comments/CommentItem.tsx`, `web/src/app/about/page.tsx`

**No schema changes. Rebuild gateway and web.**

---

### v3.2.0 — 22 March 2026

**Notification centre**

Adds a `notifications` table and a bell icon to the left-hand nav showing new-follower and new-reply events in real time.

**Schema change:** migration `009_notifications.sql` — creates the `notifications` table:

```sql
notifications (
  id            UUID PRIMARY KEY,
  recipient_id  UUID REFERENCES accounts ON DELETE CASCADE,
  actor_id      UUID REFERENCES accounts ON DELETE SET NULL,
  type          TEXT,        -- 'new_follower' | 'new_reply'
  article_id    UUID REFERENCES articles ON DELETE CASCADE,
  comment_id    UUID REFERENCES comments ON DELETE CASCADE,
  read          BOOLEAN DEFAULT false,
  created_at    TIMESTAMPTZ DEFAULT now()
)
```

**New gateway routes:**
- `GET /api/v1/notifications` — returns the 50 most recent notifications for the session user, with actor display info, article title, comment excerpt (truncated to 200 chars), and `unreadCount`.
- `POST /api/v1/notifications/read-all` — marks all unread as read.

**Trigger points:**
- `POST /follows/:writerId` — inserts a `new_follower` notification for the followed writer (fire-and-forget).
- `POST /replies` — inserts a `new_reply` notification for the content author, skipped when replying to your own content (fire-and-forget).

**Frontend:**
- `NotificationBell` component in `web/src/components/ui/NotificationBell.tsx`: bell icon with a crimson unread-count badge; clicking opens a fixed-positioned dropdown panel (rendered via React portal to escape the nav's `overflow-y-auto`). Fetches on mount and refreshes on open; marks all as read when the panel is opened.
- Desktop sidebar (`lg+`): `NotificationBell` rendered between Followers and About.
- Mobile drawer (`< md`): "Notifications" link to `/notifications`.
- `/notifications` page (`web/src/app/notifications/page.tsx`): full-page notification list with the same actor/article/comment display, used on mobile.

**Files changed:** `migrations/009_notifications.sql`, `gateway/src/routes/notifications.ts`, `gateway/src/index.ts`, `gateway/src/routes/follows.ts`, `gateway/src/routes/replies.ts`, `web/src/lib/api.ts`, `web/src/components/ui/NotificationBell.tsx`, `web/src/components/layout/Nav.tsx`, `web/src/app/notifications/page.tsx`

**Schema change: migration 009 must be applied. Rebuild gateway and web.**

---

### v3.1.9 — 22 March 2026

**Note deletion fix, article deletion hardening, social component reskin, about page copy**

**Bug fix — deleted notes reappearing in feed**

`DELETE /notes/:nostrEventId` hard-deleted notes from the DB but never published a kind 5 deletion event to strfry. The feed's note filter (`!deletedIds.has(e.id)`) checks kind 5 events, so with no kind 5 in the relay `deletedIds` was always empty for that note. The note disappeared via the optimistic `handleNoteDeleted` callback, but reappeared on every subsequent `loadFeed()` call because strfry still had the kind 1 event.

Fixed by adding kind 5 publication to the note deletion handler, identical in structure to the existing article deletion handler. Notes are kind 1 (not replaceable) so the kind 5 carries only an `['e', nostrEventId]` tag — no `['a']` coordinate needed.

A comment in the old handler claimed "the feed code already filters for [kind 5 deletion events]" — true, but only if a kind 5 exists. The comment has been updated.

**Hardening — article deletion no longer depends solely on relay publish**

Previously, if the gateway's kind 5 WebSocket publish to strfry failed (timeout, relay unavailable), the article remained in strfry and reappeared in strfry-based feeds. A frontend fallback publish existed but both could fail simultaneously (same root cause: relay unreachable).

Fix: `GET /api/v1/articles/deleted?pubkeys=<hex>,<hex>,...` — returns `{ deletedEventIds, deletedCoords }` for articles soft-deleted in the last 90 days for the given Nostr pubkeys. The `FeedView` now calls this in parallel with its strfry queries and seeds `deletedIds` / `deletedCoords` from both the DB response and any kind 5 events on the relay. The DB soft-delete is immediate and reliable, so feed filtering no longer depends on kind 5 delivery.

**Social component reskin — Notes, Replies, Composers**

Full visual redesign of the note and reply surface:
- **NoteCard**: white `rounded-xl` card with `border-surface-strong/50`; warm gradient fallback avatar (`#F5D5D6 → #E8A5A7`); note text promoted to `text-content-primary`; action buttons invisible at rest, fill on hover; reply panel stays inside card separated by a thin rule.
- **QuoteCard**: accent stripe + tinted fill (`bg-surface-sunken/60 border-l-[2.5px] border-accent`); outer border removed.
- **ReplyItem**: inline name+text layout; 20px avatars; timestamps shortened ("2h" not "2h ago", "now" not "just now"); threading border softened (`border-surface-strong/40`).
- **ReplyComposer**: pill input that expands to a bordered textarea on focus; dark pill Post button; SVG image icon; character count only near limit.
- **NoteComposer**: matches NoteCard card style; transparent textarea; dark pill Post button; SVG image icon; quote preview uses accent stripe, no outer border.
- **Tailwind**: `surface-sunken` and `surface-strong` converted to RGB alpha-value format (`rgb(... / <alpha-value>)`) to enable `/50` opacity modifiers.

**About page copy**

Replaced the three-section (Platform / What makes Platform different / You're free to leave) layout with a single flowing section. Updated copy describes the product, the tab billing model, the Nostr underpinnings, Platform's 8% fee, and account portability. Keyline divider removed.

**Files changed:** `gateway/src/routes/notes.ts`, `gateway/src/routes/articles.ts`, `web/src/components/feed/FeedView.tsx`, `web/src/components/feed/NoteCard.tsx`, `web/src/components/feed/QuoteCard.tsx`, `web/src/components/feed/NoteComposer.tsx`, `web/src/components/replies/ReplyItem.tsx`, `web/src/components/replies/ReplyComposer.tsx`, `web/tailwind.config.js`, `web/src/app/about/page.tsx`
**No schema changes. Rebuild gateway and web.**

---

### v3.1.8 — 22 March 2026

**Fix paywalled article publishing (key-service and web)**

Two bugs prevented vault encryption from working end-to-end:

1. **key-service — vault response missing ciphertext and algorithm:** `POST /articles/:id/vault` was not returning `ciphertext` and `algorithm` in its response. The frontend needs both to build the NIP-23 v2 event with a `['payload', ciphertext, algorithm]` tag. Without them the double-publish produced a v2 event with no payload tag and readers could not decrypt the article body.

2. **PaywallGateNode — missing Tiptap markdown serializer:** `PaywallGateNode` had no `toMarkdown` serializer registered with the `tiptap-markdown` extension. Without it the `<!-- paywall-gate -->` marker was never written into the markdown output, so `paywallContent` was always an empty string and the vault call was never reached.

**Files changed:** `key-service/src/routes/keys.ts`, `web/src/components/editor/PaywallGateNode.ts`
**No schema changes. Rebuild key-service and web.**

---

### v3.1.7 — 22 March 2026

**Broadsheet Confidence visual redesign (web only)**

Full visual overhaul to a warmer, more editorial aesthetic:

- **Navigation sidebar:** crimson → near-black (`ink-900`); active link indicated by a 3px crimson left-border accent instead of a crimson background fill.
- **Page background:** updated to a warmer papery tone (`#F5F0E8`).
- **Headline weight:** `font-light` → `font-medium` (500) across all pages; letter-spacing tightened to `-0.025em`.
- **Buttons:** sentence-case, 14px, visible border (previously uppercase, 13px, no border).
- **Tab pills:** sentence-case (previously uppercase).
- **Feed cards:** top-rule layout; left crimson accent reserved for paywalled articles only (previously on all article cards).
- **Article body:** crimson drop cap on the first letter of body text.
- **Ornament divider:** grey → crimson.
- **Rule accent:** 2px → 3px.
- **Blockquote border:** light red → full crimson.
- **PaywallGate unlock button:** `btn` → `btn-accent`.

Also introduces `DESIGN-BRIEF.md` (design system reference document, not committed to docs).

**Files changed:** `web/src/app/globals.css`, `web/src/app/page.tsx`, `web/src/app/about/page.tsx`, `web/src/app/auth/page.tsx`, `web/src/components/layout/Nav.tsx`, `web/src/components/feed/ArticleCard.tsx`, `web/src/components/article/ArticleReader.tsx`, `web/src/components/article/PaywallGate.tsx`, `web/tailwind.config.js`
**No schema changes. Rebuild web only.**

---

### v3.1.6 — 21 March 2026

**Feed and replies UX fixes (web only)**

**Feed — removed unimplemented "For You" tab**

The "For You" tab was a placeholder that showed an empty state. It has been removed. The feed now opens directly on the Following tab. The `FeedTab` type is narrowed to `'following' | 'add'`.

**Files changed:** `web/src/components/feed/FeedView.tsx`

**Replies — notes now expand all threaded replies**

Two bugs prevented notes from showing all their replies:

1. `ReplySection` in compact mode (used by `NoteCard`) was stripping all nested replies from every top-level reply before passing data to `ReplyItem` (`{ ...reply, replies: [] }`). Only the top-level reply text rendered; any threaded replies beneath it were silently discarded. Fixed by removing the stripping — `ReplyItem` now always receives the full reply tree.

2. The inline reply composer was only rendered after top-level replies. Clicking Reply on a depth-1 (nested) reply set `replyTarget` but the composer never appeared because the render check only ran in the top-level map. Fixed by introducing a `renderComposer` callback prop on `ReplyItem`; it is called after each nested reply so the composer appears in the correct position at any depth up to 2.

Replies now expand to show arbitrarily many threaded replies with up to two levels of indentation. The Reply button remains disabled at depth ≥ 2 to cap thread depth in the UI.

**Files changed:** `web/src/components/replies/ReplySection.tsx`, `web/src/components/replies/ReplyItem.tsx`
**No schema changes. Rebuild web only.**

---

### v3.1.5 — 21 March 2026

**Article deletion fix — deleted articles no longer reappear after feed refresh**

**Root cause:** `POST /articles` (the indexing endpoint called by the publishing pipeline) used `ON CONFLICT (nostr_event_id)`. Because every publish or edit produces a new Nostr event with a new ID, the conflict clause never fired: each edit inserted a new row instead of updating the existing one. For paywalled articles, both the v1 (free content) and v2 (encrypted payload) events were indexed as separate rows. Over time a single article accumulated one row per edit plus one extra row per paywalled publish cycle. `DELETE /articles/:id` only soft-deleted the one row the user clicked on (matched by UUID); older rows remained with `deleted_at IS NULL`, causing the article to reappear when the dashboard re-fetched.

The "can't delete again" error was a symptom of the same bug: the first delete did correctly set `deleted_at` on the clicked row (causing a 404 on retry), but sibling rows were untouched and continued to appear in `GET /my/articles`.

**Fix:**

- **Migration `008_deduplicate_articles.sql`:** soft-deletes all but the newest live row per `(writer_id, nostr_d_tag)`, then adds a partial unique index `idx_articles_unique_live` on `(writer_id, nostr_d_tag) WHERE deleted_at IS NULL`. The index is partial (not a full unique constraint) so multiple deleted rows with the same d-tag are allowed and a writer can re-publish a deleted article with the same slug.

- **`POST /articles` index endpoint:** `ON CONFLICT (nostr_event_id)` replaced with `ON CONFLICT (writer_id, nostr_d_tag) WHERE deleted_at IS NULL DO UPDATE SET ...`. The update clause now includes `nostr_event_id` (so edits update the event ID in place) and `slug`, but excludes `published_at` (original publish date is preserved across edits).

- **`DELETE /articles/:id`:** the final `UPDATE` now matches by `writer_id + nostr_d_tag` rather than `id`, so all live rows for the article are soft-deleted in a single statement regardless of how many accumulated before the migration ran.

**Files changed:** `gateway/src/routes/articles.ts`, `migrations/008_deduplicate_articles.sql`
**Schema change:** migration 008 must be applied. **Rebuild gateway only.**

---

### v3.1.4 — 21 March 2026

**Quote UX fixes and TypeScript clean-up (web only)**

**Bug fix — quote compose preview broken (× button floated over Post button)**

The "remove quote" button in `NoteComposer` was absolutely positioned (`absolute top-1 right-1`) inside a wrapper `div` that contained the `QuoteCard` component. `QuoteCard` fetches `/api/v1/content/resolve` to render the quoted content. When the API returned 404 — which happened whenever the quoted note was not present in the platform's `notes` DB table (e.g. a note published by an external Nostr client, or one whose DB indexing had silently failed) — `QuoteCard` returned `null`, collapsing the wrapper `div` to zero height. The absolutely-positioned `×` button then floated at the same vertical level as the right-aligned Post button, appearing to hover over it.

Fixed by removing `QuoteCard` from the composer entirely. `NoteCard.handleQuote()` and `ArticleCard.handleQuote()` now populate four new optional fields on `QuoteTarget` (`previewContent`, `previewAuthorName`, `previewTitle`) at the moment the user clicks Quote (all data is already in scope). `NoteComposer` renders an instant always-visible inline tile from these fields — no API call, no loading state, no possibility of collapse. The `×` button is placed inside the tile and is correctly constrained by its parent.

**Bug fix — quoted content not shown in published note**

`QuoteCard` (used in `NoteCard` to display embedded quotes) was API-only: if `/api/v1/content/resolve` returned anything other than 200 it rendered nothing. Same root cause as the compose bug. Fixed by adding a two-phase fetch: Phase 1 tries the platform API (returns rich author info, avatar, display name); Phase 2 falls back to fetching the event directly from the Nostr relay via NDK. Notes that are on the relay but not in the platform DB index now render with a truncated-pubkey author credit instead of being invisible.

**TypeScript — eliminated all three compiler errors in `web/`**

- `web/src/components/replies/ReplyComposer.tsx`: `handlePost()` lacked a `!user` guard. TypeScript does not carry the component-level `if (!user) return null` narrowing into a separately-defined async closure. Added `if (!canPost || !user) return` at the top of the function, matching the pattern used in `NoteComposer`.
- `web/src/lib/markdown.ts`: `getEmbed(...m)` spread a `RegExpMatchArray` (typed `string[]`) into functions with fixed positional parameters, which TypeScript rejects ("A spread argument must either have a tuple type or be passed to a rest parameter"). Fixed by re-typing `EMBED_PATTERNS` with `getEmbed: (m: RegExpMatchArray) => string` and passing the match array directly; each implementation now indexes `m[1]`, `m[2]` etc. instead of using named positional params.
- `web/src/lib/vault.ts`: `Uint8Array.prototype.buffer` is typed as `ArrayBufferLike` (a union that includes `SharedArrayBuffer`) but `base64ToArrayBuffer()` declared a return type of `ArrayBuffer`. Fixed by casting at the return site (`as ArrayBuffer`), which is safe because `Uint8Array` always allocates an `ArrayBuffer`, never a `SharedArrayBuffer`.

**Files changed:** `web/src/lib/publishNote.ts`, `web/src/components/feed/NoteCard.tsx`, `web/src/components/feed/ArticleCard.tsx`, `web/src/components/feed/NoteComposer.tsx`, `web/src/components/feed/QuoteCard.tsx`, `web/src/components/replies/ReplyComposer.tsx`, `web/src/lib/markdown.ts`, `web/src/lib/vault.ts`
**No schema changes. Rebuild web only.**

---

### v3.1.3 — 21 March 2026

**Auth fixes: Google OAuth, magic link emails, missing migration**

- **Bug fix (Google OAuth `google_failed`):** The OAuth state was verified by reading a `pp_oauth_state` cookie that was set inside a 302 redirect response — the same proxy-forwarding problem noted in v3.1.2, but for the state cookie rather than the session cookie. Next.js never forwarded the state cookie to the browser, so every exchange request had no cookie to compare against and returned 400. Fixed by replacing cookie-based state with an HMAC-signed state token (`nonce.timestamp.hmac-sha256` signed with `SESSION_SECRET`). The gateway generates and embeds the signed state in the redirect URL; Google echoes it back; the exchange endpoint verifies the HMAC directly — no cookie required. No frontend changes.

- **Bug fix (magic link emails not sending):** `gateway/.env` had `POSTMARK_SERVER_TOKEN` but the email service reads `process.env.POSTMARK_API_KEY`. The mismatch caused a silent throw (caught and logged, not surfaced to the caller), so the API returned 200 while sending nothing. Fixed by renaming the env var to `POSTMARK_API_KEY`.

- **Bug fix (migration 001 not applied):** The `accounts` table was missing the `email` column and the `magic_links` table entirely because `001_add_email_and_magic_links.sql` had never been run against the production database. Both Google OAuth (`SELECT id FROM accounts WHERE email = $1`) and magic link login were broken as a result. Fixed by applying the migration.

- **Bug fix (key-custody `generate` returning 400):** `gateway/src/lib/key-custody-client.ts` always sent `Content-Type: application/json` regardless of whether a body was present. When `generateKeypair()` is called with no body, Fastify rejected the request with `FST_ERR_CTP_EMPTY_JSON_BODY`. Fixed by only setting `Content-Type: application/json` when a body is actually being serialised.

**Files changed:** `gateway/src/routes/google-auth.ts`, `gateway/src/lib/key-custody-client.ts`
**Schema change:** `migrations/001_add_email_and_magic_links.sql` must be applied (adds `email` column to `accounts`, creates `magic_links` table).

---

### v3.1.2 — 21 March 2026

**Google OAuth login fix**

- **Bug fix (auth loop):** Google login redirected back to `/auth` in a loop because the session cookie was being set inside a 302 redirect response that passed through the Next.js rewrite proxy. Next.js does not reliably forward `Set-Cookie` headers from proxied redirect responses to the browser, so the cookie was never saved and every `/feed` load failed the auth check.

- **New flow:** The gateway's `GET /auth/google/callback` route has been replaced with `POST /auth/google/exchange`. Google now redirects to a Next.js page (`/auth/google/callback`) which POSTs the code and state to the exchange endpoint. The gateway validates the state cookie, exchanges the code with Google, creates or finds the account, and sets the session cookie in a normal JSON response — not a redirect. Next.js reliably forwards `Set-Cookie` from regular responses.

- **`gateway/.env.example`:** `APP_URL` now correctly defaults to `http://localhost:3010` (the frontend) and is documented as requiring the frontend URL, not the gateway URL. This affects OAuth redirect URIs, Stripe redirects, CORS origin, and magic link URLs.

- **Google Cloud Console:** The registered redirect URI must be updated from `/api/v1/auth/google/callback` to `/auth/google/callback`.

**No schema changes. Rebuild gateway and web.**

---

### v3.1.1 — 21 March 2026

**Build system fixes and key-custody activation**

**Infrastructure**

- `key-custody` added to `docker-compose.yml` — it was defined in all Dockerfiles and documented here but missing from compose, so the service never started in production. All Nostr signing operations (publish, delete, subscribe) were broken as a result.
- `gateway/.env`: `ACCOUNT_KEY_HEX` removed (moved to `key-custody/.env`); `KEY_CUSTODY_URL=http://key-custody:3004` and `INTERNAL_SECRET` added; `PLATFORM_RELAY_WS_URL` corrected from `ws://localhost:4848` to `ws://strfry:7777` (Docker service name).
- `payment-service/Dockerfile`, `key-service/Dockerfile`: `ln -s` → `ln -sf` so the symlink step is idempotent when the service directory already contains a `shared` symlink from the build context.
- `shared/` symlinks (`gateway/shared`, `payment-service/shared`, `key-service/shared`, `key-custody/shared`) committed to the repo as relative symlinks (`../shared`) so `npm run dev` works immediately after `git clone` without manual setup.

**TypeScript build**

- All service `tsconfig.json` files: `rootDir` changed from `"src"` to `"."` so files imported transitively from `shared/` (via the sibling symlink) are within the TypeScript root and compile without error.
- `*/package.json` `start` scripts updated from `dist/index.js` → `dist/src/index.js` to match the new output structure (only relevant to `node dist/…` production starts; Docker containers use `tsx` directly).
- `shared/src/lib/logger.ts`: pino v8 uses a CJS `export =` declaration; TypeScript NodeNext ESM treats the default import as a non-callable namespace — cast via `any` to call the factory.
- `gateway/src/routes/articles.ts`, `gateway/src/routes/media.ts`: `@types/node` v20 types `fetch().json()` as `Promise<unknown>` — cast results to `any`.
- `gateway/src/routes/articles.ts`: `signEvent` (key-custody HTTP client) returns a plain object; `publishToRelay` expects `nostr-tools` `VerifiedEvent` — cast at call site.
- `payment-service/src/routes/webhook.ts`: Stripe SDK v14 types do not include `transfer.paid` / `transfer.failed` in the event union despite them being valid webhook events — cast switch discriminant to `string`.

**No schema changes.**

---

### v3.1 — 21 March 2026

**Feed UX, navigation, quoting, and social graph pages**

**Quoting**

- Clicking Quote on any note or article now scrolls to the top NoteComposer and pre-fills it with the quote target, rather than opening an inline or modal sub-composer. The composer auto-focuses and shows the quoted content as a dismissible inset tile.
- `NoteComposer` now accepts `onClearQuote` and handles a reactive `quoteTarget` prop: when a new quote target arrives from the parent, the composer updates without losing any text already typed. A `×` button dismisses the quote while keeping the composed text.
- `QuoteCard` is fully clickable: article quotes link to `/article/:dTag`; note quotes link to the author's profile. Styled as a proper inset card with a hover state and a crimson left bar for articles.
- Inline quote sub-composer removed from `NoteCard`. Modal quote composer removed from `ArticleCard`. Both now call an `onQuote` callback up to `FeedView`, which manages the single pending-quote state.
- `FeedView` clears `pendingQuote` on publish.

**Feed layout**

- Feed tiles now have `space-y-3` vertical gaps and `px-6` horizontal padding, matching the NoteComposer tile width exactly.
- Replies expand within their note tile and are not separated from it.

**Note tile colour**

- Note tiles changed from dark slate (`bg-slate` / `#3D4A52`) to warm off-white (`bg-surface-sunken` / `#EDECEA`). All text is now dark-on-light. Avatar fallbacks, embed link backgrounds, and action button colours updated accordingly.

**Navigation**

- "Feed" removed from the sidebar nav and inline tablet nav — the Platform brand logo already navigates to `/feed`.
- Brand logo is now centre-aligned in the left sidebar (`lg:justify-center`).
- Search moved from the sidebar footer to the nav link list: renders as a magnifying-glass icon + "Search" label; clicking expands an inline input field. Collapses on blur if empty.
- **Following** and **Followers** added as nav links in the left sidebar, inline tablet nav, and mobile drawer.

**Social graph pages**

- New `GET /api/v1/follows/followers` endpoint returns accounts who follow the authenticated user: `{ followers: [{ id, username, displayName, avatar, pubkey, isWriter, followedAt }] }`. Does not filter by `is_writer` — all follower account types are returned.
- `/following` page: lists writers you follow with display name, username, avatar, and an Unfollow button per entry. Unfollow is applied immediately and reflected in local state.
- `/followers` page: lists people who follow you with display name, username, avatar, and a "writer" label for writer accounts.

**About page**

- About page rewritten with revised copy (three sections: intro, "What makes Platform different", "You're free to leave").

**No schema changes. Rebuild gateway and web.**

---

### v3.0.1 — 21 March 2026

**Security and correctness fixes**

- **Security (critical):** `payment-service` `/payout-cycle` and `/settlement-check/monthly` now reject requests when `INTERNAL_SERVICE_TOKEN` is unset. Previously, if the env var was absent, both the expected and actual token resolved to `undefined`, silently bypassing auth.
- **Security (critical):** `gateway` no longer falls back to a hardcoded HMAC key if `READER_HASH_KEY` is unset. The gate-pass handler now throws at runtime so the misconfiguration is visible immediately.
- **Documentation:** `INTERNAL_SERVICE_TOKEN` (payment-service cron auth secret) added to the env-var table and secret-generation commands — it was previously only in `payment-service/.env.example`. `READER_HASH_KEY` service attribution corrected (gateway, not payment-service).
- **Reliability:** Removed duplicate `publishToRelay` implementation from `gateway/src/routes/articles.ts`; the function is now imported from `gateway/src/lib/nostr-publisher.ts`.
- **Code quality:** Dynamic `await import('../db/client.js')` calls inside request handlers in `payment-service` replaced with a top-level import.
- **Validation:** UUID path-param regex in `payment-service` earnings routes tightened to full UUID4 format. `PATCH /articles/:id` now validates the article ID param and parses the body through Zod.
- **Logging:** `shared/src/db/client.ts` pool error now logged via pino (previously `console.error`).
- **Moderation:** `requireAdmin` no longer dynamically re-imports `requireAuth` on every call. Admin ID list computed once at module load; a startup warning is emitted if `ADMIN_ACCOUNT_IDS` is unset.

**No schema changes. Rebuild gateway and payment-service.**

---

### v3.0 — 21 March 2026

**Protocol specification alignment**

**1. Key custody separation**

- New `key-custody` service (port 3004): `key-custody/` directory. Holds `ACCOUNT_KEY_HEX` exclusively — the gateway can no longer decrypt user Nostr private keys.
- `gateway/src/lib/key-custody-client.ts`: gateway calls key-custody over HTTP for `generateKeypair`, `signEvent`, `unwrapNip44`. All calls carry `x-internal-secret`.
- `INTERNAL_SECRET` env var added to gateway and key-custody for service-to-service auth.

**2. Receipt portability**

- `migrations/006_receipt_portability.sql`: adds `reader_pubkey TEXT` and `receipt_token TEXT` to `read_events`.
- `payment-service/src/lib/nostr.ts`: `createPortableReceipt()` creates a private signed kind 9901 event with the actual reader pubkey (not HMAC hash). Stored in DB only — not published to relay.
- `payment-service/src/services/accrual.ts`: stores `reader_pubkey` and `receipt_token` on gate-pass.
- `gateway/src/routes/receipts.ts` (new): `GET /platform-pubkey` (public) and `GET /receipts/export` (auth) — reader exports their signed receipt tokens for use on another host.

**3. Subscription Nostr events**

- `migrations/007_subscription_nostr_event.sql`: adds `nostr_event_id TEXT` to `subscriptions`.
- `gateway/src/lib/nostr-publisher.ts` (new): `publishSubscriptionEvent()` signs and publishes kind 7003 events with the platform service key. Tags: `['p', writerPubkey]`, `['reader', readerPubkey]`, `['status', ...]`, `['amount', pence, 'GBP']`, `['period_start', ts]`, `['period_end', ts]`, `['subscription', id]`.
- `gateway/src/routes/subscriptions.ts`: fire-and-forget kind 7003 publish on create, reactivate, and cancel. Event ID stored in `subscriptions.nostr_event_id`.

**4. Author migration export**

- `key-service/src/routes/keys.ts`: new `GET /writers/export-keys` — decrypts each vault key with the KMS master key and re-wraps it with NIP-44 to the writer's own Nostr pubkey.
- `gateway/src/routes/export.ts` (new): `GET /account/export` — aggregates account info, all articles, NIP-44-wrapped content keys (from key-service), and per-article receipt whitelist (from `read_events.reader_pubkey`). Returns a versioned JSON bundle.

**5. Encrypted body in NIP-23 (double-publish pattern)**

- `web/src/lib/publish.ts`: paywalled articles use a double-publish: sign v1 (free content only) → index → encrypt paywalled body via key-service → sign v2 (adds `['payload', ciphertext, algorithm]` tag) → publish v2 (replaces v1 by d-tag, NIP-23 is replaceable) → re-index with v2 event ID.
- `key-service/src/services/vault.ts`: `publishArticle()` returns `{ ciphertext, algorithm, vaultKeyId }` directly. No separate kind 39701 vault event for new articles.
- `key-service/src/services/vault.ts`: `issueKey()` looks up vault key by `article_id` (stable FK), not `nostr_article_event_id` (which changes on re-publish). Eliminates VAULT_KEY_NOT_FOUND on edited articles.
- `web/src/lib/ndk.ts`: `ArticleEvent` gains `encryptedPayload` and `payloadAlgorithm` fields parsed from the `['payload', ...]` tag.
- `web/src/components/article/ArticleReader.tsx`: decrypts directly from `article.encryptedPayload` when present (new format); falls back to fetching kind 39701 vault event (old format).

**6. XChaCha20-Poly1305 encryption**

- `key-service/package.json` + `web/package.json`: added `@noble/ciphers ^1.0.0`.
- `key-service/src/lib/crypto.ts`: `encryptArticleBodyXChaCha` / `decryptArticleBodyXChaCha` using XChaCha20-Poly1305. Format: `base64(nonce[24] || ciphertext_with_tag)`. AES-256-GCM functions retained for backward compatibility.
- `key-service/src/types/index.ts`: `VaultEncryptResult` and `KeyResponse` gain `algorithm: 'xchacha20poly1305' | 'aes-256-gcm'`. `vault_keys.algorithm` column drives decryption path per article.
- `web/src/lib/vault.ts`: `decryptVaultContentXChaCha()` (noble/ciphers), `decryptVaultContentAesGcm()` (Web Crypto API), and dispatcher `decryptVaultContent(ciphertext, key, algorithm)`.

**Upgrading from v2.0:** See [From v2.0](#from-v20) above.

---

### v2.0 — 20 March 2026

**Quoting (NIP-18)**

- `GET /content/resolve?eventId=` resolves any event to a preview payload for quote cards.
- `POST /notes` accepts `isQuoteComment`, `quotedEventId`, `quotedEventKind`.
- `publishNote()` adds a `['q', eventId, '', authorPubkey]` tag (NIP-18) when a quote target is set.
- `QuoteCard.tsx` (new): renders quoted content inline in notes and articles.
- Selection-based quoting from article body: floating "Quote" button on text selection.

No schema changes. Rebuild gateway + web.

---

### v1.9 — 20 March 2026

**Replies (rename from Comments)**

- `gateway/src/routes/replies.ts` replaces `comments.ts`. DB table names unchanged. Old `/api/v1/comments/*` routes remain registered.
- Responsive navigation: three-zone layout (`< md` top bar + drawer, `md–lg` top bar + inline nav, `lg+` fixed left sidebar).
- Feed: sticky composer + tabs (For you / Following / Add).
- Editor: sticky title bar + toolbar.

No schema changes. Rebuild gateway + web.

---

### v1.8.x — 20 March 2026

- nginx dynamic DNS resolver (`127.0.0.11`) for zero-downtime rebuilds.
- `restart: unless-stopped` on all Docker services.
- LRB-inspired colour scheme (crimson `#9B1C20`, cool off-white `#F7F5F3`).
- Kind 5 deletion events on article delete and failed publish.
- All new accounts default to `is_writer = TRUE`.

---

### v1.7 and earlier
See git history.

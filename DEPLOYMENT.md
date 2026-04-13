# all.haus — Deployment Reference v5.29.0

**Date:** 13 April 2026
**Replaces:** v5.28.0 (see bottom for change log)

This is the single source of truth for deploying and operating all.haus.

---

## Architecture overview

```
Internet
  │
  ├─ :443 ─→ nginx (TLS termination)
  │            ├─ /api/*      → gateway:3000
  │            ├─ /ingest/*   → traffology-ingest:3005
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
                  ─→ traffology-ingest:3005
                  ─→ writes to /app/media/ (shared volume)
  payment:3001    ─→ postgres:5432, strfry:7777, Stripe API
  keyservice:3002 ─→ postgres:5432, strfry:7777
  key-custody:3004 → postgres:5432
  traffology-ingest:3005 → postgres:5432
  traffology-worker      → postgres:5432 (Graphile Worker, no port)
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
| traffology-ingest | ./traffology-ingest/Dockerfile | 3005 (Docker internal only) | Analytics beacon receiver, session tracking |
| traffology-worker | ./traffology-worker/Dockerfile | — (background) | Graphile Worker: hourly/daily/weekly aggregation, source resolution, interpretation |
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
| `INTERNAL_SERVICE_TOKEN` | gateway, payment-service | Shared secret authenticating gateway→payment-service and cron→payment-service calls (all internal endpoints: `/gate-pass`, `/card-connected`, `/payout-cycle`, `/settlement-check/monthly`) |
| `ACCOUNT_KEY_HEX` | key-custody **only** | AES-256 key for encrypting custodial Nostr privkeys at rest |
| `KMS_MASTER_KEY_HEX` | key-service | AES-256 master key for vault content key envelope encryption |
| `STRIPE_SECRET_KEY` | gateway, payment | Stripe API key (validated at startup — gateway will not boot without it) |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | web | Stripe publishable key (build fails if missing — no placeholder fallback) |
| `KEY_SERVICE_URL` | gateway | Internal URL for key-service (**required** — no localhost fallback) |
| `KEY_CUSTODY_URL` | gateway | Internal URL for key-custody (default: http://localhost:3004) |
| `PAYMENT_SERVICE_URL` | gateway | Internal URL for payment-service (**required** — no localhost fallback) |
| `PLATFORM_RELAY_WS_URL` | gateway, payment, key-service | strfry WebSocket URL (default: ws://localhost:4848) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | gateway | Google OAuth credentials |
| `APP_URL` | gateway | **Frontend** URL (Next.js). Used for OAuth redirect URIs, Stripe redirects, CORS, and magic links. Dev: `http://localhost:3010`. **Must not be the gateway URL.** |
| `ADMIN_ACCOUNT_IDS` | gateway | Comma-separated UUIDs for admin access (fallback; prefer `admin_account_ids` in `platform_config` table — no redeploy needed) |
| `EMAIL_PROVIDER` | gateway | `postmark`, `resend`, or `console` |
| `POSTMARK_BROADCAST_STREAM` | gateway | Postmark broadcast message stream ID (default: `broadcast`) |
| `EMAIL_FROM_BROADCAST` | gateway | From address for publish notification emails (default: `posts@all.haus`) |
| `BROADCAST_DAILY_SEND_LIMIT` | gateway | Daily send cap for broadcast warm-up; `0` = unlimited (default: `50`) |
| `TRAFFOLOGY_INGEST_URL` | gateway | Internal URL for traffology-ingest (default: http://localhost:3005) |
| `TRAFFOLOGY_IP_HASH_SALT` | traffology-ingest | Salt for SHA-256 IP hashing (must override default in production) |

> **Security:** `ACCOUNT_KEY_HEX` must never be set on the gateway — the key-custody service is the sole holder of this key by design. The gateway cannot decrypt user private keys.

> **Startup validation (v4.2.0, strengthened in v5.7.0):** All services validate required environment variables at startup and refuse to boot if any are missing. `SESSION_SECRET` must be at least 32 characters. `ACCOUNT_KEY_HEX` and `KMS_MASTER_KEY_HEX` must be at least 32 characters. `APP_URL` is now required (no localhost fallback in production). As of v5.7.0, `STRIPE_SECRET_KEY`, `READER_HASH_KEY`, `KEY_SERVICE_URL`, and `PAYMENT_SERVICE_URL` are also validated at gateway startup (previously these had silent fallbacks or warnings). If a service exits immediately on boot, check its logs for `Missing required environment variable:` messages.

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
openssl rand -base64 32  # INTERNAL_SERVICE_TOKEN (gateway + payment-service)
# For PLATFORM_SERVICE_PRIVKEY: generate a Nostr keypair — any hex ed25519 privkey
```

### 3. Start infrastructure

```bash
docker compose up -d postgres strfry
docker compose ps   # wait for postgres to be healthy
```

### 4. Apply schema and migrations

The base schema (`schema.sql`) is auto-applied on first postgres boot via the `initdb.d` volume mount. As of v5.13.0, `schema.sql` includes all structural changes through migration 038; the `_migrations` table is pre-seeded accordingly.

For **fresh** databases: no action needed — the schema and `_migrations` seed handle everything. As of v5.28.0, `schema.sql` includes all structural changes through migration 041.

For **existing** databases that were initialised with an earlier `schema.sql`, use the migration runner:

```bash
# From the host (with DATABASE_URL set):
DATABASE_URL=postgres://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
  npx tsx shared/src/db/migrate.ts

# Or via Docker:
docker compose exec gateway npx tsx /app/shared/src/db/migrate.ts
```

The runner reads `migrations/` in order, checks the `_migrations` table, and applies only pending files inside transactions.

Alternatively, apply migrations manually:

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

You should see 45+ tables.

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

### 8. Seed data (staging / development only)

The seed script (`scripts/seed.ts`) populates the database with realistic fake users, articles, follows, subscriptions, DMs, votes, pledge drives, and reading activity. **Do not run on production.**

```bash
# Default: 200 writers, 800 readers (~1000 users), dense relationships
ACCOUNT_KEY_HEX=<your key-custody ACCOUNT_KEY_HEX> \
DATABASE_URL=postgres://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
  npx tsx scripts/seed.ts --clean

# Small dataset: 15 writers, 25 readers (fast, for quick testing)
ACCOUNT_KEY_HEX=<...> npx tsx scripts/seed.ts --clean --small

# Custom sizes:
ACCOUNT_KEY_HEX=<...> npx tsx scripts/seed.ts --clean --writers 50 --readers 200 --articles 10
```

> **Required env vars:** `ACCOUNT_KEY_HEX` (from key-custody `.env`) is required to generate encrypted Nostr keypairs for seeded accounts. `KMS_MASTER_KEY_HEX` (from key-service `.env`) is required for vault key generation on paywalled articles. Without these, the seed script will create accounts without custodial keypairs and skip vault key generation respectively.

Options:
- `--clean` — wipe all seeded data before re-seeding (preserves the `billyisland` account)
- `--writers N` — number of writer accounts (default 200, or 15 with `--small`)
- `--readers N` — number of reader-only accounts (default 800, or 25 with `--small`)
- `--articles N` — max articles per writer (default 8, or 6 with `--small`)
- `--small` — use small defaults (equivalent to `--writers 15 --readers 25 --articles 6`)

The script generates: accounts, articles, notes, follows, subscriptions (monthly/annual/cancelled/comp), comments, reading tabs + read events, feed engagement, votes + tallies, DM conversations + messages, notifications, pledge drives + pledges, blocks, and mutes.

---

## Upgrading from a previous version

> **Important — how builds work:** The web (and all other) services run entirely inside Docker containers. Running `npm run build` or `npm run dev` locally on the host has **no effect on the live site** — those outputs go to a local `.next/` folder that the container never reads. All deployments must go through `docker compose build <service>` followed by `docker compose up -d <service>`.

### From v5.27.1

**Migration required (041).** Services changed: **gateway**, **payment-service**, **key-service**, **web**, **traffology-ingest** (new), **traffology-worker** (new). Deploy order: **migrate → rebuild all changed services**.

This release adds the Traffology analytics system (writer-facing traffic insights) and applies security hardening found during a full codebase audit.

**New services:**

- **traffology-ingest** (`traffology-ingest/Dockerfile`, port 3005): Receives page script beacons, tracks sessions, maintains live reader counts. Proxied by nginx at `/ingest/`.
- **traffology-worker** (`traffology-worker/Dockerfile`, background): Graphile Worker running hourly/daily/weekly aggregation, source resolution, and observation generation.

**Backend changes:**

- **Stripe idempotency keys** (`settlement.ts`, `payout.ts`): All Stripe mutating calls (`paymentIntents.create`, `transfers.create`) now include `idempotencyKey` to prevent duplicate charges on network retries.
- **Webhook event deduplication** (`webhook.ts`): `stripe_webhook_events` table prevents reprocessing of duplicate Stripe webhook events. Failed processing rolls back the dedup record so Stripe can retry.
- **oEmbed fetch timeout** (`media.ts`): Added 5-second `AbortSignal.timeout` to the oEmbed proxy fetch.
- **Key service pubkey validation** (`keys.ts`): `x-reader-pubkey` header now validated as 64-char hex string.

**Frontend changes:**

- **Traffology UI**: Feed view (`/traffology`), piece detail (`/traffology/piece/:pieceId`), overview (`/traffology/overview`).
- **Template HTML escaping** (`traffology-templates.ts`): All interpolated values (source names, country names, fallback data) now escaped via `escapeHtml()`.

**Schema:**

- **Migration 039**: Default article price config.
- **Migration 040**: Traffology analytics schema (13 tables in `traffology` schema + Graphile Worker queue).
- **Migration 041**: `stripe_webhook_events` dedup table; `ON DELETE CASCADE` on `subscription_events.subscription_id`.
- **schema.sql**: Synced with all migrations through 041. ON DELETE clauses from migrations 018/021/041 applied. `stripe_webhook_events` and migration tracking list updated.

**Modified files:**

- `payment-service/src/services/settlement.ts` — Stripe idempotency key
- `payment-service/src/services/payout.ts` — Stripe idempotency keys (2 calls)
- `payment-service/src/routes/webhook.ts` — event deduplication
- `gateway/src/routes/media.ts` — oEmbed timeout
- `gateway/src/routes/traffology.ts` — Traffology API routes
- `key-service/src/routes/keys.ts` — pubkey format validation
- `web/src/lib/traffology-templates.ts` — HTML escaping
- `web/src/lib/traffology-api.ts` — API client
- `web/src/app/traffology/` — all Traffology pages
- `web/src/components/traffology/` — FeedItem, ProvenanceBar, TraffologyMeta
- `web/public/traffology.js` — page tracking script
- `traffology-ingest/` — new service
- `traffology-worker/` — new service
- `migrations/039_default_article_price.sql` — new
- `migrations/040_traffology_schema.sql` — new
- `migrations/041_webhook_dedup_and_fk_fixes.sql` — new
- `schema.sql` — synced with migrations, dedup table added
- `nginx.conf` — `/ingest/` proxy block for traffology-ingest
- `docker-compose.yml` — traffology-ingest and traffology-worker services

**New env vars:**

| Variable | Service | Purpose |
|----------|---------|---------|
| `TRAFFOLOGY_INGEST_URL` | gateway | Internal URL for traffology-ingest (default: http://localhost:3005) |
| `TRAFFOLOGY_IP_HASH_SALT` | traffology-ingest | Salt for IP hashing (**must override in production**) |

**Upgrade steps:**
```bash
cd /root/platform-pub
git pull origin master

# Apply migrations (039, 040, 041)
DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@127.0.0.1:5432/platformpub \
  npx tsx shared/src/db/migrate.ts

# Add Traffology env vars
echo 'TRAFFOLOGY_IP_HASH_SALT=<generate with: openssl rand -hex 32>' >> traffology-ingest/.env
# gateway/.env already has TRAFFOLOGY_INGEST_URL defaulting to http://localhost:3005
# (use http://traffology-ingest:3005 in Docker)

# Build and deploy
docker compose build gateway payment web key-service traffology-ingest traffology-worker
docker compose up -d
```

Verify:
```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
# All services should show (healthy) after ~30s
# traffology-ingest and traffology-worker should be running

# Traffology check:
# - Open an article page: network tab should show POST to /ingest/beacon
# - /traffology: observation feed should load (empty until aggregation runs)
# - Wait for :05 past the hour: aggregation populates piece_stats

# Webhook deduplication check:
# - Stripe test webhook: should process once, second delivery returns 200 (skipped)

# oEmbed check:
# - Paste a YouTube URL in the editor: embed should resolve within 5 seconds
```

---

### From v5.25.0

No migration. Services changed: **gateway**. Deploy order: **rebuild gateway**.

This release fixes profile image uploads (and all media uploads) failing for files over ~1MB. The Fastify default body size limit (1MB) was rejecting multipart payloads before the `@fastify/multipart` plugin could process them, despite the plugin being configured for 12MB.

**Backend (gateway):**

- **Media upload body limit fix** (`media.ts`): Added explicit `bodyLimit: 12 * 1024 * 1024` on the `POST /media/upload` route to match the `@fastify/multipart` file size limit. Previously, Fastify's default 1MB body parser limit silently rejected uploads before the multipart handler ran.

**Modified files:**

- `gateway/src/routes/media.ts` — bodyLimit added to upload route

**Upgrade steps:**
```bash
cd /root/platform-pub
git pull origin master

# No migration — backend fix only
docker compose build gateway
docker compose up -d gateway
```

Verify:
```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
# gateway should show (healthy) after ~30s

# Upload test:
# - /profile → Upload photo (use a >1MB image) → should succeed
```

No new env vars. No database changes.

---

### From v5.24.0

No migration. Services changed: **gateway**, **web**. Deploy order: **rebuild gateway + web**.

This release adds paywall gating on article comments, fixes DM scroll-to-bottom on conversation open, fixes the data export download, removes the redundant "Export my data" button from the nav, and adds a publication creation flow to the dashboard.

**Backend (gateway):**

- **Paywall-gated comments** (`replies.ts`): `GET /replies/:targetEventId` now checks whether the target article is paywalled. If it is and the requesting user has not unlocked it (via ownership, purchase, or subscription), the endpoint returns `{ comments: [], totalCount: 0, paywallLocked: true }` — comment data never leaves the server for locked articles. Uses the existing `checkArticleAccess()` service.

**Frontend (web):**

- **Paywall-gated comments** (`ReplySection.tsx`, `ArticleReader.tsx`, `api.ts`): `ReplySection` accepts a new `isUnlocked` prop and handles the `paywallLocked` API response. When locked, displays "Unlock the article to read and leave replies." instead of the comment thread. Re-fetches comments automatically when the article is unlocked. `ReplyResponse` type extended with optional `paywallLocked` field.
- **DM scroll-to-bottom fix** (`MessageThread.tsx`): Conversations now scroll to the most recent message on open. Previously, the auto-scroll effect only fired when the user was already near the bottom (within 150px), which never applied on initial load when scroll position is 0. Added an `initialScrollDone` ref — first load jumps instantly to the bottom; subsequent new messages still use the near-bottom guard. The ref resets when switching conversations.
- **Export download fix** (`ExportModal.tsx`): The dynamically created `<a>` element is now appended to `document.body` before calling `.click()` and removed afterwards. Without DOM attachment, some browsers silently ignore programmatic download clicks.
- **Nav export button removed** (`Nav.tsx`): Removed "Export my data" button from both the desktop avatar dropdown and the mobile navigation sheet. Export remains accessible from the Profile settings page. Cleaned up unused `ExportModal` import and `showExport` state.
- **Publication creation UI** (`dashboard/page.tsx`): Added a "+ New publication" button to the dashboard context switcher. Clicking it reveals an inline form with name and auto-generated URL slug fields. On creation, the dashboard switches to the new publication's context. The button is always visible so users without existing publications can discover it.

**Modified files:**

- `gateway/src/routes/replies.ts` — paywall access check on comment fetch
- `web/src/components/replies/ReplySection.tsx` — `isUnlocked` prop, `paywallLocked` handling
- `web/src/components/article/ArticleReader.tsx` — passes `isUnlocked` to ReplySection
- `web/src/lib/api.ts` — `paywallLocked` field on ReplyResponse
- `web/src/components/messages/MessageThread.tsx` — initial scroll-to-bottom fix
- `web/src/components/ExportModal.tsx` — DOM-attached download anchor
- `web/src/components/layout/Nav.tsx` — export button removed from desktop + mobile nav
- `web/src/app/dashboard/page.tsx` — publication creation form

**Upgrade steps:**
```bash
cd /root/platform-pub
git pull origin master

# No migration — no schema changes
docker compose build gateway web
docker compose up -d gateway web
```

Verify:
```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
# gateway and web should show (healthy) after ~30s

# Paywall comment gating:
# - Open a paywalled article (logged out or without access): comments section shows lock message
# - Unlock the article: comments appear immediately

# DM scroll:
# - Open /messages, select a conversation with history: should scroll to latest message

# Export:
# - /profile → Data → Export → "Portable receipts" button triggers a JSON download

# Publication creation:
# - /dashboard → click "+ New publication" → fill name → Create
# - Dashboard switches to the new publication context
```

No new env vars. No database changes.

---

### From v5.22.0

No migration. Services changed: **web**. Deploy order: **rebuild web**.

This release fixes a build-breaking type error in the `FeaturedWriters` homepage component. The v5.22.0 audit removed the unused `feed.featured()` API client method, but `FeaturedWriters.tsx` still called it, preventing the Next.js production build from compiling.

**Frontend (web):**

- **FeaturedWriters fix** (`FeaturedWriters.tsx`): Replaced `feedApi.featured()` (removed in v5.22.0) with `feedApi.get('explore', undefined, 3)`. Response field updated from `data.articles` to `data.items` to match the feed endpoint's actual response shape.

**Modified files:**

- `web/src/components/home/FeaturedWriters.tsx` — API call and response field fixed

**Upgrade steps:**
```bash
cd /root/platform-pub
git pull origin master

# No migration — frontend fix only
docker compose build web
docker compose up -d web
```

Verify:
```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
# web should show (healthy) after ~30s

# Visual checks:
# - / (homepage, logged out): featured writers section loads with 3 articles
```

No new env vars. No database changes.

---

### From v5.21.0

No migration. Services changed: **gateway**, **web**. Deploy order: **rebuild gateway + web**.

This release fixes critical bugs found during audit: gate-pass access for publication members/subscribers, schema ON DELETE clause sync, publication article deletion on the relay, and dead code removal. Editor title/subtitle sizing is also refined.

**Backend (gateway):**

- **Gate-pass publication access fix (critical):** `publication_id` now passed to `checkArticleAccess()` — publication members and subscribers were previously charged for their own publication's paywalled articles.
- **Publication article kind 5 deletion:** `DELETE /publications/:id/articles/:articleId` now publishes a Nostr kind 5 deletion event to the relay.
- **Publication PATCH updated_at:** `PATCH /publications/:id` now sets `updated_at = now()`.
- **Dead code removal:** Deleted dead comment system (route, 3 components, lib file). Removed legacy `/feed/global` and `/feed/following` endpoints. Removed unused `feed.global()`, `feed.following()`, `feed.featured()` API client wrappers.

**Schema:**

- **schema.sql ON DELETE clauses:** Synced with migration 021 — added missing cascade/restrict/set-null clauses on FK constraints.

**Frontend (web):**

- **Editor sizing:** Title and subtitle card padding and font sizes reduced to match surrounding controls.

**Modified files:**

- `gateway/src/routes/articles.ts` — gate-pass publication_id lookup
- `gateway/src/services/access.ts` — receives publication_id parameter
- `gateway/src/routes/publications.ts` — kind 5 deletion, updated_at on PATCH
- `gateway/src/routes/notes.ts` — dead feed endpoints removed
- `schema.sql` — ON DELETE clauses synced
- `web/src/lib/api.ts` — dead feed methods removed
- `web/src/components/editor/ArticleEditor.tsx` — title/subtitle sizing

**Upgrade steps:**
```bash
cd /root/platform-pub
git pull origin master

# No migration — but schema.sql updated for fresh installs
docker compose build gateway web
docker compose up -d gateway web
```

Verify:
```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
# gateway and web should show (healthy) after ~30s

# Critical check — publication members can read paywalled articles without being charged:
# - Log in as a publication member, read a paywalled publication article
# - /account: no new debit entry for that read
```

No new env vars. No database changes.

---

### From v5.20.0

No new migration. Services changed: **gateway**, **web**. Deploy order: **rebuild gateway + web**.

This release fixes a Fastify duplicate-route crash that prevented the gateway from starting. The public published-articles endpoint (`GET /publications/:slug/articles`) collided with the CMS article-list endpoint (`GET /publications/:id/articles`) because Fastify treats path parameters at the same position as identical regardless of name. The public route is now at `/publications/by-slug/:slug/articles`.

**Backend (gateway):**

- **Route path change** (`publications.ts`): `GET /publications/:slug/articles` → `GET /publications/by-slug/:slug/articles`. Resolves `FST_ERR_DUPLICATED_ROUTE` crash on startup.

**Frontend (web):**

- **API client** (`api.ts`): `getPublicArticles()` updated to call `/publications/by-slug/${slug}/articles`.
- **Publication homepage** (`pub/[slug]/page.tsx`): SSR fetch updated to new route path.
- **Publication archive** (`pub/[slug]/archive/page.tsx`): SSR fetch updated to new route path.

**Modified files:**

- `gateway/src/routes/publications.ts` — public articles route path changed
- `web/src/lib/api.ts` — `getPublicArticles` path updated
- `web/src/app/pub/[slug]/page.tsx` — SSR fetch path updated
- `web/src/app/pub/[slug]/archive/page.tsx` — SSR fetch path updated

**Upgrade steps:**
```bash
cd /root/platform-pub
git pull origin master

# No migration — route path fix only
docker compose build gateway web
docker compose up -d gateway web
```

Verify:
```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
# gateway and web should show (healthy) after ~30s

# Critical check — gateway must not be crash-looping:
docker compose logs gateway --tail=5
# Should show "Server listening" — not FST_ERR_DUPLICATED_ROUTE

# Visual checks:
# - /pub/<slug>: publication homepage loads with articles
# - /pub/<slug>/archive: archive page loads with full article list
```

No new env vars. No database changes.

> **Older versions:** Upgrade instructions for v5.20.0 and earlier are available in this file's git history.

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
| 020_notification_routing_columns.sql | Notification routing columns |
| 021_missing_on_delete_clauses.sql | Missing ON DELETE clauses for FKs |
| 022_composite_index_read_events.sql | Composite index on read_events |
| 023_subscription_auto_renew.sql | `auto_renew` boolean on subscriptions |
| 024_annual_subscriptions.sql | `subscription_period` column on subscriptions |
| 025_comp_subscriptions.sql | `is_comp` boolean on subscriptions |
| 026_article_profile_pins.sql | `pinned_on_profile` and `profile_pin_order` on articles |
| 027_subscription_visibility.sql | `hidden` boolean on subscriptions |
| 028_subscription_nudge.sql | `subscription_nudge_log` table |
| 029_gift_links.sql | `gift_links` table |
| 030_commissions_expansion.sql | Pledge drive expansion columns |
| 031_fix_media_urls_domain.sql | Media URL domain migration |
| 032_dm_likes.sql | `dm_likes` table for DM reactions; marks stale `new_message` notifications as read |
| 033_admin_account_ids_config.sql | Admin account IDs in platform_config |
| 034_dm_replies.sql | `reply_to_id` column on `direct_messages` for threaded DM replies |
| 035_feed_scores.sql | `feed_scores` table + config rows for feed scoring weights |
| 036_commission_conversation.sql | `parent_conversation_id` on `pledge_drives` for DM-linked commissions |
| 037_subscription_offers.sql | `subscription_offers` table; `offer_id` + `offer_periods_remaining` on `subscriptions` |
| 038_publications.sql | Publications schema: 7 new tables, 2 enums, publication columns on articles/drafts/subscriptions/feed_scores |
| 039_default_article_price.sql | Default article price config |
| 040_traffology_schema.sql | Traffology analytics: 13 tables in `traffology` schema (pieces, sessions, sources, piece_stats, source_stats, half_day_buckets, writer_baselines, publication_baselines, topic_performance, observations) + Graphile Worker queue |
| 041_webhook_dedup_and_fk_fixes.sql | `stripe_webhook_events` dedup table; `ON DELETE CASCADE` on `subscription_events.subscription_id` FK |

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
| POST | /api/v1/articles/:id/pin | session | Toggle article pin on writer's profile |
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
| GET | /api/v1/my/blocks | session | List blocked accounts with display info |
| POST | /api/v1/my/blocks/:userId | session | Block a user |
| DELETE | /api/v1/my/blocks/:userId | session | Unblock a user |
| GET | /api/v1/my/mutes | session | List muted accounts with display info |
| POST | /api/v1/my/mutes/:userId | session | Mute a user |
| DELETE | /api/v1/my/mutes/:userId | session | Unmute a user |

### Notifications
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | /api/v1/notifications | session | List recent notifications (max 50). Excludes `new_message` type (DMs have separate unread tracking). Types: `new_follower`, `new_reply`, `new_subscriber`, `new_quote`, `new_mention` |
| POST | /api/v1/notifications/read-all | session | Mark all notifications as read |
| GET | /api/v1/unread-counts | session | Lightweight badge counts: `{ notificationCount, dmCount }`. Notification count excludes DM notifications |
| POST | /api/v1/notifications/:id/read | session | Mark a single notification as read |

### Messages (DMs)
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | /api/v1/conversations | session | Create a new DM conversation |
| POST | /api/v1/conversations/:id/members | session | Add members to a conversation |
| GET | /api/v1/messages | session | List conversations (inbox) with unread counts |
| GET | /api/v1/messages/:conversationId | session | Load messages in a conversation (newest-first, paginated). Includes `likeCount` and `likedByMe` per message |
| POST | /api/v1/messages/:conversationId | session | Send a DM (NIP-44 E2E encrypted). Rate limited: 10/min |
| POST | /api/v1/messages/:messageId/read | session | Mark a message as read |
| POST | /api/v1/messages/:messageId/like | session | Toggle like on a message (heart reaction) |
| POST | /api/v1/dm/decrypt-batch | session | Batch-decrypt messages client-side via key-custody |

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
| POST | /api/v1/subscriptions/:writerId | session | Subscribe (charges immediately). Optional body: `{ period?, offerCode? }` |
| DELETE | /api/v1/subscriptions/:writerId | session | Cancel |
| GET | /api/v1/subscriptions/mine | session | List my subscriptions |
| GET | /api/v1/subscriptions/check/:writerId | session | Check subscription status |
| GET | /api/v1/subscribers | session | List my subscribers (writer) |
| PATCH | /api/v1/subscriptions/:writerId/visibility | session | Toggle subscription visibility on public profile |
| PATCH | /api/v1/settings/subscription-price | session | Set subscription price |

### Subscription Offers
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | /api/v1/subscription-offers | session | Create offer (code or grant mode). Body: `{ label, mode, discountPct, durationMonths?, maxRedemptions?, expiresAt?, recipientUsername? }` |
| GET | /api/v1/subscription-offers | session | List writer's offers (active + revoked) |
| DELETE | /api/v1/subscription-offers/:offerId | session | Revoke an offer |
| GET | /api/v1/subscription-offers/redeem/:code | optional | Public lookup — offer details + calculated discounted price for redeem page |

### Publications
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | /api/v1/publications | session | Create publication (generates Nostr keypair) |
| GET | /api/v1/publications/:slug | session | Get publication by slug |
| PATCH | /api/v1/publications/:id | session (owner/settings) | Update publication metadata |
| DELETE | /api/v1/publications/:id | session (owner) | Archive publication |
| GET | /api/v1/publications/:id/members | session (member) | List members |
| POST | /api/v1/publications/:id/members/invite | session (manage_members) | Invite member |
| POST | /api/v1/publications/:id/members/accept | session | Accept invite |
| PATCH | /api/v1/publications/:id/members/:memberId | session (manage_members) | Update member role/permissions |
| DELETE | /api/v1/publications/:id/members/:memberId | session (manage_members) | Remove member |
| POST | /api/v1/publications/:id/transfer-ownership | session (owner) | Transfer ownership |
| GET | /api/v1/publications/invites/:token | optional | Invite details |
| GET | /api/v1/my/publications | session | My publication memberships |
| POST | /api/v1/publications/:id/articles | session (member) | Submit article to publication CMS |
| GET | /api/v1/publications/:id/articles | session (member) | List CMS articles (filterable by status) |
| PATCH | /api/v1/publications/:id/articles/:articleId | session (edit_others) | Edit article metadata |
| DELETE | /api/v1/publications/:id/articles/:articleId | session (edit_others) | Delete article |
| POST | /api/v1/publications/:id/articles/:articleId/publish | session (can_publish) | Approve and publish article |
| POST | /api/v1/publications/:id/articles/:articleId/unpublish | session (can_publish) | Unpublish article |
| GET | /api/v1/publications/:slug/public | optional | Public publication profile |
| GET | /api/v1/publications/by-slug/:slug/articles | optional | Published articles (paginated) |
| GET | /api/v1/publications/:slug/masthead | optional | Public member list |
| POST | /api/v1/subscriptions/publication/:id | session | Subscribe to publication |
| DELETE | /api/v1/subscriptions/publication/:id | session | Cancel publication subscription |
| POST | /api/v1/follows/publication/:id | session | Follow publication |
| DELETE | /api/v1/follows/publication/:id | session | Unfollow publication |
| GET | /api/v1/publications/:id/rate-card | session (manage_finances) | View publication pricing |
| PATCH | /api/v1/publications/:id/rate-card | session (manage_finances) | Update subscription/article pricing |
| GET | /api/v1/publications/:id/payroll | session (manage_finances) | View standing shares and per-article overrides |
| PATCH | /api/v1/publications/:id/payroll | session (manage_finances) | Update standing revenue shares |
| PATCH | /api/v1/publications/:id/payroll/article/:articleId | session (manage_finances) | Set per-article share override |
| GET | /api/v1/publications/:id/earnings | session (manage_finances) | Revenue dashboard (totals, per-article, payouts) |
| GET | /api/v1/pub/:slug/rss | — | Publication RSS feed |

### Traffology (writer analytics)
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | /api/v1/traffology/feed | session | Paginated observation feed (cursor-based, max 50/page) |
| GET | /api/v1/traffology/piece/:pieceId | session | Piece detail: stats, source breakdown, half-day buckets, observations |
| GET | /api/v1/traffology/overview | session | Writer baseline, all pieces with provenance, topic performance |
| GET | /api/v1/traffology/concurrent/:pieceId | session | Live reader count for a single piece (proxied from traffology-ingest) |
| GET | /api/v1/traffology/concurrent | session | Aggregated live reader counts across all writer's pieces |
| POST | /ingest/beacon | — | Page script beacon (init/heartbeat/unload). Rate limited: 120/min/IP. Proxied by nginx to traffology-ingest |

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
| GET | /api/v1/writers/:username/replies | optional | User's published replies (includes article author info) |
| GET | /api/v1/writers/:username/followers | optional | Public paginated follower list |
| GET | /api/v1/writers/:username/following | optional | Public paginated following list |
| GET | /api/v1/writers/:username/subscriptions | optional | Public subscription list (non-hidden only) |
| GET | /api/v1/search?q=&type= | optional | Search articles, writers, and publications |
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
| 30023 | Long-form article | User or Publication (via key-custody) | NIP-23 article with optional `['payload', ciphertext, algorithm]` tag for paywalled content. Publication articles are signed with the publication's keypair (signerType='publication') and include author/publisher p-tags |
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

The `key-custody` service (port 3004) is the sole holder of all user and publication Nostr private keys. It holds `ACCOUNT_KEY_HEX` — the AES-256 key used to encrypt private keys at rest in `accounts.nostr_privkey_enc` and `publications.nostr_privkey_enc`. **No other service has access to this key.**

The gateway calls key-custody for these operations:
- `POST /keypairs/generate` — generate and store a new Nostr keypair for a new user
- `POST /keypairs/sign` — sign a Nostr event with a user's or publication's private key
- `POST /keypairs/unwrap-nip44` — NIP-44 decrypt (for reading encrypted DMs, key deliveries)
- `POST /keypairs/nip44-encrypt` — NIP-44 encrypt
- `POST /keypairs/nip44-decrypt` — NIP-44 decrypt

All signing and encryption endpoints accept `signerId` + `signerType` (`'account'` | `'publication'`). When `signerType` is `'publication'`, the private key is looked up from the `publications` table. Backwards-compatible: `accountId` still accepted.

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
2. Publication member (if article belongs to a publication) → free
3. Permanent unlock (`article_unlocks`) → free, key reissued
4. Active subscription (writer or publication) → free, creates permanent unlock + subscription_read log
5. Payment flow → charges reading tab, creates permanent unlock

---

## Media uploads

Images uploaded via `POST /api/v1/media/upload` are resized (max 1200px), converted to WebP (quality 80), and written to the `media_data` volume at `/app/media/<sha256>.webp`. Nginx serves them at `/media/<sha256>.webp` with 1-year cache headers. Maximum upload size is 12MB (enforced by both Fastify `bodyLimit` and `@fastify/multipart` file size limit).

---

## Frontend pages

| Path | Purpose |
|------|---------|
| / | Landing (redirects to /feed if logged in) |
| /feed | Sticky composer + Following / Add tabs |
| /profile | Identity (name, bio, avatar, username, pubkey), payment card, Stripe Connect, data export |
| /account | Balance, transaction ledger (paid/all reads toggle), subscriptions, pledges |
| /following | Writers you follow, with unfollow action |
| /followers | Accounts who follow you |
| /notifications | Recent notifications (new followers, replies, subscribers, quotes, mentions) — excludes DM notifications. Full-page view used on mobile |
| /messages | Two-panel DM inbox: conversation list + message thread. Chronological order (newest at bottom). Like reactions on messages |
| /write | Article editor with paywall gate marker |
| /article/:dTag | Article reader with paywall unlock (SSR, ISR 60s) |
| /:username | Writer profile (SSR, ISR 60s) |
| /auth | Signup / login |
| /auth/google/callback | Google OAuth callback (handles Google redirect, exchanges code, sets session) |
| /auth/verify | Magic link verification |
| /dashboard | Articles, drafts, pledge drives, offers, pricing |
| /social | Feed reach dial, blocked accounts, muted accounts, DM fees |
| /settings | Redirects to /profile |
| /history | Redirects to /account?filter=all |
| /pub/:slug | Publication homepage (blog/magazine/minimal layout) |
| /pub/:slug/about | Publication about/mission page |
| /pub/:slug/masthead | Publication team listing |
| /pub/:slug/subscribe | Publication subscription CTA |
| /pub/:slug/archive | Publication full article archive |
| /pub/:slug/:articleSlug | Article under publication branding |
| /invite/:token | Publication invite acceptance page |
| /search | Article, writer, and publication search |
| /traffology | Traffology feed: observation stream, live reader banner |
| /traffology/piece/:pieceId | Piece detail: summary strip, provenance bars, source breakdown |
| /traffology/overview | Writer overview: baseline stats, sortable piece grid, topic performance |
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

## Known limitations (v4.8.0)

- RSS feed ingestion not yet built
- NIP-07 browser extension support not yet built
- Cash-out-at-will (writer-initiated payout) not yet implemented
- Stripe payment collection not yet live — free allowance goes negative as a testing workaround
- Email sending requires configuring `EMAIL_PROVIDER` — defaults to console logging
- Broadcast stream warm-up: new Postmark broadcast streams start rate-limited; raise `BROADCAST_DAILY_SEND_LIMIT` gradually over 2-4 weeks
- Publish email audience is paid subscribers only (Phase 2 adds followers)
- Docker healthchecks on some Alpine containers report "unhealthy" due to missing `wget`/`curl` in the image, despite services running correctly

---

## Change log

### v5.29.0 — 13 April 2026

**Email-on-publish v2 (Phase 1)**

Migration required (044). Services changed: gateway, web. New env vars: `POSTMARK_BROADCAST_STREAM`, `EMAIL_FROM_BROADCAST`, `BROADCAST_DAILY_SEND_LIMIT`.

**Postmark setup:** Before deploying, create a broadcast message stream named `broadcast` in the Postmark server dashboard and verify sender signature for `posts@all.haus` (or use domain-level DKIM). The broadcast stream manages List-Unsubscribe headers and bounce/complaint suppression automatically.

- **Broadcast stream:** Publish notification emails now use Postmark's broadcast message stream (separate IP reputation from transactional emails). Configurable via `POSTMARK_BROADCAST_STREAM` env var.
- **Writer email control:** Publish button is now two-step — confirmation panel with "Email subscribers" checkbox (checked by default). Writers opt out per article. Edits never re-send.
- **Improved email template:** Publish emails now include writer avatar, article title, summary/excerpt (~150 words), "Read on all.haus" CTA button, and branded footer.
- **Signed unsubscribe:** Email footer contains HMAC-signed unsubscribe link (`GET /api/v1/email/unsubscribe`). Readers unsubscribe without logging in. Endpoint is rate-limited (10 req/min per IP).
- **Daily send cap:** `BROADCAST_DAILY_SEND_LIMIT` (default 50) caps broadcast emails per day for stream warm-up. Set to `0` once Postmark stream is warm (typically 2-4 weeks). Skipped recipients are not retried.
- **email_sent_at tracking:** Articles table tracks when publish email was sent; prevents duplicate sends on edits.

---

### v5.28.0 — 12 April 2026

**Traffology analytics + security audit hardening**

Migration required (039, 040, 041). Services changed: gateway, payment-service, key-service, web, traffology-ingest (new), traffology-worker (new).

- **Traffology Phase 1:** Complete writer analytics system — page tracking script, ingest service, hourly/daily/weekly aggregation, source resolution (170+ known domains, shortener following), observation generation (first-day summary, anomalies, milestones, source breakdown), feed UI, piece detail with provenance bars, overview with baseline stats and topic performance.
- **Stripe idempotency keys:** `paymentIntents.create` and `transfers.create` calls now include idempotency keys to prevent duplicate charges on network retries.
- **Webhook deduplication:** `stripe_webhook_events` table prevents reprocessing of Stripe events delivered more than once. Failed handler rolls back dedup record for retry.
- **oEmbed timeout:** External oEmbed fetch now has 5-second timeout (was unbounded).
- **Key service pubkey validation:** `x-reader-pubkey` validated as 64-char hex (defence in depth).
- **Template HTML escaping:** All Traffology template values now pass through `escapeHtml()`.
- **FK fix:** `subscription_events.subscription_id` gets `ON DELETE CASCADE` (missed by migration 021).
- **schema.sql synced:** All ON DELETE clauses from migrations 018/021/041, dedup table, migration tracking updated through 041.

---

### v5.27.1 — 8 April 2026

**Fix: notification/DM badge reliability — missed messages, mobile indicator, stale counts**

No migration. Services changed: web.

- **Polling interval reduced:** Unread-count polling interval reduced from 60s to 15s (`AuthProvider.tsx`). The 60-second window meant new DMs and notifications could go unnoticed for up to a minute.
- **Mobile hamburger badge:** The mobile hamburger menu icon now displays the combined unread count badge (matching the desktop PFP avatar badge). Previously mobile users had no visual indicator until they opened the menu.
- **Mark-read race condition:** All `refreshUnread()` calls in `MessageThread.tsx`, `NotificationBell.tsx`, and `notifications/page.tsx` now `await` the preceding `markRead`/`markAllRead` call. Previously the badge count query could race the write and return a stale (still-unread) count.
- **Rebrand cleanup:** RSS feed titles/descriptions, export modal copy, and docs updated from "Platform" / "platform.pub" to "all.haus".

---

### v5.26.0 — 7 April 2026

**Fix: media upload body limit — profile images and large uploads failing**

No migration. Services changed: gateway.

- **Media upload body limit:** `POST /media/upload` route now sets `bodyLimit: 12 * 1024 * 1024` to match the `@fastify/multipart` file size limit. Fastify's default 1MB body parser limit was silently rejecting multipart payloads for any image over ~1MB before the multipart plugin could process them. This affected profile photo uploads and all image uploads from the editor.

---

### v5.25.0 — 7 April 2026

**Paywall-gated comments, DM scroll, export download, publication creation UI**

No migration. Services changed: gateway, web.

- **Paywall-gated comments:** `GET /replies/:targetEventId` checks article paywall access; locked articles return empty comments with `paywallLocked: true`. Frontend shows lock message and re-fetches on unlock.
- **DM scroll-to-bottom fix:** Conversations scroll to latest message on open via `initialScrollDone` ref.
- **Export download fix:** Download anchor appended to DOM before click.
- **Nav export button removed:** Export accessible only from Profile settings page.
- **Publication creation UI:** "+ New publication" button in dashboard context switcher with inline creation form.

---

### v5.24.0 — 7 April 2026

**CI pipeline, backend ESLint, pre-push hook**

No migration. Services changed: gateway, payment-service, key-service, key-custody, web.

- **CI pipeline:** GitHub Actions workflow for linting, type-checking, and tests across all services.
- **Backend ESLint:** ESLint configured for all backend services with shared config.
- **Pre-push hook:** Runs lint and type-check before push.

---

### v5.23.0 — 7 April 2026

**Fix: FeaturedWriters build error — removed API method still referenced**

No migration. Services changed: web.

- **FeaturedWriters build fix:** `FeaturedWriters.tsx` called `feedApi.featured()` which was removed in v5.22.0's dead code cleanup, breaking the Next.js production build. Replaced with `feedApi.get('explore', undefined, 3)` and updated response field from `data.articles` to `data.items`.

---

### v5.22.0 — 7 April 2026

**Audit fixes: critical bugs, dead code removal, editor polish**

No new migration. Services changed: gateway, web. Schema updated: `schema.sql`.

- **Gate-pass publication access fix (critical):** The gate-pass handler now SELECTs `publication_id` from the article and passes it to `checkArticleAccess()`. Previously publication members and subscribers were incorrectly charged for reading their own publication's paywalled articles.
- **schema.sql ON DELETE clauses:** Synced `schema.sql` with migration 021 — added missing `ON DELETE CASCADE`, `ON DELETE RESTRICT`, and `ON DELETE SET NULL` clauses to FK constraints on `subscriptions`, `subscription_events`, `article_unlocks`, `vote_charges`, `pledges`, `conversations`, and `publication_payouts`. Fresh database instances from `schema.sql` now match migrated databases.
- **Publication article kind 5 deletion:** `DELETE /publications/:id/articles/:articleId` now publishes a Nostr kind 5 deletion event to the relay (matching the personal article delete behaviour). Previously deleted publication articles lingered on the relay.
- **Publication PATCH updated_at:** `PATCH /publications/:id` now sets `updated_at = now()`.
- **Dead code removal:** Deleted dead comment system (gateway route, 3 frontend components, lib file — never registered or imported). Removed legacy `/feed/global` and `/feed/following` endpoints from `notes.ts` (broken column name, no block/mute filtering, duplicated by `feed.ts`). Removed unused `feed.global()`, `feed.following()`, `feed.featured()` API client wrappers.
- **Editor title/subtitle sizing:** Reduced title card padding from `p-8 sm:p-10` to `px-5 py-4` and title font from `text-4xl sm:text-5xl` to `text-2xl sm:text-3xl`. Subtitle card padding similarly reduced. Fields now match the proportions of surrounding controls.

---

### v5.21.0 — 7 April 2026

**Fix: gateway crash — duplicate route collision on publication articles**

No migration. Services changed: gateway, web.

- **Route collision fix:** `GET /publications/:slug/articles` (public) and `GET /publications/:id/articles` (CMS) registered identical Fastify route patterns, causing `FST_ERR_DUPLICATED_ROUTE` and a gateway crash loop. Public route moved to `GET /publications/by-slug/:slug/articles`. Frontend callers (`api.ts`, `pub/[slug]/page.tsx`, `pub/[slug]/archive/page.tsx`) updated.

> **Older versions:** Changelog entries for v5.21.0 and earlier are available in this file's git history.

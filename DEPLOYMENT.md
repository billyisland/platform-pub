# platform.pub — Deployment Reference v1.8.2

**Date:** 20 March 2026
**Replaces:** v1.8.1 (see bottom for change log)

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
                  ─→ writes to /app/media/ (shared volume)
  payment:3001    ─→ postgres:5432, strfry:7777, Stripe API
  keyservice:3002 ─→ postgres:5432, strfry:7777
```

### Services

| Service | Image / Build | Port | Purpose |
|---------|--------------|------|---------|
| postgres | postgres:16-alpine | 5432 (localhost only) | Shared database |
| strfry | dockurr/strfry:latest | 4848→7777 | Nostr relay |
| gateway | ./gateway/Dockerfile | 3000 (localhost only) | API gateway, auth, media upload |
| payment | ./payment-service/Dockerfile | 3001 (localhost only) | Stripe, settlement, payouts |
| keyservice | ./key-service/Dockerfile | 3002 (localhost only) | Custodial keys, vault encryption |
| web | ./web/Dockerfile | 3010→3000 | Next.js frontend |
| nginx | nginx:alpine | 80, 443 | Reverse proxy, TLS, static media |
| blossom | ghcr.io/hzrd149/blossom-server:master | 3003 (localhost only) | Future Nostr media federation |
| certbot | certbot/certbot | — | TLS certificate renewal |

### Docker volumes

| Volume | Mounted by | Purpose |
|--------|-----------|---------|
| pgdata | postgres | Database storage |
| strfry_data | strfry | Relay event database (LMDB) |
| media_data | gateway (rw), nginx (ro) | Uploaded images (WebP, content-addressed) |
| blossom_data | blossom | Blossom blob storage (not in active upload path) |
| certbot_data | nginx, certbot | ACME challenge files |
| certbot_certs | nginx, certbot | TLS certificates |

---

## Prerequisites

- Ubuntu 22.04+ or Debian 12+ server
- Docker Engine 24+ with Docker Compose v2
- Domain `platform.pub` pointing to the server's IP
- TLS certificate (via certbot, provisioned separately)
- `.env` file in `/root/platform-pub/` containing at minimum:
  ```
  POSTGRES_PASSWORD=<strong random password>
  ```

### Required environment files

Each service has a `.env.example` showing required variables. Copy and fill:

```bash
cp gateway/.env.example gateway/.env
cp payment-service/.env.example payment-service/.env
cp key-service/.env.example key-service/.env
cp web/.env.example web/.env
```

Key variables:
- `COOKIE_SECRET` / `SESSION_SECRET` — gateway session signing
- `STRIPE_SECRET_KEY` — gateway + payment service
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` — web client
- `PLATFORM_SERVICE_PRIVKEY` — 64-char hex Nostr private key for the platform service keypair
- `READER_HASH_KEY` — HMAC key for reader privacy hashing
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — Google OAuth
- `ADMIN_ACCOUNT_IDS` — comma-separated UUIDs for admin access

---

## Fresh deployment

### 1. Upload files

```bash
scp platform-pub-v1_7.zip root@your-server:/root/
cd /root
unzip -o platform-pub-v1_7.zip -d platform-pub
cd /root/platform-pub
```

### 2. Create environment files

```bash
# Generate a strong Postgres password
export POSTGRES_PASSWORD=$(openssl rand -base64 24)
echo "POSTGRES_PASSWORD=$POSTGRES_PASSWORD" > .env

# Copy and edit service env files
cp gateway/.env.example gateway/.env
cp payment-service/.env.example payment-service/.env
cp key-service/.env.example key-service/.env
cp web/.env.example web/.env
# Edit each one with your actual keys
```

### 3. Start infrastructure

```bash
docker compose up -d postgres strfry
# Wait for postgres to be healthy
docker compose ps
```

### 4. Run the schema

The schema is auto-applied on first boot via the `initdb.d` volume mount.
Verify:

```bash
docker exec platform-pub-postgres-1 psql -U platformpub platformpub -c "\dt"
```

You should see 18+ tables.

### 5. Run migrations

```bash
for f in migrations/*.sql; do
  echo "Applying $f..."
  docker exec -i platform-pub-postgres-1 psql -U platformpub platformpub < "$f"
done
```

### 6. Build and start all services

```bash
docker compose build
docker compose up -d
```

### 7. Provision TLS

```bash
docker compose run --rm certbot certonly \
  --webroot --webroot-path=/var/www/certbot \
  -d platform.pub --agree-tos -m you@example.com

docker compose restart nginx
```

### 8. Server hardening (production)

```bash
bash scripts/harden-server.sh
```

This configures UFW (ports 22, 80, 443 only), SSH key-only auth, and certbot auto-renewal.

---

## Upgrading from a previous version

### From v1.6 or earlier

```bash
cd /root/platform-pub

# Back up
cp -r . ../platform-pub-backup-$(date +%Y%m%d)

# Extract new files
unzip -o /root/platform-pub-v1_7.zip -d /root/platform-pub

# Run new migration
docker exec -i platform-pub-postgres-1 psql -U platformpub platformpub \
  < migrations/005_subscriptions.sql

# Rebuild and restart
docker compose build --no-cache gateway web
docker compose up -d
docker compose restart nginx
```

### Verifying the upgrade

```bash
# Check all services are running
docker compose ps

# Check gateway started cleanly
docker logs platform-pub-gateway-1 --tail 5

# Check the new tables exist
docker exec platform-pub-postgres-1 psql -U platformpub platformpub -c \
  "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;" | grep -E "subscription|article_unlock"
```

---

## Database

### Schema

`schema.sql` is the from-scratch path — applied automatically on first postgres boot. It creates all tables, indexes, enums, and extensions.

### Migrations

`migrations/` contains incremental changes for upgrading existing deployments:

| Migration | Purpose |
|-----------|---------|
| 001_add_email_and_magic_links.sql | Email column on accounts, magic_links table |
| 002_draft_upsert_index.sql | Partial unique index for draft upserts |
| 003_comments.sql | Comments table, comments_enabled on articles/notes, deleted_at on articles |
| 004_media_uploads.sql | Media uploads table with SHA-256 deduplication |
| 005_subscriptions.sql | Subscriptions, subscription_events, article_unlocks, subscription pricing |

Run all pending migrations:
```bash
npx tsx shared/src/db/migrate.ts
```
Or manually:
```bash
docker exec -i platform-pub-postgres-1 psql -U platformpub platformpub < migrations/NNN_name.sql
```

### Backup

```bash
docker exec platform-pub-postgres-1 pg_dump -U platformpub platformpub | gzip > backup-$(date +%Y%m%d).sql.gz
```

---

## Media uploads

Images are uploaded through the gateway (`POST /api/v1/media/upload`), processed with Sharp (resize to 1200px wide, convert to WebP quality 80, auto-rotate from EXIF), and written to the `media_data` Docker volume at `/app/media/<sha256>.webp`.

Nginx serves them statically at `https://platform.pub/media/<sha256>.webp` with 1-year cache headers.

Blossom is included in docker-compose for future Nostr media federation (BUD-02) but is not currently in the upload path.

### Checking uploads

```bash
# List uploaded files
docker exec platform-pub-gateway-1 ls /app/media/

# Check DB records
docker exec platform-pub-postgres-1 psql -U platformpub platformpub -c \
  "SELECT sha256, mime_type, size_bytes FROM media_uploads ORDER BY created_at DESC LIMIT 10;"
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
| GET | /api/v1/auth/me | session | Current user info |
| GET | /api/v1/auth/google | — | Google OAuth redirect |
| GET | /api/v1/auth/google/callback | — | Google OAuth callback |
| POST | /api/v1/auth/upgrade-writer | session | Start Stripe Connect |
| POST | /api/v1/auth/connect-card | session | Save reader payment method |

### Content
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | /api/v1/articles | session | Index published article |
| GET | /api/v1/articles/:dTag | optional | Article metadata by d-tag |
| POST | /api/v1/articles/:eventId/gate-pass | session | Paywall gate pass (checks subscription/unlock first) |
| DELETE | /api/v1/articles/:id | session | Delete article |
| POST | /api/v1/notes | session | Index published note |
| DELETE | /api/v1/notes/:nostrEventId | session | Delete note (author only) |
| POST | /api/v1/drafts | session | Save/upsert draft |
| GET | /api/v1/drafts | session | List drafts |
| POST | /api/v1/media/upload | session | Upload image |

### Social
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | /api/v1/follows/:writerId | session | Follow writer |
| DELETE | /api/v1/follows/:writerId | session | Unfollow writer |
| GET | /api/v1/follows/pubkeys | session | Followed pubkeys (for feed) |
| GET | /api/v1/comments/:targetEventId | optional | Get comments |
| POST | /api/v1/comments | session | Post comment |
| POST | /api/v1/reports | session | Submit content report |

### Subscriptions
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | /api/v1/subscriptions/:writerId | session | Subscribe (charges immediately) |
| DELETE | /api/v1/subscriptions/:writerId | session | Cancel (access until period end) |
| GET | /api/v1/subscriptions/mine | session | List my subscriptions |
| GET | /api/v1/subscriptions/check/:writerId | session | Check subscription status |
| GET | /api/v1/subscribers | session | List my subscribers (writer view) |
| PATCH | /api/v1/settings/subscription-price | session | Set subscription price |

### Public
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | /api/v1/writers/:username | optional | Writer profile |
| GET | /api/v1/writers/:username/articles | optional | Writer's articles |
| GET | /api/v1/search?q=&type= | optional | Search articles + writers |
| GET | /rss | — | Platform-wide RSS |
| GET | /rss/:username | — | Writer RSS |

---

## Frontend pages

| Path | Component | Purpose |
|------|-----------|---------|
| / | page.tsx | Landing page (redirects to /feed if logged in via nav) |
| /feed | FeedView.tsx | Mixed article + note feed from followed writers |
| /write | WritePage → ArticleEditor | Article editor with inline paywall marker |
| /article/:dTag | ArticlePage → ArticleReader | Article view with hero image, paywall gate |
| /:username | WriterProfilePage | Writer profile, follow + subscribe buttons |
| /auth | AuthPage | Signup / login (email + Google OAuth) |
| /auth/verify | VerifyPage | Magic link verification |
| /dashboard | DashboardPage | Articles, drafts, credits (conditional), debits |
| /settings | SettingsPage | Payment method, Stripe Connect, account info |
| /search | SearchPage | Parallel article + writer search |
| /about | AboutPage | How Platform works |

---

## Design system

### Colour palette

| Token | Hex | Usage |
|-------|-----|-------|
| surface | #F7F5F3 | Page background (cool off-white) |
| surface-raised | #FFFFFF | Article body, cards, inputs |
| surface-sunken | #EDECEA | Hover states, dividers |
| surface-strong | #D4D1CC | Borders, separators |
| ink-900 | #111111 | Primary text, logo border |
| content-primary | #1A1A1A | Body text |
| content-secondary | #4A4845 | Supporting text |
| content-muted | #7A7774 | Labels, meta |
| content-faint | #9E9B97 | Timestamps, tertiary |
| crimson | #9B1C20 | Nav bar, accent buttons |
| crimson-dark | #7A1519 | Nav borders, hover states |
| crimson-light | #B52226 | Hover/rule accents |
| slate | #3D4A52 | Note tiles in feed |
| slate-dark | #2E383F | Note tile borders |
| accent | #9B1C20 | Links, active states (= crimson) |
| accent-50..900 | Crimson ramp | Highlights, rule-accent |

Text on crimson/slate backgrounds uses white:
- Primary: `text-white` / `text-surface-raised` (#FFFFFF)
- Secondary: `text-surface` (#F7F5F3)
- Muted: `text-surface-sunken` (#EDECEA)

### Typography

| Family | Usage |
|--------|-------|
| Newsreader (serif) | Headlines, article body, nav links |
| Instrument Sans | UI text, labels, buttons |
| IBM Plex Mono | Code, timestamps, ornaments |

### Key CSS classes

| Class | Purpose |
|-------|---------|
| .btn | Primary button (ink-900 bg, cream text) |
| .btn-accent | Accent button (terracotta) |
| .btn-soft | Soft button (surface-raised bg) |
| .tab-pill / .tab-pill-active / .tab-pill-inactive | Tab navigation |
| .label-ui | Uppercase small label |
| .rule / .rule-accent | Horizontal dividers (rule-accent = terracotta) |
| .ornament | Centered dot ornament (· · ·) |

---

## Subscription system

### How it works

1. Writers set a monthly subscription price (default £5, configurable £1–£100)
2. Readers subscribe from the writer's profile page — charged immediately
3. While subscribed, all that writer's paywalled content is unlocked at zero cost
4. Subscription reads are logged in `subscription_events` for engagement tracking
5. Content unlocked via subscription is permanently unlocked (survives cancellation)
6. Cancellation gives access until the end of the current paid period
7. Writers see subscribers with "Good value" / "At risk" flags based on engagement

### Access check priority (gate-pass handler)

1. Own content → always free
2. Permanent unlock (article_unlocks table) → free, key reissued
3. Active subscription → free, creates permanent unlock + subscription_read event
4. Payment flow → charges to reader's tab, creates permanent unlock

### Netting

Credits (article reads + subscription income) and debits (own reading + own subscriptions) are netted. Monthly payouts transfer the net balance when it clears the threshold, minus 8% platform fee on credits.

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
docker compose restart nginx  # if gateway IP changed
```

> **Note:** After rebuilding any backend service, nginx may need a reload to re-resolve the new container IP:
> ```bash
> docker compose exec nginx nginx -s reload
> ```
> This is only necessary if you see 502 errors after a rebuild. The nginx config uses Docker's internal DNS resolver (`127.0.0.11`) with a 10-second TTL, so in normal operation it heals automatically.

### View logs
```bash
docker logs platform-pub-gateway-1 --tail 50 -f
docker logs platform-pub-web-1 --tail 50 -f
```

### Check relay events
```bash
# From browser console:
const ws = new WebSocket('wss://platform.pub/relay');
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

## Known limitations (v1.8)

- Subscription renewal is not yet automated (requires a cron job or scheduled worker to charge at period end)
- "For You" feed tab returns empty (requires engagement data + ranking algorithm)
- Nostr keypair self-custody handover UI is not yet built
- Cash-out-at-will (writer-initiated payout with fee absorption) is not yet implemented
- Stripe webhook handler exists but live/test key switch is manual
- Email sending requires configuring `EMAIL_PROVIDER` (postmark/resend) — defaults to console logging
- Search uses pg_trgm (good for launch, consider MeiliSearch post-launch for better relevance)
- Stripe payment collection not yet live — free allowance silently goes negative as a testing workaround

---

## Change log

### v1.8.2 — 20 March 2026

**Bug fixes**

- `gateway/src/routes/articles.ts`: Changed `gatePositionPct` Zod validation from `min(1)` to `min(0)`. Non-paywalled articles send `gatePositionPct: 0` (unused by the DB, which stores `NULL` for non-paywalled rows), so `min(1)` was incorrectly rejecting every non-paywalled publish with a 400 error.
- `gateway/src/routes/articles.ts`: The vault proxy routes (`POST` and `PATCH /articles/:nostrEventId/vault`) now inject `x-writer-id` from the authenticated session before forwarding to the key service. Previously the key service received no `x-writer-id` header and rejected every paywalled publish with 401 "Missing x-writer-id".
- `web/src/lib/publish.ts`: If the DB index step (step 3 of the publish pipeline) throws after the relay event has already been published (step 2), a kind 5 deletion event is now immediately published to retract the relay event. Previously a failed index left the article on the relay as a dead link — visible in the feed but 404 on click.
- `web/src/app/dashboard/page.tsx`: After a successful `DELETE /articles/:id` API call, the frontend now also publishes a kind 5 deletion event directly via NDK. This gives the relay a second, reliable path to receive the deletion and prevents deleted articles from reappearing in feeds when the gateway's own relay publish failed (non-fatal path).
- `web/src/components/feed/FeedView.tsx`: Fixed a TypeScript type signature bug on the `isArticleDeleted` helper: the parameter type was `{ id, tags }` which omitted `pubkey`, causing the `a`-tag deletion check (`30023:${e.pubkey}:${dTag}`) to silently use `undefined` at runtime and miss coordinate-based deletions.

**Upgrading from v1.8.1**

No schema changes. Rebuild and restart `gateway` and `web`:

```bash
cd /root/platform-pub
docker compose build --no-cache gateway web
docker compose up -d gateway web
```

---

### v1.8.1 — 20 March 2026

**Bug fixes**
- `web/src/app/article/[dTag]/page.tsx`: `article.id` is now always set to `meta.nostrEventId` (the gateway DB value) when merging relay and metadata. Prevents "Comment indexing failed: 404" when the relay holds a newer event ID than the one indexed in the DB.
- `gateway/src/routes/articles.ts`: Tightened `gatePositionPct` Zod validation to `min(1).max(99)`, matching the DB check constraint `gate_position_pct >= 1 AND gate_position_pct <= 99`. Previously `max(100)` allowed the DB insert to fail with a 500.
- `web/src/components/editor/ArticleEditor.tsx`: Clamped computed `gatePositionPct` to `[1, 99]` to prevent sending 0 or 100 when the gate marker is placed at the very beginning or end of an article.

**Design**
- Full colour scheme overhaul to a literary, LRB-inspired palette. Replaced warm salmon/terracotta tones with cool off-white backgrounds (`#F7F5F3`) and deep crimson (`#9B1C20`) as the sole accent. Tailwind token `terracotta` renamed to `crimson`.
- Note tiles in the feed use dark slate (`#3D4A52`) rather than crimson to reduce visual weight on the feed page.

---

### v1.8 — 20 March 2026

**Infrastructure**
- `nginx.conf`: Added `resolver 127.0.0.11 valid=10s ipv6=off` and variable-based `proxy_pass` for all upstreams — nginx now re-resolves Docker container IPs dynamically rather than caching at startup. Eliminates 502 Bad Gateway after service rebuilds.
- `docker-compose.yml`: Added `restart: unless-stopped` to all services.
- `gateway/Dockerfile`: Changed `ln -s` to `ln -sf` on shared symlink to prevent build failure when symlink already exists.
- `gateway/package.json`: Added `ws` dependency (Node 18 lacks a global `WebSocket`).

**Behaviour changes**
- All new accounts default to `is_writer = TRUE` — no separate writer-upgrade step required.
- Username generation no longer appends a random suffix unless the base username is already taken.
- Free allowance now covers subscriptions as well as per-article reads.
- Reading past zero balance is allowed — balance goes negative. No hard stop. A "allowance exhausted" modal is shown after the first read that crosses zero (in-app notice only; no payment collection yet).
- Articles deleted by author now publish a Nostr kind 5 deletion event with the correct `a` tag (`30023:<pubkey>:<d-tag>`) so deletions propagate to relays and the feed filters them correctly.
- Notes: Enter key publishes; Shift+Enter inserts a newline. Same behaviour in comment composer.
- Relay connection is awaited before note publish to prevent "0 relays available" errors on first post.

**UI / design**
- Full colour scheme overhaul:
  - Page background: pale salmon (`#FAE8E2`)
  - Article/card surfaces: cream (`#FDF6F0`)
  - Nav bar and note tiles: terracotta (`#A85141`)
  - Logo border: all-black (`#1A1512`)
  - All text on terracotta uses cream/salmon tokens only
  - Comment sections on note tiles appear in a cream inset panel
  - Accent colour (links, rule-accent, buttons): terracotta replacing eucalyptus green
- "Allowance exhausted" modal added (`AllowanceExhaustedModal.tsx`) — shown after first read past zero balance.
- Empty writer profile message: "Looks like \<name\> hasn't said anything yet."

### v1.7 — (previous baseline)
See git history.

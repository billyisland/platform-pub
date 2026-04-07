# all.haus — Deployment Reference v5.21.0

**Date:** 7 April 2026
**Replaces:** v5.20.0 (see bottom for change log)

This is the single source of truth for deploying and operating all.haus.

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

For **fresh** databases: no action needed — the schema and `_migrations` seed handle everything.

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

---

### From v5.19.0

No new migration. Services changed: **gateway**, **payment-service**, **web**. Deploy order: **rebuild gateway + payment + web**.

This release implements Publications Phase 5 — revenue management. Publication owners and finance managers can now configure subscription and per-article pricing (rate card), set standing revenue shares and per-article overrides for contributors (payroll), and view earnings dashboards. The daily payout worker now runs a publication payout cycle after the individual writer cycle, distributing revenue to members via Stripe Connect transfers based on their standing shares and article-specific overrides.

**Backend (gateway):**

- **Rate card routes** (`publications.ts`): `GET/PATCH /publications/:id/rate-card` — view and update `subscription_price_pence`, `annual_discount_pct`, `default_article_price_pence`. Requires `can_manage_finances` permission.
- **Payroll routes** (`publications.ts`): `GET /publications/:id/payroll` — view standing member shares (with user details) and per-article overrides. `PATCH /publications/:id/payroll` — bulk-update standing shares with 10,000 bps (100%) cap validation. `PATCH /publications/:id/payroll/article/:articleId` — upsert per-article share (revenue % or flat fee).
- **Earnings routes** (`publications.ts`): `GET /publications/:id/earnings` — summary totals (gross/net/pending/paid/readCount), per-article revenue breakdown, payout history with splits. Uses config-loaded `platform_fee_bps`.

**Backend (payment-service):**

- **Publication payout worker** (`payout.ts`): New `runPublicationPayoutCycle()` method on `PayoutService`. Finds publications with settled revenue above the payout threshold, then for each: (1) deducts platform fee, (2) pays flat-fee per-article overrides first, (3) distributes article revenue-share overrides, (4) distributes remaining pool by standing member shares, (5) initiates Stripe Connect transfers to each member's personal account, (6) records `publication_payouts` and `publication_payout_splits` rows, (7) marks `read_events` as `writer_paid`. Members without Stripe KYC get splits recorded as `pending`.
- **Payout worker** (`workers/payout.ts`): Now calls `runPublicationPayoutCycle()` after the individual writer payout cycle.

**Frontend (web):**

- **RateCardTab** (`RateCardTab.tsx`): Subscription pricing form (monthly price, annual discount %, default per-article price) with live annual price preview.
- **PayrollTab** (`PayrollTab.tsx`): Standing share editor with visual distribution bar, per-member bps input, 100% cap validation. Per-article overrides table showing article title, contributor, share type, value, and paid status.
- **PublicationEarningsTab** (`PublicationEarningsTab.tsx`): Summary cards (net earnings, pending, paid, read count), per-article revenue table, payout history with per-member split details.
- **Dashboard** (`dashboard/page.tsx`): Publication context now shows Rate card, Payroll, and Earnings tabs for members with `can_manage_finances` permission.
- **API client** (`api.ts`): `getRateCard`, `updateRateCard`, `getPayroll`, `updatePayroll`, `setArticleShare`, `getEarnings` methods on the publications namespace.

**New files:**

- `web/src/components/dashboard/RateCardTab.tsx`
- `web/src/components/dashboard/PayrollTab.tsx`
- `web/src/components/dashboard/PublicationEarningsTab.tsx`

**Modified files:**

- `gateway/src/routes/publications.ts` — rate card, payroll, and earnings routes added
- `payment-service/src/services/payout.ts` — `runPublicationPayoutCycle()` and `initiatePublicationPayout()` methods added
- `payment-service/src/workers/payout.ts` — calls publication payout cycle after writer cycle
- `web/src/app/dashboard/page.tsx` — new publication tabs (rate-card, payroll, earnings) with `can_manage_finances` gating
- `web/src/lib/api.ts` — revenue API client methods

**Upgrade steps:**
```bash
cd /root/platform-pub
git pull origin master

# No new migration — publication schema (038) already in place
# Rebuild gateway (new routes), payment (payout worker), and web (new tabs)
docker compose build gateway payment web
docker compose up -d gateway payment web
```

Verify:
```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
# gateway, payment, and web should show (healthy) after ~30s

# Visual checks:
# - /dashboard?context=<slug>: "Rate card", "Payroll", "Earnings" tabs visible for finance managers
# - Rate card tab: subscription price, annual discount, default article price fields
# - Payroll tab: standing shares with visual bar, per-article overrides table
# - Earnings tab: summary cards, per-article revenue table, payout history
```

No new env vars. No database changes.

---

### From v5.18.0

No new migration (038 was applied in v5.18.0). Services changed: **gateway**, **key-custody**, **web**. Deploy order: **rebuild gateway + key-custody + web**.

This release implements Publications Phases 2 and 3 — the CMS/publishing pipeline and the full reader-facing surface. Writers can now submit articles to publications, editors can approve and publish them (signed with the publication's Nostr keypair), and publications have their own homepage, about page, masthead, archive, RSS feed, subscription, and follow system. The feed and search engines now include publication content. Article pages show "By Author in Publication" bylines when applicable. Writer profiles filter out publication-only articles.

**Backend (key-custody):**

No changes beyond Phase 1 (signerType support already in place).

**Backend (gateway):**

- **Publication CMS routes** (`publications.ts`): `POST/GET /publications/:id/articles` (submit + list), `PATCH/DELETE /publications/:id/articles/:articleId` (edit/delete), `POST .../publish` and `.../unpublish` (approve/reject).
- **Server-side publishing pipeline** (`publication-publisher.ts`): New service that orchestrates article submission — generates d-tags, builds NIP-23 events with author/publisher p-tags, signs with publication key via key-custody, publishes to relay, indexes in DB. Contributors without `can_publish` save as 'submitted'; editors approve and trigger full pipeline.
- **Signing routes** (`signing.ts`): `/sign` and `/sign-and-publish` accept optional `publicationId` — checks `can_publish` permission, signs with publication key.
- **Draft routes** (`drafts.ts`): drafts can be associated with a publication via `publicationId`.
- **Public reader routes** (`publications.ts`): `GET /:slug/public` (full profile with follower/member/article counts, isFollowing, isSubscribed), `GET /by-slug/:slug/articles` (paginated), `GET /:slug/masthead`.
- **Publication subscriptions** (`subscriptions.ts`): `POST/DELETE /subscriptions/publication/:id`.
- **Publication follows** (`follows.ts`): `POST/DELETE /follows/publication/:id`. `GET /follows/pubkeys` includes followed publication pubkeys.
- **Publication RSS** (`rss.ts`): `GET /api/v1/pub/:slug/rss`.
- **Search** (`search.ts`): Publications searchable by name/tagline via pg_trgm.
- **Feed** (`feed.ts`): Following feed includes articles from followed publications.
- **Feed scorer** (`feed-scorer.ts`): Populates `publication_id` on feed_scores.
- **Article page** (`articles.ts`): `GET /articles/:dTag` now returns `publication` object (id, slug, name, subscriptionPricePence) when article belongs to a publication.
- **Writer profile** (`writers.ts`): Article queries filter `(publication_id IS NULL OR show_on_writer_profile = TRUE)`.

**Frontend (web):**

- **Editor** (`ArticleEditor.tsx`): "Publishing as" dropdown, "Also show on your personal profile" checkbox, "Submit for review" button for non-publishers.
- **Write page** (`write/page.tsx`): `?pub=<slug>` pre-selection, routes to `publishToPublication()` for publication articles.
- **Dashboard** (`dashboard/page.tsx`): Context switcher (Personal | Publication), publication-specific tabs (Articles, Members, Settings).
- **Publication dashboard tabs**: `PublicationArticlesTab.tsx` (CMS with publish/unpublish), `MembersTab.tsx` (invite, manage), `PublicationSettingsTab.tsx` (edit metadata).
- **Invite page** (`invite/[token]/page.tsx`): Shows invite details, accept/decline for logged-in users, signup redirect for anonymous.
- **Publication reader pages**: layout shell (`pub/[slug]/layout.tsx`), homepage with blog/magazine/minimal layouts (`page.tsx`), about, masthead, subscribe, archive, article-under-publication pages.
- **Publication components**: `PublicationNav.tsx`, `PublicationFooter.tsx`, `HomepageBlog.tsx`, `HomepageMagazine.tsx`, `HomepageMinimal.tsx`.
- **Article reader** (`ArticleReader.tsx`): "By Author in Publication" byline, publication subscription price used when applicable.
- **API client** (`api.ts`): Full publications namespace with reader-facing methods (getPublic, getPublicArticles, getMasthead, follow, unfollow, subscribe, cancelSubscription).

**New files:**

- `gateway/src/services/publication-publisher.ts`
- `web/src/components/dashboard/PublicationArticlesTab.tsx`
- `web/src/components/dashboard/MembersTab.tsx`
- `web/src/components/dashboard/PublicationSettingsTab.tsx`
- `web/src/app/invite/[token]/page.tsx`
- `web/src/app/pub/[slug]/layout.tsx`
- `web/src/app/pub/[slug]/page.tsx`
- `web/src/app/pub/[slug]/about/page.tsx`
- `web/src/app/pub/[slug]/masthead/page.tsx`
- `web/src/app/pub/[slug]/subscribe/page.tsx`
- `web/src/app/pub/[slug]/archive/page.tsx`
- `web/src/app/pub/[slug]/[articleSlug]/page.tsx`
- `web/src/components/publication/PublicationNav.tsx`
- `web/src/components/publication/PublicationFooter.tsx`
- `web/src/components/publication/HomepageBlog.tsx`
- `web/src/components/publication/HomepageMagazine.tsx`
- `web/src/components/publication/HomepageMinimal.tsx`

**Modified files:**

- `gateway/src/routes/publications.ts` — CMS + reader-facing routes added
- `gateway/src/routes/signing.ts` — publicationId support
- `gateway/src/routes/drafts.ts` — publicationId on drafts
- `gateway/src/routes/subscriptions.ts` — publication subscription routes
- `gateway/src/routes/follows.ts` — publication follow routes
- `gateway/src/routes/rss.ts` — publication RSS feed
- `gateway/src/routes/search.ts` — publication search
- `gateway/src/routes/feed.ts` — publication content in following feed
- `gateway/src/workers/feed-scorer.ts` — publication_id in scoring
- `gateway/src/routes/articles.ts` — publication info in article response
- `gateway/src/routes/writers.ts` — publication article filtering on writer profiles
- `gateway/src/services/access.ts` — publication member free access, publication subscription check
- `web/src/components/editor/ArticleEditor.tsx` — publication selector, cross-post checkbox
- `web/src/app/write/page.tsx` — publication pre-selection, routing
- `web/src/lib/publish.ts` — publishToPublication function
- `web/src/app/dashboard/page.tsx` — context switcher, publication tabs
- `web/src/lib/api.ts` — publications namespace, ArticleMetadata.publication field
- `web/src/components/article/ArticleReader.tsx` — publication byline
- `web/src/app/article/[dTag]/page.tsx` — passes publication props

**Upgrade steps:**
```bash
cd /root/platform-pub
git pull origin master

# No new migration — 038 was applied in v5.18.0
# Rebuild all three services (gateway has new routes + services, web has new pages)
docker compose build gateway key-custody web
docker compose up -d gateway key-custody web
```

Verify:
```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
# gateway, key-custody, and web should show (healthy) after ~30s

# Visual checks:
# - /write page: "Publishing as" dropdown appears if user is a publication member
# - /dashboard: context switcher shows personal + publication names
# - /dashboard?context=<slug>: publication Articles/Members/Settings tabs
# - /pub/<slug>: publication homepage with nav, articles, footer
# - /pub/<slug>/about: about page with rendered markdown
# - /pub/<slug>/masthead: team listing with avatars and roles
# - /pub/<slug>/archive: full article list with dates
# - /article/<dTag>: articles with publication show "By Author in Publication" byline
# - /<username>: writer profile excludes publication-only articles
# - /search: publications appear in search results
```

No new env vars. No database changes.

---

### From v5.17.0

**Migration required (038).** Services changed: **gateway**, **key-custody**, **web**. Deploy order: **migrate → rebuild gateway + key-custody + web**.

This release implements Publications Phase 1 — the schema and core services for multi-writer federated publications. Publications get their own custodial Nostr keypairs (stored in the `publications` table, managed by key-custody), an editorial membership model, and revenue pooling tables. The key-custody service now accepts a `signerType` parameter (`'account'` or `'publication'`) on all signing and encryption endpoints, allowing articles to be signed by a publication identity rather than an individual writer. The global CSS input reset is also removed, fixing editor field rendering.

**Database (migration 038):**

- **New types:** `publication_role` (`editor_in_chief`, `editor`, `contributor`), `contributor_type` (`permanent`, `one_off`).
- **New tables:** `publications`, `publication_members`, `publication_invites`, `publication_article_shares`, `publication_follows`, `publication_payouts`, `publication_payout_splits`.
- **Modified tables:**
  - `articles` — added `publication_id`, `publication_article_status`, `show_on_writer_profile` columns.
  - `article_drafts` — added `publication_id` column.
  - `subscriptions` — `writer_id` now nullable; added `publication_id`; unique constraint replaced with partial unique indexes per target type; added `subscriptions_target_check` constraint (exactly one of `writer_id`/`publication_id` must be set).
  - `subscription_nudge_log` — added `publication_id` column.
  - `feed_scores` — added `publication_id` column and index.
- **New platform config:** `publication_payout_threshold_pence` (default 2000 = £20.00).

**Backend (key-custody):**

- All signing and encryption endpoints (`/sign`, `/unwrap`, `/nip44-encrypt`, `/nip44-decrypt`) now accept `signerId` + `signerType` instead of `accountId`. When `signerType` is `'publication'`, the private key is looked up from the `publications` table. Backwards-compatible: `accountId` still accepted as a fallback.

**Backend (gateway):**

- `key-custody-client.ts` — all functions (`signEvent`, `unwrapKey`, `nip44Encrypt`, `nip44Decrypt`) updated to pass `signerId` and `signerType` parameters.
- New middleware: `publication-auth.ts` — publication-scoped authorisation for editorial endpoints.

**Frontend (web):**

- **Global input reset removed** (`globals.css`) — the blanket `input[type="text"]`, `textarea`, `select` rule that forced `bg-white` and `border: 1px solid #E5E5E5` on all form fields has been deleted. This fixes the article editor title and standfirst fields, which now render correctly as grey card panels without hairline outlines. Other form fields (auth page, etc.) are unaffected as they have their own inline styles.

**New files:**

- `migrations/038_publications.sql` — publications schema migration.
- `gateway/src/middleware/publication-auth.ts` — publication authorisation middleware.

**Modified files:**

- `schema.sql` — updated to incorporate migrations 001–038 (was 001–037).
- `key-custody/src/lib/crypto.ts` — `signerType` support on `signEvent`, `unwrapKey`, `nip44Encrypt`, `nip44Decrypt`, and `getDecryptedPrivkey`.
- `key-custody/src/routes/keypairs.ts` — schemas accept `signerId`/`signerType`, backwards-compatible with `accountId`.
- `gateway/src/lib/key-custody-client.ts` — passes `signerId`/`signerType` to key-custody.
- `web/src/app/globals.css` — global input/textarea/select reset removed.

**Upgrade steps:**
```bash
cd /root/platform-pub
git pull origin master

# Apply migration
docker exec -i platform-pub-postgres-1 psql -U platformpub platformpub < migrations/038_publications.sql

# Rebuild changed services
docker compose build gateway key-custody web
docker compose up -d gateway key-custody web
```

Verify:
```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
# gateway, key-custody, and web should show (healthy) after ~30s

# Schema check:
docker exec platform-pub-postgres-1 psql -U platformpub platformpub \
  -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'"
# Should be 45+

# Publications table exists:
docker exec platform-pub-postgres-1 psql -U platformpub platformpub \
  -c "\d publications"

# Visual checks:
# - /write page: title and standfirst fields are grey card panels, no hairline outlines
# - /write page: no white-box-with-outline artefact on title/subtitle inputs
```

No new env vars.

---

### From v5.16.0

No migration. Services changed: **gateway**, **web**. Deploy order: **rebuild gateway + web**.

This release separates crowdfunding drives (public) from commissions (private, DM-only), fixes the `PledgeDrive` frontend types to match the backend API, and refreshes the article editor layout.

**Backend (gateway):**

- `GET /drives/by-user/:userId` — now filters to `origin = 'crowdfund'` only, so commissions never appear on public profiles or in the dashboard drives tab.

**Frontend (web):**

- **`PledgeDrive` type fixed** — interface now matches backend response: `origin` (not `type`), `fundingTargetPence` (not `targetAmountPence`), `currentTotalPence` (not `currentAmountPence`), `pinned` (not `pinnedOnProfile`), status enum aligned to `open | funded | published | fulfilled | expired | cancelled`.
- **`Pledge` type fixed** — `writer` is now a nested object `{ username, displayName }` matching backend; added `driveStatus` field.
- **Commissions removed from public surfaces:**
  - Commission button removed from writer profile pages (`WriterActivity.tsx`) — commissions now start from DMs only.
  - Commission button removed from note cards (`NoteCard.tsx`) and reply threads (`ReplyItem.tsx`) — `onCommission` prop removed.
  - `CommissionCard.tsx` deleted (was unused dead code).
- **Dashboard drives tab simplified:**
  - `DriveCreateForm` — crowdfund/commission toggle removed; form now creates crowdfund drives only.
  - `DriveCard` — commission accept/decline UI removed; always labelled "Pledge drive".
  - `DrivesTab` — "Incoming commissions" section removed; simplified to active vs completed.
- **CommissionForm cleaned up** — dead `openToBakers` checkbox removed; form retained for its one call site in `MessageThread.tsx` (DM-only commissions).
- **Article editor** — title and standfirst are now separate grey (`bg-grey-100`) cards with `p-8 sm:p-10` padding, matching the body editor field. No hairlines.

**Modified files:**

- `gateway/src/routes/drives.ts` — `by-user` endpoint filtered to crowdfund only
- `web/src/lib/api.ts` — `PledgeDrive` and `Pledge` interfaces fixed to match backend
- `web/src/components/dashboard/DriveCreateForm.tsx` — crowdfund-only, toggle removed
- `web/src/components/dashboard/DriveCard.tsx` — commission UI removed, field names fixed
- `web/src/components/dashboard/DrivesTab.tsx` — commission section removed, field names fixed
- `web/src/components/profile/ProfileDriveCard.tsx` — field names fixed
- `web/src/components/profile/WorkTab.tsx` — field name fix (`pinned`)
- `web/src/components/profile/WriterActivity.tsx` — commission button and modal removed
- `web/src/components/feed/NoteCard.tsx` — `onCommission` prop removed
- `web/src/components/replies/ReplyItem.tsx` — `onCommission` prop removed
- `web/src/components/ui/CommissionForm.tsx` — dead `openToBakers` state removed
- `web/src/components/account/PledgesSection.tsx` — uses `writer.username` (matches backend)
- `web/src/components/editor/ArticleEditor.tsx` — title and standfirst as separate grey cards

**Deleted files:**

- `web/src/components/feed/CommissionCard.tsx`

**Upgrade steps:**
```bash
cd /root/platform-pub
git pull origin master

# No migration needed — only code changes
docker compose build gateway web
docker compose up -d gateway web
```

Verify:
```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
# gateway and web should show (healthy) after ~30s

# Visual checks:
# - Writer profile: no Commission button (Message button is still present)
# - Writer profile Work tab: pledge drives display correctly with progress bars
# - /dashboard?tab=drives: only crowdfund drives shown, no incoming commissions section
# - /dashboard?tab=drives: "New pledge drive" form has no crowdfund/commission toggle
# - /messages: Commission button still works in 1:1 DM threads
# - /write page: title and standfirst are separate grey cards, matching body field
# - /account: Pledges section shows writer names correctly
```

No new env vars. No database changes.

> **Older versions:** Upgrade instructions for v5.16.0 and earlier are available in this file's git history.

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

Images uploaded via `POST /api/v1/media/upload` are resized (max 1200px), converted to WebP (quality 80), and written to the `media_data` volume at `/app/media/<sha256>.webp`. Nginx serves them at `/media/<sha256>.webp` with 1-year cache headers.

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
- Docker healthchecks on some Alpine containers report "unhealthy" due to missing `wget`/`curl` in the image, despite services running correctly

---

## Change log

### v5.21.0 — 7 April 2026

**Fix: gateway crash — duplicate route collision on publication articles**

No migration. Services changed: gateway, web.

- **Route collision fix:** `GET /publications/:slug/articles` (public) and `GET /publications/:id/articles` (CMS) registered identical Fastify route patterns, causing `FST_ERR_DUPLICATED_ROUTE` and a gateway crash loop. Public route moved to `GET /publications/by-slug/:slug/articles`. Frontend callers (`api.ts`, `pub/[slug]/page.tsx`, `pub/[slug]/archive/page.tsx`) updated.

---

### v5.20.0 — 6 April 2026

**Publications Phase 5: Revenue — rate card, payroll, payout worker, earnings dashboard**

No new migration. Services changed: gateway, payment-service, web.

- **Rate card routes:** `GET/PATCH /publications/:id/rate-card` for subscription pricing, annual discount, and default per-article pricing. Gated on `can_manage_finances`.
- **Payroll routes:** `GET/PATCH /publications/:id/payroll` for standing revenue shares (10,000 bps cap); `PATCH /publications/:id/payroll/article/:articleId` for per-article overrides (revenue % or flat fee, upsert semantics).
- **Publication payout worker:** `runPublicationPayoutCycle()` runs after individual writer payouts. Processes flat fees first, then article revenue shares, then standing shares. Stripe Connect transfers to members; pending status for unverified accounts. Records `publication_payouts` + `publication_payout_splits`.
- **Earnings dashboard:** `GET /publications/:id/earnings` returns summary totals, per-article breakdown, and payout history with splits. Platform fee loaded from config.
- **Dashboard tabs:** Rate card (pricing form), Payroll (share editor with visual bar + overrides table), Earnings (summary cards, revenue table, payout history). All gated on `can_manage_finances`.
- **API client:** `getRateCard`, `updateRateCard`, `getPayroll`, `updatePayroll`, `setArticleShare`, `getEarnings`.

---

### v5.19.0 — 6 April 2026

**Publications Phases 2 & 3: CMS pipeline, reader surface, feed/search integration**

No new migration (uses 038 from v5.18.0). Services changed: gateway, key-custody, web.

- **Server-side publishing pipeline:** Articles submitted to publications are signed with the publication's Nostr keypair (via key-custody), published to the relay, and indexed — all orchestrated server-side. Contributors without `can_publish` save as 'submitted'; editors approve to trigger the full pipeline.
- **Publication CMS routes:** Submit, list, edit, delete, publish, unpublish articles within a publication. Signing routes accept `publicationId` for publication-key signing.
- **Publication reader pages:** Homepage (blog/magazine/minimal layouts), about, masthead, subscribe, archive, and article-under-publication pages at `/pub/<slug>/...`.
- **Publication subscriptions and follows:** Subscribe/unsubscribe and follow/unfollow routes for publications. Following feed includes content from followed publications.
- **Publication RSS:** Per-publication RSS feed at `/api/v1/pub/<slug>/rss`.
- **Search integration:** Publications searchable by name and tagline.
- **Feed scoring:** `feed_scores.publication_id` populated by the scoring worker.
- **Article page awareness:** Articles show "By Author in Publication" byline with link. Publication subscription price used for CTA.
- **Writer profile filtering:** Publication-only articles hidden unless `show_on_writer_profile` is true.
- **Editor integration:** "Publishing as" dropdown, "Submit for review" for non-publishers, "Also show on your personal profile" checkbox.
- **Dashboard context switcher:** Personal vs publication context with publication-specific tabs (Articles, Members, Settings).
- **Invite acceptance page:** `/invite/<token>` with accept/decline for logged-in, signup redirect for anonymous.

---

### v5.18.0 — 6 April 2026

**Publications Phase 1: schema, key-custody publication signing, CSS fix**

New migration (038). Services changed: gateway, key-custody, web.

- **Publications schema (migration 038):** 7 new tables (`publications`, `publication_members`, `publication_invites`, `publication_article_shares`, `publication_follows`, `publication_payouts`, `publication_payout_splits`), 2 new enums (`publication_role`, `contributor_type`). Modified `articles`, `article_drafts`, `subscriptions`, `subscription_nudge_log`, `feed_scores` with publication columns. New platform config `publication_payout_threshold_pence`.
- **Key-custody publication signing:** All signing/encryption endpoints (`/sign`, `/unwrap`, `/nip44-encrypt`, `/nip44-decrypt`) accept `signerId` + `signerType` (`'account'` | `'publication'`). Publication keys looked up from `publications` table. Backwards-compatible with `accountId`.
- **Gateway:** `key-custody-client.ts` updated for `signerId`/`signerType`. New `publication-auth.ts` middleware. New `publications.ts` route file.
- **CSS fix:** Removed global input/textarea/select reset (`bg-white` + `border: 1px solid`) from `globals.css` that was overriding editor field styling.

---

### v5.17.0 — 6 April 2026

**Separate crowdfunding drives from commissions, editor card refresh**

No migration. Services changed: gateway, web.

- **Crowdfunding drives are public, commissions are private (DM-only).** The `by-user` endpoint now filters to `origin = 'crowdfund'`, so commissions never appear on profiles or in the dashboard drives tab. Commission creation remains available exclusively in DM message threads via `CommissionForm`.
- **`PledgeDrive` frontend type fixed** to match backend API response: `origin` (was `type`), `fundingTargetPence` (was `targetAmountPence`), `currentTotalPence` (was `currentAmountPence`), `pinned` (was `pinnedOnProfile`), status enum aligned to backend (`open | funded | published | fulfilled | expired | cancelled`).
- **`Pledge` frontend type fixed** to match backend: `writer` is now nested `{ username, displayName }` (was flat `writerUsername`), added `driveStatus`.
- **Commission UI removed from public surfaces:** Commission button removed from writer profiles (`WriterActivity`), note cards (`NoteCard`), and reply threads (`ReplyItem`). `CommissionCard.tsx` deleted (was unused). Dashboard `DriveCreateForm` no longer offers a commission option. Dashboard `DriveCard` no longer shows accept/decline commission UI. Dashboard `DrivesTab` no longer shows an "Incoming commissions" section.
- **`CommissionForm` cleaned up:** dead `openToBakers` checkbox removed (was never sent to API). Form retained for DM use in `MessageThread.tsx`.
- **Article editor:** title and standfirst are now separate `bg-grey-100` cards with `p-8 sm:p-10` padding, matching the body editor field. No hairlines between fields.


> **Older versions:** Changelog entries for v5.13.0 and earlier are available in this file's git history.

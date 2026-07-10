# all.haus — Deployment Reference

**Consolidated:** 29 May 2026
**Baseline:** ~v5.36.0 (post workspace-experiment merge)
**Supersedes:** v5.30.0 (13 April 2026)

This is the single source of truth for deploying and operating all.haus.

> **Doc provenance note.** The structural sections below (services, migrations, routes, pages, env) were re-verified against the repository at this consolidation. The granular per-release changelog between v5.30.0 and this consolidation was **not** reconstructed — those entries live in this file's git history. The "Consolidated update" changelog entry summarises that window by capability area, anchored to the migrations and ADRs that record each change.

---

## Architecture overview

```
Internet
  │
  ├─ :443 ─→ nginx (TLS termination)
  │            ├─ /api/*      → gateway:3000
  │            ├─ /ingest/*   → traffology-ingest:3005
  │            ├─ /relay      → strfry:7777  (WebSocket upgrade)
  │            ├─ /media/*    → blossom:3003 (Blossom blob store; GET/HEAD hash paths only; rewrite → /<sha256>)
  │            └─ /*          → web:3000     (Next.js)
  │
  └─ :80 ─→ nginx (→ 301 HTTPS, plus certbot ACME challenges)

Internal only:
  gateway:3000    ─→ postgres:5432
                  ─→ payment:3001
                  ─→ keyservice:3002
                  ─→ key-custody:3004
                  ─→ traffology-ingest:3005
                  ─→ blossom:3003 (media blob store — BUD-02 PUT /upload)
  payment:3001    ─→ postgres:5432, strfry:7777, Stripe API
  keyservice:3002 ─→ postgres:5432, strfry:7777
  key-custody:3004 → postgres:5432
  traffology-ingest:3005 → postgres:5432
  traffology-worker      → postgres:5432 (Graphile Worker, no port)
  feed-ingest            → postgres:5432, strfry:7777,
                           external RSS / ActivityPub / Bluesky / email
                           (background ingestion + outbound; no public port)
```

### Services

| Service           | Image / Build                         | Port                        | Purpose                                                                                  |
| ----------------- | ------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------- |
| postgres          | postgres:16-alpine                    | 5432 (localhost only)       | Shared database                                                                          |
| strfry            | dockurr/strfry:latest                 | 4848→7777                   | Nostr relay                                                                              |
| gateway           | ./gateway/Dockerfile                  | 3000 (localhost only)       | API gateway, auth, media upload, all client-facing API                                  |
| payment           | ./payment-service/Dockerfile          | 3001 (Docker internal only) | Stripe, settlement, payouts                                                              |
| keyservice        | ./key-service/Dockerfile              | 3002 (Docker internal only) | Vault encryption, NIP-44 key issuance                                                    |
| key-custody       | ./key-custody/Dockerfile              | 3004 (Docker internal only) | Custodial Nostr keypair service (sole holder of `ACCOUNT_KEY_HEX`)                       |
| feed-ingest       | ./feed-ingest/Dockerfile              | — (background)              | Universal Feed ingestion: RSS, ActivityPub/Mastodon, AT Protocol/Bluesky, Nostr, email; outbound cross-posting |
| web               | ./web/Dockerfile                      | 3010→3000                   | Next.js frontend                                                                         |
| nginx             | nginx:alpine                          | 80, 443                     | Reverse proxy, TLS, static media                                                         |
| traffology-ingest | ./traffology-ingest/Dockerfile        | 3005 (Docker internal only) | Analytics beacon receiver, session tracking                                              |
| traffology-worker | ./traffology-worker/Dockerfile        | — (background)              | Graphile Worker: hourly/daily/weekly aggregation, source resolution, interpretation      |
| blossom           | ghcr.io/hzrd149/blossom-server:6.2.0  | 3003 (Docker internal only) | Media blob store — **primary media backend**. Gateway signs a kind-24242 (BUD-02) auth and PUTs each crunched image; nginx proxies `/media/`. Healthcheck uses `deno` (image has no `wget`/`curl`). |
| certbot           | certbot/certbot                       | —                           | TLS certificate renewal                                                                  |

### Docker volumes

| Volume        | Mounted by               | Purpose                                   |
| ------------- | ------------------------ | ----------------------------------------- |
| pgdata        | postgres                 | Database storage                          |
| strfry_data   | strfry                   | Relay event database (LMDB)               |
| media_data    | gateway (rw), nginx (ro) | **Legacy** on-disk images — reads/writes now go to Blossom; retained for rollback of *pre-cutover* blobs only (post-cutover blobs are Blossom-only), removed after soak (ADR-blossom-migration Phase 4) |
| blossom_data  | blossom                  | Blossom blob storage (primary media store) |
| certbot_data  | nginx, certbot           | ACME challenge files                      |
| certbot_certs | nginx, certbot           | TLS certificates                          |

---

## How builds and migrations work — read this first

Two operational facts cause almost every "I deployed but nothing changed" incident:

1. **Host builds do nothing.** Every service runs inside a Docker container. Running `npm run build` / `npm run dev` / `next build` on the host has **no effect on the live site** — those outputs go to a local `.next/` (or `dist/`) the container never reads. All deploys go through `docker compose build <service>` then `docker compose up -d <service>`.

2. **`up` does not rebuild, and nothing auto-runs migrations.** `docker compose up -d` (and `restart`) reuse the **existing image** unless you pass `--build`. And no Dockerfile, compose entry, entrypoint, or CI step runs the migration runner — migrations are always a **manual step**. A pull + `up` with no build and no migrate leaves both code and schema stale.

The correct upgrade shape is therefore always: **pull → migrate → build → up → reload nginx.** See [Upgrading](#upgrading).

If a feature is missing after a deploy, jump to [Troubleshooting: feature not appearing](#troubleshooting-feature-not-appearing-after-a-rebuild).

---

## Prerequisites

- Ubuntu 22.04+ or Debian 12+ server
- Docker Engine 24+ with Docker Compose v2
- Domain pointing to the server's IP
- TLS certificate (via certbot, provisioned separately)

### Required environment files

Each long-running API service reads a `.env`. Copy and fill:

```bash
cp gateway/.env.example gateway/.env
cp payment-service/.env.example payment-service/.env
cp key-service/.env.example key-service/.env
cp key-custody/.env.example key-custody/.env
cp web/.env.example web/.env
# traffology-ingest needs IP_HASH_SALT (see below)
cp traffology-ingest/.env.example traffology-ingest/.env  # if present
```

`feed-ingest`, `traffology-worker`, and `web` (build args) draw their variables from the compose `environment:`/`args:` blocks, which reference the **root `.env`**. Ensure the root `.env` carries `POSTGRES_PASSWORD`, `LINKED_ACCOUNT_KEY_HEX`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, and (optionally) `ATPROTO_PRIVATE_JWK` / `ATPROTO_CLIENT_BASE_URL`. Set `NOSTR_ENGAGEMENT_COUNTS_ENABLED=1` (read by `feed-ingest`) to turn on the Nostr reaction/reply count refresh on external cards — it ships dark (default off) because the relay REQ sweep is the heaviest engagement source (UNIVERSAL-FEED-ADR §VI.2).

Key variables:

| Variable                                    | Service                                | Purpose                                                                                                                              |
| ------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `SESSION_SECRET`                            | gateway                                | JWT signing key, cookie secret, and OAuth-state HMAC (min 32 chars)                                                                  |
| `PLATFORM_SERVICE_PRIVKEY`                  | gateway, payment, key-service          | 64-hex Nostr private key for platform service events                                                                                 |
| `READER_HASH_KEY`                           | gateway                                | HMAC key for reader pubkey privacy hashing                                                                                            |
| `INTERNAL_SECRET`                           | gateway, key-custody, key-service      | Shared secret authenticating gateway→key-custody and gateway→key-service calls                                                       |
| `INTERNAL_SERVICE_TOKEN`                    | gateway, payment-service               | Shared secret authenticating gateway→payment and cron→payment calls (`/gate-pass`, `/card-connected`, `/payout-cycle`, `/settlement-check/monthly`) |
| `ACCOUNT_KEY_HEX`                           | key-custody **only**                   | AES-256 key encrypting custodial Nostr privkeys at rest                                                                              |
| `KMS_MASTER_KEY_HEX`                        | key-service                            | AES-256 master key for vault content-key envelope encryption                                                                         |
| `STRIPE_SECRET_KEY`                         | gateway, payment                       | Stripe API key (validated at startup — gateway will not boot without it)                                                             |
| `STRIPE_WEBHOOK_SECRET`                     | payment-service                        | Stripe webhook signing secret (main account endpoint)                                                                                |
| `STRIPE_CONNECT_WEBHOOK_SECRET`             | payment-service (optional)             | Second signing secret, **only** if Connect events use a *separate* Stripe endpoint. Verified in addition to `STRIPE_WEBHOOK_SECRET`. Unneeded when the one endpoint listens to events on connected accounts (see Stripe note below) |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`        | web (build arg)                        | Stripe publishable key (baked at build time)                                                                                         |
| `KEY_SERVICE_URL` / `PAYMENT_SERVICE_URL`   | gateway                                | Internal service URLs (**required** — no localhost fallback)                                                                         |
| `KEY_CUSTODY_URL`                           | gateway                                | Internal URL for key-custody (default: http://localhost:3004)                                                                        |
| `TRAFFOLOGY_INGEST_URL`                     | gateway                                | Internal URL for traffology-ingest (default: http://localhost:3005)                                                                  |
| `PLATFORM_RELAY_WS_URL`                     | gateway, payment, key-service, feed-ingest | strfry WebSocket URL (compose: `ws://strfry:7777`). On the gateway it is also the internal fan-out target for discovery events |
| `DISCOVERY_PUBLISH_ENABLED`                 | gateway                                | Master switch for Nostr outbound discovery (kind 0/3/10002 producers + scheduler sweep). `0`/unset = ships dark (no events produced); `1` = enabled. NIP-05 endpoint is unaffected (always on). See `docs/adr/NOSTR-OUTBOUND-INTEROP-ADR.md` |
| `PUBLIC_FANOUT_RELAY_URLS`                  | gateway                                | Comma-separated public relays to fan discovery events to (e.g. `wss://relay.damus.io,wss://nos.lol`). Empty/unset = in-house relay only. Only takes effect when `DISCOVERY_PUBLISH_ENABLED=1` |
| `PUBLIC_RELAY_URL`                          | gateway                                | The relay all.haus *advertises* in kind 10002 / NIP-05 (default: `wss://all.haus/relay`). Distinct from `PLATFORM_RELAY_WS_URL` (internal publish socket) |
| `NIP05_DOMAIN`                              | gateway                                | Host used in NIP-05 identifiers `<username>@<domain>` (default: `all.haus`)                                                          |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | gateway                                | Google OAuth credentials                                                                                                             |
| `APP_URL`                                   | gateway, feed-ingest                   | **Frontend** URL. OAuth redirects, Stripe redirects, CORS, magic links. **Must not be the gateway URL.** Dev: `http://localhost:3010` |
| `GATEWAY_URL`                               | web (**build arg**)                    | Destination of the Next.js `/api/*` → gateway proxy rewrite (compose: `http://gateway:3000`). **Baked at build time** — `next.config.js` `rewrites()` is evaluated during `next build`, so a runtime-only value has no effect and the proxy silently falls back to `localhost:3000` (= the web container itself → `ECONNRESET` on every API call, blank pages). Must be passed as a Docker build arg. |
| `LINKED_ACCOUNT_KEY_HEX`                    | gateway, **feed-ingest**               | AES-256 key (64 hex) encrypting linked-account OAuth credentials and `atproto_oauth_sessions.session_data_enc`. **Must be identical across gateway and feed-ingest.** |
| `LINKED_ACCOUNT_KEY_VERSION`                | gateway, feed-ingest                   | Write-side key version for `LINKED_ACCOUNT_KEY_HEX` rotation (default: `1`)                                                          |
| `ATPROTO_CLIENT_BASE_URL`                   | gateway, feed-ingest                   | Public origin for AT Protocol OAuth client metadata (e.g. `https://all.haus`). Loopback fallback in dev                              |
| `ATPROTO_PRIVATE_JWK`                       | gateway, feed-ingest                   | ES256 signing JWK (JSON string) for `private_key_jwt`. Required for **any** Bluesky OAuth (link *and* "set one up") when `ATPROTO_CLIENT_BASE_URL` is a public origin — without it `getAtprotoClient()` throws and the connect 502s; services still boot. Generate with `npx tsx scripts/gen-atproto-jwk.ts` (see below). The public half is auto-served at `/.well-known/jwks.json` |
| `ATPROTO_ASSISTED_ENABLED`                  | gateway                                | Master switch for ASSISTED atproto ("set one up for me" → Bluesky via OAuth account-creation-in-flow). `0`/unset = ships dark (`POST /linked-accounts/bluesky/assisted` 503s, UI keeps "Set one up · soon"); `1` = enabled (live on prod 2026-06-10, verified end-to-end). Requires `ATPROTO_PRIVATE_JWK`. See `docs/adr/NETWORK-CONCIERGE-ADR.md` §6.1.1 |
| `ATPROTO_DEFAULT_PDS`                        | gateway                                | PDS hostname the ASSISTED flow seeds `authorize()` with. Defaults to `https://bsky.social`                                          |
| `MASTODON_ASSISTED_ENABLED`                 | gateway                                | Master switch for ASSISTED activitypub ("set one up for me" → Mastodon via signup-then-resume OAuth round-trip). `0`/unset = ships dark (`POST /linked-accounts/mastodon/assisted` 503s, UI keeps "Set one up · soon"); `1` = enabled (live on prod 2026-06-11, signup round-trip verified). See `docs/adr/NETWORK-CONCIERGE-ADR.md` §9 |
| `MASTODON_ASSISTED_INSTANCES`               | gateway                                | Comma-separated curated allowlist of open-registration Mastodon hosts for the ASSISTED hand-off; first entry is the default. Defaults to `mastodon.social`. Each entry is live-checked (`/api/v2/instance` registrations open + no approval) before hand-off |
| `MASTODON_DISCOVERY_INSTANCES`              | gateway                                | Comma-separated Mastodon hosts the resolver's `activitypub_discovery` branch queries (unauthenticated `/api/v2/search`, submit-only). Defaults to `mastodon.social`. Keep to one or at most two — each is a full extra HTTP round-trip per discovery submit. Distinct from `MASTODON_ASSISTED_INSTANCES`. See `docs/adr/RESOLVER-DISCOVERY-ADR.md` §5.2 |
| `IDENTITY_LINK_DETECT_ENABLED`              | feed-ingest                            | Master switch for cross-source identity-link **detection** (Slice 8 P3 — daily `identity_link_detect`, domain_match from stored metadata). `0`/unset = ships dark (cron not scheduled, no global links written; user-asserted links P2 unaffected); `1` = enabled. Writes GLOBAL links that suppress cross-posted duplicates in every reader's feed. See `SLICE-8-IDENTITY-LINKING-PLAN.md` §P3 |
| `EMAIL_PROVIDER`                            | gateway                                | `postmark`, `resend`, or `console`                                                                                                  |
| `POSTMARK_API_KEY` / `RESEND_API_KEY`       | gateway                                | Provider key (required for the chosen provider)                                                                                      |
| `POSTMARK_BROADCAST_STREAM`                 | gateway                                | Postmark broadcast message stream ID (default: `broadcast`)                                                                          |
| `EMAIL_FROM` / `EMAIL_FROM_BROADCAST`       | gateway                                | From addresses for transactional / publish-notification emails                                                                       |
| `BROADCAST_DAILY_SEND_LIMIT`                | gateway                                | Daily broadcast cap for stream warm-up; `0` = unlimited (default: `50`)                                                              |
| `ADMIN_ACCOUNT_IDS`                         | gateway                                | Comma-separated admin UUIDs (fallback; prefer `admin_account_ids` in `platform_config`)                                             |
| `IP_HASH_SALT`                              | traffology-ingest                      | Salt for SHA-256 IP hashing (**must override in production**)                                                                        |
| `MEDIA_DIR` / `PUBLIC_MEDIA_URL`            | gateway                                | Media volume path / public URL prefix                                                                                                |

> **Security:** `ACCOUNT_KEY_HEX` must never be set on any service other than key-custody. The gateway cannot decrypt user private keys by design.

> **Startup validation:** All services validate required env vars at startup and refuse to boot if any are missing (look for `Missing required environment variable:` in logs). `SESSION_SECRET`, `ACCOUNT_KEY_HEX`, `KMS_MASTER_KEY_HEX` must be ≥32 chars. `APP_URL`, `STRIPE_SECRET_KEY`, `READER_HASH_KEY`, `KEY_SERVICE_URL`, `PAYMENT_SERVICE_URL` are required on the gateway with no fallback.

---

## Fresh deployment

### 1. Clone

```bash
git clone https://github.com/billyisland/platform-pub /root/platform-pub
cd /root/platform-pub
```

The backend is an npm workspace (`shared`, `gateway`, `payment-service`, `key-service`, `key-custody`, `feed-ingest`, `traffology-ingest`, `traffology-worker`). One root `npm ci` installs every service; `@platform-pub/shared` is linked into each consumer automatically. Docker builds use multi-stage Dockerfiles (build stage compiles TypeScript; production stage runs a clean `npm ci --omit=dev` with only compiled output). `web/` is standalone (its own Next.js toolchain and lockfile).

### 2. Environment files

```bash
export POSTGRES_PASSWORD=$(openssl rand -base64 24)
echo "POSTGRES_PASSWORD=$POSTGRES_PASSWORD" > .env

cp gateway/.env.example gateway/.env
cp payment-service/.env.example payment-service/.env
cp key-service/.env.example key-service/.env
cp key-custody/.env.example key-custody/.env
cp web/.env.example web/.env
# Edit each with real keys
```

Generate secrets:

```bash
openssl rand -hex 32     # SESSION_SECRET, READER_HASH_KEY
openssl rand -hex 32     # ACCOUNT_KEY_HEX (key-custody only)
openssl rand -hex 32     # KMS_MASTER_KEY_HEX (key-service only)
openssl rand -hex 32     # LINKED_ACCOUNT_KEY_HEX (gateway + feed-ingest — must match)
openssl rand -hex 32     # IP_HASH_SALT (traffology-ingest)
openssl rand -base64 32  # INTERNAL_SECRET (gateway + key-custody + key-service)
openssl rand -base64 32  # INTERNAL_SERVICE_TOKEN (gateway + payment-service)
# PLATFORM_SERVICE_PRIVKEY: any 64-hex Nostr/ed25519 private key
```

### 3. Start infrastructure

```bash
docker compose up -d postgres strfry
docker compose ps   # wait for postgres healthy
```

### 4. Schema and migrations

The base schema (`schema.sql`) is auto-applied on **first** postgres boot via the `initdb.d` volume mount. `schema.sql` is a `pg_dump` of a fully-migrated database, kept in lockstep with `migrations/` by the CI drift guard (`scripts/check-schema-drift.sh` — regenerate `schema.sql` whenever you add a migration; the guard fails the build if the two halves disagree). It ends with an `INSERT` that **seeds the `_migrations` table** with every migration baked into the dump, so a fresh DB records them all as already-applied — the runner is then a clean no-op on a fresh DB and applies only genuinely-new files on an existing one.

- **Fresh DB:** no migration action needed — `schema.sql` is current.
- **Existing DB initialised from an older `schema.sql`:** run the migration runner (below). It reads `migrations/` in numeric-prefix order, checks `_migrations`, and applies only pending files. Each file runs inside a `BEGIN/COMMIT` and rolls back on failure, except statements Postgres forbids inside a transaction block — `ALTER TYPE … ADD VALUE` and `CREATE/DROP INDEX CONCURRENTLY` — which the runner detects and applies outside a transaction (and therefore cannot roll back).
- **Checksums:** the runner records a sha256 per applied migration and verifies all applied rows against the files on disk on every run — editing an already-applied migration file makes the next run fail loudly (corrections go in a NEW migration). Rows without a checksum (the schema.sql seed, or history from before checksums shipped) are stamped from the files on first sight, so the first run after upgrading past migrate-hardening backfills the whole table; that run's burst of UPDATEs is expected.

```bash
# From the host (Node required):
DATABASE_URL=postgres://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
  npx tsx shared/src/db/migrate.ts
```

Always apply migrations through the runner — piping a file into `psql` directly leaves no `_migrations` row (and no checksum), so the runner later tries to re-apply it and dies on the already-existing objects. That bypass is exactly how the dev DB drifted (repaired 2026-07-06).

Verify (the seeded count must equal `ls migrations/*.sql | wc -l`):

```bash
docker exec platform-pub-postgres-1 psql -U platformpub platformpub -c "\dt"
docker exec platform-pub-postgres-1 psql -U platformpub platformpub -c "SELECT count(*) FROM _migrations;"
```

### 5. Build and start everything

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

Configures UFW (22, 80, 443), SSH key-only auth, certbot auto-renewal.

### 8. Seed data (staging / development only — never production)

```bash
ACCOUNT_KEY_HEX=<key-custody ACCOUNT_KEY_HEX> \
KMS_MASTER_KEY_HEX=<key-service KMS_MASTER_KEY_HEX> \
DATABASE_URL=postgres://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
  npx tsx scripts/seed.ts --clean          # default ~1000 users
# --small for 15 writers / 25 readers; --writers N --readers N --articles N to tune
```

`--clean` wipes seeded data (preserves the `billyisland` account). `ACCOUNT_KEY_HEX` is required to generate custodial keypairs; `KMS_MASTER_KEY_HEX` for vault keys on paywalled articles.

---

## Upgrading

> **Always: pull → migrate → build → up → reload nginx.** Skipping migrate leaves the schema stale; skipping `--build` (or running `up`/`restart` alone) leaves the image stale. Use `--no-cache` on a service if a rebuild appears to produce no change.
>
> One general caution from the 2026-07-06 deploy of migration 145: a migration that **DROPs a column the running image still reads** inverts this order for that one deploy (build → up → migrate), else every request touching the column 500s for the whole rebuild window. Check destructive migrations against the *currently-deployed* code, not the new code.

```bash
cd /root/platform-pub
git pull origin master

# 1. Apply ALL pending migrations (nothing runs them automatically)
DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@127.0.0.1:5432/platformpub \
  npx tsx shared/src/db/migrate.ts

# 2. Ensure new/required env vars are present in the relevant .env files
#    (e.g. LINKED_ACCOUNT_KEY_HEX in root .env for feed-ingest; ATPROTO_* if using Bluesky)

# 3. Rebuild changed services (or all of them) and recreate containers
docker compose build --no-cache web gateway feed-ingest
docker compose up -d

# 4. Reload nginx
docker compose exec nginx nginx -s reload
```

Verify:

```bash
docker ps --format "table {{.Names}}\t{{.Status}}"   # all (healthy) after ~30s
docker compose logs gateway --tail=20                # "Gateway started" — no boot errors
```

---

## Troubleshooting: feature not appearing after a rebuild

Symptom: code is on `master`, you pulled and rebuilt, but new front-end behaviour doesn't show.

1. **Confirm the running container actually has the new code.** Pick a string unique to the feature and grep the built output inside the container (the build lands at `/app/.next`, standard `next start`):

   ```bash
   docker compose exec web sh -c "grep -rl '<unique-string-from-the-feature>' /app/.next 2>/dev/null | head"
   ```

   - **Nothing returned** → the container is a stale build. You either built on the host, ran `up`/`restart` without `--build`, or hit a cached `next build` layer. Fix: `docker compose build --no-cache web && docker compose up -d web && docker compose exec nginx nginx -s reload`, then hard-refresh the browser.
   - **A file is returned** → the code is deployed; the issue is downstream (browser cache → hard-refresh/incognito, or the API not returning expected fields → check the relevant endpoint, or a missing migration → see below).

2. **Confirm the schema is migrated.** If a new feature's query selects a column that doesn't exist, the endpoint 500s rather than silently degrading:

   ```bash
   docker exec platform-pub-postgres-1 psql -U platformpub platformpub \
     -c "SELECT filename FROM _migrations ORDER BY filename DESC LIMIT 5;"
   ```

   If the latest migrations aren't listed, run the migration runner ([§4](#4-schema-and-migrations)).

3. **Confirm you're on the right surface.** Some affordances are viewport-gated (e.g. desktop hover modals vs touch action sheets) — test the right device before concluding a feature is missing.

---

## Database

### Schema

`schema.sql` is the from-scratch path, auto-applied on first postgres boot. It is kept in lockstep with `migrations/` (CI-enforced by `scripts/check-schema-drift.sh`) and ends with a `_migrations` seed so the runner is a no-op on a fresh DB. Regenerate it whenever you add a migration so fresh databases match migrated ones.

### Migrations

| Migration | Purpose |
| --------- | ------- |
| 001 | Email column on accounts; `magic_links` |
| 002 | Partial unique index for draft upserts |
| 003 | Comments/replies; `replies_enabled` |
| 004 | Media uploads (SHA-256 dedup) |
| 005 | Subscriptions, subscription_events, article_unlocks |
| 006 | `reader_pubkey` + `receipt_token` on read_events |
| 007 | `nostr_event_id` on subscriptions |
| 008 | Deduplicate articles; partial unique `(writer_id, nostr_d_tag) WHERE deleted_at IS NULL` |
| 009 | `notifications` table |
| 010 | `votes`, `vote_tallies`, `vote_charges` |
| 011 | `ciphertext` on `vault_keys` |
| 012 | `note_id` on notifications |
| 013 | Quoted-note excerpt fields on `notes` |
| 014 | Notification dedup index (superseded by 019) |
| 015 | `access_mode` on articles; unlock_type expansion |
| 016 | `direct_messages` (NIP-17 DMs) |
| 017 | `pledge_drives`, `pledges` |
| 018 | ON DELETE clauses for FKs in 016–017 |
| 019 | Fix notification dedup (partial unique `WHERE read = false`) |
| 020 | Notification routing columns |
| 021 | Missing ON DELETE clauses |
| 022 | Composite index on read_events |
| 023 | `auto_renew` on subscriptions |
| 024 | `subscription_period` on subscriptions |
| 025 | `is_comp` on subscriptions |
| 026 | Article profile pins |
| 027 | Subscription `hidden` |
| 028 | `subscription_nudge_log` |
| 029 | `gift_links` |
| 030 | Pledge-drive expansion columns |
| 031 | Media URL domain migration |
| 032 | `dm_likes`; mark stale message notifications read |
| 033 | Admin account IDs in platform_config |
| 034 | `reply_to_id` on direct_messages (threaded DM replies) |
| 035 | `feed_scores` + config rows |
| 036 | `parent_conversation_id` on pledge_drives |
| 037 | `subscription_offers`; offer columns on subscriptions |
| 038 | Publications: 7 tables, 2 enums, publication columns across articles/drafts/subscriptions/feed_scores |
| 039 | Default article price config |
| 040 | Traffology analytics schema (13 tables + Graphile Worker queue) |
| 041 | `stripe_webhook_events` dedup; ON DELETE CASCADE on subscription_events |
| 042 | Email-on-publish: subscriber opt-in |
| 043 | Session invalidation (reject JWTs issued before logout timestamp) |
| 044 | Email-on-publish v2: track per-article send |
| 045 | Article pricing mode (`per_article` / `per_1000_words`) |
| 046 | Notification preferences (per-category opt-out) |
| 047 | Bookmarks |
| 048 | Tags / topics for articles |
| 049 | Account deletion/deactivation + email/username change fields |
| 050 | Publication `homepage_layout` |
| 051 | Article scheduling (`article_drafts.scheduled_at`) |
| 052 | Universal Feed — external sources, subscriptions, items |
| 053 | `feed_items` unified timeline table (Universal Feed Phase 2) |
| 054 | Backfill `feed_items` from articles/notes/external_items |
| 055 | Universal Feed — Bluesky / AT Protocol ingestion config |
| 056 | Universal Feed — ActivityPub / Mastodon ingestion config |
| 057 | Universal Feed Phase 5 — outbound reply router |
| 058 | Phase 5B — migrate external Nostr outbound to `outbound_posts` queue |
| 059 | Phase 5B — AT Protocol OAuth session storage |
| 060 | Phase 5B — DB-backed atproto OAuth pending-state store |
| 061 | DB-backed resolver async results (replaces in-memory map) |
| 062 | Dedup `outbound_posts` |
| 063 | `external_sources` orphaned_at + GC column |
| 064 | Index on resolver_async_results (initiator_id, created_at DESC) |
| 065 | Trust Layer 1 — precomputed trust signals |
| 066 | Trust Phase 2 — vouches + trust_profiles |
| 067 | Trust Phase 4 — epoch tracking (aggregation + decay) |
| 068 | Article size tiers (lead / standard / brief) |
| 069 | Reading-position resumption |
| 070 | Harmonize size-tier trigger with backfill semantics |
| 071 | Make `stripe_webhook_events.processed_at` nullable |
| 072 | `expiry_warning_sent` on subscription_events |
| 073 | DM send id |
| 074 | Trigram GIN indexes on accounts.username + display_name |
| 075 | `external_sources.metadata_updated_at` |
| 076 | `relay_outbox` — durable queue for Nostr relay publishes |
| 077 | `feeds` + `feed_sources` (workspace slice 3) |
| 078 | `trust_polls` (workspace slice 15) |
| 079 | `trust_layer1.pip_status` gains `contested` (workspace slice 17) |
| 080 | `feed_saves` (workspace slice 20) |
| 081 | Article cover images (workspace slice 23b) |
| 082 | Default new source volume to step 5 |
| 083 | Search content trigram index |
| 084 | `accounts.email_verification_requested_at` |
| 085 | `tab_settlements.status` — three-phase settlement pattern |
| 086 | `reading_tabs` balance-non-negative CHECK |
| 087 | Schema hardening — indexes, FK cascades, updated_at triggers, feed_items score tiebreaker |
| 088 | Traffology `findOrCreateSource` race fix (unique constraint) |
| 089 | Workspace hardening — tag-name constraint + feed_sources query index |
| 090 | Engagement count columns on external_items |
| 091 | `external_items.is_context_only` |
| 092 | Interaction foundation (Phase 4A) |
| 093 | `external_items.content_warning` |
| 094 | External protocol expansion (enum values) |
| 095 | External protocol CHECK constraint update |
| 096 | Per-source ingest mailbox (email newsletter ingestion) |
| 097 | `feed_items.is_reply` — reply signalling + filtering (Card Behaviour Phase 1A) |
| 098 | Deterministic `feed_items.post_id` / `version` / `biddability_tier` + identity trigger (UNIVERSAL-POST Phase 0a) |
| 099 | `external_authors` identity table + `feed_items.external_author_id` (UNIVERSAL-POST Phase 0b) |
| 100 | `repost_edges` — boost detection + cross-source dedup (UNIVERSAL-POST Phase 0c) |
| 101 | Relay-free nostr identity — retire relay-bearing nostr cache (UNIVERSAL-POST C1 fix; data-only, no-op on a fresh DB) |

### Backup

```bash
docker exec platform-pub-postgres-1 pg_dump -U platformpub platformpub | gzip > backup-$(date +%Y%m%d).sql.gz
```

---

## Gateway route modules

All API routes are served by the gateway under `/api/v1` (except RSS, inbound mail, and AT Protocol well-knowns). The gateway registers the following route modules (see `gateway/src/index.ts`). The detailed endpoint tables for the core modules follow.

`auth`, `google-auth`, `signing`, `writers`, `articles` (incl. earnings, gate-pass, manage, publish, subscription-convert), `notes`, `drafts`, `replies`, `media`, `follows`, `moderation`, `search`, `rss`, `inbound-mail`, `subscriptions` (events, publication, settings, subscribers, writer), `unsubscribe`, `my-account`, `receipts`, `export`, `notifications`, `votes`, `history`, `gift-links`, `subscription-offers`, `messages`, `timeline`, `social`, `publications` (cms, core, members, public, revenue), `drives`, `traffology`, `bookmarks`, `tags`, `resolve`, `external-feeds`, `external-items`, `linked-accounts`, `trust`, `reading-positions`, `feeds` (workspace — mounted at `/api/v1/workspace`), `extract`, `author-card`.

Well-known / unprefixed: `GET /.well-known/oauth-client-metadata.json`, `GET /.well-known/jwks.json`, `GET /rss`, `GET /rss/:username`, `GET /health`.

### Auth

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| POST | /api/v1/auth/signup | — | Create account |
| POST | /api/v1/auth/login | — | Request magic link |
| POST | /api/v1/auth/verify | — | Verify magic link token |
| POST | /api/v1/auth/logout | session | Clear session |
| GET | /api/v1/auth/me | session | Current user info |
| PATCH | /api/v1/auth/profile | session | Update display name, bio, avatar URL |
| GET | /api/v1/auth/google | — | Google OAuth redirect |
| POST | /api/v1/auth/google/exchange | `{ code, state }` | Google OAuth code exchange |
| POST | /api/v1/auth/upgrade-writer | session | Start Stripe Connect |
| POST | /api/v1/auth/connect-card | session | Save reader payment method |

### Content & replies

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| POST | /api/v1/articles | session | Index published article |
| GET | /api/v1/articles/:dTag | optional | Article metadata by d-tag |
| POST | /api/v1/articles/:eventId/vault | session | Encrypt paywalled body, store vault key |
| POST | /api/v1/articles/:eventId/gate-pass | session | Paywall gate pass |
| POST | /api/v1/articles/:eventId/key | session | Issue wrapped content key after gate-pass |
| PATCH | /api/v1/articles/:id | session | Update article metadata |
| DELETE | /api/v1/articles/:id | session | Soft-delete + kind 5 to relay |
| POST | /api/v1/articles/:id/pin | session | Toggle profile pin |
| POST | /api/v1/notes | session | Index published note |
| DELETE | /api/v1/notes/:nostrEventId | session | Delete note + kind 5 |
| POST | /api/v1/drafts | session | Save/upsert draft (supports `scheduled_at`) |
| GET | /api/v1/drafts | session | List drafts |
| POST | /api/v1/media/upload | session | Upload image (≤12 MB) |
| POST | /api/v1/replies | session | Post a reply |
| GET | /api/v1/replies/:targetEventId | optional | Replies for an event (paywall-gated) |
| DELETE | /api/v1/replies/:replyId | session | Delete reply |

### Feed, discovery & universal feed

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| GET | /api/v1/feed?reach=following\|explore | session | Unified feed (reach dial). Items carry `isReply`, `biddabilityTier`. Module: `timeline.ts` (path is `/feed`, not `/timeline`) |
| GET | /api/v1/workspace/feeds | session | Owner-private workspace feed objects |
| GET | /api/v1/search?q=&type= | optional | Search articles, writers, publications |
| GET | /api/v1/resolve | optional | Universal identity/URL resolver |
| GET | /api/v1/extract | optional | Readability extraction for the reader pane |
| GET | /api/v1/author-card?type=&id= | session | Tier-aware author/source card for hover modals |
| GET/POST | /api/v1/external-feeds | session | External feed subscriptions (RSS, Nostr, Bluesky, Mastodon, email) |
| GET/POST | /api/v1/external-items/... | optional/session | External item context, parent, thread, engagement |
| GET/POST | /api/v1/linked-accounts | session | Outbound cross-posting account links |
| GET/POST | /api/v1/bookmarks | session | Save/list bookmarks (`/bookmarks/ids`) |
| GET | /api/v1/tags | optional | Tag/topic listing |
| GET/POST | /api/v1/me/reading-preferences | session | Reading-position + reader preferences |

### Trust

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| GET/POST | /api/v1/my/vouches | session | Vouch graph (Trust Phase 2) |
| GET | /api/v1/trust/... | optional/session | Trust Layer 1 signals, profiles, polls |

### Social, notifications & messages

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| POST/DELETE | /api/v1/follows/:writerId | session | Follow / unfollow |
| GET | /api/v1/follows, /follows/pubkeys, /follows/followers | session | Follow lists |
| POST | /api/v1/reports | session | Submit content report |
| GET/POST/DELETE | /api/v1/my/blocks, /my/mutes | session | Block / mute management |
| GET | /api/v1/notifications | session | Recent notifications (excludes DMs) |
| POST | /api/v1/notifications/read-all, /:id/read | session | Mark read |
| GET | /api/v1/unread-counts | session | Badge counts `{ notificationCount, dmCount }` |
| POST | /api/v1/conversations | session | Create DM conversation |
| GET | /api/v1/messages | session | Inbox |
| GET | /api/v1/messages/:conversationId | session | Conversation messages |
| POST | /api/v1/messages/:conversationId | session | Send DM (NIP-44; 10/min) |
| POST | /api/v1/dm/decrypt-batch | session | Batch-decrypt via key-custody |

### Votes, subscriptions, offers, drives

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| POST | /api/v1/votes | session | Cast vote (1st upvote free; price doubles thereafter) |
| GET | /api/v1/votes/tally, /votes/mine, /votes/price | optional/session | Tallies and server-authoritative price |
| POST/DELETE | /api/v1/subscriptions/:writerId | session | Subscribe / cancel |
| GET | /api/v1/subscriptions/mine, /check/:writerId, /subscribers | session | Subscription status / lists |
| PATCH | /api/v1/settings/subscription-price | session | Set price |
| POST/GET/DELETE | /api/v1/subscription-offers | session | Discount codes & gifted subscriptions |
| GET | /api/v1/subscription-offers/redeem/:code | optional | Public offer lookup |
| GET/POST | /api/v1/drives, /my/commissions, /my/pledges | session | Pledge drives / crowdfunding / commissions |
| POST/GET | /api/v1/gift-links | session | Capped shareable access tokens |

### Publications

The full publications surface is unchanged — create/get/patch/delete, members (invite/accept/role/remove), ownership transfer, CMS (submit/list/edit/publish/unpublish), public (`/publications/by-slug/:slug/articles`, masthead), subscriptions/follows, rate-card, payroll, earnings, and `GET /pub/:slug/rss`. See `gateway/src/routes/publications/`.

### Traffology

`GET /api/v1/traffology/feed | /piece/:id | /overview | /concurrent[/:id]` (session), and `POST /ingest/beacon` (public, 120/min/IP, proxied by nginx to traffology-ingest).

### Reader account & portability

`GET /api/v1/my/tab`, `GET /api/v1/my/account-statement` (session); `GET /api/v1/platform-pubkey` (public), `GET /api/v1/receipts/export` (session), `GET /api/v1/account/export` (writer).

---

## Nostr event types

| Kind | Type | Publisher | Purpose |
| ---- | ---- | --------- | ------- |
| 0 | Metadata | User (via key-custody) | Profile |
| 1 | Note | User | Short-form post |
| 3 | Contacts | User | Follow list |
| 5 | Deletion | User | Soft-delete article/note (published by gateway on delete) |
| 7003 | Subscription | Platform service key | Subscription status (provisional NIP-88) |
| 30023 | Long-form article | User or Publication | NIP-23 article; paywalled bodies carry `['payload', ciphertext, algorithm]` |
| 30024 | Draft | User | NIP-23 draft |
| 9901 | Receipt | Platform service key | Gate-pass receipt (HMAC reader hash public; actual pubkey in private DB copy) |

### Paywall content format

Paywalled bodies embed ciphertext in the kind 30023 event:

```
tag: ['payload', <base64 ciphertext>, 'xchacha20poly1305']
```

Format: `base64(nonce[24] || ciphertext_with_tag)`, XChaCha20-Poly1305 via `@noble/ciphers`. The content key is issued via `POST /api/v1/articles/:eventId/key` after gate-pass, NIP-44-wrapped to the reader's pubkey. Legacy articles used a kind 39701 vault event with AES-256-GCM; both remain decryptable — the `algorithm` field drives the path.

---

## Key custody

`key-custody` (port 3004) is the sole holder of all user and publication Nostr private keys and the only holder of `ACCOUNT_KEY_HEX`. The gateway calls it for `POST /keypairs/generate | /sign | /unwrap-nip44 | /nip44-encrypt | /nip44-decrypt`, all carrying `x-internal-secret`. Signing/encryption endpoints accept `signerId` + `signerType` (`account` | `publication`).

---

## Author migration export & receipt portability

- **Author export** (`GET /api/v1/account/export`, writer): migration bundle of content keys (NIP-44-wrapped to the writer's own pubkey) + per-article reader whitelists. Nostr events are fetchable from the relay and not duplicated.
- **Receipt export** (`GET /api/v1/receipts/export`, reader): signed kind 9901 events. A receiving host verifies via `GET /api/v1/platform-pubkey` + `verifyEvent`.

---

## Subscription system

1. Writers set a monthly price (£1–£100, default £5); annual periods supported.
2. Subscribers are charged immediately; access is immediate.
3. Active subscription unlocks all that writer's paywalled content at zero per-article cost.
4. Each subscription emits a kind 7003 Nostr event for federation.
5. Unlocks are permanent and survive cancellation; cancellation grants access until period end.

### Access-check priority

1. Own content → free
2. Publication member → free
3. Permanent unlock (`article_unlocks`) → free, key reissued
4. Active subscription (writer or publication) → free, creates permanent unlock + subscription_read log
5. Payment flow → charges reading tab, creates permanent unlock

---

## Starter-template feeds (new-user onboarding)

A brand-new account follows nobody, so it is seeded with a **clone of each operator-designated template feed** rather than a bare timeline (FEED-RETIREMENT-PLAN Slice 3). There is no admin UI — a template is just one of your own ordinary feeds flagged `feeds.is_starter_template = true`. Seeding runs **lazily** on a user's first workspace load (`GET /workspace/feeds` → `seedStarterFeeds`, advisory-locked, idempotent) and only when that account has **zero** feeds. Until ≥1 feed is flagged it is a no-op (the client then mints an empty default feed).

**Designate a template (on the server):**

```bash
cd /root/platform-pub
# prereq — confirm migration 114 applied (the flag column exists):
docker exec platform-pub-postgres-1 psql -U platformpub platformpub -c \
  "SELECT 1 FROM information_schema.columns WHERE table_name='feeds' AND column_name='is_starter_template';"
# find the feed's UUID (curate it in your workspace first):
docker exec platform-pub-postgres-1 psql -U platformpub platformpub -c \
  "SELECT f.id, f.name FROM feeds f JOIN accounts a ON a.id=f.owner_id WHERE a.username='<you>' ORDER BY f.sort_rank;"
# flag it:
docker exec platform-pub-postgres-1 psql -U platformpub platformpub -c \
  "UPDATE feeds SET is_starter_template = true WHERE id = '<feed-uuid>';"
```

Then sign up a fresh account to confirm it lands on a clone (`SELECT cloned_from_feed_id FROM feeds WHERE owner_id=<new user>` should equal the template's id). If the flag is set but a fresh account does **not** get the clone, the running gateway image predates the Slice 3 seeding code — `docker compose build gateway && docker compose up -d gateway`.

**Semantics to know:**

- **Live snapshot at seed time, not flag time.** The clone copies the template's `name`, `appearance`, and **current** `feed_sources` rows at the moment a user is seeded. Editing the template afterwards changes what *subsequent* signups receive; it never retro-updates an existing user's clone (the clone is an independent owned feed).
- **Source types matter for cold start.** `reach`/`following` clones in *empty* (a newcomer follows nobody). Use `reach`/`explore` + specific `account`/`publication`/`tag` and `external_source` rows for immediate content — those clone as literal references and resolve for everyone.
- **Multiple templates** allowed (each newcomer gets one clone of each, ordered by template `created_at`). Swap/disable with `UPDATE feeds SET is_starter_template = false WHERE id = '…';` — read live each first-load, no redeploy.
- **Not retroactive** — only accounts with zero feeds are seeded; existing users are untouched.

---

## Media uploads

`POST /api/v1/media/upload` resizes to max 1200px, converts to WebP (q80), then uploads the blob to the internal **Blossom** blob store via BUD-02 `PUT /upload` — the gateway signs a kind-24242 authorization event server-side with the uploader's custodial key (key-custody), and verifies Blossom's returned hash before recording the `media_uploads` row. nginx **proxies `/media/<sha256>.webp` → Blossom's `/<sha256>.webp` read-only** (1-year cache headers): the location is a quoted regex matching only hash-shaped paths, with `limit_except GET` (2026-07-09 audit fix — the earlier blanket proxy exposed Blossom's `PUT /upload`/`DELETE /<sha>` to the internet, and BUD-02 auth accepts any self-signed event, so internal-only reachability IS the access control; never widen this block). The stored/public URL (`PUBLIC_MEDIA_URL/<sha256>.webp`) is backend-independent. Max upload 12 MB (Fastify `bodyLimit` + `@fastify/multipart`). Blossom is pinned to `6.2.0` (v6 Deno config schema; internal-only, no published port; healthcheck uses `deno`, as the image ships no `wget`/`curl`). The `media_data` disk volume stays mounted **one soak cycle for rollback of *pre-cutover* blobs only** — post-cutover blobs exist solely in `blossom_data`, so a plain revert 404s them (a real rollback needs a Blossom→disk copy script that doesn't exist yet); `docs/adr/ADR-blossom-migration.md` Phase 4 removes the volume plus the dead disk code. Spec: that ADR.

**Deploying an `nginx.conf` change — reload/restart is NOT enough after `git reset`.** `nginx.conf` is bind-mounted `:ro` as a **single file**, so nginx pins the file's *inode* at container start. The prod pull path (`git reset --hard origin/master`) *replaces* the file with a **new inode**, so `nginx -s reload` and `docker compose restart nginx` keep reading the **stale pre-pull config** — the container is still bound to the old inode. **Recreate the container to re-bind:**

```bash
docker compose up -d --force-recreate nginx
docker compose exec nginx grep -A4 '/media/' /etc/nginx/nginx.conf   # confirm new block is live
# After the 2026-07-09 read-only fix, verify the lockdown took:
curl -s -o /dev/null -w '%{http_code}\n' -X PUT https://all.haus/media/upload      # expect 404 (falls through to web)
curl -sI https://all.haus/media/<any-known-sha256>.webp | head -1                  # expect 200
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE https://all.haus/media/<any-known-sha256>.webp  # expect 403
```

This bit the 2026-07-08 Blossom cutover: the new `/media/` proxy block was on disk + in git, but nginx kept serving the old `alias /app/media/` block, so freshly-uploaded (Blossom-only) images 404'd with a **text/html** 404 (nginx's own `try_files =404`, distinct from Blossom's `text/plain` 404) while disk-backed images still resolved — until the force-recreate. The same single-file-inode trap applies to any `nginx.conf` edit (e.g. the CSP note below).

**CSP and external video.** Feed video is fetched cross-origin from the source's own CDN (Bluesky `video.bsky.app`, Mastodon instance media, RSS enclosures), so the nginx `Content-Security-Policy` (`nginx.conf`) must keep `media-src 'self' blob: data: https:` and a `connect-src` that includes `https:`. The `blob:` is required for the `hls.js` MediaSource URL; `connect-src https:` is required for `hls.js` to fetch the `.m3u8` manifest + segments. Dropping either silently CSP-blocks all video and the player spins forever (the symptom is invisible in local dev, which runs Next.js directly with no nginx/CSP). **`nginx.conf` is bind-mounted `:ro` and read once at container start, so a CSP edit takes effect only after the nginx container is recreated — the routine `docker compose build web && up -d web` deploy does NOT touch nginx and leaves the old CSP live.** After pulling a `nginx.conf` change, run **`docker compose up -d --force-recreate nginx`** (a plain `restart`/`reload` re-reads the *stale* bind-mounted inode — see the note above) and confirm with `curl -sI https://all.haus/ | grep -i content-security-policy`. (This is exactly why the 2026-06-17 CSP fix appeared not to work: nginx was serving the pre-fix `media-src`-less / stripe-only-`connect-src` policy.)

---

## Frontend pages

The logged-in surface is **`/reader`**. The content routes below keep full pages for direct visits / SEO but open as Glasshouse **overlays** when reached from inside the app, and several legacy routes are now redirect shims into those overlays (FEED-RETIREMENT-PLAN; routing in `web/src/lib/workspace/overlays.ts`).

| Path | Purpose |
| ---- | ------- |
| / | Landing (redirects to /reader if logged in) |
| /reader | Primary logged-in surface — composed feed vessels (the one Post-model card path) + Glasshouse overlays (reader, profile, dashboard, settings, library, network, subscriptions, messages, notifications) |
| /feed → /reader | Redirect shim (legacy global Following/Explore feed retired) |
| /[username] | Writer profile (SSR, ISR 60s; opens as the profile overlay in-app) |
| /author/[id] | External-author profile (Post-model; profile overlay in-app) |
| /source/[id] | Source surface (Post-model; surface overlay in-app) |
| /tag/[tag] | Tag/topic listing (Post-model; surface overlay in-app) |
| /article/[dTag] | Article reader with paywall unlock (SSR, ISR 60s; reader overlay in-app) |
| /write | Article editor with paywall gate marker + scheduling (also the EditorOverlay) |
| /pub/[slug] (+ /about, /masthead, /subscribe, /archive) | Publication surfaces (surface overlay in-app; article rows open the reader) |
| /profile → /reader?overlay=settings | Redirect shim (identity folded into Settings) |
| /settings → /reader?overlay=settings | Redirect shim |
| /library (+ /bookmarks, /history, /reading-history) → /reader?overlay=library | Redirect shims — saved reading (Bookmarks / History) |
| /network (+ /followers, /social, /following) → /reader?overlay=network | Redirect shims — following/followers/blocked/muted/vouches + DM fees |
| /subscriptions → /reader?overlay=subscriptions | Redirect shim — external-subscription manager |
| /search → /reader | Redirect shim (search lives in the workspace dock) |
| /dashboard | Articles, drafts, pledge drives, offers, pricing, publications (dashboard overlay in-app) |
| /messages, /messages/[conversationId] | DM inbox + thread (messages overlay in-app) |
| /notifications | Notifications, excludes DMs (notifications overlay in-app) |
| /ledger | Account ledger + writer earnings (ledger overlay in-app) |

Other routes (not re-audited in the feed-retirement pass — verify against the route before relying on them):

| Path | Purpose |
| ---- | ------- |
| /account | Balance, transaction ledger, subscriptions, pledges |
| /subscribe/[code] | Subscription offer redemption |
| /auth, /auth/verify, /auth/google/callback | Signup/login, magic-link verify, Google OAuth callback |
| /admin, /admin/reports | Moderation/admin surfaces |
| /traffology, /traffology/overview, /traffology/piece/[pieceId] | Writer analytics |
| /invite/[token] | Publication invite acceptance |
| /about | About page |

---

## Operational commands

```bash
# Restart everything
docker compose down && docker compose up -d

# Rebuild a single service (force, then recreate + reload proxy)
docker compose build --no-cache gateway
docker compose up -d gateway
docker compose exec nginx nginx -s reload

# Logs
docker logs platform-pub-gateway-1 --tail 50 -f
docker logs platform-pub-feed-ingest-1 --tail 50 -f
docker logs platform-pub-web-1 --tail 50 -f

# DB query
docker exec platform-pub-postgres-1 psql -U platformpub platformpub -c "YOUR QUERY"

# Relay sanity check (browser console)
#   const ws = new WebSocket('wss://yourdomain.com/relay');
#   ws.onopen = () => ws.send(JSON.stringify(["REQ","t",{"limit":5}]));

# Certbot renewal
docker compose run --rm certbot renew && docker compose restart nginx
```

---

## Known limitations

- **Docker healthchecks** on some Alpine containers can report "unhealthy" due to a missing `wget`/`curl` in the image despite the service running correctly. The **Blossom** image (`6.2.0`) ships **only `deno`** — its healthcheck is a `deno eval` fetch, not `wget` (a `wget` probe silently never passes, which is why the old `:master` healthcheck was always red).
- **Stripe collection** must be configured (test/live keys + webhook secret) before real money flows; verify `payment_intent.succeeded` and `transfer.paid` webhooks are reaching `/webhooks/stripe`.
  - **nginx must proxy the route.** `webhookRoutes` is registered with **no prefix** (`payment-service/src/index.ts`), so the endpoint is `/webhooks/stripe`, *not* under `/api/`. `nginx.conf` carries a dedicated `location = /webhooks/stripe` block → `http://payment:3001` (set-var + shared resolver, same pattern as `/media/`); without it the path falls through to `location /` (web) and 404s, so Stripe never reaches the payment service. An `nginx.conf` edit needs a **force-recreate** to re-bind the single-file mount's inode (see the `/media/` note above) — `reload`/`restart` alone keep serving the stale config.
  - **Connect events must reach the endpoint.** `account.updated`, `account.application.deauthorized`, and `transfer.*` are emitted on *connected* accounts. They only reach `/webhooks/stripe` if the Stripe dashboard endpoint is set to **"Listen to events on Connected accounts."** Verify this in the dashboard — the code cannot enforce it. If instead you use a *separate* endpoint for Connect events, set `STRIPE_CONNECT_WEBHOOK_SECRET` to its secret (the verifier tries both). Without one of these, writer KYC/payability flips (incl. revocation) and tribute/publication transfer confirmations are silently never delivered.
  - **livemode guard.** The handler derives the expected mode from `STRIPE_SECRET_KEY` (`sk_live_`/`rk_live_` → live) and ignores (acks with 200, does not process) any event whose `livemode` disagrees — a misrouted test event can't touch live money state.
  - **Manual-review alert.** Partial refunds and *opened* disputes (`charge.dispute.created`) are **not** auto-reversed (the per-read model only unwinds full reversals). They log at WARN with a stable `event: "manual_review_required"` field (`kind: "partial_refund" | "dispute_opened"`). Configure a log alert on that marker so they're actioned manually; the raw events are also persisted in the `stripe_webhook_events` table.
- **Email sending** requires `EMAIL_PROVIDER` (postmark/resend); defaults to console logging. New Postmark broadcast streams are rate-limited — raise `BROADCAST_DAILY_SEND_LIMIT` gradually over 2–4 weeks.
- **Bluesky OAuth** features (link an existing account *and* the ASSISTED "set one up for me" flow) are disabled unless `ATPROTO_PRIVATE_JWK` is set on gateway + feed-ingest. On a public origin its absence makes the connect endpoint 502 (not a graceful skip). Generate the key once per environment and put it in the root `.env`:

  ```bash
  echo "ATPROTO_PRIVATE_JWK=$(npx tsx scripts/gen-atproto-jwk.ts)" >> .env
  docker compose up -d gateway feed-ingest    # recreate so they pick it up
  # verify: the public key is now served
  curl -s https://<host>/.well-known/jwks.json | head -c 200   # must NOT contain a "d" field
  ```
- **Cash-out-at-will** (writer-initiated payout) is not implemented; payouts run on the scheduled cycle.
- **NIP-07 browser extension** login is not built (all accounts are custodial).
- **Lightning/Cashu payments**, **federation/self-hosted packaging**, and the **Mostr bridge** are post-launch.

---

## Change log

### Consolidated update — 29 May 2026 (baseline ~v5.36.0)

> This entry consolidates the v5.30.0 → current window. Granular per-release notes for this window were not reconstructed; capability areas are anchored to their migrations and ADRs. All earlier per-release entries below are retained.

- **Universal Feed** (migrations 052–064, 075, 090–096; `docs/adr/UNIVERSAL-FEED-ADR.md`; new `feed-ingest` service). External source ingestion — RSS, ActivityPub/Mastodon, AT Protocol/Bluesky, external Nostr, and email newsletters — into a unified `feed_items` timeline; outbound cross-posting + reply router; AT Protocol OAuth (`private_key_jwt`); DB-backed identity resolver; external item context/parent/thread endpoints; engagement counts; content warnings. New env: `LINKED_ACCOUNT_KEY_HEX` (gateway + feed-ingest, must match), `ATPROTO_CLIENT_BASE_URL`, `ATPROTO_PRIVATE_JWK`.
- **Trust layer** (migrations 065–067, 078, 079; trust routes + `/network`). Layer 1 precomputed signals, vouches + trust profiles, epoch-based aggregation/decay, trust polls, contested PIP status.
- **Workspace experiment** (migrations 077, 080, 081, 089; `docs/adr/WORKSPACE-EXPERIMENT-ADR.md`; `/reader`, `WorkspaceView`/`VesselCard`; `/api/v1/workspace/feeds`). Merged to master 29 May 2026 (fast-forward).
- **Card behaviour** (migration 097; `docs/adr/CARD-BEHAVIOUR-ADR.md`, `CARD-BEHAVIOUR-BUILD-PLAN.md`). Phases 1–3 (25–26 May 2026): unified click region map, `is_reply` reply signalling, inline conversational-neighbourhood expansion, desktop author hover modal + touch action sheet. New: `feed_items.is_reply`, `timeline` response `isReply`/`biddabilityTier`, `GET /api/v1/author-card`, `AuthorModal`, `ActionSheet`, `NeighbourhoodCard`, `useNeighbourhood`, `useAuthorCard`.
- **Relay outbox** (migration 076). Durable queue for Nostr relay publishes; article rows and outbound events commit together.
- **Reading & product** (migrations 046–051, 068–070, 082–084, 088, 092). Notification preferences, bookmarks, tags, account deletion, publication homepage layouts, article scheduling, article size tiers, reading-position resumption, search trigram indexes, traffology source race fix, interaction foundation.
- **Settlement & schema hardening** (migrations 071, 085–087). Three-phase settlement status on `tab_settlements`, nullable webhook `processed_at`, non-negative reading-tab balance constraint, broad index/FK/trigger hardening.

### v5.30.0 — 13 April 2026

Per-1000-words article pricing, £-symbol fix, responsive editor toolbar. Migration 045. Services: gateway, web.

### v5.29.0 — 13 April 2026

Email-on-publish v2 (Phase 1): broadcast stream, two-step publish with opt-out, improved template, signed unsubscribe, daily send cap. Migration 044. Services: gateway, web. New env: `POSTMARK_BROADCAST_STREAM`, `EMAIL_FROM_BROADCAST`, `BROADCAST_DAILY_SEND_LIMIT`.

### v5.28.0 — 12 April 2026

Traffology analytics + security audit hardening: tracking script, ingest service, aggregation worker, source resolution, observation feed; Stripe idempotency keys, webhook deduplication, oEmbed timeout, key-service pubkey validation. Migrations 039–041. New services: traffology-ingest, traffology-worker. New env: `TRAFFOLOGY_INGEST_URL`, `IP_HASH_SALT`.

### v5.27.1 — 8 April 2026

Notification/DM badge reliability: 15s polling, mobile hamburger badge, mark-read race fix; rebrand cleanup to all.haus. No migration. Service: web.

### v5.26.0 — 7 April 2026

Media upload body-limit fix (`bodyLimit: 12 MB` on the upload route). No migration. Service: gateway.

### v5.25.0 — 7 April 2026

Paywall-gated comments, DM scroll-to-bottom, export download fix, nav cleanup, publication creation UI. No migration. Services: gateway, web.

### v5.24.0 — 7 April 2026

CI pipeline (build, ESLint, Knip, Vitest, `next lint`, `npm audit`), backend ESLint, pre-push hook. No migration.

### v5.23.0 — 7 April 2026

FeaturedWriters build fix (removed `feed.featured()` reference). No migration. Service: web.

### v5.22.0 — 7 April 2026

Audit fixes: gate-pass publication access (critical), `schema.sql` ON DELETE sync, publication article kind 5 deletion, dead-code removal, editor polish. Service: gateway, web.

### v5.21.0 — 7 April 2026

Gateway crash fix: duplicate route collision on publication articles (`/publications/by-slug/:slug/articles`). No migration. Services: gateway, web.

> Older entries (v5.20.0 and earlier) are available in this file's git history.

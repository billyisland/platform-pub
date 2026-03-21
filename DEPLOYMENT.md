# platform.pub — Deployment Reference v3.1.4

**Date:** 21 March 2026
**Replaces:** v3.1.3 (see bottom for change log)

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
| payment | ./payment-service/Dockerfile | 3001 (localhost only) | Stripe, settlement, payouts |
| keyservice | ./key-service/Dockerfile | 3002 (localhost only) | Vault encryption, NIP-44 key issuance |
| key-custody | ./key-custody/Dockerfile | 3004 (localhost only) | Custodial Nostr keypair service |
| web | ./web/Dockerfile | 3010→3000 | Next.js frontend |
| nginx | nginx:alpine | 80, 443 | Reverse proxy, TLS, static media |
| blossom | ghcr.io/hzrd149/blossom-server:master | 3003 (localhost only) | Nostr media federation |
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
| `SESSION_SECRET` | gateway | JWT signing key (min 32 chars) |
| `COOKIE_SECRET` | gateway | Cookie signing (can equal SESSION_SECRET) |
| `PLATFORM_SERVICE_PRIVKEY` | gateway, payment, key-service | 64-hex Nostr private key for platform service events |
| `READER_HASH_KEY` | gateway | HMAC key for reader pubkey privacy hashing |
| `INTERNAL_SECRET` | gateway, key-custody | Shared secret authenticating gateway→key-custody calls |
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
openssl rand -hex 32   # SESSION_SECRET, COOKIE_SECRET, READER_HASH_KEY
openssl rand -hex 32   # ACCOUNT_KEY_HEX (key-custody only)
openssl rand -hex 32   # KMS_MASTER_KEY_HEX (key-service only)
openssl rand -base64 32  # INTERNAL_SECRET (gateway + key-custody)
openssl rand -base64 32  # INTERNAL_SERVICE_TOKEN (payment-service cron auth)
# For PLATFORM_SERVICE_PRIVKEY: generate a Nostr keypair — any hex ed25519 privkey
```

### 3. Start infrastructure

```bash
docker compose up -d postgres strfry
docker compose ps   # wait for postgres to be healthy
```

### 4. Apply schema and migrations

The base schema is auto-applied on first postgres boot via the `initdb.d` volume mount. Then run all migrations:

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

You should see 18+ tables.

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

Run all pending migrations:
```bash
npx tsx shared/src/db/migrate.ts
```
Or manually per file:
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
| GET | /api/v1/auth/me | session | Current user info |
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
| DELETE | /api/v1/articles/:id | session | Delete article |
| POST | /api/v1/notes | session | Index published note |
| DELETE | /api/v1/notes/:nostrEventId | session | Delete note |
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

### Subscriptions
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | /api/v1/subscriptions/:writerId | session | Subscribe (charges immediately) |
| DELETE | /api/v1/subscriptions/:writerId | session | Cancel |
| GET | /api/v1/subscriptions/mine | session | List my subscriptions |
| GET | /api/v1/subscriptions/check/:writerId | session | Check subscription status |
| GET | /api/v1/subscribers | session | List my subscribers (writer) |
| PATCH | /api/v1/settings/subscription-price | session | Set subscription price |

### Portability & federation
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | /api/v1/platform-pubkey | — | Platform's Nostr signing pubkey (for receipt verification) |
| GET | /api/v1/receipts/export | session | Reader's portable receipt tokens (signed kind 9901 events) |
| GET | /api/v1/account/export | session (writer) | Author migration bundle: content keys + receipt whitelist |

### Public
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | /api/v1/writers/:username | optional | Writer profile |
| GET | /api/v1/writers/:username/articles | optional | Writer's articles |
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
| 5 | Deletion | User (via key-custody) | Soft-delete article or note |
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
| /feed | Sticky composer + For you / Following / Add tabs |
| /following | Writers you follow, with unfollow action |
| /followers | Accounts who follow you |
| /write | Article editor with paywall gate marker |
| /article/:dTag | Article reader with paywall unlock |
| /:username | Writer profile |
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
- "For You" feed tab returns the same feed as Following — personalised ranking not yet implemented
- RSS feed ingestion not yet built
- Notification centre not yet built
- NIP-07 browser extension support not yet built
- Cash-out-at-will (writer-initiated payout) not yet implemented
- Stripe payment collection not yet live — free allowance goes negative as a testing workaround
- Email sending requires configuring `EMAIL_PROVIDER` — defaults to console logging

---

## Change log

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

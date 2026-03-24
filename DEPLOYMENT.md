# platform.pub — Deployment Reference v3.12.0

**Date:** 24 March 2026
**Replaces:** v3.11.0 (see bottom for change log)

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

You should see 23+ tables.

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
| /article/:dTag | Article reader with paywall unlock |
| /:username | Writer profile (public) |
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

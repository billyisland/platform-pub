# all.haus

A publishing and social platform for writers and readers, built on Nostr. Writers own their identity, audience, and content. Readers pay across all the writers they read via a shared reading tab.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Web Client (Next.js + NDK)                         │
│  ├── Reading experience + paywall gate UI           │
│  ├── Article editor (TipTap + draggable gate)       │
│  ├── Social feed (Following + For You)              │
│  ├── Commenting (threaded, per-piece toggleable)    │
│  ├── Media (Blossom images + oEmbed rich embeds)    │
│  └── Editorial dashboard (articles, drafts, earnings)│
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  API Gateway (Fastify)                     port 3000│
│  ├── Session management (JWT + httpOnly cookies)    │
│  ├── Auth routes (signup, magic link, Google OAuth) │
│  ├── Comments (CRUD, threading, author toggles)     │
│  ├── Media (Blossom upload proxy, oEmbed proxy)     │
│  ├── Article management (list, edit, soft-delete)   │
│  ├── Stripe Connect + card onboarding               │
│  └── Proxy to internal services                     │
└───────┬─────────────────────────┬───────────────────┘
        │                         │
┌───────▼──────────┐    ┌────────▼─────────┐
│ Payment Service  │    │ Key Service      │
│         port 3001│    │        port 3002 │
│ ├── Accrual      │    │ ├── Vault encrypt│
│ ├── Settlement   │    │ ├── Key issuance │
│ ├── Payout       │    │ └── NIP-44 wrap  │
│ └── Receipts     │    └──────────────────┘
└──────────────────┘
        │                         │
┌───────▼─────────────────────────▼───────────────────┐
│  PostgreSQL                                         │
│  (shared database — app-layer index + billing)      │
└─────────────────────────────────────────────────────┘
        │
┌───────▼─────────────────────────────────────────────┐
│  strfry (Nostr Relay)                      port 4848│
│  (canonical event store — articles, vaults, receipts)│
└─────────────────────────────────────────────────────┘
        │
┌───────▼─────────────────────────────────────────────┐
│  Blossom (Media Server)                    port 3003│
│  (content-addressed image storage)                   │
└─────────────────────────────────────────────────────┘
```

## What's built

| Component | Status |
|-----------|--------|
| PostgreSQL schema (18 tables) | ✅ Complete |
| Payment service (accrual, settlement, payout) | ✅ Complete |
| Key service (vault encryption, key issuance, NIP-44) | ✅ Complete |
| Community standards document | ✅ Complete |
| Shared db client (pool, transactions, config) | ✅ Complete |
| Auth (sessions, custodial keypairs, magic links, Google OAuth) | ✅ Complete |
| Email service (Postmark, Resend, console) | ✅ Complete |
| API gateway (auth, signing, articles, writers, follows) | ✅ Complete |
| Comments (threaded, per-piece toggle, author moderation) | ✅ Complete |
| Media uploads (Blossom image upload, oEmbed proxy) | ✅ Complete |
| Article management (edit via republish, soft-delete) | ✅ Complete |
| Moderation (reports, content removal, account suspension) | ✅ Complete |
| RSS feeds (per-writer + platform-wide) | ✅ Complete |
| Search (trigram-powered articles + writers) | ✅ Complete |
| Web client (Next.js + NDK + TipTap + Stripe Elements) | ✅ Complete |
| Article editor with draggable paywall gate | ✅ Complete |
| Editor image upload (drag-and-drop, paste, file picker) | ✅ Complete |
| Editor rich embeds (YouTube, Vimeo, Twitter/X, Spotify) | ✅ Complete |
| Paywall gate UI (4 reader states) | ✅ Complete |
| Full vault decryption pipeline (Web Crypto) | ✅ Complete |
| Editorial dashboard (articles, drafts, earnings tabs) | ✅ Complete |
| Feed (following-filtered + For You placeholder) | ✅ Complete |
| Writer profile pages | ✅ Complete |
| Docker compose (Postgres, strfry, Blossom, all services) | ✅ Complete |
| Migration runner + 4 migrations | ✅ Complete |
| NIP-23 markdown renderer (remark/rehype + Nostr URIs + embeds) | ✅ Complete |

## What's next (non-code)

| Item | Type |
|------|------|
| CCA legal sign-off (tab model) | 🔴 Legal — launch-blocking |
| Stripe test/live keys configured | 🔴 Ops — launch-blocking |
| Email provider configured (Postmark/Resend) | 🟡 Ops |
| Domain + DNS + TLS | 🟡 Ops |
| Launch cohort recruitment (20-30 writers) | 🔴 Business |
| For You feed ranking algorithm | ⚪ Post-launch |
| Lightning/Cashu payments | ⚪ Post-launch |
| Federation + self-hosted packaging | ⚪ Post-launch |
| Mostr bridge | ⚪ Post-launch |

## Local development

```bash
# Start infrastructure
docker compose up -d postgres strfry blossom

# Run migrations
DATABASE_URL=postgresql://platformpub:password@localhost:5432/platformpub \
  npx tsx shared/src/db/migrate.ts

# Start services (each in a separate terminal)
cd gateway && npm run dev
cd payment-service && npm run dev
cd key-service && npm run dev
```

### Environment variables

Copy `.env.example` files in each service directory. Key secrets to generate:

```bash
# Session secret (gateway)
openssl rand -base64 48

# Account keypair encryption key (gateway)
openssl rand -hex 32

# Vault KMS key (key-service)
openssl rand -hex 32

# Platform service Nostr keypair (payment + key service)
node -e "const {generateSecretKey}=require('nostr-tools'); console.log(Buffer.from(generateSecretKey()).toString('hex'))"
```

## Key decisions

- **Relay**: strfry — C++, fast, full NIP coverage, negentropy sync for federation
- **Media**: Blossom — Nostr-native, content-addressed, SHA-256 deduplication
- **Editor**: TipTap — ProseMirror-based, good DX, markdown I/O, extensible for gate widget + image upload + embeds
- **Auth**: Passwordless magic links + Google OAuth; custodial Nostr keypairs for all users
- **Sessions**: JWT in httpOnly secure cookies, 7-day lifetime, silent refresh at half-life
- **Comments**: Nostr kind 1 events with e/p tags, indexed in platform DB for threaded display
- **Article editing**: Nostr replaceable events (same d-tag, new event)
- **Article deletion**: Soft-delete in DB + Nostr kind 5 deletion event

See `platform-pub-adr-v07.docx` for the full architectural decision record.

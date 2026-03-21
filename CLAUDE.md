# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A publishing and social platform for writers built on the [Nostr protocol](https://nostr.com). Writers own their identity, audience, and content via cryptographic keypairs. Readers pay for paywalled content via a shared reading tab, with payments distributed to writers through Stripe Connect. Think Substack, but decentralized.

## Development Commands

### Infrastructure (start first)
```bash
docker compose up -d postgres strfry blossom

# Run DB migrations
DATABASE_URL=postgresql://platformpub:password@localhost:5432/platformpub npx tsx shared/src/db/migrate.ts
```

### Start services (each in its own terminal)
```bash
cd gateway && npm run dev          # port 3000
cd payment-service && npm run dev  # port 3001
cd key-service && npm run dev      # port 3002
cd key-custody && npm run dev      # port 3004
cd web && npm run dev              # port 3010 (rewrites to gateway)
```

### Build
```bash
cd <service> && npm run build   # tsc (gateway, payment-service, key-service, shared)
cd web && npm run build         # next build
```

### Test
```bash
cd <service> && npm test        # vitest run (one-shot)
cd <service> && npm run test:watch  # vitest (watch mode)
```
No test files exist in `web/` — frontend is tested manually/e2e.

### Lint
```bash
cd web && npm run lint   # next lint (only web has ESLint config)
# Other services: tsc --noEmit catches type errors
```

## Architecture

### Services
| Service | Port | Responsibility |
|---|---|---|
| `gateway` | 3000 | Main API: auth, articles, comments, search, RSS, moderation |
| `payment-service` | 3001 | Reading tab accrual, Stripe billing, writer payouts |
| `key-service` | 3002 | Vault key management, NIP-44 key issuance to readers |
| `key-custody` | 3004 | Custodial keypair service: generates, stores, and uses user Nostr private keys |
| `web` | 3010 | Next.js 14 App Router frontend |
| `strfry` | 4848 | Nostr relay (C++, stores NIP-23 events, vaults, receipts) |
| `blossom` | 3003 | Content-addressed image storage (SHA-256) |
| `shared` | — | Shared TypeScript library: DB pool, auth, sessions, email, migrations |

### Request flow
The Next.js frontend proxies all `/api/*` calls to the gateway (`next.config.js` rewrites). The gateway calls `payment-service`, `key-service`, and `key-custody` as internal services. All backend services share the same PostgreSQL database via `shared/src/db/client.ts`.

### Nostr integration
- Articles are published as **NIP-23 kind 30023** (long-form) replaceable events — same `d-tag`, new event ID on edit
- Drafts: kind 30024; Vaults (encrypted paywall content): kind 39701; Receipts: kind 9901
- Deletion: soft-delete in DB + Nostr kind 5 deletion event for federation
- Auth uses custodial keypairs: platform generates and stores an encrypted Nostr keypair per user, kept in `accounts.custodial_privkey` (AES-256-GCM encrypted with `KEYPAIR_ENCRYPTION_KEY`)

### Paywall / billing flow
1. **Provisional read** — reader passes the gate using their free allowance (£5 default per `accounts.free_allowance_pence`)
2. **Tab accrual** — `reading_tabs` balance accumulates per reader; `read_events` tracks each article read
3. **Settlement** — when tab hits threshold (~£20) or monthly, reader's card is charged via Stripe; `tab_settlements` records the charge with platform fee split
4. **Payout** — background worker in `payment-service/src/workers/payout.ts` distributes to writers via Stripe Connect; `writer_payouts` tracks status

### Vault encryption
Paywalled articles encrypt content with AES-256-GCM. The content key is stored in `vault_keys` (encrypted at rest with the platform KMS key from `KMS_KEY` env var). When a reader pays, `key-service` verifies payment and issues the content key wrapped with **NIP-44** (ChaCha20-Poly1305) to the reader's Nostr pubkey. Issuances are logged in `content_key_issuances`.

### Session management
JWT tokens in httpOnly secure cookies, 7-day lifetime, silent refresh at 3.5 days. Session creation/verification lives in `shared/src/auth/session.ts`.

### Frontend state
Zustand stores in `web/src/stores/`. The TipTap editor (`web/src/components/editor/`) supports markdown I/O, a draggable paywall gate, image upload to Blossom, and rich oEmbed embeds.

## Key Environment Variables

| Variable | Service | Purpose |
|---|---|---|
| `DATABASE_URL` | all | PostgreSQL connection string |
| `SESSION_SECRET` | gateway | JWT signing key |
| `ACCOUNT_KEY_HEX` | key-custody | AES key for custodial Nostr privkeys — key-custody only |
| `STRIPE_SECRET_KEY` | gateway, payment | Stripe API key |
| `KMS_MASTER_KEY_HEX` | key-service | Platform key for vault key encryption |
| `KEY_SERVICE_URL` | gateway | Internal URL for key-service |
| `KEY_CUSTODY_URL` | gateway | Internal URL for key-custody service |
| `PAYMENT_SERVICE_URL` | gateway | Internal URL for payment-service |
| `INTERNAL_SECRET` | gateway, key-custody | Shared secret for internal service calls |
| `RELAY_URL` | payment, key | strfry WebSocket URL |

See each service's `.env.example` for the full list.

## Database

Schema is in `schema.sql` (canonical) with incremental migrations in `migrations/`. Key tables:
- **accounts** — users (readers and/or writers), Nostr pubkey, encrypted privkey, Stripe IDs, free allowance
- **articles** — published NIP-23 events, paywall config (price, gate position %), vault event ID
- **reading_tabs / read_events / tab_settlements / writer_payouts** — the four-stage billing pipeline
- **vault_keys / content_key_issuances** — encryption key storage and audit log
- **subscriptions** — per-writer monthly subscriptions with permanent unlock support (migration 005)

Multi-step operations use `withTransaction(client => ...)` from `shared/src/db/client.ts`.

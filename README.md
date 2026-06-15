# all.haus

A publishing and social platform for writers and readers, built on Nostr. Writers
own their identity, audience, and content via custodial Nostr keypairs. Readers pay
across all the writers they read via a shared reading tab. The site is a **universal
social reader** — alongside native articles and notes it ingests RSS/Atom, external
Nostr, Bluesky, and Mastodon/threadiverse into one workspace timeline — and a
**multi-protocol identity layer**: every account is born a Nostr root and can grow
satellite presences on other networks.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Web Client — Next.js workspace (NDK + TipTap + Stripe)       │
│  ├── Multi-feed workspace canvas + reader overlay            │
│  ├── Article editor (TipTap + draggable paywall gate)       │
│  ├── Universal feed (native + RSS / Bluesky / Mastodon …)   │
│  ├── Short-form notes, reply threads, DMs, notifications    │
│  └── Editorial dashboard (articles, drafts, earnings)       │
└──────────────────────────────┬───────────────────────────────┘
                               │  Nginx → /api/* gateway, / web
┌──────────────────────────────▼───────────────────────────────┐
│  API Gateway (Fastify)                              port 3000 │
│  auth · sessions · articles · feeds · comments · votes ·      │
│  media · search · moderation · Stripe Connect · NIP-05        │
└──┬──────────────┬──────────────┬───────────────┬──────────────┘
   │              │              │               │
┌──▼────────┐ ┌───▼───────┐ ┌────▼────────┐ ┌────▼─────────────┐
│ Payment   │ │ Key       │ │ Key Custody │ │ Feed Ingest      │
│ port 3001 │ │ port 3002 │ │ port 3004   │ │ (worker, no HTTP)│
│ accrual · │ │ NIP-44    │ │ holds priv. │ │ Graphile +       │
│ settle ·  │ │ vault     │ │ keys; signs │ │ Jetstream;       │
│ payout    │ │ wrap/issue│ │ + key export│ │ RSS/atproto/AP   │
└───────────┘ └───────────┘ └─────────────┘ └──────────────────┘
   │              │              │               │
┌──▼──────────────▼──────────────▼───────────────▼──────────────┐
│  PostgreSQL — shared (index · billing · feed timeline)  :5432  │
└───────────────────────────────────────────────────────────────┘
        │
┌───────▼────────────────┐   ┌──────────────────────────────────┐
│ strfry relay     :4848  │   │ Blossom media            :3003   │
│ canonical Nostr events  │   │ content-addressed image storage  │
└─────────────────────────┘   └──────────────────────────────────┘
```

## What's built

The system has grown well beyond the original article-publishing core. Grouped by
subsystem; ✅ = built and in use, 🛑 = built but slated to park. The 2026-06-15
architecture audit (`docs/adr/ARCHITECTURE-AUDIT-ADR-2026-06-15.md`) and its
spade-ready execution plans (`docs/adr/ARCHITECTURE-AUDIT-IMPLEMENTATION-PLAN-2026-06-15.md`)
record the outstanding structural work — unified money ledger, gateway god-file
splits, outbound-retry helper, DM reactions, and parking trust + traffology.

**Platform & infrastructure**

| Component | Status |
|-----------|--------|
| PostgreSQL shared schema (~90 tables) + migration runner (117 migrations) | ✅ |
| Shared db client (pool, transactions, config), schema-drift CI guard | ✅ |
| Docker compose — Postgres, strfry relay, Blossom, gateway, payment, key, key-custody, feed-ingest | ✅ |
| strfry Nostr relay (canonical event store) | ✅ |
| SSRF-hardened outbound HTTP/WS client | ✅ |

**Identity, auth & interop**

| Component | Status |
|-----------|--------|
| Auth — magic links, Google OAuth, JWT httpOnly cookies, silent refresh | ✅ |
| Custodial Nostr keypairs; key-custody isolates private keys (sign + export) | ✅ |
| Key service — NIP-44 vault wrap/issuance for gated content | ✅ |
| Network presences — Nostr root + linked/assisted satellites (Bluesky/atproto, Mastodon/ActivityPub) | ✅ |
| Outbound discovery — NIP-05 + kind 0/3/10002, behind operator + per-user opt-in | ✅ |
| Account export (nsec via key-custody) | ✅ |

**Publishing & content**

| Component | Status |
|-----------|--------|
| Article editor — TipTap, draggable paywall gate, image upload, rich embeds (YouTube/Vimeo/X/Spotify) | ✅ |
| Article management — edit via Nostr replaceable events, soft-delete (kind 5 tombstone) | ✅ |
| NIP-23 markdown renderer (remark/rehype + Nostr URIs + embeds) | ✅ |
| Short-form notes + compose surfaces (note / reply / quote) | ✅ |
| Publications — multi-writer, payout splits, masthead/archive | ✅ |
| Relay outbox — durable publish queue + retry worker | ✅ |

**Universal feed (external ingest)**

| Component | Status |
|-----------|--------|
| Feed-ingest service — Graphile Worker + Jetstream listener | ✅ |
| Adapters — RSS/Atom/JSON, external Nostr, Bluesky (atproto), Mastodon/Lemmy (ActivityPub), email | ✅ |
| Unified `feed_items` timeline (transactional dual-write) | ✅ |
| Universal resolver — `POST /resolve` (URL / handle / email / npub / DID) | ✅ |
| Outbound posting to foreign protocols (`outbound_posts`) | ✅ |

**Social & reading**

| Component | Status |
|-----------|--------|
| Workspace — multi-feed canvas, cards, reply threads, reader overlay (web + mobile) | ✅ |
| Comments / reply threads (flat playscript), per-piece toggle, author moderation | ✅ |
| Votes, bookmarks, reposts, quotes | ✅ |
| Direct messages (conversations, paid DMs) + merged notifications inbox | ✅ |
| Search (trigram-powered articles + writers) | ✅ |
| Moderation (reports, content removal, account suspension) | ✅ |
| RSS output feeds (per-writer + platform-wide) | ✅ |
| Full vault decryption pipeline (Web Crypto) | ✅ |
| Editorial dashboard (articles, drafts, earnings) | ✅ |

**Payments**

| Component | Status |
|-----------|--------|
| Reading tab (accrual) → settlement (Stripe) → payout (Stripe Connect) | ✅ |
| Writer + publication payouts and splits | ✅ |
| Vote charges, pledges, DM pricing | ✅ |

**Trust & analytics**

| Component | Status |
|-----------|--------|
| Trust graph — Layer 1 signals, Layer 2 vouches, Layer 4 relational, TrustPip glyph | 🛑 slated to park |
| Traffology — reader telemetry (ingest + roll-up worker + dashboards) | 🛑 slated to park |

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
- **Universal feed**: external content (RSS/Atom, Nostr, Bluesky, Mastodon, email) ingested into one `feed_items` timeline; one card grammar over native + external
- **Identity**: every account is born a Nostr root; other networks are satellite presences (linked / assisted / concierge custody tiers)
- **Relay outbox**: every signed event is durably queued in-transaction; a worker owns publish + retry, so relay blips never surface as 5xx
- **Workspace**: the product is a multi-feed workspace (`/reader`) with frosted overlays, not a page-based site

See `CLAUDE.md` for sitewide standards and `docs/adr/` for the full set of architectural decision records (start with `docs/adr/UNIVERSAL-POST-ADR.md` and `docs/adr/UNIVERSAL-FEED-ADR.md`). The current structural work-in-flight is tracked in `docs/adr/ARCHITECTURE-AUDIT-IMPLEMENTATION-PLAN-2026-06-15.md`.

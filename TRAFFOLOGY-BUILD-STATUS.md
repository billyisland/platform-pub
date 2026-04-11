# Traffology Build Status

**Last updated:** 11 April 2026
**ADR:** `TRAFFOLOGY-MASTER-ADR-2.md`
**UI prototype:** `provenance-ikb.jsx` (Piece view with op-art IKB bars)

---

## What's done

### Phase 1, Step 2 — Data model and aggregation

The aggregation layer is complete. Background jobs materialise session data into stats tables, resolve traffic sources, and compute baselines.

**New service: `traffology-worker/`** (Graphile Worker, no HTTP port — pure background process)
- Hourly job (`aggregate_hourly`) — materialises `piece_stats`, `source_stats`, and `half_day_buckets` from session data. Also computes per-writer ranking (all-time and this-year).
- Daily job (`aggregate_daily`) — materialises `writer_baselines` and `publication_baselines` (rolling means for first-day readers, reading time, open rate, lifespan, subscriber counts, revenue).
- Weekly job (`aggregate_weekly`) — materialises `topic_performance` (per-topic per-writer aggregates from piece tags).
- Source resolution (`resolve_source`) — batch-resolves unresolved sessions into `traffology.sources` rows using the 5-step enrichment pipeline from ADR Section 4.1:
  1. Platform-internal (all.haus URLs → writer display name via accounts table)
  2. Nostr (deferred to Phase 2, Nostr client domains handled via known-domains)
  3. Known domain lookup table (~120 entries: search engines, social platforms, email, Nostr clients, AI tools, news aggregators, developer sites)
  4. Shortener redirect following (HEAD request with 3s timeout, fallback to known platform)
  5. Raw domain fallback
- UTM parameter handling: `utm_medium=email` or `utm_source=newsletter` → mailing-list source type
- Queued automatically before each hourly aggregation; also callable for individual sessions

**Infrastructure wiring:**
- `docker-compose.yml` — traffology-worker service added (depends on postgres, no port)
- Graphile Worker manages its own `graphile_worker.*` tables in PostgreSQL
- Crontab: hourly at :05, daily at 00:15 UTC, weekly Monday 01:00 UTC

### Phase 1, Step 1 — Page script + ingest service (commit `fddf52b`)

The collection layer is complete. Everything needed to start generating session data from article page views.

**New service: `traffology-ingest/`** (Fastify, port 3005)
- `POST /beacon` — receives init/heartbeat/unload beacons from the page script
- `GET /concurrent/:pieceId` — in-memory live reader count (5-min sliding window)
- `GET /concurrent/writer/:writerId` — aggregated live counts for all writer's pieces
- Lazy-creates `traffology.pieces` rows from `public.articles` on first beacon
- Hashes IPs with SHA-256 + salt (never stores raw IPs), geoip-lite for country/city, ua-parser-js for device type

**Page script: `web/public/traffology.js`** (~1.5KB gzipped)
- Injected on article pages via `<Script strategy="afterInteractive">`
- Tracks scroll depth, active reading time (pauses when tab hidden or idle >30s)
- Sends beacons via `navigator.sendBeacon('/ingest/beacon')` — fire-and-forget
- Session token per-tab via `sessionStorage` + `crypto.randomUUID()` (no cookies)
- Subscriber status read from data attribute set by `TraffologyMeta` client component

**Database: `migrations/040_traffology_schema.sql`**
- Full `traffology` schema with all 13 tables from the ADR
- Core tables populated by this step: `pieces`, `sessions`
- Empty tables ready for later steps: `sources`, `nostr_events`, `public_mentions`, `piece_stats`, `source_stats`, `half_day_buckets`, `writer_baselines`, `publication_baselines`, `topic_performance`, `observations`

**Infrastructure wiring:**
- `docker-compose.yml` — traffology-ingest service added
- `nginx.conf` — `/ingest/` location block proxying to ingest service
- `gateway/src/routes/traffology.ts` — authenticated proxy for concurrent counts
- `gateway/src/index.ts` — traffologyRoutes registered

---

## What's next

### Phase 1, Step 3 — Interpretation layer + feed

Build together (per ADR Section 0):

1. **Interpreter job (`interpret`).** Runs after each aggregation cycle. Reads aggregated data, applies trigger conditions from ADR Section 5.2 (the observation taxonomy), and writes `traffology.observations` records. Start with the highest-value observation types:
   - `ARRIVAL_CURRENT` / `ARRIVAL_NONE` (live reader counts)
   - `FIRST_DAY_SUMMARY` (end of first calendar day)
   - `SOURCE_NEW` (new source detected)
   - `SOURCE_BREAKDOWN` (first-day source split)
   - `ANOMALY_HIGH` / `ANOMALY_LOW` (first-day readers vs baseline)
   - `MILESTONE_READERS` (100, 500, 1k, 5k, 10k thresholds)

2. **Feed API.** New gateway routes:
   - `GET /traffology/feed` — paginated observations for the authenticated writer
   - `GET /traffology/piece/:pieceId` — piece detail (stats + filtered observations)
   - `GET /traffology/overview` — publication-level summary

3. **Feed UI.** Three new pages in the Next.js app (per ADR Section 7.1):
   - `/traffology` — The Feed (reverse-chronological observation stream)
   - `/traffology/piece/:pieceId` — The Piece (summary strip + provenance diagram + filtered feed)
   - `/traffology/overview` — The Overview (dense grid of miniature provenance bars)

   The `provenance-ikb.jsx` prototype already demonstrates the Piece view — it needs to be converted from sample data to live API data and integrated into the Next.js app with the all.haus design system (Jost font, IKB blue, Bauhaus geometry).

4. **Observation templates.** Render observations from fixed templates (ADR Section 6). Each observation type maps to a template with values slotted in. No LLM involved — the voice is precise, calm, and mechanical.

---

## Later phases (not in scope yet)

- **Phase 2:** Nostr monitor service (relay polling for reposts/reactions/quotes)
- **Phase 3:** Outbound URL search (Bluesky, Reddit, HN, Mastodon APIs) + pattern observations
- **Phase 4:** Publication editor view (same feed filtered by publication_id)

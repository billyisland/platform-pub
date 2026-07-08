# ADR: Move Media Uploads onto the Blossom Server

**Status:** Draft
**Context date:** July 2026

## Current state (verified against the codebase)

- **`POST /media/upload`** — `gateway/src/routes/media.ts`. Pipeline (documented in the header comment `media.ts:10-23` and step comments `60-67`): read multipart → Sharp crunch (`.rotate().resize(1200,null,{withoutEnlargement:true}).webp({quality:80})`, `media.ts:96-100`) → SHA-256 of the crunched buffer (`103-104`) → dedup `SELECT id FROM media_uploads WHERE sha256` (`107-110`) → **`fs.writeFile(MEDIA_DIR/<sha256>.webp)`** (`120-122`) → `INSERT INTO media_uploads` (`128-132`) → return `{url,sha256,...}` (`139-144`).
- **Storage constants** — `MEDIA_DIR = process.env.MEDIA_DIR ?? "/app/media"` (`media.ts:25`); `PUBLIC_MEDIA_URL = process.env.PUBLIC_MEDIA_URL ?? "https://all.haus/media"` (`26-27`). `ensureMediaDir()` (`46-52`) is awaited at route registration (`55`).
- **Dedup already ignores the stored column.** The duplicate branch returns `${PUBLIC_MEDIA_URL}/${sha256}.webp` (`media.ts:112-116`) — reconstructed from `PUBLIC_MEDIA_URL` + hash, **not** the `blossom_url` value read from the row. So the public URL scheme is already decoupled from what's stored in `media_uploads.blossom_url`; keeping the stored value as `PUBLIC_MEDIA_URL/<sha256>.webp` is the zero-rewrite path.
- **`media_uploads` schema** (`schema.sql:1951-1959`): `blossom_url text NOT NULL`, `sha256 text NOT NULL`, `mime_type text NOT NULL`, `size_bytes int NOT NULL`, `uploader_id uuid **NOT NULL**` (FK → `accounts`, `ON DELETE RESTRICT`). `blossom_url` is **NOT NULL** — every insert must still write *a* URL (no schema change needed; the name just becomes honest). `uploader_id` being NOT NULL also means the §4 migration script never faces a null uploader — `signEvent(uploader_id, …)` is always resolvable.
- **Blossom container** (`docker-compose.yml:309-319`): `ghcr.io/hzrd149/blossom-server:master`, volumes `blossom_data:/app/data` + `./blossom-config.yml:/app/config.yml:ro`, healthcheck `wget -qO- http://localhost:3003/`. **No `ports:` and no network override** — it is already internal-only on the default compose network. Receives no traffic today.
- **`blossom-config.yml`** (full): `port: 3000` · `storage.backend: local` (`/app/data/blobs`) · `database.backend: sqlite` (`/app/data/blossom.sqlite`) · `rules: [{type: allow, action: upload}]` (blanket allow).
- **nginx** (`nginx.conf`): `location /media/ { alias /app/media/; expires 1y; add_header Cache-Control "public, immutable"; ... }` (`114-127`), preceded by a comment (`108-113`) stating images are written by the gateway to `/app/media/<sha256>.webp`. nginx mounts the same volume read-only (`docker-compose.yml` nginx `media_data:/app/media:ro`). Dynamic-resolver pattern in use: `resolver 127.0.0.11 valid=10s ipv6=off` (`nginx.conf:51`) + per-location `set $upstream_x http://svc:port; proxy_pass $upstream_x;` (e.g. gateway `54-56`, strfry `99-101`). **`upstream {}` blocks are deliberately avoided** (`nginx.conf:27-31`: they defeat the dynamic re-resolution after a container restart) — a Blossom proxy must keep the `set $var` form.

### The port bug — resolve toward 3003

`blossom-config.yml` binds **`port: 3000`**, but the compose healthcheck probes **`:3003`** (`docker-compose.yml:316`). They disagree, so the healthcheck is almost certainly failing today — unnoticed only because nothing depends on Blossom being healthy and `restart: unless-stopped` doesn't act on healthcheck state. Two consumers this ADR adds (`BLOSSOM_URL=...:3003`, nginx `proxy_pass ...:3003`) already assume 3003. **Standardize on 3003**: set `port: 3003` in `blossom-config.yml` so config + healthcheck + gateway env + nginx all agree. This is the first, standalone step (Sequencing #1) and gates the `depends_on: service_healthy` in §5.

## Decision

Gateway remains the sole upload ingress (auth, Sharp pipeline, dedup unchanged). After crunching, the gateway uploads the blob to the local Blossom server via **BUD-02 `PUT /upload`**, signing the required kind-24242 authorization event **server-side with the uploader's custodial key** via the existing key-custody `signEvent` path. Blossom becomes the blob store; nginx proxies `/media/` to it.

Why this shape:

- **Custodial keys make BUD-02 auth free server-side.** The gateway already signs Nostr events for users via `signEvent(signerId, template, 'account')` (`gateway/src/lib/key-custody-client.ts:44-50`), used across the codebase (notes deletion `notes.ts:342`, discovery `discovery-publish.ts:120`, publication publish `publication-publisher.ts:195`, DMs `messages.ts:632`, scheduler `scheduler.ts:222`, etc.). Signing a kind-24242 auth event is the same call. This retires the "avoids the complexity of the Blossom BUD-02 auth protocol" rationale in the current `media.ts:10-23` header.
- **Attributable blobs.** Uploads become attributable to user pubkeys in Blossom's SQLite index — the precondition for future BUD-04 mirroring.
- **Public URL scheme survives.** Blossom serves `GET /<sha256>` (and `/<sha256>.ext`); nginx keeps the `/media/` prefix stable. Combined with the dedup branch already rebuilding from `PUBLIC_MEDIA_URL` (`media.ts:112-116`), **no stored URL rewrites are required**.

## Required changes

### 1. Fix Blossom config (standalone, ship first)

- Set **`port: 3003`** in `blossom-config.yml` (matches healthcheck + the new `BLOSSOM_URL` + nginx). Confirm `wget -qO- http://localhost:3003/` passes inside the container after the change.
- Blossom is **already unpublished + internal-only** (no `ports:`, default network) — §1's original "keep it reachable only from the gateway" is satisfied as-is; no compose change needed for that. The blanket `rules: [{type: allow, action: upload}]` is therefore acceptable for launch (only the gateway can reach it). Tighten rules to platform-issued pubkeys only when/if a public BUD endpoint is added (Out of scope).
- Pin the image: replace `:master` with a release tag (`docker-compose.yml:310`).

### 2. Gateway — `routes/media.ts`

Replace the disk write (`media.ts:119-122`) with a Blossom upload. Concrete shape:

1. Build the kind-24242 auth event **template** (`EventTemplate` = `{ kind, content, tags, created_at? }`; `created_at` is defaulted server-side in key-custody if omitted — `keypairs.ts` sign handler):
   ```ts
   const authTemplate = {
     kind: 24242,
     content: `Upload ${filename}`,
     tags: [
       ["t", "upload"],
       ["x", sha256],
       ["expiration", String(Math.floor(Date.now() / 1000) + 60)],
     ],
   };
   ```
2. Sign it: `const signed = await signEvent(uploaderId, authTemplate, "account");` — `signEvent` returns the **full signed event** `{ id, pubkey, sig, kind, content, tags, created_at }` (`key-custody-client.ts:44-50`), i.e. exactly the object BUD-02 wants base64'd. `uploaderId = req.session!.sub` (already in scope, `media.ts:74`).
3. `PUT ${BLOSSOM_URL}/upload`, `Authorization: Nostr ${Buffer.from(JSON.stringify(signed)).toString("base64")}`, body = the crunched `fileBuffer`, `Content-Type: image/webp`.
4. Verify the response descriptor's `sha256` equals the locally computed hash (Blossom hashes independently; mismatch ⇒ abort with 500, do not insert).
5. Keep the DB insert as-is but store `${PUBLIC_MEDIA_URL}/${sha256}.webp` in `blossom_url` (unchanged from today's `publicUrl`, `media.ts:125` — Blossom's own descriptor URL is treated as internal). Satisfies the `NOT NULL` column and keeps URLs stable if Blossom is swapped again.

**SSRF — do NOT route this through `safeFetch`; use plain `fetch`.** This is the one place the earlier draft was wrong. `safeFetch`/`shared/src/lib/http-client.ts` **unconditionally rejects any hostname that resolves to a private IP, with no allowlist** (`resolveAndValidateHost`, `http-client.ts:190-213`; loopback + RFC-1918 ranges in `PRIVATE_IPV4_RANGES`). The `blossom` Docker hostname resolves to a private `172.x` address, so `safeFetch("http://blossom:3003/upload")` would throw `Hostname blossom resolves to private IP …`. The SSRF invariant (CLAUDE.md) targets **outbound fetches to attacker-influenceable hosts**; a fixed internal service hop is explicitly the opposite. Precedent in-repo: `key-custody-client.ts:22-30` reaches `KEY_CUSTODY_URL` with a **plain `fetch`**, not `safeFetch` — the Blossom hop must do the same. Add a one-line comment at the call site noting the deliberate `safeFetch` exemption so a future reviewer/tripwire doesn't "fix" it.

**Env** — `BLOSSOM_URL=http://blossom:3003` (internal). Add it to the gateway `environment:` block in `docker-compose.yml` alongside the other internal service URLs (`PAYMENT_SERVICE_URL`, `KEY_SERVICE_URL`, `TRAFFOLOGY_INGEST_URL`; the block starts at the gateway `environment:` key, ~`docker-compose.yml:14`). `KEY_CUSTODY_URL` + `INTERNAL_SECRET` are already present (via `env_file: gateway/.env`), so signing needs no new secret. `MEDIA_DIR` stays set only until the migration script (§4) has read the old blobs off the volume; no runtime backend flag — the disk write is replaced outright.

**Failure mode.** If Blossom is down the upload 500s. Recommend **hard-fail** (the current `catch` at `media.ts:145-148` already returns 500) over a disk-fallback + reconciliation job: Blossom runs on the same Hetzner box as the gateway, so its availability ≈ the gateway's, and a fallback path reintroduces exactly the dual-storage complexity this migration removes.

### 3. nginx — proxy `/media/` to Blossom

Replace the static `alias` block (`nginx.conf:114-127`) with a proxy that reuses the existing dynamic-resolver pattern:

```nginx
location /media/ {
    set $upstream_blossom http://blossom:3003;   # set-var form: keeps 127.0.0.11 re-resolution (do NOT use an upstream{} block, per nginx.conf:27-31)
    rewrite ^/media/(.*)$ /$1 break;             # strip /media/ → Blossom serves /<sha256>[.ext]
    proxy_pass $upstream_blossom;
    expires 1y;
    add_header Cache-Control "public, immutable";
    # ...retain the existing per-location security headers (nginx.conf:118-124)...
}
```

- The `resolver 127.0.0.11 valid=10s ipv6=off` at `nginx.conf:51` already covers this location.
- Stored URLs (`https://all.haus/media/<sha256>.webp`) keep resolving: `/media/x.webp` → rewrite → `/x.webp` → Blossom.
- Update the stale comment above the block (`nginx.conf:108-113`) — it currently says images are written to `/app/media/`.
- **`proxy_cache` (recommended, but has a prerequisite):** a `proxy_cache_path … keys_zone=…` directive must live in the `http {}` context, then `proxy_cache <zone>;` in the location — nginx won't accept `proxy_cache` without the zone. Worth it so nginx keeps absorbing hot-path image reads the way the static `alias` did (Blossom + SQLite shouldn't take a direct read hit per render). Can land in the same change or a fast-follow.

### 4. Migration of existing blobs

One-off `scripts/migrate-media-to-blossom.ts`:

1. `SELECT uploader_id, sha256 FROM media_uploads`.
2. For each: read `${MEDIA_DIR}/<sha256>.webp` from the still-mounted `media_data` volume, build+sign the same kind-24242 auth as the **original uploader** (`signEvent(uploader_id, …, "account")`), `PUT` to Blossom, verify the returned hash.
3. Idempotent: Blossom dedups by hash, so re-running is safe; skip rows whose blob is already present (or just re-PUT — dedup makes it a no-op).
4. After spot-checking N random `/media/<sha256>.webp` URLs through nginx, retire the `media_data` volume — but keep it one deploy cycle for rollback.

### 5. Compose

- Add `BLOSSOM_URL: http://blossom:3003` to the gateway `environment:` block.
- Add `blossom:` to the gateway `depends_on` with `condition: service_healthy` — **gated on §1** (the healthcheck must actually pass first, i.e. after the port fix). Note the current gateway `depends_on` is loose (only `postgres: service_healthy`, `docker-compose.yml:9-11`; it doesn't even hard-depend on key-custody), so this is a slight tightening — acceptable, and correct given the gateway now can't serve uploads without Blossom.
- After migration is verified: drop the `media_data` mount from **gateway** (`media_data:/app/media`) and **nginx** (`media_data:/app/media:ro`).
- Blossom stays unpublished (already the case).

### 6. Cleanup (post-soak)

- Delete `MEDIA_DIR`, `ensureMediaDir()` and its `await` at registration (`media.ts:25, 46-52, 55`), and the `fs`/`path` imports if now unused (`media.ts:2-3`).
- Rewrite the `media.ts:10-23` header comment (it documents the local-disk workaround and the retired BUD-02 rationale).
- `media_uploads.blossom_url` is now honestly named — no DDL, just semantics.

## Out of scope (deliberately)

- **Public BUD-01/BUD-02 endpoint** (accepting uploads directly from external Nostr clients): needs the `rules` hardening (drop the blanket `allow upload`), quotas, abuse handling, and publishing Blossom's port. Separate ADR.
- **Mirroring / BUD-04** to third-party Blossom servers: the real federation payoff, and what the attributable-blob change unlocks — but until then media stays single-homed on the Hetzner box. **This migration changes the storage layer, not the availability story.**
- **Non-image media** (audio, video): the Sharp pipeline is image-only by design (`ALLOWED_TYPES`, `media.ts:28-33`).

## Sequencing (direct cutover — no runtime flag)

1. **Config/port only** — set `blossom-config.yml` `port: 3003`, pin the image, confirm the healthcheck passes. Standalone, low-risk, and it must land first: §5's `depends_on: service_healthy` is gated on it. Deploy on its own.
2. **Migrate existing blobs (§4) against the still-live disk backend.** The gateway is still writing to `media_data`, so every blob to date is on the volume; the script copies them all into Blossom. Idempotent, so a partial run is safe to resume.
3. **Cutover deploy — gateway + nginx together, in one release.** Land the §2 `media.ts` change (disk write → Blossom PUT, plain `fetch`), the §3 nginx proxy, `BLOSSOM_URL`, and `depends_on: blossom`. From this deploy on, new uploads go straight to Blossom and `/media/` reads are proxied to it.
4. **Immediately re-run the migration script (§2 of §4) once** to sweep any blobs written to disk in the window between step 2 and the cutover. Idempotent + hash-deduped, so it only moves stragglers. Then spot-check N random `/media/<sha256>.webp` URLs through nginx (mix of old-migrated and freshly-uploaded).
5. **Rollback plan:** the cutover is one deploy, so rollback is reverting it — the `media_data` volume is still mounted and intact (nothing is removed in step 3), so the reverted disk backend serves every blob immediately.
6. **After one soak cycle:** remove the `media_data` volume + its gateway/nginx mounts and delete the dead disk code (§6). This is the point of no return — do it only once Blossom has served production reads cleanly for a cycle.

## Build plan

Codebase re-verified 2026-07-08 — every code reference in this ADR holds (`media.ts:96-132` pipeline, `key-custody-client.ts:44-50` `signEvent` returning the full signed event, `keypairs.ts:42-46,132` accepting arbitrary `kind` + defaulting `created_at`, `http-client.ts:173-219` unconditional private-IP rejection, `nginx.conf:114-127` static `alias`, the internal-only Blossom compose block with the `3000`-vs-`3003` port bug, `media_uploads.blossom_url NOT NULL`). The plan below maps 1:1 onto the Sequencing above, with one addition: **Phase 0**, an external-image spike that settles the only facts this repo can't verify.

### The one residual risk — Blossom's runtime contract

Three things are asserted from the BUD spec, not observed against the pinned `blossom-server` binary. Each can break the migration even with correct gateway/nginx code, so all three are settled in Phase 0 **before** any cutover:

1. **Does `blossom-server` honour `port:` in `config.yml`?** This gates everything — §1's port fix and the whole `depends_on: service_healthy` chain rest on it. If port comes from an env var or a different key, editing `port:` silently does nothing.
2. **BUD-02 upload contract** — that the endpoint is `PUT /upload`, auth is `Authorization: Nostr <base64>`, and the response descriptor carries a `sha256` (or `nip94`-style) field to compare against the local hash.
3. **`GET /<sha256>[.webp]` returns `Content-Type: image/webp`** — an `application/octet-stream` response renders as a broken image in-browser even though the bytes are correct.

### Phase 0 — Spike the pinned image *(gates all later phases; no repo cutover)*

1. Choose a real release tag for `ghcr.io/hzrd149/blossom-server` (replaces `:master`, `docker-compose.yml:310`).
2. Bring up **only** Blossom on that tag with the current config, on the compose network.
3. Observe, from inside the network: (a) which port it binds with `port: 3000` vs `port: 3003` in config; (b) the `PUT /upload` response JSON shape (field names) for a hand-signed kind-24242 auth over a test webp; (c) whether `GET /<sha256>` and/or `GET /<sha256>.webp` returns `image/webp`.

**Exit:** record the observed port key, upload-response shape, and the correct GET form as a note in this ADR. **If `port:` is ignored, standardize every consumer (nginx + `BLOSSOM_URL` + healthcheck) on whatever port it *does* bind — "3003 everywhere" is a preference, not a constraint; "3000 everywhere" (Blossom's default) is equally valid.** Every `:3003` below means "the Phase-0-confirmed port."

#### Phase 0 — observed (2026-07-08, image `ghcr.io/hzrd149/blossom-server:6.2.0`)

Spiked the real pinned image on the compose network. **The image ships the v6 Deno rewrite**, whose `config.yml` schema is **completely different** from the current `blossom-config.yml` (`database.path`, `storage.local.dir`, `storage.rules` as MIME retention rules, `upload.enabled/requireAuth`, top-level `host`). The config had to be rewritten to the v6 schema — the pre-existing `blossom-config.yml` (`database.backend: sqlite`, top-level `rules: [{type: allow, action: upload}]`) is a stale older-`master` format that this image would not parse.

- **Port key — honoured.** `port: 3003` in config ⇒ `Blossom Server listening on http://0.0.0.0:3003`. **"3003 everywhere" stands.** Needs `host: 0.0.0.0` (default) to be reachable across the compose network.
- **BUD-02 upload — confirmed exactly as the ADR assumed.** `PUT /upload`, `Authorization: Nostr <base64(JSON of the signed kind-24242 event)>`, body = raw image bytes, `Content-Type: image/webp` ⇒ **`201`** with descriptor JSON `{"url","sha256","size","type","uploaded","nip94":[...]}`. The `sha256` field is present and equals the locally-computed hash (verify-hash step is valid). A signed kind-24242 with `["t","upload"]`/`["x",<sha256>]`/`["expiration",…]` tags authenticated cleanly (BUD-11 auth `required`).
- **GET content-type — correct on both forms.** `GET /<sha256>` **and** `GET /<sha256>.webp` both return `200 image/webp`. Stored-URL scheme `…/media/<sha256>.webp` → nginx rewrite → `/<sha256>.webp` resolves and serves `image/webp`.
- **Gotcha 1 — no `wget`/`curl` in the image; only `deno`.** The compose healthcheck **cannot** use `wget` (it silently fails today for this reason too). Switched to `deno eval` (full permissions by default in `deno eval`, so no flags): `deno eval 'const r=await fetch("http://localhost:3003/");Deno.exit(r.ok?0:1)'`.
- **Gotcha 2 — `rules: []` rejects ALL uploads (`415 "Server does not accept image/webp blobs"`)**, contradicting the example-config comment ("set to [] to accept any"). Uploads require a rule matching the MIME type. Any rule enables the prune loop, so we use `image/*` with a **100-year** `expiration` (parses fine; `Prune: storage rules active`) to make pruning an effective no-op — we must never drop user media. The §1 "blanket allow" is realised as this single image rule (internal-only reachability is still the real access control).

### Phase 1 — Config/port fix *(ADR §1; standalone deploy)*

- Set `port:` in `blossom-config.yml` to the Phase-0 value; keep the pinned tag.
- Leave `rules: [{type: allow, action: upload}]` and internal-only networking unchanged (correct for launch — only the gateway can reach it).

**Exit:** `wget -qO- http://localhost:<port>/` passes *inside the container*; the compose healthcheck goes green (prerequisite for Phase 3's `depends_on: service_healthy`). Deploy on its own.

### Phase 2 — Migrate blobs against the live disk backend *(ADR §4; no cutover)*

`scripts/migrate-media-to-blossom.ts`:

1. `SELECT uploader_id, sha256 FROM media_uploads`.
2. Per row: read `${MEDIA_DIR}/<sha256>.webp` off the still-mounted `media_data` volume → build the kind-24242 template → `signEvent(uploader_id, template, 'account')` → `PUT ${BLOSSOM_URL}/upload` (Phase-0 contract) → verify returned hash `== sha256`.
3. Idempotent (hash-deduped); log + continue per-row so a partial run resumes; print a migrated/already-present/failed summary.

**Exit:** run completes with failed-count 0 (or each failure understood); spot-fetch blobs from Blossom by hash. Nothing user-facing changes — gateway still writes disk, nginx still serves disk.

### Phase 3 — Cutover: gateway + nginx + compose in one release *(ADR §2/§3/§5)*

**`gateway/src/routes/media.ts`** — replace the disk write (`media.ts:119-122`) with §2's sign→`PUT`→verify-hash flow using the Phase-0 contract. **Plain `fetch`, not `safeFetch`** (add the one-line exemption comment at the call site — §2). Store `${PUBLIC_MEDIA_URL}/${sha256}.webp` in `blossom_url` (unchanged value). Hash mismatch ⇒ 500, no INSERT. Keep the existing `catch → 500` hard-fail (no disk fallback).

**`docker-compose.yml`** (gateway block, `:70-120`) — add `BLOSSOM_URL: http://blossom:3003` to `environment:` (by `:85`); add `blossom: { condition: service_healthy }` to `depends_on` (`:78`). **Leave the `media_data` mounts (gateway `:82`, nginx) in place** — untouched, so rollback is instant.

**`nginx.conf`** (`:114-127`) — replace the `alias` block with the set-var proxy (§3): `set $upstream_blossom http://blossom:3003;` + `rewrite ^/media/(.*)$ /$1 break;` + `proxy_pass $upstream_blossom;`. **Retain all six security headers (`:118-124`) + `expires 1y` / `Cache-Control immutable`.** Fix the stale comment (`:112-113`). No `upstream {}` block (`nginx.conf:27-31`). `proxy_cache` deferred to a fast-follow (first add a `proxy_cache_path … keys_zone=` in the `http {}` context — confirm that context exists).

**Immediately post-deploy:** re-run the Phase 2 script once to sweep blobs written to disk in the Phase-2→cutover window (idempotent). Then spot-check N random `/media/<sha256>.webp` URLs **through nginx** (old-migrated + freshly-uploaded), confirming `image/webp` + correct render.

**Exit:** a fresh upload round-trips (editor → gateway → Blossom → rendered); old images still resolve; both carry `image/webp`.

**Rollback:** revert the single cutover commit — `media_data` is still mounted + complete, so the disk backend serves every blob immediately.

### Phase 4 — Soak, then remove the disk backend *(ADR §6; point of no return)*

After one clean soak cycle serving production reads from Blossom:

- Drop the `media_data` mount from gateway (`:82`) + nginx; remove `MEDIA_DIR` from the gateway `environment:` (`:89`); retire the `media_data` volume.
- Delete `MEDIA_DIR`, `ensureMediaDir()` + its `await` (`media.ts:25,46-52,55`), and now-unused `fs`/`path` imports (`media.ts:2-3`).
- Rewrite the `media.ts:10-23` header (drop the local-disk + "avoids BUD-02 complexity" narrative).
- `media_uploads.blossom_url` is now honestly named — no DDL.

**Exit:** uploads + reads still work with the volume gone (backend-only change; hairline/lint/`next build` unaffected).

# all.haus — Loading, Hydration & Responsiveness Audit

**Repo:** `billyisland/platform-pub` · **Scope:** felt slowness on cold load, feed hydration, and opening an article · **Deployment:** single VPS via docker-compose

> **Code-verified 2026-06-17.** The original draft was written from a partial read of the main paths. Each finding below has now been checked against the source; correction notes are inline (**Correction:**). The headline change: finding #5 (SSR the public read surfaces) is **already implemented** — every public page is a server component, and three of them already carry `revalidate: 60`. The genuinely open levers are #1 (CDN), #2 (nginx), #3 (bootstrap fan-out), #4 (lazy overlays), #6 (gated-body / overlay open), and the #7 cheap wins.

## Implementation status (2026-06-17)

| # | Finding | Status |
| --- | --- | --- |
| 1 | CDN in front | **Open — yours.** Account/DNS task, no repo change. |
| 2 | nginx HTTP/2 / Brotli / keepalive | **HTTP/2 done** (`http2 on;`). Brotli + keepalive deliberately deferred (see §2). |
| 3 | `/workspace/bootstrap` aggregate | **Done.** Gateway route + `WorkspaceView` wiring + reusable `list`/`sources`/`items` helpers. |
| 4 | Lazy-load overlays | **Done.** `web/src/components/workspace/LazyOverlays.tsx` (code-split + open-gated). |
| 5 | SSR public reads | **Mostly already shipped.** Residual: `/author`,`/tag`,`/source` SSR — see Outstanding. |
| 6 | Instant free preview | **Done** for the workspace reader open (title+dek seeded from the card's `Post`). |
| 7 | Cheap wins | Poll-gate **done**; `output: 'standalone'` **open** (see Outstanding). |

Shipped changes pass `tsc` (web + gateway), repo `eslint` (0 errors), and the hairline tripwire. They require a `web`+`gateway` rebuild and an nginx reload to go live (none are committed-and-deployed by this audit).

## Root cause

all.haus is a near-fully client-rendered app where content sits behind a serial fetch waterfall, with no edge layer in front of a single London box. The HTML shell paints fast but empty; everything that matters waits on JS parse → auth → feed fetches. That one shape explains all three felt-slow areas.

## Fixes, ordered by impact

### 1. Put a CDN in front (Cloudflare or similar)
Biggest single lever, especially for anyone not near London. Right now every asset pays origin RTT to one VPS. Cache `/_next/static/*` (hashed, immutable), `/media/*` (nginx already marks these immutable), and the four preloaded fonts at the edge; terminate TLS there; turn on Brotli. Also offloads the box.

### 2. nginx: HTTP/2 (Brotli + upstream keepalive deliberately deferred)
`listen 443 ssl;` had no `http2`. **Done** — added `http2 on;` (the deployed image is `nginx:alpine`, well past 1.25.1). H2 multiplexing removes the per-request H1 connection setup the client-side fetch waterfall pays.

**Corrections to the original draft's other two halves — neither is a safe in-repo change on this deployment:**
- **Brotli:** the deployed image is stock `nginx:alpine`, which **does not ship `ngx_brotli`**. A `brotli on;` directive against it fails `nginx -t`, so the container would refuse to start — committing it would break the next deploy. Getting Brotli means switching to an nginx image built with the module (e.g. a custom build, or `fholzer/nginx-brotli`); that's an infra decision (your bit), not a config line. Until then Next's own `compress: true` gzip (it runs `next start`, not standalone) still covers JS/CSS on the wire.
- **Upstream keepalive:** `keepalive` requires `upstream {}` blocks. The config deliberately uses `resolver 127.0.0.11` + `set $upstream …` so Docker hostnames are **re-resolved after a container rebuild** (the documented intent) — open-source nginx does *not* re-resolve servers named in an `upstream` block, so converting would reintroduce stale-IP 502s on your rebuild-on-prod flow. The gain is negligible anyway: these upstreams are loopback on the same box (no TLS, sub-millisecond handshake), unlike the client↔nginx hops H2 fixes. Not worth the regression.

### 3. Collapse the workspace bootstrap waterfall  *(fixes feed scroll + hydration)*
`WorkspaceView.tsx` (~L704–839) does `feeds.list()`, then per-vessel `listSources()` + `loadVesselItems()`. There's no combined endpoint in `api/feeds.ts` (confirmed — `workspaceFeeds` exposes `list`/`listSources`/`items` separately). Add a gateway `/workspace/bootstrap` that returns feeds + sources + first page of items (and ideally the `me` payload) in one response.

**Correction:** the original "**1 + 2N round trips, each gated on the prior, ~5 serial hops" overstates the depth.** Only `list()` blocks; the `2N` source and item calls are then fired **in parallel** (fire-and-forget `.then(...)` / `void loadVesselItems(feed)` per feed, L755–767 and L825–829), and `loadVesselItems` does *not* wait on `listSources`. So the real serial **depth** after the JS bundle is **fetchMe → list → items = 3 hops**, not 5; the `1 + 2N` is request **count/fan-out**, not latency. The endpoint is still worth building — it removes one RTT, collapses the request fan-out (which matters most under HTTP/1.1, i.e. before #2 lands), and lets the first page of items arrive with the feed list — but bill it as "cut 3 hops → 2 and kill the fan-out", not "5 → 1".

### 4. Lazy-load the overlays  *(fixes cold load / bundle size)*
Confirmed: nothing uses `next/dynamic`. `WorkspaceView` statically imports the Reader / Messages / Ledger / Settings / Library / Network / Dashboard overlays (L40–46), and `LayoutShell` statically imports the **Editor** overlay (TipTap `ArticleEditor`), Compose, Profile and Surface overlays (L8–11) — all in the initial bundle though they only mount on demand. (Minor correction to the draft: the Editor/Compose overlays live in `LayoutShell`, not `WorkspaceView`; the bundle cost is identical.) Convert each to `next/dynamic(() => import(...), { ssr: false })`. Large cut to initial JS → faster parse and hydrate. TipTap and Stripe Elements are the biggest individual wins.

### 5. SSR + cache the public read surfaces  *(half already done; the rest is bigger than the draft implies)*
**Correction — the draft over-generalised in both directions.** The public read pages split into two groups:

| Route | page.tsx | Body fetch | Status |
| --- | --- | --- | --- |
| `/article/[dTag]` | server, fetches | server-side HTML | ✅ `revalidate: 60` |
| `/read/[postId]` (external reader) | server, fetches | server-side HTML | ✅ `revalidate: 60` |
| `/pub/[slug]` | server, fetches | server-side HTML | ✅ `revalidate: 60` |
| `/[username]` (profile) | server, fetches | server-side HTML | ✅ `revalidate: 60` |
| `/author/[authorId]` | server **shell only** | **client** (`AuthorProfileView`, `'use client'`) | ❌ blank → JS → fetch |
| `/tag/[tag]` | server **shell only** | **client** (`TagBrowser`, `'use client'`) | ❌ blank → JS → fetch |
| `/source/[id]` | server **shell only** | **client** (`SourceSurface`, `'use client'`) | ❌ blank → JS → fetch |

So: **articles/pubs/profiles/external-reads are already fully SSR'd with `revalidate: 60`** — "opening an article is blank → JS → fetch → render" is **false** for those on a direct visit. But **author / tag / source pages do match the complaint** — the `page.tsx` is a server component in name only; it renders a `'use client'` body that fetches client-side, so the body is *not* in the HTML and a one-line `revalidate` buys nothing (there's no server fetch to cache). Bringing those three up to the article model means lifting the data fetch into the server `page.tsx` (as `/article` does) and passing it down — a real refactor per page, with care not to regress the interactive bits (infinite scroll, follow state). That's a **medium task per page, not a quick win.**

Plus the residual that applies regardless of route:
- **The in-workspace open is still client-fetched.** Opening an article *from the workspace* uses the `ReaderOverlay` (`useReader`), which fetches client-side via the thread projector — that is the path that actually *feels* slow for a logged-in user, and #5 doesn't touch it. See #6.

### 6. Render the free portion of a paywalled article immediately  *(done for the workspace open; standalone was never blocked)*
**Correction — the crypto was never on the free-preview path.** `vault.ts` is serial (fetch article → key-service wrapped key → gateway NIP-44 unwrap → local decrypt — the documented 6-step flow), **but that runs only on paywall *unlock*.** Both readers paint the free body without it: the standalone `/article/[dTag]` server page ships free HTML server-side, and the workspace `ReaderOverlay` gets `contentFree` in the single `getByDTag` call, then `ArticleReader` renders it from the `content` prop (the gate-pass/unwrap/decrypt only fire when the reader clicks unlock). So there was no "two roundtrips + crypto" blocking the preview.

The real residual gap was the **workspace open's single `getByDTag` round trip**, during which the overlay showed a blank pulse skeleton. **Done:** the reader target now carries an optional `preview` (title + dek) seeded from the feed card's `Post`, so `ReaderOverlay` paints the article's identity on the first frame — in the same Literata title/dek typography the loaded `ArticleReader` header uses, so the body fading in below causes no layout shift. Falls back to the neutral skeleton when opened from a surface with no `Post` in hand (search, dashboard, reading history). The full free body still arrives with the one `getByDTag` fetch; what changed is the open no longer *feels* blank while it lands.

### 7. Cheaper wins
- `output: 'standalone'` in `next.config.js` for smaller/faster containers (helps deploys, not user latency). **Not done** — needs a matching Dockerfile change; see Outstanding.
- Vessels already carry `status: "loading"` — make sure skeletons paint on the first frame so the surface feels solid while data lands. (Confirmed present; the reader's #6 preview is the related polish that shipped.)
- Visibility-gate the 15s unread poll in `AuthProvider` to cut idle load on the box. **Done** — the poll now starts/stops on `visibilitychange` and fetches once on re-show.

## Server / hardware (single VPS)

Postgres shares the box with strfry, Blossom, gateway, payment, key-service, web, and nginx — they contend for CPU/IO under any load, and Postgres is the shared dependency for every request. Pin its memory (`shared_buffers`, `effective_cache_size`), and move it to its own box or managed PG when budget allows. Combined with the CDN taking static/media/fonts off-origin, that frees the box for dynamic work. Short-TTL gateway-side caching of hot public reads (article-by-dTag, author profile) is worth adding once #5 is in.

## Measure first

No data yet, so before touching anything: run Lighthouse plus a WebPageTest from two regions and watch the network panel on `/reader`. The `1 + 2N` waterfall and the empty-shell gap will be obvious, and they give a before/after baseline.

**Highest leverage to start:** CDN (#1) for felt solidity, and the bootstrap endpoint (#3) for the feed.

## Outstanding work (next time)

Open jobs not yet done, for a future pass:

**In-repo (Claude can do):**
1. **SSR `/author`, `/tag`, `/source`** (#5 residual). Each `page.tsx` is a server shell rendering a `'use client'` body (`AuthorProfileView` / `TagBrowser` / `SourceSurface`) that fetches client-side. Lift the first data fetch into the server `page.tsx` and pass it down as props (the `/article/[dTag]` page is the reference), add `next: { revalidate: 60 }`, and keep the interactive bits (infinite scroll, follow state) working in the client child. Confirm none vary by viewer before caching. Medium task **per page**, independent of each other.
2. **`output: 'standalone'`** (#7). Add to `next.config.js` and update `web/Dockerfile` to copy the standalone server output (`.next/standalone` + `.next/static` + `public`) and run `node server.js` instead of `next start`. Smaller/faster container; helps deploys, not user latency. Verify the build + container boot before relying on it.
3. **Short-TTL gateway cache for hot public reads** (article-by-dTag, author profile) — worth adding once the CDN (#1) is in, per Server/hardware below.

**Yours (no repo change / infra):**
4. **CDN (#1)** — Cloudflare in front: cache `/_next/static/*`, `/media/*`, fonts; terminate TLS; enable Brotli at the edge. Single biggest lever.
5. **Brotli at nginx (#2)** — only after switching off stock `nginx:alpine` to an image with `ngx_brotli`; then add the `brotli` directives. (CDN-edge Brotli via #4 is the easier route.)
6. **Postgres tuning / own box** — pin `shared_buffers`/`effective_cache_size`, or move PG off the shared VPS when budget allows.
7. **Measure** — Lighthouse + WebPageTest from two regions on `/reader`, before/after, for a real baseline.

## Caveats

- **Resolved (2026-06-17 code pass):** #5's SSR question is settled (see the table). Articles, pubs, profiles and external reads are already server-rendered with `revalidate: 60`. The genuine remaining #5 work is converting `/author`, `/tag`, `/source` from client-fetched bodies to server-fetched (a refactor per page, not a one-liner); confirm none vary by viewer first.
- Confirm Next's default gzip is actually reaching the wire (not stripped at the proxy) before investing in Brotli. Note `web` runs `next start` (not `output: 'standalone'`), so Next's own `compress: true` gzip is in play — Brotli at nginx still beats it on JS/CSS, **but `ngx_brotli` must be compiled into the nginx image** (stock nginx doesn't ship it); confirm or add the module before relying on #2's Brotli half. HTTP/2 and upstream keepalive need no module.
- No runtime measurement has been taken yet (see "Measure first"). All ordering is by reasoned impact, not profiled data.

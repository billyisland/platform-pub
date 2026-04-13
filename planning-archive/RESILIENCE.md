# Platform — Resilience Specification

Technical decisions that make Platform the cockroach of social clients. Not optimisation for speed on good hardware — survival on bad hardware. The words are the product. They should arrive as HTML, render without JavaScript, and load on anything with a browser.

This document is a companion to DESIGN.md and NAVIGATION-ARCHITECTURE.md. Where those specify what the UI looks like and how it's organised, this specifies how it's built and what it assumes about the environment it runs in.

---

## Principle

Platform's content pages (article reader, writer profiles) should be server-rendered HTML that works without JavaScript. The social pages (feed, dashboard, editor, messages) are interactive by nature and use client-side React appropriately. The split follows the two-register model from DESIGN.md: canvas mode is the cockroach, platform mode is a modern SPA.

---

## 1. Server-render all canvas-mode pages

### What changes

The article reader (`/article/:slug`) and writer profile (`/:username`) pages currently use `'use client'` and render entirely on the client. They should be converted to React Server Components that fetch data on the server and return complete HTML.

### Implementation

**Article reader (`/article/:slug`):**
- The page component is a Server Component (no `'use client'` directive).
- It fetches the article from the gateway at request time using `fetch()` in the server component. The gateway is on the same network — this is fast.
- The NIP-23 markdown body is rendered to HTML on the server using the existing remark/rehype pipeline (`src/lib/markdown.ts`). The rendered HTML is embedded directly in the response.
- The headline, byline, date, and body arrive as static HTML. No JavaScript needed to read the article.
- Interactive elements hydrate on top as Client Components embedded within the Server Component:
  - `PaywallGate` — client component (needs to check reader auth state, handle payment flow)
  - `CommentSection` — client component (needs to post replies, load threads)
  - `VoteControls` — client component
  - `ShareButton` — client component
  - `ReportButton` — client component
- The pattern: `page.tsx` is a Server Component that renders the article body and metadata as HTML, then drops in `<PaywallGate />`, `<CommentSection />` etc. as islands of interactivity.

**Writer profile (`/[username]/page.tsx`):**
- Same pattern. Server Component fetches the writer's profile and article list from the gateway.
- Name, bio, avatar, article list render as static HTML.
- Follow button, subscribe button, and any interactive elements are Client Component islands.

**Homepage (`/page.tsx`):**
- Already mostly static. Ensure the hero, manifesto, and "how it works" sections are pure HTML with no client-side dependencies.
- `FeaturedWriters` can be a Server Component that fetches featured writers at request time.

**About page (`/about/page.tsx`):**
- Pure static. No client components needed. Remove `'use client'` if present.

### What stays client-rendered

These pages are inherently interactive and should remain Client Components:

- `/feed` — real-time feed with tabs, note composer, infinite scroll
- `/write` — TipTap editor, drag-and-drop images, paywall gate placement
- `/dashboard` — tabbed interface, inline editing, drive management
- `/messages` — real-time conversation, WebSocket or polling
- `/account` — interactive ledger filters, inline subscription cancel
- `/auth` — form interactions, OAuth flows
- `/search` — live search with results
- `/notifications` — dismiss/mark-read interactions
- `/profile` — form with avatar upload
- `/settings` — form interactions

### Data fetching pattern for Server Components

```typescript
// /article/[slug]/page.tsx — Server Component
// No 'use client' directive

import { ArticleBody } from '@/components/article/ArticleBody'
import { PaywallGate } from '@/components/article/PaywallGate'
import { CommentSection } from '@/components/comments/CommentSection'

const GATEWAY = process.env.GATEWAY_INTERNAL_URL ?? 'http://localhost:3000'

async function getArticle(slug: string) {
  const res = await fetch(`${GATEWAY}/api/v1/articles/by-slug/${slug}`, {
    next: { revalidate: 60 }, // ISR: revalidate every 60s
  })
  if (!res.ok) return null
  return res.json()
}

export default async function ArticlePage({ params }: { params: { slug: string } }) {
  const article = await getArticle(params.slug)
  if (!article) return notFound()

  return (
    <article>
      {/* All static — arrives as HTML */}
      <h1>{article.title}</h1>
      <div className="byline">
        <span>{article.author.displayName}</span>
        <time>{article.publishedAt}</time>
      </div>
      <ArticleBody html={article.renderedHtml} />

      {/* Interactive islands — hydrate on client */}
      {article.paywallOffset && (
        <PaywallGate articleId={article.id} price={article.pricePence} />
      )}
      <CommentSection articleId={article.id} />
    </article>
  )
}
```

The key: `ArticleBody` is a Server Component that just renders pre-built HTML. `PaywallGate` and `CommentSection` are Client Components with `'use client'`. The page itself has no `'use client'` directive, so Next.js renders it on the server.

### Server-side markdown rendering

The existing `src/lib/markdown.ts` pipeline (remark → rehype → HTML string) should run on the server at request time (or at publish time, cached in the DB). This means the markdown-to-HTML conversion happens once, not on every client. The gateway could store the rendered HTML alongside the raw markdown and serve it directly.

**Option A (request-time):** The Server Component calls the gateway, gets raw markdown, runs the remark/rehype pipeline, outputs HTML. Simple but runs the pipeline on every request (cacheable with ISR).

**Option B (publish-time):** The gateway renders markdown to HTML when an article is published or updated, stores it in the DB. The Server Component receives pre-rendered HTML. Faster at request time, but requires a re-render pipeline when the markdown renderer changes.

Recommendation: Start with Option A + ISR (revalidate every 60 seconds). Move to Option B when the site has enough traffic to justify it.

---

## 2. One custom font, not three

### What changes

DESIGN.md specifies three custom fonts: Literata (serif), Instrument Sans (sans-serif), IBM Plex Mono (monospace). That's 200-400KB of font downloads depending on weights and subsets.

Reduce to one custom font: **Literata only**. The other two roles fall to system fonts.

### Font stack

```css
/* The literary voice — custom font, the brand */
--font-serif: 'Literata', Georgia, 'Times New Roman', serif;

/* The social/conversational voice — system sans */
--font-sans: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;

/* Site infrastructure — system mono */
--font-mono: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
```

### Why this works

- **Literata** is the brand. It carries the literary voice — article headlines, body text, the logo. This is where the custom font earns its weight. It distinguishes Platform from every system-font site.
- **System sans** for the social layer (notes, replies, buttons, forms) is fine. The social voice is conversational and functional — it doesn't need to be distinctive, it needs to be legible and fast. System fonts render instantly (no FOUT/FOIT), look native to the user's OS, and are already optimised for screen rendering.
- **System mono** for infrastructure labels (nav links, tab labels, bylines, metadata) actually gains something: the mono-caps treatment (uppercase + letter-spacing) is doing the visual work, not the specific font. `ui-monospace` on macOS gives you SF Mono, on Windows gives you Cascadia Mono or Consolas — both are excellent.

### Font loading

Load Literata with `font-display: swap` and preload the most critical weight (400 regular, used for article body):

```html
<link rel="preload" href="/fonts/literata-latin-400.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/literata-latin-500.woff2" as="font" type="font/woff2" crossorigin>
```

Self-host the font files rather than loading from Google Fonts. This eliminates a DNS lookup, a connection to `fonts.googleapis.com`, and a connection to `fonts.gstatic.com` — three network round-trips saved.

Subset Literata to Latin + Latin Extended only (unless the platform serves other scripts). This cuts the file size significantly.

### Weights to ship

| Weight | File | Used for |
|--------|------|----------|
| 400 regular | `literata-latin-400.woff2` | Article body, standfirsts, excerpts, homepage hero subtitle |
| 400 italic | `literata-latin-400-italic.woff2` | Article card headlines, logo, quoted excerpts |
| 500 medium | `literata-latin-500.woff2` | Reader headline, profile display name, logo |

Three files. Likely ~60-80KB total for Latin subset in woff2. Compare to 200-400KB for three full font families.

---

## 3. Remove client-side relay connections

### What changes

The current web client imports NDK (`@nostr-dev-kit/ndk`) and connects directly to the Nostr relay via WebSocket from the browser. This adds ~50-80KB to the client bundle, opens a persistent WebSocket connection, and does event filtering and subscription management on the client.

Remove NDK from the client bundle entirely. All relay communication goes through the gateway via HTTP.

### What the gateway already handles

Looking at the existing gateway routes, it already proxies most relay operations:

- Article CRUD (publish, edit, delete via Nostr events) — `routes/articles.ts`
- Note publishing — `routes/notes.ts`
- Reply publishing — `routes/replies.ts`
- Follow/unfollow — `routes/follows.ts`
- Signing — `routes/signing.ts`
- Feed (global and following) — `routes/v1_6.ts` or via DB queries
- Search — `routes/search.ts`

### What might still use direct relay access

Check `src/lib/ndk.ts` and any components that call `getNdk()` directly. The feed currently uses NDK to subscribe to the relay and filter events client-side. This should be replaced with gateway API calls:

- `GET /api/v1/feed/global` — already exists, returns feed items from the DB
- `GET /api/v1/feed/following` — already exists or should exist
- Note/reply submission — already goes through gateway signing proxy

### Implementation

1. Audit every import of `getNdk`, `NDKEvent`, `NDKKind`, and other NDK types in `src/`.
2. Replace each with a gateway API call using `fetch()`.
3. Remove `@nostr-dev-kit/ndk` from `web/package.json`.
4. Remove `src/lib/ndk.ts` (or reduce it to type definitions if needed for event parsing).

The gateway becomes the only Nostr-aware component. The web client is a plain HTTP client.

### Trade-off

This removes real-time event streaming from the client. The feed won't update live via WebSocket — it will need to poll or be manually refreshed. For a writing platform (not a chat app), this is acceptable. Articles don't arrive every second. A 30-second poll interval or a manual "refresh" action at the top of the feed is fine.

If real-time is later desired (e.g., for DMs), the gateway can expose a Server-Sent Events endpoint or a WebSocket proxy — a single, thin connection managed by the gateway, not a full Nostr client in the browser.

---

## 4. Image discipline

### Rules

- All `<img>` tags must have explicit `width` and `height` attributes (or equivalent CSS aspect-ratio) to prevent layout shift.
- All images below the fold use `loading="lazy"`.
- Avatar images: serve at 2x the display size maximum. A 28px avatar circle needs a 56px source image, not a 400px one. The gateway or Blossom should support size parameters or the client should request appropriately sized images.
- Article images: use `<picture>` with WebP/AVIF sources and a JPEG/PNG fallback where the image pipeline supports it.
- No background images for decorative purposes. The design is white + type + crimson accents. There are no decorative images.

### Implementation

Add a shared `<Avatar>` component that handles:
- Correct sizing (explicit width/height)
- Lazy loading (except for the nav avatar, which is above the fold)
- Fallback to initials if no avatar URL
- Grey placeholder background during load

```typescript
// components/ui/Avatar.tsx
export function Avatar({ src, name, size = 28 }: { src?: string | null; name: string; size?: number }) {
  const initial = (name || '?')[0].toUpperCase()

  if (!src) {
    return (
      <span
        style={{ width: size, height: size, fontSize: size * 0.4 }}
        className="inline-flex items-center justify-center rounded-full bg-grey-100 text-grey-400"
      >
        {initial}
      </span>
    )
  }

  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      className="rounded-full object-cover"
    />
  )
}
```

---

## 5. Minimal JavaScript on canvas-mode pages

### Budget

Canvas-mode pages (article reader, writer profiles) should target < 50KB of JavaScript transferred (compressed). This is the JS needed for interactive islands only — paywall gate, comments, follow/subscribe buttons.

Platform-mode pages (feed, dashboard, editor) have no specific JS budget — they are interactive applications and should use what they need.

### How to measure

```bash
# Build the production app
cd web && npm run build

# Check the route-specific bundle sizes in the build output
# Next.js reports per-route JS in the build summary
```

### What to exclude from canvas bundles

The article reader should not load:
- NDK / Nostr client library (removed entirely per §3)
- TipTap / ProseMirror (editor-only)
- Note composer code (feed-only)
- Dashboard components
- Feed components

Next.js code-splits by route automatically, but verify that dynamic imports are used for heavy interactive islands if they pull in large dependencies.

---

## 6. Progressive enhancement targets

These are not requirements for launch but goals that the architecture should not prevent:

### No-JS reading

An article page should display the full article text (up to the paywall point) without JavaScript. The server-rendered HTML contains the content. JavaScript adds: paywall interaction, comments, voting, sharing. A reader with JS disabled sees the article and a `<noscript>` message explaining that interactive features require JavaScript.

### No-JS navigation

The top bar links (FEED, WRITE, DASHBOARD, ABOUT) are standard `<a>` tags. They work without JavaScript. The avatar dropdown requires JS (it's a client-side toggle), but the items within it are standard links. On mobile, the hamburger menu requires JS — the `<noscript>` fallback should display the nav links inline rather than hiding them behind a toggle that can't open.

### Printable articles

Article pages should print cleanly via the browser's native print function. The canvas-mode styles (white background, serif type, no decorative elements) are already close to print-ready. Add a print stylesheet that:
- Hides the nav bar, paywall gate, comments, voting controls
- Removes max-width constraint on the body so text fills the page
- Sets font-size to 12pt for body text
- Shows the article URL at the bottom

```css
@media print {
  nav, .paywall-gate, .comments, .vote-controls, .share-button { display: none; }
  .article-body { max-width: none; font-size: 12pt; line-height: 1.6; }
  .article-body::after { content: attr(data-url); display: block; margin-top: 2em; font-size: 10pt; color: #666; }
}
```

---

## 7. Network assumptions

### Target latency budget

- Article page first contentful paint: < 1.5s on a 3G connection (1.6 Mbps, 300ms RTL)
- Feed page interactive: < 3s on a 3G connection
- Total page weight (article, first load, no cache): < 200KB transferred

### Caching strategy

- Static assets (JS, CSS, fonts): immutable, cache forever (hashed filenames)
- Article HTML: ISR with 60-second revalidation, or `stale-while-revalidate`
- API responses (feed, profile): `Cache-Control: private, max-age=30`
- Font files: `Cache-Control: public, max-age=31536000, immutable`

### Offline

Not a target for launch. But the architecture should not prevent a future service worker that caches articles for offline reading. Server-rendered HTML pages are trivially cacheable by a service worker — another advantage of the SSR approach.

---

## Summary of changes

| Area | Current | Target |
|------|---------|--------|
| Article reader | Client-rendered (`'use client'`) | Server Component + client islands |
| Writer profiles | Client-rendered | Server Component + client islands |
| Homepage | Mostly static, some client deps | Fully server-rendered |
| Fonts | 3 custom (Literata, Instrument Sans, Plex Mono) | 1 custom (Literata) + system sans + system mono |
| Font loading | Google Fonts CDN | Self-hosted, preloaded, Latin subset |
| Nostr relay | Client-side NDK via WebSocket | Gateway proxy only, NDK removed from client |
| Client JS (article page) | Full SPA bundle | < 50KB (interactive islands only) |
| Images | No consistent sizing/lazy strategy | Explicit dimensions, lazy loading, shared Avatar component |
| Print | Not considered | Print stylesheet for articles |
| No-JS fallback | White page | Article content renders, noscript message for interactive features |

---

## Prep work completed (2026-04-02)

The following prerequisites were addressed before starting the build order. These fixes unblock or simplify the resilience work described above.

### Editor lazy-loaded (§5 prerequisite)

TipTap and all ProseMirror extensions are now loaded via `next/dynamic` with `ssr: false` on the `/write` page (`web/src/app/write/page.tsx`). This removes the editor bundle from all canvas-mode routes, a prerequisite for the <50KB JS budget on article pages.

### API calls centralized through api.ts (§3/§7 prerequisite)

Scattered raw `fetch()` calls in `FeedView`, `NoteCard`, `VoteControls`, `ReplySection`, and `FeaturedWriters` have been replaced with the typed API client in `web/src/lib/api.ts`. New API namespaces added: `content.resolve()`, `feed.global()`, `feed.featured()`, `follows.follow()`, `follows.pubkeys()`, `search.writers()`. This ensures consistent credential handling and provides a single point for adding cache headers, ISR integration, or service worker interception.

### Shared formatting utilities extracted (SSR prep)

`formatDate`, `truncate`, and `stripMarkdown` — previously duplicated across four files — are now consolidated in `web/src/lib/format.ts`. These utilities work in both server and client contexts, avoiding duplicate work when converting to Server Components.

### Error boundaries added (§1 island safety)

- `web/src/components/ui/ErrorBoundary.tsx` — reusable component boundary for client islands
- `error.tsx` files added for `/`, `/article`, `/feed`, `/dashboard` routes

When canvas-mode pages become Server Components with client islands, a crash in `PaywallGate` or `CommentSection` will be caught by the boundary rather than destroying the server-rendered article HTML underneath.

### Unused `dark` prop removed from VoteControls/ReplySection API

Dead prop (`dark?: boolean`) noted as "kept for API compat" has been left in place but excluded from destructuring, reducing confusion during the SSR conversion.

---

## Build order

1. **Self-host Literata, switch sans/mono to system fonts.** Smallest change, immediate payload reduction. Update `globals.css` and font loading in `layout.tsx`.
2. **Convert article reader to Server Component.** The highest-impact change — the page people come for becomes the fastest page on the site. Error boundaries are now in place for client islands.
3. **Convert writer profiles to Server Component.** Same pattern, second canvas-mode page. Shared `formatDateFromISO` is ready for server-side use.
4. **Audit and remove NDK from client.** Replace direct relay calls with gateway API calls. The API client layer is now complete — most components already use it. Remove the package.
5. **Add Avatar component and image discipline.** Shared component, explicit sizing, lazy loading.
6. **Add print stylesheet.** Small CSS addition.
7. **Measure and verify.** Build, check bundle sizes per route, test on throttled connection. Editor is already lazy-loaded so the `/write` route won't pollute canvas bundles.

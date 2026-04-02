# Platform — Design Specification v2

This document captures the design direction agreed in conversation. It replaces DESIGN-BRIEF.md ("Broadsheet Confidence"), which described an earlier iteration that has been superseded.

---

## Positioning

Platform is a writing and social platform built on Nostr. It is the cool-kids, anti-big-money-tech alternative to Substack — for fairly normal writer types who never in their lives want to deal with bitcoin. The social layer should feel dynamic and involving. The branding should drop away in areas that feel like the writers' own home. The visual language should be minimal and discreet enough that writers can project their own identities into its empty spaces.


## Two registers

The entire UI operates in one of two visual modes, determined by route.

### Platform register

Used on: homepage, feed, dashboard, about, auth, search, settings, following, followers, notifications, write/editor.

This is the platform's own editorial voice. The brand is present: crimson accents, structured typography, the logo in full colour. Background is white. The platform is the host, showing you around.

### Writer canvas register

Used on: article reader (`/article/:slug`), public writer profiles (`/:username`).

The platform recedes. Background is white (same as platform, but stripped of all brand decoration). The logo shrinks, turns grey, becomes a quiet wordmark. No crimson except on functional elements (paywall price tags). No ornamental rules or section labels. The writer's name, their words, their images — that's all there is.

**Implementation:** A `useLayoutMode()` hook reads the current pathname and returns `'platform'` or `'canvas'`. The layout shell, nav bar, and any mode-aware components read this value.


## Colour

### Palette

The entire site is white and grey with one colour: crimson.

| Token | Value | Usage |
|-------|-------|-------|
| `white` | `#FFFFFF` | Page background (both registers) |
| `black` | `#1A1A1A` | Primary text, headlines, ink |
| `grey-600` | `#666666` | Secondary text, standfirsts, excerpts |
| `grey-400` | `#999999` | Muted text, timestamps in canvas mode |
| `grey-300` | `#BBBBBB` | Faint text, metadata, inactive nav, placeholders |
| `grey-200` | `#E5E5E5` | Borders, rules, dividers |
| `grey-100` | `#F0F0F0` | Light rules (between feed items), subtle backgrounds |
| `grey-50` | `#FAFAFA` | Quoted-article card background |
| `crimson` | `#B5242A` | Accent: logo, active tab, paywalled border, price, CTA buttons |
| `crimson-dark` | `#921D22` | Hover state on crimson elements |

### Rules for colour usage

- Crimson appears in exactly these places: logo wordmark, active feed tab underline, left border on paywalled article cards, price tags (£ amounts), primary CTA buttons, the homepage accent rule, article ornament dividers.
- In canvas mode (article reader, writer profiles), crimson only appears on functional payment elements (price tags, paywall gate CTA). It does not appear on decorative elements.
- The drop cap on article pages is black (`#1A1A1A`), not crimson. The writer's space is neutral.
- No background colours. No coloured surfaces. No parchment. No green.


## Typography

Three fonts, three clear roles.

### Literata (serif)

The literary voice. Used for:
- Article card headlines (always italic, medium weight)
- Article card standfirsts/excerpts (roman, regular weight)
- Article body text in the reader
- Homepage hero headlines
- Writer profile display names
- The logo/wordmark ("Platform" — italic, medium weight, crimson)
- Quoted article excerpts (italic)

Weights used: 400 (regular), 500 (medium).

### Instrument Sans (sans-serif)

The social/conversational voice. Used for:
- Note text in the feed
- Reply text in threads
- Writer names on notes (semibold)
- Buttons (semibold)
- Form inputs and labels
- The "about" page body text

This font only appears on the social layer and in UI chrome. It never appears in the article reader or on article cards. If a user is reading published writing, they see Literata. If they are in a conversation, they see Instrument Sans.

Weights used: 400 (regular), 500 (medium), 600 (semibold).

### IBM Plex Mono (monospace)

Site infrastructure. Always uppercase. Used for:
- Nav links (FEED, WRITE, DASHBOARD, ABOUT)
- Feed tab labels (FOR YOU, FOLLOWING)
- Author bylines on article cards (SARAH CHEN)
- Metadata lines (TODAY / 6 MIN / £0.30)
- Action labels (REPLY, QUOTE, SHARE)
- Timestamps on notes (2H, 5H)
- Section labels (THE DEAL, HOW IT WORKS)
- Search placeholder
- Attribution lines on quoted content
- The ornament divider (· · ·)

Weight used: 400 only. Character comes from the uppercase + letter-spacing, not from weight variation.

Letter-spacing: `0.04em` for nav and tabs, `0.06em` for bylines and section labels, `0.02em` for metadata and actions.

### Type scale

| Element | Font | Size | Weight | Style |
|---------|------|------|--------|-------|
| Logo (platform mode) | Literata | 20px | 500 | italic |
| Logo (canvas mode) | Literata | 16px | 500 | italic |
| Nav links | Plex Mono | 12px | 400 | uppercase |
| Feed tab labels | Plex Mono | 12px | 400 | uppercase |
| Article card headline | Literata | 24px | 500 | italic |
| Article card standfirst | Literata | 15px | 400 | roman |
| Article card byline | Plex Mono | 11px | 400 | uppercase |
| Article card metadata | Plex Mono | 11px | 400 | uppercase |
| Note text | Instrument Sans | 15px | 400 | roman |
| Note author name | Instrument Sans | 14px | 600 | roman |
| Note timestamp | Plex Mono | 11px | 400 | uppercase |
| Note action labels | Plex Mono | 11px | 400 | uppercase |
| Reply text | Instrument Sans | 14px | 400 | roman |
| Reply author name | Instrument Sans | 13px | 600 | roman |
| Article reader body | Literata | 17px | 400 | roman |
| Article reader headline | Literata | 34px | 500 | roman (not italic in reader) |
| Article reader byline name | Instrument Sans | 14px | 600 | roman |
| Article reader byline date | Instrument Sans | 13px | 400 | roman |
| Homepage hero | Literata | 48px | 500 | roman |
| Homepage hero subtitle | Literata | 48px | 400 | roman, grey-300 |
| Button text | Instrument Sans | 14–15px | 600 | roman |
| Form labels | Instrument Sans | 13px | 500 | roman |


## Logo

The word "Platform" set in Literata italic, medium weight (500), crimson (`#B5242A`). No box, no border, no background. Just the word.

- Platform mode: 20px, crimson
- Canvas mode: 16px, grey-300 (`#BBBBBB`)

The italic makes the logo feel like a signature rather than a label. It rhymes with the italic article headlines, giving the entire serif layer a consistent voice.


## Navigation

### Structure

A single horizontal top bar, no sidebar. Same bar at every breakpoint.

**Platform mode:** White background, 1px bottom border (`grey-200`). Contains: logo (left), nav links in mono caps (FEED, WRITE, DASHBOARD, ABOUT), search input (right), user avatar with dropdown (right).

**Canvas mode:** White background with slight transparency, 1px bottom border (`grey-100`, lighter). Contains: logo in grey (left), "← FEED" back link in mono caps (left of centre), user avatar (right). No nav links, no search. Minimal presence.

**Mobile:** Hamburger opens a sheet below the top bar. Same content, stacked vertically.

### Nav hierarchy (logged in)

Primary (always visible in top bar): Feed, Write, Dashboard, About.

Secondary (in user avatar dropdown): Profile, Following, Followers, Notifications, Settings, credit balance, Log out.

This is a reduction from 9 top-level sidebar items to 4 top-level + 5 in a dropdown. Following/followers/notifications are "me" pages, not navigation destinations.


## Feed

### Article cards

Separated by thin rules (`grey-100`). No background colour, no card container.

- **Paywalled articles** have a 3px crimson left border. This is always visible — it is not a hover state.
- **Free articles** have no left border. They sit flush.
- Byline: mono caps, grey-300
- Headline: Literata italic, 24px, medium weight, black
- Standfirst: Literata roman, 15px, grey-600
- Metadata: mono caps, grey-300. Items separated by `/` at reduced opacity.
- Price (if paywalled): mono caps, crimson

### Note cards

Avatar (28px circle, grey-100 background) + name (Instrument Sans semibold) + timestamp (mono caps) on one line.

Note text: Instrument Sans 15px, black. Left-aligned with 38px indent (clearing the avatar).

Action labels (REPLY, QUOTE): mono caps, grey-300, below the note text at the same indent.

### Quoted content in notes

Two patterns:

**Quoting a passage** (text selection from an article): A block below the note text, indented to the same 38px, with a 2px left border in grey-200. The quoted text is Literata italic, 14px, grey-600. Attribution line below in mono caps, grey-300: `AUTHOR NAME · ARTICLE TITLE`.

**Quoting an entire article** (sharing/referencing): A compact card below the note text with a 3px crimson left border (if paywalled) or grey-200 border (if free), and a `grey-50` background. Contains the article title in Literata italic 14px, and attribution in mono caps.

### Threaded replies

Indented below the parent note at 38px + 16px, with a 1px left border in grey-100. Reply author names in Instrument Sans 13px semibold, text in Instrument Sans 14px, timestamps in mono caps.


## Article reader (canvas mode)

White background. No platform branding except the quiet grey wordmark in the nav.

- Byline: avatar circle + name (Instrument Sans 14px semibold) + date (Instrument Sans 13px, grey-300)
- Headline: Literata roman (not italic — this is the writer's space, not the feed's summary), 34px, medium weight, black, tight letter-spacing (-0.025em)
- Horizontal rule: 1px, grey-200, below headline
- Body: Literata 17px, line-height 1.8, black. Max-width 640px, centred.
- Drop cap: Literata 3.5em, medium weight, black. Not crimson — the writer's space is neutral.
- Links in body: black, underlined, not crimson
- Blockquotes: 2px left border in grey-200, italic, grey-600

### Paywall gate

The one place crimson appears in canvas mode. Crimson top and bottom border (3px). Heading in Literata. CTA button in crimson (`btn-accent`). Price in Literata, large (40px). This is a commercial moment and the brand asserts itself.


## Writer profile (canvas mode)

Same quiet nav as the article reader. Writer's name in Literata 26px medium weight. Username in mono caps, grey-300. Bio in Literata 15px, grey-600.

Follow button: Instrument Sans, grey border. Subscribe button: Instrument Sans, black fill.

Article list: same treatment as feed article cards but without the standfirst — just title, metadata, and the crimson left border on paywalled pieces.


## Buttons

| Variant | Background | Text | Border | Font |
|---------|-----------|------|--------|------|
| Primary (`btn`) | black | white | none | Instrument Sans 15px / 600 |
| Accent (`btn-accent`) | crimson | white | none | Instrument Sans 15px / 600 |
| Ghost (`btn-ghost`) | transparent | grey-600 | 1px grey-200 | Instrument Sans 15px / 500 |

All buttons: no border-radius, no text-transform, hover is `opacity: 0.85`. No 3D bottom-border effect from the old design.


## What this replaces

| Old | New |
|-----|-----|
| Green surface backgrounds (`#EDF5F0`, `#DDEEE4`) | White (`#FFFFFF`) |
| Parchment card backgrounds (`#FFFAEF`) | No card backgrounds |
| Fixed 240px left sidebar | Horizontal top bar |
| 9 top-level nav items | 4 primary + dropdown |
| Source Sans 3 (everything) | Instrument Sans (social), Literata (articles), Plex Mono (infrastructure) |
| Crimson accent on decorative elements everywhere | Crimson on logo, paywalled borders, prices, CTAs only |
| Italic headlines everywhere | Italic on article card headlines only; roman in the reader |
| Green/crimson/parchment on writer profiles and articles | Neutral white canvas |
| Three responsive nav systems (drawer, inline, sidebar) | One top bar + one mobile sheet |


## Files affected

New files:
- `src/hooks/useLayoutMode.ts`
- `src/components/layout/LayoutShell.tsx`

Modified files:
- `tailwind.config.js` — new colour tokens, remove green palette
- `src/app/globals.css` — new base styles, canvas class, updated components
- `src/app/layout.tsx` — remove sidebar offset, add LayoutShell
- `src/components/layout/Nav.tsx` — complete rewrite
- `src/app/page.tsx` — homepage with new type treatment
- `src/app/about/page.tsx` — new typography
- `src/components/feed/ArticleCard.tsx` — Literata headlines, crimson border logic
- `src/components/feed/NoteCard.tsx` — Instrument Sans, mono infrastructure
- `src/components/feed/FeedView.tsx` — tab labels in mono caps
- `src/components/article/ArticleReader.tsx` — canvas register, neutral type
- `src/components/article/PaywallGate.tsx` — canvas exception for crimson
- `src/components/home/FeaturedWriters.tsx` — new card treatment
- `src/app/auth/page.tsx` — Instrument Sans forms
- `src/app/dashboard/page.tsx` — updated tab pills
- `src/app/[username]/page.tsx` — canvas register, neutral profile
- `src/app/profile/page.tsx` — Instrument Sans forms

# all.haus — Design Specification

This document is the design authority for the all.haus rebrand (formerly "Platform"). It replaces `DESIGN.md` and `DESIGN-BRIEF.md`. Every frontend change must conform to these rules.

---

## Identity

**Name:** all.haus
**Logo mark:** ∀ — the universal quantifier, rendered as an inverted capital A. Heavy stroke weight, low crossbar. Drawn as an SVG path, not a Unicode character. The component replaces `ThereforeMark` and is called `ForAllMark`.
**Wordmark:** "all.haus" set in Jost, 18px, weight 500, white on black nav. The mark and wordmark always appear together in the nav.

The ∀ mark is crimson in platform mode, white in canvas mode (same two-register logic as before).


## Foundational principle

**Structure comes from mass and rhythm, not from accumulation of thin lines.**

Every organising element on the site is one of three things:

1. **A solid block of colour** (black, crimson, or grey-100 backgrounds)
2. **A thick rule** (minimum 4px, usually 6px) that registers as its own region
3. **Empty space** used rhythmically to separate content

There are no hairlines. No 1px borders between feed items. No faint dividers. No `border-grey-100`. No decorative rules. If something needs separating, use a thick bar or whitespace. If it doesn't need separating, let it breathe.

This principle applies to every page on the site, including pages not explicitly specified below. When extending the design to new components or views, ask: "Is this structure made of blocks, bars, and space — or am I reaching for a thin line?" If the latter, redesign.


## Two registers

The two-register system is retained from the previous design.

### Platform register
Used on: homepage, feed, dashboard, about, auth, search, settings, following, followers, notifications, write/editor.

The brand is present. The nav is a solid black beam. Crimson accents appear. Typography is geometric sans (Jost) for the platform's voice, serif (Literata) for the writers' voice. Structural elements are bold.

### Writer canvas register
Used on: article reader (`/article/:slug`), public writer profiles (`/:username`).

The platform recedes. The ∀ mark turns white. No crimson except on functional payment elements (paywall gate, price tags). No additional black bars in the content area (nav and footer beams remain on every page). The writer's words dominate. Literata is the primary font.


## Colour

The entire palette is black, white, grey, and one red.

| Token | Value | Usage |
|-------|-------|-------|
| `black` | `#111111` | Text, headlines, nav background, structural bars, free-article left borders, footer background |
| `white` | `#FFFFFF` | Page background (both registers) |
| `crimson` | `#B5242A` | ∀ mark (platform mode), paywalled-article left borders, price tags, accent CTA buttons, active tab underlines, paywall gate |
| `crimson-dark` | `#921D22` | Hover state on crimson elements only |
| `grey-600` | `#666666` | Secondary text |
| `grey-400` | `#999999` | Nav link default state (on black), section labels inside black bars (on black). Not used for text on white backgrounds. |
| `grey-300` | `#BBBBBB` | Note-quote left borders, blockquote borders in articles, closing ∀ mark. Not used for text on white backgrounds. |
| `grey-200` | `#E5E5E5` | Reserved for input field borders and similar form chrome. Not used for layout dividers. |
| `grey-100` | `#F0F0F0` | Content area backgrounds (e.g. "how it works" panel), avatar placeholder fills |
| `grey-50` | `#FAFAFA` | Not used in the new design |

### The bar code

A consistent system of thick left borders encodes content type and access:

| Bar colour | Meaning |
|-----------|---------|
| **Crimson (4–6px)** | Paywalled article — whether it's a feed card, a quoted article title, or a quoted article passage |
| **Black (4–6px)** | Free article — same three contexts |
| **Grey-300 (4px)** | Quoted note |

This is the only colour-coding system on the site. It is never contradicted. No other left-border colours exist.


## Typography

Three fonts, three clear roles. The sans-serif font changes from Instrument Sans / system-ui to **Jost** (geometric, Bauhaus-lineage, open-source via Google Fonts).

### Jost (geometric sans-serif)
The platform's structural voice. Used for:
- Homepage hero headlines (clamp 52–92px, weight 600)
- Nav wordmark ("all.haus", 18px, weight 500)
- Note text in the feed (15px, weight 400)
- Writer names on notes (14px, weight 600)
- Button text (15px, weight 600)
- "How it works" step titles and body
- Homepage body copy (18px)
- Form labels, settings text, dashboard UI
- Any text that is the platform speaking

### Literata (serif)
The literary voice. Used for:
- Article card headlines (italic, 28px, weight 500)
- Article card excerpts (roman, 15.5px, weight 400)
- Article body text in the reader (roman, 17px)
- Manifesto lines on the homepage (italic, clamp 20–28px)
- Quoted article text passages (italic, 14px)
- Writer profile display names
- Drop caps (black, not crimson)

### IBM Plex Mono
Site infrastructure. Always uppercase. Used for:
- Nav links (11px, tracking 0.06em)
- Feed tab labels (11px, tracking 0.06em)
- Author bylines on article cards (11px, tracking 0.06em)
- Metadata: dates, read times, reply counts (11px, tracking 0.02em)
- Price tags (11px, crimson)
- Section labels inside black bars ("THE DEAL", "HOW IT WORKS")
- Search input placeholder
- Footer links
- Attribution lines on quoted content

Weight: 400 only. Character comes from uppercase + letter-spacing, not weight variation.

### Type scale

| Element | Font | Size | Weight | Style |
|---------|------|------|--------|-------|
| Homepage hero | Jost | clamp(52px, 9vw, 92px) | 600 | roman |
| Homepage hero subtitle | Jost | same | 600 | roman, grey-600 |
| ∀ mark wordmark | Jost | 18px | 500 | roman |
| Nav links | Mono | 11px | 400 | uppercase |
| Feed tabs | Mono | 11px | 400 | uppercase |
| Article card headline | Literata | 28px | 500 | italic |
| Article card excerpt | Literata | 15.5px | 400 | roman |
| Article card byline | Mono | 11px | 400 | uppercase |
| Article card metadata | Mono | 11px | 400 | uppercase |
| Note text | Jost | 15px | 400 | roman |
| Note author name | Jost | 14px | 600 | roman |
| Note timestamp | Mono | 11px | 400 | uppercase |
| Reply text | Jost | 14px | 400 | roman |
| Reply author name | Jost | 13px | 600 | roman |
| Quote: note text | Jost | 14px | 400 | roman |
| Quote: article title | Literata | 16px | 500 | italic |
| Quote: article passage | Literata | 14px | 400 | italic |
| Quote: attribution | Mono | 10px | 400 | uppercase |
| Article reader body | Literata | 17px | 400 | roman |
| Article reader headline | Literata | 34px | 500 | roman (not italic) |
| Button text | Jost | 15px | 600 | roman |
| Section labels (in black bars) | Mono | 11px | 400 | uppercase |
| Footer links | Mono | 11px | 400 | uppercase |


## Navigation

### Structure

A single horizontal top bar. **Solid black background**, no border, no shadow. It is a structural beam.

**Platform mode:** Black background, full width. Contains: ∀ mark in crimson + "all.haus" wordmark in white (left), nav links in mono-caps white/grey (centre-left), search input (right), square avatar (right).

**Canvas mode:** Same black bar. The ∀ mark is white. No wordmark. No nav links. Minimal presence. Avatar (right) only.

**Mobile:** Hamburger opens a sheet below the nav bar.

### Nav hierarchy (logged in)

Primary (in top bar): Feed, Write, Dashboard, Following.

Secondary (in avatar dropdown): Profile, Messages, Notifications, Account (with balance), Reading history, Settings, Export my data, Admin (if applicable), Log out.

### Active state

Active nav link: white text, 4px crimson bottom border. Inactive: grey-400 text, no border. Hover: white text.


## Feed

### Feed tabs

Tabs sit on a **solid black bar** that extends full-width within the feed column. Tab labels are mono-caps. Active tab: white text with 4px crimson bottom border. Inactive: grey-600 text.

### Article cards

Separated from other content by generous whitespace (36px top margin). No background, no container border.

- **6px left border**: crimson if paywalled, black if free. This is always visible.
- **28px left padding** (content indented from the bar).
- Byline: mono-caps, grey-600, with dot separators.
- Price (if paywalled): mono-caps, crimson.
- Headline: Literata italic, 28px, black. Tight leading (1.18).
- Excerpt: Literata roman, 15.5px, grey-600. Max-width 540px.
- Footer: mono-caps, grey-600. Read time + reply count.
- Hover: left border transitions to crimson (free articles) or crimson-dark (paid).

### Note cards

Lightweight. No border, no background, no divider. Separated from surrounding content by whitespace alone (20px top margin). Left-padded 28px to align with article card content.

- Author row: 28px square avatar (grey-200 background) + name (Jost 14px semibold) + timestamp (mono 11px, grey-600).
- Note text: Jost 15px, black, indented 38px (clearing avatar).
- Footer: mono-caps, grey-600, at same 38px indent.

### Quoted content in notes

All quotes appear below the note text, indented to 38px (same as note text), with a **4px left border** and 20px left padding.

**Quoting a note:**
- 4px grey-300 left border.
- Small avatar (18px) + author name (Jost 12px semibold, grey-600).
- Quoted text: Jost 14px, grey-600.

**Quoting an article title:**
- 4px left border: crimson if paid, black if free.
- Author: mono-caps, 10px, grey-600.
- Title: Literata italic, 16px, black.
- Excerpt (optional): Literata roman, 13px, grey-600.

**Quoting an article passage:**
- 4px left border: crimson if paid, black if free.
- Quoted text: Literata italic, 14px, grey-600. In quotation marks.
- Attribution: mono-caps, 10px, grey-600. Format: `ARTICLE TITLE · AUTHOR NAME`.


## Homepage (landing page)

### Hero

- Headline: Jost, clamp(52–92px), weight 600, black. Line-height 0.92, letter-spacing -0.035em. Flush left.
- Subtitle: same size/weight, grey-600.
- Below: a **6px full-width black rule** (the `slab-rule`).
- Body copy: Jost 18px, max-width 440px.
- CTA button: crimson background, white text, Jost 15px semibold. No border-radius.

### Manifesto ("The deal")

Two-column grid: 180px black column (with mono-caps label in grey-400) | content column.

Manifesto lines are Literata italic, clamp(20–28px). Lines are separated by **4px black rules**, not hairlines.

On mobile: collapses to single column, label becomes a black bar above.

### How it works

- Label bar: full-width black background, mono-caps grey-400 text.
- Three-column grid below on grey-100 background.
- Columns separated by **4px black vertical rules**.
- Step numbers: mono, crimson.
- Step titles: Jost 16px semibold.
- Step body: Jost 14px, grey-600.
- On mobile: single column, steps separated by 4px black horizontal rules.

### Closing mark

∀ mark in grey-300, centred, generous top/bottom margin (80px / 64px).


## Footer

**Solid black background**, matching the nav. The site is bookended by two black beams.

- ∀ mark (small, grey-600) + "all.haus" (mono, grey-600) on the left.
- Links (About, Guidelines, Privacy, Terms) in mono-caps, grey-600, on the right.


## Buttons

| Variant | Background | Text | Border | Font |
|---------|-----------|------|--------|------|
| Primary (`btn`) | black | white | none | Jost 15px / 600 |
| Accent (`btn-accent`) | crimson | white | none | Jost 15px / 600 |
| Ghost (`btn-ghost`) | grey-100 | grey-600 | none | Jost 15px / 500 |

All buttons: no border-radius. Hover: `opacity: 0.85` on primary/accent, `background: var(--g200)` on ghost.


## Article reader (canvas mode)

White background. No platform branding except the quiet white ∀ mark in the nav.

- Byline: square avatar + name (Jost 14px semibold) + date (Jost 13px, grey-600).
- Headline: Literata roman (not italic), 34px, weight 500, black, letter-spacing -0.025em.
- Body: Literata 17px, line-height 1.8, black. Max-width 640px, centred.
- Drop cap: Literata 3.5em, weight 500, black. Not crimson.
- Links in body: black, underlined.
- Blockquotes: 4px left border grey-300, Literata italic, grey-600. (Note: blockquotes within articles use 4px grey-300 — the same as quoted notes — because these are not article-quoting-article; they're the author's own typographic choice.)

### Paywall gate

The one place crimson asserts itself in canvas mode. Crimson top and bottom borders (4px). CTA button in crimson. Price in Literata.


## Writer profile (canvas mode)

Same quiet white-∀ nav. Writer's name in Literata 26px, weight 500. Username in mono-caps, grey-600. Bio in Literata 15px, grey-600.

Article list: same left-bar treatment as feed cards — 6px crimson for paid, 6px black for free. No standfirst, just title + metadata.


## Avatars

**Square**, not rounded. No `border-radius`. Grey-200 background when no image is set. Monospace initial letter, grey-400, uppercase.

Sizes: 28px in notes and nav, 18px in quote attribution, 32px in the nav dropdown identity block.


## Applying these rules to unspecified pages

Many pages are not explicitly designed here: dashboard, settings, account, search results, notifications, messages, auth forms, admin views, the editor, following/followers lists.

**The same principles apply absolutely.** Specifically:

1. **No hairlines.** If you need a divider, use a 4px+ rule or whitespace. Do not use `border-b border-grey-100` or `border-grey-200` as layout separators. (Input field borders are the sole exception.)
2. **Section labels go in black bars.** Any mono-caps section heading should sit inside a black background strip, not float above a thin rule.
3. **Structure from blocks and space.** Dashboard stat cards, settings sections, notification groups — all should be organised by solid colour blocks (black or grey-100 backgrounds) and generous whitespace, not by accumulating faint borders.
4. **The bar code is sacred.** Any reference to an article uses the crimson/black left-border convention. Any reference to a note uses grey-300. No other left-border meanings exist.
5. **Jost for platform voice.** All UI text, form labels, button text, dashboard copy, settings descriptions — Jost.
6. **Literata for writers.** Article content, article headlines, writer names on profiles, manifesto-style display text.
7. **Mono for infrastructure.** Labels, metadata, timestamps, navigation, attribution. Always uppercase, always 400-weight.
8. **Crimson is functional.** It marks: the ∀ logo, paywalled content, prices, accent CTAs, active tab indicators, the paywall gate. It never appears decoratively.
9. **Footer and nav are black beams.** They bookend every page.
10. **Square avatars, square inputs, square buttons.** No border-radius anywhere.


## Files affected

### New files
- `web/src/components/icons/ForAllMark.tsx` (replaces `ThereforeMark.tsx`)

### Modified files
- `web/tailwind.config.js` — Jost in font stack, updated colour tokens, remove legacy green palette
- `web/src/app/globals.css` — updated base styles, remove all thin-rule component classes, add slab-rule classes, update button/tab/label styles
- `web/src/app/layout.tsx` — load Jost from Google Fonts
- `web/src/app/page.tsx` — homepage with new structure
- `web/src/components/layout/Nav.tsx` — black nav beam, ∀ mark, wordmark
- `web/src/components/layout/Footer.tsx` — black footer beam
- `web/src/components/feed/ArticleCard.tsx` — 6px left bar, 28px headline, updated spacing
- `web/src/components/feed/NoteCard.tsx` — Jost text, square avatar, quote blocks
- `web/src/components/feed/QuoteCard.tsx` — 4px bar code, remove grey-50 background
- `web/src/components/feed/FeedView.tsx` — black tab bar
- `web/src/components/feed/NoteComposer.tsx` — updated quote preview styling
- `web/src/components/home/FeaturedWriters.tsx` — updated card treatment
- `web/src/components/article/ArticleReader.tsx` — 4px blockquote borders
- `web/src/components/article/PaywallGate.tsx` — 4px crimson borders
- `web/src/components/ui/*` — square avatars, updated button classes
- Every page using thin rules or faint borders as layout dividers

### Removed
- `web/src/components/icons/ThereforeMark.tsx`
- All legacy green/surface/card/parchment tokens from `tailwind.config.js`
- All `.rule`, `.rule-inset` classes (replaced by `.slab-rule` variants)
- The `.ornament` class (replaced by `ForAllMark` closing mark)

### Reference mockup
The interactive HTML mockup demonstrating the landing page, feed, and quote types is in the project files as `allhaus-mockup.html`.

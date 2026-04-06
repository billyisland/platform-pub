# Feed Design Overhaul — Specification

> Reference mockup: `platform-feed-mockup-v9.html` (in this directory)
> Open it in a browser to see the target design rendered with live fonts and shapes.

## Overview

This spec describes a visual overhaul of the feed components: note tiles, article tiles, and quoted content within notes. The changes affect typography, colour, shape, and component structure. No backend or data-model changes are required.

## Fonts

### Replace all typefaces site-wide

Remove Instrument Sans, Newsreader, and IBM Plex Mono from the project.

**New sans-serif (UI font):** Source Sans 3
- Used for: note body text, author names, timestamps, bylines, buttons, meta lines, labels, nav, all UI chrome
- Google Fonts import: `Source+Sans+3:ital,wght@0,300;0,400;0,600;0,700;1,400`

**New serif (editorial font):** Cormorant
- Used for: article titles, article excerpts, article body prose, the "Platform" brand logotype, all headings in prose content
- Google Fonts import: `Cormorant:ital,wght@0,300;0,400;0,500;0,600;0,700;1,300;1,400;1,500;1,600`

### Files to change

1. **`web/tailwind.config.js`** — update `fontFamily` in `theme.extend`:
   ```js
   fontFamily: {
     sans: ['"Source Sans 3"', '"Source Sans Pro"', 'system-ui', 'sans-serif'],
     serif: ['"Cormorant"', 'Georgia', 'serif'],
     mono: ['"IBM Plex Mono"', '"Courier New"', 'monospace'], // keep for code blocks only
   },
   ```

2. **`web/src/app/globals.css`** — replace the Google Fonts `@import` URL at the top:
   ```css
   @import url('https://fonts.googleapis.com/css2?family=Source+Sans+3:ital,wght@0,300;0,400;0,600;0,700;1,400&family=Cormorant:ital,wght@0,300;0,400;0,500;0,600;0,700;1,300;1,400;1,500;1,600&display=swap');
   ```

3. **`web/src/app/globals.css`** — update the `body` rule in `@layer base`:
   ```css
   body {
     @apply bg-surface text-content-primary antialiased;
     font-family: 'Source Sans 3', 'Source Sans Pro', system-ui, sans-serif;
     font-size: 0.9375rem;
     line-height: 1.6;
   }
   ```

4. **`web/tailwind.config.js`** — update the `typography` plugin config to use Cormorant for prose:
   ```js
   typography: {
     DEFAULT: {
       css: {
         fontFamily: '"Cormorant", Georgia, serif',
         // ... keep other prose settings, update fontFamily references
       }
     }
   }
   ```

5. Update font-family references in `globals.css` component classes (`.label-ui`, `.label-mono`, `.tab-pill`, `.btn`, `.btn-accent`, `.btn-soft`) to use `'Source Sans 3'` instead of `'Instrument Sans'`.

## Colour and background

### Page background
The page background (`surface` in Tailwind config) should remain `#F5F0E8`. The contrast between page and article tiles is subtle but intentional — article tiles are this same cream colour, and they are distinguished from the page by their shape (zigzag edge) rather than by a colour difference.

### No changes to the existing colour tokens
The crimson, ink, content, and accent scales in tailwind.config.js are unchanged.

## Note tiles (NoteCard component)

File: `web/src/components/feed/NoteCard.tsx`

### Background and shape
- Background: `#2A2A2A` (slightly lighter than the current ink-900)
- Border-radius: `14px` (rounded — the "stone" shape)
- Text colour: `#F5F0E8` (cream) for body text, `#EAE5DC` as a slightly muted alternative
- Author name: `#F5F0E8`, 15px, Source Sans 3 bold (700)
- Timestamp: `#9E9B97`, 13px, Source Sans 3 regular
- Body text: `#EAE5DC`, 16px, Source Sans 3 regular, line-height 1.55

Replace the current `bg-surface-raised rounded-xl border border-surface-strong/50` classes with custom styling for the dark stone appearance.

### Action buttons (Reply, Quote, Vote, Share)
Style as ghost pills on the dark background:
- Font: Source Sans 3, 12px
- Text colour at rest: `rgba(245, 240, 232, 0.7)` (translucent cream — must be clearly visible, not hidden)
- Background at rest: `rgba(245, 240, 232, 0.05)`
- Border: `1px solid rgba(245, 240, 232, 0.13)`
- Border-radius: 20px
- Padding: 4px 14px
- Hover: background `rgba(245, 240, 232, 0.12)`, text `#F5F0E8`

**Important:** Buttons must be clearly visible at rest, not invisible until hover.

### Quoted note inside a note
When a note quotes another note, the inset note uses:
- Background: `#141414` (darker than the outer note's `#2A2A2A`)
- Border-radius: 10px
- Fully enclosed within the parent note — no overflow

### Quoted article inside a note (the pennon)
When a note quotes an article, the quoted article is rendered as a cream pennant that extends past the note tile's right edge:

- Background: `#F5F0E8` (same cream as standalone article tiles)
- No border-radius (sharp corners — it's a flag, not a stone)
- Red left border (`#9B1C20`, 5px) if the article is paywalled
- The wrapper has `margin-right: -24px` to push it past the note's right edge by ~24px
- The right edge is clipped into a **swallowtail fork** using CSS `clip-path: polygon()`
- The fork geometry: two prongs at top-right and bottom-right corners, V-point at 50% height, about 28px back from the prong tips
- The note tile's dark right edge should be visible through the V-cleft, roughly at the midpoint of the fork depth
- The fork lines should be acute (steep diagonals from corners to centre), giving a dynamic lance-like energy
- Add right padding (~48px) so text content doesn't get clipped by the fork shape

#### Swallowtail clip-path implementation
Apply via JavaScript after render (fonts must be loaded first):
```js
function applySwallowtail(qa, overhang) {
  var w = qa.offsetWidth;
  var h = qa.offsetHeight;
  var forkDepth = 28; // px from prong tips to V-point
  var vX = ((w - forkDepth) / w) * 100;
  qa.style.clipPath = 'polygon(0% 0%, 100% 0%, ' + vX + '% 50%, 100% 100%, 0% 100%)';
}
```
Or implement as a React `useEffect` with a ref.

## Article tiles (ArticleCard component)

File: `web/src/components/feed/ArticleCard.tsx`

### Background and shape
- Background: `#F5F0E8` (cream)
- No border-radius (sharp corners)
- No top border (remove the current `border-t border-ink-300`)
- Paywalled articles: `border-left: 6px solid #9B1C20` (thicker than the current 3px)

### Right edge — zigzag scallop
The right edge of every article tile is cut into a zigzag pattern using CSS `clip-path: polygon()`, making the tile look like a flag or pennant.

- Tooth depth: 36px (how far the points jut out)
- Tooth height: ~28px (calculate even number of teeth to fill tile height exactly)
- Extra right padding (~58px) so text doesn't touch the zigzag edge

#### Zigzag clip-path implementation
```js
function applyZigzag(el) {
  var h = el.offsetHeight;
  var w = el.offsetWidth;
  var toothDepth = 36;
  var teeth = Math.round(h / 28);
  if (teeth < 2) teeth = 2;
  if (teeth % 2 !== 0) teeth += 1;
  var toothH = h / teeth;
  var baseRight = ((w - toothDepth) / w) * 100;
  var points = ['0% 0%', baseRight + '% 0%'];
  for (var i = 0; i < teeth; i++) {
    var yMid = ((i * toothH + toothH / 2) / h) * 100;
    var yBot = (((i + 1) * toothH) / h) * 100;
    points.push('100% ' + yMid + '%');
    points.push(baseRight + '% ' + yBot + '%');
  }
  points.push('0% 100%');
  el.style.clipPath = 'polygon(' + points.join(', ') + ')';
}
```

### Typography
- Author byline: Source Sans 3, 11px, bold, uppercase, letter-spacing 0.05em, `#7A7774`
- Title: Cormorant, 28px (26px minimum), weight 600, `#111111`, line-height 1.2
- Excerpt/standfirst: Cormorant, 18px, weight 400, `#4A4845`, line-height 1.5
- Meta line (date, read time, £ symbol): Source Sans 3, 12px, `#7A7774`

### Action buttons
Style identically to note buttons but adapted for the light background:
- Text colour at rest: `#7A7774`
- Background at rest: `rgba(17, 17, 17, 0.03)`
- Border: `1px solid rgba(17, 17, 17, 0.1)`
- Border-radius: 20px
- Padding: 4px 14px
- Hover: background `rgba(17, 17, 17, 0.07)`, text `#4A4845`

### Article tiles with hero images
For articles that have a hero image (the current image-overlay variant), keep the image treatment but apply the same zigzag right edge via clip-path. The image should be clipped along with the tile.

## Brand logotype

File: `web/src/components/layout/Nav.tsx`

Update the "Platform" logo text to use Cormorant:
```
font-family: 'Cormorant', Georgia, serif
font-size: 34px (adjust as needed for the bordered box)
font-weight: 600
```

Keep the existing border-box treatment (3px solid border, tight padding).

## Nav sidebar

No structural changes to the nav layout. Update font references from Instrument Sans / `font-serif` to Source Sans 3 / Cormorant as appropriate. The nav uses `font-serif` for link text — this should now resolve to Cormorant.

## Article reading page

File: `web/src/components/article/ArticleReader.tsx`

The article body prose uses the Tailwind `prose` class which is configured via the typography plugin. Update the typography config so that prose renders in Cormorant at the existing size (1.125rem / 18px) with the existing line-height (1.85).

## Paywall gate

File: `web/src/components/article/PaywallGate.tsx`

No structural changes. The heading should render in Cormorant (via `font-serif`), and UI text in Source Sans 3 (via `font-sans` / body default).

## Implementation notes

- The zigzag and swallowtail clip-paths must be applied after the component has rendered and fonts have loaded, since they depend on the element's computed dimensions. In React, use `useEffect` with a ref, and optionally listen for `document.fonts.ready`.
- The clip-paths should be recalculated on window resize.
- The swallowtail on quoted articles requires the parent note tile to have `overflow: visible` so the pennant can extend past the note's right edge.
- Test on mobile widths — the zigzag depth (36px) may need to reduce on narrow screens. Consider a media query or responsive calculation.
- The `clip-path: polygon()` approach is well-supported in all modern browsers.

## Summary of visual metaphor

- **Notes** are dark rounded stones with chalk-coloured sans-serif text — small, self-contained, handled objects
- **Articles** are cream flags with serif text and a scalloped right edge — things you plant and display
- **Quoted notes** are darker stones inset within lighter ones
- **Quoted articles** are cream pennants that break out of their parent note, with a swallowtail fork revealing the dark stone behind them
- **Paywalled content** is marked by a thick crimson left border on both standalone and quoted article tiles

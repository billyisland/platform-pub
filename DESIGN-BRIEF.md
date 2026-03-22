# Platform Visual Design Brief — "Broadsheet Confidence"

**Purpose:** This document is a complete implementation spec for the visual redesign of the Platform web client. It is intended to be read by Claude Code and executed file-by-file. Every change is described with exact values; no aesthetic judgment is required.

**Do not change any business logic, routing, API calls, or component structure.** This is a CSS/Tailwind-only refactor with minor className changes in TSX files.

---

## 1. Files to change (in order)

1. `web/tailwind.config.js` — colour tokens, typography, spacing
2. `web/src/app/globals.css` — base styles, components, utilities
3. `web/src/components/layout/Nav.tsx` — sidebar/header redesign
4. `web/src/app/layout.tsx` — adjust main content padding for narrower sidebar
5. `web/src/app/page.tsx` — homepage hero
6. `web/src/app/about/page.tsx` — about page typography
7. `web/src/components/feed/ArticleCard.tsx` — feed item layout
8. `web/src/components/article/ArticleReader.tsx` — reading experience
9. `web/src/components/article/PaywallGate.tsx` — gate styling
10. `web/src/app/dashboard/page.tsx` — tab pills and page header
11. `web/src/app/auth/page.tsx` — auth form typography

No new files are needed. No packages to install.

---

## 2. Tailwind config (`web/tailwind.config.js`)

### Colour changes

Replace the `colors` block inside `theme.extend` with:

```js
colors: {
  surface: {
    DEFAULT: '#F5F0E8',    // was #F7F5F3 — warmer, more papery
    raised: '#FFFFFF',
    sunken: '#EAE5DC',     // was #EDECEA — warmer to match
    strong: '#D4D1CC',
  },
  crimson: {
    DEFAULT: '#9B1C20',
    dark: '#7A1519',
    light: '#B52226',
  },
  slate: {
    DEFAULT: '#3D4A52',
    dark: '#2E383F',
    light: '#4F5F69',
  },
  ink: {
    DEFAULT: '#111111',
    900: '#111111',
    800: '#222222',
    700: '#333333',
    600: '#4A4845',
    500: '#7A7774',
    400: '#9E9B97',
    300: '#D4D1CC',
    200: '#E8E6E3',
    100: '#F2F0EE',
    50:  '#F5F0E8',       // match new surface
  },
  content: {
    DEFAULT: '#111111',
    primary: '#1A1A1A',
    secondary: '#4A4845',
    muted: '#7A7774',
    faint: '#9E9B97',
  },
  accent: {
    DEFAULT: '#9B1C20',
    50:  '#FDF2F2',
    100: '#F5D5D6',
    200: '#E8A5A7',
    300: '#D46F72',
    400: '#C44548',
    500: '#B52226',
    600: '#9B1C20',
    700: '#7A1519',
    800: '#5C1013',
    900: '#3D0A0D',
  },
  brand: {
    50: '#F5F0E8',
    100: '#FFFFFF',
    500: '#B52226',
    600: '#9B1C20',
    700: '#7A1519',
  },
},
```

### Typography changes

Replace the `typography.DEFAULT.css` block:

```js
typography: {
  DEFAULT: {
    css: {
      maxWidth: '640px',
      fontSize: '1.125rem',
      lineHeight: '1.85',
      color: '#1A1A1A',
      fontFamily: '"Newsreader", "Iowan Old Style", Georgia, serif',
      h1: {
        fontFamily: '"Newsreader", Georgia, serif',
        fontWeight: '500',           // was 400
        letterSpacing: '-0.025em',   // was -0.01em — tighter
      },
      h2: {
        fontFamily: '"Newsreader", Georgia, serif',
        fontWeight: '500',           // was 400
        letterSpacing: '-0.015em',   // was -0.005em
      },
      h3: {
        fontFamily: '"Newsreader", Georgia, serif',
        fontWeight: '500',           // was 400
      },
      a: {
        color: '#9B1C20',
        textDecoration: 'underline',
        textUnderlineOffset: '3px',
        textDecorationThickness: '1px',
        '&:hover': { color: '#7A1519' },
      },
      blockquote: {
        borderLeftColor: '#9B1C20',  // was #D46F72 — use full crimson
        borderLeftWidth: '2px',
        fontStyle: 'italic',
        color: '#4A4845',
      },
      code: {
        fontFamily: '"IBM Plex Mono", monospace',
        fontSize: '0.875em',
      },
      p: { marginTop: '1.5em', marginBottom: '1.5em' },
    },
  },
},
```

---

## 3. Globals CSS (`web/src/app/globals.css`)

### Base layer changes

In `@layer base`, update `body`:
```css
body {
  @apply bg-surface text-content-primary antialiased;
  font-family: 'Instrument Sans', 'Inter', system-ui, sans-serif;
  font-size: 0.9375rem;
  line-height: 1.6;
  padding-top: 0;  /* was 60px — sidebar is now left-only, no top bar offset needed at lg */
}
```

**Note:** On mobile (below lg) the top bar still exists, so add to the end of globals.css in `@layer utilities`:
```css
@media (max-width: 1023px) {
  body { padding-top: 56px; }
}
```

### Component layer changes

**Buttons — `.btn`:** Change to sentence-case, add border, increase size:
```css
.btn {
  background: #111111;
  color: #FFFFFF;
  font-family: 'Instrument Sans', system-ui, sans-serif;
  font-size: 0.875rem;           /* was 0.8125rem */
  font-weight: 500;
  letter-spacing: 0.01em;        /* was 0.03em */
  text-transform: none;          /* was uppercase */
  border: 1px solid #333333;     /* NEW — gives depth */
  border-radius: 0;
  padding: 0.75rem 1.75rem;      /* was 0.625rem 1.5rem — more generous */
  transition: background-color 0.15s ease;
  cursor: pointer;
}
```

**`.btn-accent`:** Same changes plus crimson border:
```css
.btn-accent {
  background: #9B1C20;
  color: #FFFFFF;
  font-family: 'Instrument Sans', system-ui, sans-serif;
  font-size: 0.875rem;
  font-weight: 500;
  letter-spacing: 0.01em;
  text-transform: none;
  border: 1px solid #7A1519;
  border-radius: 0;
  padding: 0.75rem 1.75rem;
  transition: background-color 0.15s ease;
  cursor: pointer;
}
```

**`.btn-soft`:** Same text-transform and size changes:
```css
.btn-soft {
  @apply bg-surface-raised text-content-primary;
  font-family: 'Instrument Sans', system-ui, sans-serif;
  font-size: 0.875rem;
  font-weight: 500;
  letter-spacing: 0.01em;
  text-transform: none;
  border: 1px solid #D4D1CC;
  border-radius: 0;
  padding: 0.75rem 1.75rem;
  transition: background-color 0.15s ease;
  cursor: pointer;
}
```

**Tab pills:** Also sentence-case:
```css
.tab-pill {
  font-family: 'Instrument Sans', system-ui, sans-serif;
  font-size: 0.8125rem;
  font-weight: 500;
  letter-spacing: 0.01em;
  text-transform: none;           /* was uppercase */
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 0;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
```

**Label classes:** Increase weight:
```css
.label-ui {
  font-family: 'Instrument Sans', system-ui, sans-serif;
  font-size: 0.75rem;
  font-weight: 600;              /* was 500 */
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.label-mono {
  font-family: 'Instrument Sans', system-ui, sans-serif;
  font-size: 0.75rem;
  font-weight: 600;              /* was 500 */
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: #7A7774;
}
```

**Ornament — change colour to crimson:**
```css
.ornament {
  @apply text-center select-none;
  font-family: 'IBM Plex Mono', monospace;
  letter-spacing: 0.5em;
  font-size: 0.75rem;
  color: #9B1C20;                /* was #9E9B97 — now crimson */
}
```

**Rule accent — heavier:**
```css
.rule-accent {
  border-top: 3px solid #9B1C20;  /* was 2px */
}
```

---

## 4. Navigation (`web/src/components/layout/Nav.tsx`)

This is the biggest single change. The sidebar switches from `bg-crimson` to `bg-ink-900` (near-black), and becomes narrower on desktop. The active state changes from a full background-colour swap to a small crimson left-border marker.

### Desktop sidebar (lg+)

Change the `<header>` className:
```
fixed z-50 top-0 left-0 right-0 lg:right-auto lg:bottom-0 lg:w-[200px] lg:flex lg:flex-col
```
becomes:
```
fixed z-50 top-0 left-0 right-0 lg:right-auto lg:bottom-0 lg:w-[200px] lg:flex lg:flex-col
```
**BUT** change `bg-crimson` to `bg-ink-900` everywhere in this component. Specifically:

1. The `<header>` tag: replace `bg-crimson` with `bg-ink-900`
2. The mobile drawer `<div>`: replace `bg-crimson` with `bg-ink-900`
3. The mobile border: replace `border-crimson-dark` with `border-ink-800`
4. The logo border: change `border: '3px solid #FFFFFF'` → keep as-is (white on dark ink works)
5. Loading skeleton: replace `bg-crimson-dark` with `bg-ink-800`
6. Search input bg: replace `bg-crimson-dark` with `bg-ink-800`
7. Avatar fallback bg: replace `bg-crimson-dark` with `bg-ink-800`
8. Desktop logo border-b: replace `border-crimson-dark` with `border-ink-800`
9. Sidebar bottom border: replace `border-crimson-dark` with `border-ink-800`

### Active state for sidebar links

Replace the `sidebarLinkClass` function:

```tsx
function sidebarLinkClass(path: string) {
  return `block font-serif text-sm py-2.5 pr-4 transition-colors w-full ${
    isActive(path)
      ? 'pl-[13px] border-l-[3px] border-crimson text-white font-medium'
      : 'pl-4 text-ink-400 hover:bg-white/5 hover:text-white'
  }`
}
```

Key differences: active state uses `border-crimson` (the accent) on a dark ink background instead of `bg-crimson-dark`. Inactive text is `text-ink-400` (muted) instead of `text-surface`.

### Top bar link class (mobile/tablet)

Replace the `topLinkClass` function:
```tsx
function topLinkClass(path: string) {
  return `font-serif text-sm transition-colors px-2.5 py-1 ${
    isActive(path)
      ? 'text-white border-b-2 border-crimson'
      : 'text-ink-400 hover:text-white'
  }`
}
```

### Mobile drawer

Replace `bg-crimson` with `bg-ink-900` and all `border-crimson-dark` with `border-ink-800`.

---

## 5. Layout (`web/src/app/layout.tsx`)

The sidebar width stays at `lg:w-[200px]`, so the main content offset stays the same:
```tsx
<main className="min-h-screen lg:pl-[200px]">
```
No change needed here.

---

## 6. Homepage (`web/src/app/page.tsx`)

Change headline weights and add the accent rule:

```tsx
export default function HomePage() {
  return (
    <div className="mx-auto max-w-article px-6 py-24">
      <section>
        <h1 className="font-serif text-5xl font-medium leading-tight text-ink-900 sm:text-6xl" style={{ letterSpacing: '-0.025em' }}>
          Free authors.
        </h1>
        <p className="font-serif text-5xl font-normal leading-tight text-content-muted sm:text-6xl mt-1" style={{ letterSpacing: '-0.025em' }}>
          Writing that's worth something.
        </p>

        <div className="rule-accent mt-12" />

        <p className="mt-8 text-lg text-content-primary leading-relaxed max-w-lg">
          At Platform, you own your identity. Build a profile that
          exists on your terms. Find an audience that pays, from
          day one.
        </p>

        <div className="mt-10">
          <Link href="/auth?mode=signup" className="btn text-base px-10 py-4">
            Get started — free £5 credit
          </Link>
        </div>
      </section>

      <div className="mt-32 ornament" />
    </div>
  )
}
```

Changes: `font-light` → `font-medium` on h1, `font-light` → `font-normal` on subtitle, added `letterSpacing: '-0.025em'` style, added `rule-accent` between headline and body, and the button text uses an em dash instead of a colon.

---

## 7. About page (`web/src/app/about/page.tsx`)

Change all `font-light` to `font-medium` on headings. Add `style={{ letterSpacing: '-0.02em' }}` to all `<h1>` and `<h2>` elements.

---

## 8. ArticleCard (`web/src/components/feed/ArticleCard.tsx`)

### Non-hero card (the common case)

Replace:
```tsx
<div className="bg-surface-raised p-5 border-l-[3px] border-accent">
```

With:
```tsx
<div className={`py-5 border-t border-ink-300 ${article.isPaywalled ? 'pl-4 border-l-[3px] border-l-accent' : ''}`}>
```

This makes the default card a simple ruled item (top border only), with the left crimson accent reserved for paywalled articles.

Also change the headline from `font-normal` to `font-medium`:
```tsx
<h2 className="font-serif text-xl font-medium text-content-primary group-hover:text-accent transition-colors mb-2 leading-snug" style={{ letterSpacing: '-0.015em' }}>
```

Key change: hover state now goes to `text-accent` (crimson) instead of `opacity-80`.

---

## 9. ArticleReader (`web/src/components/article/ArticleReader.tsx`)

### Standard header (no hero image)

Change the headline:
```tsx
<h1 className="font-serif text-3xl font-medium leading-tight text-ink-900 sm:text-4xl mb-10" style={{ letterSpacing: '-0.025em' }}>
  {article.title}
</h1>
```
(`font-light` → `font-medium`, added letterSpacing)

### Hero image header

Same change:
```tsx
<h1 className="font-serif text-3xl font-medium leading-tight text-white sm:text-4xl" style={{ letterSpacing: '-0.025em' }}>
  {article.title}
</h1>
```

### Add drop-cap support

In the article body `<div>`, add a class that enables CSS drop caps. In globals.css, add to `@layer components`:

```css
.prose-dropcap > p:first-of-type::first-letter {
  font-family: 'Newsreader', Georgia, serif;
  font-size: 3.5em;
  float: left;
  line-height: 0.8;
  margin: 0.05em 0.08em 0 0;
  color: #9B1C20;
  font-weight: 500;
}
```

Then in ArticleReader, add `prose-dropcap` to the free content div:
```tsx
<div ref={articleBodyRef} className="prose prose-lg prose-dropcap max-w-none" dangerouslySetInnerHTML={{ __html: freeHtml }} />
```

---

## 10. PaywallGate (`web/src/components/article/PaywallGate.tsx`)

No structural changes needed — the existing gate styling in globals.css is already solid. The `.gate-label` colour is already crimson. Just verify that the unlock button uses `btn-accent` class.

---

## 11. Dashboard tabs

In the dashboard page, the tab pills already use the classes from globals.css. The text-transform change in step 3 handles them automatically.

---

## 12. Auth page (`web/src/app/auth/page.tsx`)

Change any `font-light` headings to `font-medium`. No other changes needed.

---

## Summary of the visual shift

| Element | Before | After |
|---------|--------|-------|
| Sidebar background | Crimson (#9B1C20) | Ink (#111111) |
| Page background | #F7F5F3 | #F5F0E8 (warmer) |
| Headline weight | 300 (light) | 500 (medium) |
| Headline tracking | -0.01em | -0.025em |
| Button text | UPPERCASE 13px | Sentence case 14px |
| Button border | none | 1px solid (darker shade) |
| Feed cards | Left accent border on all | Top rule; left accent only on paywalled |
| Crimson usage | Sidebar only | Rules, drop caps, ornaments, hover, gates |
| Nav active state | bg-crimson-dark full swap | 3px crimson left-border on dark ink |
| Ornament colour | #9E9B97 (grey) | #9B1C20 (crimson) |
| Blockquote border | #D46F72 (light) | #9B1C20 (full crimson) |
| Rule accent | 2px | 3px |
| Drop caps | None | Crimson, Newsreader 500, 3.5em |

---

## How to use this with Claude Code

Paste the following prompt (or a trimmed version) into Claude Code:

> Read DESIGN-BRIEF.md in the repo root. It contains exact instructions for a visual redesign. Work through the files in order (sections 2–12), making every change specified. Do not change any business logic, API calls, or component structure — this is purely visual. After each file, verify it compiles (run `cd web && npx next build` or just `npx tsc --noEmit` in the web directory).

Copy this file to the repo root before starting.

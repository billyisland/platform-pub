# Platform — Logo & Mark Specification

This document specifies the Platform identity mark, its relationship to the wordmark, and the implementation changes needed across the codebase. It replaces the current text-only logo treatment.

---

## The mark

Three dots arranged in a ∴ (therefore) triangle. No containing box, no border. The mark is freestanding.

### Geometry

The mark is defined in a `viewBox="0 0 26 22"` SVG coordinate space:

```svg
<svg viewBox="0 0 26 22" xmlns="http://www.w3.org/2000/svg">
  <circle cx="13" cy="4.5" r="4.0" fill="currentColor"/>
  <circle cx="5.2" cy="17.5" r="4.0" fill="currentColor"/>
  <circle cx="20.8" cy="17.5" r="4.0" fill="currentColor"/>
</svg>
```

The triangle is slightly wider than it is tall (26:22 ratio), giving it a grounded, stable stance. The top dot sits at roughly 20% from the top of the viewBox; the bottom two sit at roughly 80%. The gap between the bottom dots is approximately one dot-diameter.

### Dot radius

The mark exists at two weights:

| Weight | Radius | Used for |
|--------|--------|----------|
| Heavy | `r="4.0"` in a 26×22 viewBox | Nav mark, app icon, favicon |
| Light | `r="2.8"` in a 26×22 viewBox | Section ornament between content |

The heavy weight is the identity mark. The light weight is the typographic ornament — punctuation, not branding.

### Associations

The ∴ carries several concurrent readings, none of which need to be explained to users:

- **Therefore** — logical argument; premises leading to conclusions. A place where reasoning matters.
- **Platform** — three points of support; the simplest stable structure. A tripod.
- **Equality** — the equals sign rotated. Fair terms, 92% payout, no algorithmic suppression.
- **Craft guild** — the three-point mark has Masonic and artisan-guild heritage. Writers as craftspeople.

---

## Identity system

The identity operates in three tiers, determined by context.

### Tier 1: Full lockup (platform mode nav)

Mark + wordmark, side by side. This is the primary brand expression.

```
[∴ mark]  Platform
 crimson   crimson, Literata italic 500, 20px
```

- Mark: heavy weight (r=4.0), rendered at 22×18px display size, crimson `#B5242A`
- Gap between mark and wordmark: 7px
- Wordmark: Literata italic, weight 500, 20px, crimson `#B5242A`, `letter-spacing: -0.01em`
- The mark and wordmark are vertically centred on the nav bar's midline

### Tier 2: Mark only (canvas mode nav)

The mark alone, small and grey. The quietest brand presence.

- Mark: heavy weight (r=4.0), rendered at 16×13px display size
- Colour: `grey-400` (`#999999`), hover `grey-600` (`#666666`)
- No wordmark. The mark is the only brand element in the nav bar.

### Tier 3: App icon / favicon

The mark on a background, with the OS or browser providing containment.

**App icon (iOS/Android/PWA):**
- Crimson background (`#B5242A`), white dots
- The mark is centred in the icon canvas at approximately 58% of the icon's width
- The OS applies its own rounded-rect mask

**Favicon (16×16):**
- Crimson dots on transparent background
- At this size the dots naturally merge toward a triangular impression — this is acceptable and intentional
- Provide a dedicated 16×16 SVG favicon with slightly enlarged dots (`r="4.8"` in the same viewBox) to ensure legibility

**Favicon SVG:**
```svg
<svg viewBox="0 0 26 22" xmlns="http://www.w3.org/2000/svg">
  <circle cx="13" cy="4.5" r="4.8" fill="#B5242A"/>
  <circle cx="5.2" cy="17.5" r="4.8" fill="#B5242A"/>
  <circle cx="20.8" cy="17.5" r="4.8" fill="#B5242A"/>
</svg>
```

---

## The ornament

The `· · ·` ornament that currently appears as a section divider throughout the site is replaced by the ∴ triangle at light weight.

### Ornament geometry

Same triangle arrangement as the mark, with smaller dots:

```svg
<svg viewBox="0 0 26 22" xmlns="http://www.w3.org/2000/svg">
  <circle cx="13" cy="4.5" r="2.8" fill="currentColor"/>
  <circle cx="5.2" cy="17.5" r="2.8" fill="currentColor"/>
  <circle cx="20.8" cy="17.5" r="2.8" fill="currentColor"/>
</svg>
```

### Ornament colour

- In platform mode: crimson `#B5242A` (matching the current `· · ·` colour from DESIGN.md)
- In canvas mode (article reader): grey-400 `#999999` — the ornament follows the same recessive rules as the logo

### Ornament display size

Rendered at approximately 24×20px display size. Centred horizontally. Vertical spacing above and below remains as currently specified per context (varies by page).

---

## Implementation

### New file: `web/src/components/icons/ThereforeMark.tsx`

A reusable SVG component for the mark.

```tsx
interface ThereforeMarkProps {
  size?: number          // display width in px (height scales proportionally)
  weight?: 'heavy' | 'light'
  className?: string     // for colour via Tailwind (e.g. text-crimson, text-grey-400)
}

export function ThereforeMark({
  size = 22,
  weight = 'heavy',
  className = '',
}: ThereforeMarkProps) {
  const r = weight === 'heavy' ? 4.0 : 2.8
  const h = Math.round(size * (22 / 26))

  return (
    <svg
      width={size}
      height={h}
      viewBox="0 0 26 22"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <circle cx="13" cy="4.5" r={r} />
      <circle cx="5.2" cy="17.5" r={r} />
      <circle cx="20.8" cy="17.5" r={r} />
    </svg>
  )
}
```

### Changes to `web/src/components/layout/Nav.tsx`

**Platform mode logo (lines 294–301):**

Replace the `<Link>` containing the "Platform" text with the mark + wordmark lockup:

```tsx
{/* Logo — mark + wordmark lockup */}
<Link
  href={logoHref}
  className="flex items-center gap-[7px] flex-shrink-0 group"
>
  <ThereforeMark
    size={22}
    weight="heavy"
    className="text-crimson group-hover:text-crimson-dark transition-colors"
  />
  <span className="font-serif text-[20px] font-medium italic text-crimson group-hover:text-crimson-dark transition-colors leading-none"
    style={{ letterSpacing: '-0.01em' }}
  >
    Platform
  </span>
</Link>
```

**Canvas mode logo (lines 244–250):**

Replace the "Platform" text link with the mark only:

```tsx
{/* Logo — mark only, grey */}
<Link
  href={logoHref}
  className="flex-shrink-0"
>
  <ThereforeMark
    size={16}
    weight="heavy"
    className="text-grey-400 hover:text-grey-600 transition-colors"
  />
</Link>
```

### Changes to `web/src/app/globals.css`

**Replace the ornament class (lines 118–127):**

Remove the text-based `· · ·` ornament and replace with a class that styles the SVG ornament container:

```css
.ornament {
  @apply text-center select-none;
  display: flex;
  justify-content: center;
  align-items: center;
  color: #B5242A;
}
```

Remove the `::before` pseudo-element entirely — the ornament content is now provided by the `<ThereforeMark>` component, not by CSS content.

### Changes to ornament usage in pages

Every `<div className="ornament" />` (self-closing, relying on `::before`) becomes a container for the component:

**`web/src/components/article/ArticleReader.tsx` (line 235):**
```tsx
<div className="ornament mt-16 mb-12">
  <ThereforeMark size={24} weight="light" className="text-grey-400" />
</div>
```

Note: in the article reader (canvas mode), the ornament uses `text-grey-400` instead of crimson.

**`web/src/app/page.tsx` (line 100):**
```tsx
<div className="mt-32 ornament">
  <ThereforeMark size={24} weight="light" />
</div>
```

**`web/src/app/about/page.tsx` (line 39):**
```tsx
<div className="ornament mb-12">
  <ThereforeMark size={24} weight="light" />
</div>
```

**`web/src/app/auth/page.tsx` (line 81):**
```tsx
<div className="ornament mb-8">
  <ThereforeMark size={24} weight="light" />
</div>
```

**`web/src/components/article/PaywallGate.tsx` (line 49):**

The paywall gate has an inline `· · ·` rather than the `.ornament` class. Replace:

```tsx
<div className="text-center mb-6 font-mono text-[14px] tracking-[0.5em] text-crimson select-none">· · ·</div>
```

with:

```tsx
<div className="text-center mb-6">
  <ThereforeMark size={24} weight="light" className="text-crimson" />
</div>
```

### Favicon and app icon files

**`web/public/favicon.svg`** — new file:

```svg
<svg viewBox="0 0 26 22" xmlns="http://www.w3.org/2000/svg">
  <circle cx="13" cy="4.5" r="4.8" fill="#B5242A"/>
  <circle cx="5.2" cy="17.5" r="4.8" fill="#B5242A"/>
  <circle cx="20.8" cy="17.5" r="4.8" fill="#B5242A"/>
</svg>
```

**`web/public/apple-touch-icon.png`** — generate from this SVG at 180×180px:

White ∴ dots on crimson `#B5242A` background. Centre the mark at approximately 58% of the canvas width. Use the heavy weight (`r="4.0"` in the 26×22 viewBox).

**`web/public/icon-192.png`** and **`web/public/icon-512.png`** — same treatment for PWA manifest icons.

---

## What not to do

- **Never put the mark inside a box or border.** The earlier boxed treatments (v3.18 through v4.0) are superseded. The freestanding dots are the mark.
- **Never use the mark as a monogram initial.** It is not the letter P. It is an abstract symbol.
- **Never rotate or rearrange the dots.** The orientation is always ∴ (one up, two down). The inverted form (∵) is "because" and carries the wrong connotation.
- **Never use the heavy-weight dots as the section ornament.** The ornament is always light weight. The distinction between mark (heavy) and ornament (light) is what prevents the logo from feeling stamped between every section.
- **Never show the mark in crimson in canvas mode.** Canvas mode is the writer's space. The mark appears in grey only, matching the recessive-brand rules from DESIGN.md.

---

## Summary of changes

| Element | Before | After |
|---------|--------|-------|
| Platform-mode logo | "Platform" — Literata italic 22px crimson | ∴ mark (22×18px, crimson) + "Platform" wordmark |
| Canvas-mode logo | "Platform" — Literata italic 16px grey | ∴ mark only (16×13px, grey-400) |
| Section ornament | `· · ·` via CSS `::before` | ∴ triangle, light weight, via `<ThereforeMark>` component |
| Favicon | None specified | ∴ SVG, crimson on transparent |
| App icon | None specified | White ∴ on crimson background |
| Paywall gate ornament | Inline `· · ·` text | `<ThereforeMark>` component, crimson |

---

## Files affected

New:
- `web/src/components/icons/ThereforeMark.tsx`
- `web/public/favicon.svg`
- `web/public/apple-touch-icon.png` (generated)
- `web/public/icon-192.png` (generated)
- `web/public/icon-512.png` (generated)

Modified:
- `web/src/components/layout/Nav.tsx` — logo in both modes
- `web/src/app/globals.css` — ornament class
- `web/src/components/article/ArticleReader.tsx` — ornament
- `web/src/components/article/PaywallGate.tsx` — ornament
- `web/src/app/page.tsx` — ornament
- `web/src/app/about/page.tsx` — ornament
- `web/src/app/auth/page.tsx` — ornament
- `web/src/app/layout.tsx` — favicon link tag (if not already SVG)

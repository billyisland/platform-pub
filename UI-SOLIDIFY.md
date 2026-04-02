# UI Solidification Pass

Make the redesign feel more solid, chunky, and confident without changing the design language. All changes stay within the existing token system — no new colours, components, or layout grids.

---

## 1. Bump base body font size: 15px → 16px

**File:** `web/src/app/globals.css`

In the `@layer base` body rule, change `font-size: 0.9375rem` to `font-size: 1rem`. This only affects UI chrome (nav, cards, metadata, forms). Article prose is already 17px via the typography plugin and is unaffected.

```css
/* before */
body {
  font-size: 0.9375rem;
}

/* after */
body {
  font-size: 1rem;
}
```

---

## 2. Promote the grey scale — fewer 300s, more 400s/600s

The biggest contributor to the "faint" feeling. `text-grey-300` is `#BBBBBB` — roughly 1.6:1 contrast on white, below WCAG minimums at small sizes.

### 2a. ArticleCard byline and metadata

**File:** `web/src/components/feed/ArticleCard.tsx`

| Element | Before | After |
|---------|--------|-------|
| Byline (author name) | `text-grey-300` | `text-grey-400` |
| Metadata row (date, read time, replies) | `text-grey-300` | `text-grey-400` |
| `/` separators in metadata | `opacity-40` | `opacity-60` |

### 2b. NoteCard timestamp

**File:** `web/src/components/feed/NoteCard.tsx`

| Element | Before | After |
|---------|--------|-------|
| Timestamp next to author name | `text-grey-300` | `text-grey-400` |
| Action labels (Reply, Quote) | `text-grey-300` | `text-grey-400` |

### 2c. Homepage section labels

**File:** `web/src/app/page.tsx`

All three section labels ("THE DEAL", "HOW IT WORKS", "NOW WRITING ON PLATFORM") use `text-grey-300`. Change to `text-grey-400`.

### 2d. Canvas-mode logo

**File:** `web/src/components/layout/Nav.tsx`

The canvas-mode (minimal bar) logo is `text-grey-300 hover:text-grey-400`. Change to `text-grey-400 hover:text-grey-600`.

### 2e. Global label-muted class

**File:** `web/src/app/globals.css`

```css
/* before */
.label-muted {
  color: #BBBBBB;
}

/* after */
.label-muted {
  color: #999999;
}
```

### 2f. Ornament divider

**File:** `web/src/app/globals.css`

```css
/* before */
.ornament {
  color: #BBBBBB;
}

/* after */
.ornament {
  color: #999999;
}
```

---

## 3. Thicken the keylines

### 3a. `.rule` class — currently nearly invisible

**File:** `web/src/app/globals.css`

```css
/* before */
.rule {
  height: 1px;
  background: #F0F0F0;
}

/* after */
.rule {
  height: 1px;
  background: #E5E5E5;
}
```

### 3b. ArticleCard border-bottom

**File:** `web/src/components/feed/ArticleCard.tsx`

Change the card wrapper class from `border-b border-grey-100` to `border-b border-grey-200`.

### 3c. Dashboard table row borders

**File:** `web/src/app/dashboard/page.tsx`

The `<thead>` and `<tr>` elements use `border-grey-200/50`. Remove the `/50` opacity modifier so they render at full strength: `border-grey-200`.

---

## 4. Give the nav more presence

**File:** `web/src/components/layout/Nav.tsx`

### 4a. Add shadow to platform-mode header

Replace the border-bottom approach with a shadow for physical weight:

```
/* platform-mode header element */
before: className="fixed top-0 inset-x-0 z-50 bg-white border-b border-grey-200"
after:  className="fixed top-0 inset-x-0 z-50 bg-white border-b border-grey-200 shadow-[0_1px_3px_rgba(0,0,0,0.04)]"
```

### 4b. Bump logo size

In the platform-mode logo `<Link>`, change `text-[20px]` to `text-[22px]`.

---

## 5. Fatten the article card left accent

**File:** `web/src/components/feed/ArticleCard.tsx`

In the inline `style` on the card wrapper `<div>`:

```js
// before
style={{ borderLeft: isPaid ? '3px solid #B5242A' : '3px solid transparent', ... }}

// after — thicker accent, visible neutral spine on free articles
style={{ borderLeft: isPaid ? '4px solid #B5242A' : '4px solid #E5E5E5', ... }}
```

This gives every card a consistent left "spine" and makes the feed feel like a printed column.

---

## 6. Increase vertical padding on feed cards

**File:** `web/src/components/feed/ArticleCard.tsx`

Change the card wrapper class from `py-6` to `py-8`. The extra breathing room makes the feed feel more generous and confident.

---

## 7. Bump mono metadata text from 11px to 12px

This is a cross-component change. Every instance of `text-[11px]` in metadata/byline contexts should become `text-[12px]`. This aligns them with nav link size and tab labels, creating a single "small mono" tier.

### Files to update:

| File | Elements |
|------|----------|
| `components/feed/ArticleCard.tsx` | Byline, metadata row |
| `components/feed/NoteCard.tsx` | Timestamp, action labels, quote attribution |
| `components/article/PaywallGate.tsx` | Trust badges row at bottom |
| `components/article/ArticleReader.tsx` | Any 11px mono metadata |
| `components/feed/QuoteCard.tsx` | Attribution line |

Search the `web/src/components` directory for `text-[11px]` and update each instance to `text-[12px]`.

---

## 8. Tighten button padding ratio

**File:** `web/src/app/globals.css`

The loose padding makes button text float in too much space. Slightly more compact proportions paradoxically read as more solid.

```css
/* before — .btn, .btn-accent, .btn-ghost, .btn-soft */
padding: 0.875rem 2.25rem;

/* after */
padding: 0.75rem 2rem;
```

Apply to all four button classes: `.btn`, `.btn-accent`, `.btn-ghost`, `.btn-soft`.

---

## 9. Strengthen the "How it works" box on homepage

**File:** `web/src/app/page.tsx`

Change the container class from `bg-grey-50 border border-grey-200` to `bg-grey-100 border border-grey-200`. The slightly darker fill makes the panel read as a definite element rather than a faint wash.

---

## 10. Paywall gate trust badges and ornament

**File:** `web/src/components/article/PaywallGate.tsx`

### 10a. Trust badges

These are selling points, not footnotes. Change the bottom row from `text-[11px] text-grey-400` to `text-[12px] text-grey-600`.

### 10b. Ornament size

The `· · ·` ornament at `text-[12px]` is tiny. Change to `text-[14px]` so it reads as a deliberate pause.

---

## Summary of token-level changes

| Token / pattern | Before | After |
|----------------|--------|-------|
| Body font size | 0.9375rem (15px) | 1rem (16px) |
| Secondary text colour | `grey-300` widespread | `grey-400` minimum |
| `.label-muted` colour | #BBBBBB | #999999 |
| `.ornament` colour | #BBBBBB | #999999 |
| `.rule` background | #F0F0F0 | #E5E5E5 |
| Card border-bottom | `grey-100` | `grey-200` |
| Card left border (free) | transparent | #E5E5E5 |
| Card left border width | 3px | 4px |
| Card vertical padding | py-6 | py-8 |
| Mono metadata size | 11px | 12px |
| Button padding | 0.875rem 2.25rem | 0.75rem 2rem |
| Nav logo size | 20px | 22px |
| Nav header | border only | border + subtle shadow |
| Homepage "How it works" bg | grey-50 | grey-100 |
| Paywall trust badges | 11px grey-400 | 12px grey-600 |

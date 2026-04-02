# Platform — Design Spec v2

**"Chunky, robust, spirited."**
The home for writers who are serious about real writing, real reporting, and owning their own platform.

---

## 1. Design Principles

**Physical weight.** Every surface should feel like it sits on something. Cards rest on ledges. Buttons depress like typewriter keys. Rules are thick enough to cast a shadow in your mind. Nothing floats.

**Confident scale.** Text should be readable at arm's length. If it's important enough to be on the page, it's important enough to be seen without squinting. The smallest functional text is 13px. Metadata is 13px. Body is 16px. Headlines earn their space.

**Editorial spirit.** This is a place that cares about craft. Typographic gestures — drop caps, italic headlines, small-caps labels, ornamental dividers — signal that the platform respects the tradition of publishing. Not retro pastiche; living editorial grammar.

**Institutional confidence.** The homepage should feel like walking into the lobby of a serious publication, not a startup landing page. Show real work by real writers. Explain the business model plainly. Don't beg — invite.

---

## 2. Colour Tokens

No palette changes — the existing colours are distinctive. Two adjustments to improve contrast and warmth on interactive elements.

| Token | Old | New | Notes |
|---|---|---|---|
| `content-faint` | `#7A9A8A` | `#6B8E7A` | One notch darker/warmer. Used for inactive nav, secondary metadata. |
| `content-muted` | `#4A6B5A` | `#3D5E4D` | One notch darker. Used for labels, supporting body text. |
| All others | — | Unchanged | `surface`, `surface-deep`, `card`, `rule`, `accent`, `ink` remain as-is. |

### Tailwind config change

```js
content: {
  DEFAULT: '#0F1F18',
  primary: '#0F1F18',
  secondary: '#263D32',
  muted: '#3D5E4D',       // was #4A6B5A
  faint: '#6B8E7A',       // was #7A9A8A
  'card-muted': '#8A8578',
  'card-faint': '#ACA69C',
},
```

---

## 3. Wordmark / Logo

The "Platform" wordmark in the sidebar and mobile header.

| Property | Old | New |
|---|---|---|
| Font | Literata 600 | Literata 700 |
| Size | 28px | 30px |
| Colour | `#B5242A` (accent) | Unchanged |
| Border | `1.5px solid #B5242A` | **`3.5px solid #B5242A`** |
| Padding | `5px 14px 7px` | `5px 15px 8px` |
| Letter-spacing | `-0.02em` | Unchanged |

The heavier border should feel like a wax seal pressed into paper — a thick, confident impression. Not a hairline rule with colour; a physical mark.

---

## 4. Typography Scale

### Headlines (Literata, italic)

| Context | Old | New |
|---|---|---|
| Homepage hero | 6xl / 7xl | Unchanged (clamp 3rem–4.5rem) |
| Article card headline | 26px / weight 500 | **28px / weight 500** (1.5rem → 1.625rem) |
| Article page title | clamp(2.25rem, 4vw, 3rem) | Unchanged |
| Manifesto lines (new) | — | clamp(1.5rem, 3vw, 2rem), italic, weight 400 |

### Body text (Source Sans 3 / Literata for articles)

| Context | Old | New |
|---|---|---|
| Card excerpt | 14.5px / weight 400 | **16px / weight 400** |
| Note body | 15px | **16px** |
| Article body (prose) | 1.125rem / line-height 1.8 | Unchanged |
| About page body | text-lg (18px) | Unchanged |

### Metadata & Labels (Source Sans 3)

| Context | Old | New |
|---|---|---|
| Author label on cards | 11px / weight 600 | **13px / weight 700** |
| Date/time/read metadata | 11px | **13px** |
| Nav sidebar links | 15px / weight 400/600 | **17px / weight 500/700** |
| Tab labels | 13px / weight 500 | **15px / weight 500/700** |
| Mono labels (IBM Plex Mono) | — | 12–13px, uppercase, `letter-spacing: 0.04–0.08em` |

### Minimum text size

Nothing below **12px** anywhere in the interface. The previous 10px and 11px sizes for user initials, micro-labels, and metadata are all bumped to 12–13px.

---

## 5. Rules & Dividers

| Element | Old | New |
|---|---|---|
| `.rule` (main structural) | 1px `#B8D2C1` | **2px `#B8D2C1`** |
| `.rule-inset` (secondary) | 1px | **1.5px** |
| `.rule-accent` | `border-top: 1px` | **`border-top: 2.5px`** |
| Sidebar vertical rule | `border-l border-rule` (1px) | **`border-l-2 border-rule`** (2px) |
| Card bottom border (new) | None | **`border-bottom: 2.5px solid #B8D2C1`** |
| Paywall gate top/bottom (new) | None | **`border-top: 3px solid #B5242A; border-bottom: 3px solid #B5242A`** |
| Sidebar bottom user section | None | **`border-top: 2px solid #B8D2C1`** |

### CSS changes

```css
.rule {
  height: 2px;         /* was 1px */
  background: #B8D2C1;
}
.rule-inset {
  height: 1.5px;       /* was 1px */
}
.rule-accent {
  border-top: 2.5px solid #B8D2C1; /* was 1px */
}
```

---

## 6. Buttons

All three button variants get the same structural upgrade.

### `.btn` (primary dark)

```css
.btn {
  background: #0F1F18;
  color: #FFFFFF;
  font-size: 1rem;            /* was 0.875rem */
  font-weight: 600;           /* was 500 */
  padding: 1rem 2.5rem;       /* was 0.75rem 2rem */
  border-bottom: 3px solid #060e0a;  /* NEW — pressed key effect */
  border-radius: 2px;
  transition: background-color 0.15s ease, transform 0.08s ease;
}
.btn:hover { background: #263D32; }
.btn:active {
  transform: translateY(2px);
  border-bottom-width: 1px;
}
```

### `.btn-accent` (crimson)

```css
.btn-accent {
  background: #B5242A;
  color: #FFFFFF;
  font-size: 1rem;
  font-weight: 600;
  padding: 1rem 2.5rem;
  border-bottom: 3px solid #8A1B20;  /* NEW */
  border-radius: 2px;
}
.btn-accent:active {
  transform: translateY(2px);
  border-bottom-width: 1px;
}
```

### `.btn-soft` (ghost/outline)

```css
.btn-soft {
  background: transparent;
  color: #0F1F18;
  font-size: 1rem;
  font-weight: 600;
  padding: 1rem 2.5rem;
  border: 1.5px solid #B8D2C1;       /* NEW — visible border */
  border-radius: 2px;
}
.btn-soft:hover {
  background: #263D32;
  color: #FFFFFF;
  border-color: #263D32;
}
```

### Small variant

For inline/compact buttons (follow, quote, tab actions), use a `.btn-sm` modifier:

```css
.btn-sm {
  font-size: 0.875rem;
  padding: 0.625rem 1.5rem;
}
```

---

## 7. Article Cards

The feed card is the most frequently seen element. It needs to feel like a tangible object.

### Structure

```
┌──────────────────────────────────────────────┐
│ 4px left border (transparent → accent hover) │
│                                              │
│  AUTHOR LABEL  (13px, 700, uppercase, #8A8578)
│                                              │
│  Headline in Literata italic                 │
│  28px, weight 500, #0F1F18                   │
│                                              │
│  Excerpt in Source Sans 3                    │
│  16px, weight 400, #263D32                   │
│                                              │
│  28 Mar / 7 min / 4 replies / £0.40  ▲ 7    │
│  (13px, #ACA69C, price in #B5242A bold)      │
│                                              │
├──────────────────────────────────────────────┤
│ 2.5px bottom border (#B8D2C1)                │
└──────────────────────────────────────────────┘
```

### Key CSS

```css
/* Card container */
background: #FFFAEF;
padding: 1.5rem 1.75rem;
border-left: 4px solid transparent;
border-bottom: 2.5px solid #B8D2C1;
cursor: pointer;
transition: border-left-color 0.12s ease;

/* Hover */
&:hover {
  border-left-color: #B5242A;
}
```

### Spacing between cards

Feed cards stack with `gap: 0` — the 2.5px bottom borders create natural separation. No additional margin between cards.

---

## 8. Sidebar Navigation

### Dimensions

| Property | Old | New |
|---|---|---|
| Width | 240px | Unchanged |
| Right border | 1px `border-rule` | **2px `border-rule`** |
| Link font size | 15px | **17px** |
| Link font weight (inactive) | 400 | **500** |
| Link font weight (active) | 600 | **700** |
| Link padding vertical | `py-3` (12px) | **`py-[14px]`** |
| Active left border | 2px `border-accent` | **4px `border-accent`** |
| Bottom user section | No top border | **`border-top: 2px solid #B8D2C1`** |
| User name font size | 12px | **14px** |

### Active state

```css
/* Active link */
padding-left: calc(1.25rem - 4px);
border-left: 4px solid #B5242A;
font-weight: 700;
color: #0F1F18;

/* Inactive link */
padding-left: 1.25rem;
border-left: 4px solid transparent;
font-weight: 500;
color: #6B8E7A;
```

---

## 9. Paywall Gate

The conversion threshold. Should feel like a proper doorway.

### Layout

```
     ┄┄┄ article text fading out ┄┄┄

  ╔══════════════════════════════════╗  ← 3px #B5242A top border
  ║                                  ║
  ║           · · ·                  ║  ← ornament
  ║                                  ║
  ║        Keep reading              ║  ← Literata 26px
  ║                                  ║
  ║   This will be added to your     ║  ← Source Sans 15px
  ║        reading tab.              ║
  ║                                  ║
  ║           £0.40                  ║  ← Literata 40px
  ║                                  ║
  ║     [ Continue reading ]         ║  ← btn-accent, full chunky size
  ║                                  ║
  ║  No subscription / Pay per read  ║  ← 13px trust signals
  ║                                  ║
  ╚══════════════════════════════════╝  ← 3px #B5242A bottom border
```

### Key changes from current

| Property | Old | New |
|---|---|---|
| Gradient fade height | 80px | **100px** |
| Top/bottom border | None | **3px solid #B5242A** |
| Heading size | 20px | **26px** |
| Price size | 28px | **40px** |
| Subtext size | 13px | **15px** |
| Trust signal size | 12px | **13px, weight 500** |
| Button | `btn-accent` (default size) | `btn-accent` (full 1rem/2.5rem size) |

---

## 10. Homepage

The homepage gains three new sections below the existing hero. Total structure:

### Section 1: Hero (existing, tightened)

- Headline: unchanged (clamp 3rem–4.5rem Literata)
- Rule below: upgrade to 2.5px thick
- Body copy: unchanged (19px Source Sans)
- CTA: `btn-accent` at full chunky size

### Section 2: Manifesto (new)

- Mono label: `THE DEAL` — IBM Plex Mono, 13px, uppercase, `letter-spacing: 0.08em`, colour `#6B8E7A`
- Crimson accent rule: 2.5px `#B5242A` top border above the section
- Four statements in Literata italic, clamp(1.5rem, 3vw, 2rem), weight 400, colour `#0F1F18`
- Each separated by a 1px `#B8D2C1` rule (last has no rule)
- Padding: `0.6em 0` per line

Statements:
1. *Own your name.*
2. *Own your audience.*
3. *Own your archive.*
4. *Leave whenever you want, and take everything with you.*

### Section 3: How it works (new)

- Container: `background: #DDEEE4`, `border: 1.5px solid #B8D2C1`, padding `2.5rem 2rem`
- Mono label: `HOW IT WORKS`
- Three-column grid (responsive, `minmax(200px, 1fr)`)
- Each step: mono step number in `#B5242A` (01, 02, 03), bold title in Source Sans 17px/700, body in Source Sans 15px/#3D5E4D

Step content:
1. **Write and publish** — Articles and notes. Set a paywall anywhere in the text, or publish free.
2. **Readers pay per read** — No subscriptions. Charges accumulate on a tab and settle via Stripe.
3. **You keep 92%** — 8% covers running costs. No ads, no algorithmic suppression, no tricks.

### Section 4: Featured writers (new)

- Mono label: `NOW WRITING ON PLATFORM`
- Stack of 3 article cards (same style as feed cards: parchment bg, 2.5px bottom border, 4px hover accent)
- Below: `btn-soft` with label "Read the feed →"

### Section 5: Closing ornament

- `· · ·` ornament, centred

---

## 11. Auth Page

### Adjustments

| Element | Old | New |
|---|---|---|
| Heading | `text-2xl` (24px) | **28px** |
| Input padding | `px-3 py-2.5` | **`px-4 py-[14px]`** (0.875rem) |
| Input border | None | **`1.5px solid #B8D2C1`** |
| Input font size | `text-mono-sm` (15px) | **16px (1rem)** |
| Google button border | None | **`1.5px solid #B8D2C1`** |
| Google button padding | `px-4 py-2.5` | **`px-4 py-[14px]`** |
| Label size | 12px | **13px** |
| Submit button | `.btn` default | `.btn` full size (1rem, 600) |
| "or" divider rule | 1px | **1.5px** |

Inputs should feel like fields you write into, not voids. The visible border gives them definition.

---

## 12. Feed Tabs

| Property | Old | New |
|---|---|---|
| Font size | 13px | **15px** |
| Active weight | 600 | **700** |
| Active underline | 2px | **3px** |
| Inactive weight | 400 | **500** |
| Tab padding | `0.5rem 0` | **`0.625rem 1.25rem`** |

---

## 13. Note Composer

| Property | Old | New |
|---|---|---|
| Border | None | **`1.5px solid #B8D2C1`** |
| Padding | Varies | **`0.875rem 1.25rem`** |
| Font size | Varies | **15px** |
| Placeholder colour | `content-muted` | `content-faint` (`#6B8E7A`) |

---

## 14. Micro-typography Details

These are small gestures that compound into the feeling of editorial care.

**Drop cap** — already exists. No change.

**Article card author labels** — small-caps style via uppercase + 700 weight + `0.05em` tracking. Already close; just bump to 13px.

**Metadata separators** — the `/` dividers between date/time/replies: keep at `opacity: 0.4`. Good as-is.

**Selection colour** — already `background: #B5242A; color: #FFF`. Good.

**Ornament** — `· · ·` in IBM Plex Mono, accent red, `letter-spacing: 0.5em`. Bump size from `0.6875rem` to **`0.75rem`**.

---

## 15. Motion & Interaction

Keep motion minimal and purposeful. This is a reading platform, not a portfolio site.

| Interaction | Spec |
|---|---|
| Card hover (left border) | `transition: border-left-color 0.12s ease` |
| Button active (depress) | `transform: translateY(2px)` on `:active`, `transition: transform 0.08s ease` |
| Nav link hover | `transition: color 0.12s ease` |
| Page transitions | None — standard Next.js navigation. No frills. |
| Loading skeletons | Keep existing `animate-pulse` pattern. No change. |

---

## 16. Implementation Priority

Work in this order. Each step is independently shippable.

1. **`tailwind.config.js`** — Update `content-muted`, `content-faint` tokens.
2. **`globals.css`** — Rules, buttons, ornament, tab classes.
3. **`Nav.tsx`** — Sidebar link sizes, weights, active border width, wordmark border, user section border.
4. **`ArticleCard.tsx`** — Bottom border, left hover border, type scale bumps.
5. **`page.tsx` (homepage)** — Add manifesto, how-it-works, and featured-writers sections.
6. **`PaywallGate.tsx`** — Top/bottom accent borders, price size, gradient height, heading size.
7. **Auth page** — Input borders, padding, button size.
8. **`FeedView.tsx`** — Tab size/weight, composer border.
9. **`NoteCard.tsx`** — Type scale consistency pass.
10. **`ArticleReader.tsx`** — Verify prose scale (should be fine), byline sizing pass.

---

## 17. What Not to Change

- **Font stack.** Literata / Source Sans 3 / IBM Plex Mono is excellent. Don't touch it.
- **Colour palette.** The sage-parchment-crimson identity is distinctive. Only the two faint/muted warmth nudges above.
- **Layout structure.** Sidebar + content area at lg, top bar below lg. Sound.
- **Content widths.** 640px article, 780px feed, 960px frame. Well-judged.
- **The `· · ·` ornament.** It's a good signature. Just make it slightly larger.
- **Rounded-none / sharp aesthetic.** The `border-radius: 2px` throughout is correct. Don't round anything further.

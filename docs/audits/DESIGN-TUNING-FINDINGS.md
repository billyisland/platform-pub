# Design Tuning — Findings & Recommendations

> **Status (2026-06-17): §1–§5 implemented; §6 deferred as a flagged decision.**
> §3 shipped as `spring`/`summer`/`autumn`/`winter` (no user-facing display
> names — the `SchemeSwatch` is the sole identifier), then **reworked 2026-06-21**
> so a scheme is a *colourway* (seasonal character) that adapts to the global
> light/dark toggle — each colourway has a light AND a dark variant; see the
> **§3 addendum**. §2 was corrected on
> implementation: `crimson-dark` and `off-white` are **live** (Tailwind `hover:`
> uses / `ProvenanceBar` canvas) and were kept; only the genuinely-dead
> `neighbour-grey` was removed, and the flagged hardcoded hexes are the exempt
> Stripe iframe appearance. Gateway scheme ids live at
> `gateway/src/routes/feeds/crud.ts`, not `feeds.ts`.

A tuning pass, not a rebuild. The system is coherent Swiss/Bauhaus (hard edges,
slab rules instead of hairlines, three-voice type, crimson accent). The goal is
to resolve a few seams that make the whole read as slightly muddy and
unresolved, and to fix the per-feed colour schemes, which aren't yet working.

Scope reviewed: `web/tailwind.config.js`, `web/src/app/globals.css`,
`web/src/lib/palette/registry.ts`, `web/src/components/workspace/tokens.ts`,
plus token-usage and line-weight greps across `web/src`.

---

## 1. Colour — the warm/cool seam (root cause of the muddiness)

The system runs **two neutral ramps at different temperatures**, segregated by
context:

- `grey-*` — pure-neutral (equal RGB). Used for light app chrome: soft fills,
  hover, input edges, disabled states, placeholders, secondary text.
- `stone-*` / `bone` / `cream` — warm. Used for the workspace floor, glasshouse
  wells, dark-mode card text, standfirst, meta.

This half-works because the two families mostly stay in their own worlds. The
muddiness appears only at the **seams** where they meet — a neutral `grey-100`
chip on a warm `bone` surface, grey rules on `cream`/glasshouse wells. Against a
warm ground a pure-neutral grey reads faintly cold/green. Nothing is dirty; the
surfaces are simply out of temperature agreement.

**Recommendation — warm the light end of `grey-*` only.** Nudge the greys that
cross into the warm world toward the `bone` temperature (R ≥ G > B). Leave the
dark greys (`grey-400`/`600`, mostly text on white) neutral. Components keep
referencing the same tokens; only values move, so it's fully reversible.

| Token | now | proposed | note |
|---|---|---|---|
| `grey-100` | `#F0F0F0` | `#F2F1ED` | soft fills, ghost buttons, paywall panel |
| `grey-200` | `#E5E5E5` | `#E7E5DF` | hover fills, input edges |
| `grey-300` | `#BBBBBB` | `#B9B7AF` | external card bar, disabled, blockquote rule |
| `grey-400` | `#999999` | leave | placeholder/muted text — keep neutral |
| `grey-600` | `#666666` | leave (optional small nudge) | secondary text |

Secondary issue: the ramp has an uneven step. `grey-200` → `grey-300` jumps 42
units (229 → 187) against an 11-unit step above it. Not urgent; flag only. Don't
add steps (no revolution) — smooth in place if/when it bothers you.

---

## 2. Token sprawl — prune the duplicates (the "unresolved" tax)

When several tokens do near-identical jobs, no choice feels canonical, which
reads as unresolved even when each screen is fine.

| Token | value | verdict |
|---|---|---|
| `crimson-dark` | `#921D22` | **Dead** — declared in registry + globals, used nowhere. Remove. |
| `neighbour-grey` | `#CCCCCC` | **Dead** — labelled "legacy," used nowhere. Remove. |
| `glasshouse-well` | `#F5F4F0` | Identical value to `cream`. Keep slug for semantics; document/align as one value. |
| `cream` | `#F5F4F0` | Canonical of the pair above. |
| `off-white` | `#FAFAFA` | Neutral; near-dupe of `cream-hover` at opposite temperature. Pick one. |
| `cream-hover` | `#FAFAF7` | Warm; preferred survivor of the pair. |

Also: a handful of **warm-greys are hardcoded outside the token system** —
`#1A1A1A` (≈ `ink-925`), `#292524`, `#a8a29e`. Repoint to tokens. The Google
brand hexes on the OAuth button (`#4285F4` etc.) are a legitimate exception —
leave them.

---

## 3. Feed colour schemes — replace with four seasons

### Why the current three don't cohere

They don't share a construction grammar:

- **Vela** (teal frame / cream content) and **Caju** (ember frame / peach
  content) both work on one logic: a saturated *frame* around a desaturated,
  warm-tinted *light reading surface*.
- **Anil** breaks it — indigo walls (`#1B2742`) but a *burnt-umber* interior
  (`#472D20`). A brown floor under blue walls: two unrelated dark hues, no
  shared story. This is the one that reads broken.

### The model (unchanged)

Each scheme commits **three surfaces only** — `walls` (also the bar and the
quote-embed surface), `interior` (the ground), `card` (the reading surface).
All text, meta, semantic and bar-well colours are **derived by luminance**
(`components/workspace/tokens.ts`), selecting between the tuned light/dark text
ramps. Two hard constraints follow:

1. The card must be **clearly** light or dark — a mid-luminance card defeats
   both text ramps.
2. Because the derived text family is warm (`stone`/`bone`), surfaces want a
   slight warm/cool *tint* (not pure saturation) to agree with it.

### Proposed set — one shared grammar, four moods

Saturated frame → tinted ground → clean reading surface, varied across season
and assertiveness (Spring vivid, Summer intense, Autumn bold, Winter quiet).
Three light-card, one dark-card — all clear of the mid-luminance band.

| Scheme | mood | walls | interior | card | card |
|---|---|---|---|---|---|
| Spring | fresh / vivid | `#2F7D4A` | `#DCEBCF` | `#F4F8EC` | light |
| Summer | intense | `#0E5DB0` | `#F2D89E` | `#FCF3DD` | light |
| Autumn | bold | `#B5461E` | `#E9C9B4` | `#FBEFE3` | light |
| Winter | muted | `#232E45` | `#2C3850` | `#34425E` | dark |

Winter is what Anil should have been: a single cool slate-indigo family stepped
walls → interior → card as a clean dark elevation ramp (mirrors how `dark`
steps `true-black` → `ink-925` → `ink-900`).

**Naming is open.** The Brazilian-modernist convention (Anil/Vela/Caju) can
continue with new Portuguese names, or season names can become literal.

### Change surface (per the existing scheme wiring)

Adding/renaming schemes touches all of:

- `web/src/lib/palette/registry.ts` — the nine `*-walls` / `*-interior` /
  `*-card` entries (and their order, which is canonical for the devtool).
- `web/src/app/globals.css` — the matching `--ah-*-rgb` triples (keep in sync
  with the registry).
- `web/src/components/workspace/tokens.ts` — the `FeedScheme` union,
  `SCHEME_SURFACES`, `PALETTES`, and `SCHEME_OPTIONS`.
- `gateway/src/routes/feeds.ts` — `FEED_SCHEME_IDS` (PATCH validation must
  mirror the union).
- `normalizeBrightness` — map retired ids (`anil`/`vela`/`caju`) onto a default
  so stale persisted layouts keep working.

### Addendum (2026-06-21) — a scheme is a colourway, light/dark is global

The four-seasons set above (and the former `primary`/`dark` pair) shipped as
**mode-fixed** schemes: Spring/Summer/Autumn were always light, Winter always
dark, and a vessel kept its scheme colours regardless of the global light/dark
toggle (frozen by `LIGHT_ISLAND_STYLE`). That has been reworked so the **scheme
is a COLOURWAY (seasonal character), orthogonal to light/dark**:

- Five colourways — `basic` (the former `primary`/`dark` collapsed into one) plus
  `spring`/`summer`/`autumn`/`winter`. `primary`/`dark` alias to `basic`.
- **Each colourway carries BOTH a light and a dark surface set.** The variant is
  chosen by the **global** toggle via `paletteFor(scheme, dark)`; the colourway
  only sets the hue/energy. So a Spring feed is fresh-green-light in light mode
  and fresh-green-dark in dark mode.
- The original variant of each keeps its slug names; the added variant is
  suffixed `-dk` (Spring/Summer/Autumn, which were light-first) or `-lt`
  (Winter, dark-first). The new variant surfaces (walls / interior / card):

  | Colourway | added variant | walls | interior | card |
  |---|---|---|---|---|
  | Spring | dark (`-dk`)  | `#2C7A47` | `#15201A` | `#1E2D24` |
  | Summer | dark (`-dk`)  | `#0F5BA8` | `#221C12` | `#2E2719` |
  | Autumn | dark (`-dk`)  | `#B5461E` | `#251A14` | `#32271E` |
  | Winter | light (`-lt`) | `#2B3756` | `#D8DDEA` | `#EFF2F8` |

- The light-island still wraps desktop vessels **and now the mobile per-feed
  pages** (`MobileWorkspace.tsx`), but its role is narrowed: it keeps the derived
  *text* slugs (bone/ink/white/stone) canonical so the ramps stay deterministic
  — the variant supplies the light/dark, not the island. Mobile thus honours the
  colourway too (it previously ignored it). The `SchemeSwatch` previews the
  variant for the *current* global mode.
- Wiring delta vs. the "Change surface" list above: `tokens.ts` now exposes
  `paletteFor(scheme, dark)`, `BASIC_LIGHT`/`BASIC_DARK`, and `SEASONAL_PALETTES`
  (the precomputed 4×2 variants) in place of the single static `PALETTES`;
  `FEED_SCHEME_IDS` lives at `gateway/src/routes/feeds/crud.ts`.

---

## 4. Line weights — leave them

Already disciplined: 2px for component borders, 4px for structural rules, 6px
for the hero slab. One real drift to fix:

- Blockquote is **2px** in `.article-compose-body` but **4px** in the prose
  typography config. Reconcile to one (recommend 4px to match read view).

---

## 5. Type scale

The serif heading scale is the strong part and should be left alone: body
`1.0625rem` → h3 `1.35` → h2 `1.75` → h1 `2.25` is a consistent ~1.28 ratio
(near a major third).

One real fault: **the editor and the article disagree.** Compose headings are
set in px (`h2: 22px`, `h3: 18px`) while rendered prose uses the rem scale
(`h2: 28px`/`1.75`, `h3: 21.6px`/`1.35`). Same semantic level, different size —
what you type isn't sized like what you read.

- **Fix:** move the `.article-compose-body` headings onto the prose ratio.

The small UI/mono sizes (11/13/14/15px) are clustered and off-ratio, but that's
normal pragmatism for chrome text — leave.

---

## 6. Light/dark elevation asymmetry (a decision, not a bug)

Dark mode has a real tonal elevation ramp (`ink-925` ground → `ink-900` card →
`ink-850` input). Light mode is flat white-on-white, with separation carried
entirely by slab rules and bars. Defensible Bauhaus logic — but it's why light
mode can feel slightly flatter / less resolved than dark. Worth a deliberate
call: either accept it as the house style, or introduce one faint warm-grey
surface step in light mode for cards/wells. No action implied; flagging so it's
a choice rather than an accident.

---

## Priority order

1. **Feed schemes → four seasons** (§3) — the thing that's visibly not working.
2. **Warm the light-end greys** (§1) — biggest single fix for the muddiness.
3. **Prune dead/duplicate tokens** (§2) — removes the unresolved tax.
4. **Reconcile compose vs prose type** (§5) and the blockquote weight (§4) —
   small, cheap, correct.
5. **Decide on light-mode elevation** (§6) — optional, deliberate.

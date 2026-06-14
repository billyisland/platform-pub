# FEED-SCHEME-REFRESH-ADR: New Per-Feed Colour Schemes

**all.haus Architectural Decision Record**
**Status:** Accepted & implemented (2026-06-14). Small, self-contained colour change.
**Author:** Ed Lake / Claude (design partner)
**Depends on:** GLASSHOUSE-AND-PALETTE-ADR §III.4 (the scheme cycle control), UNIVERSAL-FEED-ADR, UI-DESIGN-SPEC
**Affects:** `web/src/components/workspace/tokens.ts`, `web/src/lib/palette/registry.ts`, `web/src/app/globals.css`, `gateway/src/routes/feeds.ts`

> **Note to Claude Code.** Colour-content change only. It swaps the curated
> scheme surfaces and their slugs; it does **not** touch the cycle control, the
> text-derivation logic, or the monochrome Paper/Dark schemes. Where it names a
> slug, token, or hex, treat that as the intended value. The migration map in
> §III.3 is load-bearing — without it, every existing feed snaps to Paper.

---

## I. Problem statement

The four colourful per-feed schemes (`blush`, `sage`, `sand`, `slate`) are being
retired in favour of four new ones drawn from a Brazilian-modernist colour idiom,
contrasting in mood and tuned to sit together as a family. Paper (`primary`) and
Dark (`dark`) are unchanged. The scheme structure is unchanged — each scheme is
still three surfaces (walls double as the bar, interior, card), with card text
derived by luminance in `tokens.ts`, so only the surface values and slug names
move.

---

## II. Principle

Each card stays **clearly light or clearly dark** so both derived text ramps
resolve (per `tokens.ts`). Three of the four are light; Cobalto is the one dark
scheme.

---

## III. Decision

### 1 — The four new schemes

Replace `blush` / `sage` / `sand` / `slate` with `mata` / `cobalto` / `vela` /
`caju`. Surfaces:

| Scheme  | Mood                     | walls     | interior  | card      | isDark |
|---------|--------------------------|-----------|-----------|-----------|--------|
| Mata    | bold green, hot, graphic | `#4A6E12` | `#EFE9DA` | `#F7F2E6` | false  |
| Cobalto | cool, electric, dark     | `#1B2BC2` | `#16228C` | `#141C52` | true   |
| Vela    | coastal, bright, warm    | `#156057` | `#EDE1C2` | `#FAF3E2` | false  |
| Caju    | hot — ember to coral     | `#C2461C` | `#F4C9BE` | `#FCEAE1` | false  |

`:root` triples for `globals.css` (slug pattern `--ah-<scheme>-<surface>-rgb`):

```
mata-walls    74 110 18     mata-interior    239 233 218   mata-card    247 242 230
cobalto-walls 27 43 194     cobalto-interior 22 34 140      cobalto-card 20 28 82
vela-walls    21 96 87      vela-interior    237 225 194    vela-card    250 243 226
caju-walls    194 70 28     caju-interior    244 201 190    caju-card    252 234 225
```

### 2 — Wiring

Five edits, all mechanical:

1. `registry.ts` — replace the twelve `blush-*`/`sage-*`/`sand-*`/`slate-*`
   entries with the twelve above (same `-walls`/`-interior`/`-card` shape, same
   canonical-order block). Keep labels descriptive.
2. `globals.css` — replace the corresponding `:root` `-rgb` vars with the triples
   above.
3. `tokens.ts` `FeedScheme` union — `…'mata' | 'cobalto' | 'vela' | 'caju'` in
   place of the four old ids.
4. `tokens.ts` `SCHEME_OPTIONS` — `{ id: 'mata', label: 'Mata' }`,
   `{ id: 'cobalto', label: 'Cobalto' }`, `{ id: 'vela', label: 'Vela' }`,
   `{ id: 'caju', label: 'Caju' }` after Paper/Dark. (`SCHEME_IDS` and the cycle
   button follow automatically.)
5. `tokens.ts` `PALETTES` and the curated scheme→surfaces map
   (`Exclude<FeedScheme,'primary'|'dark'>`) — point each new id at its three new
   slugs; set `isDark` per the table.

### 3 — Migration (required)

Existing feeds persist a scheme id (`blush`, etc.) that no longer exists; left
alone, `normalizeBrightness` coerces all of them to `primary`, silently flattening
every customised feed to Paper. Add an alias map consulted **before** the
`SCHEME_IDS` test, mapping each retired id to its nearest new mood:

```ts
const SCHEME_ALIASES: Record<string, FeedScheme> = {
  blush: 'caju',   // pink/maroon → hot coral
  sage:  'mata',   // green → green
  sand:  'vela',   // warm tan → warm sand
  slate: 'cobalto' // dark blue → dark blue
}
```

`normalizeBrightness` resolves an alias if present, then falls through to the
existing coercion (unknown / `medium` / `dim` / junk → `primary`).

---

## IV. Consequences

- **Cycle length is now six** (Paper → Dark → Mata → Cobalto → Vela → Caju). That
  is about the ceiling for a click-through; adding a seventh scheme should prompt
  a move to a picker rather than a longer cycle.
- **Caju + crimson sit close.** The system crimson accent (votes, paid bar,
  selection) lands near Caju's orange-red walls — low-contrast red-on-red.
  Acceptable as a tonal effect for now.
- Two cool schemes (Cobalto, Vela), two warm (Mata, Caju); one dark, three light.

## V. Out of scope (noted, not built)

A **per-scheme accent token** — a fourth slot per scheme, distinct from system
crimson — would let each scheme carry its own accent (relieving crimson of
double-duty and fixing the Caju adjacency above), and would let a controllable hot
splash drop into any scheme, Vela included. Deferred to its own ADR.

## VI. Done when

A feed previously on `blush`/`sage`/`sand`/`slate` reloads onto its mapped new
scheme (not Paper); the cycle button steps through all six; and each new card
renders legible body and meta text in both light and dark, checked in a full
vessel with the 8px walls and elevation shadow (flat swatches understate how the
interior shifts).

---

## VII. Implementation notes (2026-06-14)

- **Sixth edit, beyond the ADR's five:** `gateway/src/routes/feeds.ts`
  `FEED_SCHEME_IDS` was mirrored to the new ids. CLAUDE.md requires the gateway
  enum to mirror the client scheme list, and the `z.enum` PATCH validator would
  otherwise reject every new scheme — so the cycle couldn't persist server-side
  (§VI). **No DB backfill:** rows still holding a retired id are aliased on read by
  the client's `SCHEME_ALIASES`; only new ids are ever written back.
- The unrelated `blush`/`blush-deep` registry slugs (profile-avatar gradient) are
  **not** scheme surfaces and were left untouched.
- Verified: web + gateway `tsc --noEmit` clean; hairline tripwire clean for touched
  files. Live legibility in a full vessel (8px walls + elevation shadow) needs the
  prod web rebuild — flat swatches understate the interior shift.

---

# Addendum A — drop Mata, replace Cobalto with Anil (2026-06-14)

**Status:** Post-implementation revision. The base ADR shipped; `mata` / `cobalto`
/ `vela` / `caju` went live, then two faults showed up in use.

## A.1 Why

- **Mata and Vela read as the same scheme twice** — both a green-family frame over
  warm light surfaces, side by side in the cycle. Mata is dropped; the set loses
  its bold green (§A.4).
- **Cobalto doesn't hold up** — a pure-ultramarine bar at vessel-frame scale is
  fatiguing and garish over its own card. Replaced by **Anil**, a deep indigo that
  splits Cobalto and the retired Slate: bluer and more alive than Slate, calm
  rather than electric, following Slate's value logic (walls darkest, card the
  lifted reading well) so it sits as a comfortable dark reading surface.

The colourful set is now three: **Anil** (indigo, cool, dark), **Vela** (coastal,
light), **Caju** (hot, light).

## A.2 Surface changes

| Scheme | walls     | interior  | card      | isDark |
|--------|-----------|-----------|-----------|--------|
| Anil   | `#0E1C44` | `#16285E` | `#20305C` | true   |

`:root` triples: `anil-walls 14 28 68 · anil-interior 22 40 94 · anil-card 32 48 92`.

Edits: `registry.ts` (delete the three `mata-*`, rename `cobalto-*` → `anil-*` in
place); `globals.css` (drop `mata-*` vars, replace `cobalto-*` with the `anil-*`
triples); `tokens.ts` `FeedScheme` union / `SCHEME_OPTIONS` / `PALETTES` /
`SCHEME_SURFACES` (drop `mata`, `cobalto` → `anil`, `isDark: true`);
`gateway/src/routes/feeds.ts` `FEED_SCHEME_IDS` mirrored. Order: Paper → Dark →
Anil → Vela → Caju (five-stop cycle). `vela` / `caju` untouched.

## A.3 Migration (updated)

`mata` and `cobalto` are now also retired-but-persisted ids (both already live on
feeds), on top of the original four. The alias map, consulted before the
`SCHEME_IDS` test:

```ts
const SCHEME_ALIASES: Record<string, FeedScheme> = {
  blush:   'caju',  // hot pink → hot coral
  sage:    'vela',  // green → teal-green light  (was 'mata')
  sand:    'vela',  // warm tan → warm sand
  slate:   'anil',  // dark blue → indigo        (was 'cobalto')
  mata:    'vela',  // dropped green → nearest light scheme
  cobalto: 'anil',  // electric blue → indigo
}
```

Everything else (`medium` / `dim` / unknown / junk) still falls through to
`primary`. A feed on `mata` or `cobalto` reloads onto its mapped live scheme, not
Paper.

## A.4 Consequences

- **Cycle is five stops** (down from six).
- **No bold green remains** — Vela's teal is the only green, light and blue-leaning.
  A future bold green needs its own slot in a cooler/darker register than Vela to
  avoid repeating the Mata/Vela collision (its own addendum if so).
- The §V per-scheme-accent follow-on is unaffected and still deferred.

---

# Addendum B — quoted-post embeds ride the walls surface (2026-06-14)

**Status:** Implemented. Affects `tokens.ts` and the two quote renderers
(`web/src/components/post/QuotedEmbed.tsx`,
`web/src/components/workspace/QuotedPostTile.tsx`).

## B.1 Why

A quoted-post embed previously sat on `palette.interior` (the vessel *ground*),
the same surface as the card's own content well — so the quote didn't separate
from the host body. It now rides `palette.walls` (the vessel *frame* colour, the
same surface as the bar), giving the embed a distinct, recessed-frame reading.

## B.2 Mechanism

Three derived fields join `VesselPalette`, so the treatment is one rule across all
five schemes rather than per-component contrast math:

- `quoteBg` = the `walls` colour.
- `quoteText` = strong-contrast primary, derived against **walls** luminance
  (`bone-bright` on dark walls, `ink` on light) — not the card ramp.
- `quoteMeta` = legible muted secondary (`stone-350` dark / `stone-600` light).

Derived in `deriveVesselPalette` from the existing `darkBar` (walls-luminance)
switch for curated schemes; set literally for `primary` / `dark`. Because it keys
off walls luminance it stays correct if a light-walls scheme is ever added; today
all five schemes have dark walls, so quote text resolves light-on-dark throughout.
Both renderers point their tile background + text at these fields; the nested
link-preview chip inside `QuotedPostTile` keeps its own `cardBg` surface (an
intentional light chip-within-the-quote). Verified: web `tsc --noEmit` clean.

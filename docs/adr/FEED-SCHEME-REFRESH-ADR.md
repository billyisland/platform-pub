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

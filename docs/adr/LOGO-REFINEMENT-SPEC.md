# ∀ Mark Refinement — Implementation Spec

Execution doc for Claude Code. Repo: `billyisland/platform-pub`. All paths relative to repo root.

> **Status: SHIPPED 2026-07-06.** Implemented as specified, on the wider-splay canonical decided below. Rasters regenerated from `favicon.svg` via the repo-root `sharp`; the 32px crossbar check passed numerically (two full-intensity rows — the 4.6 fallback was not needed). Retained as the canonical reference for the ∀ geometry.
>
> **Geometry note — REWRITTEN 2026-07-22, and it now cuts deeper than a rim treatment. Read this before using any disc value below.**
>
> This spec's stance (~20.5° splay, apex clear of the rim, feet bleeding through the top) is **the BARE GLYPH's only**: `ForAllMark` — the crimson ∀ in Nav/Footer/About, which has no disc and so no rim to meet. It still defines the canonical construction, and File 1 below is still live.
>
> **Every DISC instance now carries `FORALL-CUT-AND-LOCKUP-ADR` §III.1's rim-kiss geometry instead** — the `ForallMenu` trigger, `favicon.svg` (+ its rasters), and the brand exports in `web/public/brand/`. Apex mitred to a point kissing the bottom rim, feet overshooting so the disc circle trims them flush through the top; pinning both ends to the rim forces a ≈16.7° splay, narrower and taller than the ~20.5° above. That is a **consequence of the construction, not a second design** — which is why it belongs to every disc instance and to no bare one. 200-frame values in the ADR; the 56-frame port is legs `M14.36 1.61 L28 47.15 L41.64 1.61` w5.06, crossbar (19.96,20.26)→(36.04,20.26) w4.17, clip at the literal rim **r=28** (an inset clip leaves the ink slice the overshoot exists to remove).
>
> So **the disc values in Files 2 and 3 below are superseded** — they are the record of the 2026-07-06 pass, not current geometry. The earlier caveat here (exports drifted from the in-app discs; ADR §IV.4 kept the live button clear of the rim; reconciliation open at CONSOLIDATED-TODO §10) is **closed**: the trigger and favicon were ported onto the export geometry 2026-07-22, so all three disc instances agree again. ADR §IV.4 is superseded with it, its pinched-crescent warning retained as the standing visual check at 36–40 px.

## Why

Four refinements to the ∀ mark, applied consistently across every instance:

1. **Straight crossbar in the canonical position** — upper third of the glyph (~32–34% from the wide end). The workspace trigger currently runs it through the disc centre (`y=28`), which at small sizes reads as a V/chevron rather than ∀.
2. **Sharp interior apex** — legs meet in a mitred point *inside* the disc rather than terminating on the rim with round caps. Legs still bleed through the top rim (clipped), which is deliberate; the bottom apex becomes a sharp point with clearance from the rim.
3. **Lighter stroke** — legs at ~9.5% of disc diameter (was ~10.7%), crossbar slightly thinner than the legs (~84% of leg weight). Balances the mark against the Jost-medium wordmark.
4. **Unified geometry** — `ForAllMark.tsx`, the `ForallMenu` trigger, and `favicon.svg` currently use three unrelated constructions. All converge on one canonical construction: same splay, same stroke ratios, same crossbar position, same apex/cap treatment. (Pixel-exact identity between the disc-clipped marks and the frame-cropped standalone is not attainable — different crops — so those shared metrics *are* the unification.)

## Canonical geometry

Reference frame: 200×200, disc centre (100,100), disc r=94.

**Splay decision (2026-07-06): the canonical stance is the WIDER splay of the File-1 standalone mark** — tan = 50/134, ~20.5° from vertical — not the ~18.4° of the design-pass reference SVGs. File 1's numbers are unchanged and now *define* the stance; the disc marks below are re-derived from it.

| Element | Value |
|---|---|
| Legs | single path `M37.8 -6 L100 160.7 L162.2 -6`, stroke 18, `stroke-linejoin="miter"`, `stroke-miterlimit="6"`, clipped to disc |
| Crossbar | rect x=64 y=71.1 w=72 h=15 (centre y=78.6) |
| Leg splay | ~20.5° from vertical (tan = 50/134, the File-1 ratio) |
| Apex | vertex (100,160.7); miter tip lands ≈(100,186.4), ~7.6 clear of the rim |
| Legs exit rim | ≈(48.1,21.6) and (151.9,21.6) — two clean arc-following cuts |

**Placement follow-up (2026-07-06, post-ship):** as first shipped the glyph sat too high in the disc (apex vertex y=150, tip ~18 clear of the rim — a fat empty band at the bottom while the top bled). Fixed by translating the glyph down 10.7 units (3 in the 56-frame) — the values above and per-file below are the corrected placement; legs re-extended to the same top-endpoint y so the bleed is unchanged. Shape (splay, stroke weights, crossbar position on the legs) untouched; File 1 has no disc, unaffected.

The legs' vertex overshoot above the rim is arbitrary (it's clipped) — only splay, stroke weights and crossbar carry identity. Divide by 3.571 for the 56-frame used by the trigger and favicon (values given per-file below; everything lands on clean numbers). Reference SVGs from the design pass exist outside the repo (`allhaus-mark.svg`, bleed variant; a contained variant exists but is not being adopted) — **superseded on splay** by the decision above.

## File 1 — `web/src/components/icons/ForAllMark.tsx`

Replace the SVG contents. Current path (`M0 0L16.5 46H23.5L40 0...` + rect y=6) has the crossbar at 13% from the top and a different splay; both change.

New glyph, viewBox `0 0 112 160`:

```tsx
<path d="M6 0 L56 134 L106 0" fill="none" stroke="currentColor"
      strokeWidth={15} strokeLinejoin="miter" strokeMiterlimit={6} />
<rect x="20" y="44.75" width="72" height="12.5" fill="currentColor" />
```

Note the current component uses `fill="currentColor"` on the svg root with a filled path; the new legs are **stroked**, so stroke must be `currentColor` and fill `none` on the path (keep the rect filled).

These numbers are unchanged by the splay decision — this mark defines the canonical stance. One subtlety: the stroked legs' butt-cap corners extend a hair past the viewBox on three sides (top cap corners to y≈−2.6, side corners to x≈−1 and ≈113); the SVG's default overflow clipping crops them to a flat top edge, matching the old filled path's termination. Intended — don't "fix" it by shrinking the path or making overflow visible.

**Aspect change:** old viewBox is 40×46 (0.87 w:h); new is 112×160 (0.7 w:h). Keep `size` as the *rendered height* and derive width:

```tsx
const h = size
const w = Math.round(size * 0.7)
```

Then bump call sites to preserve current rendered heights (old code rendered h = size × 1.15):

| File | Old `size` | New `size` |
|---|---|---|
| `web/src/components/layout/Nav.tsx` (Wordmark) | 18 | 21 |
| `web/src/components/layout/Nav.tsx` (canvas-mode mark) | 18 | 21 |
| `web/src/components/layout/Footer.tsx` | 14 | 16 |
| `web/src/app/about/AboutContent.tsx` | 24 | 28 |
| `web/src/components/article/ArticleReader.tsx`, `PaywallGate.tsx`, `web/src/app/auth/page.tsx`, `web/src/app/tribute/claim/page.tsx` | check each | × 1.15, rounded |

Update the component's doc comment: crossbar is **upper third**, not "low crossbar" (the current comment is wrong even for the current shape).

## File 2 — `web/src/components/workspace/ForallMenu.tsx` (trigger)

> **SUPERSEDED on geometry (2026-07-22).** The "New" values below shipped 2026-07-06 and were replaced by the disc-form rim-kiss construction — see the geometry note at the top. The *structural* instructions in this section (what not to touch: the double clip, the spin machinery, the ∀↔X morph, the close-X, the badge, stroke-via-style) all still stand; only the numbers moved, plus the clip radius 27 → 28.

Geometry swap **only** inside the idle-∀ group (the first `clipPath="url(#forall-clip)"` group). Do not touch: the double-clip structure (SVG clip + `overflow:hidden` wrapper span), the hover-spin/`glyphRot` machinery, the ∀↔X morph groups, the close-X geometry, the unread badge, the `discBg`/`discGlyph` tokens, or the stroke-via-style pattern (the §III.3 comments explain why each exists — leave them, amend the geometry description).

Current (56 frame):

```tsx
<line x1="28" y1="56" x2="8.5" y2="5" />
<line x1="28" y1="56" x2="47.5" y2="5" />
<line x1="17.3" y1="28" x2="38.7" y2="28" />
```

New:

```tsx
{/* legs: one path so the interior apex miter-joins — two separate
    lines with butt caps would notch at the apex */}
<path d="M10.6 -1.7 L28 45 L45.4 -1.7"
      strokeLinejoin="miter" strokeMiterlimit={6} />
{/* crossbar: upper third, slightly lighter than the legs */}
<line x1="18" y1="22" x2="38" y2="22" strokeWidth={4.2} />
```

Group attribute changes: `strokeWidth={6}` → `strokeWidth={5}`; `strokeLinecap="round"` → `strokeLinecap="butt"`. Stroke colour stays on the group `style` (var() references don't resolve in presentation attributes — existing comment covers this).

The apex miter tip lands ≈(28,52.2), ~2.9 clear of the r=27 clip; legs overshoot the top rim and are clipped as before, so the background-independence guarantee is unchanged. *(2026-07-22: the clearance is now zero by design — the tip lands ≈(28,56), a point on the rim, and the clip is r=28. Background-independence is unchanged, since it rests on the double clip, not on the inset.)*

Leave the close-X group exactly as-is (round caps on the X are fine and it never coexists with the ∀).

## File 3 — `web/public/favicon.svg`

> **SUPERSEDED on geometry (2026-07-22)** — same as File 2: the favicon is a disc instance and now carries the rim-kiss construction (clip already `r=28` here). The palette, the clip structure and the "painted, never punched — a tab ground is not ours to control" rule are unchanged.

Same swap, keeping the existing inverted palette (ink disc `#1A1A18`, bone glyph `#F0EFEB`) and the `#disc` clip:

```svg
<g clip-path="url(#disc)" fill="none" stroke="#F0EFEB">
  <path d="M10.6 -1.7 L28 45 L45.4 -1.7" stroke-width="5"
        stroke-linejoin="miter" stroke-miterlimit="6"/>
  <line x1="18" y1="22" x2="38" y2="22" stroke-width="4.2"/>
</g>
```

Update the file's comment block to describe the new construction.

## File 4 — regenerate rasters

`web/public/icon-32.png` (32×32) and `web/public/apple-touch-icon.png` (usually 180×180 — verify current dimensions before regenerating) from the new `favicon.svg`. Use whatever renderer is available (`sharp` via a one-off node script, or `rsvg-convert`). Apple touch icons don't support transparency well — flatten onto `#1A1A18`.

At 32px the 4.2-unit crossbar renders ≈2.4px; check it doesn't alias away. If it does, bump the favicon crossbar (only) to 4.6.

## Verification

- Trigger: hover spin, open/close morph to X, unread badge, both `inBar` (36px) and floating (56px) sizes, light and dark (`discBg`/`discGlyph` inversion).
- Nav/Footer/About: lockup baseline alignment unchanged, mark visually same height as before the aspect change. The mark narrows ~18% at preserved height (aspect 0.87→0.7) — eyeball the wordmark lockup gap. Nav/Footer are logged-out chrome; verify them logged out.
- Favicon in an actual browser tab at 16px effective size.
- `npm run lint` / typecheck pass, **plus `next build`** (SWC catches errors tsc+eslint miss).
- Seeing it locally needs a web image rebuild (`docker compose build web && docker compose up -d web`) — web runs a prod build, no hot-reload.

## Non-goals

- No wordmark/typography changes (Jost stays).
- No colour token changes.
- No animation timing changes.
- The contained (no-bleed) mark variant is not being adopted.

# FORALL-CUT-AND-LOCKUP-ADR: The Negative-Space ∀ Disc, the Workspace Window & the Floating-Lockup Rebalance

**all.haus Architectural Decision Record**
**Status:** Accepted; implemented 2026-07-21. Three related changes, all shipped: §III canonical cut mark (assets in `web/public/brand/`); §IV the idle trigger as a window onto the workspace (incl. the negative-lens iridescence, §IV.5 — `lensMode` in `ForallMenu.tsx`, blend scoped by `body { isolation }` in `globals.css` + canvas `isolation` in `WorkspaceView.tsx`); §V lockup rebalance (disc 46 / wordmark 28, dropdown gap tracking `discSize`). The §IV.3 composite/stacking questions were settled by the pre-implementation prototype (§IV.5 records its findings); the §VII in-browser eyeball pass over live feed schemes remains the standing verification.
**Author:** Ed Lake / Claude (design partner)
**Depends on:** GLASSHOUSE-AND-PALETTE-ADR (disc integrity, scrim separation), LOGO-REFINEMENT-SPEC (canonical ∀ stance), WORKSPACE-FULL-VIEW-SPEC / MOBILE-LAYOUT-ADR (the canvas the disc floats over), UI-DESIGN-SPEC
**Assumes:** the desktop workspace pans **horizontally** — feeds occupy grid slots, new feeds extend to the right, the canvas scrolls sideways, and the ∀ disc stays pinned to the lower-right of the viewport. That workspace behaviour is its own work; this ADR specifies only the **mark's** behaviour within it.
**Affects:** `web/public/brand/*` (new), `web/public/favicon.svg`, `web/src/components/workspace/ForallMenu.tsx`, `web/src/components/workspace/WorkspaceView.tsx` (layer check only), `web/src/components/icons/ForAllMark.tsx` (doc only), `docs/adr/LOGO-REFINEMENT-SPEC.md` (geometry note)

> **Note to Claude Code.** Design-decisions document, not a line-level spec. It fixes
> the _what_ and the _why_; you own the _how_. Where it names a file, token, or
> constant, treat that as the intended shape unless you find a concrete reason it
> cannot work — in which case **stop and flag**, do not improvise a divergent design.
> §IV changes the idle disc from a painted glyph to a real hole and carries a
> **prototype-first gate** and a hard invariant (the open menu still paints); read it
> in full before touching `ForallMenu.tsx`, and preserve the hover-spin and ∀↔X morph.

---

## I. Problem statement

Three related wants.

1. **The mark has a stronger idea in it than the current disc expresses** — a
   **negative-space cut**, where the ∀ is the surface the disc rests on, showing
   through. Its tip just kisses the bottom rim; its feet run out through the top rim
   flush, no ink between letter and edge — a solid disc with the ∀ cut clean through
   it, lying on the page.

2. **On the workspace, that surface can be the content itself.** With the canvas
   panning sideways and the disc pinned lower-right, feeds — often ones dragged to the
   bottom of the screen — pass beneath the disc as you scroll back over them. If the ∀
   is a real hole there, you glimpse the feed through the letter: the mark becomes a
   literal window onto the workspace, not a logo sitting on top of it. This is the one
   dynamic surface where a true hole is not a compromise but the whole point.

3. **The floating lockup doesn't sit as one row.** "all.haus" is set left of the disc
   (`ForallMenu.tsx`, floating anchor); the disc is 56 px, the wordmark 24 px, so the
   disc out-masses the type and the two read as _disc, with a label_.

## II. The constraint that governs everything here

The negative-space cut is only free when what sits **behind the ∀ is something we're
content to show.** Where the ground is unknown, or changes state, or must never be
seen, the mark cannot punch — it must **paint** the ∀ in a chosen colour instead. On a
solid known ground, paint and hole are pixel-identical; the choice only matters when
the ground is out of our control. The cases divide cleanly:

- **Show it → punch.** The idle workspace disc. Behind it is our own feed content (or
  the bone floor between cards). A hole reveals it; that is the intended effect (§IV).
- **Can't predict it → paint or bake.** The browser tab (favicon: tab-strip colour
  varies with theme; a hole makes the ∀ tab-coloured, invisible on a dark tab).
  External composites (Stripe, OG on foreign pages, press). These paint a fixed glyph,
  or bake a chosen ground in — never punch.
- **Wrong thing is behind → paint.** The workspace disc **when the menu is open.** It
  lifts onto the light island above the Glasshouse scrim; a hole there would show the
  scrim, and in one mode the island matches the disc and the ∀ vanishes. So the open
  state keeps the GLASSHOUSE-hardened painted glyph. The disc punches when idle and
  **paints when open** — a state swap, detailed in §IV.

## III. Decision — the canonical cut mark

### III.1 Geometry (source of truth, 200-unit frame)

Disc centre (100,100), radius 94. All disc marks derive from this; scale to target.

- **Feet** on the rim at ±28° from top — centrelines to (55.9, 17.1) and (144.1, 17.1)
  — then overshoot ~6 units outward along the leg axis, to (54.2, 11.4) and
  (145.8, 11.4), so the disc circle trims them: the cut meets the rim flush, no ink
  slice between foot and edge.
- **Legs** a single mitred path `M54.2 11.4 L100 164.3 L145.8 11.4`, weight 17 (~9% of
  diameter), `miterlimit` ≥ 12. The apex vertex (y≈164.3) is set so the mitred outer
  tip resolves to a **point on the bottom rim** (100,194) — the ink crescents close
  behind it and the letter kisses the edge. This is the one value to tune by eye.
- **Crossbar** straight, upper third at y≈74, spanning the leg centrelines (x≈73→127),
  weight 14 (~0.82 of the legs).

This supersedes the "apex clear of rim / feet bleed and stop" description in
LOGO-REFINEMENT-SPEC **for the cut (disc) form only**. The bare-glyph `ForAllMark`
(crimson ∀, no disc, Nav/Footer/About) is unchanged — no rim to kiss. Cross-reference
both docs so the forms don't drift.

### III.2 Two realisations of one mark

- **Punch (real hole).** A `<mask>`: white disc, black ∀ (legs path + crossbar); the
  ink circle carries the mask, so only the ∀ strokes go transparent — **the disc body
  and rim stay fully opaque.** For the idle workspace disc (§IV) and for exported
  assets on brand-controlled ground.
- **Paint (simulated).** The ∀ drawn in a chosen colour over the opaque disc — today's
  technique. For the open workspace disc, the favicon, and all external composites.

Reference SVG for the punch form (ship in `web/public/brand/`):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="all.haus">
  <mask id="ah-forall">
    <circle cx="100" cy="100" r="94" fill="#fff"/>
    <path d="M54.2 11.4 L100 164.3 L145.8 11.4" fill="none" stroke="#000"
          stroke-width="17" stroke-linejoin="miter" stroke-miterlimit="12" stroke-linecap="butt"/>
    <line x1="73" y1="74" x2="127" y2="74" stroke="#000" stroke-width="14" stroke-linecap="butt"/>
  </mask>
  <circle cx="100" cy="100" r="94" fill="#1A1A18" mask="url(#ah-forall)"/>
</svg>
```

Note: some renderers (incl. our build-time rasteriser) don't apply SVG `mask` — verify
in a browser and ship a PNG beside the SVG for static exports.

### III.3 Exported assets

`web/public/brand/allhaus-cut.svg` + a transparent PNG at 1024, for press/partner use
and any first-party placement on a **single flat brand section** whose colour we set.
**Not** for the favicon, Stripe, or OG-on-foreign-pages (§II). If a section colour is
fixed, a flattened PNG is equivalent and cheaper than runtime masking.

## IV. Decision — the idle trigger as a window onto the workspace

Supersedes the earlier "keep painting, hard no" stance: the disc **punches when idle,
paints when open.** This is the mark's home on the live site.

### IV.1 Behaviour by state

- **Resting (closed), including while the canvas scrolls beneath it:** ∀ is a real
  hole. Whatever sits at lower-right — a feed card, the gap between cards, or the bone
  floor — shows through the letterform. When floor shows (the common case), the ∀ reads
  as the disc's photo-negative exactly as today; when a card passes under, you glimpse
  it. The glimpse is **serendipitous, not composed** — uncontrolled by design. The
  disc body is not a fixed colour but a live negative of the feed behind it, so a
  light/dark feed edge passes straight through the mark as a seam — see §IV.5.
- **Hover (closed):** the disc spins 180°; the hole spins with it, content showing
  through the turn. Desired, but see the prototype gate (§IV.3) — if a mask animating
  over live content isn't smooth, fall back to snapping to paint for the spin only.
- **Open (menu):** the disc lifts to the island, scales 1.04, and the glyph morphs
  ∀→X. From the swap onward the glyph is **painted**, on the island, exactly as today.
  The morph animates paint over the island, never a hole over content.

### IV.2 Invariants

1. **The disc body and rim are always opaque.** Only the ∀ strokes are the window.
   The difference-blend (§IV.5) preserves this — a white source over an opaque feed
   yields an opaque result — so the silhouette stays a solid, findable, tappable disc
   even when a passing feed momentarily matches it and washes the letter out. A
   washed-out _letter_ is fine; a washed-out _button_ is not.
2. **The idle→open swap (hole→paint) must be imperceptible.** It happens as the disc
   leaves the floor for the island, where hole and paint coincide, so a snap reads as
   no change. Do not cross-fade a hole into paint over moving content.
3. **Nothing opaque may sit between the punched disc and the workspace content in the
   idle state.** The island backing belongs to the open dropdown, not the resting
   button — confirm in `WorkspaceView`/`ForallMenu` layering that the idle disc punches
   straight through to the canvas (z-60 over content; scrim is z-[55], below).
4. Keep the GLASSHOUSE double-clip / rim-containment for the **painted** (open) state;
   the punch form gets exact containment free from the mask's own circle.
5. **The blend group is load-bearing.** The idle disc and the feed must share one
   isolated blend group, and nothing may form a stacking context between them — see
   §IV.5, which is where this went wrong in prototype and will again if ignored.

### IV.3 Prototype-first gate

Before committing: prototype the idle hole over the scrolling canvas and confirm (a)
the spin **and** scroll composite is smooth (mask over a live layer, at DPR 1 and 2),
(b) the hole→paint open-swap is invisible on the floor in **both** light and dark, and
(c) the glimpse reads as elegant rather than busy against real feed cards. The
hole-through-spin (§IV.1) is a committed decision — if the composite stutters, the
answer is to make it smooth (avoid re-rasterising the mask per frame; promote the
**disc** if needed — but never the feed canvas the blend reads, and mind that adding
`will-change`/`transform` must not create a stacking context that breaks the blend,
§IV.5), **not** to quietly drop back to paint. If it cannot be made smooth, or if (b) cannot be made seamless,
**stop and flag** rather than shipping jank or a visible open-flicker.

### IV.4 Trigger geometry

The trigger _may_ adopt the §III.1 kiss/flush geometry, but at 36–56 px a rim-kiss
pinches the ink crescents to nothing, which can alias or read as a nick, and a
spinning button wants a whole outline. **Recommendation: the exported logo kisses; the
live button keeps the ∀ clear of the rim** (as now) even once it punches — a hole clear
of the rim still shows content through the letter without breaking the disc silhouette.
Treat any move to a kissing trigger as its own visual-QA pass, not a side-effect here.

### IV.5 Iridescence — the idle disc as a live negative lens

Refines IV.1's resting state, and is confirmed by prototype. The idle disc is a
**white disc with the ∀ punched, set to `mix-blend-mode: difference`** against the
workspace. Every pixel of the body renders as the photographic negative of whatever
sits directly behind it, so a light/dark feed edge passes **straight through** the mark
as a seam — ink on the light side, bone on the dark — instead of the whole disc
flipping as a unit. Over the bone floor the negative resolves to ~ink, so the resting
brand look is preserved for free. The ∀ stays a genuine hole showing the true feed; the
wordmark takes the same difference blend so the seam runs through the type. It
iridesces because difference inverts hue as well as value: each feed's own colours come
through negated as the canvas scrolls.

**Colour negative, by necessity.** A tonal (value-only) negative needs
`backdrop-filter: grayscale + invert`, which was prototyped and **rejected** — at least
one target browser will not composite `backdrop-filter` under a CSS mask even with the
mask moved to a parent wrapper. The difference blend needs no `backdrop-filter` and is
the shippable route. Per-pixel and the feed's *named accent* are mutually exclusive (an
accent is one token; a lens is spatial), and boundary-through requires the lens — do
not try to reconcile them.

**Stacking is where it breaks.** For the blend to invert the feed rather than render as
flat white, the disc and the feed must share one blend group:
- `isolation: isolate` on the workspace viewport/root that contains both the feed
  canvas and the idle disc, so the blend is scoped there and never inverts unrelated
  chrome.
- The idle disc must **not** sit inside any element forming its own stacking context
  between it and the feed — no `z-index`, no `opacity < 1`, no `filter`, no
  `transform`/`will-change` wrapper on the lockup. A `z-index` on the lockup was the
  exact bug that rendered the disc solid white in prototype. Position it with
  `z-index: auto` and rely on paint order.
- Do **not** detach the feed canvas into its own layer (`will-change: transform`) in a
  way that excludes it from the blend backdrop.

**Open state and morph still paint.** The lens is idle-only. On open the disc lifts to
the light island and reverts to the painted glyph and the ∀→X morph (§IV.1); there is
no feed behind it there to invert, and the GLASSHOUSE painted path is what reads on the
island. The handoff must be seamless (IV.2.2): on the floor, difference-of-white ≈ ink
= the painted colour, so the swap should be invisible — verify it.

**Mid-grey is the weak spot.** A feed near 50% luminance inverts to a near-equal grey,
dropping contrast for both the body (vs its ground) and the ∀-hole (true feed vs the
body's negative). No current scheme lands there; a future mid-tone one would. Mitigate
only if it bites: a hairline rim (itself difference-blended stays legible) or a slight
`contrast()` boost — don't pre-build it.

## V. Decision — floating-lockup rebalance

Floating ForallMenu lockup only. The mobile bar (`anchor="bar"`, disc 36, own
wordmark) and the Nav top-bar lockup (`Nav.tsx`, 21 px mark + 18 px text) are out of
scope.

- **Disc:** floating `discSize` 56 → **46**.
- **Wordmark:** floating `fontSize` 24 → **28**; weight/tracking unchanged
  (`font-medium`, −0.01em).

Rationale: at 28 px Jost, cap-height ≈ 20 px; disc/cap ≈ 2.3, down from 3.2 — kin on one
row, not a disc looming over a label. Both are single literals; tune ±2 by eye.

Follow-through (parametric on `discSize`, so they track — just confirm): the wordmark
button's `right: 24 + discSize + 14` and `height`, the Explain-leader anchor, the
badge. **Flag:** the open dropdown uses a fixed `bottom: 64` in the floating branch
(inBar uses `top: discSize + 8`); with a 46 px disc that fixed value widens the gap —
consider tracking `discSize` (e.g. `discSize + 18`). The 14 px wordmark↔disc gap can
stay; drop to 12 if the larger type feels loose.

## VI. Non-goals

- No change to the bare-glyph `ForAllMark` stance or the crimson-wordmark colour logic.
- No change to the ∀↔X morph, hover-spin, unread badge, or the Glasshouse scrim.
- No punching of any disc whose ground is unpredictable or state-changing except the
  idle workspace disc (§II, §IV).
- No mobile-bar or Nav-topbar resizing.
- No `backdrop-filter` tonal (value-only) negative — prototyped and rejected on browser
  support (§IV.5); the difference-blend colour negative is the chosen route.
- No attempt to tint the lens from a feed's named accent token — incompatible with
  per-pixel boundary-through (§IV.5).
- The horizontal-scroll workspace itself is assumed, not specified here.

## VII. Verification

- **Cut asset:** open `allhaus-cut.svg` in a browser over ink, bone, and a mid-tone;
  apex kisses, feet run out clean, no ink slice; shipped PNG matches (mask caveat).
- **Idle window:** scroll feed cards of several schemes under the resting disc in light
  and dark; the ∀ glimpses content, the ring stays solid and tappable throughout; over
  floor the mark looks exactly as before.
- **Negative lens:** park a feed edge under the resting disc — the seam runs through
  the disc and the wordmark, ink on the light side, bone on the dark; the ∀ shows the
  true feed. Over the bone floor the disc reads as brand ink. Confirm the blend is
  scoped by `isolation` and no stacking context sits between disc and feed (else the
  disc renders solid white).
- **Open swap:** open/close repeatedly on the floor — no flicker at the lens→paint
  boundary in either mode; morph, spin, badge unaffected.
- **Lockup:** wordmark and disc read as one row; dropdown gap intact or intentionally
  re-tracked.
- `npm run lint` / typecheck clean.

# GLASSHOUSE-AND-PALETTE-ADR: Overlay Separation, Disc Integrity & Palette-Control Retirement

**all.haus Architectural Decision Record**
**Status:** Accepted & implemented (2026-06-14). Four independent changes; shipped §V.1–4.
**Author:** Ed Lake / Claude (design partner)
**Depends on:** UI-DESIGN-SPEC, UNIVERSAL-FEED-ADR (per-feed schemes), CARD-BEHAVIOUR-ADR
**Affects:** `web/src/app/globals.css`, `web/src/lib/palette/registry.ts`, `web/src/components/workspace/Glasshouse.tsx`, `web/src/components/workspace/ForallMenu.tsx`, `web/src/components/workspace/FeedComposer.tsx`, `web/src/components/workspace/tokens.ts`, `web/src/components/account/SettingsPanel.tsx`, `web/src/components/account/ThemeSection.tsx`, `web/src/components/devtools/PalettePanel.tsx`, `web/src/components/devtools/PaletteHydrator.tsx`, `web/src/stores/paletteDevtool.ts`

> **Note to Claude Code.** Design-decisions document, not a line-level spec. It
> fixes the _what_ and the _why_; you own the _how_. Where it names a file,
> token, constant, or selector, treat that as the intended shape unless you find
> a concrete reason it cannot work — in which case **stop and flag**, do not
> improvise a divergent design. §V.3 carries a CLAUDE.md invariant; read it before
> touching the palette devtool.

---

## I. Problem statement

The glasshouse overlay was tuned against a single neutral ground (bone in light,
ink in dark). It now opens over **per-feed colour schemes** (Paper / Dark / Blush
/ Sage / Sand / Slate), and the chrome has not kept up:

1. **The pane cannot find a stable footing.** `bg-glasshouse` is a fixed mid-grey
   (`#DCDAD3`), and the scrim is blur-only with no fill — by design, "so the
   ground colour is preserved." That preservation is precisely the fault: a fixed
   pane colour is asked to separate against a variable, sometimes-saturated
   backdrop, which it cannot do reliably. Separation is the scrim's job, and the
   scrim has been doing none of it.

2. **The pane is the wrong polarity.** `#DCDAD3` is _darker_ than the light ground,
   so the overlay reads as a recessed grey slab rather than lifted paper — at odds
   with every other surface in the system.

3. **The ∀ disc leaks in glasshouse mode.** The constructed ∀ paints its legs in
   the floor colour, overshooting the rim and relying on _two_ coincident circles
   to contain them (the SVG `#forall-clip` r=28 and the CSS `border-radius:50%`
   disc). The two diverge by a sub-pixel under the open-menu `scale(1.04)` and on
   fractional DPRs, so floor-coloured leg-tips paint a hair past the rim. On the
   workspace floor those tips are camouflaged floor-on-floor; the instant the disc
   sits over the frosted scrim the camouflage is gone and they read as pale nicks
   at the edge. Separately, the disc sets `border:none` but not `outline:none`, so
   modal focus-return while an overlay is open draws a UA focus rectangle around
   the coin — the "illegal outline."

4. **Two palette-editing surfaces ship to users who should not have them.** The
   ForallMenu "Palette" row opens the operator devtool; Settings carries a
   preset-theme picker (`ThemeSection`). Both let a user repaint arbitrary registry
   slugs and persist the result, which can drift the identity and (preset side)
   defeat the point of having one. They should not be user-facing.

5. **The per-feed scheme picker is a swatch row, not a control.** Every other
   per-feed appearance axis — density, orientation, text size — is a single
   click-through `AppearanceControl`. The colour scheme is the odd one out, a row
   of `SCHEME_OPTIONS` swatches. It should match its siblings.

---

## II. Design principles

1. **Separation belongs to the scrim, identity to the pane.** The scrim presents a
   consistent ground; the pane is then a fixed parchment that always meets the same
   field, with no scheme-aware code anywhere in the pane.
2. **The disc is self-contained.** It must render identically over the floor or
   over the frost. No part of its correctness may depend on what is behind it.
3. **One control language for per-feed appearance.** Anything a reader tunes
   per-feed is a click-through `AppearanceControl`.
4. **Retire the controls, keep the mechanism.** Removing user-facing palette
   editing must not remove boot-time hydration of persisted overrides (CLAUDE.md).

---

## III. Decisions

### 1 — Scrim does the separating (req 1)

`Glasshouse.tsx`, the `z-[55]` scrim div. Keep the blur; add a mode-aware
translucent wash **and** a desaturation pass, so any feed scheme behind it
converges toward the mode's neutral ground:

Add a `.gh-scrim` rule to `globals.css` rather than a long arbitrary className:

```css
.gh-scrim {
  backdrop-filter: blur(3px) saturate(0.7);
  background: rgb(var(--ah-bone-bright-rgb) / 0.72);
}
:root.dark .gh-scrim { background: rgb(var(--ah-ink-925-rgb) / 0.74); }
```

Scrim div becomes `className="fixed inset-0 z-[55] gh-scrim"`. `saturate(0.7)`
removes most of the _colour_ variance (the part that actually breaks the pane);
the wash removes the tonal variance and fixes the ground. These are **tuned
values** (started at bone / 0.66 / 0.66) — the light wash converges to
bone-bright rather than bone so the ground sits a touch *below* the lighter
parchment pane, and both alphas were nudged up (0.72 / 0.74) so the modal lifts
clearly off the scrim. Re-tune against the loudest feed (Slate behind a light
pane, a saturated Blush behind dark). The blur-only justification ("the disc
keeps its contrast") is retired: §III.3 makes the disc background-independent,
so the wash is safe.

### 2 — Glasshouse pane becomes pale parchment (req 2)

Repoint the existing `glasshouse` slug to parchment rather than minting a new
colour or moving the pane to a different token (the registry position is canonical;
every `bg-glasshouse` consumer keeps working untouched).

`globals.css`: `--ah-glasshouse-rgb: 220 218 211;` → `245 244 240`
(the parchment value already carried by `cream`).
`registry.ts`: update the `glasshouse` entry `hex` to `#F5F4F0` and the label to
`Frosted overlay pane (pale parchment, lifted)`.

Consequence: the pane is now _lighter_ than both the bone floor and the washed
scrim ground, so it reads as lifted paper (correct polarity, §I.2). `grey-600`
secondary text (`#666`) on `#F5F4F0` is high-contrast — no text-token change.

**Polarity flipped — lightest is outermost (2026-06-14).** The pane/field
relationship above was inverted: the pane was parchment `#F5F4F0` and text-input
fields were the bright white well (`bg-white`) inset into it. Flipped so the
**lightest colour is outermost** — the pane is now **white** (`glasshouse` slug
repointed `#F5F4F0` → `#FFFFFF`) and the inset fields/wells take a new
`glasshouse-well` slug (`#F5F4F0`, the old pane value), a touch darker than the
pane. `globals.css` adds `--ah-glasshouse-well-rgb: 245 244 240`; `registry.ts`
relabels `glasshouse` ("…interior — lightest, outermost") and adds
`glasshouse-well` right after; `tailwind.config.js` adds the `glasshouse-well`
colour token. Both slugs are in `THEME_LOCKED_SLUGS`. The migration swept every
nested field/well `bg-white` → `bg-glasshouse-well` (and `bg-white/40` washes →
`bg-glasshouse-well/40`) across the overlay surfaces (editor, composers,
messages, dashboard/account/network/library/social panels, …); floating material
that is itself the outermost layer (dropdowns, popovers, `AuthorModal`, the
reader canvas, the black topbar) stays white. The scrim (now bone-bright at 0.72,
§1) sits darker than the white pane, so separation actually improves. **Validated:**
web `tsc --noEmit` clean; hairline tripwire clean on touched files (no new
hairlines — the `divide-y` flags are pre-existing debt on lines that only had
their `bg-` token swapped). Needs a web rebuild to take effect.

### 3 — Harden the ∀ disc so it is background-independent (req 3)

`ForallMenu.tsx`, disc button and inner SVG. Make the disc its own single
authoritative mask and remove the UA outline:

1. **Single clip.** Clip the inner SVG to the _exact_ disc the user sees, in the
   same scaled coordinate space, with `overflow:hidden` + `borderRadius:50%`. Leg
   overshoot can then never escape under any transform or DPR, because the disc
   that draws the rim is the disc that clips.
2. **Belt-and-braces.** Inset `#forall-clip` r=28 → r=27 so the SVG clip never
   reaches the literal rim, killing the anti-aliased seam.
3. **No UA outline.** Suppress the UA default via the `.forall-trigger` CSS class
   (`:focus { outline:none }` + a real `:focus-visible` 2px crimson ring), so
   modal focus-return shows focus without a rectangle around the disc.
4. Optional: pin the disc to its own integer-pixel compositor layer
   (`transform: translateZ(0)`) so scale/spin introduce no fractional offset.

The ∀ legs stay floor-coloured (they sit on the dark disc, where that reads
correctly); the fix is purely about containment, not colour.

### 4 — Per-feed scheme as a click-through button (req 5)

`tokens.ts`: add `nextScheme`, mirroring `nextOrientation` / `nextTextSize`:

```ts
export function nextScheme(s: FeedScheme): FeedScheme {
  const order = SCHEME_OPTIONS.map((o) => o.id)
  const i = order.indexOf(normalizeBrightness(s))
  return order[(i + 1) % order.length]
}
```

`FeedComposer.tsx`: replace the `SCHEME_OPTIONS` swatch row with one
`AppearanceControl`, exactly as Orientation/Text size, glyph = a `SchemeSwatch`
(a small filled square in the scheme's `interior` surface, with a ≥2px walls bar
echoing the vessel grammar), indicator = the scheme name. Persistence and the
`onSchemeChange` wiring are unchanged — only the control shape changes.

### 5 — Retire palette-editing surfaces, keep hydration (req 4)

> **CLAUDE.md invariant.** `registry.ts` and CLAUDE.md mark the registry, the
> `var()` indirection, the `paletteDevtool` store, and the devtool's **mount-time
> `hydrate()`** as permanent: that effect is what applies persisted overrides on
> boot. If you delete the surface that owns it, saved themes silently stop
> applying on reload. Retire the **controls**; preserve the **mechanism**.

- **Extract hydration to a headless mount.** Lift the `hydrate()` `useEffect` out
  of `PalettePanel.tsx` into a new UI-less `PaletteHydrator` mounted once at the
  app root. This is the component that must always mount; the panel itself need
  not.
- **Remove the user-facing entries.** Delete the ForallMenu "Palette" row and
  remove `ThemeSection` from `SettingsPanel.tsx`. `ThemeSection.tsx` may be parked,
  not deleted.
- **Keep the devtool, gate it operator-only.** `PalettePanel` survives behind an
  operator gate (`?palette` query / key-chord), not the shipped menu or settings.
  Store, registry, and `applyPaletteOverrides` are untouched.
- **Per-feed schemes are a separate axis** (workspace layout, `tokens.ts`
  `PALETTES`), _not_ the override store — §III.4 is unaffected by any of this.

**One product call (decided).** Existing users may hold persisted preset/devtool
overrides under `PALETTE_STORAGE_KEY` (`ah:palette-overrides`). Chosen: **(b)
one-time purge** of `ah:palette-overrides` on upgrade, returning everyone to the
canonical shipped palette. Per-feed schemes survive (separate key). The headless
hydrator runs regardless, so the mechanism remains for operator tuning and future
use.

---

## IV. Consequences

- The pane colour stops being a per-feed problem — the question "what colour reads
  against any feed" is dissolved, not answered, by moving the work to the scrim.
- The disc looks identical over floor and frost; the long-standing leg-leak and the
  focus-rectangle are both closed by making the coin self-contained.
- Users lose free-form palette editing. That is the intent. Operators keep it.
- Net change is small: two CSS/token edits (§III.1–2), one component hardening
  (§III.3), one control swap (§III.4), one extract-and-gate (§III.5). No schema, no
  migrations beyond the override purge.

## V. Phasing

1. **Token + scrim** (§III.1–2). Pure CSS/token, no logic.
2. **Disc hardening** (§III.3). Self-contained; verify over every scheme + dark.
3. **Scheme cycle button** (§III.4). Isolated to FeedComposer/tokens.
4. **Palette-control retirement** (§III.5). Headless-hydrator extraction before
   removing any surface; confirm a saved override still applies on reload with the
   panel unmounted, then the §III.5 product call.

---

## VI. Implementation notes (2026-06-14)

Shipped as specified, with these deliberate, flagged adjustments:

- **§III.3 disc clip — wrapper, not the button.** The ADR said add `overflow:hidden`
  to the disc *button*, but the unread badge is a deliberate child at `top:-2,
  right:-2` that overflows the button; clipping the button would clip the badge.
  The authoritative `overflow:hidden`+`borderRadius:50%` clip therefore lives on a
  **wrapper span around the SVG** (same intent — the disc that draws the rim is the
  disc that clips), leaving the badge an un-clipped sibling. Plus r=28→27 and the
  optional `translateZ(0)` layer pin.
- **§III.3 focus — no inline `outline`.** The "illegal outline" was already closed
  by the `.forall-trigger` CSS (commit 371ab86: `:focus{outline:none}` +
  `:focus-visible` crimson ring). The ADR's suggested inline `outline:"none"` is
  explicitly **banned by CLAUDE.md** (higher specificity kills the keyboard ring
  too), so the CSS approach was kept and no inline outline was added.
- **`:root.dark .gh-scrim` is currently dead CSS** — there is no global `.dark`
  mechanism (the workspace floor is always `--ah-bone`; "dark" is a per-feed scheme
  local to a vessel). The rule is harmless and matches the ADR verbatim, retained
  for future-proofing.
- **Operator gate** = `?palette` query param **or** the `Ctrl+Alt+P` chord. The
  purge uses sentinel `ah:palette-purged-v1` (bump the suffix to re-run).

Verified: web `tsc --noEmit` clean; root ESLint 0 errors; hairline tripwire clean
for touched files. Live verification (the full vessel with 8px walls + elevation
shadow) needs the prod web rebuild.

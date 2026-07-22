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

**Wordmark lockup (2026-06-17).** A 24px `all.haus` wordmark sits to the LEFT of
the floating ∀ disc (`text · glyph`, font-sans medium, `ink-925`, `-0.01em`
tracking — matching the Nav/mobile wordmarks). It is part of the trigger's click
target: clicking it runs the same `setView` toggle and hovering it drives the
same ∀ glyph spin, and it's excluded from the outside-click dismiss. It lives in
its OWN fixed layer — a sibling of the disc container, not a child (a child of
the `z-60` container couldn't be placed independently in the stacking order) —
at **z-60**, so it stays CRISP above the Glasshouse scrim (`z-[55]`) exactly like
the disc: opening an overlay never blurs or dims it. (Earlier the same day it was
trialled at z-50, below the scrim, so a glasshouse hid it; reversed to z-60 +
24px so it reads as the persistent brand lockup.) Floating (desktop) only —
`MobileWorkspace`'s bar already carries its own wordmark. `aria-hidden`/`tabIndex={-1}`
so it doesn't duplicate the disc's accessible control.

**∀ → X back-to-workspace / minimise (2026-06-17).** The ∀ disc doubles as the
universal "way back". The glyph swap is an **animated cross-fade with a discreet
quarter-turn**, not a hard swap: the constructed ∀ and the **large white X** (the
same clipped white-bars construction — two diagonals spanning the disc) are two
stacked SVG `<g>` groups; as the close state engages the ∀ fades + rotates out
(−90°) while the X fades + rotates in (~200ms opacity / 260ms transform), both
turning about the view-box centre (28,28) so the clipped disc never shifts. The
close-X never inherits the disc's hover spin (the svg-level rotate is pinned to 0
whenever the X shows; the spin's `onTransitionEnd` reset is scoped to the svg's
own `transform` so the group morph transitions bubbling up don't mis-fire it).
`aria-label` becomes "Back to workspace". Because the disc sits at z-60 above the
frost on both desktop (floating) and mobile (bar), it is reachable above every
overlay — so panels no longer need an in-body "back to workspace" / escape prompt
(the empty-state links in `LibraryPanel` / `NetworkPanel` are now gated to the
standalone-page case only). The wordmark trigger shares the same handler.

- **Desktop:** the X shows for the six ∀-menu **destination** overlays only
  (Messages · Dashboard · Library · Network · Ledger · Settings — `ForallMenu`
  subscribes to those six stores' `isOpen`); a click runs `closeMenuOverlays()`.
  Reader / profile / composer panes are draggable windows carrying their own ✕,
  so they leave the disc as the ∀.
- **Mobile:** every Glasshouse is a full-screen sheet, so the disc is the
  minimise-X for **any** open sheet (the six destinations **plus** the
  note/article/feed composers, reader, profile, surface). This rides a presence
  registry, `useGlasshousePresence` (`web/src/stores/glasshouse.ts`): the "one
  Glasshouse at a time" invariant means it is always 0-or-1, so `Glasshouse.tsx`
  mirrors the single live pane's `onClose` into it on mount and clears it on
  unmount — token-guarded exactly like the module-level `activeGlasshouse` var, so
  a superseded pane's unmount never clobbers its successor's slot. The disc reads
  `isOpen` to flip the glyph and calls `close()` (the same close the pane's own ✕
  and Escape fire) to dismiss the sheet. The workspace underneath resumes the feed
  you left (the `ah:mobile-feed` resume key), so "back" lands you where you were.
  The X also shows whenever the ∀ **menu itself** is open — the open menu and its
  in-place panels (Search) are not Glasshouse sheets, so they aren't in the
  presence registry, but on mobile the disc is still their only dismiss
  affordance (no outside-tap target, no ✕ on the panel). So `showClose` also
  takes `isMobile && view !== "closed"`, and the disc's existing toggle
  (`view !== "closed"` → `"closed"`) closes the menu/panel; `aria-label` reads
  "Close menu" in that case. Desktop keeps the disc as ∀ while the dropdown is
  open (a mouse can click outside; an X on a small anchored dropdown reads oddly).

**Mobile back-guard — Back / edge-swipe == ✕ (2026-06-22).** On mobile, a browser
Back (Android back gesture/button) or iOS edge-swipe must close the open sheet, not
navigate off the site. Most overlays push **no** history entry — the six ∀-menu
destinations, the composers, the editor, and the mobile DM drill-down cover are all
in-memory state — so Back had nothing to pop and left the site. The fix is a small
LIFO **back-guard** (`web/src/lib/backGuard.ts`): each open dismissible owns one
same-URL history sentinel (`history.pushState`), and a single global `popstate`
listener closes the **topmost** guarded surface on Back instead of letting the
navigation through; a self-close (✕/Esc/scrim/swipe) consumes its own sentinel via
`history.back()` (closes must be idempotent). `Glasshouse` installs it for every
sheet via `useBackGuard(isMobile && !selfHistory, onClose)` — so on mobile, Back
closes any frosted sheet exactly like the disc-✕. **The three URL-synced overlays
(reader/profile/surface) opt out with the new `selfHistory` prop**: they already
push a canonical URL and listen for `popstate` themselves (see `stores/reader.ts`),
and a second sentinel would double-push. The **mobile DM cover** registers its own
guard *above* the Messages sheet's (`MessagesInbox`), so the first Back pops the
thread back to the conversation list (matching the back-arrow and the in-element
right-swipe), a second Back closes the Messages sheet, a third returns to the
workspace — surfaces unmount top-first, so each guard always cleans the current top.
The in-element finger-swipe recognizer is unchanged; it handles swipes that land
*inside* the cover (which never trigger the browser's edge-back), and the two paths
converge to the same state. **Desktop is untouched** (explicit ✕ affordances, no
edge-swipe-back). Mobile-gated via `useIsMobile`.

**Feed-launched frame (2026-06-17).** A reader pane or profile overlay opened
**from a feed card** frames itself in that feed's identity, in the feed's WALL
colour (`palette.walls`). The frame is an **inverted, thinner echo of the feed's
vessel** (⊓ — the inversion of the vessel's ⊔): a substantial top bar
(`FRAME_TOP` = 8px) + narrow side rules (`FRAME_SIDE` = 4px), **open at the
bottom**, so the pane reads as a piece of that feed's frame lifted onto the
scrim. `Glasshouse` takes an optional `frameColor` (a `var(--ah-…)` string) and
paints it as a pointer-events-none colour overlay (`absolute inset-0`, `z-[5]` —
below the `z-10` grip/✕ chrome, which are nudged inward off the coloured
borders) sitting in the content's top + side padding gutters, so it never
disturbs the pane's width/scroll geometry or its `overflow-hidden` clip;
8/4px are well clear of the banned single-pixel range (solid bars, not hairlines).
The colour rides the overlay stores: `useReader`/`useProfile` carry a `frameColor`
set on open and cleared on close/dismiss/pop. Only genuinely feed-launched call
sites pass it — `WorkspaceView`'s `openReaderFromPost` (article card → reader),
the card `Byline`'s `openProfileHref(href, palette.walls)` (byline → profile), and
the byline hover `AuthorModal` (fed `palette.walls` by `PostByline`). Feed-agnostic
launch points (sitewide `ProfileLink`, `SearchPanel`, `FeedComposer` source-author
links) pass nothing ⇒ `frameColor` null ⇒ no frame. On the mobile full-screen
sheet **neither the coloured frame nor the skip ears render** (gated on
`!isMobile`, 2026-06-19): the full-bleed sheet has no gutter to carry the
in-padding frame cleanly, so reader/profile sheets are plain on mobile.

**Skip ears (reader only, 2026-06-17).** When the reader is launched from a feed,
`ReaderOverlay` also passes `Glasshouse` a `sideNav` ({`onPrev`/`onNext` +
`canPrev`/`canNext`}) and `frameTextColor` (`palette.barText`). Glasshouse then
renders two **half-circle "ears"** protruding from the pane's left/right edges —
*siblings* of the pane (rendered in the wrapper, not the pane), so they clear its
`overflow-hidden`; vertically centred on the pane's measured height via a
`ResizeObserver`. Each ear is the `frameColor` with a CSS-triangle arrow in
`frameTextColor`: **left = previous article** (◀, up the feed), **right = next**
(▶, down the feed). They step through the launching feed's **article list** in
place: `useReader` carries `nav` ({`entries`, `index`}) + a `skip(±1)` that
re-opens the adjacent entry reusing the single pushed history entry
(`replaceState`), and `openFeedItem(entries, index, …)` wires it on launch. The
list is built by `WorkspaceView`'s module-level `articleToReaderEntry` over the
feed's `v.items` — **articles only** (the reader-pane click targets); notes and
external short posts return null and drop out of the skip sequence. An unavailable
step (`!canPrev`/`!canNext`) dims its ear to 0.3 and disables it. Ears are
suppressed on the mobile full-screen sheet (they'd fall off-viewport) and on any
feed-agnostic open (no `nav` ⇒ no `sideNav`). **Keyboard twin:** while a
feed-launched reader is open, `ReaderOverlay` binds **←/→** to `skip(∓1)` (the
keyboard equivalent of the ears) — ignored when a field has focus or a modifier
is held, and `skip` no-ops at the list ends. **Touch twin (mobile, 2026-06-19):**
because the ears are suppressed on the full-screen sheet, `ReaderOverlay` also
binds a horizontal swipe across the reading pane to the same `skip` — swipe left
→ next, swipe right → previous (standard paged-content convention). A swipe
counts only when it travels ≥56px horizontally and clears the vertical delta
(vertical-dominant gestures fall through to normal scrolling), and a swipe begun
inside a horizontally-scrollable child (wide code block / image) is left to that
element — the same restraint the mobile feed pager shows. Gated on `hasNav` +
`isMobile`.

**Mobile reader text column (2026-06-19).** On the full-screen sheet the reader
must fill the viewport, not inherit the desktop overlay's wide gutters. The
external `ExternalArticleReader` `paddingX` (and the native preview skeleton)
step responsively — `px-6 sm:px-12 md:px-24` — so the desktop overlay keeps its
roomy ~96px side margins while a phone gets a ~24px gutter. The native
`ArticleReader` was already responsive (`px-4 sm:px-6` + `px-5 sm:px-10
md:px-[72px]`), so only the external path and the skeleton needed the fix; the
prior flat `px-24` collapsed an external article to a ~183px column on a 375px
phone.

(The frame was originally a full `outline` of `palette.walls` at the vessel's 8px
SIDE-WALL thickness, all the way around; changed on 2026-06-17 to the inverted
top-bar-plus-side-rules shape — open at the bottom, thinner — with the skip ears
added to the open sides.)

**Whole-pane drag + reader stretch (2026-06-17).** The Glasshouse pane is
draggable by **any empty/margin part of itself**, not only the top-centre grip
(which remains as the discoverable affordance). A pointerdown on the pane starts
the drag *unless* `isPaneDragSurface` (`Glasshouse.tsx`) rules it out — it bails
when the target is an interactive control (`a, button, input, textarea, select,
label, [role="button"|"link"|"textbox"], [contenteditable], [data-no-drag]`,
plus `audio`/`video`), holds its own selectable text (a direct text node — `<p>`,
heading, span; a bare layout container with no direct text reads as draggable
chrome), or is a native scrollbar gutter (pointer past `clientWidth`/`clientHeight`
of a scrollable target). So prose stays highlightable, links/buttons stay live,
scrollbars still scroll — only the margins move the window. The drag pins
`body { user-select: none }` for the gesture so a sweep over prose mid-drag
doesn't select. Separately, `ReaderOverlay` now opts into `resizable` (its
existing `persistKey="reader"`), so the reader pane carries the bottom-right
stretch handle and persists its size — same mechanism as the composer / editor /
messages panes.

**Flush surfaces must clear the pinned handles (2026-06-22).** The grip
(top-centre, ~y14–22px across the type scale) and the bottom-right resize grip
(16×16, on `resizable` panes) are pinned `z-10` over the pane *content*. A body
that reserves a top gutter (the `py-12` page-style overlays — Ledger, Dashboard,
Library, Network, Settings) puts both handles in empty space and is safe by
construction. A body that renders **flush** to the pane edges must clear them
itself: keep no control under the top-centre grip band, and — when the pane is
`resizable` — nudge any bottom-right control left of the resize grip. The merged
Messages inbox (`MessagesInbox`) is the worked example: its centre conversation
column carries `pt-6` so the grip lands on the empty grey strip, not the
"Messages" header, and `MessageThread`'s send form reserves `pr-7` (under the
same `headerRightInset` flag that already insets the header for the ✕) so the
Send button clears the resize grip. The mobile full-screen sheet has no grips
(only the ✕, which the segmented header clears with `pr-12`), so this is a
desktop-pane concern only.

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

**Amendment (2026-07-19) — colour is a menu, not a cycle; and `nextScheme` is
retired.** The single-`AppearanceControl` colour cycle above proved awkward:
reaching a specific scheme took up to four clicks and you couldn't see the
options. The colour axis is now a small **menu** (`SchemeMenu` in
`FeedComposer.tsx`) — the trigger shows the selected scheme's dot, and opening
drops a little palette of one `SchemeDot` per scheme (a solid dot in the
scheme's most forceful surface, its `walls` colour, in the current global
light/dark variant), click to pick. This replaces both the old swatch row _and_
this decision's cycle button for colour only. The three-bar `SchemeSwatch` and
`tokens.ts::nextScheme` are removed. **Orientation and text size stay cycles**
(a couple of ordered steps, no palette to preview), and **density collapsed to a
two-state cycle** (`compact`/`standard`) the same day — see §III.4a.

Accessibility notes (2026-07-21, §0i.7/§0h.5): each swatch's `aria-label`
deliberately exposes the internal colourway id (`Colour scheme: spring`) — "no
display name" is a visual-register decision and the ids are stable and
descriptive, whereas an unnamed radio set is unusable to AT. The active ring on
`SchemeDot` keys off the global mode explicitly (bone in dark, ink in light —
the islanded span's pinned `--ah-ink` would otherwise vanish on the inverting
menu ground), trigger + swatches carry `.focus-ring`, and the menu's Escape
handler stops propagation so it closes the menu without dismissing the whole
FeedComposer (Glasshouse listens on `window`, the menu on `document` — the M22
lightbox precedent). That Escape-claim pattern was centralised 2026-07-22
(§0k.3) into the shared `web/src/hooks/useEscapeShield.ts` — SchemeMenu now
rides it, along with the five other popovers that had the bare-`document`
double-close (ProfileFollowControl, IdentityLinkControl, FollowingTab's
unsubscribe dialog, VouchModal, AuthorModal) — see the CLAUDE.md "Overlay
close affordance" rule; new popovers over a pane use the hook, never an
inline copy.

### 4a — Density is a two-state toggle (2026-07-19)

`Density` was `compact | standard | full`, but `full` rendered byte-identically
to `standard` in every path (the only density branches — card padding, action-row
visibility, media visibility, drag — all test `=== "compact"` only). It is
removed: `Density = 'compact' | 'standard'`, `nextDensity` toggles the two, and a
new `tokens.ts::normalizeDensity` migrates any persisted `full` (or junk) to
`standard` on read (localStorage rehydrate + server-appearance reconcile), so no
DB backfill is needed. The gateway `FEED_DENSITIES` enum keeps `full` **accepted**
(a round-tripped stale value is not rejected), mirroring how `FEED_SCHEME_IDS`
tolerates the retired `primary`/`dark`. Dead plumbing cleared alongside: the
`Vessel` `density` prop (density reaches cards via `WorkspaceView`'s
`CardContext`, never through the vessel) and its never-read `effDensity`.

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

## VII. Global light/dark/system mode (2026-06-21)

A sitewide appearance toggle was added: **Light / Dark / System**, per-device
(localStorage `ah:color-mode`, default `light`), modelled on the type-size
control. Store `web/src/stores/colorScheme.ts`, headless `ColorSchemeHydrator`
(mounted in `LayoutShell`, with a `matchMedia` listener so `system` tracks the OS
live), settings UI `account/ColorModeControl`, and a blocking inline script in
`app/layout.tsx` that sets `html.dark` before paint (no white flash). The store
toggles the `html.dark` class + `documentElement.style.colorScheme`.

**This intentionally reverses the original §III.2 "the pane is always pale
parchment / always-light" stance.** The Glasshouse pane is now *mode-neutral*,
not literally light: it is white in light mode and a dark elevated surface in
dark mode. The separation model (§III.1 scrim does the separating; §III.2 pane is
the lightest/outermost layer *within its mode*) is preserved — the elevation
ramp simply inverts.

**Mechanism — invert-at-root + feed light-islands:**

1. **`html.dark { … }`** in `globals.css` inverts only the canonical NEUTRAL
   ramp (`DARK_SLUGS` in `web/src/lib/palette/island.ts`: `ink`, the greys,
   `white`, `glasshouse`, `glasshouse-well`, `bone`/`bone-bright`, `off-white`,
   `cream*`, `nav-grey`). Surfaces darken, text lightens; elevation order
   (ground < well < cards < pane) is preserved inverted. Accent/semantic/
   already-dark/per-feed-season slugs are untouched, so the trust pips, crimson
   accents, the dark vessel scheme and all four-seasons schemes are unaffected.
   Because every global-chrome consumer reads these vars, the whole shell flips
   with near-zero per-component edits: workspace ground, reader/profile/source/
   tag surfaces, every Glasshouse overlay, dropdowns/popovers.

2. **A feed scheme is a COLOURWAY (seasonal character), orthogonal to light/dark**
   (2026-06-21): the colourway is per-feed, but its light-vs-dark follows the
   **global** toggle. Five colourways (`basic` + `spring`/`summer`/`autumn`/
   `winter`), each with a **light AND a dark surface set** (registry slugs, the
   opposite-of-original variant suffixed `-dk`/`-lt`); `paletteFor(scheme, dark)`
   returns the matching variant. **Desktop feed vessels still carry
   `LIGHT_ISLAND_STYLE`** on the `Vessel` root — an inline re-declaration of
   `DARK_SLUGS` back to their canonical light triples (inline beats the
   `html.dark` stylesheet rule) — but the island's role is now narrower: it keeps
   the *derived text slugs* (bone/ink/white/stone) the palette references
   resolving canonical so the text ramps stay deterministic; the **variant**, not
   the island, supplies the light/dark. (Season surface slugs are not in
   `DARK_SLUGS`, so only the variant choice flips them.) The **ForallMenu disc +
   dropdown** (locked nav chrome) and the FeedComposer **scheme swatch** (which
   previews the colourway's variant for the current global mode) carry the same
   island. The **wordmark** is a sibling over the floor,
   so it flips to light via `var(--ah-ink)`. **The disc itself, though islanded,
   deliberately inverts its own fill/glyph in dark mode** (2026-06-21): rather
   than letting the island freeze it, `ForallMenu.tsx` picks `discBg`/`discGlyph`
   off `useColorScheme().dark` — light mode is the dark `ink-925` disc + light
   `bone` glyph, dark mode is the photo-negative (light `bone` disc + dark
   `ink-925` glyph). Both tokens still resolve to canonical light inside the
   island, so the swap is the explicit JS choice, not the root inversion; the
   close-X glyph and the unread-badge ring track the same pair. The **dropdown
   menu is unaffected** (stays light).

3. **Mobile feeds render the per-feed colourway in the global mode's variant**,
   same as desktop (2026-06-21): `WorkspaceView.renderFeedContents` + `interiorFor`
   use `paletteFor(brightness, dark)`, and the mobile per-feed pages carry
   `LIGHT_ISLAND_STYLE` (`MobileWorkspace.tsx`) so the derived text resolves
   canonical. The mobile **bar** above the pages is NOT islanded — it is global
   chrome and inverts with the toggle.

4. **Theme-following content** (profile/source/tag content-log cards — which
   carry no colourway) uses `globalContentPalette(dark)` (the `BASIC_LIGHT`
   palette with `isDark`/crimson — plus the mode-specific stone tones
   `cardStandfirst`→`stone-300` and `nameLabel`→`stone-350`, since `stone-*` is
   not in `DARK_SLUGS` and so doesn't invert; the light-mode `stone-600` would
   otherwise read dark-on-dark) corrected, outside any island. Article `prose` gets a `html.dark .prose`
   `--tw-prose-*` override (the plugin's vars are fixed grays that wouldn't
   otherwise invert).

**Also in this change:** the FeedComposer scheme swatch was redesigned from the
murky concentric-rectangle chip (§III.4) to **three fat equal bars** (French-flag
grammar: walls · interior · card), larger and clearer. And the external author
profile header (`/author/:id`) was restructured so the follow control drops to
its **own row below the identity block on mobile** (it previously shared the
avatar/name row and broke long names).

Verified: web `tsc --noEmit` clean; `next build` clean; root ESLint 0 errors;
hairline tripwire clean for touched files. Live verification needs the prod web
rebuild.

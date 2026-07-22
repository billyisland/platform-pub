# WORKSPACE-COLUMN-LAYOUT-ADR: The Columnar Floor — Derived Geometry, No Collision

**all.haus Architectural Decision Record**
**Status:** Proposed, 2026-07-22; codebase-review + decision pass folded in the same
day (drop-zone split, deferred column collapse, edge auto-pan, nav-row z-order,
Explain adaptation, v1 appearance migration, virtualization-first sequencing).
Supersedes the free-coordinate floor (signed store
coordinates, mover-yields collision, bootstrap heal) shipped across the 2026-07-20/21
resolver rework, and the difference-blend ∀ lens. Retains the vessel chassis, the
merge flow's intent, per-feed appearance, and the mobile pager untouched.
**Author:** Ed Lake / Claude (design partner)
**Depends on:** WORKSPACE-DESIGN-SPEC (⊔ vessel, no-overlap addendum), MOBILE-LAYOUT-ADR (feed numbering: `feeds.sort_rank`; hide: `feeds.hidden`), FORALL-CUT-AND-LOCKUP-ADR (∀ mark)
**Affects:** `web/src/lib/workspace/*`, `web/src/stores/workspace.ts`, `web/src/components/workspace/WorkspaceView.tsx`, `Vessel.tsx`, `ForallMenu.tsx`, `MergeFeedConfirm.tsx`

> **Note to Claude Code.** This is a design-decisions document, not a line-level
> implementation spec. It fixes the _what_ and the _why_; you own the _how_. Where it
> names a file, constant, or function, treat that as the intended shape unless you find
> a concrete reason it cannot work — in which case stop and flag it rather than
> improvising a divergent design. Phasing is in §X; Slice 0 (virtualization, against
> the current floor) ships first, then Slice 1 (the pure layout module) precedes the
> rest of the rework and must land with its tests.

---

## I. Problem statement

The floor currently stores a signed `{x, y}` per feed and enforces the no-overlap
invariant by _resolution_: a mover-yields candidate search on drop
(`findRestingPosition`), a resize clamp (`clampSizeClear`), a bootstrap heal that
shelves resting piles rightwards (`repairRestingLayout` → `healRestingOverlaps` →
`reconcileLayouts`), and a signed-origin canvas whose extent is derived per frame
(`canvas.ts`). Each mechanism exists to repair states the data model permits but the
design forbids. The observed failures are exactly the repairs firing: a declined merge
re-runs the resting solver and the source vessel lands somewhere the user did not put
it; the heal shelves a vessel past the right edge of everything, off any screen the
user is looking at; the extent stretches to cover it, so the workspace scrolls into
apparently empty space. The machinery is not buggy so much as the model is wrong: it
represents states we never want, then works to escape them.

Separately, the tab is heavy. Two causes, one dominant. Dominant: nothing
virtualizes — every vessel mounts its full hydrated feed (cards, media, live DOM)
regardless of visibility, so n feeds cost n live feeds at all times. (The web
client holds no relay connections — `lib/ndk.ts` is types-only and all content
arrives over the gateway REST API — so the cost is React trees, DOM nodes, and
decoded media, not sockets.)
Secondary: the ∀ lens renders `mix-blend-mode: difference` across the viewport inside
a `body { isolation: isolate }` scope, which forces the compositor to hold large
intermediate surfaces and defeats scroll-layer caching — a GPU/repaint cost, real but
not the thing making Firefox threaten the tab.

## II. Design principles

1. **Geometry is derived, never stored.** The persisted layout is an _order_ — columns
   left to right, slots top to bottom — plus per-slot sizes. Pixel positions, gutters,
   and the scroll extent are computed from it by one pure function. A state that
   violates the spacing rules is unrepresentable, so there is nothing to detect,
   resolve, or heal.

2. **The floor is finite and taut.** Scroll extent runs from one grid square left of
   the left-most feed to one grid square right of the right-most. Dragging cannot
   create empty space; hiding cannot leave holes. There is no Excel-style lost
   scrolling because there is nowhere to be lost.

3. **The stripe is the unit.** The grid square equals the vessel wall: `GRID = WALL =
   8`. Wall / buffer / wall between adjacent vessels reads as three even coloured
   bands. The grid is invisible; the stripes are how you feel it. (8px also restores
   the phase with the 4px design rhythm that the 10px lattice broke — the exact repair
   `grid.ts`'s own comment anticipated.)

4. **Drops resolve to slots, not coordinates.** A drag ends at the nearest legal slot.
   The dragged vessel is the only thing whose slot changes by the gesture itself;
   shunting is a consequence of recomputation, visible and predictable, never a
   solver's side-effect at a distance.

5. **What is off-screen costs nothing.** A vessel outside the viewport keeps its
   chassis and loses its contents: card tree unmounted, scroll position and
   pagination cursor retained.

## III. The layout model

### III.1 Structure

```ts
interface WorkspaceLayout {
  columns: Column[];              // ordered, left → right
}
interface Column {
  id: string;                     // stable ULID, not a feed id
  slots: Slot[];                  // ordered, top → bottom
}
interface Slot {
  feedId: string;
  w: number;                      // px, snapped to GRID; slots in a column may differ
  h: number | null;               // px snapped, or null = "fill remaining share"
}
```

Appearance (brightness, density, orientation, textSize) moves to a separate
`Record<feedId, VesselAppearance>` persisted alongside. Layout is purely structural;
appearance is purely per-feed; neither store reaches into the other. Two provisos:
the record stays a **cache** for scheme and density, which are server-authoritative
feed character (`feeds.appearance`, MOBILE-LAYOUT-ADR §VI) — the bootstrap
reconcile and the FeedComposer PATCH-with-revert survive unchanged; and the v1
store's `minimized` field is dropped, not carried — it has no consumer anywhere
in the tree today.

### III.2 Derivation

One pure function, `deriveGeometry(layout, viewport): Map<feedId, Rect> & { floorWidth }`:

- Available height `H` = viewport height − nav row height − 2·GRID (top and bottom
  buffer). Feeds may never extend below the top of the nav row (§VI).
- A column's bounding width = the widest slot in it. Column x positions: GRID, then
  each subsequent column one GRID past the previous column's bounding right edge.
  Slots narrower than the column left-align within it (their numeral edge stays on the
  shared gridline).
- Within a column, fixed-height slots take their `h`; `null` slots divide the
  remainder (after gutters and fixed slots) equally, floored to `SLOT_MIN_H`. Vertical
  order top to bottom with one GRID between slots.
- `floorWidth` = last column's right edge + GRID. If a single column narrower than the
  viewport is all there is (the first-run state), the strip centres; otherwise it
  left-aligns and `floorWidth` is the scroll extent. No signed coordinates, no origin,
  no `computeExtent`.

### III.3 Constants

`GRID = 8` (replacing 10, and equal to `WALL`). `SLOT_MIN_H` — the height at which a
feed still renders as something useful: byline row + one card ≈ the current
`VESSEL_MIN_H = 200`, to be tuned by eye. `SLOT_MIN_W = VESSEL_MIN_W = 220`.
`FACTORY_W` / `FACTORY_H` — the first-run Billy Island clone's dimensions: wide (on
the order of 640px, tune by eye) and full available height. These are also the
regimented-layout dimensions (§V).

### III.4 First run

On first authenticated load with no stored layout: one column **per seeded starter
feed**, one slot each, at `FACTORY_W × null` (fills `H`), centred per §III.2. The
gateway clones _every_ `is_starter_template` feed for a new owner
(`gateway/src/routes/feeds/crud.ts::seedStarterFeeds`) — today that is the single
Billy Island clone, but the first-run branch must not assume n = 1; the
no-template fallback is the client-minted empty feed, same shape. No horizontal
scroll exists until content exceeds the viewport.

### III.5 Adding a feed

A new feed appends a new right-most column with one slot at `FACTORY_W × null`.
Geometry recomputation does the rest: the strip stops centring once it exceeds the
viewport, the left-most column sits one GRID from the floor's left edge, and the
scroll extent grows rightwards. Feed numerals (`sort_rank`) are untouched by layout —
there is no requirement that Feed 1 be left-most.

## IV. Gestures

### IV.1 Drag

A drag lifts the vessel out of the layout, but its slot is **held open** (rendered
empty) for the duration of the gesture — the column recomputes without it only on
release. Rationale (decided 2026-07-22): collapsing live shrinks `floorWidth`
mid-gesture, the browser clamps `scrollLeft`, and the floor slides under the
pointer — the exact lurch class the current code confines to gesture boundaries
(see the compensation choreography in `WorkspaceView.tsx` / `Vessel.tsx`, whose
comments document the bug). The held-open slot also doubles as the snap-back
target for a cancelled drop; the live tighten-preview of hiding is forgone.

The lifted vessel follows the pointer freely. Throughout the
drag, the drop resolver (§IV.2) runs on the pointer position and the floor shows one
insertion affordance — a GRID-wide highlight stripe at the slot that would be taken.
Holding the drag within an edge margin (~48px) of the left/right viewport edge
**auto-pans** the floor continuously under it, speed scaling with proximity — the
taut floor has no gesture slack to drag into, so this is the only way a drag
reaches an off-screen column; the resolver keeps reading the pointer against the
moving geometry.
Release commits to that slot. Because every pointer position maps to some nearest
legal slot, "drag as far as you like" is safe: release in empty space and the vessel
snaps back to the nearest gap, one buffer from its neighbour, never lost.

### IV.2 Drop resolution

In priority order at the release point:

1. **Over a feed — split by zone** (decided 2026-07-22). On a taut floor nearly
   every pointer position is inside some vessel's rect, so "over a feed → merge"
   as a whole-rect rule would leave only the 8px gutters as insertion targets and
   make reordering a precision game. Instead the rect splits: an **outer band**
   (~48px, tune by eye) adjacent to a column or stack boundary resolves to
   **insertion at that boundary** (per rules 2/3); only the **central region**
   arms and, on release, prompts to merge (§IV.4). Insertion stays reachable
   everywhere without aiming; merge keeps a large, unambiguous target.
2. **Vertical gap**: pointer within a column's x-span, in a stack gap (including
   above the first or below the last slot) whose height ≥ `SLOT_MIN_H` + 2·GRID →
   insert into that column at that position, `h` = the gap minus buffers (auto-fit).
3. **Between columns** (or beyond either end): insert a new column at that boundary;
   every column rightwards shunts by recomputation. The vessel keeps its dragged `w`
   and `h`.

"Nearest" is measured from the pointer at release, Euclidean to the candidate slot's
centre stripe.

### IV.3 Resize

Handles adjust `w`/`h` on the slot, snapped to GRID, clamped to `SLOT_MIN_*` and to
`H`. Growing a slot's width grows its column's bounding width; the floor recomputes
and columns to the right slide — no clamp-at-neighbour needed, because neighbours are
in other columns and gutters are invariant. Growing height beyond what the stack can
hold clamps at the available remainder (fixed-height siblings are not squeezed;
`null` siblings compress down to `SLOT_MIN_H`).

### IV.4 Merge and decline

Dropping on a feed's central region prompts via `MergeFeedConfirm` as now. Confirm
merges the feeds (server call unchanged) and the source's slot vanishes;
recomputation closes the gap.
Decline (or failure, after the dialog has shown its error) needs **no placement at
all**: the source never left the layout — its slot was held open for the whole
gesture (§IV.1) — so dismissing the dialog simply lets it spring home. The target
never moves. No solver, no shelf, no vanishing; `settleAfterAbandonedMerge` has no
successor because the state it existed to repair is no longer reachable.

### IV.5 Hide, unhide, remove

Hide (server-side `feeds.hidden`, unchanged) splices the slot; an emptied column is
removed; recomputation compacts, so the visible feeds are always as tightly arrayed
as the buffer allows. Unhide re-enters as a new right-most column at factory size.
Delete behaves as hide plus the existing server delete. `removeVessel`,
`reconcileLayouts`' ghost-pruning survives in spirit: bootstrap still drops slots
whose feed ids the server no longer returns.

## V. The regimented layout (hotkey)

A global hotkey toggles **regimented mode**: every non-hidden feed on screen at once,
factory dimensions, ordered by numeral 1..n left to right — the parade-ground view.

- **Key:** `\` (backslash), plain, no modifier. Suppressed when focus is in any text
  input, textarea, or contenteditable, while a modal/overlay is open, **and while an
  Explain program is active** (`useExplain.isActive` — the frozen floor owns the
  keyboard; Explain is not in the Glasshouse presence registry, so the overlay check
  alone does not cover it). No current
  global single-key bindings conflict (verified 2026-07-22: the only global
  bindings are ⌘K, Ctrl+←/→, Ctrl+Alt+P, and Escape handlers). Changeable by
  taste; it is one constant.
- **Semantics:** entering regimented mode _derives_ a transient layout — one column
  per visible feed, `sort_rank` order, each `FACTORY_W × null` — and renders it. If n
  feeds at factory width exceed the viewport, regimented mode scales widths down
  uniformly (never below `SLOT_MIN_W`) so all n fit; below that floor it admits
  horizontal scroll rather than render uselessly narrow feeds.
- **The custom layout is not touched.** The user's `WorkspaceLayout` stays in the
  store and in storage exactly as it was; regimented mode is a view over the feed
  list, not an edit to the layout. Pressing `\` again drops back to the stored
  layout. This makes restore trivial and crash-safe: there is no "previous layout"
  snapshot to lose, because the previous layout was never replaced.
- **Edits while regimented:** drag/resize/merge gestures are live but any layout
  _mutation_ (a completed drop, a resize commit) exits regimented mode first and
  applies to the custom layout — i.e. the regimented arrangement materialises as the
  new custom layout with that one edit applied. Appearance changes (brightness,
  density) are per-feed and apply in either mode without exiting.
- Persist only the boolean (`workspace:regimented:{userId}`) so a reload lands where
  the user left off.

## VI. The nav row and the death of the lens

The ∀ site-navigation control leaves its floating disc position and renders as a
fixed row along the bottom of the viewport, full width, ordinary opaque chrome (walls
palette, slab rule on its top edge). The workspace floor ends one GRID above it;
§III.2's `H` already accounts for this. Feeds can never extend behind or below it.

**Z-order and Glasshouse interplay** (decided 2026-07-22, mirroring the mobile
bar precedent): the nav row sits at **z-58** — above the Glasshouse scrim (z-55)
and pane (z-56), below the lightbox (z-70) — so navigation stays live over any
open pane, preserving the substance of the crisp-above-the-frost invariant
(destination-hopping, Explain launchable over a pane). Glasshouse panes clamp and
position within `vh − navRowH` (extend `usePanePlacement`'s desktop path the way
its mobile branch already subtracts `MOBILE_BAR_H`). The mobile bar stays
top-anchored; the desktop row is bottom — a deliberate asymmetry, one rule per
form factor.

**Explain adapts in the same slice** (Slice 4): the `disc` explainable root
re-anchors to the row's ∀, leader/anchor geometry re-derives against the bar, and
the D3 chrome-swap and paneExplain branches are re-pointed — Explain never goes
dark on master. The `\` hotkey suppression during a program is §V's.

The difference-blend lens is deleted: `mix-blend-mode: difference`, the
`isolation: isolate` scope on `body`, the lens-mode hoisting and stacking-context
choreography in `ForallMenu.tsx` (§IV.5 of its ADR), and the scrim-layering rules
that existed to keep the blend legible. Rationale: (a) the compositing cost — a
viewport-sized blend surface re-rendered on every scroll frame; (b) with a bounded,
taut floor and a fixed nav row there is nothing left for the lens to float over. The
∀ mark itself, the menu's contents, and its ceremony are retained; only the blend and
the float go.

## VII. Virtualization

`WorkspaceView` tracks the scroll viewport and mounts feed _contents_ only for
vessels intersecting viewport ± one viewport-width margin. Outside it, a vessel
renders chassis, numeral, byline, and a flat interior wash — no cards, no media.
The mechanics are simpler than they sound because the state already lives in the
right place: `VesselState` (items, `nextCursor`, caught-up watermark) is
`WorkspaceView` component state and survives a contents unmount as-is; there are
no subscriptions to tear down (§I — the client is REST-only). The one thing an
unmount does lose is the DOM scroll position, so the vessel saves its scroll
body's `scrollTop` on unmount and restores it on remount. Entering the margin
remounts and rehydrates. Regimented mode benefits automatically: with all feeds
on screen they are all mounted, which is the mode's point, but n is bounded by
what fits.

This slice, not the layout rewrite, is the fix for the Firefox memory pressure,
and it is deliberately independent. **It ships first** (decided 2026-07-22):
against the _current_ floor, before Slice 1 — the user-facing pain stops weeks
earlier and nothing in it is thrown away by the rewrite.

## VIII. Persistence

localStorage remains the source of truth (per WORKSPACE-EXPERIMENT-ADR §3 — now in
`planning-archive/`), new key
`workspace:layout:v2:{userId}` holding `{ columns, appearance }`, debounced 200ms as
now. On first v2 write the v1 key (`workspace:layout:{userId}`) is read once and
deleted: **coordinates are discarded** (the new model has no use for them), but the
**appearance fields are carried across** — `textSize` and `orientation` are
local-only (no server copy, unlike scheme/density) and the new model still uses
them, so a wholesale wipe would silently lose real settings; `brightness`/`density`
come along too as warm cache, with the server staying authoritative (§III.1).
Decided 2026-07-22 — a one-shot ~10-line read, not a migration framework. The
legacy `hidden` bootstrap sweep (`clearLegacyHidden`) retires with the v1 key.

## IX. Deletions

Gone entirely: `lib/workspace/collision.ts` and `collision.test.ts`
(`findRestingPosition`, `clampSizeClear`, `repairRestingLayout`);
`healRestingOverlaps` and the heal half of `reconcileLayouts`; `lib/workspace/canvas.ts`
(signed origin, `computeExtent`, `EDGE_PAD`); `settleAfterAbandonedMerge` and the
armed-merge pointer/rect split it existed to reconcile, replaced by §IV.2's single
resolver; the lens blend per §VI — **including its satellites**:
`stores/lensSuppress.ts` and the `useLensSuppressor` call sites in `NewFeedPrompt`
and `LightboxOverlay`, the canvas `isolation: isolate` in `WorkspaceView`, and the
`body { isolation }` scope in `globals.css`; `defaultGridSlot`/`DEFAULT_GRID`; the
store's dead `minimized` field (§III.1). `grid.ts` shrinks to `GRID = 8`, `snap`, and
the size constants — `snap` stays exported because the Glasshouse pane drag/resize
shares the lattice (persisted `ah:overlay-pos/size` values re-snap 10→8 on next
interaction; harmless). Kept: the Ctrl+←/→ jump-to-ends binding, unchanged — still
meaningful on any floor wide enough to scroll; don't lose it in the
`WorkspaceView` rewrite. The expected diff is strongly net-negative.

**Doc obligations, same change:** CLAUDE.md's "Desktop workspace floor — infinite
sideways, never taller" section, the lens paragraphs (∀ mark / FORALL-CUT), and
the disc-at-z-60 Glasshouse invariant are written as standing "never reintroduce"
rules — if they are not superseded in the commit that ships each slice, future
sessions will actively defend the old model against this one. FORALL-CUT-AND-LOCKUP-ADR
and the WORKSPACE-DESIGN-SPEC mover-yields addendum get status notes pointing here.
The stale "Web reads via NDK" line in CLAUDE.md's architecture section should be
corrected while in there (§I).

## X. Phasing

Every slice lands green on master with the standing rituals: root `npm run lint` at
0 errors, `next build` before committing web changes (SWC-only errors escape
tsc/eslint), `scripts/check-hairlines.sh` over touched files, and a
`docker compose build web && docker compose up -d web` pass at `localhost:3010`
(the web image is a prod build — no hot reload).

### Slice 0 — virtualization, first (§VII)

Ships against the **current** floor; touches `WorkspaceView.tsx` and `Vessel.tsx`
only.

- **Visibility set.** `WorkspaceView` already holds everything needed: `viewport`
  state, `floorScrollRef` (kept current by the scroll listener), and per-vessel
  store rects. Add a `visibleIds: Set<string>` recomputed rAF-throttled on scroll /
  resize / layout change: vessel visible iff `[x − originX, x − originX + w]`
  intersects `[scrollLeft − viewport.w, scrollLeft + 2·viewport.w]` (± one
  viewport margin), with `x`/`w` from `positions[id]` (`w` falling back to
  `VESSEL_DEFAULT_W`). Add a small hysteresis (a second margin band or trailing
  debounce) so a vessel straddling the boundary doesn't thrash mount/unmount.
- **Contents gate.** New `Vessel` prop `contentsMounted: boolean`. The vessel and
  its chassis stay mounted (refs, drag, resize, VesselBar all persist); only the
  scroll-body children swap for a flat interior wash. Because the Vessel instance
  survives, it owns the restore state internally: when `contentsMounted` flips
  false, save `scrollBodyRef.current.scrollTop` into a ref; when it flips true,
  restore it in a layout effect. `VesselState` (items, `nextCursor`, watermark)
  is untouched by design — it lives in `WorkspaceView`, not the unmounted tree.
- **Height pinning.** An intrinsic-height vessel (no stored `h`) collapses when
  its cards unmount, and `readFloorRects` (still live in this slice) reads
  `el.offsetHeight` for collision/merge — a collapsed wash would lie to the
  resolver. On the flip to unmounted, measure the chassis height and pin it as an
  explicit height on the wash; unpin on remount.
- Mobile is out of scope: the pager already bounds the mounted set to one
  full-bleed page.
- **Verification:** Firefox `about:memory` / task-manager before/after with a
  many-feed workspace; drag/merge/resize behave identically for washed vessels
  (they are obstacles and merge targets exactly as before).

### Slice 1 — the pure layout module

New `web/src/lib/workspace/layout.ts` + `layout.test.ts`. Nothing renders yet;
this is the half the property tests can hold to account.

- **Types** per §III.1 (`WorkspaceLayout`, `Column`, `Slot`), plus a `Drop`
  discriminated union:
  `{kind:'merge', targetFeedId}` ·
  `{kind:'into-column', columnIndex, slotIndex, h}` ·
  `{kind:'new-column', boundaryIndex}` — the three §IV.2 outcomes.
- **Functions** (all pure; viewport passed as `{w, h, navRowH}` — `navRowH` is 0
  until Slice 4 wires the row):
  - `deriveGeometry(layout, vp) → {rects: Map<feedId, Rect>, floorWidth, offsetX}`
    per §III.2; `offsetX` carries the first-run centring (single column narrower
    than the viewport). **Degradation is derivation's job**: on a shrunken
    viewport (window resize, or Slice 4 subtracting the nav row), `null` slots
    compress toward `SLOT_MIN_H` first, then fixed `h` values squeeze
    proportionally — the *stored* layout is never rewritten by a resize, because
    geometry is a function of layout **and** viewport.
  - `resolveDrop(layout, geom, pointer, lifted: {feedId, w, h}) → Drop` per
    §IV.2, including the edge/centre split (`EDGE_BAND = 48`) and the held-open
    slot (the lifted feed's own slot is not a merge target and resolves as a
    no-op drop back into itself).
  - `applyDrop(layout, feedId, drop)`, `insertFeed(layout, feedId)` (append
    right-most column at `FACTORY_W × null`), `removeFeed(layout, feedId)`
    (splice slot, drop emptied column), `resizeSlot(layout, feedId, size, vp)`
    (w free to the max, h clamped to the stack remainder per §IV.3),
    `regimentedLayout(feeds: {id, sortRank}[], vp)` per §V (uniform width
    scale-down, floor at `SLOT_MIN_W`).
  - Constants: `SLOT_MIN_W`/`SLOT_MIN_H` (aliasing `VESSEL_MIN_W`/`VESSEL_MIN_H`
    from `grid.ts`), `FACTORY_W`/`FACTORY_H`, `EDGE_BAND`, `AUTOPAN_MARGIN = 48`,
    `AUTOPAN_MAX_SPEED`.
- **`grid.ts` flips to `GRID = 8`** here (one line + comment rewrite — the
  comment already names 8 as the phase-preserving value). This retunes the live
  free-coordinate floor and the Glasshouse pane lattice immediately: stored
  multiples of 10 re-snap to 8 on the next gesture, which is invisible in
  practice and saves a two-lattice interregnum.
- **Tests**, in the property-corpus style of `collision.test.ts` (which this
  file replaces in Slice 3): for random layouts and random gesture sequences —
  no derived rect overlaps another; every inter-vessel gutter is exactly GRID;
  `floorWidth` is taut (last right edge + GRID); every pointer position resolves
  to a legal `Drop` and applying it yields a legal layout; `regimentedLayout`
  fits n feeds or admits scroll only below `SLOT_MIN_W`; derivation under any
  `vp.h` keeps every rect within `H`.

### Slice 2 — the store

`stores/workspace.ts` rewritten around `{layout: WorkspaceLayout, appearance:
Record<feedId, VesselAppearance>, regimented: boolean}`. Written and unit-tested
first, but **lands in the same commit as Slice 3** — the old `WorkspaceView`
reads `positions` and cannot compile against the new store, and an adapter shim
would be wasted work.

- **Persistence:** `workspace:layout:v2:{userId}` holding `{columns, appearance}`,
  reusing the current debounced `scheduleWrite` shape (200ms) and the defensive
  parse-and-validate read; `workspace:regimented:{userId}` as a bare boolean.
- **v1 migration** (§VIII): on hydrate, if the v2 key is absent and
  `workspace:layout:{userId}` exists, lift per-feed `brightness`/`density`/
  `orientation`/`textSize` into the appearance record (running the existing
  `normalizeBrightness`/`normalizeDensity` retirement maps), discard
  `x/y/w/h/hidden/minimized`, delete the v1 key. Feeds arriving with appearance
  but no slot are placed by the bootstrap reconcile below. Unit-test against
  fixture v1 blobs (5a-, 5b-, 5c-era shapes all still occur in the wild).
- **Actions:** `hydrate`; `applyDrop`/`insertFeed`/`removeFeed`/`resizeSlot`
  delegating to the layout module; the four appearance setters (same call
  signatures `WorkspaceView` and `FeedComposer` use today, now writing the
  appearance record — the server-reconcile contract of §III.1 is the caller's,
  unchanged); `reconcileFeeds(liveIds, visibleIds)` — prune slots whose feed the
  server no longer returns *or* has hidden, append missing visible feeds via
  `insertFeed` in list order (there is no heal: illegal states are
  unrepresentable); `setRegimented`; `materializeRegimented(vp)` (§V's
  edit-while-regimented: stamp the derived regimented arrangement as the custom
  layout, for the caller to then apply its one edit); `reset`.
- Deleted with the rewrite: `clearLegacyHidden` and its bootstrap sweep call
  site in `WorkspaceView` (the pre-migration-113 hide push-up), `removeVessel`
  (subsumed by `removeFeed`), `healRestingOverlaps`.

### Slice 3 — the floor

`WorkspaceView.tsx` + `Vessel.tsx` rewired to derived geometry; the §IX deletions
land here except the lens (see ordering note).

- **Geometry replaces the canvas.** `const geom = useMemo(() =>
  deriveGeometry(layout, {w: viewport.w, h: viewport.h, navRowH: 0}), …)`. The
  canvas div sizes to `geom.floorWidth` (+ `offsetX` centring); vessels position
  absolutely from `geom.rects`. Gone: `computeExtent`/`EDGE_PAD`, the
  `floorGesture`/`canvasSlack` state, the origin-compensation layout effects in
  `WorkspaceView` and the `originX` effect + `onFloorGesture` plumbing in
  `Vessel` — there is no origin, so there is nothing to compensate. The Vessel's
  existing spring-to-position effect survives as the slot-change settle
  animation.
- **Drag.** Framer still lifts the vessel (transient raised z, free transform);
  the slot underneath is held open (§IV.1), so the layout and geometry are
  *stable for the whole gesture*. Per `onDragFrame`, `WorkspaceView` converts
  the viewport pointer to floor space (floor `getBoundingClientRect()` +
  `scrollLeft`) and runs `resolveDrop`: a `merge` arms the target (existing
  `armed` prop + outline), an insertion renders the GRID-wide highlight stripe
  (a positioned div on the canvas, 8px — no hairline concern). `onDragEnd`
  commits: merge → `setPendingMerge` (dialog flow unchanged); insertion →
  `applyDrop`. **The declined-merge path needs no settle at all** — the source
  never left the layout, so `MergeFeedConfirm.onClose` just clears
  `pendingMerge` and the vessel springs home; `settleAfterAbandonedMerge` is
  deleted rather than replaced. Confirm → server `merge` then `removeFeed`.
- **Auto-pan.** An rAF loop while dragging: pointer within `AUTOPAN_MARGIN` of
  the floor's left/right edge scrolls `floor.scrollLeft` at speed ∝ proximity;
  the per-frame resolver naturally reads against the moved geometry.
- **Resize.** The Vessel's handle machinery survives; `clampResize` is
  re-backed by `resizeSlot`'s clamps (w free, h to the stack remainder) instead
  of `clampSizeClear`. Live column-slide (§IV.3) needs the proposal visible to
  the derivation mid-gesture: a new `onResizeFrame(size)` feeds a transient
  override map merged into the `deriveGeometry` input, so columns rightward
  slide with the handle; commit writes the store and drops the override.
- **System placements** all become `insertFeed`: `adoptFeed` (drop the
  `defaultGridSlot` + `findRestingPosition` block), the bootstrap
  missing-layout loop (dropped wholesale — `reconcileFeeds` owns it), unhide
  (`handleRestoreHiddenFeed` loses its resolver call; hide/unhide map to
  `removeFeed`/`insertFeed` around the existing server PATCH), delete and merge
  (already routed through `removeFeed`).
- **Untouched:** the mobile branch (`renderFeedContents` shared; appearance
  reads move from `positions[id].*` to `appearance[id].*`, as do the
  `FeedComposer` prop wirings), the Ctrl+←/→ handler (reads
  `scrollWidth`/`clientWidth` — still correct), Slice 0's virtualization
  (visibility now reads `geom.rects`, simpler than before), `itemKey`/data
  loading/expansion state.
- **Ordering note — the lens survives this slice.** The floating disc still
  blends until Slice 4, so the canvas keeps `isolation: "isolate"` and vessels
  keep `LIGHT_ISLAND_STYLE`; only Slice 4 may remove them.
- **Deletions taken here:** `lib/workspace/collision.ts` + `collision.test.ts`,
  `lib/workspace/canvas.ts`; `grid.ts` shrinks to `GRID`/`snap` + the min/max
  size constants still referenced (`VESSEL_DEFAULT_W` dies with the default-slot
  logic).

### Slice 4 — nav row + lens removal + Explain re-anchor (§VI)

- **The row.** New `components/workspace/NavRow.tsx` exporting `NAV_ROW_H`:
  `position: fixed`, bottom, full width, `zIndex: 58`, mode-aware neutral chrome
  (`var(--ah-ink)`-family tokens that invert with `html.dark` — the row is
  global chrome, not a feed island), 4px slab on its top edge. It renders the
  wordmark (absorbing `ForallMenu`'s separate fixed wordmark layer) and docks
  the ∀. `ForallMenu` gains a third anchor, `"row"`, alongside
  `"floating"`/`"bar"`: container fixed within the row's right end, menu/search
  opening upward (`bottom: NAV_ROW_H + gap`, mirroring the floating branch's
  `bottom: discSize + 18`). The mobile `"bar"` branch is untouched.
- **Lens deletion.** In `ForallMenu.tsx`: the `lensMode` derivation and every
  branch it feeds (the `mixBlendMode: "difference"` styles on the container and
  wordmark, the hoisting comments, the painted/punched swap logic — the punched
  `ForAllMark` construction itself is retained as the row's idle glyph, minus
  the blend). Delete `stores/lensSuppress.ts` and its `useLensSuppressor` calls
  in `NewFeedPrompt.tsx` and `LightboxOverlay.tsx`; the `body { isolation }`
  block in `globals.css`; the canvas `isolation: "isolate"` in `WorkspaceView`
  (held over from Slice 3). Vessels keep `LIGHT_ISLAND_STYLE` — that serves the
  per-feed colourway derivation (§Global light/dark), not the lens.
- **Floor height.** `deriveGeometry`'s `navRowH` goes live (`NAV_ROW_H`); the
  Slice 1 degradation policy absorbs stored fixed heights that no longer fit.
- **Glasshouse inset.** In `Glasshouse.tsx::usePanePlacement`, the desktop path
  subtracts `NAV_ROW_H` wherever it reads `vp.vh` (the `maxHeight` derivation,
  the drag clamp, the resize clamp, the initial snap-centre) — the mirror of the
  `fullScreen` branch's `MOBILE_BAR_H` inset. The row at z-58 sits above scrim
  (55) and pane (56) by construction.
- **Explain.** The `disc` explainable root already tracks `buttonRef`, which
  moves with the button into the row — leader/anchor geometry re-derives from
  the live rect. Re-point the D3 chrome-swap (the floor-mode wordmark → About
  button swap) at the row's wordmark slot. Verify the z band table in
  `ExplainOverlay.tsx` (floor scrim 50 / highlight 57 / cursor bubble 58 / chrome
  60): the bubble ties the row at 58 — bump the bubble to 59 so it never renders
  under the opaque row.
- **Docs, same commits:** the §IX obligations — CLAUDE.md's infinite-floor and
  lens sections, FORALL-CUT-AND-LOCKUP-ADR and WORKSPACE-DESIGN-SPEC status
  notes, the NDK correction.

### Slice 5 — regimented hotkey (§V)

- **Binding.** A `keydown` effect beside the existing ⌘K handler in
  `WorkspaceView` (desktop only): plain `\`, no modifier. Guard list, all
  already at hand in that scope: editable-focus (`closest('input, textarea,
  select, [contenteditable…]')`, the Ctrl+←/→ handler's exact probe),
  `useGlasshousePresence.getState().isOpen`, `useExplain.getState().isActive`,
  the lightbox store, and the local non-Glasshouse surfaces (`newFeedOpen`,
  `pendingMerge`, `pipPanel`, `feedComposerFor`, `composerOpen`, `bringWorld`,
  `ceremony`) — with `lensSuppress` gone (Slice 4) there is no generic
  "transient modal open" registry, and these are all local state anyway.
- **Rendering.** When `regimented`, the geometry input is
  `regimentedLayout(visibleSorted, vp)` instead of the stored layout — a view,
  not an edit; the stored layout and the v2 key are untouched. Gestures stay
  live; a layout **mutation** (`applyDrop`, `resizeSlot` commit) calls
  `materializeRegimented` first, then applies, then clears `regimented` —
  appearance changes apply in place without exiting.
- **Persistence:** the `workspace:regimented:{userId}` boolean, read at hydrate.

## XI. Decided by default (flag to reopen)

Nearest-slot distance is measured from the pointer at release, not the vessel's
centre. Slots narrower than their column left-align. Unhide re-enters at the right
end rather than remembering its old slot. The regimented hotkey is `\`. The
merge/insert edge band is ~48px and the auto-pan margin ~48px, both tuned by eye.
Column ids come from `crypto.randomUUID()` (no ULID dependency exists in `web/`
and nothing orders by id). The three-band wall/buffer/wall stripe (§II.3) fully
reads only for vertical-orientation vessels — a horizontal ⊏ has no right wall
and stack seams meet a VesselBar; accepted as-is.

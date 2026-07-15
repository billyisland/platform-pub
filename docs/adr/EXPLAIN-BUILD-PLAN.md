# Build Plan: First-Run Onboarding & the Explain Engine

**Companion to** `docs/adr/EXPLAIN-ADR.md` (the ADR is the source of truth for behaviour and copy; this file is the implementation scope).
**Scope:** `/reader` (`WorkspaceView`) **desktop only** — `MobileWorkspace` is explicitly out (ADR §Surface). The engine must not mount on the mobile branch.
**Status:** COMPLETE — all seven slices shipped (2026-07-14/15). The engine is live: Explain runs from the ∀-menu row, and first-run auto-runs once per user per device. Copy verified verbatim against Appendix A. The one follow-up noted at slice 7 — the Explain `disc` label being unreachable in the Explain program — is now fixed (the About button reveals it on hover). All "current state" line references below were verified against the codebase (see §0).

---

## 0. Verification deltas (what differs from the ADR's stated state)

The ADR's decisions are sound; three factual corrections change the surface area:

1. **`ForallMenu` path.** It lives at `web/src/components/workspace/ForallMenu.tsx`, **not** `components/layout/` (ADR §2, §8 cite the wrong dir).
2. **The ceremony is dead code today.** `setCeremony(...)` is commented out (`WorkspaceView.tsx:928-935`, responsive path `742`); only `BringYourWorld` fires on first login (`951`). The `ForallCeremony` render (`1556-1580`) is unreachable via any live path. Consequence: D6 gate (b) ("ceremony not pending/playing") is trivially satisfied today. First-run should still **subscribe defensively** to the ceremony signal, because the re-enable is deferred, not cancelled — don't hard-code "no ceremony".
3. **`from_starter` touches 6 backend sites, not 3.** There are five `FeedRow`-typed queries (crud.ts `192`, `213`, `292`, `350`; shared.ts `loadFeed` `38`) plus the type + mapper. The ADR's "192, 292, 350" missed the `INSERT … RETURNING` at `crud.ts:213` (needs a literal `false AS from_starter`, not the `EXISTS` subquery — a new feed is never a clone) and `loadFeed`.

Verified **exact**: z-bands (Glasshouse scrim `z-[55]`/pane `z-[56]`, `Glasshouse.tsx:506,509`; ForallMenu chrome `zIndex:60`, `402/435-436`); presence registry (`stores/glasshouse.ts:20-24`, `isOpen`+`close`+internal `_set`); `onDragFrame` (`Vessel.tsx:87,385`); frozen floor (`overflow:hidden`, `WorkspaceView.tsx:1607`); `useAuthorHover` (in `components/feed/AuthorModal.tsx:544`, 300ms open debounce; also consumed by `FeedComposer.tsx:1282`); `WorkspaceFeed` reaches every vessel as `vessel.feed.fromStarter` via `VesselState` (`WorkspaceView.tsx:184-185`) with no plumbing.

---

## 1. New files (frontend)

| File | Responsibility | ADR ref |
|---|---|---|
| `web/src/lib/explain/registry.ts` | `ExplainKind` union (12 kinds); Appendix A copy as data; derived-ordering fn (`floor → per-vessel by sort_rank → card kinds → disc`); provenance-fork copy selector | §4, App. A, D5, D7 |
| `web/src/stores/explain.ts` | Zustand store per overlay-store conventions. `isActive/program/annotations/index/hover` + `open/next/prev/pin/setHover/close`. **No history push** (ephemeral chrome) | D12 |
| `web/src/components/workspace/ExplainProvider.tsx` | React context holding the registration `Map<key, {kind, ref, order?, params?}>`; exports `useExplainable(kind, opts)` for root registration (live refs survive drag/reorder/mount churn) | D4, §8 |
| `web/src/components/workspace/ExplainOverlay.tsx` | The whole visible layer: z-50 scrim (flat wash ≤0.18 alpha, **no** `backdrop-filter`), pointer routing (`pointermove`/click on the single full-viewport catcher), hit-test via registration rects + `document.elementsFromPoint` → `closest('[data-explain]')`, bubble + leader renderer, `getBoundingClientRect` measurement + `ResizeObserver` invalidation, drag suspension, reduced-motion path | D1, D9, D11 |

Keep the bubble/leader as a sub-component inside `ExplainOverlay.tsx` unless it grows — no need to pre-split.

---

## 2. Modified files

### Frontend — engine wiring

- **`web/src/components/workspace/WorkspaceView.tsx`**
  - Wrap the desktop `Floor` (`1599-1612`) in `<ExplainProvider>`.
  - Mount `<ExplainOverlay>` alongside the other overlays (`1581-1587`).
  - Add the **D6 entry effect** (extend the bootstrap effect at `917-952`): subscribe to ceremony completion (or its seen-flag pre-set), gate on `workspace:firstrun_seen:<userId>` unset + `!bringWorld` + ≥1 vessel rendered; wait ≤4s for a card with a linked byline (beat-3 readiness) then run anyway free-floating; write the seen-flag **on open** (`localStorage["workspace:firstrun_seen:"+user.id]="true"`), following the existing `CEREMONY_SEEN_PREFIX`/`BRING_WORLD_SEEN_PREFIX` namespace (`110/116`).
  - **Guard the mobile branch:** provider + overlay + entry effect mount only on the desktop path, never under `MobileWorkspace`.

- **`web/src/components/workspace/Vessel.tsx`** — `useExplainable("vessel", { feedId, order: sortRank, params: { feedName, fromStarter } })` on the vessel root; `data-explain="vessel.resize"` on the resize handle (`521-552`).

- **`web/src/components/workspace/VesselBar.tsx`** — `data-explain` on the four leaves: `vessel.name`, `vessel.gear`, `vessel.hide`, `vessel.addSource`.

- **Post components** (`web/src/components/post/`) — `data-explain="card"` on the `PostCardInteractive` chassis; `card.byline` in `PostByline.tsx`; `card.reply` + `card.quote` in `PostActions.tsx`. (Card kinds contribute **one** representative sequential annotation, anchored to the topmost fully-visible card in the lowest-`sort_rank` vessel with cards — D5 — but every instance stays hover-discoverable.)

- **`web/src/components/workspace/ForallMenu.tsx`**
  - New **Explain row** in its own group (single primary option, keep the menu slim) → `useExplain.getState().open({ kind: "explain" })`.
  - **Disable rule (D10):** dim + `title="close this pane to use Explain"` when `useGlasshousePresence` `isOpen`.
  - **Chrome swap (D3):** while `isActive`, swap the disc + wordmark (`380-422`, `485-676`) for an **"About all.haus"** button at the same z-60 layer; the button opens `/about` as a standard Glasshouse pane. Suppress the swapped chrome while the About pane is open (pane owns its own dismiss), restore on close. The draft's "re-select the ∀ row to toggle off" gesture does not exist.

- **`web/src/components/feed/AuthorModal.tsx`** (`useAuthorHover`, `544`) — **D2 guard:** early-return (and close-if-already-open) when `useExplain.getState().isActive`. One edit covers both the `PostByline` and `FeedComposer` (`1282`) consumers.

### Backend — the `from_starter` wire (self-contained, ships alone)

No new column, **no migration, no `schema.sql` regen** — `feeds.cloned_from_feed_id` + `feeds.is_starter_template` already exist (`schema.sql:1346-1347`; FK `6015-6019`). Semantics per D7: **`EXISTS` subquery** (stricter than `IS NOT NULL` — survives a renamed/deleted/un-flagged template).

- **`gateway/src/routes/feeds/shared.ts`**
  - `from_starter: boolean;` on `FeedRow` (`10-19`).
  - `fromStarter: row.from_starter` in `feedRowToResponse` (`21-32`).
  - Add to the `loadFeed` SELECT (`38`, `f.` alias):
    ```sql
    EXISTS (SELECT 1 FROM feeds t
            WHERE t.id = f.cloned_from_feed_id AND t.is_starter_template) AS from_starter
    ```

- **`gateway/src/routes/feeds/crud.ts`**
  - `listFeedsForOwner` SELECT (`192`, `f.` alias) — add the `EXISTS(... f.cloned_from_feed_id ...) AS from_starter` above.
  - PATCH `/feeds/:id` UPDATE…RETURNING (`292`) — same, but the correlated column is **`feeds.cloned_from_feed_id`** (no `f.` alias in this statement).
  - PUT `/feeds/order` re-list SELECT (`350`, `f.` alias) — same as `listFeedsForOwner`.
  - `createFeedForOwner` INSERT…RETURNING (`213`) — append literal **`false AS from_starter`** (a freshly created feed has no `cloned_from_feed_id`; the `EXISTS` subquery shape doesn't fit an INSERT).
  - **No `bootstrap.ts` change** — it delegates to `listFeedsForOwner` + `feedRowToResponse` and inherits `fromStarter` for free.

- **`web/src/lib/api/feeds.ts`** — `fromStarter: boolean;` on `WorkspaceFeed` (`7-27`). Flows to `vessel.feed.fromStarter` via `VesselState` with no further plumbing.

---

## 3. Build order (shippable slices, maps to ADR §9)

1. **Backend `from_starter` slice** — ✅ **SHIPPED 2026-07-14.** `shared.ts` (FeedRow type + `feedRowToResponse` + `loadFeed` SELECT), `crud.ts` (list/order `EXISTS`, PATCH `EXISTS` on `feeds.` alias, INSERT literal `false`), web `WorkspaceFeed.fromStarter` (kept **required** per D7 — no test fixtures construct `WorkspaceFeed` literals, so nothing broke). Gateway + web `tsc` clean; the `EXISTS` expression verified both branches against dev DB in a rolled-back txn (template→false, clone-of-template→true, hand-created→false).
2. **Registry + Provider + `useExplainable` + `data-explain` tagging** — ✅ **SHIPPED 2026-07-15.** New `web/src/lib/explain/registry.ts` (12-kind union, Appendix-A copy as data, provenance-fork selectors, `buildExplainSequence`) + `web/src/components/workspace/ExplainProvider.tsx` (context Map of roots + `useExplainable`, remount-race-guarded, inert outside a provider). `WorkspaceView` wraps the desktop floor in `<ExplainProvider>`, threads `sortRank`/`fromStarter` into `Vessel`; `Floor` registers `floor`, `Vessel` registers `vessel` + tags `vessel.name`/`vessel.resize`, `VesselBar` tags `vessel.gear`/`vessel.hide`/`vessel.addSource`, the post components tag `card`/`card.byline`/`card.reply`/`card.quote`. No visible UI (nothing reads the Map yet). `tsc` + eslint (0 err) + hairlines + `next build` clean. **Note:** `disc` root registration is deferred to slice 5 — the `disc` annotation anchors to the About button (D3), which only exists during a program (the chrome swap), so its registration lands with that swap, not here.
3. **Store + scrim + pointer routing + hit-testing** with a stub bubble (§9.2 / D1, D12). — ✅ **SHIPPED 2026-07-15.** New `web/src/stores/explain.ts` (the D12 state machine: `isActive`/`program`/`annotations`/`index`/`hover` + `open`/`next`/`prev`/`pin`/`setHover`/`close`; DOM-free — `open` takes a resolved `Program`; `pin` mints an on-the-fly annotation for a hover-only non-representative card, D5) + `web/src/components/workspace/ExplainOverlay.tsx` (z-50 flat wash `rgb(var(--ah-true-black-rgb)/0.14)`, no backdrop-filter per D9; single full-viewport catcher freezes the floor per D1; `pointermove`→live hit-test→hover, click→pin-or-dismiss; hit-test resolves leaf > vessel > floor via `elementsFromPoint`+`closest('[data-explain]')` and registry-root identity, skipping own chrome via `data-explain-chrome`; hover copy folds the vessel provenance fork off registry params, D7). `WorkspaceView` mounts `<ExplainOverlay />` **desktop-only** (`!isMobile`, build-plan §2 mobile guard). Bubble is a STUB (positioned box, crude clamp) — real placement/leader/measurement/drag-suspension/reduced-motion is slice 4 (D11). Nothing opens a program yet (∀-menu row is slice 5), so inert in production. `tsc` + eslint (0 err) + hairlines + `next build` clean.
4. **Bubble renderer** — ✅ **SHIPPED 2026-07-15.** `ExplainOverlay.tsx` replaces the stub with the real `Bubble`: two-pass self-measure (`useLayoutEffect` size → `placeBubble`) picking the side with most free room (right→left→below→above, else max-free), clamped to the viewport with a `MARGIN`; a 2px crimson leader (`<line>` stroke via `style` per the SVG-var rule) from the target facing-edge midpoint to the bubble near-edge midpoint + a 4px dot (`<circle r=2>`) at the target end; free-float centred with no leader for `alwaysFloat` beats or a deregistered target (D8); live `getBoundingClientRect` re-read every render, invalidated by a `measureTick` bumped from a `ResizeObserver` on the floor root + (while pinned) the pinned target's `[data-vessel-scroll]` container (new marker on `Vessel.tsx`) + window-resize — **no scroll trigger** (frozen floor, D1); drag suspension via a new `explain` store `draggingFeedId` seam wired to `WorkspaceView`'s vessel drag start/end (pinned hidden, hover suppressed — **inert under the frozen scrim in v1**, complete for the v2 pointer-forwarding path); reduced-motion path (`prefersReducedMotion` → static leader, opacity-only enter, no `stroke-dashoffset` draw / transition). `tsc` + eslint (0 err) + hairlines + `next build` clean. Nothing opens a program yet (∀-menu row is slice 5), so still inert in production.
5. **Explain program** — ✅ **SHIPPED 2026-07-15.** `ExplainProvider` gains `resolveExplainProgram` + `useOpenExplain()` (program built at open() from the live registry: floor → per-vessel by sort_rank → one representative card kind each, D5-gated on any vessel having cards → disc; copy resolved with the `vessel` provenance fork off `fromStarter`, D7). `ExplainOverlay.elementFor` anchors each card representative to the topmost leaf in the **lowest-sort_rank** vessel that has it (D5), plus a capture-phase Esc handler with the D12 precedence (early-return while the About pane is open; else close Explain + stopPropagation). `ForallMenu` adds the **Explain row** (own group, desktop-only, disabled + title + inert-on-select while any Glasshouse is open, D10) → `useOpenExplain()`, and the **D3 chrome swap** (disc + wordmark → an islanded "About all.haus" button at z-60, registered as the `disc` explainable root — the deferred slice-2 registration, since the disc annotation anchors to the About button; button opens `/about` via new `useAboutOverlay` + `AboutOverlay.tsx`, a standard Glasshouse over `AboutContent`; swapped chrome suppressed while About open via the presence registry, restored on close). **D2** hover guard on `useAuthorHover` (`AuthorModal.tsx`): `onMouseEnter` early-returns while active, an open modal closes on activation. `AboutOverlay` mounts desktop-only alongside `ExplainOverlay`. `tsc` + eslint (0 err) + hairlines + `next build` clean. **The engine is now live in production** (the ∀-menu Explain row opens it).
6. **First-run program** — ✅ **SHIPPED 2026-07-15.** `ExplainProvider` gains `resolveFirstRunProgram` (six `firstRunBeats` resolved from the live registry: beats 1-2 anchor to the lowest-sort_rank vessel, its `fromStarter` driving the beat-1 provenance fork D7; beats 5-6 free-float, beat 6 `done`), `useOpenFirstRun()`, and a headless `FirstRunController` running the D6 gate (seen-flag unset + ≥1 vessel + ≤4s `card.byline` wait then run-anyway; never over an open Glasshouse; seen-flag written on open). `WorkspaceView` mounts it desktop-only, `armed` on `bootstrap ready && !ceremony && !bringWorld`. `ExplainOverlay` adds the pinned-bubble stepping footer (label-ui "N / M" + btn-text Back/Next → Done on the done beat, `pointerEvents:auto`) and ArrowLeft/Right stepping (first-run only). Explain untouched (footer gated on `program.kind === "firstrun"`). Verified end-to-end in a browser: auto-fire on fresh load, vessel-anchored beat 1 + chrome swap, Back/Next/Arrow stepping, free-floating beat 6 with Done, Done-closes + ∀ restored, no refire on reload. `tsc` + eslint (0 err) + hairlines + `next build` clean.
7. **On-screen copy pass** — ✅ **SHIPPED 2026-07-15.** Verified all copy is verbatim against Appendix A (no code change needed — it was entered as data in slice 2). Programmatic diff: all **20** copy strings (7 first-run beats + 9 Tier-1 labels + 4 Tier-2 labels) match Appendix A byte-for-byte in **both** directions, and **no em/en dashes** appear in any copy string (only in code comments). On-screen render confirmed in a browser for the first-run beats (1 + 6, incl. the beat-6 `\n\n` paragraph break) and the Explain labels `floor` / `vessel.gear` / `card.byline` / `vessel.addSource`. **Follow-up (was a slice-5 gap, now FIXED 2026-07-15):** the `disc` label — last in the Explain sequence, byte-verbatim incl. the `∀` glyph — was initially **not surface-able in the Explain program** (the "About all.haus" button sits at z-60 above the scrim, so `pointermove` never hits the scrim there, clicking opens About not a pin, and Explain has no stepper). Resolved by wiring the About button's own `onMouseEnter`/`onMouseLeave` to set/clear the Explain hover to `{kind:"disc"}` (2 lines in `ForallMenu.tsx`); the overlay's existing hover renderer anchors the bubble to the button's registered `disc` ref. Honours Explain's "hover anything, read its label" model without a document-level listener or a stepper, and leaves D1's frozen floor intact (the button was already the sanctioned live control; click opens About, hover teaches). Verified in a browser: hover surfaces the label verbatim incl. `∀`, floor bubble dims, clears on leave. See FIX-PROGRAMME.

Slices 1 and 2 are safe to land independently ahead of the engine.

---

## 4. Decisions to settle before coding

1. **`fromStarter` required vs optional.** The ADR specifies required (`fromStarter: boolean`). Required will break any test/mock `WorkspaceFeed` literals — **grep test fixtures first**. Optional (`fromStarter?: boolean`, treat `undefined` as false) is lower-blast-radius but risks a silent mis-fork on a real feed. **Recommendation: keep required, fix fixtures.**
2. **Ceremony coupling (D6).** Confirm v1 intent: first-run runs on first login gated only by `BringYourWorld` (ceremony is dark), but still subscribes to the ceremony signal for the deferred re-enable. Matches the ADR — noted because the live code path differs from the ADR's narration.
3. **`EXISTS` semantics** — already decided (D7); recorded here because the simpler `IS NOT NULL` is tempting and would silently mis-classify an edited/deleted template.

---

## 5. De-risking notes

- **Frozen floor holds.** `WorkspaceView.tsx:1607` `overflow:hidden` with internal-scrolling vessels is verified — so D1's "scrim swallows wheel/touch, no live scroll re-measure" and D4/D11's "annotate the surface as it stands at `open()`" are correct as written. This is the single biggest simplification; do not add a `scroll` trigger.
- **`vessel.feed.fromStarter` needs zero plumbing** — the whole `WorkspaceFeed` already travels into `VesselState`, so the provenance fork (D7) reads straight off the anchored vessel.
- **One `useAuthorHover` guard** covers every native-hover surface (both consumers route through `AuthorModal.tsx`).

---

## 6. Rough size

~4 new frontend files, ~7 modified frontend files, 3 backend edits + 1 web type. The backend slice and the tagging slice are each landable and verifiable on their own; the engine (slices 3–6) is the bulk of the work.

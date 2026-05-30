# Feed / Vessel change requests — build plan

**Status (2026-05-30).** Batch 1 shipped — tasks **2, 3, 4, 6, 7** implemented and
typecheck-clean (`web` `tsc --noEmit`). Remaining: task **5** (media expansion), task **1**
(external pip → author modal, needs the AuthorModal click-vs-hover refactor flagged in
evaluation), and tasks **8 + 9** (text-size plumbing + typography unification, the latter
pending the playscript-byline design-rule reconciliation). Per-task completion notes are
inline below.

Scope: the **workspace vessel system** only (`web/src/components/workspace/*`). The
single-column `/feed` page (`web/src/components/feed/FeedView.tsx`) is being retired and
is **out of scope** — but two of its components (`AuthorModal`, `useAuthorCard`) are
reused below.

Nine tasks, ordered roughly by independence. Each lists the root cause (file + the
mechanism, not just symptoms), the change, and acceptance criteria. Tasks 8 and 9
introduce a shared per-feed **text size** concept; do them after the rest or in their own
commit, as they touch the most files.

---

## 1. Make the trust pip clickable on external cards (author bio)

**Current behaviour.** On native note/article cards the byline pip is a `PipTrigger`
(`web/src/components/workspace/PipTrigger.tsx`) → `onPipOpen` → `setPipPanel` →
`<PipPanel>` in `WorkspaceView`. This works today. On **external** cards
(`ExternalVesselCard` in `VesselCard.tsx`) the pip is a bare `<TrustPip>` with no trigger —
inert by design, because the trust route keys on a platform user id that external authors
lack. That is the pip the screenshot exercises, so it "does nothing".

**Change.** Wire the external pip to the existing minimal author-bio modal rather than the
trust panel.

- The endpoint `/api/v1/author-card?type=external&id={externalItemId}` already returns
  `{ displayName, handle, avatarUrl, bio, follower/following/postCount, sourceName,
  followTarget, … }`. `resolveExternalAuthor` in `gateway/src/routes/author-card.ts` keys
  on `external_items.id`, so pass **`external.id`** (the item id), not the source id.
- `web/src/components/feed/AuthorModal.tsx` already renders this. Props:
  `{ type, id, anchorRef, onClose }` — it portals and self-positions against `anchorRef`;
  presence === open. Reference usage: `feed/ExternalCard.tsx` (which drives it via
  `useAuthorHover`; ignore the hover hook here — see note).
- In `ExternalVesselCard`: add `const pipRef = useRef<HTMLButtonElement>(null)` and
  `const [authorOpen, setAuthorOpen] = useState(false)`. Replace the bare-pip
  `pipNodeByline` with a `<button ref={pipRef}>` wrapping `<TrustPip>` (same inline /
  no-border styling as `PipTrigger`) whose `onClick` does `e.stopPropagation()` then
  `setAuthorOpen(v => !v)`. Render
  `{authorOpen && <AuthorModal type="external" id={external.id} anchorRef={pipRef}
  onClose={() => setAuthorOpen(false)} />}`.
- Verify `AuthorModal` closes on Escape / outside-click; if it does not (it was previously
  driven by a hover controller), add an Escape + outside-pointerdown listener that calls
  `onClose`.

**Defer:** hover-to-open. Click only for now. (Original CR1 hover behaviour parked.)

**Acceptance.** Clicking the pip on a Bluesky/Mastodon/RSS card opens a small bio popover
anchored to the pip; clicking elsewhere / Escape closes it. Native note/article pips are
unchanged (still open `PipPanel`). Pip click never triggers the card-expand handler.

---

## 2. Stop consolidating consecutive same-author posts into one card — ✅ DONE

> **Done.** `ParentContextTile` gained an optional `selfAuthor?: { handle?; name? }`; after
> it fetches the parent it `return null`s on a handle match (or a case-insensitive name match
> when neither side has a handle). `ExternalVesselCard` passes `external.authorHandle/Name`;
> `NoteVesselCard` passes `{ name }`. `ReplyGroupCard`'s tile and all cross-author context are
> untouched. Note: for the note→external case the parent always carries a handle while the
> native note author does not, so name-fallback suppression is effectively inert there (safe
> default: show context) — the dominant external self-thread case is fully handled.

**Current behaviour.** When a post is a reply, the card renders `ParentContextTile`
(`web/src/components/workspace/ParentContextTile.tsx`) inline above the body: a grey mono
parent byline (`NAME · time`), the parent's text, and a **bottom hairline**
(`borderBottom: 1px solid …33`). In a self-thread (e.g. Jonn Elledge replying to his own
post) the parent and child are the same author, so the two posts read as a single merged
card divided by a hairline — exactly the screenshot.

The parent post also exists as its **own** feed item (it is not folded in by
`groupReplies`, which only clusters distinct replies sharing one parent). So the inline
parent is redundant for self-threads.

**Change.** Suppress `ParentContextTile` when the parent author is the same as the card
author, so each post stands alone.

- Add an optional prop to `ParentContextTile`: `selfAuthor?: { handle?: string; name?: string }`.
- After it fetches the parent, if `selfAuthor` is set and matches the parent
  (`parent.authorHandle === selfAuthor.handle`, falling back to a case-insensitive
  `authorName` match when handles are absent), `return null`.
- Pass `selfAuthor` from the call sites:
  - `ExternalVesselCard`: `selfAuthor={{ handle: external.authorHandle ?? undefined,
    name: external.authorName ?? undefined }}`.
  - `NoteVesselCard` (the `note.externalParentId` tile): pass the note's resolved author
    name; handle may be unavailable, so name-match is the fallback.
- Leave `ReplyGroupCard`'s parent tile and all **cross-author** reply context unchanged —
  showing what a post replies to is still wanted; only same-author consolidation goes.

**Acceptance.** A self-thread renders as N separate cards, each with its own full byline,
no inline parent, no hairline between bodies. A reply to a *different* author still shows
the parent-context tile as before.

---

## 3. Restore inter-card gap inside a vessel — ✅ DONE

> **Done.** Moved `display/flexDirection/gap` off the scroll body onto a new flex `<div>`
> that wraps `{children}` *inside* `PullToRefresh` (and on the non-`onRefresh` branch). The
> scroll body keeps padding + overflow + its `flex: 1 1 0` item-sizing. `GAP` left at 12.

**Current behaviour.** `Vessel.tsx`'s scroll body sets `display:flex; gap:12px`
(`GAP = 12`), but its only direct flex child is the `<PullToRefresh>` wrapper — the actual
cards live *inside* that wrapper as plain block siblings, so the 12px gap applies to
nothing. Result: cards butt together as one ribbon.

**Change.** Put the gap on the element that actually contains the cards.

- In `Vessel.tsx`, wrap `{children}` in a flex container *inside* `PullToRefresh` and move
  the `flexDirection` / `gap` there; keep the outer scroll body as the scroll/overflow
  container only:

  ```tsx
  <PullToRefresh onRefresh={onRefresh} scrollRef={scrollBodyRef}>
    <div style={{
      display: "flex",
      flexDirection: isHorizontal ? "row" : "column",
      gap: `${GAP}px`,
    }}>
      {children}
    </div>
  </PullToRefresh>
  ```

  Apply the same wrapper on the non-`onRefresh` branch. Remove `display/flexDirection/gap`
  from the outer scroll-body style (leave padding + overflow).
- Keep `GAP = 12`. (You said the current value is fine once it actually applies; if it
  reads heavy after task 2 separates the cards, drop to 8 — single constant.)

**Acceptance.** Cards in a vessel have a clear, even gap between them, vertically and
(in horizontal orientation) horizontally; pull-to-refresh still works.

---

## 4. Collapse expanded conversations on refresh — ✅ DONE

> **Done.** `loadVesselItems` now, before reloading, reads the vessel's current items from
> `vesselsRef.current`, collects every expand key (`id` **and** `feedItemId` where present),
> and filters both `expandedCards`/`expandedThreads` (no-op identity return when nothing
> changes). `refreshAll` clears both sets entirely. Initial-bootstrap loads are a no-op
> because the vessel has no ready items yet.

**Current behaviour.** `loadVesselItems(feed)` (the refresh path, `WorkspaceView.tsx`)
reloads items but never touches `expandedCards` / `expandedThreads`, so expanded
conversational context survives a refresh.

**Change.** When a vessel refreshes, collapse the conversations belonging to it.

- In `loadVesselItems`, after the new items land, remove that vessel's item keys from both
  sets. Compute keys from the vessel's items (both `id` and `feedItemId` where present,
  matching the `expandKey` logic used in the render loop), then
  `setExpandedCards(prev => …filtered)` and `setExpandedThreads(prev => …filtered)`.
- In `refreshAll`, clear both sets entirely (it refreshes every vessel).

**Acceptance.** Expanding a card's conversation then refreshing that feed (pull-to-refresh
or `refreshAll`) returns every card to collapsed.

---

## 5. Expanding a card expands its media to full dimensions

**Current behaviour.** `MediaBlock` (`VesselCard.tsx`) always renders the hero in a fixed
`aspectRatio: 16/9` box with `objectFit: cover` (cropped). Its `expanded` prop currently
only affects oEmbed iframes. Worse, `expanded` is passed to `MediaBlock` **only** from the
external card — `NoteVesselCard` and `ArticleVesselCard` call `<MediaBlock … />` without
it.

**Change.**
- Pass `expanded` into `MediaBlock` from `NoteVesselCard` and `ArticleVesselCard`
  (they already receive `expanded`).
- In `MediaBlock`, when `expanded` is true, render the hero image/video at natural
  dimensions bounded by the container width instead of the cropped 16:9 box:
  - drop `aspectRatio` and `objectFit: cover`;
  - `<img>` / thumbnail: `width: 100%; height: auto; maxWidth: 100%; display: block;`
    (the card already spans the vessel interior width minus padding, so 100% === the
    container-derived max width you asked for);
  - keep the cropped 16:9 treatment for the collapsed state.
- The `+N` overflow pill currently hides extra media. Optional but in the spirit of the
  request: when `expanded`, render the additional image/video items stacked below the hero
  (each full-width, natural ratio) and drop the pill. If you skip this, leave the pill.

**Acceptance.** Collapsed cards keep the neat 16:9 thumbnail; expanding a card shows its
image/video at true aspect ratio, full width of the feed container, no crop.

---

## 6. Auto-dismiss the "you're caught up" tile after 4s — ✅ DONE

> **Done.** Extracted the `caught-up` branch into a `CaughtUpTile` subcomponent (the variant
> needs hooks; the other variants stay pure). A `useEffect` starts a 4000ms `onDismiss` timer
> on mount and clears on unmount; `onMouseEnter` cancels it and `onMouseLeave` restarts it.
> ADD SOURCES / DISMISS / scroll-up paths still dismiss immediately.

**Current behaviour.** `EmptyFeedTile` variant `"caught-up"` (rendered in
`WorkspaceView` when `v.caughtUp`) persists until the user clicks ADD SOURCES / DISMISS or
scrolls up (the scroll/wheel dismiss lives in `Vessel.tsx`).

**Change.** In `EmptyFeedTile`, for the `"caught-up"` branch only, start a 4000ms timer on
mount that calls `onDismiss?.()`; clear it on unmount. Pause on hover so it doesn't vanish
under the cursor: cancel the timer on `onMouseEnter`, restart it on `onMouseLeave`. (Add
`"use client"` effects to this component — it's currently pure.)

**Acceptance.** The caught-up tile disappears on its own ~4s after appearing if untouched;
hovering it pauses the countdown; the existing ADD SOURCES / DISMISS / scroll-up paths
still dismiss immediately.

---

## 7. Disable the first-feed and new-feed entrance animations — ✅ DONE

> **Done.** Both `setCeremony({…})` calls are commented out with a `// TODO: re-enable /
> refine entrance animation` note (the first-login `cx`/`cy` consts are commented too so they
> don't dangle). `ceremony` stays `null`, so `<ForallCeremony>` and the `hidden=` guard go
> inert; the `ForallCeremony` component and the drag-settle spring are untouched. The
> `CEREMONY_BOX_W/H` consts are now referenced only in comments — left in place for the
> pending re-enable (no `noUnusedLocals` in `web/tsconfig.json`, so no build impact).

**Current behaviour.** `ForallCeremony` (framer-motion ∀→⊔ animation) plays in two cases,
both triggered by `setCeremony(…)` in `WorkspaceView.tsx`:
- **first feed** — the first-login block (`if (mintedFounderFeed && !seen …)`, ~line 643),
  `pace: "ceremonial"`;
- **new feeds** — on feed creation (~line 546), `pace: "responsive"`.

**Change.** Comment out (don't delete) both `setCeremony({ … })` calls so `ceremony`
stays `null`; the `<ForallCeremony>` render and the `hidden={ceremony?.feedId === …}`
guard then become inert and the feed simply mounts at its grid slot. Leave a `// TODO:
re-enable / refine entrance animation` note at each site. Keep the `ForallCeremony`
component and the vessel drag-settle spring (`animate(mx,…)`) untouched.

**Acceptance.** Neither the first feed (fresh account) nor newly added feeds animate in;
no console errors; feeds appear directly at their positions.

---

## 8. Move appearance controls off the vessel bar into the composer modal; add a text-size control

**Current behaviour.** `VesselBar.tsx` holds, left-to-right: brightness `○◐●`, density
`c/s/f`, orientation `|/─`, settings `⚙`, hide `×`, spacer, then the `+ add source` input.
The feed **numeral** and the **stretch/resize grab** live on the chassis in `Vessel.tsx`
(not on the bar).

**Keep on the bar:** settings `⚙`, hide `×`, the add-source input. **Keep on the chassis:**
the numeral and the resize grab (no change). **Move into the composer modal:** brightness,
density, orientation. **Add to the modal:** a text-size control.

### 8a. Strip the three cycle controls from `VesselBar`
- Remove the brightness / density / orientation `BarButton`s and their glyph maps.
- Remove `onBrightnessCommit` / `onDensityCommit` / `onOrientationCommit` from
  `VesselBarProps` and from where `Vessel.tsx` passes them into `<VesselBar>`.
- The bar now contains only `⚙`, `×`, spacer, add-source input.

### 8b. Add a per-feed text size to the store + tokens
- `web/src/components/workspace/tokens.ts`: add
  ```ts
  export type TextSize = 1 | 2 | 3 | 4 | 5
  export const DEFAULT_TEXT_SIZE: TextSize = 3
  // body / reading text px per step; meta + bylines are unaffected (task 9)
  export const TEXT_SIZE_PX: Record<TextSize, number> = {
    1: 11.5, 2: 12.5, 3: 13.5, 4: 15, 5: 16.5,
  }
  export function nextTextSize(t: TextSize): TextSize {
    return (t >= 5 ? 1 : ((t + 1) as TextSize))
  }
  ```
  (Default step 3 = 13.5px keeps today's body size.)
- `web/src/stores/workspace.ts`: add `textSize?: TextSize` to the per-vessel layout
  interface and a `setVesselTextSize(feedId, textSize)` action (mirror
  `setVesselDensity`). It persists with the rest of the layout.

### 8c. Render the four controls in `FeedComposer`
- `FeedComposer.tsx` currently takes only `{ feed, open, onClose, onSourcesChanged,
  onRenamed, onDeleted }`. Add props for the current values and commit callbacks:
  `brightness, density, orientation, textSize` and `onBrightnessChange, onDensityChange,
  onOrientationChange, onTextSizeChange`.
- Wire them from `WorkspaceView` where `<FeedComposer>` is rendered: read current values
  from `positions[feed.id]` (defaulting via the `DEFAULT_*` tokens) and pass the existing
  `setVesselBrightness/Density/Orientation` + new `setVesselTextSize` as the callbacks.
- Add an **"Appearance"** section in the modal body, after the "Add a source" block and
  before the delete/footer region. Four labelled cycle controls in the modal's existing
  `label-ui` idiom (reuse the glyphs that were on the bar):
  - Brightness — `○ / ◐ / ●` (cycles `nextBrightness`)
  - Density — label it **"View"** with `Condensed / Standard / Full` (this is the
    full-vs-condensed control; `nextDensity`)
  - Orientation — `| / ─` (`nextOrientation`)
  - **Text size** — the inverted big-A/small-A glyph: render two turned-A's
    (`Ɐ`, U+2C6F) at different sizes side by side, e.g.
    `<span style={{fontSize:18}}>Ɐ</span><span style={{fontSize:12}}>Ɐ</span>`, as the
    button face; click cycles `nextTextSize` through the five steps. Show the current step
    (e.g. `3/5`) as a small adjacent indicator. Text size is **orthogonal** to View
    (density) — they are separate controls.

**Acceptance.** The vessel bar shows only `⚙`, `×`, and the add-source field (plus the
chassis numeral and resize grab). Opening the composer (gear, or numeral double-click)
shows an Appearance section with Brightness, View, Orientation, and a five-step Text size
control using inverted A glyphs. All four persist per feed across reload.

---

## 9. Uniform text size/style across main / reply / parent; reply bylines match main bylines

**Current divergences (catalogue before editing):**
- Main note/external **body**: `text-[13.5px] leading-[1.5]`.
- **Playscript thread** dialogue (`ExternalPlayscriptEntry.tsx`, used by expanded threads
  and `ReplyGroupCard`): `text-[14.5px] leading-[1.55]` — different size.
- **Parent** body (`ParentContextTile.tsx`): `text-[13.5px] leading-[1.5]` — already matches.
- Main **byline** (`Byline` in `VesselCard.tsx`): `label-ui` mono row = pip + name
  (`font-medium`, `cardTitle`) + `·` + relative time, colour `cardMeta`.
- **Reply byline** (`ExternalPlayscriptEntry` speaker line): a bold-sans `Name:` playscript
  form — different style.
- **Parent byline** (`ParentContextTile`): `font-mono text-[11px] uppercase` — different again.

**Change.**

### 9a. One body size, driven by the per-feed text-size step
- Derive the body px from the feed's `textSize` via `TEXT_SIZE_PX` and thread it through
  `CardContext` (add `bodyPx: number` to the `CardContext` interface; set it in
  `VesselCard` from `TEXT_SIZE_PX[textSize ?? DEFAULT_TEXT_SIZE]`). Pass `textSize` into
  `VesselCard` from the render loop (alongside `density`/`brightness`).
- Apply `style={{ fontSize: ctx.bodyPx, lineHeight: 1.5 }}` to **all** reading-content
  blocks, replacing the hard-coded `text-[13.5px]` / `text-[14.5px]`:
  main note body, external body (collapsed + expanded `contentHtml`/`fullBody`),
  parent body, and playscript dialogue. `ExternalPlayscriptEntry` / `ParentContextTile`
  take a `bodyPx` (or the whole `ctx`) prop so they render at the same size as the host
  card.
- Net effect: at the default step everything reads at 13.5px (so the only visible change
  today is the 14.5 → 13.5 thread fix); the text-size control then scales all of it in
  lockstep. **Meta rows and bylines (mono `label-ui`) stay fixed** — "text size" governs
  the prose, not the chrome.

### 9b. Reply (and parent) bylines styled like main bylines
- Replace the `ExternalPlayscriptEntry` bold-`Name:` speaker line with the same visual
  treatment as the main `Byline`: pip slot (or its absence, consistently) + name
  (`font-medium`, `cardTitle`) + `·` + relative time, in the `label-ui` mono row at
  `cardMeta`. Easiest: extract the existing `Byline` JSX from `VesselCard.tsx` into a small
  shared component (e.g. `web/src/components/workspace/Byline.tsx`) and use it in
  `ExternalPlayscriptEntry`, `ReplyGroupCard`, and `ParentContextTile`. Keep the `→ Name`
  "replying to" affordance where it exists, but render the name in the shared byline style
  rather than bold sans.
- The playscript "Name:" colon convention is dropped in favour of the standard byline.

**Acceptance.** Body text of a given kind is the same size and style whether it sits in a
main card, an expanded reply thread, a reply group, or a parent tile — and scales together
with the text-size control. Reply and parent bylines are visually identical to main-card
bylines.

---

## Suggested commit grouping
1. Tasks 2, 3, 4, 6, 7 — small, independent fixes.
2. Task 5 — media expansion.
3. Task 1 — external pip → author modal.
4. Tasks 8 + 9 — text-size plumbing + typography unification (shared `Byline`, `bodyPx`
   through `CardContext`), since they touch the most surfaces.

## Files touched (reference)
- `web/src/components/workspace/Vessel.tsx` — 3
- `web/src/components/workspace/VesselBar.tsx` — 8a
- `web/src/components/workspace/VesselCard.tsx` — 1, 2, 5, 9
- `web/src/components/workspace/WorkspaceView.tsx` — 4, 7, 8c, 9
- `web/src/components/workspace/EmptyFeedTile.tsx` — 6
- `web/src/components/workspace/ParentContextTile.tsx` — 2, 9
- `web/src/components/workspace/ExternalPlayscriptEntry.tsx` — 9
- `web/src/components/workspace/ReplyGroupCard.tsx` — 9
- `web/src/components/workspace/FeedComposer.tsx` — 8c
- `web/src/components/workspace/tokens.ts` — 8b
- `web/src/components/workspace/Byline.tsx` (new) — 9b
- `web/src/stores/workspace.ts` — 8b
- `web/src/components/feed/AuthorModal.tsx` — reused by 1 (verify Esc/outside-click close)

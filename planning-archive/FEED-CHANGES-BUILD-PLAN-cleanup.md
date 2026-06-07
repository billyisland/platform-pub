# Feed / Vessel change requests — build plan

**Status (2026-05-30).** All nine tasks shipped, typecheck-clean (`web` `tsc --noEmit`).
Batch 1: tasks **2, 3, 4, 6, 7**. Batch 2: tasks **5** (media expansion) + **1** (external
pip → author modal). Batch 3: tasks **8** (appearance controls → composer modal + text-size
control) + **9** (text-size plumbing through `CardContext.bodyPx` + shared `Byline`). Per-task
completion notes are inline below.

Scope: the **workspace vessel system** only (`web/src/components/workspace/*`). The
single-column `/feed` page (`web/src/components/feed/FeedView.tsx`) is being retired and
is **out of scope** — but two of its components (`AuthorModal`, `useAuthorCard`) are
reused below.

Nine tasks, ordered roughly by independence. Each lists the root cause (file + the
mechanism, not just symptoms), the change, and acceptance criteria. Tasks 8 and 9
introduce a shared per-feed **text size** concept; do them after the rest or in their own
commit, as they touch the most files.

---

## 1. Make the trust pip clickable on external cards (author bio) — ✅ DONE

> **Done.** External pip is now a `<button ref={pipRef}>` wrapping `<TrustPip>` whose
> `onClick` stops propagation and toggles `authorOpen`; renders `<AuthorModal type="external"
> id={external.id} anchorRef={pipRef} dismissOnMouseLeave={false}>`. `AuthorModal` gained
> Escape + outside-`pointerdown` dismissal (anchor excluded so the trigger toggles rather
> than close-then-reopen) and a `dismissOnMouseLeave` prop (default true) so hover-driven feed
> usage is unchanged. Native note/article pips still open `PipPanel`.

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

## 5. Expanding a card expands its media to full dimensions — ✅ DONE

> **Done.** `MediaBlock` now branches its hero container/img style on `expanded`: expanded
> drops `aspectRatio`/`objectFit:cover` for `width:100%; height:auto; maxWidth:100%`; collapsed
> keeps the cropped 16:9. When expanded, extra image/video items render full-width stacked below
> the hero and the `+N` pill is suppressed (`overflowCount` zeroed). `NoteVesselCard` and
> `ArticleVesselCard` now pass `expanded` into `MediaBlock` (external already did).

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

## 8. Move appearance controls off the vessel bar into the composer modal; add a text-size control — ✅ DONE

> **Done.** 8a: `VesselBar` lost the brightness/density/orientation `BarButton`s + glyph maps +
> the three `*Commit` props; `Vessel` dropped the now-dead commit props too (it still takes the
> current values to resolve palette/layout). Bar = ⚙ · × · spacer · add-source. 8b: `tokens.ts`
> gained `TextSize`/`DEFAULT_TEXT_SIZE`/`TEXT_SIZE_PX`/`nextTextSize`; the workspace store gained
> `textSize?` on `VesselLayout` + a `setVesselTextSize` action (persists with the layout). 8c:
> `FeedComposer` takes `brightness/density/orientation/textSize` + `on*Change` callbacks (wired
> from `WorkspaceView` against the store, reading `positions[feed.id]`); renders an "Appearance"
> section with four `AppearanceControl` cycle buttons — Brightness (○◐●), View
> (Condensed/Standard/Full), Orientation (|/─), and Text size (two `Ɐ` glyphs + `n/5` indicator).

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

## 9. Uniform text size/style across main / reply / parent; reply bylines match main bylines — ✅ DONE

> **Done.** 9a: `CardContext` gained `bodyPx`, set in `VesselCard` from
> `TEXT_SIZE_PX[textSize ?? DEFAULT_TEXT_SIZE]` (`textSize` threaded in from the render loop).
> All prose blocks now use `style={{ fontSize: ctx.bodyPx, lineHeight: 1.5 }}` instead of
> hard-coded `text-[13.5px]`/`text-[14.5px]`: note body, external collapsed/expanded
> (`contentHtml` + `fullBody`), parent body, and playscript dialogue (the 14.5→bodyPx fix).
> `ParentContextTile`, `ExternalPlayscriptEntry`, `ExternalPlayscriptThread`, and
> `ReplyGroupCard` take a `bodyPx` prop (default = standard step). Article serif content left
> as-is (not in the catalogue). Meta/bylines stay fixed. 9b: extracted a shared
> `web/src/components/workspace/Byline.tsx` (pip · name · time, with an optional `replyingTo`
> "→ NAME" prefix in the same idiom); used by `VesselCard`'s three cards, `ParentContextTile`,
> and `ExternalPlayscriptEntry`. The playscript bold-`Name:` speaker line + colon convention is
> dropped; its timestamp moved into the byline (action row now just `Reply`).

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

---

# 📋 Code review findings — TO ADDRESS NEXT SESSION

**Audited 2026-05-30** across the full commit range `288e1ca^..HEAD` (the 7 commits
above). Scope note: commits 1–5 implement the 9-task plan above; the last two commits
(`5eecfc0` focal conversation view, `2cc3521` external refocus) are **not** in the plan and
added the highest-risk surface — a new gateway endpoint (`GET /conversation/:eventId`), a
`?focus=` param on `/external-items/:id/thread` (`deriveFocusItem`), and four new frontend
files. **The SSRF surface in `deriveFocusItem` was reviewed and is correctly closed** — host
comes from the trusted base row and the Mastodon status id is regex-gated to digits. Overall
the work is solid and `tsc`-clean; items below are robustness/hygiene, none block shipping.

## High — do first
- [x] **H1 — Add a cycle guard to client thread walks.** ✅ Visited-`Set` guards added to
  `ConversationView` ancestor `while` + descendant DFS. `ExternalAncestorRail` /
  `ExternalPlayscriptThread` don't recurse (they map flat server-provided lists) so the
  loop hazard doesn't apply there; added id-dedupe to both instead for `key` parity (see L4).
  `web/src/components/workspace/ConversationView.tsx:84-90` (ancestor `while`) and `:97-105`
  (descendant DFS) follow `parentEventId`/`childrenOf` links with no visited `Set`. A
  `parentEventId` cycle or self-parent row → infinite recursion → hung tab. The server
  *prevents* cycles (immutable `parent_comment_id`), so this needs DB corruption to trigger —
  but the fix is a one-line `Set<string>` guard in both walks and the failure mode (frozen
  render thread for every viewer of that conversation) is severe. Apply the same guard to
  `ExternalAncestorRail.tsx` / `ExternalPlayscriptThread.tsx` for parity.
- [x] **H2 — Bound `threadCache` (server).** ✅ Added `setThreadCache()` helper with a
  1000-entry cap that sweeps expired entries first then evicts oldest insertions; the route
  now writes through it. The other server caches are item-id-keyed (bounded by visible
  content) so left as-is, with a note.
  `gateway/src/routes/external-items.ts:42-46, 400, 436`. The cache is a plain `Map` with a
  TTL field but no size cap and no expiry sweep. The new key `` `${id}|${focus}` `` makes the
  keyspace attacker-controlled (`focus` is unbounded query input) — an authed user can mint a
  permanent entry per distinct `focus` (30/min via rate limit, never reclaimed) → monotonic
  gateway memory growth. Add an LRU cap or periodic expired-entry sweep.

## Medium
- [x] **M1 — `refreshKey` bump resets the focal node.** ✅ The reset effect now depends on
  `[hostEventId]` only, so a `refreshKey` bump (publishing a reply) no longer yanks a
  re-rooted reader back to the root. `ConversationView.tsx:59` —
  `setFocalId(hostEventId)` fires on every `refreshKey` change, so publishing a reply yanks a
  re-rooted user back to the conversation root. Confirm intended; if not, preserve `focalId`
  when the node still exists.
- [x] **M2 — Focal node absent from refetched tree renders a hole.** ✅ Added an effect: if
  the focal id is gone from a refetched tree (and the tree is non-empty), reset to the host
  root.
  `ConversationView.tsx:166, 309` — `byId.get(focalId) ?? null` with no fallback; a stale/
  deleted `focalId` leaves ancestors above an empty gap. Add a "not found → reset to root".
- [x] **M3 — Unbounded + non-invalidating client caches.** ✅ Both hooks gained a shared
  `readCache`/`writeCache` pair with a 60s TTL + 200-entry cap (insertion-order eviction).
  `useConversation` now deletes the stale entry before a `refreshKey` refetch so a concurrent
  mount can't read pre-reply nodes; `useExternalThread` entries now expire instead of going
  stale for the whole session.
  `web/src/hooks/useExternalThread.ts:13,38` (key `${itemId}|${focus}`, one permanent entry
  per node clicked, **no refresh path** so external threads go stale for the whole session)
  and `web/src/hooks/useConversation.ts:26,74` (refetch-around on `refreshKey` doesn't delete
  the stale entry first, so a concurrent mount can read pre-reply nodes). Cap + add TTL; fix
  the read-around. Pairs naturally with H2 — one consistent cache-bounding fix.
- [ ] **M4 — Inconsistent "non-adjacent parent" arrow semantics.** _Deferred — purely
  cosmetic, and there's no unambiguous "correct" ordering to converge on (native DFS vs
  external chronological; the spec calls threads "chronological", which native itself
  doesn't honour). Unifying it risks a visible reordering regression for no behavioural gain;
  left for a dedicated typography/threading pass._
  Native descendants are DFS-ordered (`ConversationView.tsx:97-105`); external descendants are
  chronologically sorted (`external-items.ts:1752`), so the `→ PARENT:` arrow heuristic in
  `ExternalAncestorRail.tsx:38-50` / `ExternalPlayscriptThread.tsx:52-64` fires on different
  nodes than native. Cosmetic but visible divergence from the playscript spec.

## Low
- [x] **L1 — Outside-click while `AuthorModal` open both dismisses it and toggles card
  expand.** ✅ `AuthorModal`'s outside-`pointerdown` handler now registers a one-shot
  capture-phase `click` swallower (with a 0ms cleanup so only this gesture's click is caught)
  before calling `onClose`, so dismissing the modal by clicking the card no longer fires the
  card's expand handler. The anchor (pip) case still returns early, so toggling is unaffected.
- [x] **L2 — Thumbnail-less extra videos vanish in expanded media.** ✅ A video extra with no
  poster frame now renders a "▶ Watch video ↗" link to its URL instead of returning `null`.
- [x] **L3 — Dead `CEREMONY_BOX_W/H` consts draw `next lint` warnings.** ✅ Silenced with
  `eslint-disable-next-line @typescript-eslint/no-unused-vars` per the Task 7 keep-for-re-enable
  decision (rather than removing, so the pending entrance-animation work can still use them).
- [x] **L4 — Duplicate node ids → React key collisions.** ✅ `ConversationView` `<li>` keys are
  now group-prefixed (`anc-`/`focal-`/`desc-`) so a node appearing in two groups can't collide;
  `ExternalPlayscriptThread` and `ExternalAncestorRail` dedupe their entry lists by id.
- [ ] **L5 — `GET /conversation/:eventId` fetches all comments unbounded.**
  `replies.ts:620` — no `LIMIT`/pagination (inherited from `/replies`); the focal view renders
  the entire set. _Deferred per the original "revisit if any conversation gets large" note —
  it's a pre-existing `/replies` characteristic, not a regression from this work._
- [x] **L6 — atproto `focus` is an authed open-proxy for any public Bluesky thread.** ✅
  Comment-only: the thread-route comment no longer claims "ownership scoping" for atproto — it
  now states plainly that `focus` is an unverified `at://` URI (authed read-proxy for public
  Bluesky threads on the pinned AppView host, no SSRF since the host is fixed).

## Cross-cutting
- [ ] **Tests:** the undocumented focal-conversation backend (`/conversation/:eventId`,
  `deriveFocusItem`) has **zero test coverage**. Add: root resolution from a comment id,
  paywall-locked empty response, and a `deriveFocusItem` SSRF/regex-gate test. _Not yet done
  — the robustness fixes above don't change this surface's behaviour; tracked as the remaining
  open item from this review._
- [x] **Cache bounding (H2 + M3)** ✅ Addressed consistently: server `threadCache`
  (`setThreadCache`, cap + expiry sweep) and both client hooks (`readCache`/`writeCache`, TTL +
  cap). The remaining server caches are item-id-keyed and intentionally left unbounded with a
  note.

### Verified correct (no action needed)
`deriveFocusItem` Mastodon SSRF defense (path-traversal/query-injection/host-breakout all
normalize safely); self-thread `null===null` non-match (`ParentContextTile.tsx:91-102`);
refresh-collapse key collection + identity no-op (`WorkspaceView.tsx:370-387`); Zustand
`setVesselTextSize` merge + forward-compatible persistence; `EmptyFeedTile` caught-up timer
lifecycle; removed appearance-control props fully cleaned; paywalled article bodies never leak
through `/conversation` (title only); no conditional-hook violations.

---

# 📋 UNIVERSAL-POST independent audit findings — 2026-06-01

**Audited 2026-06-01** across the three-day UNIVERSAL-POST arc (`29c22d2^..ac100ca`, 47
commits) against `UNIVERSAL-POST-ADR.md` §2–§10 and `CARD-BEHAVIOUR-ADR.md`. This is a
**second, independent pass** after the author's own post-cutover audit (`ac100ca`: C1 +
4 highs). Those fixes were re-verified and hold — see _Verified correct_ at the foot. The
items below are what the first pass did not surface. Priority is by consequence, not effort.
None is a regression the test suite would have caught (the gaps are in untested paths or in
ADR-intent conformance, not type safety).

## P0 — wrong now, or latent-severe on a live path

- [ ] **P0-1 — `scoresheet.reposts` is the wrong number, and is always 0 for native.**
  `gateway/src/lib/post-mapper.ts:216` sets `scoresheet.reposts = Number(row.boost_count)`,
  i.e. the count of external `repost_edges`. But §2.2 reserves the scoresheet for the
  **all.haus native** reaction tally. Two consequences: (a) `feed-ingest/src/lib/repost-edge.ts`
  itself documents that a boost of **native** content derives a non-matching `target_post_id`
  and never binds, so a native THING's `boost_count` is **always 0** — native posts show 0
  reposts even when reposted; (b) for external THINGs the field shows the *followed-source
  boost count*, which is neither the origin repost count (`originCounts.repost`, already
  carried separately) nor an all.haus tally. The displayed numeral is a three-way smear.
  **Change:** stop sourcing `scoresheet.reposts` from `boost_count`. Surface the booster
  count via the attribution set (it already rides `{ items, attribution }`), and populate the
  native scoresheet from the actual native repost events when that path exists; until then,
  zero it honestly rather than mislabel `boost_count`. **Severity:** user-visible-wrong on
  every card today; one-mapper change.

- [x] **P0-2 — `/thread` server descendant walk has no cycle guard → hangable request on the
  live thread engine.** ✅ **Done.** Threaded a `seenDescendant` `Set<string>` through `collect()`
  in `gateway/src/routes/post-thread.ts` (mirrors the ancestor walk's `seen` set): the recursion
  early-returns on an already-expanded `parentId`. Each comment still appears under exactly one
  `parent_post_id`, so each is pushed at most once — no duplicate subtree rows, no behaviour change
  on well-formed data; a corrupt `parent_comment_id` cycle now terminates instead of recursing
  unboundedly. The walk was extracted to a pure, dependency-free `gateway/src/lib/thread-walk.ts::
  collectDescendants` (so it's unit-testable without the route's DB/service imports) and covered by
  `gateway/tests/post-thread.test.ts` (6 tests: well-formed DFS order + uniqueness, deep linear
  chain, 2-node cycle, self-parent, and a large cycle that terminates). Gateway `tsc --noEmit` +
  full `vitest` (88) clean.
  `gateway/src/routes/post-thread.ts:260-267` — `collect()` recurses
  `parentId → children → collect(child)` with no visited `Set`. A self-parent or cyclic
  `parent_comment_id` (corrupt data) → unbounded recursion → the request hangs / the worker
  stalls for **every** reader of that conversation. This is the exact hazard the 2026-05-30
  review fixed as **H1** for the *client* `ConversationView` walk; the ancestor walk in this
  same file already carries a `seen` set (`:239`), but the new server descendant walk
  reintroduced the unguarded form. Now that `/thread` is the live projector, the blast radius
  moved server-side (can't be cleared by a client reload). **Change:** thread a visited
  `Set<string>` through `collect`, mirroring the ancestor walk; skip already-seen ids.
  **Severity:** needs DB corruption to trigger (rated High under the H1 precedent), but the
  failure mode is a stuck server path and the fix is one line.

## P1 — conformance / correctness, needs more than a line

- [ ] **P1-1 — The §5 "direct-follow content is never buried under boosted content"
  guarantee is not delivered, and cannot be under the additive formula as tuned. DECISION
  REQUIRED.** `gateway/src/routes/post-feed.ts:60-62` defaults `recencyHalflifeHours=12`,
  `boostCeiling=3`. The score is `recencySeed + saturate(mass)` (`:94-104`): `recencySeed`
  maxes at 1.0, boost lift reaches 3.0. A 60-day-old THING with ~2 fresh boosts (mass≈1.9 →
  lift 1.16) **outranks** a one-hour-old direct-follow post (0.944). Worse, with a 12h
  half-life `recencySeed` floating-underflows to ~1e-37 for anything older than ~3 weeks — the
  regime the endpoint was validated in — so live ordering degenerates to boost-mass-then-
  `published_at`, and *all* unboosted direct content sits beneath *all* boosted content. The
  underflow was logged in the ADR §10 record as benign ("a knob to tune") but was not
  connected to the §5 invariant it breaks. Root cause is partly an **ADR-internal
  contradiction**: the §5 prose promises "never buried" while the §5 *additive* formula permits
  burying whenever boost lift exceeds `recencySeed`'s ceiling. **This is a design call, not a
  patch** — pick one: (a) floor `recencySeed` at/above `boostCeiling` for followed-author
  direct posts; (b) rank direct-follow and boost-float in separate bands and merge; (c) make
  boosts multiply recency rather than add; or (d) amend the §5 prose to drop the absolute
  guarantee. **Severity:** quietly defeats the central aim of the scoring rewrite in the exact
  data regime it ships into.

- [x] **P1-2 — `inReplyTo`/`quotes` mis-resolve for replies/quotes to articles.** ✅ **Done +
  bug confirmed LIVE.** Investigation settled the open question: native kind-1 replies/quotes store
  the target article's **raw event id** (not its `a`-coordinate) — the client builds the target
  from `article.nostrEventId` (`publishNote.ts` → `notes.quoted_event_id`), and in practice the
  compose *reply* path routes through the *quote* parameter, so the dangle most often manifests via
  `quoted_event_id`/`quotes_post_id`. Verified against the dev DB: deriving from the article event
  id does **not** match the article THING's `post_id`; deriving from the coordinate does.
  **Fix (read-side, repairs existing + future rows, no migration/re-ingest):** both nostr branches
  in `POST_SELECT` (`gateway/src/lib/post-mapper.ts`) now run through a shared `nostrTargetPostId()`
  snippet that resolves the stored event id to the article's coordinate
  `'30023:'||pubkey||':'||dtag` via a correlated `articles ⨝ accounts` lookup (`COALESCE` falls back
  to the raw event id for note targets, which is correct). Validated on live data: an article event
  id now resolves to the article's real `post_id`; a non-article id falls through unchanged. Used by
  both `/feed` and `/thread` since `POST_SELECT` is shared. Gateway `tsc` clean; SQL executes in the
  full join context (no alias collision). **Residual (separate follow-up, NOT fixed here):** the
  on-relay event is also NIP-18/23-non-conformant — `publishNote.ts:41` emits an `e`/`q` event-id
  tag for a replaceable kind-30023 target that should carry an `a` (coordinate) tag. That's a
  relay-interop concern for external consumers, distinct from all.haus thread linkage; left as a
  noted follow-up. **Tests:** `gateway/tests/post-mapper.test.ts` (7 tests) is a structural
  regression guard — it asserts both nostr branches in `POST_SELECT` route through the
  exported `nostrTargetPostId()` coordinate resolver (and that the naive
  `feed_items_derive_post_id('nostr', n.reply_to_event_id)` / `…quoted_event_id` forms are gone),
  while the external branches stay unchanged; the runtime SQL behaviour itself was validated against
  the dev DB during the fix.
  `gateway/src/lib/post-mapper.ts:95` derives `in_reply_to_post_id =
  feed_items_derive_post_id('nostr', n.reply_to_event_id)`. But a native article's `post_id`
  is minted from the **naddr coordinate** `'30023:'||pubkey||':'||dtag` (migration 098), not
  its event id. A kind-1 reply whose `reply_to_event_id` holds the article's *event* id
  therefore derives a `post_id` that matches **no THING** → the edge dangles and `/thread`
  can't resolve the parent → orphaned thread node. Replies that carry the `a`-coordinate
  resolve fine; the bug bites whichever form your kind-1 article replies actually store.
  **Change:** confirm what `reply_to_event_id` holds for article replies; if it's the event
  id, resolve the article's naddr coordinate before deriving (or store/derive both and try the
  coordinate as a fallback). Same logic applies to the `quoted_event_id` branch (`:98`) for
  quotes of articles. **Severity:** silently breaks thread linkage for an entire content class.

## P2 — robustness / scale

- [ ] **P2-1 — `version` edit-detector can miss deep-body edits; poll options never hashed.**
  The identity trigger (`migrations/099_external_author_identity.sql:99-107`, current
  definition) only recomputes the content hash when `content_preview`/`title`/`nostr_event_id`/
  `external_item_id` change. `content_preview` is **truncated**: an external edit that changes
  body text beyond the preview cutoff, leaving the preview and title untouched, won't trigger
  recompute → stale content served under an unchanged `version`, contradicting §2.4's "identical
  content ⇔ identical hash" (and, by intent, its converse). Separately, `feed_items_content_version`
  (migration 098) hashes text+title+media URIs but **omits poll options**, which §2.4 lists in
  the canonical object — a poll-only edit is invisible. **Change:** recompute on any
  `external_items` content touch (or hash full text, not the preview proxy); add `pollOptions`
  to the canonical fingerprint. **Severity:** low frequency, silent staleness when it bites.

- [ ] **P2-2 — `fetchAttribution` is unbounded per THING.**
  `gateway/src/routes/post-feed.ts:131-160` pulls *every* `repost_edge` for the page's
  `post_id`s and discards `rn > 25` (`ATTRIBUTION_PER_POST`) in JS. §5 explicitly anticipates
  high-boost THINGs ("boosted by 14… at scale the number is the proof"), so a viral THING pulls
  thousands of rows per feed page to keep 25. **Change:** push the `ROW_NUMBER ≤ 25` filter
  into SQL (lateral or filtered window) and return the total count for the "+N" via a separate
  `COUNT`, rather than over-fetching to derive it. **Severity:** no correctness impact; scales
  badly precisely where §5 expects volume.

## P3 — hygiene / documented residual

- [ ] **P3-1 — Biddability tier is sticky; never upgrades D→C.** The trigger early-returns when
  `item_type`/`source_protocol`/`external_item_id` are unchanged
  (`migrations/099_external_author_identity.sql:118`); `author_uri` is not a tracked input, so
  a late-arriving `author_uri` won't promote D→C. Largely moot today — `rss.ts` hardcodes
  `author_uri = null` (so RSS is permanently D and tier C is email-only by construction) — but
  any future email From-parsing or `author_uri` backfill won't re-tier. **Action:** note only;
  fix if/when an `author_uri` backfill path lands.

- [ ] **P3-2 — Phase 5 deletion is workspace-scoped; the §10 "no dangling references" Accept is
  not met.** The legacy `components/feed/` family (`ExternalCard`, `NoteCard`,
  `NeighbourhoodCard`), `useNeighbourhood`, `ExternalThreadEntry`, `ParentItem`, and the
  `quoted*` fields survive and remain wired into `/source/[id]` and the standalone `/feed`. This
  was **recorded deliberately** in the ADR §10 Phase 5 note (deferred to a later
  `/feed`+`/source`-scoped pass), so it is tracked residual debt, not a silent miss — but the
  cutover is marked done (C10) while two card families coexist. Stale future-tense comments
  referencing the now-deleted `VesselCard` (e.g. `web/src/components/post/chassis.tsx:12`)
  should be swept in the same pass. **Action:** schedule the `/feed`+`/source` retirement pass;
  until then, leave a pointer here so "Phase 5 done" isn't read as "legacy removed".

- [ ] **P3-3 — Constructed external profile (§VI.3) aggregates per protocol-identity, not per
  person.** Authorised (UNIVERSAL-POST §4.4/§9 pulled it back from CARD-BEHAVIOUR's deferral;
  supersession recorded). But `external_authors` is keyed `UNIQUE(protocol, stable_handle)`, so
  one person's Bluesky + Mastodon identities stay separate rows and the profile aggregates only
  within a single protocol identity — the "unified across all linked platforms" ambition is
  partially met. Correctly tracked as feature-debt #5 ("Cross-source identity linking"); pointer
  only, no action here.

### Verified correct (no action needed)
C1 relay-free nostr identity (shared `nostrEventUri`/`nostrAddrUri` + migration 101 soft-delete/
rebuild) is coherent and closes the dedup-to-one + boost-reconstruction break; `recordRepostEdge`
idempotency (partial unique indexes `idx_repost_edges_origin`/`_synthetic` + bare `ON CONFLICT DO
NOTHING`) is correct; H3 Readability sanitiser is wired (`extract.ts:85` applies
`sanitizeArticleContent` with a long-form allowlist to the newly-public `/reader/[postId]` path);
the `scoreNow` cursor-pin (`post-feed.ts`) correctly fixes the keyset duplicate-row bug; §6
`originCounts = null` for native is enforced in the mapper; the saturation-over-accumulated-mass
choice (vs §5's literal per-term `Σ saturate`) is the correct reading of the stated "tenth boost
lifts far less than the second" intent — a sound documented deviation, not a defect.

---

# 📋 Full-view card spec-conformance — 2026-06-01

**Checked 2026-06-01.** The live workspace cards (post-cutover: `VesselCard` deleted, dev
flag gone, hosts on `PostCardInteractive`/`PostThread`) against the informal full-view
behavioural spec (the product target behind ADR §4). Per-clause verdict held separately;
this records only the **gaps**, P0–P3. Clause numbers below refer to that spec
(resting card 1–8 · expand 9–15 · thread 16–22 · re-root 23–25 · hover 26–28 · profile
29–31). Several gaps are documented Phase-2/3 scope cuts (marked _cut_); two are
undocumented and read as oversights.

## P0 — the defining all.haus behaviour is absent

- [ ] **SC1 — The all.haus native reaction layer is mostly unbuilt (clause 5; §7).** Ties
  directly to **P0-1** above. `web/src/components/post/PostActions.tsx` renders native
  up/down vote (`VoteControls`, gated `native && post.version`), a **disabled "Save"
  placeholder**, and report (native-only). There is **no all.haus repost button anywhere**,
  and **no all.haus vote on external content** (VoteControls is native-gated). What *did*
  ship is `usePostInteractions` — **origin interact-back** (push a like/repost to
  Bluesky/Mastodon via a linked account), which its own header notes "is NOT the all.haus
  scoresheet (greenfield `POST /post/:postId/react`, ADR §9 — deferred)." So a card can like
  a Mastodon post *on Mastodon* but cannot up-vote or repost it *as an all.haus object* — the
  one thing §6/§7 say every THING wears by construction, and the action that feeds §5
  re-float. **Change:** build `POST /post/:postId/react { up|down|repost }` (§9, all tiers),
  back the scoresheet, and render a real all.haus vote+repost row in `PostActions` available
  at **every** tier (replace the disabled "Save"). Until then the affordance reads as "coming
  soon" rather than degraded. **Severity:** the spec's centre of gravity; also the reason
  P0-1's "reposts" numeral can only ever be `boost_count`.

## P1 — built wrong or diverged, and undocumented

- [ ] **SC2 — The constructed profile carries the modal's info but none of its affordances
  (clause 30).** `web/src/app/author/[authorId]/AuthorProfileView.tsx` renders avatar, name,
  handle, bio, follower/following/post stats and the `level="feed"` post log — but the only
  `<button>` on the page is "SHOW MORE" (`:275`). The spec requires the profile to contain
  "all the information **and affordances** of the modal" — the hover modal's
  follow / add-as-source control (`AuthorModal` `FollowButton`) is simply not reproduced on
  the full page. **Not recorded as a scope cut anywhere** — reads as an oversight. **Change:**
  lift the `followTarget` + `FollowButton` from `AuthorModal` into the profile header.
  **Severity:** low effort, clear conformance miss.

- [ ] **SC3 — Counter-click is interact-back, not the §4.2 reactor-modal / scroll-to-reply
  (clause 15).** `web/src/components/post/PostCounters.tsx::InteractiveRow` renders the
  like/reply/repost counts as **action buttons** (toggle an origin like, open the reply box).
  §4.2 specified: like/repost count → modal listing the reactors; reply count → scroll to the
  first already-expanded reply. Neither exists. This is a deliberate-looking product choice
  (Twitter-style fused row) that was never ratified against §4.2. **Decision required:** keep
  the fused action row and amend §4.2, or split count (→ modal/scroll) from action.
  **Severity:** affects every expanded external card; behavioural divergence, not a crash.

## P2 — documented scope cuts the spec still wants (track to close)

- [ ] **SC4 — Focal video does not autoplay-muted with an unmute control (clause 11). _cut._**
  `LEVEL_SPEC.focal.video = "autoplay-unmute"` is computed in `resolveSpec` but **no component
  consumes the video mode** — `PostMedia` (`web/src/components/post/PostMedia.tsx`) isn't even
  passed it; video always renders a poster + play-glyph that `window.open`s the origin.
  **Change:** thread `spec.video` into `PostMedia`; on focal render a real
  `<video autoplay muted playsInline>` + unmute toggle; keep the poster/glyph for non-focal.

- [ ] **SC5 — Quoted post does not promote to a full child on expand (clause 12). _cut._**
  `web/src/components/post/QuotedEmbed.tsx` has no `"full-child"` branch — at focal it folds
  to `"mini"` (byline+body), per the documented Phase-3 cut. Needs `/thread` quote resolution
  to render the quoted post with feed-level affordances; the inner quote-of-quote then degrades
  to the §4.1 stub (already specced).

- [ ] **SC6 — External thread participants are read-mostly (clauses 16/17). _cut._**
  `PostThread` gates `onReply`/`onReport` on `p.author.pubkey` (native only), and external
  all.haus reactions are deferred (SC1), so an expanded conversation's external parents/replies
  lack the "full affordances of a feed card" the spec asks for. Resolves once SC1 lands and
  external inline reply is wired into the thread leaves.

- [ ] **SC7 — Follow-on-origin missing; modal offers a single target (clause 28). _cut._**
  `AuthorModal` renders one `FollowButton` whose `followTarget` is *either* an all.haus
  user-follow *or* an add-as-source subscribe — never both, and never a **follow on the origin
  platform** (interact-back, deferred). For an external A/B author with a linked account the
  spec wants add-as-source **and** origin-follow concurrently. **Change (when interact-back
  lands):** model `followTarget` as a set; add the origin-follow affordance gated on a matching
  linked account.

## P3 — cosmetic / degradation

- [ ] **SC8 — Overflow arrows aren't in the indentation gutter (clause 22).** `PostThread`'s
  ↑/↓ are `sticky top-2/bottom-2 ml-1` against the viewport edge, not in the 32px thread gutter
  beside the off-screen content. Functionally correct (IntersectionObserver sentinels toggle
  them, persist until you reach the end). Reposition into the `ml-8` gutter for spec fidelity.

- [ ] **SC9 — External trust pip is permanently "unknown" (clause 1).** `gateway/post-mapper.ts`
  hardcodes external `pipStatus: "unknown"`; the pip renders but never reflects trust. Expected
  while the trust graph is deferred (§9); note only.

### Conformance summary
Met as specified: clauses 1–4, 6–10, 14, 18–21, 23–27, 29, 31. Diverged/partial: 5 (SC1),
11 (SC4), 12 (SC5), 15 (SC3), 16/17 (SC6), 22 (SC8), 28 (SC7), 30 (SC2). The two to treat as
genuine gaps rather than known deferrals are **SC1** (the all.haus action layer — the spec's
point) and **SC2** (profile affordances — an unrecorded oversight); the rest are documented
Phase-2/3 cuts now collected here so they don't drift out of view.

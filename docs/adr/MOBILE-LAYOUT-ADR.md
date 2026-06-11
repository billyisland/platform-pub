# MOBILE-LAYOUT-ADR: The Mobile Workspace — Single-Feed Paging

**all.haus Architectural Decision Record**
**Status:** Proposed, 2026-06-08. Not yet sliced into the build plan. Supersedes the
pre-workspace mobile view, which has not been touched since the canvas was built.
**Author:** Ed Lake / Claude (design partner)
**Depends on:** WORKSPACE-FULL-VIEW-SPEC, UI-DESIGN-SPEC, CARD-BEHAVIOUR-ADR (§VIII touch idiom), UNIVERSAL-FEED-ADR
**Affects:** `web/src/components/workspace/*`, `web/src/stores/workspace.ts`, `gateway/src/routes/feeds.ts`, `schema.sql`, `migrations/`

> **Note to Claude Code.** This is a design-decisions document, not a line-level
> implementation spec. It fixes the _what_ and the _why_; you own the _how_. Where it
> names a file, endpoint, column, or constant, treat that as the intended shape unless
> you find a concrete reason it cannot work — in which case stop and flag it rather than
> improvising a divergent design. Phasing is in §VIII; Slice 1 is the data spine and
> precedes everything else.

---

## I. Problem statement

The mobile view has not been reworked since the workspace canvas landed. The canvas is
an inescapably pointer-spatial paradigm: `Vessel.tsx` is a ⊔-chassis the user drags to
position, resizes, reorients (⊔/⊏), and merges by dragging one onto another, with each
feed's `{x, y}` held in the `positions` map in `stores/workspace.ts`. None of that has a
touch translation. Drag-to-arrange on a 380px viewport is not a degraded version of the
desktop interaction — it is no interaction at all.

So mobile is not a responsive reflow of the workspace. It is a **different interaction
model that presents the same feeds**: one feed per screen, paged horizontally. The
desktop's spatial affordances do not shrink onto the phone; they are simply absent
there, and the feed's identity is carried instead by its numeral.

---

## II. Design principles

1. **Reduction, not port.** The spatial canvas does not exist on touch. We do not
   apologise for its absence or gesture at a miniature of it; mobile is its own surface.

2. **Keep feed _character_, drop feed _arrangement_.** Brightness and density are
   properties of a feed and travel with it to mobile. Position, size, orientation, and
   merge are properties of the _canvas_ and stay on the desktop.

3. **The numeral is the spine.** A feed's number is both the identity the reader sees
   and the order they swipe through. This forces the numeral to become real, persisted
   state (§VII) rather than the render-time accident it is today.

4. **One gesture, one job** (per CARD-BEHAVIOUR §II.1). Horizontal swipe is claimed at
   the _page_ level for moving between feeds. This does not contend with card actions:
   CARD-BEHAVIOUR §VIII already fixes the touch idiom as tap-through plus the `⋯` action
   sheet, with no horizontal card swipe. The two gestures live on different objects.

---

## III. Shell

The old top nav is retained, with the burger mapping to the **ForallMenu** — already the
∀ command surface that opens the overlays (messages, notifications, search, ledger,
profile, new-feed). On mobile those overlays become **full-screen sheets**; they exist
today as overlays, so this is presentation, not rearchitecting.

Below the nav, the rest of the viewport is the **active feed, full-bleed**. No vessel
walls, no chassis, no canvas — the ⊔ is a desktop chrome and does not render on mobile.

---

## IV. Moving between feeds

- **Vertical scroll** moves within the active feed (the existing `PullToRefresh`
  vertical gesture is unaffected — see §VI on axis orthogonality).
- **Horizontal swipe** pages between feeds, in **rank order** (§VII).
- A slim **indicator strip** under the top nav shows _feed N of M_ and supports
  tap-to-jump. This is non-negotiable: a pure swipe pager with no indicator is a known
  discoverability trap, and the strip doubles as the visible form of the rank order.
- **Resume and deep-links key off the feed `id`, never the numeral.** The numeral is a
  positional label and will shift under reorder, delete, and hide; a stored numeral
  would silently point at the wrong feed.

---

## V. Hidden feeds

Hidden feeds are **excluded from the swipe rotation**, and the visible feeds **renumber
1…N with no gaps**. A gap in a swipe sequence (1 → 3 → 4) reads as a bug. The cost is
that a feed's mobile number can differ from a count that includes hidden feeds, and can
shift on hide/unhide — which is consistent with the numeral already shifting on delete,
and is the correct trade.

---

## VI. Per-feed appearance, and what is dropped

**Retained:** the colour scheme and density, surfaced through a per-feed **settings
sheet** — the mobile form of the FeedComposer gear that already owns appearance on
desktop. (Since 2026-06-11 the colour scheme — brightness's successor, the six-swatch
`SchemePicker` — already persists server-side on `feeds.appearance.scheme`, migration
112, so it travels to mobile for free; **density is the remaining per-device
localStorage gap**, and `feeds.appearance` JSONB is its natural landing spot.)

**Dropped on mobile:** orientation (meaningless at full-bleed — there is one column and
it is the screen), resize, drag-to-position, and merge-by-drag. These are canvas
operations with no spatial substrate on the phone.

**Axis orthogonality.** The pager (horizontal) and scroll/pull-to-refresh (vertical) sit
on perpendicular axes and do not contend. The one real hazard is the orientation logic
in `Vessel.tsx`, where a horizontal vessel scrolls its _contents_ horizontally; that
inner horizontal scroll would fight the pager. Because orientation is dropped on mobile
(principle II.2), force vertical layout there and the hazard cannot arise. Second, minor:
the pip's capture-phase click-swallower (`PipPanel`/`PipTrigger`) and the pager's pan
handler must not both claim a drag begun near the pip — resolve in favour of the pip.

---

## VII. Feed ranking and the `sort_rank` migration

This is the substantive data change, and it is shared by both surfaces.

Today there is **no order stored anywhere**. The numeral is derived live in
`WorkspaceView.tsx` as _sort feeds by `createdAt`, take the index + 1_. The `feeds` table
carries only `id`, `owner_id`, `name`, `appearance` (jsonb, migration 112 — the per-feed
colour scheme), and timestamps. The moment a user can re-rank
feeds, order becomes intentional state that must persist:

1. **Schema.** Add `sort_rank integer` to `feeds` (new migration, with the matching
   `schema.sql` dump so the drift check stays green — note migration ordering against the
   `028` precedent in the audit). Backfill existing rows in current `createdAt` order so
   nothing jumps on deploy.
2. **Derivation.** Switch the client numeral from the `createdAt` sort to `sort_rank`.
   This unifies the two surfaces: desktop badges and mobile swipe order read the same
   field, and "Feed 1" becomes a thing the user _chose_ rather than an accident of which
   feed they made first.
3. **Write path.** A `PATCH` (or equivalent) on `gateway/src/routes/feeds.ts` to persist
   a reorder. Ranks are plain integers, rewritten in full on each reorder — feeds per
   user are few, so lexorank-style fractional keys are unjustified complexity.
4. **UI.** A drag-to-rank list of all feeds in **FeedComposer**, which already owns
   rename / delete / source list / appearance and is the natural home.

**Rank and canvas position are fully independent — by design.** They answer different
questions: rank is "what number is this feed, and where does it sit in the swipe order";
position is "where does its vessel sit on the desktop canvas." They may freely disagree —
rank-1 may sit bottom-right on the canvas, and the desktop numeral badges will therefore
look scattered across the workspace. That is expected behaviour under decoupling, not a
defect to be reconciled.

---

## VIII. Phasing

Slices are ordered by dependency. Slice 1 is pure data/refactor and changes no visible
behaviour; the migration must land and be green before anything builds on it.

1. **Rank as data.** Add `sort_rank` + migration + `schema.sql` dump + backfill; move
   the client numeral derivation from `createdAt` to `sort_rank`. Desktop looks
   identical. No new UI.
2. **Reorder UI.** Drag-to-rank list in FeedComposer; the `feeds` reorder endpoint.
   Available on both surfaces (it is one component).
3. **Mobile shell.** Top nav + burger → ForallMenu; ForallMenu overlays as full-screen
   sheets; single full-bleed active feed; orientation/resize/position/merge suppressed
   on the mobile breakpoint.
4. **The pager.** Horizontal swipe over _visible_ feeds in rank order; indicator strip
   with tap-to-jump; hidden feeds excluded and 1…N renumbering; resume-by-`id`. Resolve
   the pip gesture precedence here.
5. **Per-feed appearance sheet.** Colour scheme and density on mobile via the settings
   sheet (the scheme already syncs server-side — migration 112).

Do not start Slice 4 before Slice 1 is green: the pager has no order to page through
until the rank exists.

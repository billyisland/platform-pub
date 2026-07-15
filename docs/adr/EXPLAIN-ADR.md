# ADR: First-Run Onboarding & the Explain Engine

**Status:** Proposed — supersedes `EXPLAIN-ENGINE-SPEC.md` and `EXPLAIN-LABEL-INVENTORY.md` (both draft). Copy in Appendix A is final pending on-screen review.
**Context date:** July 2026
**Surface:** `/reader` (`WorkspaceView`) desktop. Mobile (`MobileWorkspace`) explicitly out of scope — no hover branch, tap already overloaded; separate ADR when it comes into scope.

---

## 1. Summary

One engine, two programs:

- **First-run** — a fixed six-beat sequence that auto-runs once per user per device, walks the reader through the essential affordances, and carries the worldview (non-algorithmic feeds, universal ingestion, open protocol). Dismissable in one gesture.
- **Explain** — a contextual annotator, invoked from a permanent ∀-menu row, that labels every explainable object currently on the topmost surface. Plain signage; the ideology lives in first-run and `/about`.

Both produce the same `Annotation[]` and share anchoring, stepping, hover, dismiss, and layering. The engine treats copy as data; all copy is in Appendix A.

**Division of labour (decided this session):** first-run editorialises, Explain describes. Explain labels contain at most trace personality; every "why" claim beyond one sentence belongs in first-run or the About pane.

---

## 2. Current state (verified against the codebase)

- **Z-bands.** Glasshouse scrim `z-[55]` `.gh-scrim` (blur + wash), pane `z-[56]` (`Glasshouse.tsx:8-12,506-509`); `ForallMenu` chrome at `zIndex: 60` (`ForallMenu.tsx:402,435-436`). The Explain bands in §8 slot beneath these unchanged.
- **Presence registry.** `useGlasshousePresence` exists with `isOpen` + `close` (`stores/glasshouse.ts:13-23`); `ForallMenu` already reads it to flip the disc glyph.
- **Drag frames.** `Vessel` exposes `onDragFrame` (`Vessel.tsx:87,385`), consumed by `WorkspaceView` (`WorkspaceView.tsx:1314`). Available for bubble suspension (§6).
- **Seen-flag conventions.** `workspace:ceremony_seen:` and `workspace:bring_world_seen:` prefixes in `WorkspaceView.tsx:110-116`. First-run follows this namespace, not the previously drafted `reader:`.
- **Byline hover is occupied.** `PostByline` anchors a 300 ms debounced `AuthorModal` on every linked byline (`PostByline.tsx:26-29,125-146`), hosting `SourceVolume` (5-step weight + RANDOM/TOP, follow-gated, ordering stays chronological, `SourceVolume.tsx:12-35`). Explain must coexist with this (§5, D2).
- **Starter feed.** New owners are seeded a fully editable clone of the `is_starter_template = true` feed on first `GET /feeds` / `bootstrap` (`crud.ts:83-186`, `bootstrap.ts`). Each clone already records its template in `feeds.cloned_from_feed_id` (migration `114`; `schema.sql:1347`; written `crud.ts:106`) — so starter provenance needs no new column, only wire exposure (D7). Beat 1's copy depends on this (D7).
- **First-mount theatre.** `ForallCeremony` (theatrical vessel materialisation) and `BringYourWorld` both fire off the zero-feeds signal on the same mount that would trigger first-run (`WorkspaceView.tsx:110-116,918`). Sequencing required (D6).
- **Parked/dark surfaces.** `TrustPip` is a non-interactive legibility dot; pip panel dormant behind a flag. Upstream-edges tribute is not on the card action row. Both unlabelled and out of the registry until lit.

---

## 3. Decisions

Numbered for reference. D1–D9 resolve the gaps identified in the spec review; D10–D12 carry forward the sound choices from the draft spec unchanged.

### D1 — The floor is inert while Explain is active

While `isActive`, the underlying product does not respond to input. Interaction routing:

- The Explain scrim (§8) is a single full-viewport div that **intercepts all pointer events**. No `pointer-events: none` pass-through. **This includes wheel and touch, so the floor is frozen while Explain is active.** The `/reader` floor is a fixed `overflow:hidden` canvas (`WorkspaceView.tsx:1607`) whose vessels scroll *internally* (`Vessel.tsx:479`); the page itself never scrolls, and the scrim sitting above the vessels swallows their wheel/touch too. So "scroll" cannot reveal new content mid-Explain — the engine annotates the surface exactly as it stands at `open()`. (This is what resolves the draft's scroll ambiguity: D4's "cards mount on scroll" and a live-`scroll` re-measure both assumed a scrollable floor. They don't apply; see D4, D11.) If a frozen surface proves too limiting in review, the sanctioned v2 forwards wheel/touch deltas to the scroll container under the pointer — deliberately deferred, exactly like D9's cutout.
- **Hover** is resolved by the engine from the scrim's `pointermove` via coordinate hit-test against (a) the registration Map's live rects and (b) `document.elementsFromPoint` → `closest('[data-explain]')` for tagged descendants. This makes hover discovery live by construction (no stale snapshot; see D4).
- **Click on a discoverable target** pins that target's annotation: the pinned channel's `index` jumps to the matching annotation (creating one on the fly for hover-only instance targets). Clicks therefore have a job, and it is an Explain job, not a product job. *(Explain program only — first-run ignores clicks entirely: its fixed sequence is driven by Next/Back/arrows and finished by Done/Esc, so a stray click can neither warp the cursor nor mint off-tour annotations. 2026-07-15.)*
- **Click anywhere else** (not a bubble, not the About button, not a target) dismisses, per §7. **The floor registration spans the whole viewport, so a click that hit-tests to the floor counts as "anywhere else" and dismisses** — otherwise the non-target set would be empty and click-dismiss unreachable (the floor's copy stays reachable via hover, and it is the pinned opening annotation). *(2026-07-15 — resolves a latent contradiction between the full-viewport floor target and this dismiss rule.)*
- No product action fires through the scrim. The gear does not open settings; the byline does not open `AuthorModal`; reply does not focus a composer. Explain explains; it does not drive.

*Rationale:* the draft spec's dismiss rules implied a click-catching scrim while its hover channel implied a pointer-transparent one. Those are incompatible. Inert-floor resolves the contradiction, honours the stated non-goal ("does not drive the user anywhere"), and reduces the scrim to one implementation instead of per-target listener plumbing.

### D2 — Native hover surfaces are suppressed while Explain is active

D1 already prevents `AuthorModal` from opening (events never reach the byline), but belt-and-braces: `useAuthorHover` early-returns when `useExplain.getState().isActive`, so a modal already open at Explain-activation time closes rather than lingering under the scrim. Same guard on any future hover affordance (pip panel, if unparked).

### D3 — Chrome swap wins; the toggle dismiss is deleted

While active, `ForallMenu` swaps the disc + wordmark for the **"About all.haus"** button (subscribing to `isActive`), at the same z-60 layer, disc glyph machinery untouched. The swap is not cosmetic: the disc sits at z-60 **above** the Explain scrim (z-50), so it is the one live control during Explain — swapping it to About gives it a defined, safe job instead of a floor-toggle that would fire through. Since the ∀ disc is therefore unreachable, the draft spec's "re-select the ∀ Explain row to toggle off" dismiss gesture **cannot exist and is removed**. Dismiss is Esc / empty-click / first-run's "done" only (§7). The About button opens `/about` as a standard Glasshouse pane (existing machinery whole: scrim, ✕, Esc, scroll-lock, `useGlasshousePresence` — the same pattern `SurfaceOverlay` uses for `/pub/:slug/about`). While the About pane is open, the swapped chrome is suppressed (the pane owns its own dismiss); restored on pane close.

**Anchoring — resolves Open-1.** Both programs set `isActive`, so **first-run also swaps** the disc to About; there is never a moment during any program when the ∀ glyph is on screen. The `disc`-position annotation (first-run beat 4 and the Explain `disc` label) therefore anchors its leader to the **About button** — the control actually on screen — and **leads with the About button's current function**, then notes the ∀-menu role the corner resumes once Explain closes. This keeps the engine's point-at-what-is-there contract (D4) instead of describing an invisible ∀. Beat 4 additionally avoids naming "Explain" (not yet introduced at that beat), saying "the rest of the time" rather than "when Explain is off"; the Explain label may name it (the user is in Explain). Copy in Appendix A is written to this. The earlier "decide on-screen" is closed.

### D4 — Discovery: registered roots + delegated leaves; sequence gets a snapshot, hover gets live resolution

- **Roots register** (`useExplainable`): `floor`, `disc` (singletons), each `vessel` (per `feedId`, `order: sortRank`, `params: { feedName }`). Live refs, survive drag/reorder/mount churn via the `ExplainProvider` Map.
- **Leaves are tagged** (`data-explain="…"`): `vessel.name`, `vessel.gear`, `vessel.hide`, `vessel.addSource`, `vessel.resize` inside `Vessel`/`VesselBar`; `card`, `card.byline`, `card.reply`, `card.quote` inside the post components.
- **The sequential program** is built once at `open()`: registered roots ∪ tagged descendants *at that moment*, ordered floor → vessels by `sort_rank` (sub-anchors immediately after their vessel) → disc last (the handoff). If a sequenced target deregisters mid-run, advance `index` to the next live annotation (close if none).
- **The hover channel never consults the snapshot.** It resolves from the pointer per D1, so a card that mounts after `open()` via **async ingestion** is immediately hoverable. (Scroll cannot introduce one — the floor is frozen, D1 — so live resolution's remaining job is the ingestion case, not scroll.)

### D5 — Card kinds: one representative instance in the sequence, every instance on hover

Card kinds (`card`, `card.byline`, `card.reply`, `card.quote`) would otherwise multiply the sequence by the number of visible cards. Rule: each card kind contributes **one** sequential annotation, anchored to the topmost fully visible card in the first (lowest `sort_rank`) vessel that has cards. All instances remain hover-discoverable. If no vessel has cards, card kinds are omitted from the sequence and remain hover-only.

### D6 — First-run entry: sequenced after the ceremony, gated on content, seen-on-open

Entry condition, all of: (a) `workspace:firstrun_seen:<userId>` unset; (b) `ForallCeremony` not pending/playing — first-run subscribes to ceremony completion (or its seen-flag being pre-set) rather than racing it; (c) `BringYourWorld` not showing; (d) the workspace has ≥ 1 vessel rendered.

Beat readiness: beat 3 anchors `card.byline`, which requires a rendered card with a linked byline. Wait up to **4 s** after (a)–(d) for the first vessel to render one; on timeout, run anyway with beat 3 free-floating (D8). Ingestion is async and must not be able to hold onboarding hostage.

The seen-flag is written when first-run **opens**, not on completion, so a one-gesture dismiss counts as seen (contract: dismissable in one gesture, never again). Per-device localStorage is accepted (mirrors ceremony); the copy consequence is handled by D7.

### D7 — Beat 1 (and the `vessel` label) fork on starter provenance

Per-device flags mean an established user on a new machine replays first-run against a workspace that may contain months of their own curation, not the Billy Island starter. The provider therefore checks whether the anchored feed is the starter clone and selects the copy variant accordingly.

**Provenance is already recorded — do not add a column.** Every starter clone already links back to its template via `feeds.cloned_from_feed_id` (migration `114`; `schema.sql:1347`; written at seed time in `crud.ts:106`). "Is this the starter clone?" is therefore `cloned_from_feed_id` resolves to a feed with `is_starter_template = true` — never name equality, and strictly more robust than a boolean (it survives a renamed/edited starter and multiple templates). The earlier draft's proposed `seeded_from_starter`/`source_template_id` column is redundant and is cut; no migration, no `schema.sql` regen.

The only real gap is the wire: `cloned_from_feed_id` is used internally in `crud.ts` but is **not** on the `GET /feeds` feed object today. Expose it as a **computed boolean** (the client has no template id to compare against, and we must not leak another feed's id) — add to each `FeedRow`-building SELECT (`crud.ts:192`, `crud.ts:292/350`, `loadFeed` `shared.ts:38`):

```sql
EXISTS (SELECT 1 FROM feeds t
        WHERE t.id = f.cloned_from_feed_id AND t.is_starter_template) AS from_starter
```

then `from_starter: boolean` on `FeedRow` (`shared.ts:10`), `fromStarter` in `feedRowToResponse` (`shared.ts:21`), and `fromStarter: boolean` on the frontend `WorkspaceFeed` (`web/src/lib/api/feeds.ts:7`). A freshly `createFeedForOwner`'d feed has no `cloned_from_feed_id`, so `from_starter` is `false` by construction — correct. The provider reads `feed.fromStarter` off the anchored vessel:

- **Starter present** → the "copied from a feed belonging to Billy Island" copy (Appendix A).
- **Not the starter** → the neutral variant (Appendix A, marked ★).

Same fork for the Explain `vessel` label, keyed per-vessel: the provenance copy renders only on the actual starter clone; all other vessels get the neutral variant.

### D8 — Anchor-or-float, decided per beat

Resolves the draft's open question 2. First-run beats resolve their targets from the live registry at `open()`. Beats 1–4 anchor where their target exists and **free-float centred** where it does not (beat 3 being the realistic case, per D6). Beats 5–6 are floor beats and always free-float over the floor (the floor "anchor" is the frame, not a point; no leader line). Explain-program annotations always anchor (their targets were discovered, so they exist).

### D9 — Scrim: light dim, no blur, no cutout in v1

Explain scrim is a flat wash at **≤ 0.18 alpha**, no `backdrop-filter` — feeds must stay legible behind their own labels (the deliberate inversion of `.gh-scrim`, whose blur suppresses identity). **No spotlight cutout in v1**: elevating the active vessel above a fixed sibling scrim is unreliable (framer-motion transforms create stacking contexts), and a masked-hole scrim turns one div into geometry. The light dim keeps the active target readable without special-casing it. If review finds the active target insufficiently distinguished, the sanctioned v2 is a four-rectangle scrim around the active rect — not z-index games with transformed vessels.

### D10 — Topmost-surface rule, stated as what v1 does

Panes register no targets in v1. Therefore: while any Glasshouse is open, the ∀-menu **Explain row is disabled** (dimmed, with title text "close this pane to use Explain"). Discovery never has to arbitrate occlusion. The registration Map remains the seam: when pane interiors come into scope, panes register their own targets and discovery keys off the presence registry to pick the surface. The draft's general visibility oracle ("visible, in viewport, not behind a higher-z surface") is retired as a v1 requirement.

### D11 — Anchoring, measurement, drag (carried forward, unchanged)

Bubbles position from the target's live `getBoundingClientRect()`, measured when the target becomes active (pinned) or on hover-resolve (hover) — never all up front, never cached. Re-measure the active target via `ResizeObserver` — on the floor container (vessel add / remove / resize) and, while a target is pinned, on that target's own vessel scroll container as well (async ingestion can reflow a vessel's interior under the pinned card, a shift a floor-level observer misses). **No `scroll` trigger** — the floor is frozen while Explain is active (D1), so the pre-`open()` clip state is the only one; the partially-scrolled / fully-scrolled-out clauses below describe that frozen state, not live scrolling. During a vessel drag: **suspend** the pinned bubble (restore on `onDragEnd` via the existing `onDragFrame`/drag callbacks), suppress hover. A bubble chasing a dragged object is noise. Placement: side with most free room (right → left → below → above), clamp into viewport; 2 px crimson leader from target edge midpoint to bubble anchor edge, 4 px dot at the target end; partially-scrolled target → anchor to the visible clip edge; fully scrolled out → drop the leader, pin to the vessel header. Reduced motion (`lib/workspace/motion`): no leader draw, no slide; opacity steps only.

### D12 — State machine, store, layering (carried forward with D1/D3 amendments)

`idle → active` on `open(program)`, back on `close()`. Within `active`, two concurrent channels, no mode enum: **pinned** (sequential cursor `index`, driven by next/prev/click-pin per D1) and **hover** (transient, does not touch `index`; while showing, the pinned bubble dims by opacity and restores on leave). Zustand store per overlay-store conventions, **no history push** — Explain is ephemeral chrome, not a shareable URL.

```ts
interface ExplainState {
  isActive: boolean;
  program: Program | null;
  annotations: Annotation[];        // resolved at open()
  index: number;                    // pinned cursor
  hover: { kind: ExplainKind; key?: string } | null;
  open: (p: Program) => void;
  next: () => void;
  prev: () => void;
  pin: (t: { kind: ExplainKind; key?: string }) => void;   // D1 click-pin
  setHover: (t: ExplainState["hover"]) => void;
  close: () => void;
}
```

Esc precedence (highest first): open Glasshouse → Explain → ForallMenu dropdown. One capture-phase handler in the engine early-returns when `useGlasshousePresence.getState().isOpen`, letting the pane consume Esc (`Glasshouse.tsx:484-487` unchanged). Closing About returns to Explain; exiting Explain returns to the floor.

---

## 4. Registry (`ExplainKind`, v1)

Supersedes the draft spec's §2 union (which predated the byline re-anchoring and still carried `source.volume`). `source.volume` is **not a kind** — volume is taught at `card.byline`. `vessel.numeral` is **cut** (folded into `vessel`; the registry ships no copyless kinds). `card.pip` stays unlabelled (parked). Reserved `[next]` kinds (menu-open sub-program; pane interiors incl. `pane.feedComposer.*`) keep their inventory ids but ship no copy and no registration.

```ts
type ExplainKind =
  // singletons
  | "floor" | "disc"
  // per-feed instance + tagged leaves
  | "vessel" | "vessel.name" | "vessel.gear"
  | "vessel.hide" | "vessel.addSource" | "vessel.resize"
  // card kinds — representative-instance in sequence (D5), all instances on hover
  | "card" | "card.byline" | "card.reply" | "card.quote";
```

Twelve kinds. Explain's derived order: `floor` → per-vessel (`vessel`, then its leaves) by `sort_rank` → card kinds (representative instance, D5) → `disc` last.

---

## 5. Layering

| Band | z | What | Note |
|---|---|---|---|
| floor + vessels | base | the `/reader` objects | inert while Explain active (D1) |
| Explain scrim | z-50 | flat dim ≤ 0.18, no blur, catches all pointer events | D1, D9 |
| Explain bubbles + leaders | z-52 | pinned + hover | crisp above the dim |
| Glasshouse scrim | z-55 | About backdrop (blur) | only while About open |
| Glasshouse pane | z-56 | About content | |
| ForallMenu / swapped chrome | z-60 | disc ⇄ "About all.haus" | suppressed while About pane open (D3) |

---

## 6. Dismiss & persistence

- **Explain:** Esc (subject to precedence, D12) or click on any non-target, non-bubble, non-About region — **including the floor** (the full-viewport floor target counts as empty for clicks, D1). Completing the last sequential step is **not** an auto-dismiss (re-reading and hovering remain available). No toggle dismiss (D3).
- **First-run:** Esc or the explicit "done" affordance on beat 6 — one gesture kills it. Clicks are inert during first-run (D1): they neither dismiss (a reflex click must not lose a mid-tour state) nor pin.
- **Seen-flag:** `localStorage["workspace:firstrun_seen:" + user.id] = "true"`, written at open (D6). Per-device; copy fork per D7 makes that safe.

---

## 7. Edge cases

- **Glasshouse open when the row is reached** → row disabled (D10); the case where discovery must arbitrate surfaces cannot arise in v1.
- **Drag mid-Explain** → pinned suspended, hover suppressed (D11).
- **Active target deregisters** (feed hidden/deleted mid-run) → advance `index` to next live annotation; close if none.
- **Zero targets at `open()`** → no-op + log. With D6's gating this should now be genuinely unreachable for first-run rather than aspirationally so.
- **New device, established user** → first-run replays with neutral beat 1 (D7).
- **Scrolled/clipped targets, reduced motion** → per D11.

---

## 8. Integration points

- `ExplainProvider` — wraps the floor; holds the registration Map.
- `WorkspaceView` — mounts the overlay layer (scrim + bubble renderer); runs the D6 entry check subscribed to ceremony state; passes drag suspend signals.
- `Vessel` / `VesselBar` — `useExplainable` on the vessel root; `data-explain` on name / gear / hide / add-source / resize.
- `PostCardInteractive` / `PostByline` / `PostActions` — `data-explain` on card chassis / byline / reply / quote; `useAuthorHover` gains the D2 guard.
- `ForallMenu` — Explain row (own group, single primary option, keep the menu slim; disabled per D10) → `open({kind:"explain"})`; subscribes to `isActive` for the chrome swap; swapped chrome suppressed while About pane open.
- `gateway` (`crud.ts` / `shared.ts` feed reads) — expose the existing `cloned_from_feed_id` provenance as a computed `from_starter` boolean on the feed wire object; no new column (D7).

---

## 9. Build order

1. Registry + `ExplainProvider` + `useExplainable` + `data-explain` tagging (D4; no UI yet).
2. Store + scrim + pointer routing + hit-testing (D1, D12) with a stub bubble.
3. Bubble renderer: placement, leader, measurement/invalidation, drag suspension, reduced motion (D11, D9).
4. Explain program: derived ordering + representative-instance rule (D5); ∀-menu row + disable rule (D10); chrome swap + About pane + suppression + Esc precedence (D3, D12).
5. First-run program: ceremony sequencing, content gate, seen-flag, provenance fork, anchor-or-float (D6–D8).
6. Copy pass on-screen against Appendix A (the `disc`-label anchoring is decided — D3, Open-1 resolved).

---

## 10. Open (deliberately deferred)

1. **`disc` label anchoring — RESOLVED (D3).** The `disc`-position annotation anchors to the About button and leads with its current function, since both programs swap the disc and the ∀ glyph is never on screen during a program. Copy is written to this (Appendix A). Retained here only as a pointer; no longer open.
2. Sequential completion affordance on beat 6 — current copy carries "press Explain any time"; whether it also gets a distinct visual "done" treatment is a design-pass call.
3. Pane-interior Explain, menu-open sub-program, mobile — all `[next]`, seams reserved (D10, §4).
4. Server-side seen-flag — revisit only if D7's fork proves annoying in practice.

---

## Appendix A — Copy (final draft, this session)

Copy is data; the engine renders it verbatim. No em-dashes anywhere by editorial rule. First-run editorialises; Explain labels are signage.

### A.1 First-run (six beats)

**1 · `vessel` — starter variant (D7)**
> This is a feed: a list of sources plus the weights you have given them. This one is copied from a feed belonging to Billy Island, founder of all.haus, and for better or worse it reflects his interests. It's yours now. Change it or delete it as you see fit.

**1★ · `vessel` — neutral variant (D7)**
> This is a feed: a list of sources plus the weights you have given them. It's yours to change or delete as you see fit.

**2 · `vessel.addSource`**
> You can add a source here: a writer, a blog, a newsletter, a tag, or almost anything else that publishes. Everything arrives in one place and reads the same way, so you don't need a separate app for each.

**3 · `card.byline`** *(free-floats if no card rendered, D8)*
> Hover over a name to follow that person and set how prominent they are in this feed. It's basically a volume knob: louder, quieter, or mute. The mixing is done by you, not for you.

**4 · `disc`** *(anchors to the About button; leads with About, D3)*
> This is About: the full account of what all.haus is and how it works, worth reading once. The rest of the time, this same corner is your menu, the one place everything runs from: writing, searching, your messages, your money, your settings. There is no other interface to learn.

**5 · `floor`** *(free-floats, D8)*
> Make as many feeds as you like and arrange them however suits you. They stay where they are put.

**6 · `floor`** *(free-floats, D8; carries the "done" affordance)*
> There is no algorithm here. Your feeds run in order of time, weighted by you and answerable to nobody else. Whatever you publish lives on an open protocol and remains yours wherever you take it. The public square should not have a landlord.
>
> You can press **Explain** at any time to be shown how anything works.

### A.2 Explain labels — Tier 1

**`floor`**
> This space is yours to fill with feeds. You can have as many as you want, configured as you like and positioned however suits you. They stay where they are put.

**`vessel` — starter clone only (D7)**
> A feed is a list of sources plus the weights you have given them. To get you started, this one is copied from a feed belonging to Billy Island, founder of all.haus. For better or worse, it reflects his interests. Change what's in it, or delete it if you want to start fresh.

**`vessel` ★ — all other feeds (D7)**
> A feed is a list of sources plus the weights you have given them. Change what's in it, or delete it if you want to start fresh.

**`vessel.name`**
> This is the feed's name. Click to rename it and manage its sources, or click and drag to move the feed container around this workspace.

**`vessel.gear`**
> Each feed's individual settings live behind this button: renaming, appearance, the full list of sources, and deletion.

**`vessel.hide`**
> This hides the feed without destroying it. Restore a hidden one from the menu at any time.

**`vessel.addSource`**
> Type here to add a source: a writer, a blog, a newsletter, a tag, or almost anything else that publishes. It all arrives in the same place.

**`vessel.resize`**
> Drag this corner to make the feed bigger or smaller.

**`disc`** *(anchors to the About button, D3)*
> Right now this opens About: a fuller account of what all.haus is and how it works. When Explain is off, this same corner is the ∀ menu, where everything runs from: writing, searching, your messages, your money, your settings. There is no other interface to learn.

### A.3 Explain labels — Tier 2

**`card`**
> This is one item from one of the feed's sources, shown in the order it arrived.

**`card.byline`**
> Hover over the name to follow this person and set how prominent they are in this feed. It's basically a volume knob: louder, quieter, or mute.

**`card.reply`**
> This posts a reply, which appears in the thread underneath the original.

**`card.quote`**
> This quotes the item into a post of your own, so you can add your thoughts on top. The original stays attached and attributed.

### A.4 Copy notes

- Deliberate duplications: "they stay where they are put" (beat 5 ↔ `floor` label) and the volume-knob line (beat 3 ↔ `card.byline` label). A user typically meets only one surface per session; the repetition harmonises rather than clashes.
- The Billy Island provenance appears in beat 1 and the starter `vessel` label by the same reasoning, and only ever on the actual starter clone (D7).
- Cut kinds: `vessel.numeral` (folded into `vessel`), `source.volume` (superseded by `card.byline`), `card.pip` (parked, unlabelled).
- Source-type list in add-source copy is aspirational by decision; revisit at launch against what `feed-ingest` actually accepts.

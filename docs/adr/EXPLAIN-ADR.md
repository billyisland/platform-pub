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

### Post-live amendments (2026-07-15)

The first live session on production reversed four calls; the decision texts below carry dated notes where they changed:

1. **First-run auto-entry is dormant.** Landing in Explain mode on load without asking for it read as a malfunction, not a welcome. `FirstRunController` is no longer mounted (kept intact in `ExplainProvider.tsx` for revival); Explain is strictly ∀-menu-invoked (amends D6).
2. **The Explain hover bubble renders at the cursor**, tooltip-style (one persistent bubble, copy swaps in place), not element-anchored — anchoring to a large target's rect scattered bubbles far from the pointer (amends D11 for the Explain program; first-run pinned beats keep anchored placement + leader).
3. **The Explain pinned channel is not rendered** (and click-pin is deleted; any click dismisses). The index-0 floor bubble + the 0.35-alpha dim while hovering meant a ghost bubble was near-permanently on screen — the floor target spans the viewport, so hover was never empty (amends D1/D12; the pinned channel now renders only in first-run).
4. **The chrome swap replaces only the wordmark.** The ∀ disc stays on screen during a program, registers as the `disc` explainable root, surfaces the `disc` label on its own hover, and its click exits Explain (About pane open → closes that first, glyph flips to X). The "About all.haus" button takes the wordmark's spot and carries a new hover-only `about` kind (rewrites D3; the disc copy now describes the disc).

### Second-session amendments (2026-07-15, Explain over panes)

5. **D10 is reversed — Explain annotates an open Glasshouse.** The ∀-menu Explain row is never disabled: with a pane open, `resolveExplainProgram` returns a **pane-surfaced program** (`Program.surface: "floor" | "pane"`) whose sole resolved annotation is the new **`pane`** kind, tagged on the Glasshouse pane root (`Glasshouse.tsx`) so every pane inherits it; everything else is hover-discovered live from `[data-explain]` tags inside the pane, the same delegated-leaf model as the floor. In pane mode the scrim rises to z-57 and the cursor bubble to z-58 (above the pane's z-55/56 bands, under the ForallMenu's z-60); hit-testing resolves **only** tags inside the pane root — the frozen floor visible through nothing but the gh-scrim never answers; focus/ARIA freezing targets the pane instead of the vessel roots; and the pane closing (Esc — precedence unchanged, the pane consumes it first — or any store-side close such as a popstate) **closes Explain with it**, rather than falling back to the floor mid-frost. Per-surface interior kinds arrive with the caption slices; until then the pane root answers every interior hover.
6. **The wordmark→About swap is floor-mode only.** During a pane-mode program the wordmark stays put: clicking "About all.haus" would open a pane that *supersedes the very pane being explained* (the one-Glasshouse rule) — a rug-pull.
7. **The desktop disc never flips to the X for open panes** (`ForallMenu`). The six-destination close-on-click was mobile's minimise-X bleeding into a surface already carrying ✕ / Esc / scrim-click, and it made the menu — and therefore Explain — unreachable over any pane. The disc now always toggles the menu on desktop (the dropdown renders at z-60, above every Glasshouse; destination-hopping rides the supersede rule); the only desktop X left is Explain's own (About pane open → X closes back to Explain). Mobile is untouched (the disc-X remains a sheet's sole dismiss affordance there). The menu's Explain group is now an **Explain / About pair on desktop** and **About alone on mobile** (Explain has no hover branch there; `AboutOverlay` mounts on both branches). *(2026-07-16, amendment 11: About has since left the desktop menu — Explain alone remains.)*

### Third-session amendments (2026-07-16)

8. **D1 is softened: frozen for clicks, live for scroll.** The Explain scrim forwards wheel events to the scrollable element under the cursor (`ExplainOverlay.tsx::handleWheel`: deepest non-chrome element from `elementsFromPoint`, then the nearest ancestor scrollable in the gesture's axis — the same element the wheel would have reached with no scrim), then re-runs the hit-test at the unmoved pointer so the caption tracks what scrolled into place. This is the sanctioned "v2 forwards pointer deltas" seam D1 anticipated, scoped to scroll only: clicks stay dead, both surfaces (pane bodies, Messages columns, vessel interiors) scroll under annotation. **First-run keeps the fully frozen surface** — its pinned bubbles anchor to element rects and D11 deliberately has no scroll re-measure trigger.
9. **The `card` label forks on card flavour.** A second per-instance fork joins D7's vessel provenance: `PostCard` derives a flavour from the post (`registry.ts::explainCardFlavour` — native article / native note / external nostr / atproto / activitypub / rss / email; native = protocol nostr + custodial pubkey, mirroring `isNativePost`) and the chassis carries it as **`data-explain-param`** on the `data-explain="card"` element. The hit-test reads the attribute into `HoverTarget.param` (part of hover identity, so sweeping between adjacent cards of different flavours swaps copy), and `explainCardCopy(param)` resolves it against `CARD_FLAVOUR_COPY`, falling back to the generic `card` label for unrecognised flavours. The param channel is generic — any future kind needing per-instance copy rides the same attribute.
10. **All caption prose lives in `web/src/lib/explain/copy.ts`** — one strings-only file (`EXPLAIN_LABELS`, `CARD_FLAVOUR_COPY`, `VESSEL_COPY`, `FIRST_RUN_COPY`), imported by `registry.ts`, which keeps the machinery (kind union, flavour derivation, resolvers, sequence orders). Appendix A remains the editorial record; `copy.ts` is the implementation home to edit at will — the `Record<…Kind, string>` typing fails the build on a deleted or misnamed caption.
11. **About leaves the desktop menu.** The desktop Explain group is **Explain alone** (amends amendment 7's pair); About on desktop is reached through Explain's own "About all.haus" button (the floor-mode wordmark swap, D3) or the `/about` page. Mobile keeps **About alone** (no Explain there). `AboutOverlay` stays mounted on both branches (`WorkspaceView`) — the Explain-path open depends on it. Consequence, accepted: with a pane open on desktop (pane-mode Explain suppresses the wordmark swap, amendment 6), About is not reachable from the workspace chrome until the pane closes.

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
- **Hover** is resolved by the engine from the scrim's `pointermove` via coordinate hit-test against (a) the registration Map's live rects and (b) `document.elementsFromPoint` → `closest('[data-explain]')` for tagged descendants. This makes hover discovery live by construction (no stale snapshot; see D4). *(2026-07-15: the hover bubble renders AT the cursor — see amendment 2 — and the z-60 chrome the scrim never sees, the disc + About button, reports its own hover to the store.)*
- **Any click dismisses** *(2026-07-15 form, amendment 3 — click-pin is deleted: the hover bubble already rides the cursor, so pinning duplicated it, and the perpetually-dimmed pinned bubble read as half-triggered noise)*. First-run still ignores clicks entirely: its fixed sequence is driven by Next/Back/arrows and finished by Done/Esc, so a stray click cannot dismiss a mid-tour state.
- No product action fires through the scrim. The gear does not open settings; the byline does not open `AuthorModal`; reply does not focus a composer. Explain explains; it does not drive.

*Rationale:* the draft spec's dismiss rules implied a click-catching scrim while its hover channel implied a pointer-transparent one. Those are incompatible. Inert-floor resolves the contradiction, honours the stated non-goal ("does not drive the user anywhere"), and reduces the scrim to one implementation instead of per-target listener plumbing.

### D2 — Native hover surfaces are suppressed while Explain is active

D1 already prevents `AuthorModal` from opening (events never reach the byline), but belt-and-braces: `useAuthorHover` early-returns when `useExplain.getState().isActive`, so a modal already open at Explain-activation time closes rather than lingering under the scrim. Same guard on any future hover affordance (pip panel, if unparked).

### D3 — Chrome swap: wordmark only; the disc stays and is annotated in place *(rewritten 2026-07-15, amendment 4)*

While active, `ForallMenu` swaps only the **wordmark** for the **"About all.haus"** button (same spot, left of the disc, same z-60 layer, islanded like the disc). The **∀ disc stays on screen**: it registers as the `disc` explainable root, reports its own hover to the engine (surfacing the `disc` label — it sits above the scrim, which therefore never hit-tests it), and **its click exits Explain** (with the About pane open, the click closes that first and the glyph flips to the X). Hiding the disc and then explaining "the corner is really a menu you can't currently see" was the original form's awkwardness; now the engine points at the real thing. The draft spec's "re-select the ∀ Explain row to toggle off" gesture still does not exist — the menu never opens over the frozen floor — but the disc click is a sanctioned dismiss alongside Esc / any click (§7). The About button opens `/about` as a standard Glasshouse pane (existing machinery whole: scrim, ✕, Esc, scroll-lock, `useGlasshousePresence`) and carries its own hover-only **`about`** kind; the button is suppressed while the About pane is open (the pane owns its own dismiss), restored on close.

**Geometry.** The About button and the disc are a matched pair — a disc and an elongated disc (the mobile pip-strip grammar): same height (`discSize`, 56), same end radius (`discSize/2`, so the pill's caps carry the disc's curvature), flush on one shared bottom rule (`bottom: 24`). Both must be block-level — the disc trigger sets `display: "block"` explicitly, because a UA-default inline-block button sits on its bottom-anchored container's text baseline and the line box's strut descent (~8px) lifts it off the anchor (fixed 2026-07-15; the pill, a flex button, was never affected).

**Anchoring.** The `disc` annotation (first-run beat 4 and the Explain `disc` label) anchors to the disc itself and describes the ∀ menu directly; the About button is described by its own `about` label. Copy in Appendix A is written to this. (The original D3 form — swap the whole lockup, anchor the disc label to the About button, lead with About — is superseded; it survived one live session, 2026-07-15.)

### D4 — Discovery: registered roots + delegated leaves; sequence gets a snapshot, hover gets live resolution

- **Roots register** (`useExplainable`): `floor`, `disc` (singletons), each `vessel` (per `feedId`, `order: sortRank`, `params: { feedName }`). Live refs, survive drag/reorder/mount churn via the `ExplainProvider` Map.
- **Leaves are tagged** (`data-explain="…"`): `vessel.name`, `vessel.gear`, `vessel.hide`, `vessel.addSource`, `vessel.resize` inside `Vessel`/`VesselBar`; `card`, `card.byline`, `card.reply`, `card.quote` inside the post components.
- **The sequential program** is built once at `open()`: registered roots ∪ tagged descendants *at that moment*, ordered floor → vessels by `sort_rank` (sub-anchors immediately after their vessel) → disc last (the handoff). If a sequenced target deregisters mid-run, advance `index` to the next live annotation (close if none).
- **The hover channel never consults the snapshot.** It resolves from the pointer per D1, so a card that mounts after `open()` via **async ingestion** is immediately hoverable. (Scroll cannot introduce one — the floor is frozen, D1 — so live resolution's remaining job is the ingestion case, not scroll.)

### D5 — Card kinds: one representative instance in the sequence, every instance on hover

Card kinds (`card`, `card.byline`, `card.reply`, `card.quote`) would otherwise multiply the sequence by the number of visible cards. Rule: each card kind contributes **one** sequential annotation, anchored to the topmost fully visible card in the first (lowest `sort_rank`) vessel that has cards. All instances remain hover-discoverable. If no vessel has cards, card kinds are omitted from the sequence and remain hover-only.

### D6 — First-run entry: sequenced after the ceremony, gated on content, seen-on-open

**DORMANT (2026-07-15, amendment 1):** the auto-entry no longer runs — `FirstRunController` is unmounted (kept intact in `ExplainProvider.tsx`). Landing in Explain mode on load without asking for it read as a malfunction on the live site. The gates below remain the spec for any revival.

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

### D10 — Topmost-surface rule, stated as what v1 does *(REVERSED 2026-07-15, amendment 5)*

**Superseded:** Explain now runs over an open Glasshouse as a pane-surfaced program (amendment 5) and the Explain row is never disabled. The original v1 rule below is retained for the record.

Panes register no targets in v1. Therefore: while any Glasshouse is open, the ∀-menu **Explain row is disabled** (dimmed, with title text "close this pane to use Explain"). Discovery never has to arbitrate occlusion. The registration Map remains the seam: when pane interiors come into scope, panes register their own targets and discovery keys off the presence registry to pick the surface. The draft's general visibility oracle ("visible, in viewport, not behind a higher-z surface") is retired as a v1 requirement.

### D11 — Anchoring, measurement, drag

*(2026-07-15, amendment 2: everything below now applies to the **first-run pinned bubble only**. The Explain hover bubble is a cursor tooltip — offset below-right of the pointer, flipping above/left at the viewport edges, clamped to the margin, no leader, one persistent instance whose copy swaps in place — because element-anchored placement put bubbles far from the pointer on large targets, which read as haphazard.)*

Bubbles position from the target's live `getBoundingClientRect()`, measured when the target becomes active (pinned) or on hover-resolve (hover) — never all up front, never cached. Re-measure the active target via `ResizeObserver` — on the floor container (vessel add / remove / resize) and, while a target is pinned, on that target's own vessel scroll container as well (async ingestion can reflow a vessel's interior under the pinned card, a shift a floor-level observer misses). **No `scroll` trigger** — the floor is frozen while Explain is active (D1), so the pre-`open()` clip state is the only one; the partially-scrolled / fully-scrolled-out clauses below describe that frozen state, not live scrolling. During a vessel drag: **suspend** the pinned bubble (restore on `onDragEnd` via the existing `onDragFrame`/drag callbacks), suppress hover. A bubble chasing a dragged object is noise. Placement: side with most free room (right → left → below → above), clamp into viewport; 2 px crimson leader from target edge midpoint to bubble anchor edge, 4 px dot at the target end; partially-scrolled target → anchor to the visible clip edge; fully scrolled out → drop the leader, pin to the vessel header. Reduced motion (`lib/workspace/motion`): no leader draw, no slide; opacity steps only.

### D12 — State machine, store, layering (carried forward with D1/D3 amendments)

`idle → active` on `open(program)`, back on `close()`. Within `active`, two concurrent channels, no mode enum: **pinned** (sequential cursor `index`, driven by next/prev) and **hover** (transient, does not touch `index`). *(2026-07-15, amendments 2–3: the pinned channel renders only during first-run — Explain is hover-only, and hover is suppressed during first-run, so exactly one channel is ever visible and the dim-while-hovering rule is deleted. `pin` remains in the store as a dormant seam.)* Zustand store per overlay-store conventions, **no history push** — Explain is ephemeral chrome, not a shareable URL.

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
  // the About button standing in for the wordmark during a program
  // (hover-only, never sequenced — 2026-07-15, amendment 4)
  | "about"
  // the Glasshouse pane root — the base annotation of a pane-mode program
  // (2026-07-15, amendment 5); per-surface interior kinds arrive with the
  // caption slices
  | "pane"
  // per-feed instance + tagged leaves
  | "vessel" | "vessel.name" | "vessel.gear"
  | "vessel.hide" | "vessel.addSource" | "vessel.resize"
  // card kinds — representative-instance in sequence (D5), all instances on hover
  | "card" | "card.byline" | "card.reply" | "card.quote";
```

Fourteen kinds. Explain's derived order: `floor` → per-vessel (`vessel`, then its leaves) by `sort_rank` → card kinds (representative instance, D5) → `disc` last. *(2026-07-15: the derived order is retained as the seam for a future stepped walk-through, but the live Explain program is hover-only and never walks it.)*

---

## 5. Layering

| Band | z | What | Note |
|---|---|---|---|
| floor + vessels | base | the `/reader` objects | inert while Explain active (D1) |
| Explain scrim | z-50 | flat dim ≤ 0.18, no blur, catches all pointer events | D1, D9 |
| Explain bubbles + leaders | z-52 | pinned + hover | crisp above the dim |
| Glasshouse scrim | z-55 | About backdrop (blur) | only while About open |
| Glasshouse pane | z-56 | About content | |
| ForallMenu / swapped chrome | z-60 | disc stays; wordmark ⇄ "About all.haus" | About button suppressed while its pane is open (D3, 2026-07-15 form) |

---

## 6. Dismiss & persistence

- **Explain:** Esc (subject to precedence, D12), **any click on the scrim** (2026-07-15 form, amendment 3 — click-pin is deleted, so every scrim click is a dismiss), or **a click on the ∀ disc** (amendment 4). The About button keeps its own job (opens the pane). No toggle dismiss (D3).
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

**4 · `disc`** *(anchors to the ∀ disc itself, D3 2026-07-15 form)*
> This is the ∀ menu, the one place everything runs from: writing, searching, your messages, your money, your settings. Next to it, About has the fuller account of what all.haus is and how it works, worth reading once. There is no other interface to learn.

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

**`disc`** *(the real ∀ disc, D3 2026-07-15 form)*
> This is the ∀ menu, where everything runs from: writing, searching, your messages, your money, your settings. There is no other interface to learn. While Explain is on, clicking it simply takes you back to your workspace.

**`about`** *(the About button standing in for the wordmark; hover-only, 2026-07-15)*
> This opens About: a fuller account of what all.haus is and how it works, worth reading once.

**`pane`** *(the Glasshouse pane root — the pane-mode base annotation; 2026-07-15, amendment 5)*
> This is a pane, floating over your workspace. Drag it by any empty part of itself to move it, and it will remember where you leave it. Close it by clicking outside, pressing Escape, or with the ✕ in the corner.

### A.3 Explain labels — Tier 2

**`card`**
> This is one item from one of the feed's sources, shown in the order it arrived.

**`card.byline`**
> Hover over the name to follow this person and set how prominent they are in this feed. It's basically a volume knob: louder, quieter, or mute.

**`card.reply`**
> This posts a reply, which appears in the thread underneath the original.

**`card.quote`**
> This quotes the item into a post of your own, so you can add your thoughts on top. The original stays attached and attributed.

### A.3b Explain labels — pane chrome + Reader interior (C1, shipped 2026-07-16)

All hover-only (pane mode has no sequence by design). The ✕ is deliberately uncaptioned. Wiring notes: the skip ears are siblings of the pane root, so the pane-mode hit-test scopes to the pane's wrapper; the frame strips and a dimmed ear are pointer-events:none, so they are made hit-testable only while a program is active (`explainActive` in `Glasshouse.tsx`).

**`pane.resize`** *(the bottom-right stretch handle, resizable panes)*
> Drag this corner to make the pane bigger or smaller. It will remember the size you choose.

**`pane.frame`** *(the coloured top bar + side rules, feed-launched panes only)*
> This frame takes its colour from the feed you opened this from, so you can tell at a glance where a pane came from. Panes opened any other way go without.

**`pane.ear.prev`** *(left skip ear)*
> This steps back to the previous article in the feed you came from. The ← key does the same.

**`pane.ear.next`** *(right skip ear; carries the ↑/↓ hint for the pair)*
> This steps forward to the next article in the feed you came from. The → key does the same, and ↑ and ↓ scroll the page as you read.

**`reader`** *(the reading surface — ReaderOverlay's scroll body)*
> This is the reader. Anything you open from a feed is read here: pieces by all.haus writers and pieces from elsewhere, all in the same place.

**`reader.gate`** *(the paywall gate, when a paywalled article is showing)*
> This is where the free part of the article ends. Continue and the price is added to your reading tab: you pay only for what you read, and settle the tab later. The tab lives under Ledger in the ∀ menu.

### A.3c Explain labels — writing surfaces (C2, shipped 2026-07-16; copy Ed-approved as drafted)

All hover-only, same as A.3b. Each surface carries a base kind on its scroll body (the `reader` pattern: it answers any hover its leaves don't); the generic `pane` copy keeps answering the pane chrome. Flag-gated affordances (follow-graph import, "Sync now") and transient panels (publish confirm, schedule picker) are deliberately uncaptioned; the long-note nudge's Switch button shares `composer.article`. Wiring notes: `editor.gate` is set in `PaywallGateNode`'s node view DOM (the in-document divider); `ToolbarButton` and `AppearanceControl` gained the optional `dataExplain` prop (the Byline/VesselBar pattern); `feedComposer.volume` tags the whole controls row inside a `feedComposer.source` row, so the row's two ×s resolve to different copy. No engine work was needed — every C2 target is an interactive element inside the pane wrapper.

#### Note composer (`Composer`)

**`composer`** *(base: the composer pane body; the same box serves note, reply and quote modes)*
> This is the note composer. A note is a short post, published under your name to anyone who follows you, here and on the open network beyond. Replies and quotes are written in this same box.

**`composer.crosspost`** *(the per-network toggle pills; present only when a linked network exists)*
> One switch per network you have linked: dark means this note will also post there. The default for each network is set in Settings, under Reach other networks.

**`composer.article`** *(the "Write an article →" affordance)*
> This carries what you have written into the article editor. Articles have no length limit and can take a title, a standfirst, images, tags and a paywall.

#### Article editor (`EditorOverlay` / `ArticleEditor`)

**`editor`** *(base: the editor body)*
> This is the article editor. Write on the page below; the toolbar handles formatting, images, embeds and the paywall. Your work saves itself as a draft while you write.

**`editor.dek`** *(the standfirst field)*
> This is the standfirst: one line under the title saying what the piece is about. It travels with the title on the article's card in feeds, and it is optional.

**`editor.paywall`** *(the toolbar Paywall button)*
> This places a paywall in the article. Everything above the line stays free to read; everything below it is paid. Click again to take it out.

**`editor.gate`** *(the inserted gate line in the document; first sentence deliberately identical to `reader.gate`, the same object seen from the other side)*
> This is where the free part of the article ends. Readers continue past it by paying the price set below, which goes on their reading tab.

**`editor.price`** *(the price field; present only while a gate is inserted)*
> This is what a reader pays to read past the paywall. A suggested price appears based on length, but it is yours to set.

**`editor.tags`** *(the tag input)*
> Tags say what the piece is about. Each tag has its own page collecting everything published under it, and readers can add a tag to their feeds as a source.

**`editor.schedule`** *(the Schedule button; hidden when editing a published article)*
> This publishes the article later, at a time you choose. A scheduled piece waits in your dashboard and goes out on its own.

**`editor.draft`** *(the Save draft button + status)*
> Saving happens by itself as you write; this button saves on demand. Drafts live in the dashboard, under the ∀ menu.

**`editor.publication`** *(the "Publishing as" select; present only with publication memberships)*
> This chooses who the article goes out as: yourself, or a publication you belong to. Depending on your role there, a publication piece may need an editor's approval before it goes live.

#### Feed composer (`FeedComposer`)

**`feedComposer`** *(base: the composer pane body)*
> This is the feed composer: everything about one feed is decided here. Its name, its sources and their volumes, how it looks, and where it sits in the order.

**`feedComposer.addSource`** *(the omnivorous resolver field; first sentence deliberately identical to `vessel.addSource`, one grammar for one gesture)*
> Type here to add a source: a writer, a blog, a newsletter, a tag, or almost anything else that publishes. Paste whatever you have, a username, a URL, an npub or a #tag, and it will be worked out.

**`feedComposer.source`** *(a source row; the volume cluster inside it carries its own kind below)*
> This is one of the feed's sources. Click its name to have a look at it; the × at the end of the row removes it from this feed.

**`feedComposer.volume`** *(the volume steps + sampling chips inside a source row)*
> This is the source's volume in this feed: quieter to the left, louder to the right, and the × in front mutes it without removing it. RANDOM and TOP choose which of its posts get through when it is turned down, and NO REPLIES keeps only its freestanding posts.

**`feedComposer.reach`** *(the Following / Explore chips)*
> These add the site's shared streams to the feed: Following is everyone you follow, Explore is the wider platform. Either can sit alongside individual sources.

**`feedComposer.colour`** *(the Colour appearance control; the swatch-is-the-name point is the teaching goal)*
> This cycles the feed's colour scheme. The swatch is its only name: three bars for the feed's frame, its ground and its cards. Light or dark follows your sitewide appearance setting; the character is the feed's own.

**`feedComposer.view`** *(the View density control)*
> This cycles how much of each post the feed shows: condensed, standard, or full.

**`feedComposer.orientation`** *(the Orientation control)*
> This turns the feed between tall and wide. The symbol is the feed's own container, open on the side it grows from.

**`feedComposer.textSize`** *(the Text size control)*
> This steps the feed's text size, one to five. It belongs to this feed alone; the sitewide type size lives in Settings.

**`feedComposer.order`** *(the drag-to-rank list)*
> Drag the rows to put your feeds in order. The numbers here are the numbers the feeds wear on the floor, and on a phone this is the order you swipe through. Hidden feeds keep their place but wear no number.

**`feedComposer.hide`** *(the Hide/Unhide button; verbatim reuse of `vessel.hide`, one grammar for one gesture)*
> This hides the feed without destroying it. Restore a hidden one from the menu at any time.

**`feedComposer.delete`** *(the Delete button)*
> This deletes the feed for good. If you only want it out of the way, hide it instead.

### A.3d Explain labels — destination surfaces (C3, shipped 2026-07-16; copy Ed-approved as drafted, all four money sites confirmed)

All hover-only, same as A.3b/A.3c. Each of the six ∀-menu destinations carries a base kind on its overlay scroll body (the `reader` pattern; Messages, which is flush, tags the `MessagesInbox` root on both its desktop and mobile returns); the generic `pane` copy keeps answering pane chrome. Wiring notes: `SettingsSection` and `SettingsRow` gained the optional `dataExplain` prop (the ToolbarButton/AppearanceControl pattern); the Library tab bodies are wrapped in plain tagged divs (their components return state-dependent roots); `ledger.allowance` nests inside `ledger.balance` and `settings.discovery` inside `settings.reach` — the hit-test's `closest()` resolves the innermost tag, the same nesting grammar as `feedComposer.volume`. No engine work was needed.

Deliberately uncaptioned: flag-gated affordances (Vouches tab, the thread Commission button, Ledger's pledges section + tributes-reserved block, Analytics tabs, assisted "Set one up", follow-import affordances, PostLinkImportOffer); the publication-context dashboard tabs (Members/Settings/Rate card/Payroll/Earnings — deep conditional surface, named by `dashboard.context`; its own slice if ever wanted); transient panels (schedule picker, gift-links expansion, new-message form, export modal, publication-create form, connect banner); self-describing forms (Profile/Email, notification + reading toggles, danger zone); the read-only Followers tab (base covers it).

#### Messages (`MessagesInbox`)

**`messages`** *(base: the inbox root, desktop three-column and mobile pager alike)*
> This is your inbox, in three parts: notifications on the left, your conversations in the middle, and the open conversation on the right. Everything addressed to you lands somewhere here.

**`messages.notifications`** *(the notifications column, `NotificationsPanel` root)*
> This is the activity log: follows, replies, quotes, mentions, and news from any publication you belong to. Click a row to open the thing it is about; a message notification opens the conversation here in place.

**`messages.new`** *(the New button on the conversation list; echoes the omnivorous "whatever you have" grammar of `feedComposer.addSource`)*
> This starts a conversation. Address it with whatever you have: a username, an email address, an npub.

**`messages.thread`** *(the reading pane, `MessageThread` root)*
> This is the open conversation. Write at the bottom; hover any message to like it or answer it directly. Older messages load from the top.

#### Dashboard (`DashboardPanel`)

**`dashboard`** *(base)*
> This is your dashboard: what you have written, who subscribes to you, what your work earns and what it costs to read. Money itself moves in the Ledger; this is where you run the writing.

**`dashboard.context`** *(the Personal / publication switcher row, incl. "+ New publication")*
> Dashboards come one per identity: your own, and one for each publication you belong to. Switch here, or start a new publication.

**`dashboard.articles`** *(the unified drafts + published table)*
> Drafts and published pieces share this table, drafts first. Schedule a draft and it publishes itself at the time you set; publish it and the draft is cleared away, leaving the piece with its reads and earnings. Replies turns a piece's thread on or off.

**`dashboard.gifts`** *(the Gifts action, paywalled rows only)*
> This makes gift links for a paywalled piece: anyone opening one reads it free. Each link carries a set number of uses and can be revoked.

**`dashboard.pricing`** *(the Pricing tab body)*
> Your prices live here: what a monthly subscription to you costs, and the default price of a paywalled article, either scaling with length or fixed. Getting paid out needs the Stripe connection at the bottom, made once.

#### Library (`LibraryPanel`)

**`library`** *(base)*
> This is your library: pieces you have bookmarked and pieces you have read. Anything here opens straight back into the reader.

**`library.bookmarks`** *(the Bookmarks tab body)*
> Pieces you have saved with the Bookmark action on a card. They stay here until you unbookmark them.

**`library.history`** *(the History tab body)*
> Every piece you have opened, newest first, marked paid or free. What the paid ones actually cost you is in the Ledger.

#### Network (`NetworkPanel`)

**`network`** *(base)*
> This is your network: who you follow, who follows you, and the accounts you have blocked or muted.

**`network.dmFee`** *(the DM access card above the tabs)*
> This puts a price on messages from people you don't follow: set one and a stranger pays it to reach you. Blank means anyone can write free. Overrides give particular people a different price, or none.

**`network.following`** *(the Following tab body; teaches the feed-derived external-follow invariant from the reader's side)*
> Writers you follow on all.haus. Following someone from another network works differently: add them to one of your feeds, and the following is done there.

**`network.blocked`** *(the Blocked tab body)*
> Accounts you have blocked: they disappear from your feeds and can no longer reply to your work. Unblock here.

**`network.muted`** *(the Muted tab body)*
> Accounts you have muted: you no longer see them, and they are not told. To also stop someone replying to you, block instead.

#### Ledger (`LedgerPanel`)

**`ledger`** *(base — carries the approved "this is your reading tab" sentence)*
> This is your ledger: everything your account earns and spends, listed to the penny. Most of it is your reading tab: paid pieces add their price as you read, and the tab settles in one small charge later, not one card form per article.

**`ledger.balance`** *(the Net balance header)*
> One figure for the whole account: what you have earned minus what you have read. In credit, the balance is yours; outstanding, it settles from your card when the tab reaches its threshold.

**`ledger.allowance`** *(the Free allowance meter, when present; nests inside `ledger.balance`)*
> This is your free allowance, spent before the tab is touched: paid reading draws it down first, and only when it is gone do prices start landing on your tab.

**`ledger.transactions`** *(the transaction table + filter pills)*
> Every movement, one row each: reads, settlements, subscriptions, earnings. Filter by direction, or hide the free reads.

**`ledger.subscriptions`** *(the Subscriptions section, when present)*
> Subscriptions you hold. Each row manages its own: whether new pieces reach your email, whether the subscription shows on your profile, and cancelling, which keeps your access to the end of the period.

#### Settings (`SettingsPanel`)

**`settings`** *(base)*
> These are the account's settings: who you are, how you pay and get paid, how far your words travel, and this device's preferences. Anything about a particular feed lives in that feed's composer instead.

**`settings.payment`** *(the Payment & payouts section)*
> The card on file settles your reading tab, at the threshold or monthly, and pays for subscriptions. Stripe Connect is the other direction: it is how your earnings reach your bank.

**`settings.discovery`** *(the Nostr Public/Private block inside Reach other networks; nests inside `settings.reach`)*
> This is your visibility on the open Nostr network. Public publishes your profile beyond all.haus, so people anywhere can find and follow you; Private withdraws it.

**`settings.reach`** *(the Reach other networks section; reciprocates `composer.crosspost`)*
> Networks you have linked, and what each may do: whether your notes crosspost there by default, and whether the people you follow there can be brought into your feeds. The composer's per-note switches start from these defaults.

**`settings.theme`** *(the Theme row)*
> Light or dark for the whole site, on this device; System follows the machine's setting. Feeds keep their own colours in both.

**`settings.typeSize`** *(the Type size row; reciprocates `feedComposer.textSize`)*
> This steps the site's type size on this device. A single feed can be stepped on its own too, from its feed composer.

**`settings.export`** *(the Export button in Your data)*
> This downloads everything that is yours: your keys, your writing, your receipts. The keys are the point: with them, your identity and your audience work anywhere on the open network, not just here.

### A.3e Explain labels — profile + surface overlays (C4, shipped 2026-07-16; copy Ed-approved, minimal set)

All hover-only, same as A.3b–A.3d. The bases ride the overlay scroll bodies: `profile` on ProfileOverlay's (so the native and external branches both inherit it), and `source`/`tag`/`pub` on SurfaceOverlay's, switched on the target kind — the generic `pane` copy keeps answering pane chrome, and the content logs inherit the `card.*` kinds from the already-tagged chassis for free. Wiring notes: the two dropdown controls (`profile.followFeeds`, `profile.identityLinks`) tag their wrapper so trigger and open menu answer alike; `profile.subscribe` is one kind for both subscription states (the Subscribe pair's container and the Subscribed/cancel button), with copy that reads for both; `profile.follow` tags both native toggles (WriterActivity's and ProfileFollowControl's). No engine work was needed.

Deliberately uncaptioned: **AuthorModal and everything inside it** (the feed-scoped FollowButton, SourceVolume) — `useAuthorHover` suppresses the modal while Explain is active, so it is unreachable by construction, and `card.byline` already describes it; flag-gated affordances (Vouch + TrustProfile); logged-out branches ("Log in to follow" — the workspace is login-gated); and, cut as self-describing on editorial review (2026-07-16): the avatar lightbox, the RSS links, the Message button, plus the profile tabs, stats lines, protocol labels, SHOW MORE pagination, masthead member rows, the About view's rendered markdown, and empty states.

#### Profile pane (`ProfileOverlay` — native + external branches)

**`profile`** *(base: the ProfileOverlay scroll body)*
> This is a profile. Writers on all.haus and people from other networks both open here, the same way: who they are, what they have posted, and the ways to follow them.

**`profile.follow`** *(the native Follow/Following toggle: WriterActivity's and ProfileFollowControl's NativeFollowToggle)*
> This follows the writer: their posts reach any of your feeds carrying the Following stream. Everyone you follow is listed under Network in the ∀ menu.

**`profile.followFeeds`** *(the external "Follow ▾" feed-picker; teaches the feed-derived invariant from the doer's side, reciprocating `network.following`)*
> This follows someone from another network, and that works by feed: pick which of your feeds should carry their posts, or start a new one for them. Sitting in at least one feed is what following means.

**`profile.handle`** *(the external @handle out-link, present only with an `externalUrl`)*
> This opens their profile on their home network, in a new tab. The @handle is the one link that leads off all.haus.

**`profile.subscribe`** *(money site; one kind for both subscription states — the card-on-file requirement is left to the 402 error message by decision)*
> This is a subscription to the writer, monthly or yearly: while it runs, their paywalled pieces cost nothing more to read. The charge goes on your reading tab, the subscription is managed from the Ledger, and cancelling keeps your access to the end of the period.

**`profile.identityLinks`** *(the "Link to…" control, external profiles only; teaches Slice-8 dedup)*
> If the same person posts from more than one place, link their accounts here. Your feeds then treat those accounts as one person, and a piece posted to several networks shows only once.

#### Surface overlay (`SurfaceOverlay` — source / tag / publication)

**`source`** *(base: the scroll body when the target is a source — a stream, not a person; it carries none of the profile affordances)*
> This is a source's own page: what it publishes, newest first, as far back as all.haus has seen. To keep it in your workspace, add it to one of your feeds.

**`tag`** *(base: the scroll body when the target is a tag; second sentence deliberately reciprocates `editor.tags`)*
> This is a tag's page, collecting every article published under it. A tag can be added to a feed as a source, like anything else that publishes.

**`pub`** *(base: the scroll body when the target is a publication, all four views)*
> This is a publication: writers publishing together under one name, with a masthead, an archive and followers of its own.

**`pub.nav`** *(the home | about | masthead | archive view nav)*
> These are the publication's pages: its latest pieces, what it is, who makes it, and everything it has published. Each opens here in place.

**`pub.follow`** *(PubFollowButton; follow feeds the Following reach stream, and `notify_on_publish` defaults true)*
> This follows the publication: its new pieces reach any of your feeds carrying the Following stream, and arrive by email until you say otherwise.

### A.4 Copy notes

- Deliberate duplications: "they stay where they are put" (beat 5 ↔ `floor` label) and the volume-knob line (beat 3 ↔ `card.byline` label). A user typically meets only one surface per session; the repetition harmonises rather than clashes. `pane.resize` opens with the `vessel.resize` sentence by the same reasoning: one grammar for one gesture.
- The Billy Island provenance appears in beat 1 and the starter `vessel` label by the same reasoning, and only ever on the actual starter clone (D7).
- Cut kinds: `vessel.numeral` (folded into `vessel`), `source.volume` (superseded by `card.byline`), `card.pip` (parked, unlabelled).
- Source-type list in add-source copy is aspirational by decision; revisit at launch against what `feed-ingest` actually accepts.

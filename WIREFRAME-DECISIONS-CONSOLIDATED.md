# WIREFRAME DECISIONS — CONSOLIDATED

*Compiled from the wireframing pass. April 2026. Supersedes WIREFRAME-DECISIONS.md (Steps 1–3) and WIREFRAME-DECISIONS-STEPS-5-6.md.*

This document records every design decision taken during Steps 1–9 of the wireframe plan. It is the single reference for committed wireframe-level choices. Read alongside PRINCIPLES.md and WORKSPACE-DESIGN-SPEC.md; where this document and the spec diverge, the divergence is flagged with reasoning.

---

## Step 1 — The ⊔ rendering study

### Committed: Variant A

Five variants produced and tested at primary and dim brightness on grey-100.

**Canonical ⊔ proportions:**

- Wall weight: 8px (0.5rem).
- Interior padding: 16px (1rem).
- Card inset from walls: 0px (cards fill the interior; their own internal padding handles content breathing room).
- Inter-card gap: 12px.
- Default width at standard density: 300px (flexible — resizable by user).
- Aspect ratio at rest: approximately 1:2.2 (portrait, taller than wide).
- Opening: full width of the vessel interior (walls stop at the top edge; no narrowing).

**Rejected variants:**

- B (6px walls) — fails at dim. Reads as borders, not structure.
- C (8px walls, 320px width, 20px padding) — eats carrying capacity at the workspace level.
- D (10px walls) — competes with content for attention. At dim, walls become the most salient element.
- E (8px sides, 12px base — tapered) — asymmetry complicates horizontal-strip rotation.

**Crimson at dim:** Pass. Desaturated crimson (#C4545A) on dimmed card background (#E8E7E2) retains sufficient contrast.

---

## Step 2 — Density × brightness matrix

Nine frames tested: three densities (compact, standard, full) crossed with three brightness levels (primary, medium-bright, dim).

### Density differentiation: Pass

The three states read as categorical, not gradual.

- **Compact** — scannable title list; a table of contents.
- **Standard** — the reading default; enough context to decide whether to engage.
- **Full** — immersive mode; everything the platform knows about the item.

### Compact density

- Header row collapses entirely. Trust pip moves inline before the title at 9px diameter (down from 11px).
- Paywall status: crimson £ glyph after the title. The full chip is too heavy for this register.
- Action strip hidden. Long-press reveals actions at content scope.

### Full density

- Thumbnail renders below standfirst, above source attribution.
- Source attribution (VIA NOSTR · NPUB1CRA…) in IBM Plex Mono caps at the quietest register.

### Crimson across all densities at dim: Pass

Paywall chip, £ glyph, and voted-upvote arrow all hold at dim.

### Medium-bright as default: Confirmed

Walls at #4A4A47, cards at #F5F4F0. Invites a salience decision without being assertive or recessive.

### Carrying-capacity finding

Full density at 280–300px width is tight: two cards fill the visible vessel. Standard fits three. Compact fits six or more. The density control is load-bearing for workspace economics.

---

## Step 3 — Workspace at rest

Three scenarios tested: empty, moderate, crowded.

### The room test: Pass

Across all three scenarios the arrangement reads as objects in a space rather than widgets in a grid. Contributing factors: material weight of walls, continuous grey-100 floor, brightness-as-depth, absence of alignment gridlines.

### Empty scenario (first login)

Single vessel centred reads as invitation. Surrounding grey-100 is conspicuously empty. ∀ present in bottom-right without intruding. Founder's feed at medium-bright.

### Moderate scenario (everyday)

Four feeds at mixed brightnesses, densities, and orientations produce a three-axis gradient. Each axis does different work: brightness controls salience, density controls information load, orientation controls attentional mode.

### Crowded scenario (carrying-capacity pressure)

Seven feeds fill the workspace. Pressure is visible and productive. User has responded: four compact, one horizontal strip, three dim. Two primary-brightness standard-density feeds are the expensive items. No room for an eighth at standard density without dimming or compressing. The frame does not look broken.

### No-overlap rule: Confirmed

No overlap in any scenario. All vessels tile with floor visible between them.

### Horizontal strip: Works

The ⊔ rotated 90° reads correctly. Compact titles run left-to-right as a scan line. Name label repositions alongside the opening.

---

## Step 4 — The ∀ workspace control

### Committed: Bottom-right corner

The ∀ sits in the bottom-right corner of the workspace floor.

- Rendered in crimson (#B5242A).
- Tap opens a black menu growing upward from the mark.
- Four menu items in IBM Plex Mono caps: NEW FEED, NEW NOTE, FORK FEED BY URL, RESET LAYOUT.
- Two separators: creation actions grouped (new feed, new note), utility actions grouped (fork, reset).

**Rejected positions:**

- Floating edge — no problem it solves. The ∀ is a fixed affordance.
- Top-right — collides with the topbar.
- Top-left — same topbar collision, worst thumb reach on mobile.
- Bottom-left — tighter corridor, worse thumb reach than bottom-right.

---

## Step 5 — The note composer

### Architectural decision: one component, two modes

The existing codebase's three writing surfaces (ComposeOverlay, ArticleComposePanel, ArticleEditor) collapse into a single `Composer` component with two rendering modes: **note** and **article**. The mode controls which chrome is visible around the same TipTap editor instance.

**Rationale.** The spec requires that the note→article transition feel like "the writing surface getting more room, not like a modal transition." Two separate editor instances cannot deliver this.

**What this retires:** ArticleComposePanel, ArticleEditor, ReplyComposer. The `/write` page becomes a thin wrapper.

**What survives unchanged:** ComposeOverlay shell, TipTap extensions, draft auto-save, price suggestion, the `useCompose` store (simplified).

### The FOR field

The audience selector is a single field labelled `FOR:` in IBM Plex Mono caps. It replaces the current model where public notes, replies, and DMs are separate flows.

**Why FOR, not TO.** "To" implies sending. "For" describes the relationship: you publish *for* an audience. The word covers both publication and messaging without implying the wrong register for either. It also carries the brand: "for all" is the ∀.

### Three value types

**∀ ALL** — the default. Crimson ∀ mark followed by `ALL` in crimson Plex caps. Tappable; tapping places cursor for input. Hint text: *narrow to a person, group, or audience*. Publishing pushes content as public on every connected protocol.

**An individual identity** — typed as a username, npub, handle, or resolved from search. Black chip in Plex caps. Multiple allowed. Protocol inferred and shown below the field as a quiet `VIA NOSTR · NIP-17 DM` line. Cross-post pills disappear.

**A named audience** — a persistent, opt-in group (e.g. subscribers, a publication's members). Chip with member count. Protocol pills reappear as `VIA:` toggles. Button reads `Publish`, not `Send`.

### Button text logic

- `FOR: ∀ ALL` → **Publish**
- `FOR: [individual]` → **Send**
- `FOR: [named audience]` → **Publish**
- Article mode, any FOR state → **Publish** (crimson)

### Behavioural rules

- `∀ ALL` is the displayed default value, not a placeholder.
- Adding a recipient replaces `∀ ALL`. Removing all recipients restores it.
- Reply opens the composer with the original author pre-populated and reply context shown below the FOR zone.
- Mixed-protocol recipients rejected with quiet inline error.

### Note composer states

**State 1: Empty.** Overlay opens via ⌘K. White surface, black 6px top rule. `FOR: ∀ ALL` in audience zone. Empty textarea, placeholder: *What's on your mind?* Controls bar: image upload, cross-post pills, character count (0/1000), black `Publish` button. No toolbar, no title, no dek, no tags.

**State 2a: Mid-compose, private.** FOR field contains resolved identity chip. `VIA NOSTR · NIP-17 DM` below. Cross-post pills gone. Button reads `Send`.

**State 2b: Mid-compose, named audience.** FOR field contains audience chip with count. Cross-post pills reappear as `VIA:` toggles. Button reads `Publish`.

**State 3: Mid-compose, public with nudge.** FOR field: `∀ ALL`. Article nudge banner between FOR zone and compose area. Trigger conditions (OR logic): word count > 400, heading node present, or more than one image node. Copy: *This is getting long. Switch to article mode?* Two actions: `SWITCH` (black) and `KEEP AS NOTE` (ghost). `KEEP AS NOTE` sets `nudgeDismissed` flag for the session. Non-blocking. Word count displays in crimson when nudge is active.

---

## Step 6 — The article composer and nudge migration

### The migration

Tapping `SWITCH` triggers `setMode('article')` on the same component. No navigation, no new mount, no dismissal animation. The TipTap instance persists — cursor, content, undo history, and auto-save all preserved.

### What changes on switch

**Overlay width:** 560px → 640px.

**New zones appear (top to bottom):**

1. Title field — Literata serif italic 22px. Pre-populated if note content began with a heading.
2. Dek/standfirst field — Literata serif 15px. Placeholder: *Standfirst (optional)*.
3. Publication selector — `PUBLISH AS:` with `PERSONAL` default.
4. Word count and read time.
5. Toolbar — `B · I · H2 · H3 · " · IMG | PAYWALL`. Paywall button is the only crimson-accented toolbar item.
6. Price row — appears only when paywall gate is inserted.

**Controls bar changes:** Auto-save status at left. `SCHEDULE` button. `Publish` button turns crimson. Cross-post pills removed. Character count replaced by word count.

### What persists across the switch

FOR field and value, compose area content and cursor, TipTap instance and state, auto-save.

### The useCompose store — simplified

- `composerMode: 'note' | 'article'` — controls which chrome is visible.
- `forValue: ForAll | Identity[] | NamedAudience` — determines button text and protocol.
- `replyContext: QuoteTarget | null` — if set, reply preview is shown.
- `nudgeDismissed: boolean` — per-session flag.
- `isOpen: boolean` — overlay visibility.

---

## Step 7 — Content-scope long-press

### Committed

The long-press surface carries two controls: **volume** (more / less / none) and **save**. Reply is not on this surface — it already lives on the action strip.

### Surface form

An attached panel that slides down from the top edge of the card, inside the card's white surface. Separated from the card body by a 3px black rule.

### Panel content

- Left: pip + author name (reinforcing that volume is per-author, not per-card).
- Right: three volume buttons — MORE, LESS, NONE — in IBM Plex Mono caps, separated by thin vertical rules. SAVE sits after a wider gap.

### Volume button states

- At rest: all neutral (#5F5E5A text on white).
- MORE or LESS selected: white text on black.
- NONE selected: white text on crimson (#B5242A) — signals the destructive nature of removing a source.

### Pip panel relationship

More/less/none are quick gestures that nudge the pip panel's percentage (e.g. +20%, −20%, 0%). The pip panel's bar is downstream — a readout of accumulated nudges, not the primary input.

### Focus and dismissal

- Surrounding cards dim while the panel is active. This is a focus treatment, not a brightness change — clears on dismissal.
- Dismissal: tap outside the panel, or tap the card body below it. No explicit close button.

---

## Step 8 — Feed-scope composer

### Committed: vessel becomes its own editor

Long-press on the feed's name label transforms the vessel from reading mode into composer mode. No separate surface, no overlay, no navigation. The vessel is the thing being edited.

### Composer layout (top to bottom)

**Header row.** Feed name at left, editable inline, underlined to signal editability. DONE button at right — exits composer mode.

**Source rows.** White cards on grey-100 floor, 1px gaps between them (floor visible through). Each source row carries:

- Top line: pip (9px), author name (Literata medium 14px), platform (Plex caps 10px), × remove affordance at far right.
- Bottom line: draggable weight bar (4px, black fill on grey track, 0–100%), percentage readout (Plex caps 10px), per-source RND/TOP sampling toggle.

0% weight = muted (equivalent to long-press NONE).

**Add source input.** Below the last source row. Accepts URL, handle, or npub. Plex caps placeholder: `+ ADD SOURCE BY URL, HANDLE, OR NPUB`.

**Footer.** DELETE FEED at left in quietest register (#B4B2A9). Source count at right.

### Transition back to reading

Name label as toggle (tap again) plus the DONE button. Both paths exist so the transition is discoverable gesturally and explicitly. Tap-outside is not a dismissal trigger — avoids accidental loss of mid-edit state.

### Design rationale

- Source rows use the card-header grammar from the pip panel handoff (pip + name + platform). Familiar vocabulary, different context.
- No ⊔ typography appears in the composer. The composition structure is visible through the layout — sources stacked, each weighted, inside the vessel that is the ⊔.
- The vessel-as-editor avoids a settings-panel feel. The user is not configuring a feed; they are shaping the container they're looking at.

---

## Step 9 — Animations

Two sequences, storyboarded as key frames. Both pass through the ∀ → H → ⊔ transformation. The H evokes *haus* without making a fuss — a ceremonial transit point, not a category the product carries.

### First-login animation (~2s, plays once)

**Frame 1 (0ms).** Crimson ∀ expands from the centre of an empty workspace.

**Frame 2 (~400ms).** ∀ parts into H. Two 8px black verticals, crossbar connecting them. This is the slowest moment — held for ~600ms.

**Frame 3 (~1200ms).** Crossbar drops toward the base. Horizontal bars accumulate behind it, stacking upward from the bottom. Abstract — lengths and weights suggest content but nothing is legible yet. Verticals spread to vessel proportions.

**Frame 4 (~1600ms).** Bars snap to cards. White rectangles with title/standfirst lines resolve in place. Snap, not morph. The vessel is now recognisably a ⊔ with content inside.

**Frame 5 (~2000ms).** Resting state. Vessel settles to medium-bright (walls #4A4A47, cards #F5F4F0). Name label "Founder's feed" appears above the opening. ∀ takes its position in the bottom-right corner. The workspace is ready.

### Feed-creation animation (~800ms, plays on every new feed)

**Frame 1 (0ms).** ∀ appears at the point where the new vessel will land.

**Frame 2 (~200ms).** ∀ parts into H. Briefer than first-login — a flash of recognition, ~200ms hold.

**Frame 3 (~500ms).** Crossbar dissolves downward, accumulates as base. Walls settle to ⊔ proportions. Interior fills with grey-100.

**Frame 4 (~800ms).** Resting state. Empty vessel at medium-bright. No name label — blank area prompts on first edit. "Add sources" hint centred in the empty interior.

### Animation relationship

The two animations rhyme. Both pass through H. Both deliver a ⊔. The difference is content (populated vs empty) and pace (ceremonial vs responsive). The meaning of the H accrues through repetition; no single viewing should feel elaborate.

---

## Colour tokens committed

### Primary brightness
- Vessel walls: #111111 (var(--black))
- Vessel interior / floor: #F0EFEB (var(--grey-100))
- Card background: #FFFFFF (var(--white))
- Card title / author name: #111111
- Card standfirst: #5F5E5A (var(--grey-600))
- Platform/date metadata: #8A8880 (var(--grey-500))
- Action strip: #8A8880
- Paywall chip / crimson: #B5242A (var(--crimson))
- Vessel name label: #5F5E5A

### Medium-bright (default for new feeds)
- Vessel walls: #4A4A47
- Vessel interior: #E6E5E0
- Card background: #F5F4F0
- Card title / author name: #3A3A37
- Card standfirst: #7A7974
- Platform/date metadata: #9C9A94
- Paywall chip / crimson: #B5242A (unchanged)
- Vessel name label: #8A8880

### Dim
- Vessel walls: #8A8880
- Vessel interior: #D4D3CE
- Card background: #E8E7E2
- Card title / author name: #6B6A66
- Card standfirst: #9C9A94
- Platform/date metadata: #A8A6A0
- Action strip: #A8A6A0
- Paywall chip / crimson (desaturated): #C4545A
- Voted state (desaturated): #C4545A
- Pip opacity: 0.7
- Vessel name label: #B4B2A9

---

## Deviations from spec

**One (Step 5).** The wireframe plan specifies that "the send button reads *Publish* because the To field is empty." The wireframe uses `FOR:` as the field label and `∀ ALL` as the default value, and names the button `Publish` when FOR is ∀ ALL or a named audience, `Send` when FOR contains individual identities. This is a refinement of the spec's intent — the button text reflects the nature of the action.

**Two (Step 5).** The wireframe plan does not anticipate the `FOR: [named audience]` state. Identified during the session as a necessary intermediate between "for all" and "for one." Additive — no conflict with committed decisions.

**Three (Step 5).** The spec's nudge copy is shortened from *this is getting long. Switch to the article composer for headings, images, and structure?* to *This is getting long. Switch to article mode?* The shorter version trusts the user to discover what article mode offers on switch.

**Four (Step 7).** The wireframe plan specifies three controls on the long-press surface: volume, save, and reply. Reply was dropped — it already lives on the card's action strip. The long-press surface carries volume and save only.

**Five (Step 8).** The spec describes the feed composer as "the ⊔ expression exposed as editable text." The wireframe drops the editable-text conceit in favour of direct-manipulation source rows within the vessel-as-editor. No ⊔ typography appears. The composition structure is visible through layout, not notation.

---

## What remains open

Items not resolved by Steps 1–9.

1. **Dark mode** — unresolved beyond the per-vessel brightness gradient. The three-voice palette and single-crimson-accent rule were authored against a white-only environment. A dark-mode translation has not been written.
2. **Cards with media** — lead images on articles, images in notes, video embeds. Not yet drawn. Will stretch the card grammar.
3. **Long-note truncation** — truncation mark and tap-through behaviour for notes beyond ~6 lines. Not yet specified.
4. **Tags in article mode** — present in the current codebase but removed from the wireframe. Decision needed: compose-time or post-publish metadata?
5. **Preview in article mode** — specified in the wireframe plan but not wireframed. Implementation-time decision.
6. **Named audiences** — the FOR field accepts them but the persistence, consent, and management model is not yet designed. Product decision that precedes implementation.
7. **Reply state wireframe** — identified as a composition of existing states (FOR field pre-populated + reply context). Not separately wireframed. Produce if needed during implementation.
8. **Brightness-and-focus coupling** — reading mode vs arranging mode. Deferred to its own design pass.
9. **Pip panel in non-green states** — amber, grey, crimson trust-signal versions. Architecture stress-test pending.
10. **Pip panel on mobile** — bottom-sheet treatment. Same content, different geometry.
11. **Cross-protocol reply semantics** — deferred. Not day-one.

---

*This document is the consolidated record of the wireframing pass. It supersedes the per-step decision documents. Revise when subsequent work resolves open items or changes committed decisions, with a note on what changed and why.*

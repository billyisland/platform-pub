# WORKSPACE EXPERIMENT ADR

*Date: 2026-05-01. Status: Active experiment, slices 1 + 1.5 + 2 + 2.5 + 2.6 + 2.7 + 2.8 + 3 + 4 + 5a + 5b + 5c + 6 + 7 + 8 shipped on branch. Branch: `workspace-experiment` (anchored at tag `pre-workspace-experiment`).*

## Context

The design corpus contains two incompatible navigation models. Phase A (`docs/adr/ALLHAUS-REDESIGN-SPEC.md`) is a topbar + global compose overlay sitting over a single feed, partially shipped on `master`. The workspace model (`WORKSPACE-DESIGN-SPEC.md`, `WIREFRAME-DECISIONS-CONSOLIDATED.md`) replaces the topbar with a grey workspace floor on which users arrange ⊔-shaped vessels representing feeds, with an ∀ creation control in the bottom-right.

This branch explores whether the workspace model works without abandoning Phase A. Phase A remains canonical on `master`. If the experiment succeeds, the branch merges and Phase A is retired. If it doesn't, the branch is deleted; nothing is lost.

## Decisions

### 1. Workspace is canonical on this branch

The Phase A topbar and the global ComposeOverlay-as-currently-shipped are retired on this branch. The authenticated home becomes the workspace floor. The ∀ in the bottom-right is the only object-creation entry point at workspace scope.

### 2. Animation: Framer Motion

The ∀→H→⊔ transformation (Step 9) is choreographed, multi-element, with SVG morphing and snap transitions. CSS animations can express it but the choreography becomes painful. Lottie requires After Effects assets and a designer-developer handoff that doesn't exist here. Framer Motion is React-native, supports `AnimatePresence` for mount/unmount sequencing, has first-class SVG path animation, and brings gesture primitives (`useDrag`, gesture composition) we'll need for vessel manipulation. Use Framer Motion for both the ceremonial ∀→H→⊔ sequences and in-workspace gestures (drag, resize, rotate, brightness drag).

Provide a `prefers-reduced-motion` variant for the ∀→H→⊔ sequences — fade-in fallback rather than the full transformation.

### 3. Persistence: local-first

- **Workspace layout** (vessel position, size, brightness, density, orientation) → `localStorage` is the source of truth, keyed by user id. Background sync to a server table is deferred until the shape settles. A future server hydrate doesn't need shape changes if the localStorage shape is treated as canonical.
- **Feed definitions** (sources + weights + sampling mode) → server-backed from day one. New tables `feeds(id, owner_id, name, created_at, updated_at)` and `feed_sources(feed_id, source_id, weight, sampling_mode, muted_at)`. These describe what *content* a vessel pulls; the workspace layout merely positions vessels.
- **Saved items** → defer. Stub in code, no schema until the surface design solidifies.

### 4. State: Zustand, optimistic

Two new stores alongside `useCompose`:

- `useWorkspace` — vessels array, current drag/resize/rotate target, arrangement vs reading mode.
- `useFeed(feedId)` — content fetched from `/api/v1/feeds/:id/items`, scroll position, per-feed unread tracking.

`useCompose` extends in place per Steps 5/6: add `composerMode`, `forValue`, `nudgeDismissed`. Don't fork a new store.

All workspace mutations are optimistic — the local store updates immediately, the localStorage write is debounced (200ms), any future server sync is best-effort.

### 5. Mobile: deferred

The experiment is desktop-first. Pinch-to-resize, two-finger rotation, two-finger vertical brightness drag have no committed touch alternatives. The mobile geometry decision (Wireframe doc Open Item 10; Step 4 hardware-prototyping note) waits until desktop works. On mobile during the experiment, render a "desktop only" placeholder rather than a half-baked touch UI.

### 6. Accessibility: experiment floor

Not full WCAG AA. The floor for the experiment:

- All critical paths (compose, open article, vote, reply, subscribe, navigate between vessels) reachable by keyboard.
- Vessels render as `role="region"` with the feed name as `aria-label`.
- ∀ menu opens on Enter as well as click; arrow-key navigation through the four items.
- Long-press surface has a keyboard equivalent (e.g. `Shift+Enter` on a focused card).
- Screen-reader labels for all icon-only controls.
- Reduced-motion variant for the ∀ animations.

Deferred until the experiment graduates: contrast verification across all three brightness states (the brightness experiment intentionally degrades contrast), full keyboard model for drag/rotate/brightness, focus management for arrangement mode.

## What survives from current code

Untouched:
- All backend services (gateway, payment-service, key-service, key-custody, feed-ingest, relay).
- TipTap editor and extensions (`web/src/components/editor/`).
- NDK reading and event parsing (`web/src/lib/ndk.ts`).
- Universal resolver, atproto/mastodon adapters, relay outbox, all of `shared/`.
- `feed_items` table — vessel content comes from this same denormalised source.
- Trust pip data layer (`gateway/src/routes/trust.ts`, `trust_layer1`, `vouches`).
- Auth, payments, subscriptions, publications routes.

Adapted:
- Card data shapes survive; visual rendering reskinned per `CARDS-AND-PIP-PANEL-HANDOFF.md`.
- The existing publish pipelines (`publishNote` for kind 1, `messages.createConversation` + `messages.send` for encrypted DMs) are reused unchanged — the new composer is a fresh UI on top of the existing rails.

Resolved against pre-experiment forecasts:
- `useCompose` store does **not** extend — it retires alongside the `ComposeOverlay` shell. Workspace composer state is component-local until a second open-the-composer entry point exists, then a fresh `useWorkspaceCompose` (or similar) replaces it.
- The new `Composer` is **not** chrome wrapped around `ComposeOverlay`. It is a new component (`web/src/components/workspace/Composer.tsx`) — `ComposeOverlay` continues to render only on platform-mode routes (`/feed`, `/article/...`, etc.) and will be deleted before any merge to `master`.

Retired (on this branch only):
- Phase A topbar.
- `NoteComposer`, `ArticleComposePanel`, `ArticleEditor` — fold into `Composer`.
- `/feed` page (after the workspace is solid; coexists during build).
- The `/write` standalone editor page becomes a thin wrapper that renders `Composer` in article mode.

New:
- `Workspace` component (the floor), `Vessel` component (the ⊔), `Composer` (single-component note+article).
- `∀Menu`, `ContentLongPressPanel`, `FeedComposer` (vessel-as-editor mode).
- `useWorkspace`, `useFeed` Zustand stores.
- Framer Motion animation primitives for ∀→H→⊔ and vessel gestures.
- `feeds` + `feed_sources` migrations.
- `GET /api/v1/feeds`, `POST /api/v1/feeds`, `PATCH /api/v1/feeds/:id`, `DELETE /api/v1/feeds/:id`, `GET /api/v1/feeds/:id/items`.

## Migration within the branch

1. Build workspace at `/workspace` while `/feed` and `/write` still exist. Iterate without disrupting fallback paths.
2. Wire the authenticated home to `/workspace` when it feels right.
3. Delete retired code (NoteComposer, ArticleComposePanel, ArticleEditor, old `/feed`, topbar) before any eventual merge to `master`.

## Build log

### Slice 1 — vessel renders real content (2026-04-30, commits `5c76d33`, `9047a87`)

Smallest first slice. New `/workspace` route renders one centred ⊔ on a grey-100 floor, fetching from `/api/v1/feed?reach=explore` (the existing timeline endpoint — feeds API is slice 3) and rendering up to 12 wireframe-grammar cards inside.

- `web/src/app/workspace/page.tsx` — route entry.
- `web/src/components/workspace/Vessel.tsx` — chassis to Step 1 spec: 8px walls, 16px interior padding, 12px inter-card gap, 300px wide, medium-bright tokens (walls #4A4A47, interior #E6E5E0, cards #F5F4F0). Static — no drag/resize/rotate/brightness/density.
- `web/src/components/workspace/VesselCard.tsx` — card variants for article, note, external, and `new_user` (join announcement). Pip + author + standfirst, no avatars, no action strip. Tokens local to the file — not added to `tailwind.config.js`.
- `web/src/components/workspace/WorkspaceView.tsx` — floor + fetch + map.

Skipped intentionally: feeds tables, `useWorkspace` store, ∀ menu, animations, localStorage, drag/resize gestures.

### Slice 1.5 — chrome retired on /workspace (2026-04-30, commit `a67efc9`)

Per ADR §1, the Phase A topbar and `ComposeOverlay` are retired on this branch. Implementation:

- `useLayoutMode` gains a third mode, `workspace`, returned for `/workspace` and any sub-paths.
- `LayoutShell` now owns Nav / `ComposeOverlay` / `Footer` / main-padding rendering and suppresses all four in workspace mode. `app/layout.tsx` simplifies to `<LayoutShell>{children}</LayoutShell>`.
- `WorkspaceView` floor now fills `100vh` directly.

Other routes (`/feed`, `/write`, `/`, `/:username`, etc.) are untouched and keep platform chrome. Note: with no topbar there is currently no in-app navigation off `/workspace` — the ∀ menu (slice 2) becomes the navigation anchor.

### Slice 2 — ∀ menu (2026-05-01)

Persistent ∀ control fixed bottom-right of the workspace floor. Tap (or Enter when focused) reveals a four-item menu per `WORKSPACE-DESIGN-SPEC.md` §"Workspace scope": *New feed*, *New note*, *Fork feed by URL*, *Reset workspace layout*. Closes on outside click, Escape, or item select; focus returns to the ∀ button. Arrow-up/-down + Home/End cycle items; mouse hover and keyboard navigation share an `activeIndex`. The button is a 56px black disc with the ∀ glyph in Literata; menu is a small white sheet with a hairline black border, no scrim.

- `web/src/components/workspace/ForallMenu.tsx` — new component, fixed position, role=menu/menuitem.
- `WorkspaceView` mounts `<ForallMenu />` on the floor.
- All four item handlers are `console.log` stubs for this slice. Wiring lives in later slices: *new note* → `Composer` (per ADR §"Adapted"), *new feed* → `POST /api/v1/feeds` (slice 3), *fork by URL* → universal resolver, *reset layout* → `useWorkspace` (slice 4).
- No Framer Motion yet; ADR §2 reserves it for the ∀→H→⊔ ceremony and gestures. Menu reveal is a CSS transform/transition.

Skipped intentionally: ∀→H→⊔ animation, mobile placement (∀ position on touch is part of the deferred mobile decision per ADR §5), focus-trap inside the menu (single-level, Escape suffices for the experiment a11y floor).

### Slice 2.5 — minimal Composer wired to *New note* (2026-05-01)

`web/src/components/workspace/Composer.tsx` is the workspace's own composer surface — fresh component, *not* a reuse of the retired `ComposeOverlay`. Slice 2.5 ships note mode only.

- Centred panel over a 40% scrim, opens on ∀ → *New note*. Esc / scrim click / Cancel close it.
- Surface per `WORKSPACE-DESIGN-SPEC.md` §"The note composer": a To field above a body textarea. Empty To shows the persistent `Publishing publicly` banner; the action button reads `Publish`.
- To-field resolution and protocol selection are **not** wired this slice. Typing into To disables Publish and surfaces a hint that private addressing arrives in a later slice. This honours the spec's invariant — that the To field is *the* central narrowing gesture — without faking autocomplete.
- Body publishes via the existing `publishNote(content, user.pubkey)` pipeline (signed and outbox-enqueued through `/api/v1/notes`). Char limit 1000.
- On success the Composer closes and bumps a `feedRefreshTick` on `WorkspaceView`, which re-fetches the vessel's feed. No optimistic insertion yet — the new note appears via refetch, which is sufficient at slice 2.5 because the founder's-feed vessel is the only one and the user's own publish lands in `feed_items` immediately.
- State is local to `WorkspaceView`. The migration map flags the retired `stores/compose.ts` for rewrite (three-mode shell coordination retires with the overlay); this slice deliberately does not extend it. A workspace-scoped store arrives when a second open-the-composer entry point exists (e.g. reply from a card).

`ForallMenu` becomes controlled — it now takes `onAction(key)` rather than owning stub handlers. The other three actions (*new feed*, *fork by URL*, *reset layout*) remain stubs in `WorkspaceView.handleForallAction`.

Skipped intentionally: article mode, To-field autocomplete + resolver wiring, protocol selector, draft autosave, media attachments, the 400-word note→article nudge, optimistic feed insertion, mobile sheet geometry.

### Slice 2.6 — To-field resolver + protocol selector (2026-05-01)

The To field's central design role per `WORKSPACE-DESIGN-SPEC.md` §"The note composer" is the cardinality-determines-publication gesture. Slice 2.6 makes it real on the input side; publishing semantics catch up later.

**To field.** Composer-local input now wraps a chip row. Typing 300ms-debounce-resolves through the universal resolver (`POST /api/v1/resolve`, context `dm`) and Phase B polls (up to 3 ticks at 1s) — same shape as `SubscribeInput` but adapted for chip selection. Native account matches surface in a dropdown alongside fuzzy-matched broadcast tokens (*Everyone on all.haus / Nostr / Bluesky / fediverse*). Enter on the input adds the top person match; click adds either kind. Backspace on an empty input pops the last chip; per-chip × button removes any chip. Person chips render black, broadcast chips render light.

**Banner + button label.** Empty-or-broadcast-only To still shows the `Publishing publicly` banner; the button still reads `Publish`. Person chips suppress the banner.

**Protocol selector.** Visible only when the chip row is empty (per spec: "When the To field is empty, a subtle secondary control surfaces"). Four toggle pills — `ALL.HAUS · NOSTR · BLUESKY · ACTIVITYPUB` — all on by default. Stored in component state.

**Publish gating.**
- Person chips present → publish disabled with hint *Private addressing wires in a later slice — remove person chips to publish*. The DM/private-addressing pipeline is its own slice (the resolved chip carries the protocol, but encrypted DM dispatch + cross-protocol DM is non-trivial).
- Empty To with Nostr toggled off, or broadcast-only To without Nostr → publish disabled with hint *Cross-protocol broadcast wires later. Include Nostr to publish.* The hint is honest about what the existing `publishNote` pipeline does (it signs and outbox-enqueues a Nostr kind 1; cross-posting to ActivityPub / atproto requires `crossPost` + a `linked_account_id`, deferred).
- Otherwise (empty To with Nostr on, or broadcast-token-list-including-Nostr) → public publish via existing `publishNote(content, user.pubkey)`. Other-protocol toggles and other-protocol broadcast tokens are accepted by the UI and ignored at publish time; the gating hint and the *Send via* selector make this state visible.

**No store coupling.** All resolver state, chip state, and protocol state is local to `Composer.tsx`. The retired `stores/compose.ts` stays untouched.

Skipped intentionally: encrypted Nostr DM dispatch (person chips), cross-protocol broadcast publishing (lighting up Bluesky/ActivityPub toggles for real — needs `linked_accounts` integration), chip ordering / drag-reorder, "named groups" autocomplete, identity-resolution chains beyond `dm` context (e.g. RSS feeds aren't valid To targets), keyboard navigation inside the dropdown beyond Enter-on-top-match, To-field history / recents.

### Slice 2.7 — person chips dispatch as encrypted DMs (2026-05-01)

The cardinality-determines-publication invariant is now real for native targets. Publishing the composer with one or more person chips routes through the existing DM pipeline rather than the public publish path.

**Pipeline.** `Composer.handlePublish` branches on chip kind:
- *Person chips only* → `POST /conversations { memberIds }` then `POST /messages/:conversationId { content }`. The existing `gateway/src/services/messages.ts` handles NIP-44 encryption end-to-end via key-custody — the composer doesn't see plaintext leaving the browser any differently than the existing `/messages` page does. Multiple person chips form a group conversation in one call.
- *Empty / broadcast-only* → unchanged from slice 2.6 (public `publishNote` via Nostr).
- *Mixed* (person chips + broadcast tokens) → publish disabled with hint *Mixing people with broadcast targets isn't supported in one send*. Two intents in one gesture is genuinely ambiguous; one-or-the-other is the cleanest contract.

**Surface changes.**
- *Publishing publicly* banner is suppressed when any person chip is present (the publish is no longer public).
- Action button label flips: `Publish` → `Send` for private. `Publishing…` → `Sending…` while in flight.
- Hint reads *Sending privately to N recipient(s) — appears in their inbox at all.haus/messages.* — naming the destination so the user understands the gesture's outcome.
- DM-pricing skip handling: if `messages.send` returns a non-empty `skippedRecipientIds`, surface *Sent, but N recipient(s) were skipped — DM pricing not paid* and leave the composer open. Settling DM pricing happens via the existing `/settings/dm-pricing` flow; not in scope here.

**Conversation deduplication.** Each Send creates a fresh conversation, matching the existing `/messages` page's behaviour. Find-or-create on identical member sets is a separate UX call that depends on whether `/messages` survives as a list surface (migration map §5 #5 still open).

Skipped intentionally: find-or-create dedupe, send to a person chip with no UUID (resolver returned a confidence-`speculative` external account), per-conversation reply context, message threading from a vessel card, mirroring sent DMs into the workspace feed (they're private, they don't belong in `feed_items`).

### Slice 2.8 — cross-protocol broadcast for empty/broadcast-only To (2026-05-01)

The protocol toggles and "Everyone on Bluesky / fediverse" broadcast chips light up. A public publish now anchors on the native Nostr publish *and* fans out to the user's connected Bluesky / Mastodon accounts, on the back of the existing Phase 5 outbound pipeline.

**Wire-up.**
- The existing `outbound_posts.action_type` CHECK already includes `'original'` (`source_item_id` and `linked_account_id` are both nullable post-058) — no migration. The slot was reserved during Phase 5 and was never wired from the gateway side.
- `POST /notes` schema swaps the singular `crossPost` (`{linkedAccountId, sourceItemId, actionType: 'reply' | 'quote'}`) for plural `crossPosts: array`. Per-target Zod refinement enforces the invariant `actionType === 'original' ⇔ sourceItemId omitted`. The handler now loops + enqueues each entry; failures are logged and skipped per target so a Bluesky outage can't block a working Mastodon cross-post (or vice versa). The pre-2.8 single-target shape had no production callers — `publishNote` was the only frontend reference and the field was unused — so the rename is straight.
- `enqueueCrossPost` widens to `actionType: 'reply' | 'quote' | 'original'` and `sourceItemId?: string`. Migration 062's dedup index already keys on `(account_id, nostr_event_id, linked_account_id, action_type)` and tolerates NULL `source_item_id` via `IS NOT DISTINCT FROM`, so re-enqueues are still idempotent.
- `feed-ingest/src/tasks/outbound-cross-post.ts` accepts `'original'` for both atproto + activitypub. The Mastodon branch simply skips the quote-URL append + `replyToStatusUri`; the Bluesky branch skips the `reply` / `quote` strong-refs. The unsupported-action assertion in the atproto branch is now exhaustive (was implicit no-op fall-through).
- `web/src/lib/publishNote.ts`: `crossPost?: CrossPostTarget` → `crossPosts?: CrossPostTarget[]`. `CrossPostTarget.sourceItemId` is now optional and `actionType` includes `'original'`.

**Composer surface.**
- On open, `Composer` calls `linkedAccounts.list()` and bins valid accounts by protocol. The atproto + activitypub toggles in the *Send via* row reflect connection state: connected → toggleable as before; not connected → rendered disabled-grey with a `title` reading *Connect &lt;Bluesky/Activitypub&gt; in Settings → Linked accounts to broadcast there*. Native `ALL.HAUS` and `NOSTR` toggles are unaffected (always-on; `nostr` still gates the publish).
- Broadcast targets resolve from chips when broadcast chips are present, otherwise from the toggle set. Cross-post targets = `(broadcast_set ∩ {atproto, activitypub}) ∩ {protocols with valid linked account}`.
- Hint copy: when at least one cross-post target is queued, the char-count line becomes `Publishing to Nostr · BLUESKY · ACTIVITYPUB — N/1000`. The slice 2.6 *Cross-protocol broadcast wires later* hint is gone; the still-present *Include Nostr to publish* gate (Nostr-toggled-off broadcast) reads as *Cross-protocol broadcast needs Nostr as the anchor. Include Nostr to publish.* — matching the new reality that the *other* protocols *are* wired but Nostr remains the anchor.

**Worker payload shape.** Top-level cross-posts produce one `outbound_posts` row per target with `(linked_account_id = <atproto|activitypub linked>, source_item_id = NULL, action_type = 'original')`. Body text passes through the same grapheme/char budget truncation paths (`truncateWithLink`); on Bluesky truncation appends the all.haus permalink, on Mastodon nothing (no quote URL since there's no source). Idempotency keys (`outbound_posts.id`) are stable across retries.

Skipped intentionally: cross-protocol broadcast that *omits* Nostr (still requires the anchor — sliced separately because the all.haus DB record currently keys on a Nostr event id), per-protocol body customisation (mentions, language tags, sensitive-content flags), per-target preview before send, post-publish toast surfacing the cross-post status, retry/abandon UI on the workspace floor (status lives in `outbound_posts`; surfacing it is its own slice), broadcast-to-self filtering (a user sending "Everyone on Bluesky" doesn't get a status from their own bridge — same as today since the cross-post writes to the linked account, not the source feed).

### Slice 3 — feeds schema + CRUD + multi-vessel workspace (2026-05-01)

The `feeds` object becomes real. A vessel is now a render of a server-backed feed, not a hardcoded explore query, and ∀ → *New feed* spawns a fresh vessel.

**Schema (migration 077).** `feeds(id, owner_id, name, created_at, updated_at)` with an 80-char name guard and an `owner_id, created_at` index. `feed_sources(feed_id, source_type, account_id|publication_id|external_source_id|tag_name, weight, sampling_mode, muted_at)` with a target-matches-type CHECK and per-type partial unique indexes so the same target can't double-up. `weight` and `sampling_mode` are reserved columns for the eventual ranking story (ADR §3) — slice 3's items query ignores both. `feed_sources` mutations bump `feeds.updated_at` via trigger so workspace ordering stays correct without route-side coordination.

**Routes (`gateway/src/routes/feeds.ts`).** `GET /api/v1/feeds` (list mine), `POST /api/v1/feeds {name}`, `PATCH /api/v1/feeds/:id {name}`, `DELETE /api/v1/feeds/:id`, `GET /api/v1/feeds/:id/items`. Owner-private: every read and write asserts `owner_id = session.sub`. Zod-validated bodies, UUID guard on params. Items returns `{feed, items, nextCursor, placeholder}`. When `feed_sources` is empty, `placeholder: true` and items mirror the explore query (cursoring on `(score, published_at, id)`); when sources exist, slice 3 returns an empty array with a TODO until source-set wiring lands. The placeholder query is a deliberate small duplication of `timeline.ts`'s explore branch — `timeline.ts` keeps its helpers module-private and the duplication retires when source semantics arrive.

**Web client (`web/src/lib/api/feeds.ts`).** New `workspaceFeeds` namespace exporting `list / create / rename / remove / items` plus `WorkspaceFeed` and `WorkspaceFeedItemsResponse` types. Renamed away from `feeds` because the existing `external-feeds.ts` already exports a `feeds` namespace for RSS/Mastodon/Bluesky/Nostr subscriptions on `/subscriptions`; collision would have shadowed both.

**Workspace (`WorkspaceView.tsx`).** Bootstraps on first authenticated load: list feeds; if none exist create the default "Founder's feed"; render one `Vessel` per feed with parallel `items()` fetches. Vessels lay out via `flex flex-wrap gap-8` on the floor — multi-vessel arrives with the multi-feed object, not as a separate slice. Composer's `onPublished` now refreshes every vessel.

**∀ menu *New feed* wired.** New `NewFeedPrompt` modal (matches `Composer`'s scrim/panel grammar) takes a name (1–80 chars), POSTs, and appends a vessel that immediately fetches its placeholder items. Body copy is honest about the placeholder: *Sources arrive in a later slice — for now this feed shows the explore stream.* Cancel / Esc / scrim-click closes; Enter submits.

Skipped intentionally: rename UI on existing vessels, delete UI on vessels, source-set authoring (the actual point of having a feed object — wiring `feed_sources` rows from follows / publications / external subscriptions / tags is the next slice's territory), per-vessel pagination beyond the first 20 items, optimistic cross-vessel publish (the user's own publish lands in `feed_items` and only its source feeds should refetch — currently every vessel does), drag-to-reposition (still no `useWorkspace` store), multi-feed empty state UX (each vessel shows its own NO ITEMS independently). The *Fork feed by URL* and *Reset workspace layout* ∀ items remain `console.log` stubs.

### Slice 4 — feed composer: source CRUD + items query honours sources (2026-05-01)

The `feeds` object becomes load-bearing. A vessel's name label is now a click-to-open affordance for the feed composer; the composer authors `feed_sources` rows; the items query fans out across them rather than falling back to explore.

**Routes (`gateway/src/routes/feeds.ts`).** Three new endpoints alongside the slice 3 surface:
- `GET /api/v1/feeds/:id/sources` — list rows with target display info (account / publication / external_source / tag) via LEFT JOINs against each potential target table. The `display` block is computed server-side so the client doesn't re-derive labels.
- `POST /api/v1/feeds/:id/sources` — discriminated-union body. Native targets (`account`, `publication`, `tag`) pass an existing UUID or, for tag, a name (auto-inserted into `tags` so `/tag/:name` and global tag listings stay consistent). External takes either an existing `externalSourceId` or a `(protocol, sourceUri[, displayName, …])` pair. The pair shape upserts `external_sources` and ensures an `external_subscriptions` row for the caller (in one txn) so the existing feed-ingest workers pick the source up; an immediate fetch job is enqueued for `rss` / `nostr_external` / `activitypub` (atproto rides Jetstream's 60s DID refresh). The per-type partial unique indexes from migration 077 surface as `409 Source already on feed`.
- `DELETE /api/v1/feeds/:id/sources/:sourceId` — straight delete. The associated `external_subscriptions` row is deliberately *not* torn down: a user may keep the subscription via `/subscriptions` or use the same external source in another feed. Subscription teardown is its own gesture.

**Items query (`sourceFilteredItems`).** Replaces slice 3's empty-set placeholder for non-empty source sets. Single SELECT against `feed_items`, with the source set expressed as four OR-ed `EXISTS` clauses: account → `fi.author_id = fs.account_id`, publication → `a.publication_id = fs.publication_id`, external_source → `fi.source_id = fs.external_source_id`, tag → `EXISTS` join through `article_tags + tags`. Reused `FEED_SELECT` / `FEED_JOINS` / `rowToItem` from the placeholder branch. `muted_at IS NULL` filters per source. Empty-source feeds still hit the explore placeholder. Cursor narrows from `(score, published_at, id)` to `(published_at, id)` because slice 4 doesn't yet rank across sources — chronological is the honest contract until `weight` + `sampling_mode` wire in.

**Web client (`web/src/lib/api/feeds.ts`).** Three new methods on `workspaceFeeds`: `listSources / addSource / removeSource`. New types `WorkspaceFeedSource`, `WorkspaceFeedSourceKind`, `AddWorkspaceFeedSourceInput` (the discriminated union mirroring the route shape).

**Composer (`web/src/components/workspace/FeedComposer.tsx`).** New component, scrim/panel grammar matching `Composer` and `NewFeedPrompt`. Reached by clicking the vessel name label (`Vessel.tsx` gained an `onNameClick` prop — long-press lives in the gesture system not yet built). Shows the feed name as header, lists current sources with × remove buttons, and offers an "Add a source" input that resolver-debounces (300ms + Phase B polling, context `subscribe`) and renders match candidates (native account / external source / RSS feed). Click a candidate → POST → list refreshes → `onSourcesChanged` triggers `loadVesselItems` on the affected vessel. Tag fallback: input starting with `#` offers a literal `tag` add when the resolver returns nothing useful (the resolver doesn't classify `#tag` natively). Honest empty state: *No sources yet — this feed shows the explore stream until you add one.*

**Wiring (`WorkspaceView.tsx`).** New `feedComposerFor: WorkspaceFeed | null` state; vessel name onClick sets it. After source change the affected vessel re-fetches via the existing `loadVesselItems`.

Skipped intentionally: rename / delete UI on vessels (routes already exist; needs its own confirm-flow), per-source weight / sampling-mode authoring (columns reserved, no UX yet), source mute toggle (column reserved, no UI), drag to reorder sources, paste-URL one-shot (the *Fork feed by URL* ∀ item — naturally a *create feed* + *add source* combo, deferred), the `external_subscriptions` cap check on POST `/feeds/:id/sources` (the existing `/feeds/subscribe` route enforces a 200-cap; slice 4 trusts the caller — a real cap on workspace adds is a follow-up that probably belongs in a shared helper), bulk import (selecting current follows en masse to seed a feed), and per-vessel pagination beyond 20 items. The *Reset workspace layout* ∀ item remains a `console.log` stub.

### Slice 5a — vessel drag-to-position + localStorage layout (2026-05-01)

The first vessel gesture. Vessels stop flex-wrapping and become absolutely-positioned objects on the floor, draggable by the name label, with positions persisted to localStorage per user. Framer Motion enters the codebase for the first time.

**New surfaces.**
- `web/src/stores/workspace.ts` — `useWorkspace` Zustand store. `positions: Record<feedId, {x,y}>`, `hydrate(userId)`, `setVesselPosition(feedId, pos)`, `removeVessel(feedId)`, `reset()`. localStorage key `workspace:layout:<userId>`, debounced 200ms write. Quota-exceeded / private-browsing failures swallowed silently — the in-memory layout is authoritative for the session, the persistence is best-effort. Per ADR §3 there is no server sync this slice.
- `web/src/lib/workspace/motion.ts` — small Framer Motion config (drag spring, reduced-motion variant, `prefersReducedMotion()` helper). Slice 5a actually uses none of the spring config because `dragMomentum={false}` settles the vessel exactly where the cursor was; the file exists for the resize / rotate / ∀→H→⊔ slices that *do* need it.

**Vessel changes (`Vessel.tsx`).** The chassis is now a `motion.div` with `position: absolute`, `x` / `y` motion values mirrored to `position` props via a `useEffect`. `drag` is enabled but `dragListener` is `false` — drag only initiates when `dragControls.start(event)` fires from the name label's `onPointerDown`. Cards inside the vessel stay clickable. `dragMomentum={false}` + `dragElastic={0}` — no springy slide-back, no overshoot. `dragConstraints` accepts a `RefObject<HTMLElement>` from the parent so vessels can't be dragged off the floor and lost. A `dragMovedRef` flag tracks whether the gesture was a drag or a click; the name-label `onClick` (which opens `FeedComposer`) is suppressed if any movement occurred during the gesture, so dragging the label doesn't accidentally open the composer.

**WorkspaceView changes.** Floor becomes `position: relative`, `height: 100vh`, `overflow: hidden`. A `floorRef` is threaded into each `Vessel` as `dragConstraints`. The bootstrap effect now blocks on `useWorkspace.hydrated` so default-slot writes never overwrite a stored layout. After hydration, for each feed without a stored position, a default grid slot is computed (340px col width = 300px vessel + 40px gutter, 32px outer padding, wraps at viewport width) and written back. `handleCreateFeed` does the same for newly-created vessels: next-slot default at the time of creation. The `flex flex-wrap justify-center` wrapper is gone; vessels live as absolutely-positioned children of the floor. Loading / error hints centre on the floor via `position: absolute; top/left: 50%; translate(-50%, -50%)`.

**Behaviour.** Position is `{x, y}` in floor coordinates (top-left origin). `dragConstraints` clamps to the floor element's box, so a vessel can't be lost off-screen. No no-overlap rule — overlap is allowed in slice 5a; Wireframe §3's no-overlap commitment waits until resize/brightness slices land and the spatial economics matter.

**No new dependencies on Framer Motion ceremonies.** `motion.div` only — no `AnimatePresence`, no path animation, no SVG morphing. The ∀→H→⊔ ceremonial sequence (Slice 9 / Step 9) and the brightness / density gestures will pull in more of the API; this slice deliberately stays minimal.

**Reset workspace layout (∀ menu item) still stubbed.** The store's `reset()` exists and is exported; wiring the ∀ item is a small follow-up that probably wants a confirm modal first.

Skipped intentionally: vessel resize (next slice), brightness / density / rotation (Step 2 wireframe), no-overlap collision detection, scrollable canvas beyond viewport, server-side persistence (still localStorage-only per ADR §3), keyboard equivalents for drag (deferred per ADR §6 a11y floor — vessels remain keyboard-reachable as `role="region"`, just not keyboard-positionable), mobile touch geometry (still desktop-only per ADR §5), default-grid recompute on viewport resize (the slot formula reads `window.innerWidth` once at bootstrap; if the user resizes their browser drastically the existing layout stays put rather than reflowing), garbage-collect orphaned `positions` entries when feeds are deleted on another device (`removeVessel` exists but isn't wired to deletion yet because vessel deletion UI doesn't exist).

### Slice 5b — vessel resize via bottom-right corner (2026-05-01)

The second vessel gesture. Vessels gain a quiet resize handle at the bottom-right corner of the chassis; drag widens / lengthens the vessel; size persists alongside position in localStorage.

**Store changes (`useWorkspace`).** `VesselLayout` extends from `{x, y}` to `{x, y, w?, h?}`. New `setVesselSize(feedId, {w, h})` merges into the existing record under the same `workspace:layout:<userId>` key, debounced 200ms. Slice-5a values (positions only) read forward without migration — `w` / `h` are optional and undefined means "use the vessel's intrinsic size."

**Vessel changes (`Vessel.tsx`).** New `size?: {w?, h?}` and `onSizeCommit?` props. The chassis becomes `position: relative` so the handle can pin to its bottom-right; a 16×16 hit area at `right: -8, bottom: -8` (offsetting the 8px wall) carries a small ◢ glyph at low opacity. Resize is plain `onPointerDown` + `setPointerCapture` + `onPointerMove` — Framer Motion's `drag` API is for translation, not bounded resize, so the handle owns its own gesture path. `liveSize` state mirrors the in-flight value during the drag and is committed on `onPointerUp`. Min 220×200 per spec ("below which content becomes illegible"); max 2000×2000 defensively (the floor's `overflow: hidden` clips visually so spec's "no maximum" rule is honoured by the floor, not the vessel). When `size.h` is set, the chassis takes a fixed height and the body becomes `overflow-y: auto` so cards scroll inside; without `h`, the vessel grows with content as before.

**Gesture independence.** The resize handle calls `event.stopPropagation()` on pointerdown and the vessel's translation drag is gated by `dragControls.start()` from the name label only — the two gestures don't interfere.

Skipped intentionally: pinch-to-resize (touch — deferred per ADR §5), corner-handle visibility on hover only (the handle stays present and quiet, in keeping with workspace-as-physical-space), per-density default sizes (size is freeform until density gestures arrive), aspect-ratio lock (spec implies free resize), keyboard equivalents for resize (deferred per ADR §6 a11y floor), no-overlap collision detection (still a later slice — vessels can overlap when resized large), default-size recompute on viewport resize, server-side persistence.

### Slice 5c — vessel brightness, density, orientation (2026-05-01)

The three remaining per-feed attentional axes per `WORKSPACE-DESIGN-SPEC.md` §"Feed scope" come online. Brightness changes the resolved colour palette (walls, interior, name label, cards). Density changes the card grammar inside (compact / standard / full). Orientation toggles the chassis between vertical (⊔: left + right + bottom walls) and horizontal (⊏: top + left + bottom walls, opening on the right; cards lay out in a row, horizontal scroll if w/h fixed).

**Tokens consolidated.** New `web/src/components/workspace/tokens.ts` exports `Brightness | Density | Orientation` + a `PALETTES: Record<Brightness, VesselPalette>` lookup keyed on the wireframe's committed primary / medium / dim colour tables (incl. desaturated crimson `#C4545A` and `pipOpacity: 0.7` at dim). Three small `next*` cycle helpers. The chassis resolves a single `palette` and passes `brightness` + `density` down to cards; cards re-render at the right brightness/density without per-card token plumbing beyond the two props.

**Store changes (`useWorkspace`).** `VesselLayout` extends with optional `brightness`, `density`, `orientation`. Three new setters (`setVesselBrightness` / `setVesselDensity` / `setVesselOrientation`) merge into the existing per-feed record under the same `workspace:layout:<userId>` storage key, debounced 200ms. Slice-5a / 5b values read forward unchanged because every new axis is optional with a per-axis default (medium / standard / vertical).

**Vessel changes (`Vessel.tsx`).** Accepts the three new props + commit callbacks. Wall arrangement branches on orientation. Inner flex direction switches between `column` and `row`; height-set vessels now scroll on the active axis (vertical → `overflow-y`, horizontal → `overflow-x`). Three small cycle controls (mono-glyph buttons) appear pinned to the chassis bottom-right just left of the resize handle: `○|◐|●` for brightness, `c|s|f` for density, `||─` for orientation. Each click cycles forward; `title` carries the full label so the abbreviations stay discoverable. Per ADR §5 these are the desktop alternatives to the touch gestures (two-finger vertical drag for brightness, two-finger rotation for orientation, gestural density toggle) — the cycle buttons are honest about discreteness; when continuous brightness lands, the storage shape evolves at that point.

**Card changes (`VesselCard.tsx`).** Now accepts `density` + `brightness` props and resolves a `CardContext` carrying both. Compact density collapses the card to an inline 9px pip + single-line title (with a crimson `£` glyph for paywalled articles, no full price). Standard is the slice-1 layout. Full adds a final source-attribution row (`VIA <PROTOCOL> · <IDENTIFIER>`, mono caps 10px, quietest meta colour). All hardcoded medium-bright tokens are replaced with palette lookups, so a vessel at `dim` recolours its cards including pip opacity (0.7 per spec).

**Wiring (`WorkspaceView.tsx`).** Plumbs the three new props from `useWorkspace` to each `Vessel`, and `density` + `brightness` from the layout to each rendered card.

Skipped intentionally: continuous brightness (touch gesture deferred per ADR §5; storage stays discrete until then), real touch gestures (two-finger vertical drag, two-finger rotation, gestural density), brightness-as-focus coupling (`WORKSPACE-DESIGN-SPEC.md` §"What this spec doesn't yet pin down" — focus mode is its own design pass), name-label repositioning to the opening side in horizontal mode (label stays above the vessel root for now; spec calls for it to follow the opening), per-density default sizes (a horizontal vessel still inherits the user's last w/h — they resize to taste), keyboard equivalents for the three controls (deferred per ADR §6 a11y floor — the cycle buttons are clickable, just not arrow-key-reachable), nine-state matrix QA across density × brightness in the live UI (the wireframe showed the nine frames pass; the runtime renderer is a first cut), no-overlap collision (still later), thumbnails / lead images at full density (the spec calls for them; `feed_items` doesn't carry them in a way the slice can render — TODO).

### Slice 6 — ∀ → *Reset workspace layout* wired (2026-05-01)

The fourth ∀ menu item stops being a `console.log` stub. The reset is layout-only — positions, sizes, brightness, density, orientation — and never touches `feeds` or `feed_sources`. Feeds and their sources survive the reset.

**Surface.** New `web/src/components/workspace/ResetLayoutConfirm.tsx` matches the scrim/panel grammar of `NewFeedPrompt` (40% scrim, 420px panel, hairline black border, 144px top inset). Body copy adapts to vessel count: zero-vessel state describes the wipe abstractly; ≥1 promises *N vessels* will return to the default grid. The confirm button is crimson (`#B5242A`) and auto-focuses on open — destructive-flavoured even though the operation is non-destructive in the data sense, because committed layout is genuinely irrecoverable. Cancel / Esc / scrim-click closes.

**Wiring (`WorkspaceView.tsx`).** New `resetConfirmOpen` flag. `ForallAction === 'reset'` opens the modal; on confirm `handleResetLayout` calls `useWorkspace.reset()` *and immediately re-seeds default grid slots for the current vessels in their existing order* via `defaultGridSlot(i, viewportWidth)`. Without the re-seed the vessels would collapse to `(0, 0)` for one paint while the bootstrap default-slot effect didn't re-run (it's keyed on `user`, not on `positions`). Re-seeding inside the same handler keeps the floor visually continuous through the reset.

**Store (`useWorkspace.reset()`).** Already existed from slice 5a — set `positions: {}`, schedule a localStorage write of the empty object. No changes this slice.

Skipped intentionally: undo (one-shot toast offering *Undo reset* would need a snapshot of the pre-reset map; the modal is the friction layer for now), reset-only-this-vessel (per-vessel context menu, deferred with rename/delete), keyboard shortcut (the ∀ menu's Enter-on-item is the keyboard path), animation on the re-seed (vessels snap to grid; with Framer Motion's `layout` prop this could tween, but the resize/rotate slices haven't pulled in `layoutId` yet).

### Slice 7 — vessel rename + delete UI (2026-05-01)

The two slice-3 routes that had no surface — `PATCH /api/v1/workspace/feeds/:id` and `DELETE /api/v1/workspace/feeds/:id` — light up. Both gestures hang off `FeedComposer`'s header / footer rather than introducing a per-vessel context menu (which would need the long-press / right-click gesture system not yet built).

**Rename (header).** The static name in the composer header swaps to a `Rename` mono-caps button next to the name. Click → inline input pre-filled with the current name (auto-selected for fast retype), `Save` and `Cancel` buttons inline. Enter saves; Esc cancels. Validates 1–80 chars, trim-equal-to-current = no-op close. On success the composer reflects the new name and `onRenamed(feed)` fires up to `WorkspaceView` which patches the matching `vessels[].feed` so the vessel name label updates without a refetch.

**Delete (footer).** A new bottom row separated by hairline, with a single `Delete feed` mono-caps button at right (grey → crimson on hover). Click → swaps in-place to a two-step confirm row: hint *Delete this feed? Sources are removed; subscriptions are kept.* + `Cancel` + crimson `Delete`. The two-step in-panel confirm is lighter than `ResetLayoutConfirm`'s modal because the action is feed-scoped (one row to undo by re-creating) rather than workspace-scoped.

**Last-feed guard.** `WorkspaceView` passes `deleteBlocked={vessels.length <= 1}`; in that case the footer renders a hint reading *Can't delete your only feed — create another first.* in place of the delete button. Without the guard, a sole-feed delete would leave the floor visibly empty until the next bootstrap reseeded a default — an awkward hidden recovery path. The gateway `DELETE /workspace/feeds/:id` would happily delete it; the FE-only guard is the friction layer.

**Subscription preservation.** The composer's hint copy (*subscriptions are kept*) names the deliberate behaviour from slice 4: deleting a feed cascades to its `feed_sources` rows but leaves any underlying `external_subscriptions` rows intact. The user can keep the subscription via `/subscriptions` or reuse the source on another feed.

**Layout cleanup.** On delete, `onDeleted(feedId)` drops the vessel from `vessels` *and* calls `useWorkspace.removeVessel(feedId)` so the localStorage layout entry doesn't accumulate stale records. The store method already existed from slice 5a; this is its first wired caller.

Skipped intentionally: undo-delete toast (would need an in-memory snapshot of the deleted feed + its sources, plus a re-create endpoint that preserves IDs — not worth it for an experiment), per-vessel rename via long-press / context menu (the gesture system is its own slice), confirm-on-rename (rename is reversible — the user can rename back), keyboard shortcut for Rename (the button is reachable via Tab inside the composer; the workspace a11y floor per ADR §6 doesn't require a dedicated shortcut), animated removal of the vessel from the floor (Framer Motion `AnimatePresence` will arrive with the ∀→H→⊔ ceremony slice).

### Slice 8 — ∀ → *Fork feed by URL* wired (2026-05-01)

The third ∀ stub goes live. *Fork feed by URL* is a one-gesture combo of *create feed* + *add first source* + *open vessel*, sharing the universal-resolver input grammar from `FeedComposer`'s "Add a source" but minting a fresh feed each time.

**Surface (`web/src/components/workspace/ForkFeedPrompt.tsx`).** New component. Same scrim/panel grammar as `NewFeedPrompt` (40% scrim, 480px panel, hairline black border, 144px top inset). Single input — *Paste a URL, @username, npub, DID, or #tag* — that resolver-debounces (300ms + Phase B polling, context `subscribe`). Match candidates render below as a list of mono-caps-sublabelled buttons; clicking one performs the fork. Tag fallback for `#name` inputs mirrors `FeedComposer`. Hint copy under the input names the gesture's outcome: *Picks something below to mint a new feed pointed at it. Rename later from the feed composer.*

**Fork mechanics.** `handleFork(opt)` runs `workspaceFeedsApi.create(derivedName)` then `workspaceFeedsApi.addSource(feedId, opt.add)` in sequence. The derived name comes from the resolved match — display name → @username → URI → feed title — clamped to 80 chars. If `create` succeeds but `addSource` fails, the partial feed is *kept* and handed back via `onForked(feed)`; the modal surfaces a hint reading *Feed created but source add failed: …* so the user can finish wiring it via the feed composer rather than losing the new vessel. Roll-forward over rollback because the feed itself is salvageable state.

**Wiring (`WorkspaceView.tsx`).** New `forkOpen` flag. `ForallAction === 'fork'` opens the modal; `handleForked(feed)` mirrors `handleCreateFeed` — appends the vessel, writes a default-grid slot via `setVesselPosition`, fires `loadVesselItems(feed)`. The user lands on a vessel that already shows the source's content on first paint (modulo backfill latency for newly-subscribed external sources).

**Why "fork" not "subscribe".** The menu copy uses *fork* because the verb in this branch's vocabulary is workspace-floor-shaped: *fork* makes a new vessel from an external thing the way a software fork makes a new repo from a remote one. Subscribing to a single source from `/subscriptions` (which still exists as the Phase 1–4 surface) is a different gesture with a different mental model.

Skipped intentionally: multi-source fork (the menu item is "Fork *feed* by URL"; the user mints one source at a time and adds more in `FeedComposer`), fork from clipboard (browser permission costs > value at this fidelity), recently-resolved suggestions (the resolver doesn't expose a history surface yet), import a feed-of-feeds (e.g. an OPML upload — out of scope for the workspace shell), in-place rename of the derived name *before* the fork commits (the modal's hint already promises rename-later via the feed composer; an inline rename would slow the gesture to two steps when one of the resolver matches is good enough).

## Deferred (TODO in code, not blocking the experiment)

- Trust pip colour function (signal composition rule).
- Save persistence (per-feed Saved state schema and surface).
- DM/messages model (vessel vs `/messages` route).
- Notifications anchor (corner pip vs ∀-menu adjunct vs vessel).
- Search entry point.
- Publications surface in workspace.
- Named audiences (FOR field) persistence + consent + management.
- Volume TOP metric definition.
- Dark mode.
- "Medium-bright" pixel value.
- Cards with media (lead images, video embeds).
- Long-note truncation.
- Tags in article mode.
- Pip panel for non-green trust states.
- Cross-protocol reply semantics.
- Brightness × focus coupling.
- Nudge dismissal persistence beyond session.

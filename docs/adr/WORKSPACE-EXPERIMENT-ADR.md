# WORKSPACE EXPERIMENT ADR

*Date: 2026-05-01. Status: Active experiment, slices 1 + 1.5 + 2 + 2.5 + 2.6 + 2.7 + 2.8 + 3 + 4 + 5a + 5b + 5c + 6 + 7 + 8 + 9 + 10 + 11 + 12 + 13 + 14 + 15 + 16 + 17 + 18 + 19 + 20 + 21 + 22 + 23 shipped on branch. Branch: `workspace-experiment` (anchored at tag `pre-workspace-experiment`).*

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

### Slice 9 — ∀→H→⊔ ceremony animation (2026-05-01)

The signature visual move per `WORKSPACE-DESIGN-SPEC.md` §"The ∀-to-H-to-⊔ transformation" + `WIREFRAME-DECISIONS-CONSOLIDATED.md` Step 9. Two paces: *ceremonial* on first-login (~2000ms, terminal state populated with card placeholders) and *responsive* on each new feed creation (~800ms — under one second per spec, terminal empty ⊔). Framer Motion's `AnimatePresence` + transformable SVG primitives enter the codebase for the first time, on the back of the slice 5a `motion.div` baseline.

**Component (`web/src/components/workspace/ForallCeremony.tsx`).** A floor-relative absolutely-positioned 300×300 SVG overlay. Five phases driven by `setTimeout` boundaries off `CEREMONY_TIMINGS[pace]`: `forall` → `partingToH` → `hHold` → `crossbarDrop` → (`cards`, ceremonial only) → `done`. The ∀ glyph renders as Literata text inside the SVG, crimson `#B5242A`, scales 0.4→1 from box centre, then fades as the H bars resolve. Verticals fade in (matching the ∀'s exit), the crossbar enters at H position (mid-Y, between the verticals), then animates `(x, y, width)` to the ⊔ base position (full-width, bottom). For ceremonial pace, three white card placeholders fade in inside the resolved ⊔. `transition` uses `easeInOut` on the crossbar drop and `easeOut` on entries — snap-not-morph reads via decisive easing rather than literal stepping.

**Reduced-motion variant.** ADR §2 reserved a fade-only fallback. When `prefers-reduced-motion: reduce` is set, the component renders a static ⊔ (verticals + base) that fades in over 200ms then fires `onComplete`. No transformation, no ∀, no card snap.

**Timings (`web/src/lib/workspace/motion.ts`).** New `CeremonyTiming` interface + `CEREMONY_TIMINGS` map. Ceremonial sums to 2000ms (`forallIn 150 + forallHold 100 + partToH 150 + hHold 700 + crossbarDrop 350 + cardsSnap 350 + settle 200`). Responsive sums to 740ms with `cardsSnap = 0`. The `hHold = 700` honours the spec's "the slowest moment — held for ~600ms" framing for the ceremonial pace.

**Wiring (`WorkspaceView.tsx`).** New `ceremony: PendingCeremony | null` state. `handleCreateFeed` and `handleForked` both:
1. POST → mint feed
2. Compute destination grid slot via `defaultGridSlot(...)`
3. Append vessel + write position to the layout store *immediately* — items fetch starts behind the curtain
4. Set `ceremony = { feedId, pace: 'responsive', target: slot }`
5. On ceremony `onComplete` → clear `ceremony` (vessel becomes visible)

The first-login path is gated in the bootstrap effect: when the feed list is empty AND a `workspace:ceremony_seen:<userId>` localStorage flag is unset, the ceremony queues at viewport-centred coordinates with `pace: 'ceremonial'`, and the seen flag writes on completion. The flag survives logouts on the same browser; a returning user with zero feeds (e.g. they deleted everything) does not get the ceremonial pace again — it's an onboarding moment, not a fallback.

**Vessel hidden during ceremony (`Vessel.tsx`).** New `hidden?: boolean` prop sets `opacity: 0` + `pointerEvents: 'none'` on the `motion.div`. The vessel still mounts so its items query lands during the ceremony — for an 800ms responsive pace this hides ~500ms of LOADING… that would otherwise follow the ceremony. The visible ⊔ during animation is the ceremony overlay; on `onComplete` the overlay unmounts and the vessel reveals with content already in place (or close to it).

**Position discontinuity (first-login).** The ceremonial pace plays viewport-centred per spec ("expands from the centre of an empty screen"), but the founder's feed mounts at its grid slot — so when the ceremony completes, the ⊔ "appears" in the corner rather than gliding from centre to slot. The spec describes a continuous resolve into resting position; sliding the SVG across the floor to terminate exactly on the destination chassis is a polish slice, not slice 9. The current jump is brief and the eye reads it as the ceremony giving way to the workspace, not as a glitch.

Skipped intentionally: the slide-from-centre-to-corner choreography for first-login (the ceremonial pace's terminal position currently doesn't match the eventual founder's-feed grid slot — a continuous transit is its own animation slice with `layoutId` plumbing that's not in service yet), card content during the ceremonial cards phase (the placeholders are blank rectangles — title/standfirst lines "resolve in their final third into legible content" per spec, deferred until the cards layer can be re-used between ceremony and live render), morph-not-just-cross-fade between glyphs (true ∀→H path morphing requires either pre-baked path data or a font-as-paths pipeline; the current cross-fade reads convincingly at the durations involved), reduced-motion sliding equivalent (the fade-in is pure opacity — no traversal), per-vessel ∀→H→⊔ on subsequent reloads (intentionally one-shot — the ceremony is a transit, not a category), audio cue / haptic.

### Slice 10 — Composer article mode + 400-word note→article nudge (2026-05-01)

`Composer` becomes the single composing surface for both notes and articles, per `WIREFRAME-DECISIONS-CONSOLIDATED.md` Step 6. Note mode (slices 2.5–2.8) is unchanged; article mode adds a TipTap-backed editing surface, title + dek + publication selector + paywall toolbar, and the 400-word elevation nudge. Two entry points: ∀ → *Write an article* (direct), and the in-composer *Write an article →* link (or 400-word nudge) from note mode (elevation).

**Mode state.** `Composer` gains `mode: 'note' | 'article'` + `initialMode?: ComposerMode` prop. Mode is local to the component and resets on every open. The retired `stores/compose.ts` stays untouched — workspace-scope compose state is still component-local until a second open-as-article entry point exists (e.g. quote-as-article from a card).

**TipTap.** A single `useEditor` instance is mounted up-front while the Composer is open (extensions: `StarterKit` with H2/H3, `Markdown`, `Image`, `ImageUpload`, `EmbedNode`, `PaywallGateNode`, `Placeholder`, `CharacterCount`). It survives a note→article elevation in-place. The textarea-based note mode is preserved as-is — switching to article mode lazy-populates the editor with the textarea content via `editor.commands.setContent(initialBody, false)`. A heading-prefixed first line (`# …`) is promoted to the title field, matching the spec's *"Pre-populated if note content began with a heading"*. The elevation is one-way per slice 10: there's no *back to note* affordance, because the note's plain-text + char-count semantics aren't expressible in TipTap state without lossy round-tripping.

**Article-mode chrome.** New zones top-down per spec:
1. Title — Literata serif italic 22px on `bg-grey-100` (`#F0EFEB`) field.
2. Standfirst — Literata serif italic 15px, `Standfirst (optional)` placeholder.
3. *Publish as* selector — `<select>` defaulting to `PERSONAL`. Populates from `publications.myMemberships()` pre-fetched on open. Memberships without `can_publish` annotate the option label `(review)` and the publish button flips to `Submit for review`.
4. Toolbar — `B · I · H2 · H3 · " · IMG | PAYWALL`. PAYWALL is the only crimson-accented item; toggling inserts/removes the `paywallGate` node via the existing TipTap commands.
5. Editor surface — `EditorContent` on `bg-grey-100` with `min-height: 320` and a `max-height: calc(100vh - 480px)` scroll cap so the panel never exceeds viewport.
6. Price row — appears only when the gate is inserted. £-prefixed numeric input + word count + read-time readout.

**Hint copy + button.** Bottom row in article mode reads `N words · M min read[ · Saved]`. Person chips in the To field disable publish with *Articles can't be sent privately — remove person chips to publish.* The Publish button is crimson `#B5242A` in article mode (matches the wireframe's *publish button turns crimson*); label flips to `Submit for review` for memberships without `can_publish`.

**Publish path.** `handlePublishArticle` builds a `PublishData` from the editor's markdown (split at `PAYWALL_GATE_MARKER` if the gate is inserted, with `gatePositionPct` computed from the free/paywall ratio) and dispatches:
- `publishToPublication(publicationId, data)` if a publication is selected — server-side pipeline via `gateway/publications/:id/articles`. Same path the legacy `/write?pub=…` form uses.
- `publishArticle(data, user.pubkey)` for `PERSONAL` — client-side pipeline (sign v1, index, encrypt v2 if paywalled, sign v2, re-index). Same path the legacy `/write` form uses.

The composer doesn't reimplement either pipeline — both helpers in `web/src/lib/publish.ts` are reused. Tags, scheduling, comments toggle, and `showOnWriterProfile` defer to defaults (`tags: []`, no schedule, comments-on, profile-on); per spec these "defer to the full editor" until polished into the panel. The legacy `/write` page survives unchanged as the deep-link form for resume + edit + schedule + tags-rich flows.

**Draft autosave.** The TipTap `onUpdate` hook calls `createAutoSaver(3000)` with the current title/dek/content/price. Autosave is gated on a non-empty title — `saveDraft` requires it server-side. Draft status (`Saved` / `Save failed`) appears inline in the bottom hint row for ~2s.

**Cross-protocol broadcast in article mode.** Hidden — the *Send via* row only renders when `mode === 'note' && chips.length === 0`. The article path always anchors on Nostr (kind 30023) with no atproto/activitypub fan-out. Cross-posting articles to ActivityPub or Bluesky is its own slice (the Bluesky/Mastodon outbound paths key on a Nostr kind-1 source event; articles are kind 30023 and would need their own routing through `outbound_posts.action_type = 'original'` plus a per-protocol body shape decision — defer until users actually ask for it).

**400-word nudge.** New `web/src/components/workspace/Composer.tsx` local state `nudgeDismissed` + `showNudge`. While in note mode, an effect counts whitespace-split words and shows an inline panel reading *This is getting long. Switch to article mode?* with `Switch` (crimson) and `Dismiss` (grey) buttons. Threshold is 400 words per spec. Dismissal is per-Composer-session (resets on close/reopen). The nudge is a one-shot panel rather than a recurring toast — once dismissed, it stays gone for the rest of the open session even as the user keeps typing.

**∀ menu fifth item.** `ForallMenu` adds `'new-article'` after `'new-note'` with label *Write an article*. `WorkspaceView.composerOpen` becomes `false | 'note' | 'article'` so the same Composer instance can open in either mode. Mode resets on open via the `initialMode` prop.

**`/write` page survives.** The route still serves the long-form editor (full toolbar, tags, scheduling, edit-published-article via `?edit=`, draft resumption via `?draft=`). It's no longer the *only* way to write an article — the workspace Composer covers fresh-publish + paywall-gate + publication routing for the common case — but the Migration Map's "undecided" verdict on `/write` resolves provisionally as **survives as deep-link form** (per Open Item §5.6).

Skipped intentionally: schedule button (no draft-then-schedule UI in the panel; falls back to `/write?draft=…` if the user wants to schedule), tag input (Wireframe Step 6 doesn't list it among article-mode zones; tags survive on `/write`), comments toggle, *show on writer profile* toggle for publication articles, edit-published-article from the workspace (the panel only knows fresh-publish; editing routes to `/write?edit=…`), draft resumption (the panel always opens fresh — opening a saved draft routes to `/write?draft=…`), embed toolbar button (simpler IMG-only toolbar this slice), price suggestion based on word count (the legacy `/write` has it; defer until the panel sees real use), publish-confirmation panel with email-subscribers checkbox (slice goes straight from Publish click to publish; the confirm/email flow is per spec but adds a step that didn't fit the workspace's *gesture is the publish* feel — revisit), back-to-note from article mode (one-way elevation), TipTap-as-note-mode (the textarea stays — note→article is a real mode change with content carry-over, not a chrome change over a single editor), 760px article-mode width per the legacy ALLHAUS spec (kept at 640 for both modes; revisit if the article surface feels cramped). Cross-posting articles to ActivityPub / Bluesky and the article→DM "private article" gesture remain explicitly out of scope.

### Slice 11 — card click-through + action strip + reply context (2026-05-01)

Vessels stop being read-only display surfaces. Cards click through to the reader, gain a quiet `vote · reply · share` strip under the body in standard / full density, and the *Reply* gesture finally gives `Composer` its second open-the-composer entry point. The `useWorkspaceCompose` extraction the slice-2.5 build log forecasted is *not* built — `WorkspaceView`-local state (`composerOpen` + `replyTarget`) is enough for the two entry points (∀ menu and card-action-strip Reply); a store extraction can wait until a third entry point arrives.

**Card click-through.** `VesselCard` accepts an optional `onClick` on `CardShell`. Articles route to `/article/[dTag]` via `useRouter().push` (the carry-over reader, per Migration Map §1). Externals open `sourceItemUri` in a new tab — atproto URIs first translate to `bsky.app` via a local `atprotoWebUri` helper that mirrors the one in the deprecated `feed/ExternalCard.tsx` (kept duplicated rather than promoting to a shared util because the deprecated card retires before any merge to master). Notes don't navigate — there's no `/note/[id]` route in the workspace world, and the existing inline reply thread in `feed/NoteCard` is part of the deprecated chassis. Notes stay read-in-place; the action strip provides the only interaction.

**Action strip (`CardActions`).** Mono-caps 11px row pinned under the card body in standard / full density, suppressed in compact (compact is intentionally a single-line title — adding a six-glyph action row defeats the density). Three slots:
- `VoteControls` — reused from `web/src/components/ui/VoteControls.tsx` unchanged. Vote target is the Nostr event id + kind (30023 for articles, 1 for notes). Externals don't render vote controls — vote tallies are bound to a native event id and external items don't have one. The component lazy-fetches its own tallies / my-votes via `votesApi`, so the strip stays cheap to render across many cards (per-vessel up to 12 cards × N vessels). A future optimisation could batch-load tallies with the items query, but the current per-card load is fine at slice-11 traffic.
- `Reply` button — fires `onReply(replyTarget)` up to `WorkspaceView`, which sets the reply target and opens the composer. Suppressed for externals (cross-protocol replies are deferred per ADR open question + UNIVERSAL-FEED-ADR — the slice doesn't try to wire them).
- `Share` button — copies a deep link to clipboard (`window.location.origin + /article/<dTag>` for articles; `sourceItemUri` for externals). No toast confirmation this slice; users see the cursor land back on the card. A small "Copied" affordance is its own polish.

Click bubbling: `CardActions` calls `e.stopPropagation()` on its container so vote / reply / share clicks don't fall through to the card-level `onClick` and trigger an unwanted navigation.

**Drag vs click.** Vessels initiate drag only from the name label (`dragControls.start(event)` on `onPointerDown` of the `<button>` / `<div>` name label, with `dragListener={false}` on the parent `motion.div`). Cards inside the vessel are not drag handles, so card clicks are safe — no need for a `dragMovedRef`-style suppression on the card layer.

**`Composer.replyTarget`.** New optional `ReplyTarget` prop (`{ eventId, eventKind, authorPubkey, authorName, excerpt? }`) exported from `Composer.tsx`. When set:
- Mode locks to `note` regardless of `initialMode` (article-mode replies aren't a thing).
- The `Publishing publicly` banner + To-field + protocol selector + *Write an article →* link are all hidden. The cleanly-removed surface is replaced with a *Replying to NAME — excerpt* header in the slice-10 banner-bg grammar (mono-caps name, italic Literata excerpt).
- `handlePublishNote` branches: a reply payload routes through the existing `web/src/lib/replies.ts::publishReply` (NIP-10 e+p tags, `/api/v1/replies` index endpoint) rather than `publishNote`. The reply pipeline is fully reused — the new path is a four-line branch in `Composer.handlePublishNote`. No new endpoints, no new tags, no new tag conventions.
- Button label flips to `Reply` / `Replying…`. Hint row drops to the bare `N/1000` char count.
- Char limit stays at 1000; reply-only `parentCommentEventId` (for nested-thread context) is *not* supported this slice — only top-level replies to a card. Threaded replies on the workspace are their own slice (the playscript thread render pattern from `web/src/components/replies/PlayscriptThread.tsx` survives per Migration Map §2 *replies/* but isn't yet wired into the vessel surface).

**Wiring (`WorkspaceView.tsx`).** New `replyTarget: ReplyTarget | null` state. The ∀ menu's *new note* / *new article* paths clear it; the card action strip's `onReply` sets it + opens the composer in note mode. `Composer.onClose` clears both `composerOpen` and `replyTarget` so the next ∀ → *New note* doesn't accidentally inherit a stale reply context.

**Cross-checks against the design corpus.** The card grammar in `CARDS-AND-PIP-PANEL-HANDOFF.md` calls for a unified action strip — slice 11 ships `Reply · Vote · Share` and defers `Save` (the per-feed save mechanism is its own gesture, listed in §"Deferred" below). The `BookmarkButton` retires per Migration Map §2 (cross-feed bookmarks dropped); slice 11 doesn't reintroduce it under another name. Trust pip remains inline (non-tappable) — the pip panel is its own slice, listed below.

Skipped intentionally: pip panel as tap target on the inline pip (slice 12 territory — needs trust polling preview UI, FOLLOW + SUBSCRIBE rows), nested-thread reply context (`parentCommentEventId` + `parentCommentId`), reply count badge on cards (the existing `/api/v1/replies` count endpoint is there; rendering it on every card was deemed visual noise without the playscript thread to drop into), in-card playscript thread expansion (slice 13+), Save action on the strip (per-feed save is the right model per spec but needs schema), share-toast affordance, tap-to-quote (`Quote` was on the pre-workspace card strip; the workspace's quote story routes through the resolver-driven Composer with a quoted-event tag and is its own slice), batch vote tally pre-loading on the items endpoint, click-through for notes (no `/note/[id]` route — surfaces in a future slice that decides between modal-thread and dedicated route), cross-protocol reply on external cards (Bluesky reply via linked atproto account etc. — Migration Map §5 #11), keyboard equivalent for the action strip (per ADR §6 a11y floor — the buttons are Tab-reachable since they're in the natural DOM order, just not chord-shortcutted), `/article/[dTag]` reading-mode-vs-arranging-mode coupling (still URL navigation — `WORKSPACE-DESIGN-SPEC.md` open Q remains deferred).

### Slice 12 — pip panel (first cut) (2026-05-01)

The TrustPip stops being inert. Tapping the pip on a native (note / article) card opens a popover with header, bio, a first-cut trust signals block, and a SUBSCRIBE footer when the writer offers subscriptions. Per `CARDS-AND-PIP-PANEL-HANDOFF.md` §"The pip panel" the panel is the *judgment + commitment* surface — slice 12 ships *commitment* (FOLLOW + SUBSCRIBE link) in full and ships *judgment* as a placeholder until the polling backend exists.

**Trigger surface (`PipTrigger`).** New thin wrapper around `TrustPip` that turns the inline pip into a button. Click `stopPropagation`s so the card-level navigation (`onClick` on `CardShell`) doesn't fire on the same gesture. The button measures its own bounding rect and hands `(pubkey, rect, status)` up to `WorkspaceView` so a single shared `PipPanel` instance can anchor on whichever pip was tapped. Compact-density rendering keeps the slice-5c 0.82× scale via the pip code's existing transform path; this slice didn't touch the bare `TrustPip` component.

**Native vs external.** Article + note cards render `PipTrigger`; external cards keep the bare `TrustPip` because external authors don't have a platform user id and `gateway/src/routes/trust.ts::GET /trust/:userId` keys on user id. Cross-protocol pip panels (showing trust info for a Bluesky author seen via Jetstream) is its own slice — needs federation-side identity resolution that doesn't exist yet.

**Panel surface (`PipPanel.tsx`).** Fixed-position popover, ~420px wide, anchored below-and-right of the pip when there's room, otherwise above. Outside-pointerdown + Esc close. Z-index 70 (above the floor + cards but below the workspace ∀ menu's potential modal — none currently in flight at z 60+ except `Composer`'s 60, so 70 keeps the panel above an inadvertently-still-open composer). Material is the slice-1 white panel + hairline black border + soft shadow grammar — matches `NewFeedPrompt` / `ForkFeedPrompt` / `Composer`.

**Header.** Large pip (1.4× transform of the inline pip) · author name in Literata medium 18px with a `›` glyph chevron (the name+chevron is a `next/link` to `/<username>` — the carry-over writer profile route per Migration Map §1) · right-aligned `FOLLOW ›` / `FOLLOWING ›` (mono-caps, text-only, no button chrome — matches the handoff doc's "rejected: making FOLLOW an inverted block button" note). The author's-own-pip suppresses the FOLLOW button (you can't follow yourself).

**Bio line.** Literata regular 14px, plain weight, from the writer's `accounts.bio` field via the existing `GET /writers/by-pubkey/<pubkey>` route. Rendered only if non-empty — empty bio gets clean omission rather than a placeholder.

**TRUST section (first cut).** Renders the existing `trust_layer1` signals — `accountAgeDays`, `articleCount`, `payingReaderCount`, `nip05Verified`, `paymentVerified` — as a five-row mono-caps right-aligned-value list. Honest about what's missing: a small Literata italic line below reads *Polling questions land in a future slice.* The handoff doc's three poll questions (*Are they human? · Are they who they seem to be? · Do they engage in good faith?*) need a polling backend that doesn't exist (`docs/adr/ALLHAUS-OMNIBUS.md` §III.7 frames this as trust-system-spec-proper territory). Layer 1 signals are a real-data surface for the same question — *what does the system know about this author?* — and ship in advance of the polling system rather than blocking the panel's other elements.

**VOLUME section.** Skipped this slice. The handoff calls for a five-step horizontal volume bar with a RANDOM/TOP sampling toggle — both surface and persistence. Per ADR §3 *Saved items: defer. Stub in code, no schema until the surface design solidifies.* Volume settings are in the same category — they're per-user-per-author state, no schema, and the bar's interaction model needs a proper design pass (continuous drag vs discrete steps; the touch gesture deferred per ADR §5; the `RANDOM` vs `TOP` semantics from the handoff's open architectural questions). Slice 12 leaves the section out entirely rather than ship a non-functional placeholder; it returns when the schema lands.

**SUBSCRIBE footer.** Right-aligned mono-caps crimson `SUBSCRIBE · £X.XX/MO ›` link to `/<username>` when `subscription_price_pence > 0`. The actual subscribe gesture lives on the writer's profile page (per handoff: "subscribing is the action; managing an existing subscription is on the author's profile or account page"). The panel's footer is the entry point, not the form. `SUBSCRIBED — MANAGE ›` for active subscriptions is deferred — needs a per-pubkey subscription-status check from `/api/v1/subscriptions/mine` that wasn't worth threading for this slice.

**Wiring (`WorkspaceView.tsx`).** New shared `pipPanel: { pubkey, status, rect } | null` state. Card `onPipOpen` sets it; the panel's `onClose` clears it. A one-shot `followsApi.listPubkeys()` call on workspace mount populates a `Set<string>` of the user's followed pubkeys; the panel reads its initial follow state from this set rather than each open firing its own membership check. `onFollowChanged` mutates the set so the next open of the same pip reflects the new state. The set isn't refetched after panel close — the canonical state is on the gateway, but for the workspace's lifecycle this approach matches the localStorage-first ethos of slice 5a (best-effort cache, optimistic updates).

**Follows API (`web/src/lib/api/follows.ts`).** New module with `listPubkeys / follow / unfollow`. Matches the existing `client.request<T>` pattern; re-exported from `web/src/lib/api.ts` facade. Mostly a tidy-up — `FollowingTab.tsx` was hitting `/api/v1/follows/...` via raw `fetch` because no namespace existed.

Skipped intentionally: VOLUME bar (no schema; needs polling-spec-proper-adjacent design pass), the three-poll-question UI (no polling backend), in-person count line (no `encounter` data exposure), subscribed-state detection in the footer (`SUBSCRIBED — MANAGE ›`), pip panel in non-green states (the four-state pip mapping per handoff §"Trust section" needs the polling result composition function — `ALLHAUS-OMNIBUS` §III.7 + open question), pip panel on mobile (sheet-from-bottom; ADR §5 mobile defer), block / mute (block lives elsewhere per handoff §"What the panel does NOT carry"; mute = 0% volume so retires with the volume bar's arrival), `ALL POLLING ›` depth affordance (needs the trust-detail surface), pip panel for external authors (cross-protocol identity resolution), focus management / focus trap inside the panel (the workspace a11y floor per ADR §6 keeps this minimal — Esc + outside-click close suffice), aria-expanded state on the trigger button, animated open/close (the panel snaps; Framer Motion's `AnimatePresence` could tween but the popover's small surface makes it unnecessary for now).

### Slice 13 — inline playscript thread on vessel cards (2026-05-02)

The slice 11 build log flagged `web/src/components/replies/PlayscriptThread.tsx` as surviving Migration Map §2 *replies/* but not yet wired into the vessel surface. Slice 13 wires it. Native cards (article + note) gain a `Thread` toggle in the action strip; tapping it expands an inline playscript directly under the card body.

**No new component.** `ReplySection` (the existing source-of-truth for tree fetch + flatten-to-playscript + reply-publish + vote-tally batching) is reused unchanged in shape. The slice adds a single new prop — `refreshKey?: number` — to its existing useEffect deps so an external publish path (the slice-11 overlay Composer) can nudge a refetch without remounting. `compact` (already supported) suppresses the section's own border-top + heading so the embed reads as part of the card.

**Surface (`VesselCard.tsx`).** `CardActions` gains an optional `Thread` button after `Reply` — text-only mono-caps in the strip's grey, label flips to `Hide thread` when expanded. Compact density still skips the action row entirely; the toggle is suppressed there. A new `CardThread` wrapper renders `ReplySection` inline and click-isolates the subtree (`onClick={(e) => e.stopPropagation()}`) so taps inside the thread don't bubble up to the card-level navigation. External cards don't render the toggle — `/api/v1/replies` keys on a native event id and the cross-protocol reply story is still deferred.

**State (`WorkspaceView.tsx`).** Two new pieces: `expandedThreads: Set<string>` (which event ids are open) and `threadRefreshTicks: Record<string, number>` (per-target counter bumped after an overlay-Composer reply lands). Toggle handler flips membership; the slice-11 overlay Reply path stays as the *fast* compose surface, but its reply-publish now also auto-expands the affected card's thread and bumps the tick so the new reply is immediately visible.

**`Composer.onReplied`.** New optional callback fires only on the reply branch of `handlePublishNote` (the four-line branch added in slice 11). Distinct from `onPublished` because note/article publishes refresh every vessel's items query, while reply publishes only need the affected card's thread to refetch.

**Brightness coverage.** ReplySection's hardcoded greys (text-grey-200, text-grey-300, etc.) don't recolour for dim/bright vessel palettes. Slice 13 accepts the slight palette mismatch — the playscript reads correctly, just isn't fully tokenised. Per-brightness theming for the playscript surface lives with the broader brightness × focus design pass (already deferred).

Skipped intentionally: reply count badge on the action strip (the existing `/api/v1/replies` endpoint exposes `totalCount` — surfacing it inline was deemed visual noise without a stronger reason to draw the eye to thread depth before expansion), in-thread quote-reply (the `Quote` action remains absent), nested-thread parent context beyond what the existing playscript already handles via the `→ PARENT:` line, animated expand/collapse (Framer Motion `AnimatePresence` would tween nicely but the visual snap reads fine and the workspace's animation budget is reserved for the ∀ ceremonies + drag), keyboard shortcut to toggle thread (per ADR §6 a11y floor — the button is Tab-reachable, just not chord-shortcutted), brightness-aware colour overrides for the playscript surface, share-toast affordance from inside the thread (the ReplySection still owns its own delete confirm + report — those routes remain unchanged).

### Slice 14 — pip panel VOLUME bar + per-feed-per-author commitment (2026-05-02)

Slice 12 left the VOLUME section of the pip panel out of the first cut, citing missing schema + design pending. Slice 14 ships it without a new migration — the existing `feed_sources` rows on migration 077 already have `weight`, `sampling_mode`, and `muted_at` columns reserved for exactly this purpose, and slice 4's `sourceFilteredItems` already filters on `muted_at IS NULL`. Volume becomes a thin pip-panel surface over those columns.

**Architectural call.** The handoff doc (`CARDS-AND-PIP-PANEL-HANDOFF.md` §"Open architectural questions") leaves whose-volume-applies-where unanswered: per-vessel? globally? Slice 14 decides per-vessel. The vessel *is* the per-feed surface; if you want a writer at low volume in your tech feed and high volume in your friends feed, that's the right default. Globally would conflict with the vessel-as-attentional-economy ethos.

**Routes (`gateway/src/routes/feeds.ts`).** Three new endpoints alongside the slice 4 source-CRUD surface:
- `GET /workspace/feeds/:id/author-volume/:pubkey` — read. Looks up `accounts.nostr_pubkey = $pubkey`, finds the matching `feed_sources` account row for that feed, returns `{ accountId, step, sampling, muted }`. `step = null` when there's no row (passive default — no commitment yet).
- `PUT /workspace/feeds/:id/author-volume/:pubkey { step: 0..5, sampling: 'random' | 'top' }` — upsert via `INSERT … ON CONFLICT (feed_id, account_id) WHERE source_type = 'account' DO UPDATE` against the existing partial unique index. Step 0 sets `muted_at = now()`; steps 1–5 clear `muted_at` and set `weight` per a five-bucket lookup (`[1.0, 0.25, 0.5, 1.0, 2.0, 4.0]` keyed by step). Step 3's weight matches the `feed_sources.weight DEFAULT 1.0` so a passive→committed-at-3 transition doesn't change ranking once weight is wired.
- `DELETE /workspace/feeds/:id/author-volume/:pubkey` — clears the row (back to passive). Unknown-author DELETE returns 204 rather than 404 because the only client gesture is *clear commitment*, and a missing row already represents the cleared state.

**Sampling mapping.** The route's `'random'` ⇔ `feed_sources.sampling_mode = 'random'`, `'top'` ⇔ `'scored'`. The third existing value `'chronological'` is the hidden default, matching what slice 4's items query actually does today; the bar UI doesn't surface it.

**Surface (`PipPanel.tsx`).** New `feedId?: string` prop. When set on a non-self panel, a `VolumeBar` section renders below the trust signals: a six-button row (× mute, then steps 1..5), a `CLEAR` link to return to passive, and a RANDOM/TOP toggle (visible only at step ≥1, where sampling is meaningful). Active steps fill in solid black; mute is solid crimson; passive (no commitment) renders all empty. Optimistic local state with a refetch-on-failure recovery path. Hint copy below the bar adapts: passive → "Default — no commitment yet"; muted → "Muted in this feed"; committed → "Weight is recorded; ranking by volume lands when the items query honours weight" (honest about the deferred ranking story).

**Wiring (`WorkspaceView.tsx`).** The existing `pipPanel` state gains `feedId: string` (the vessel the click came from); the per-card `onPipOpen` curry now passes `v.feed.id`. New `onVolumeChanged` callback on `PipPanel` triggers `loadVesselItems(target.feed)` so a freshly-muted author drops from the visible card set without a manual reload — the items query already filters muted sources.

**Why no new table.** Reusing `feed_sources` keeps the items query consistent across slices: an author is a tracked source whether the user added them via the source composer (slice 4) or via the volume bar's first-step commitment. The two surfaces author the same row shape. A separate `feed_author_overrides` table would have required a parallel mute filter in the items query and an extra precedence rule between two separate weight columns.

**Web client (`web/src/lib/api/feeds.ts`).** New `workspaceFeedsApi.getAuthorVolume / setAuthorVolume / clearAuthorVolume` plus the `AuthorVolume` type. Standard `client.request` shape; re-exported from the api facade.

Skipped intentionally: ranking-by-weight in the items query (still chronological per slice 4 — wiring weight into the SQL is the larger ranking story), volume bar on external cards (no native account_id; cross-protocol pip panels are deferred), keyboard equivalents for the bar (per ADR §6 a11y floor), continuous (drag-to-set) volume (touch gesture + fine resolution storage; the discrete five-step buckets match the wireframe and the storage shape is forward-compatible), volume bar in the author's own pip panel (you can't set commitment for yourself), per-source-not-just-author volume (a publication source has weight too — the source composer already shows it as a column, but the surface-side dial belongs in the source composer not the pip panel), TOP-mode metric definition (the route accepts the value; the ranking semantics defer with the items-query-honours-weight slice), bulk import / import follows-as-volume-set, undo-clear toast.

### Slice 15 — three-question polls + minimal polling backend (2026-05-02)

The pip panel's TRUST section becomes load-bearing for the spec's three questions per `CARDS-AND-PIP-PANEL-HANDOFF.md` §"Trust section":
1. *Are they human?*
2. *Are they who they seem to be?*
3. *Do they engage in good faith?*

**Honesty about anonymity.** ADR-OMNIBUS §III.7 frames trust polling as anonymous via a separate attestation service that doesn't see session data. Slice 15 *does not* build that pipeline. It ships a non-anonymous `respondent_id` in the row so writes are attributable at the database level. The route shape mitigates: `GET /trust/polls/:userId` only ever surfaces aggregate counts + the viewer's own row — no other respondent's identity is reachable through any panel-side path. The honest framing is *minimal polling backend, not anonymous polling backend*. The attestation-service rewrite replaces the table when it lands; the client UI is already shaped for aggregate-only reads, so no panel work is wasted.

**Schema (migration 078).** `trust_polls(id, respondent_id, subject_id, question, answer, created_at, updated_at)`. `question` is one of `humanity / authenticity / good_faith`; `answer` is `yes / no`. UNIQUE on `(respondent_id, subject_id, question)` so re-answers upsert. `CHECK (respondent_id != subject_id)` — you don't poll yourself. Index on `(subject_id, question)` for the aggregate read. `updated_at` trigger on edit.

**Question naming choice.** The handoff intentionally distinguishes the three poll questions from the four `vouches` dimensions (humanity, encounter, identity, integrity). `humanity` overlaps; `authenticity` ("who they seem to be") is *deliberately weaker* than the formal `identity` vouch dimension; `good_faith` is the behavioural-honesty question the handoff explicitly defends as *not* the abstract `integrity`. New names rather than reusing existing dimension labels keep the two surfaces distinct in the schema, which matters when the anonymous-attestation rewrite arrives — vouches and polls have different anonymity guarantees.

**Routes (`gateway/src/routes/trust.ts`).** Three new endpoints under the existing trust router:
- `GET /trust/polls/:userId` — `optionalAuth`. Returns `{ subjectId, polls: { humanity: { yes, no, viewerAnswer }, authenticity: …, good_faith: … } }`. `viewerAnswer` is `null` for anonymous viewers or for questions the viewer hasn't answered. Two queries: a `GROUP BY question, answer` aggregate, and (when authenticated) a viewer-scoped row lookup. The shape always includes all three questions, with zero counts for ones never polled, so the client doesn't have to handle missing keys.
- `POST /trust/polls/:userId { question, answer }` — `requireAuth`. Subject-self block (`userId === respondentId` returns 400). Validates question + answer. Upsert on the unique key.
- `DELETE /trust/polls/:userId { question }` — `requireAuth`. Withdraws the viewer's row. 204 on success or no-op.

**Surface (`PipPanel.tsx`).** New `PollQuestions` component renders three rows below the Layer 1 trust signals (suppressed for the user's own pip — you don't poll yourself). Each row: Literata 13px question label · YES toggle (solid black when chosen) · NO toggle (solid crimson when chosen) · right-aligned `N%` confidence (yes-share of total, em-dash when no votes). Optimistic update on tap — the bar moves before the round-trip — with a re-fetch on failure to recover from drift. Re-tapping the viewer's current answer withdraws it (so you can change your mind, or unanswer to "don't know"). Italic Literata footnote: *Polls about &lt;name&gt; are visible only as totals — your own answer is editable.* — naming the privacy contract the route enforces. The slice 12 *Polling questions land in a future slice.* placeholder copy is gone.

**Web client (`web/src/lib/api/trust.ts`).** New `trustApi.getPolls / submitPoll / withdrawPoll` plus `PollQuestion`, `PollAnswer`, `PollAggregates`, `PollsResponse` types. Re-exported via the existing api facade.

**Pip-colour composition still deferred.** The handoff §"Trust section" + §"Open architectural questions" notes that the pip's four-state colour (green / amber / grey / crimson) should compose from the three poll results plus in-person (`encounter` vouch) count. Slice 15 ships *the data and the gesture* but doesn't change the pip's colour mapping — `trust_layer1_refresh` still drives `pip_status` purely from Layer 1 signals. Wiring poll aggregates into the pip mapping is a separate slice that owns the threshold function (the handoff calls it out as trust-system-spec-proper territory).

**Single respondent per row.** No multiple identities, no Sybil resistance, no decay. Slice 15 is the smallest possible thing that makes the panel real. The full trust system per ADR-OMNIBUS adds: anonymous attestations (encrypted to a service pubkey), graph-weighted aggregation, decay across epochs, concentration / Sybil discount factors, the humanity ratchet. None of that is in slice 15. The route shape, however, doesn't expose attribution to clients — so swapping the storage backend is a server-side replacement.

Skipped intentionally: anonymous attestation pipeline (the trust-system-proper rewrite), graph-weighted aggregation (every respondent counts equally — the handoff's "anonymous and secure, drawing on the user's trust graph and the wider network" language requires the full system), decay across time, Sybil discount, the in-person count line below the three questions (needs `vouches.dimension = 'encounter'` data piped through — separate slice), pip-colour composition from poll results (the pip still maps from Layer 1 only), `ALL POLLING ›` depth view (the handoff's extended detail surface), confidence intervals on the percentage display (the handoff calls for "high confidence" colour signalling — needs a sample-size threshold function), question-level mute (a viewer who doesn't want to opine on humanity can simply not tap; a separate "skip" affordance is unnecessary friction), poll-question version history (today's three are not necessarily the final phrasing — when they change, existing rows stay valid because the question key is the join target, not the rendered string).

### Slice 16 — items query honours `feed_sources.weight` + `sampling_mode` (2026-05-02)

The slice 14 volume bar stops being a placebo. `sourceFilteredItems` now ranks rows by an `effective_score = mode_value × weight` blend rather than chronological-ignoring-weight. The volume bar's hint copy in `PipPanel.tsx` drops the *ranking by volume lands when the items query honours weight* admission and reads the terse *Weight applied to this feed's ranking.* — the bar's commitment is now observable in the vessel that triggered it.

**Rewrite (`sourceFilteredItems` in `gateway/src/routes/feeds.ts`).** Three CTEs replace the slice-4 single SELECT:
1. `feed_mode` — the feed's dominant `sampling_mode` across non-muted source rows. `GROUP BY sampling_mode ORDER BY COUNT(*) DESC, sampling_mode LIMIT 1`. Alphabetical tiebreak makes the choice deterministic when two modes have equal source counts.
2. `matched` — every `feed_items` row that matches at least one non-muted source, with `weight = MAX(fs.weight)` across matches. The four `source_type` branches collapse into a single `JOIN feed_sources fs ON ... AND (account-match OR pub-match OR external-match OR tag-match)` with `GROUP BY fi.id`. Two sources for the same writer (e.g. account row + publication row) take the louder of the two weights.
3. `scored` — runs `FEED_JOINS`, applies block / mute / reply-roots gates, computes `effective_score` from the dominant mode:
   - `chronological` → `EXTRACT(EPOCH FROM published_at) * weight`
   - `scored` → `COALESCE(fi.score, 0) * weight` (the existing `feed_scores_refresh` value)
   - `random` → `random() * weight`

Outer SELECT cursors on `(effective_score, fi_id)` with row-comparison `< ($4::float8, $5::uuid)`.

**Cursor format (`parseScoredCursor`).** New 2-part `${effective_score}:${id}`. Distinct parser from `parseCursor` because the float vs `parseInt` matters for fractional weights — the existing `parseCursor` would silently truncate a `19345678.5` epoch-times-half score. Random mode's cursor is mathematically valid (later pages still filter `< previous_score`) but next-page rows reshuffle because `random()` reseeds per query — load-more under random mode is a re-roll, not stable pagination.

**Per-source mode mixing — deferred.** A feed with one `chronological` and one `scored` source picks whichever mode has more source rows. Per-row mode dispatch (chronological's chrono-author beats scored's scored-author when they're in the same vessel) needs the mode column flowing through the per-row score computation; the dominant-mode rule is the honest first cut.

**PipPanel hint update.** `web/src/components/workspace/PipPanel.tsx` `VolumeBar` hint copy drops the deferred-ranking disclaimer; the panel-level docstring updates to acknowledge slices 14–16 as the volume + polling story rather than placeholders.

**No new dependencies.** All data already lives in `feed_sources` (migration 077) and `feed_items.score` (existing `feed_scores_refresh` cron). The only code change is the SQL rewrite + cursor parser + hint copy.

Skipped intentionally: per-source mode mixing inside one feed (one source chronological, another scored — needs row-level mode dispatch), random-mode stable pagination (would need a per-cursor seed; load-more re-rolls is acceptable for the experiment), weight-into-explore (the empty-source placeholder branch keeps its score-DESC explore semantics — placebo-on-a-feed-with-no-sources is the explore stream itself, not the volume bar's territory), cross-vessel ranking interactions (each vessel still scores independently — a writer at weight-4 in feed A and weight-1 in feed B is correctly ranked per-vessel), explicit TOP metric definition (the route accepts `'top'` and maps it to `sampling_mode = 'scored'` which uses `feed_items.score` — refining what TOP "means" beyond reusing the existing score is its own pass), unit/integration tests against a live DB (the gateway's vitest harness mocks `pool.query` so testing this would assert SQL string shape, not behaviour — manual smoke is the verification floor for this slice, matching slices 13–15), volume-bar honest-state when the underlying source row didn't exist before commit (currently the PUT creates it; that's still correct — the bar was always meant to upsert).

### Slice 17 — pip colour composition from polls + Layer 1 (2026-05-02)

The pip stops mapping purely from Layer 1 thresholds. Slices 12 and 15 had built up the data layer (L1 signals + three-question polls) but the pip's colour was still set by the slice-1-shipped SQL CASE on `(account_age_days, paying_reader_count, payment_verified)` only — polls were collected but never observed in the inline glyph. Slice 17 closes the loop with a four-state composition (`known/partial/unknown/contested`) blending both inputs.

**Migration 079.** `trust_layer1.pip_status` CHECK constraint widens from three values to four — adds `'contested'`. No data migration needed; the daily refresh repopulates every row.

**Compose function (`feed-ingest/src/lib/trust-pip.ts`).** Pure module, no DB. `composePipStatus({layer1, polls}) → PipStatus`. Threshold rules:
- **Crimson (`contested`)** — `humanity` no-share ≥0.7 (with sample ≥3) OR `good_faith` no-share ≥0.7 (with sample ≥3). Authenticity-no alone stays amber, not crimson — the handoff intentionally distinguishes authenticity (a deliberately weaker question than the formal `identity` vouch dimension) from the behavioural-honesty signal `good_faith`.
- **Green (`known`)** — all three polls positive (yes-share ≥0.7, sample ≥3) AND L1 anchor (NIP-05 verified OR ≥1 paying reader). The L1 anchor stops a flood of poll-positive responses on a brand-new account from minting a green pip without any platform-side commitment from the writer.
- **Amber (`partial`)** — any single poll positive (with sample), OR strong L1 (≥3 articles + payment_verified) without polls. Lets a writer with low polling volume but real platform commitment surface above grey.
- **Grey (`unknown`)** — no meaningful signal yet.

Sample-size floor of 3 is the honest first cut — keeps a single hostile vote from flipping the pip but doesn't pretend to confidence-interval rigour. The handoff calls for proper confidence-interval scaling once the system has volume; we'll tune after a week of real polling. Threshold values (0.7 / 0.3 / 3) are chosen by feel and live as constants at the top of the module so a tuning pass touches one place.

**Tests (`feed-ingest/src/lib/trust-pip.test.ts`).** 14 unit tests covering each state + the sample-size floor + edge cases (authenticity-no without humanity-no stays amber; humanity-no overrides any L1 anchor; ambiguous polls without L1 stay grey; below-floor poll volume reads as no-data).

**Cron (`feed-ingest/src/tasks/trust-layer1-refresh.ts`).** Existing daily task no longer composes pip in SQL. Single SELECT now also pivots `trust_polls` into six per-subject counts via `LEFT JOIN poll_aggregates`; JS calls `composePipStatus()` per row; bulk upsert via `UNNEST` keeps it to two round-trips total. Threshold logic is in JS rather than SQL CASE so a tuning change touches one file.

**Frontend (`web/src/components/ui/TrustPip.tsx`).** `PipStatus` type widens; `PIP_COLORS` adds `contested: '#B5242A'` (the crimson the rest of the workspace uses); `PIP_TITLES` adds `'Contested signal'` for the tooltip. `web/src/lib/ndk.ts` widens its exported `PipStatus`. The deprecated `web/src/components/feed/ExternalCard.tsx` (kept until merge per Migration Map §1) widens its inline copy of the union too — small busywork, retires with the file.

**No pip-panel surface change.** `PipPanel.tsx` already shows raw L1 + polling aggregates; the composition lives behind the inline pip glyph. The panel surfaces the *constituent* data so users can see why a pip is the colour it is — no new copy needed.

**Refresh cadence still daily.** A poll vote's effect on the inline pip lands at the next `trust_layer1_refresh` (01:00 UTC). Real-time pip refresh on vote would need either a per-write trigger or a fast-path recomputation in the route handler; the daily cron is the cadence the broader trust system uses, and the panel itself shows live aggregates so the user sees their tap reflected immediately even if the inline pip lags.

Skipped intentionally: encounter count from `vouches.dimension = 'encounter'` (the in-person-met signal — its own slice; the handoff intends it as a hard upgrade path to green), confidence-interval / sample-size scaling beyond the floor of 3 (the current rule is honestly placeholder), real-time pip refresh on poll vote (cron-cadence is intentional), per-viewer pip composition (the eventual "trust as a function of *your* graph" needs the Layer 4 relational layer plus a per-request compute path, deferred), hysteresis to prevent a pip flapping between contested ↔ partial when sample sizes hover at the threshold (revisit if it shows up in real data), pip composition for external authors (still grey because external authors don't have a platform user id, same constraint as slice 12), seeding a refresh on poll-write so freshly-polled subjects update faster than the daily cadence.

### Slice 18 — encounter count + hard upgrade path to green (2026-05-02)

Slice 17 reserved encounter (in-person met) as the hard upgrade path to green but didn't pipe the data in — the pip composer was still keying on `(humanity, authenticity, good_faith, L1)` only. Slice 18 closes that loop. `vouches.dimension = 'encounter'` affirms become a third L1 anchor option, and the pip panel gains an encounter count line plus an "I've met them" toggle for the viewer.

**Compose function (`feed-ingest/src/lib/trust-pip.ts`).** `PipLayer1` extends with `encounterCount: number`. The threshold rules widen:
- `l1Anchor` — was `nip05Verified || payingReaderCount > 0`. Now also unlocks when `encounterCount ≥ 1`. So a brand-new account with all-three-polls-positive can mint green if even one person has affirmed meeting them in person, without needing NIP-05 or paying readers.
- `strongL1` — was `articleCount ≥ 3 && paymentVerified`. Now also satisfied when `encounterCount ≥ 2`. Two independent in-person affirms is a real signal even without articles or payment activity, and lifts the pip from grey to amber.

**Threshold call.** Encounter ≥ 1 = anchor, ≥ 2 = strong-alone. Polling has a `SAMPLE_FLOOR = 3` because polls are cheap and Sybil-prone; encounters are deliberate, expensive gestures (you have to know the person *and* explicitly affirm you've met them) so the floor is lower. A single affirm doesn't lift you above grey on its own (still requires polls + anchor for green, or strong L1 for amber), but it does *gate* the green path. Two affirms gates amber. The constants `ENCOUNTER_ANCHOR = 1` / `ENCOUNTER_STRONG = 2` live at the top of the module so a tuning pass touches one place.

**Crimson is uncrossable.** Encounter does not override `humanity-no` or `good_faith-no`. Meeting someone in person doesn't cancel multiple credible accounts of bad faith — the order of evaluation in `composePipStatus` still checks negative polls before any anchor logic. Test `'encounter does not override humanity-no'` is the regression guard.

**Cron query (`feed-ingest/src/tasks/trust-layer1-refresh.ts`).** New `encounter_aggregates` CTE alongside the existing `poll_aggregates`. `COUNT(*) WHERE dimension = 'encounter' AND value = 'affirm' AND withdrawn_at IS NULL`, grouped by `subject_id`. Outer SELECT carries `COALESCE(ea.encounter_count, 0)`, JS passes through to `composePipStatus()`. Bulk upsert shape unchanged — the encounter count is consumed inside the JS composer, not stored on `trust_layer1` (the pip composer reads it; the L1 row only stores the *outcome* `pip_status`). Two-round-trip pattern preserved.

**Visibility-agnostic count.** The pip uses *all* non-withdrawn encounter affirms — both `public` and `aggregate` visibility — because the count matters for trust-system purposes regardless of whether the attestor is publicly named. The /trust/:userId panel surface separately filters `publicEndorsements` on `visibility = 'public'`; that's the right place for visibility filtering, not the pip composer. Contests are excluded (the route already restricts contests to aggregate-only — that's about visibility, not count — but the encounter signal is specifically about affirmative "I've met them" claims, so the SQL filters on `value = 'affirm'`).

**Gateway response (`gateway/src/routes/trust.ts`).** `GET /trust/:userId` adds a top-level `encounter: { affirmCount }` field. Done as a small dedicated COUNT query rather than reusing the existing `dimensions[encounter].attestationCount`, because the latter combines affirm + contest into a single number for the four-dimension trust profile shape. The pip panel needs the affirm count cleanly. Two queries instead of one; the cost is trivial against the existing per-pip-open round trips.

**Panel surface (`web/src/components/workspace/PipPanel.tsx`).** New `EncounterRow` component. Renders below the L1 signals (separated by hairline `borderTop`) with a Literata 13px line — `Met by N people in person.` (or `Not yet met by anyone in person.` for zero, `Met by 1 person in person.` for the singular) — and a right-aligned `I'VE MET THEM` mono-caps toggle. Solid-black filled when active (matches the YES poll button's grammar). Tap-to-affirm posts `vouches { dimension: 'encounter', value: 'affirm', visibility: 'aggregate' }` via the existing `trustApi.vouch`; tap-to-withdraw uses `trustApi.withdrawVouch(id)`. Optimistic count update with revert on failure. Self-pip suppresses (you can't vouch you've met yourself — the existing `attestor_id != subject_id` CHECK enforces this server-side too).

**Visibility = aggregate, not public.** The panel toggle commits an aggregate-visibility vouch — count-only, attestor identity not surfaced on the writer's `publicEndorsements`. This matches the slice-15 polling contract (your gesture is editable, totals are what other people see). A reader who wants to publicly endorse meeting someone can still upgrade via the full vouch surface at `/network`. Keeping the panel gesture lightweight: one tap, no visibility picker. The handoff frames the encounter line as a count display, not an endorsement graph.

**Pip refresh cadence still daily.** Like slice 17's poll votes, an encounter affirm's effect on the inline pip lands at the next `trust_layer1_refresh` (01:00 UTC). The panel itself reflects the count immediately (optimistic update), so the user sees their tap take effect even if the inline pip lags.

Skipped intentionally: encounter-public visibility from the panel (the full-vouch surface at `/network` still owns public-encounter affirms; the panel's gesture is the lightweight aggregate path), confidence-weighted encounter (the handoff alludes to attestor weighting per Layer-2 epoch aggregation — that's the trust-system-proper rewrite, not this slice; here every affirm counts equally), encounter-as-poll-question hybrid (the handoff considers a "did you meet them?" yes/no question alongside the four poll questions — different mental model, separate slice), per-viewer pip composition that *requires* an encounter from someone in your follow graph (Layer 4 in spirit; needs Layer 4 plumbed into the per-request compute path), encounter requiring two-sided confirmation (the spec's eventual "we both met" reciprocal flag — current implementation is one-sided like the rest of `vouches`), encounter on external authors (no platform user id; the `subject_id` foreign key keys on `accounts.id`), seeding a refresh on encounter-write so freshly-vouched subjects update the pip faster than the daily cadence (matches the slice-15 / slice-17 pattern), pip-panel "remove I've met them" confirm step (one-tap toggle is the right friction floor — the user can re-tap to revert).

### Slice 19 — pip panel framing for non-green states (2026-05-02)

Slices 12 → 18 built up the pip panel's data layer (L1 + dimension scores + Layer 4 + polls + encounter + composed pip status) without ever varying the panel's chrome by pip state. The same flat header + same trust section rendered whether the writer's pip was green, amber, grey, or crimson — the only state difference was the inline glyph's colour, inherited via `<TrustPip status={pipStatus} />`. Slice 19 ships the framing layer the panel was always meant to carry: a per-state subtitle that names what the pip means and where the gesture lives, plus a coloured accent stripe at the top of the panel that visually keys it to the pip state.

**`STATUS_PRESENTATION` map.** New module-local constant in `PipPanel.tsx` keyed on `PipStatus`. Each entry carries `accent` (the matching pip colour) + `subtitle` (an italic Literata one-liner). The four lines:
- `known` → `#1d9e75` · *Established profile — readers confirm the basics.*
- `partial` → `#ef9f27` · *Developing profile — some signal, more would help.*
- `unknown` → `#b0b0ab` · *New here — tap below to share what you know.*
- `contested` → `#B5242A` · *Contested — readers have raised concerns.*

The colours mirror `web/src/components/ui/TrustPip.tsx`'s `PIP_COLORS` lookup. Re-importing would have meant either exporting the constant from `TrustPip.tsx` (incidental coupling — `TrustPip` is a glyph component that doesn't otherwise know about panels) or pulling both consumers through a shared tokens module that doesn't exist yet. The four-line dup is the honest move; both surfaces evolve together because they're tied to a single design call about pip palette.

**Stripe at the top.** A 3px-tall full-width band sits flush above the panel padding, inside the 1px black panel border. Mirrors the workspace's chassis-bar grammar — slice-1 cards use the same left-bar pattern (4px solid bar, varies by card type). The stripe is `aria-hidden` because the inline pip glyph already carries the accessible-label semantics; the stripe is purely visual reinforcement.

**Subtitle under the writer name.** Italic Literata 13px in `TOKENS.hint`, sits between the header row and the bio (or directly above the TRUST section when bio is empty). Names what the pip means in plain language, and for non-green states gestures toward the affordance that exists below — *tap below to share what you know* points at the polls + encounter sections without spelling them out.

**Self-pip suppresses both.** New `showFraming = !isOwn && !loading && !error && writer !== null` gate. The framing is about how *others* read the writer; doesn't apply when looking at your own pip. The load/error gating prevents a flash of "wrong colour" stripe before the trust profile loads — the panel currently assumes a default of `unknown` until trust data lands, which would otherwise render a grey stripe for ~150ms before flipping to the real status.

**No section reordering.** The slice 12 → 18 sections (TRUST L1 signals, encounter row, poll questions, VOLUME bar, SUBSCRIBE footer) stay in the same order regardless of pip state. The data layer is sound; what was missing was *framing*, not architecture. Reordering would over-engineer a slice that's about copy + tone.

**Encounter / poll button palettes unchanged.** YES is solid black, NO is solid crimson. Keying the buttons to the pip palette would muddy the polling signal — the user is registering an opinion *about* the writer, not echoing the existing pip colour. The crimson NO + black YES grammar is one of the panel's load-bearing decisions and stays untouched.

**No tooltip / aria-live announcement on stripe colour change.** The pip glyph itself carries `title` + `aria-label` per `TrustPip.tsx` (e.g. "Contested signal"). Duplicating that on the stripe would be redundant for screen readers and noisy for sighted users; one source is enough.

Skipped intentionally: section reordering by state (e.g. polls foregrounded for grey, contests-list foregrounded for crimson — the current chrome carries the framing without rearranging structure), state-conditional CTAs (e.g. a `REPORT THIS USER ›` link in the contested-state footer — abuse reporting lives at a different surface and isn't part of the pip panel's gesture vocabulary), polling-question reordering when the pip is contested (showing the negative-tally question first — the `humanity / authenticity / good_faith` order is design-canonical and reordering by state would obscure the question you're asking), animated stripe transition between states (slice cadence doesn't justify the Framer Motion plumbing for a colour change that happens once on open and never re-renders without a panel close), per-status pip glyph sizing on the header (today's 1.4× scale is constant), help-text overlay explaining the four states (the legend is implicit in the subtitle copy; an explicit pip-states cheat sheet would belong on a `/about/trust` page that isn't built), the 'unknown' state's invitation copy varying by whether the writer has *any* L1 signal vs literally zero (the "new here" framing reads OK across the gradient — overshooting precision when there's no data to drive a finer copy split), per-locale subtitle copy (i18n is its own infrastructure pass that the workspace experiment hasn't tackled).

### Slice 20 — per-feed save persistence + Save action + saved view (2026-05-02)

The Deferred list's leading item retires. Slice 11's card action strip reserved a Save slot but the spec was vague on cross-feed vs per-feed semantics; ADR §3 left save persistence open *until the surface design solidifies*. Slice 20 commits per-feed: saves belong to the vessel that minted them. The same article saved in two vessels lives as two `feed_saves` rows. The legacy `bookmarks` table (articles only, per-user, global, used by the deprecated reading-mode chassis' `BookmarkButton`) survives until merge — slice 20 doesn't touch it; the workspace and the reading-mode chassis are deliberately separate save surfaces.

**Architectural call: per-feed.** The vessel *is* the per-feed surface; saves are an attentional stash, and stashing in a vessel means *for use in this vessel*. Cross-feed unified save would conflict with the vessel-as-attentional-economy ethos and would force a "save to which feed?" picker on the gesture. Per-feed keeps Save a one-tap commit. Cross-vessel "move to" is a future gesture that needs its own design pass; slice 20 doesn't ship it.

**Schema (migration 080).** `feed_saves(id, feed_id, feed_item_id, created_at)`. Cascade on both FKs (feed deletion + item soft-deletion are both load-bearing — deleted items get filtered server-side, deleted feeds wipe their saved set with the rest of the feed). UNIQUE on `(feed_id, feed_item_id)` makes re-save idempotent. Compound index `(feed_id, created_at DESC, id DESC)` supports the listing cursor + the `ids` lookup. No `saved_by` column — feeds are owner-private and the route checks ownership before any read or write; if shared/group feeds ever land, the column adds straight.

**Routes (`gateway/src/routes/feeds.ts`).** Four new endpoints:
- `GET /workspace/feeds/:id/saves?cursor=…&limit=…` — listing in save-time DESC. Reuses `FEED_SELECT` + `FEED_JOINS` so the response items are byte-identical to `/items` plus a `savedAt` epoch. Cursor parses `${epoch_ms}:${feed_save_id}`; ms (vs seconds) preserves intra-second ordering without a tiebreaker beyond the row id we already emit. Soft-deleted `feed_items` are filtered so a save outliving its target cleans visually without a separate sweep.
- `GET /workspace/feeds/:id/saves/ids` — light-weight `Set<feedItemId>` for the strip to render Save vs Saved labels without per-card round trips.
- `POST /workspace/feeds/:id/saves { feedItemId }` — idempotent save. Pre-checks `feed_items.id IS NOT NULL AND deleted_at IS NULL` so a deleted target returns 404 rather than silently succeeding via `ON CONFLICT DO NOTHING` (which would surface a ghost row in the saved view).
- `DELETE /workspace/feeds/:id/saves/:feedItemId` — unsave. 204 on success, no 404 on missing — the gesture is "make this not saved" and a missing row already represents that state.

**Plumbing `feed_items.id` to the client.** `rowToItem` now exposes `feedItemId: row.fi_id` on all three item shapes (article/note/external). The save target is the unified id, not per-type Nostr/external IDs. `web/src/lib/ndk.ts` extends `ArticleEvent`, `NoteEvent`, `ExternalFeedItem` with optional `feedItemId?` (optional because reading-mode + profile pages build these objects without going through the unified table) and an optional `savedAt?` field that's present only in the saved view's response.

**Web client (`web/src/lib/api/feeds.ts`).** `workspaceFeedsApi` gains `listSaves / listSavedIds / saveItem / unsaveItem`. Same `request` shape as the rest of the namespace.

**Save button on the strip (`VesselCard.tsx`).** `CardActions` accepts `feedItemId / isSaved / onToggleSave` and renders a `Save` / `Saved` button after `Share`. Saved is crimson (the workspace's "committed" colour, matching crimson Send / SUBSCRIBE / contested pip). Suppressed in compact density (the strip is suppressed there entirely). Suppressed if the item lacks a `feedItemId` so non-workspace mounts don't render an action they can't fulfil. External cards include the button — saves key on `feed_items.id` not Nostr event id, so externals are first-class save targets unlike vote/reply.

**Vessel SAVED view toggle.** `Vessel.tsx` accepts `savedView?: boolean` + `onToggleSavedView?` and renders a fourth chassis control alongside `brightness · density · orientation`: `★` (filled crimson) when in saved view, `☆` (resize-handle grey) when in live view. Tap flips the binary. The name label appends ` · SAVED` when the toggle is active so the mode flip is unmistakable from the floor — the vessel rendering is otherwise identical between views.

**WorkspaceView state.** `VesselState` extends with `view: 'live' | 'saved'` + `savedIds: Set<string>`. Bootstrap seeds `view: 'live'` and `savedIds: new Set()` per vessel, then fires a `listSavedIds` per feed in the background to populate the Set so the strip's Save / Saved labels render correctly from first paint. `loadVesselItems(feed, view?)` branches on view and hits either `items` or `listSaves`. A `vesselViewRef: Map<string, view>` mirrors the latest view per vessel so `loadVesselItems` (which is `useCallback`-stable) reads the right view without taking a fresh closure on every state change. Toggle handler: flips `v.view`, sets `items: []` + `status: 'loading'`, fires `loadVesselItems` with the new view.

**Optimistic save toggle.** `handleToggleSave(feedId, feedItemId, next)` mutates the affected vessel's `savedIds` Set immediately (add or delete), and — if currently in saved view + this is an unsave — drops the item from the visible list so the gesture's outcome is observable without a refetch. On request failure, the Set is reverted; a dropped item isn't restored to the saved view because the filter discards its data. The user can flip back to live and retry.

**Empty saved state.** Saved view with no items renders *NO SAVED ITEMS YET — TAP SAVE ON A CARD TO KEEP IT HERE*; live view keeps the existing *NO ITEMS*. The hint reads as guidance, not error.

**No store extraction.** `WorkspaceView`-local state is enough; the per-vessel save Set + view-mode aren't shared with any other surface. A `useWorkspaceSaves` extraction can wait until a second consumer arrives (e.g. a saved-items badge in the topbar adjacent or a cross-feed roll-up). Slice 5a's drag store, slice 14's `feed_sources` reuse, and slice 15's polling state all followed the same "extract on second consumer" rule.

**View-mode is session-ephemeral.** Reloading the workspace returns each vessel to the live view. Persisting view-mode in localStorage would be possible (`useWorkspace` already keys on `feedId`) but the saved view is genuinely a brief detour, not a sticky channel — coming back to a workspace that auto-flips to SAVED on any vessel would feel surprising. The Save persistence (the `feed_saves` rows) is server-backed; the view *toggle* is intentionally ephemeral.

Skipped intentionally: cross-feed save view ("all my saves" — slice 20 is per-feed by design; if a cross-feed gesture lands later it's a `/saved` route or a special vessel, not a flag on the existing list), save-into-a-different-feed picker (the Save button always saves to the active vessel; cross-feed move is its own gesture), pagination in the saved view (returns the first 50; cursor exists in the route + the API client but the client renders a single page and load-more is its own slice), save count badge on the chassis (a `★ N` indicator next to the toggle when saves exist), share-toast affordance on save commit (the strip flips Save→Saved which is visible enough), keyboard equivalent for the SAVED toggle (per ADR §6 a11y floor — the button is Tab-reachable, just not chord-shortcutted), drag-to-reorder saved items (the order is save-time DESC; user-driven reorder is a deeper persistence story), saving from compact density (compact suppresses the action strip entirely; slice 20 doesn't break that rule), legacy `bookmarks` cross-pollination (saving an article on the workspace doesn't backfill the legacy table; the two surfaces are deliberately separate and the legacy table retires on merge), volume×save interplay (a muted author's previously-saved item still appears in the saved view — saved is intentional retention, mute is "less of this in my live feed", and the two commitments don't override each other), per-feed-item annotation / note (a "why I saved this" textarea per save — needs schema changes the slice doesn't ship).

### Slice 21 — notifications anchor (2026-05-02)

The Deferred list's *Notifications anchor (corner pip vs ∀-menu adjunct vs vessel)* item retires. Slices 11–20 closed the active loops (reply, save, vouch, poll, encounter) for the *actor* but the *recipient* of those gestures had no surface on the chrome-less workspace floor — the Phase A topbar's notification badge retired with slice 1.5, and `/notifications` is a carry-over page the workspace user never has reason to visit. Slice 21 ships the anchor without rebuilding any data plumbing: the existing `notifications` table + `GET /api/v1/notifications` + `GET /api/v1/unread-counts` + `POST /notifications/:id/read` + `POST /notifications/read-all` (all already in `gateway/src/routes/notifications.ts`) are sufficient.

**Architectural call: bell adjacent to ∀, not a vessel.** The pre-existing ADR open question framed three candidates: corner pip / ∀-menu adjunct / notifications vessel. The vessel option is tempting (notifications-as-feed fits the workspace ethos) but breaks the `Vessel` chassis abstraction — vessels render `feed_items`, and notifications aren't `feed_items` — and would have forced "is the notifications vessel always present? does it persist across resets?" decisions that aren't worth answering for an alert surface. The ∀-menu adjunct miscategorises notifications as object creation. A bell button in the bottom-right cluster, immediately to the left of ∀, is the lightest fit: it's a workspace-scope control like ∀, it doesn't pretend to be feed content, and the cluster pattern (∀ + bell) makes the bottom-right read as the workspace's affordance corner.

**Anchor surface (`NotificationsAnchor.tsx`).** New component. A 40px white disc with a 1px black border, line-icon bell glyph, and an unread badge in workspace crimson (`#B5242A`). The disc is intentionally smaller than ∀ (56px) and lighter-weight (white vs black) — ∀ is the dominant gesture, the bell is subordinate. Position: `right: 96, bottom: 32`, where 96 = ∀'s `right: 24` + 56 width + 16 gap, and `bottom: 32` vertical-centres the 40px disc against ∀'s 56px axis. The badge tops out at `99+` for readability — anyone with three-digit unread is already past the affordance's design intent.

**Panel surface.** Click opens a 380×min(560, 100vh-120) popover anchored bottom-right, matching the `PipPanel` / `NewFeedPrompt` / `ForkFeedPrompt` material grammar (white bg, hairline black border, soft shadow). Top row: `NOTIFICATIONS` mono-caps label + `MARK ALL READ` mono-caps action (disabled-grey when unread is zero). Scrollable list of rows below. Footer with `OPEN FULL LOG ›` link to `/notifications` for users who want pagination + the historical log — the popover renders the first 30 (the route's default page size) and doesn't paginate inline. Outside-pointerdown + Esc close. `z-index: 50` matches `ForallMenu`.

**Row layout.** Per row: a 6px crimson dot (placeholder when read — keeps width stable so titles don't reflow on read-state change) · `Actor name` (Jost 13px, semibold when unread, medium when read) followed by a label string in plain weight (e.g. *replied to <article-title>*, *followed you*, *quoted you* — same `TYPE_LABELS` map the existing `/notifications` page uses) · for `new_reply` only, the comment excerpt in italic Literata 13px (line-clamped to 2 lines) · time-ago in mono-caps 10px. Unread rows additionally have a `#FAFAF7` background tint so the unread set scans at a glance.

**Click target navigation.** Re-uses the route logic from `web/src/app/notifications/page.tsx::getDestUrl`. Articles → `/article/<dTag>`, profile-shaped events → `/<username>`, dashboard-shaped events → `/dashboard*`. The workspace doesn't yet have a publications/dashboard surface (per ADR-level Deferred list), but the carry-over Phase A pages `/dashboard`, `/messages`, etc. still exist on this branch — slice 21 doesn't try to re-home them. New-message notifications are intentionally excluded server-side (`type != 'new_message'` filter on the route) so the bell never doubles up with the legacy DM badge; the workspace's eventual DM/messages model decision (still Deferred) owns that surface.

**Read-state model.** Click commits an optimistic mark-read (the row's bold flips to medium, the badge decrements, the dot fades) before the network round-trip. `MARK ALL READ` does the same to the full visible list + zeroes the badge. Failures log to console + (for read-all) trigger a list refetch to recover from drift; per-row failures keep the optimistic state because the user's already navigated away by then and re-flipping the row to unread on a return visit would be more confusing than a one-row drift. Subsequent `unread-counts` polls would correct any drift on the badge anyway.

**Polling cadence.** `/unread-counts` fires on workspace mount + every 30s thereafter, regardless of panel state — the route is one cheap COUNT scan and the badge needs to update for the closed-panel case. Panel-open additionally triggers a `/notifications` list fetch so the visible rows are always fresh on open. Closing the panel preserves the cached list so a quick reopen feels instant; the polling interval picks up new unread-count drift in the meantime. No SSE, no WebSocket, no service-worker push — per user-memory record, real-time push is mobile-app territory and web stays on polling. 30s is the smallest interval that still feels responsive without burning gateway round trips.

**No new endpoints, no schema changes.** All routes pre-exist. The only code change outside of `NotificationsAnchor.tsx` is two lines in `WorkspaceView.tsx` (import + render alongside `<ForallMenu />`).

**Notification preferences.** Skipped from the workspace surface. The existing `/settings` page's `NotificationPreferences` panel still owns the seven-category toggle (`new_follower`, `new_reply`, `new_mention`, `new_quote`, `commission_request`, `pub_events`, `subscription_activity`). Adding a preferences cog to the popover would inflate scope without serving a workspace-specific need — the toggles are durable settings, not bell-adjacent gestures.

Skipped intentionally: notification grouping ("3 people replied to X" — needs aggregation logic the existing route doesn't do), inline reply directly from the popover (would require Composer plumbing the bell isn't worth coupling to), filter chips by type (the popover is a glance surface; filtering belongs on the full `/notifications` log page), focus management / focus trap inside the panel (per ADR §6 a11y floor — Esc + outside-click suffice), keyboard arrow navigation through rows (Tab works since rows are buttons in DOM order; chord shortcut isn't part of the workspace floor), real-time push via SSE / WebSocket / service worker (per user-memory record, real-time push is mobile-app territory; 30s polling is the honest web cadence), unread-by-type breakdown badge (single integer is the right glance affordance), notification snooze / mute by author (kill-switch lives at `/settings`; per-author mute is a `vouches`-adjacent gesture that doesn't fit the bell), pip-coloured grouping inside the popover (the rows are about events, not authors — colouring rows by the actor's pip would conflate two signals), animated open/close on the panel (the snap is fine — Framer Motion's animation budget stays reserved for the ∀ ceremonies + drag), per-row delete / dismiss (the existing route has no DELETE endpoint and slice 21 doesn't add one — read-state is the existing dismiss model and the user can read-all if they want a clean slate), badge count animation on increment (the badge re-paints; flashing it would be visual noise), notifications surface for non-authenticated users (the bell only renders inside `WorkspaceView`, which already gates on `user`).

### Slice 22 — search anchor (2026-05-02)

The Deferred list's *Search entry point* item retires. Slice 21 closed the recipient/notifications gap on the chrome-less workspace floor; slice 22 closes the discovery gap. The pre-existing `gateway/src/routes/search.ts` (pg_trgm trigram index on `articles.title`, ILIKE on `accounts.username` / `display_name`, ILIKE on `publications.name` / `tagline`) is sufficient — no schema changes, no new endpoints, no backend work.

**Architectural call: disc, not vessel.** The earlier ADR open question framed three candidates: bottom-right disc / ∀-menu adjunct / search vessel. The vessel option (search-as-saved-feed: type a query, materialise a vessel whose contents are the result set, keep around or dismiss) fits the workspace ethos but stretches `Vessel` (results aren't `feed_items` in the ranking sense), forces decisions about query persistence + re-run cadence + ephemerality vs stickiness, and replicates the same chassis-abstraction strain that killed the notifications-vessel option in slice 21. The disc is the safer first cut; search-as-vessel can land later if usage justifies it. The ∀-menu adjunct miscategorises search as object creation. A magnifier disc in the bottom-right cluster, immediately to the left of the notifications bell, completes the workspace's affordance corner: **∀ · bell · search**, left-to-right.

**Anchor surface (`SearchAnchor.tsx`).** New component. A 40px white disc with a 1px black border and a magnifier glyph. Position: `right: 152, bottom: 32`, where 152 = bell `right: 96` + 40 width + 16 gap, and `bottom: 32` matches the bell's vertical-centre against ∀'s 56px axis. The cluster pattern stays internally consistent (same disc dimensions + same hover transition + same z-index 50 as the bell).

**Panel surface.** Click opens a 380×min(480, 100vh-120) popover anchored bottom-right, matching the `PipPanel` / `NotificationsAnchor` / `NewFeedPrompt` / `ForkFeedPrompt` material grammar (white bg, hairline black border, soft shadow). Top: a single text input (Jost 14px on `#FAFAF7`, autofocus on open). Below: scrollable result list grouped into three sections — *Writers*, *Articles*, *Publications* — each with an 11px mono-caps section header on a tinted `#FAFAF7` band so the eye can jump between categories without re-reading section types.

**Search shape.** `web/src/lib/api/search.ts` exposes `articles / writers / publications`, each accepting `(q, limit, signal)`. The component fires all three concurrently via `Promise.all` per keystroke (the gateway route handles each as a separate hop, but the round trips parallelise). Limits: 5 writers / 8 articles / 5 publications — the 8 for articles weights the dominant category in the search corpus without forcing scroll for the typical "did I find what I was looking for" glance. AbortController cancels in-flight requests on every new keystroke so a slow trigram round-trip on `q="ali"` can't beat a fast one on `q="alic"` and clobber it. 200ms debounce on input change — under that, the ILIKE/trigram queries fire on every typed character; over, the panel feels laggy.

**Min query length.** 2 characters. Mirrors the gateway's `query.length < 2` 400-error guard so the client never fires a request that would bounce. Below the threshold, the component renders the *Type at least 2 characters* hint instead of the loading spinner. The threshold is also why this slice doesn't bother with a "no results" pre-fetch state for empty input — *idle* and *empty* are visually distinct.

**Click navigation.** Per result type: writer → `/${username}` (handled by `web/src/app/[username]/`), article → `/article/${dTag}` (handled by `web/src/app/article/[dTag]/`), publication → `/pub/${slug}` (handled by `web/src/app/pub/[slug]/`). Click closes the panel + navigates. The trio is the existing route shape — no new pages.

**Empty state.** Italic Literata 13px *No results for "${query}".* The mono-caps "Searching…" loading state and the hint state share the same colour (`#9C9A94`) so the panel doesn't strobe between greyscale tones on each query.

**Footer = none.** Unlike the bell's *Open full log ›* link to `/notifications`, the search popover has no footer pointing at the carry-over `/search` page. The workspace experiment is about retiring carry-over surfaces (per ADR §1: "Phase A topbar and the global ComposeOverlay-as-currently-shipped are retired on this branch"), and entrenching `/search` as a "see more results" destination would push against that. The popover's per-section limits (5/8/5) are the cap; deeper search is a future slice — either deepening the popover with pagination or, if usage justifies it, a search-vessel.

**No new endpoints, no schema changes.** All three category routes pre-exist on the gateway. The only code change outside of `SearchAnchor.tsx` + the new `web/src/lib/api/search.ts` client is two lines in `WorkspaceView.tsx` (import + render alongside `<ForallMenu />` and `<NotificationsAnchor />`).

**Cluster width.** Three discs + ∀ now occupy ~232px of the bottom-right edge (∀ 56px + 16 gap + bell 40 + 16 + search 40 + right margin 24 + bottom-right of ∀ at right: 24, total leftmost edge of search at right: 192). At a 1024px viewport this is still ≪ a quarter of the floor's width, which is the upper bound the affordance corner can occupy without crowding workspace content. A fourth anchor would push it; the corner has roughly one more affordance slot before the cluster needs a different geometry (vertical stack? collapse-into-∀-menu?).

Skipped intentionally: keyboard arrow-key navigation through results (Tab works since rows are buttons in DOM order; arrow chord isn't part of the workspace floor per ADR §6 a11y), recent-searches history (would need a new table or localStorage; the popover is a pull surface, not a memory surface), scoped search like *search-within-vessel* (per-vessel filtering is a different gesture — a future per-vessel search affordance on the Vessel chassis itself, not the workspace-scope disc), filter chips by type (the three sections already separate types; chips would over-engineer a glance surface), search-as-vessel (the architectural alternative ruled out above; defer until usage justifies the chassis stretch), pagination inline in the popover (per-section limits are the cap; if the query has more matches the user iterates the query), full-search footer link to `/search` (the carry-over page survives but the workspace doesn't link to it; entrenches a Phase A surface the experiment is retiring), publication-tagline / writer-bio in the result row (kept rows tight to the name + slug + count line so all three sections share a uniform two-line vertical rhythm), highlighting matched substrings in result text (would need to thread the query through the row component for a cosmetic gain), search-by-tag entry (the carry-over `/tag/[tag]` route is not surfaced — tag-search needs a different mental model than text search and isn't part of the workspace's discovery story yet), debounce-cancel of in-flight Promise.all when query falls back below the min length (the AbortController + the length-guard branch in `handleQueryChange` already short-circuits — covered), per-query telemetry / search analytics (no analytics infrastructure in the experiment), search-as-you-type prefetch on hover before click (premature optimisation against the existing trigram cost).

### Slice 23 — cards with media (note + external) (2026-05-02)

The Deferred list's *Cards with media* item retires for note + external cards. Article cover images are deferred to a follow-on slice — see "Article scope" below. The slice is client-only: no schema change, no migration, no backend work.

**Where the data already lives.** External items already carry their media end-to-end: `external_items.media JSONB` is populated by `feed-ingest` adapters (`atproto-ingest.ts`, `activitypub-ingest.ts`, `feed-ingest-rss.ts`, `feed-ingest-nostr.ts`), the gateway's `FEED_SELECT` already pulls `fi.media`, and `rowToItem`'s external branch already emits it on the wire as `media: Array<{type, url, thumbnail?, alt?, width?, height?, ...}>`. Notes carry their media as URLs embedded in `content` text rather than in any structured column — extracting them is a one-regex client-side pass over the existing `note.content` field.

**Article scope: deferred.** The NIP-23 `image` tag (the spec'd hero-image carrier) is not currently produced by `web/src/lib/publish.ts::buildNip23Event`, the editor (`/write` + Composer article mode) has no cover-image picker, and `gateway/src/routes/articles/publish.ts` has no `image` tag in its request schema. Plumbing article covers through is a multi-surface change (editor picker + signed event tag + request schema + dual-write into `feed_items.media`) that doesn't fit in one slice; ships separately as slice 23b. Article cards continue to render without hero media for now.

**Note media extraction (`web/src/lib/media.ts`).** New `extractNoteMedia(content)` helper. Reuses the existing `extractUrls` + `isImageUrl` (which match `.jpg|.jpeg|.png|.gif|.webp` with optional query strings, plus the Blossom `/<sha256>` shape) rather than duplicating regex. Returns `Array<{type:'image', url}>` shaped like `external_items.media` so the same `MediaBlock` consumes both. Audio + link items aren't extracted — embeddable URLs (YouTube/Vimeo/Spotify/Twitter) are recognised by `isEmbeddableUrl` but rendering them needs oEmbed plumbing the slice doesn't ship; bare video file URLs (`.mp4`/`.webm`) in notes are rare in practice, so v1 is images-only on the note path.

**Note display text strip.** When a note has extracted media, the displayed text is `stripMediaUrls(content).displayText` (strips image URLs + nostr event references) so the URLs don't show as bare text alongside the rendered tile. When extraction returns nothing, the original content is shown unchanged — keeping the regex's blast radius narrow. The slice doesn't try to handle markdown-style inline images (`![alt](url)`) since the note compose path is plaintext-only today.

**`MediaBlock` component (`VesselCard.tsx`).** New module-local component. Renders the first `image` item (preferred) or first `video` item from the supplied media array, in a fixed 16:9 cover container with `objectFit: 'cover'`. Lazy-loaded `<img>`, `referrerPolicy="no-referrer"` to match the deprecated `feed/ExternalCard.tsx` privacy posture (some external image hosts log referer; the workspace surface shouldn't leak which native vessel is displaying their content). Background colour pulls from `ctx.palette.interior` so the placeholder during load matches the brightness state. Video items render the same image surface (using `thumbnail` if the source provided one, otherwise an empty palette-coloured surface) overlaid with a 44px white play-glyph disc; click opens the source URL in a new tab via `externalUrl`. The video-on-no-thumbnail case uses a lighter scrim (`rgba(0,0,0,0.06)` vs `0.18`) so the play disc still pops against the palette colour.

**Multi-item indicator.** When `media.length > 1`, a `+N` corner pill (mono-caps, white-on-90%-black) sits in the bottom-right of the hero. No carousel, no lightbox — clicking the pill does nothing in v1; it's a count indicator. Tapping the card already navigates to the source (external) or doesn't navigate (note); seeing the rest of the album is a future slice. Cap held at "first hero + count" deliberately: every additional rendered tile multiplies the per-card render cost across a feed full of multi-image atproto posts.

**Density gating.** `MediaBlock` early-returns `null` when `ctx.density === 'compact'`. Compact mode already suppresses the action strip (slice 11 rule) — the row is single-line on purpose and a hero image would defeat its semantic. Standard + full both render. Brightness states render symmetrically per the user's call this turn ("no need to worry about dimming images"); the dim palette intentionally desaturates UI but media stays full-fidelity since dimming a JPEG would either need a CSS filter that breaks photo intent or a server-side variant that doesn't exist. The interior background colour does adapt — `dim` brightness tints the placeholder slightly differently from `primary` — so the hero block sits visually consistent with the rest of the card.

**Click semantics.** External cards: the whole card is already clickable (opens source URL); the `MediaBlock` is wrapped in the same target so a tap on the image follows the same navigation. Notes: the card-level click target doesn't navigate (notes don't have a canonical destination URL on the workspace); the image is non-interactive. For external `video` items, the `MediaBlock` itself stops propagation and opens in a new tab regardless — so the user can click the play disc without the card-level handler firing twice.

**No image lightbox.** Tapping an image doesn't open a fullscreen viewer. Lightbox is a deeper UX (focus trap, swipe-to-dismiss, prev/next, escape semantics) that doesn't fit the workspace's affordance grammar — vessels are reading surfaces, not media galleries. If lightbox lands later it should be at the workspace-floor level, not a per-card surface.

**No image upload from compose.** The Composer's note + article modes don't have an image-upload affordance; this slice doesn't add one. A user pasting an image URL into a note today gets media rendering; uploading an image from disk requires the Blossom-upload path to be wired into the Composer — a separate slice.

**No backend work.** The diff is `web/src/lib/media.ts` (one new helper, ~10 lines), `web/src/components/workspace/VesselCard.tsx` (one new `MediaBlock` component + two integration sites: `NoteVesselCard` body, `ExternalVesselCard` body), and the ADR. `feed_items.media` JSONB column is unchanged; `rowToItem` is unchanged; the gateway is unchanged.

**Saved view inherits.** Slice 20's saved view reuses the same `VesselCard` render so saved items get the same hero treatment without further change. A saved external post with images shows the hero in both the live and saved views — consistent; the user's mental model of "save this as it is" holds.

Skipped intentionally: article cover images (deferred — needs editor + publish-route + NIP-23 image-tag plumbing; tracked as slice 23b candidate), oEmbed for arbitrary link cards (YouTube / Vimeo / X / Spotify previews — separate slice that subsumes the deprecated card's link-embed path), inline `<video>` players for `.mp4`/`.webm` (autoplay policies, audio handling, accessibility), GIF autoplay control (every browser autoplays GIFs by default and the slice doesn't fight that), image lightbox / fullscreen viewer, alt-text overlay on hover for accessibility (the underlying `<img alt>` already serves SR users; visible alt on hover is a different request), blurhash / placeholder while loading (the palette-coloured surface plays that role; blurhash needs server-side hash computation), carousel for multi-image posts (the `+N` pill counts but doesn't navigate), per-vessel "no images" toggle on the chassis (the brightness/density bar has the room but turning images off across a vessel is a different gesture), image upload from the Composer (Blossom upload is wired in `web/src/lib/media.ts` already but plumbing it into the Composer's note/article modes is its own slice), markdown-style inline images (`![alt](url)`) in note content (note compose path is plaintext-only today), media for the NewUserVesselCard variant (no media surface for system-generated cards), per-density variation in hero size (16:9 is constant across standard + full — full could go larger but the rhythm benefit is minor and standard already renders generously).

## Deferred (TODO in code, not blocking the experiment)

- Article cover images (slice 23 deferred — needs editor + publish path).
- DM/messages model (vessel vs `/messages` route).
- Publications surface in workspace.
- Named audiences (FOR field) persistence + consent + management.
- Volume TOP metric definition (slice 14 records the value; slice 16 maps it to `feed_items.score × weight`; refining what TOP *means* beyond reusing the existing score remains open).
- Per-source mode mixing inside one feed (slice 16 picks a feed-level dominant mode).
- Random-mode stable pagination (slice 16 re-rolls per query).
- Anonymous attestation pipeline (slice 15 ships attributable polls; trust-system-proper rewrites the storage backend).
- Dark mode.
- "Medium-bright" pixel value.
- Long-note truncation.
- Tags in article mode.
- Cross-protocol reply semantics (slice 13 inline thread is native-only; external cards still have no Reply / Thread affordances).
- Brightness × focus coupling (also blocks per-brightness theming for the slice-13 inline playscript).
- Nudge dismissal persistence beyond session.

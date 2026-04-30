# WORKSPACE EXPERIMENT ADR

*Date: 2026-04-30. Status: Active experiment. Branch: `workspace-experiment` (anchored at tag `pre-workspace-experiment`).*

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
- `useCompose` store extends per Steps 5/6.
- `ComposeOverlay` shell becomes the chrome around the new `Composer` component (one component, two modes — note + article).
- Card data shapes survive; visual rendering reskinned per `CARDS-AND-PIP-PANEL-HANDOFF.md`.

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

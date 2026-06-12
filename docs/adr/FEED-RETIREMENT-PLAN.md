# FEED-RETIREMENT-PLAN — retire the legacy `/feed` model

**Status:** In progress — Slices 1, 2, 3 & 4 shipped 2026-06-12; Slice 0 decided (option a). `/feed` is now a redirect shim; the front door lands on `/workspace`; reach (Following/Explore) is a composable source kind; new accounts seed a starter-feed clone. **Operator prereq before seeding does anything: flag ≥1 of your own feeds as a template** — `UPDATE feeds SET is_starter_template = true WHERE id = '<feed-uuid>';`. Remaining: Slice 5 (overlays), Slice 6 (backend untangle + extract shared SQL), Slice 7 (deletions).
**Date:** 2026-06-12
**Provenance:** feature-debt.md §4 readiness assessment (2026-06-12), re-verified against the codebase the same day. UNIVERSAL-POST-ADR §10 Phase 5 deliberately scoped the Post-model cutover to the workspace and named "a later `/feed`+`/source`-scoped pass"; this is that pass.
**Goal:** `/workspace` becomes the entirety of logged-in all.haus. Every surface renders cards through the one Post-model path (`web/src/components/post/`); the legacy `components/feed/` card stack and its gateway endpoints are deleted.

---

## 0. Progress log (read this first when resuming)

**Slice 0 — DECIDED (operator, 2026-06-12): option (a), composable reach source kind.** Global reach (Following/Explore) becomes first-class `reach:following` / `reach:explore` source kinds in `feed_sources`, composable into any vessel alongside subscriptions — not two special-cased seeded feeds (b), not dropped (c). Needs source-kind plumbing in `gateway/src/routes/feeds.ts` + FeedComposer. `GET /feed/:feedId` (post-feed.ts) already serves `feedId ∈ {following, explore}` as scored Post[] — reuse it as the reach projector. Gates Slice 3 only.

**Slice 1 — SHIPPED (2026-06-12, commit `8aecbda`).** `GET /sources/:id` now projects `Post[]`; `SourceSurface.tsx` renders `PostCardInteractive`/`PostThread`. `ExternalCard` is no longer imported outside `FeedView`. gateway+web tsc clean, lint 0 errors, hairlines clean. *Runtime check pending a `web` rebuild.*

**Slice 2 — SHIPPED (2026-06-12, commit `76c2f2d`).** `?kind=article|note` added to `/author/:id/posts`; new `GET /author/:id/replies` projects native kind-1111 comments as `Post[]` via `commentToPost` (moved to shared `post-mapper.ts`). `WorkTab`/`SocialTab` render Post cards (pin + drives preserved; replies expand to the unified thread). No `components/feed/*` import remains under `components/profile/`. *Runtime check pending a `web` rebuild.*

**Slice 3 — SHIPPED (2026-06-12).** Migration `114_reach_source_and_starter_template.sql` (schema.sql regenerated, drift guard green, applied to dev DB). All three workstreams landed:
- **A (reach source kind):** `feed_sources` grows a `reach` `source_type` + a `reach_kind` ('following'|'explore') discriminator (both CHECK constraints + a `(feed_id, reach_kind)` partial unique). Plumbed through `feeds.ts` (`addSourceSchema`/`addSource`/`insertSource`/`sourceRowToResponse` + the three source-list SELECTs) and the FeedComposer (two `+ Following` / `+ Explore` quick-add chips, since reach has no text to resolve). Reach membership is computed in **`sourceFilteredItems`' `matched` CTE** — *not* the `GET /feed/:feedId` projector the plan named: the workspace items path returns the legacy `rowToItem` shape (mapped client-side to Post via `map-feed-item.ts`), a different shape/mapper than post-feed.ts, so the clean seam was the `matched` CTE membership branches. Web types in `lib/api/feeds.ts` (`WorkspaceFeedSourceKind` += `reach`, `ReachKind`, `AddWorkspaceFeedSourceInput`). Validated against the dev DB: both branches' columns resolve and the full CTE returns rows.
- **B (starter-feed clone):** `feeds.is_starter_template` + `feeds.cloned_from_feed_id` (FK → feeds, ON DELETE SET NULL). `cloneFeedForOwner` + `seedStarterFeeds` helpers in `feeds.ts`; seeding runs from a **zero-feeds guard in `GET /workspace/feeds`** (advisory-locked per owner, idempotent), which covers all signup paths (OAuth + email) *and* existing empty accounts uniformly — so it was **not** also hooked into the two signup paths (DRY, equally correct). No-op until a template is flagged, in which case the client's empty-default-feed mint still fires (unchanged legacy fallback). Clone SQL validated against the dev DB (copies feed + all sources, incl. reach rows).
- **C (front door):** `auth/page.tsx` ×2, `auth/verify`, `auth/google/callback`, and the two admin redirects → `/workspace`; `/feed` is now a redirect shim; `Nav.tsx` logged-in "Feed"→"Workspace" (→`/workspace`), logged-out "Feed" link dropped, logo → `/workspace`; the topbar search box (desktop + mobile) **removed** rather than repointed — it already dropped the query through the Slice-4 `/search` shim, so removing the broken box is strictly not worse, and search lives in the workspace dock now. Back-to-feed CTAs (SourceSurface, AuthorProfileView, library, network) → `/workspace`.

gateway+web tsc clean, root lint 0 errors, gateway tests 117/117 (boot was a cold-start 5s-timeout flake — passes at 30s), hairlines clean on touched files (the one Nav.tsx hit is pre-existing Compose-button debt, not in this diff). *Runtime check pending a `web` rebuild.*

**Slice 3 follow-on items (deferred, not blockers):**
- **Operator template-flag UI** — flagged via SQL for now (documented in `feeds.ts` + the Status line); a small admin toggle is optional polish.
- **"Cloned from <operator>'s feed" provenance UI** — the `cloned_from_feed_id` column is durable but not yet surfaced in the feed response/UI (needs a join to the template owner's name).
- **`feedReach` localStorage key** is now inert (its only live reader, `FeedView`, no longer renders behind the shim; `FeedDial` on `/network` is Slice-5 territory) — left for the Slice 5/7 cleanup rather than chased piecemeal.
- **reach:following scope** is native-only (follows + own + followed publications); external subscriptions are composed as explicit `external_source` rows, not bundled into reach — a deliberate alignment with the vessel model, documented at the `matched` CTE.

**Slice 4 — SHIPPED (2026-06-12).** New `GET /tags/:name/posts` projects tag articles as `Post[]` (article-only, cursor-paged, keeps `total` for the header) — mirrors `GET /sources/:id`. `TagBrowser.tsx` renders `PostCardInteractive` (reader-in-place when `inOverlay`, navigate on the standalone page); no hand-rolled article rows remain. `/search` is now a redirect shim to `/workspace` (the dock `SearchPanel` is the search surface). gateway+web tsc clean, lint 0 errors, hairlines clean. *Runtime check pending a `web` rebuild.*

**Corrections to the plan discovered while building (carry forward):**
- **`Nav.tsx`'s topbar search box still pushes to `/search`** (now a shim → `/workspace`), so it drops the query and, for a logged-out visitor on a public page, lands them on the login-gated workspace. This is the black topbar that Slice 3 already touches (the four `/feed` links) — repoint/remove the search box there. Out of Slice 4's scope; left intact deliberately.
- **Legacy `/tags/:name` + the `tags.getByName` web client are now orphaned** (only `tags.search`, the editor autocomplete, still uses the legacy tags API). Left in place for the Slice 7 deletion pass, not removed piecemeal.
- **Profile replies are NOT in `/posts`.** §2 assumed WorkTab/SocialTab both ride `/author/:id/posts`. Native replies are kind-1111 rows in the `comments` table, *not* `feed_items`, so they have no `post_id` and never appear in `/posts`. They now have a dedicated projector (`GET /author/:id/replies`). Any future "author's replies" surface must use it, not `/posts`.
- **The Post chassis has no inline delete affordance** (neither does `AuthorProfileView` nor the workspace cards — `PostActions` carries Vote/Reply/Quote/Report only). Slice 2 therefore dropped the legacy NoteCard per-note delete on one's own profile. This is a uniform Post-model gap, not a Slice-2 regression — but it IS a real capability loss across the consolidated world. Decide separately whether to grow a delete action into the chassis before Slice 7 deletes the legacy cards for good.
- `commentToPost`/`CommentRow` now live in `gateway/src/lib/post-mapper.ts` (Slice 6's "extract shared SQL" instinct, done early for this one).

**Slice 3 seeding — DECIDED (operator, 2026-06-12): starter-feed clone.** A new account does **not** auto-seed a bare `reach:following` vessel — a brand-new user follows nobody, so it would be empty. Instead it starts with a **clone of a designated operator feed**: a real `feeds` row owned by the new user, with the template's `feed_sources` + `appearance` copied, labelled as a clone, which they can rename, add to, drop sources from, or delete at will. A real owned feed, not a special-cased object — so no bespoke "default feed" machinery, just a copy operation. This sidesteps the cold-start emptiness all three reach-only candidates had. `reach:following`/`reach:explore` remain the composable source kinds from Slice 0(a) (a starter template *may* include `reach:following`), but they are no longer the cold-start answer.

Sub-decisions — DECIDED (operator, 2026-06-12):
- **Template designation** → **`feeds.is_starter_template` boolean** the operator toggles (feed-character-as-data; multiple templates allowed later; no redeploy to change). Migration adds the column. **The operator must flag ≥1 of their own feeds as a template before this works** — wire a small operator toggle (or set the flag via SQL).
- **Clone label** → **name set at clone time** (the template's name; the clone is fully editable/renamable afterwards) **plus a `cloned_from_feed_id` provenance column** (nullable FK → `feeds`) so the UI can durably render "cloned from <operator>'s feed". Same migration.
- **Trigger** → **clone at signup, plus a zero-feeds guard on workspace bootstrap** (idempotent) so existing accounts — and any signup that raced the seed — aren't stranded on an empty workspace.

---

## 1. Verified current state (corrections to the assessment in bold)

### Legacy card stack and its importers

| Component (`web/src/components/feed/`) | Live importers outside the stack |
| --- | --- |
| `FeedView` | `app/feed/page.tsx` only |
| `ExternalCard` | `SourceSurface` (and `FeedView`) |
| `ArticleCard` | `profile/WorkTab` (and `FeedView`) |
| `NoteCard` | `profile/SocialTab` (and `FeedView`) |
| `QuoteCard`, `NeighbourhoodCard`, `ActionSheet` | none — internal to the stack |
| `SubscribeInput` | `app/subscriptions/page.tsx` (and `FeedView`) |
| `AuthorModal` | **shared, keep** — `post/PostByline`, `workspace/FeedComposer`, `useAuthorCard` |

### Live workspace dependencies on the retiring path — **there are two, not one**

1. `SurfaceOverlay` → `SourceSurface` → `ExternalCard` over legacy-shaped `GET /sources/:id` (the assessment's "one live dependency").
2. **`ProfileOverlay` → `NativeProfilePanel` → `WriterActivity` → `WorkTab`/`SocialTab` → legacy `ArticleCard`/`NoteCard`.** Native profiles opened from any byline draw legacy cards inside the consolidated world today.

(`TagBrowser` also renders in-overlay but uses hand-rolled rows over the tags API — no legacy cards, lower urgency.)

### **The front door still opens onto `/feed`**

`app/auth/page.tsx:33,71` and `app/auth/verify/page.tsx:42` `router.push('/feed')` after signup/login/verify. `Nav.tsx` (black topbar) links `/feed` in four places; fallback CTAs in `SourceSurface`, `AuthorProfileView`, `/library`, `/network` link it too. Retirement must repoint all of these.

### Backend reality

- **The product decision already has its backend.** `GET /feed/:feedId` (`gateway/src/routes/post-feed.ts`, UNIVERSAL-POST §9) serves `feedId ∈ {following, explore}` as scored, deduped `Post[]` — and has **zero frontend callers**. It was built for exactly this cutover and is sitting unused.
- **`GET /author/:authorId/posts` already serves both id-spaces** (native `author_id` + external `external_author_id`) as full-view `Post[]`, and `AuthorProfileView` already renders it through `PostCardInteractive` — so the external author profile is **already ported**; only the *native* profile tabs remain, and their endpoint may already exist (see Slice 2).
- `timeline.ts` exports (`FEED_SELECT`/`FEED_JOINS`/`feedItemToResponse`/`parseCursor`) are imported by `post-feed.ts`, `post-thread.ts`, `sources.ts`, **and `author.ts`** (four importers, not two) — extraction must precede deleting the legacy handler.
- The workspace reads `GET /workspace/feeds/:id/items` (`feeds.ts`), a **third** query path with its own duplicated `FEED_SELECT`/`FEED_JOINS`/`rowToItem` (`feeds.ts:1185/1222/1297`), ranking by `effective_score`; empty vessels fall back to `placeholderExploreItems` (the explore stream).
- `GET /conversation/:eventId` (`replies.ts`): confirmed no frontend caller.

### Bucket B pages (standalone, no overlay equivalent) — all confirmed

- `/network` — tabs following/followers/blocked/muted/vouches + `FeedDial` + `DmFeeSettings`.
- `/library` — bookmarks + reading history; `/bookmarks`, `/history`, `/reading-history` all redirect here (onto a topbar page).
- `/subscriptions` — external-subscription CRUD via `SubscribeInput`.
- `/profile` — name/bio/avatar editor + `UsernameChange`.
- `/search` — bespoke article/writer rows; **redundant**: the dock `SearchPanel` already covers writers + articles + publications and routes results into overlays.

---

## 2. Slices, in order

Ordering rationale: kill the two live in-workspace legacy dependencies first (1–2), then take the product decision and close the front door (0+3), then the remaining ports (4), then the missing overlays (5), then untangle and delete (6–7). Slices 1, 2, 4, 5 are independent of the Slice 0 decision and can proceed at any time.

### Slice 0 — Product decision: where does global reach live? *(the one non-engineering item)*

Legacy `/feed` is a single global following/explore timeline; the workspace is per-feed composed vessels. Before `/feed` dies, decide:

- **(a) Reach as a composable source kind** — `feed_sources` grows `reach:following` / `reach:explore` rows, composable into any vessel alongside subscriptions. Most aligned with the composed-vessel model and "feed character as data"; needs source-kind plumbing in `feeds.ts` + FeedComposer.
- **(b) Two seeded default feeds** — "Following" and "Explore" vessels backed directly by the existing `GET /feed/:feedId` projector; new accounts get them at signup, existing accounts on first visit. Cheapest correct v1; vessels are special-cased rather than composed.
- **(c) Drop global reach** — `placeholderExploreItems` already pipes explore into empty vessels; following-reach simply disappears. Cheapest of all, but silently deletes a product capability.

**Recommendation: (b) now, (a) as the follow-on** — (b) ships the cutover on an endpoint that already exists; (a) is the durable model and can absorb (b)'s feeds later without migration drama. Avoid (c): following-reach is real value.

Decision needed from the operator before Slice 3 lands. Nothing else blocks on it.

### Slice 1 — Port `SourceSurface` to the Post model *(live dependency #1 — first)* — ✅ SHIPPED (§0)

- Gateway: add a source-scoped `Post[]` projector — either `GET /source/:id/posts` beside the profile/meta in `sources.ts`, or a `source` filter on the post-feed machinery. Reuse the §5 projector conventions (cursor, dedup, attribution) from `post-feed.ts`.
- Web: `SourceSurface` swaps its `ExternalCard` list for `PostCardInteractive` (same `CardContext` pattern as `AuthorProfileView`); keep the source header + SHOW MORE. Overlay and standalone page share the component already — one change covers both.
- Accept: a source opened from a workspace card renders Post-model cards with thread expand / quote / media parity; `components/feed/ExternalCard` no longer imported outside `FeedView`.

### Slice 2 — Port native profile tabs *(live dependency #2)* — ✅ SHIPPED (§0; replies needed their own projector, not `/posts`)

- `GET /author/:authorId/posts` already filters native authors by `author_id`. `WorkTab` (articles) and `SocialTab` (notes + replies) need a **kind filter** (`?kind=article|note`) on that endpoint — or accept the combined chronological log and split client-side.
- Web: `WriterActivity` renders both tabs through `PostCardInteractive`; delete `WorkTab`/`SocialTab`'s legacy card usage. Native profile overlay and standalone `/{username}` page share `WriterActivity` — one change covers both.
- Accept: no `components/feed/*` import remains under `components/profile/`.

### Slice 3 — Close the front door, retire `/feed` — ✅ SHIPPED (§0)

All sub-decisions are now DECIDED (Slice 0 = option (a); seeding = starter-feed clone; the three clone sub-decisions in §0). This slice is unblocked — build it directly. Two largely-independent workstreams (**A** reach source kinds, **B** starter-clone seeding) plus the front-door repoint (**C**); B+C are the part that actually retires `/feed`, A can land alongside or just after.

**A — reach as a composable source kind.** `feed_sources.source_type` today is CHECK-constrained to `{account, publication, external_source, tag}` (see `feed_sources_source_type_check` + `feed_sources_target_matches_type` in `schema.sql`). Add a `reach` type carrying a discriminator (e.g. a `reach_kind text` column or reuse `tag_name`-style scalar) for `following`/`explore`; grow both CHECK constraints. Plumb through `gateway/src/routes/feeds.ts` (the `/workspace/feeds/:id/sources` CRUD + the items SELECT) and the FeedComposer source picker. The items query for a `reach` source reuses the existing `GET /feed/:feedId` projector (`post-feed.ts`, `feedId ∈ {following, explore}`) — wire it into the feed-items assembly rather than re-implementing scoring. Migration + regenerate `schema.sql` + drift guard (CLAUDE.md).

**B — starter-feed clone (seeding).** 
1. Migration: `feeds.is_starter_template boolean DEFAULT false`, `feeds.cloned_from_feed_id uuid REFERENCES feeds(id)` nullable. Regenerate `schema.sql` + drift guard.
2. A clone operation in `feeds.ts`: given a template feed id + new owner, INSERT a `feeds` row (copy `name`, `appearance`; fresh `owner_id`; set `cloned_from_feed_id`; assign `sort_rank`) + copy every `feed_sources` row (all four/five source_types, incl. any reach rows once A lands) under the new feed id. One transaction.
3. Trigger at signup (the account-creation path) → clone the template(s) flagged `is_starter_template`. Plus a zero-feeds guard on workspace bootstrap (the feed-list load) that clones if the account owns no feeds — idempotent, covers existing accounts + raced signups.
4. Operator affordance to flag a template feed (small toggle, or document the SQL). **Prereq: ≥1 feed flagged before this does anything.**

**C — close the front door.**
- Repoint post-auth: `auth/page.tsx` ×2 (`:33,:71`) + `auth/verify/page.tsx` (`:42`) → `/workspace`.
- `/feed` becomes a redirect shim to `/workspace` (standard retired-route pattern, CLAUDE.md).
- Remove the four `Nav.tsx` `/feed` links **and the topbar search box's `/search` push** (`Nav.tsx:262,:268` — Slice 4 carry-forward); update fallback CTAs (`SourceSurface` `/feed` link at `:141`, `AuthorProfileView`, `/library`, `/network`) to `/workspace`.
- Drop the `feedReach` localStorage key handling.
- Accept: no live `href`/`push` to `/feed` outside the shim; logging in lands on the workspace; a fresh account opens onto a populated starter feed.

### Slice 4 — Port `/tag`, retire `/search` — ✅ SHIPPED (§0)

- `TagBrowser`: replace hand-rolled rows with Post-model article cards (tags are article-only). Needs a tag-scoped `Post[]` source — tag filter on the post-feed machinery or a small projector beside the tags routes. Overlay + standalone share `TagBrowser` already. *Done: new `GET /tags/:name/posts` projector (`tags.ts`) + `tagPosts` web client; `TagBrowser` renders `PostCardInteractive`.*
- `/search`: redirect shim to `/workspace` — the dock `SearchPanel` is the search surface (already richer: writers + articles + publications, results open in overlays). Optionally a `?overlay=search` param that opens the dock panel, if shim-to-bare-workspace feels lossy. *Done: plain redirect to `/workspace` (no `?overlay=search` — no search overlay store exists; the dock panel is reachable from the ForallMenu). `Nav.tsx`'s topbar search box still targets `/search`; repoint in Slice 3 (see §0 carry-forward).*
- Accept: `/tag/:name` renders PostCards in both modes; `/search` is a shim.

### Slice 5 — Build the four missing overlays (Bucket B)

Standard retired-route pattern for each: shared panel body + `inOverlay` gate + store (`isOpen`/`open`/`close`) + entry in `overlays.ts` + old route becomes a shim forwarding params. Suggested shapes:

- **`/network` → NetworkPanel overlay** (own overlay; it's a destination, not a setting). Shim forwards `?tab=` (vouches deep-links exist — CLAUDE.md cites `/network?tab=vouches`).
- **`/library` → LibraryPanel overlay**; `/bookmarks`/`/history`/`/reading-history` shims re-target `/workspace?overlay=library[&tab=history]`.
- **`/subscriptions` → fold into feed management** rather than a new overlay if possible: external-subscription CRUD is feed-source territory (FeedComposer adjacency). If scope creeps, a thin SubscriptionsPanel overlay is acceptable; either way `SubscribeInput`'s replacement must land here before the Slice 7 deletion.
- **`/profile` → SettingsPanel section** (name/bio/avatar/username is settings-shaped); shim to `/workspace?overlay=settings&section=profile`.

Stay standalone by design: `/`, `/about`, `/auth`, `/invite`, `/subscribe/:code` (logged-out world); `/traffology`, `/admin` (ops); public content URLs (`/{username}`, `/author/:id`, `/source/:id`, `/tag/:name`, `/pub/:slug…`) keep their full pages for direct visits/SEO — the ports above make them render the same Post-model components in both modes.

### Slice 6 — Backend untangle

1. **Extract the shared SQL** from `timeline.ts` into `gateway/src/lib/feed-sql.ts` (`FEED_SELECT`, `FEED_JOINS`, `feedItemToResponse`, `parseCursor`); update the four importers (`post-feed`, `post-thread`, `sources`, `author`). Mechanical, do first.
2. Delete the legacy `GET /feed` handler (`timeline.ts` route) once Slice 3's shim is live.
3. Delete `GET /conversation/:eventId` (`replies.ts`) — no callers.
4. **Decide, don't default:** converging `GET /workspace/feeds/:id/items` onto the `post-feed.ts` projector (killing the third query path + duplicated SQL in `feeds.ts`) is real work with ranking implications (`effective_score` vs §5 hotness). Track it as its own follow-on; do *not* let it block the deletions above.

### Slice 7 — Deletion manifest

After 1–6, in one pass, with `knip` + grep verification before each delete:

- `web/src/components/feed/{FeedView,ExternalCard,ArticleCard,NoteCard,QuoteCard,NeighbourhoodCard,SubscribeInput,ActionSheet}.tsx` — **keep `AuthorModal.tsx`** (shared).
- `useNeighbourhood` and any hooks orphaned by the card deletions (audit `useNativeParent` and friends; **keep `useAuthorCard`** — feeds `AuthorModal`).
- `app/feed/page.tsx` body (already a shim by then), legacy client code in `lib/api` that only served `GET /feed?reach=`.
- Gateway: legacy `GET /feed` handler + now-unused private helpers in `timeline.ts` (the file may reduce to nothing once `feed-sql.ts` exists — delete it if so).
- Accept: `grep -r "components/feed/" web/src` returns only `AuthorModal`; root lint 0 errors; gateway + web `tsc` clean; gateway tests green; `scripts/check-hairlines.sh` clean on touched files.

---

## 3. Invariants to hold throughout (CLAUDE.md)

One post per card (no fused cards return in the ports); no hairlines; palette-awareness for anything rendered on vessel interiors; byline routing per the chassis spec; no workspace escapes to the black topbar (every new overlay follows the retired-route pattern); Glasshouse one-at-a-time with `onSupersede` for URL-synced overlays; omnivorous identity inputs wherever Slice 5 rebuilds a subscribe/identity field.

## 4. Rough sizing

| Slice | Size |
| --- | --- |
| 1 SourceSurface port | 1 session (endpoint + swap) |
| 2 Profile tabs port | 1 session (kind filter + swap) |
| 3 Front door + `/feed` shim | small; blocked on Slice 0 decision |
| 0+3 with option (b) seeded feeds | 1–2 sessions incl. seeding |
| 4 Tag port + search shim | 1 session |
| 5 Four overlays | 2–3 sessions (network is the big one) |
| 6 Untangle | 1 session (item 4 tracked separately) |
| 7 Deletions | small |

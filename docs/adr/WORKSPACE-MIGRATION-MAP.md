# WORKSPACE MIGRATION MAP

*Reconciliation between the April 2026 design corpus and the live codebase. April 2026.*

Companion to `ALLHAUS-UI-SURFACE.md`. That document is descriptive — what the UI is, abstracted from the code. This document is operational — for every shipped surface, a verdict on what the workspace reframe means for it, and for every backend hook a verdict on whether it survives the UI's reframe. Read alongside `PRINCIPLES.md`, `WORKSPACE-DESIGN-SPEC.md`, `WIREFRAME-PLAN.md`, and `CARDS-AND-PIP-PANEL-HANDOFF.md` (collectively, "the new corpus").

Verdict vocabulary:

- **survives** — the surface continues to govern in its current shape. Workspace-side changes don't reach it; ongoing work can keep building on it.
- **retires** — the surface is dropped by the new corpus. Once the workspace lands, this is dead code; until then, do not invest in it.
- **folds** — the surface is absorbed into another surface specified by the new corpus. The functionality survives in a new location; the existing component will be migrated and then removed.
- **undecided** — the new corpus is silent or ambivalent. A design call is needed before the surface can be touched safely.

The carry-over verdict here is provisional in the same sense as the carry-over sections of `ALLHAUS-UI-SURFACE.md` are provisional: the surface continues to govern in its prior shape until the workspace metaphor is propagated through it. Carry-over surfaces are listed here as **survives (carry-over)** to distinguish them from surfaces the new corpus actively endorses.

---

## 1. Top-level routes (`web/src/app/`)

| Route | Component(s) | Verdict | Notes |
|---|---|---|---|
| `/` (`page.tsx`) | landing | **undecided** | New corpus silent on marketing/unauthenticated entry. `ALLHAUS-UI-SURFACE.md` §12 flags as carry-over without spec. |
| `/workspace` | `WorkspaceView` + `Vessel` + `VesselCard` + `ForallMenu` + `Composer` + `NewFeedPrompt` + `FeedComposer` + `ResetLayoutConfirm` + `ForkFeedPrompt` | **built — 2026-04-30 → 2026-05-01** | Branch experiment. ⊔ vessels on a grey-100 floor, platform chrome suppressed via `useLayoutMode = 'workspace'`, persistent bottom-right ∀ menu. Workspace `Composer` reachable from ∀ → *New note* with resolver-backed To-field chips, four-protocol selector, and a publish pipeline that branches on chip kind (empty / broadcast → public Nostr publish + cross-post to connected Bluesky / Mastodon linked accounts via `crossPosts: [{actionType: 'original', linkedAccountId}]`; person chips → encrypted DM via `messages.createConversation` + `messages.send`). Slice 3: workspace bootstraps from `GET /api/v1/feeds`, seeds a default feed if none exist, renders one vessel per feed via `GET /api/v1/feeds/:id/items` (placeholder = caller's explore stream when `feed_sources` is empty); ∀ → *New feed* opens `NewFeedPrompt` and POSTs. Slice 4: vessel name labels are clickable and open `FeedComposer` (scrim/panel matching `NewFeedPrompt`); the composer lists sources, offers a resolver-backed *add a source* input (300ms debounce, Phase B polling, context `subscribe`) that classifies into native_account / external_source / rss_feed candidates plus a `#tag` fallback; new endpoints `GET/POST /api/v1/feeds/:id/sources` and `DELETE /api/v1/feeds/:id/sources/:sourceId` author rows. The items query for non-empty source sets fans out across four OR-ed `EXISTS` clauses (account / publication / external_source / tag) joined to `feed_items`; cursor narrows from `(score, published_at, id)` to `(published_at, id)` until weight + sampling_mode arrive. External-source pair adds upsert `external_sources` and ensure an `external_subscriptions` row in one txn so feed-ingest picks them up; per-type partial unique indexes surface as `409 Source already on feed`. Slice 5a: Framer Motion arrives. Vessels become absolutely-positioned `motion.div`s draggable by the name label (drag handle gated via `dragControls` + `dragListener=false` so cards inside stay clickable); positions live in a new `useWorkspace` Zustand store (`web/src/stores/workspace.ts`) backed by localStorage `workspace:layout:<userId>` with a 200ms-debounced write and silent-on-quota-error semantics; `dragConstraints` is bound to the floor ref so vessels can't be dragged off-screen; default grid slot (340px col, 32px padding, wraps at viewport width) computed for any feed without a stored position on bootstrap and on new-feed creation. Slices 5b + 5c: vessel resize via bottom-right ◢ corner handle (`onPointerDown` + `setPointerCapture` + `onPointerMove`, min 220×200, optional `w/h` extending `VesselLayout`), plus brightness / density / orientation per `WORKSPACE-DESIGN-SPEC.md` §"Feed scope" (consolidated `tokens.ts` with `PALETTES: Record<Brightness, VesselPalette>`, three small mono-glyph cycle controls `○|◐|●` `c|s|f` `||─`, density-aware `VesselCard` rendering compact / standard / full, horizontal orientation switches inner flex direction to `row` and scroll axis to horizontal). Slice 6: ∀ → *Reset workspace layout* wired (`ResetLayoutConfirm` modal + `useWorkspace.reset()` + immediate re-seed of default-grid slots so the floor doesn't visibly collapse to (0, 0) for one paint). Slice 7: vessel rename + delete UI inside `FeedComposer` (header inline rename input via `PATCH /api/v1/workspace/feeds/:id`; footer two-step Delete-feed confirm via `DELETE /api/v1/workspace/feeds/:id`; `deleteBlocked={vessels.length <= 1}` hint replaces the button when this is the last feed; `useWorkspace.removeVessel(feedId)` finally has its first wired caller). Slice 8: ∀ → *Fork feed by URL* wired (`ForkFeedPrompt` resolver-debounced single-input modal; on candidate click runs `create(derivedName)` then `addSource` in sequence; partial-failure roll-forward keeps the new feed and surfaces a hint so the user can finish in `FeedComposer`). All four ∀ menu items (new-note / new-feed / fork / reset) now live. Brightness-as-focus coupling, real touch gestures (continuous brightness, two-finger rotation), the ∀→H→⊔ animation, no-overlap collision, per-source weights / mute toggle, drag-to-reorder sources, lead images at full density remain deferred. Per-slice detail in `WORKSPACE-EXPERIMENT-ADR.md` build log (slices 1, 1.5, 2, 2.5, 2.6, 2.7, 2.8, 3, 4, 5a, 5b, 5c, 6, 7, 8). |
| `/feed` | `FeedView` | **retires** (still live, fallback during build) | Workspace replaces the single-stream feed page entirely. Vessels live on the workspace floor; there is no `/feed` URL in the new model. The `FeedView` component is the largest single surface to be replaced. Coexists with `/workspace` during the experiment per ADR §"Migration within the branch". |
| `/library` | bookmarks + reading-history tabs | **retires (bookmarks)** + **folds (reading history → user-scope §21)** | Cross-feed bookmarks dropped per `ALLHAUS-UI-SURFACE.md` §0 and §7. Reading-history-as-list survives only as the resumption mechanic (`useReadingPosition`); the page-level surface folds into user-scope's *Reading preferences*. |
| `/network` | follow/follower/blocked/muted + `FeedDial` + `DmFeeSettings` + Vouches | **folds** | Following/followers absorbed into per-vessel composer (sources) + pip panel `FOLLOW`. Blocks move to author profile / DM surface. Mutes = 0% volume on pip panel. `FeedDial` retires (per §638's "four-mode FeedDial dropped"). DM fees fold into user-scope settings. Vouches tab retires alongside the four-dimension scheme. |
| `/ledger` | balance + accrual + tab history + subscriptions + pledges | **folds (subscription manager)** + **retires (tab history at launch)** | `ALLHAUS-UI-SURFACE.md` §10.2: micropayments deferred, so `BalanceHeader` / `AccountLedger` go dark at launch. Surface reduces to `SubscriptionsSection` + `PledgesSection`, which themselves should fold into the pip panel's `SUBSCRIBED — MANAGE ›` flow. Reactivates with the tab. |
| `/profile` | display name / avatar / username / bio | **folds → user-scope §21** | Per `ALLHAUS-UI-SURFACE.md` §21.2. |
| `/settings` | email / payment / linked accounts / notifications / reading prefs / export / danger zone | **folds → user-scope §21** | Already the closest existing surface to user-scope; the workspace reframe is mostly a relocation (corner avatar tap), not a content rewrite. |
| `/dashboard` | writer surface (Articles / Subscribers / Proposals / Pricing / publication tabs) | **survives (carry-over)** | Writer-side reframe deferred per `ALLHAUS-UI-SURFACE.md` §22. Continues to govern until the workspace metaphor reaches the writer side. |
| `/write` | full TipTap editor | **survives (deep-link form)** | Slice 10 lights up the workspace `Composer` article mode for fresh-publish + paywall + publication routing. `/write` continues to serve the long-form editor for everything the panel doesn't yet cover: tag input, scheduling, draft resumption (`?draft=`), edit-published-article (`?edit=`), and the publish-confirmation panel with email-subscribers checkbox. The Migration Map's earlier "undecided" verdict resolves provisionally to *survives as deep-link form* per Open Item §5.6. |
| `/notifications` | log view | **folds** | New home is undecided per §14 — corner anchor, ∀ menu adjunct, peripheral vessel, or user-scope. `NotificationBell` in current `Nav.tsx` retires with the topbar. |
| `/messages` + `/messages/[conversationId]` | DM list + thread | **undecided** | The central reframing question per §13. The To-field cardinality collapses DMs and posts into one gesture; whether `/messages` survives, becomes a vessel, or is reached via To-field history is not pinned. |
| `/search` | trigram search results | **undecided** | §19.1: search backend exists; entry point under workspace metaphor not specified. |
| `/admin` + `/admin/reports` | reports queue | **survives (carry-over)** | Admin reframe deferred per §20.2 / §22.2. |
| `/traffology`, `/traffology/overview`, `/traffology/piece/[id]` | analytics | **survives (carry-over)** | Writer-side analytics reframe deferred per §16. |
| `/[username]` | writer profile | **survives (carry-over)** | Per §9 — masthead absorbs less now that the pip panel exists, but the page stays as the depth surface. Tab labels and the trust block need reconciliation but the route persists. |
| `/article/[dTag]` | article reader | **survives (carry-over)** | §8: the *reading-vs-arranging mode* coupling that would fold this into a vessel is explicitly deferred. URL navigation is the stop-gap. |
| `/pub/[slug]` + `/about`, `/archive`, `/masthead`, `/subscribe`, `/[articleSlug]` | publication surfaces | **survives (carry-over)** | §15: workspace fit for publications is the central reframing question and explicitly open. URLs persist. |
| `/auth`, `/auth/verify`, `/auth/google/callback` | sign-in flows | **survives** | Pre-workspace surface. Untouched. |
| `/about` | static about page | **survives (carry-over)** | Marketing surface; no reframe. |
| `/invite/[token]` | publication invite acceptance | **survives** | Resolver-backed; unchanged. |
| `/subscribe/[code]` | offer redeem page | **survives (carry-over)** | §22 outstanding subscription UI. |
| `/subscriptions` | external feed subscriptions manager | **folds → per-vessel composer §2.3** | Per §19.4: subscriptions and external feed sources both flow through the feed composer as ⊔ operands. |
| `/tag/[tag]` | tag browse | **survives (carry-over)** | §19.2 — no all-tags index, otherwise minimal. |
| `/account`, `/social`, `/history`, `/followers`, `/following`, `/bookmarks`, `/reading-history` | URL aliases (Next.js `redirect()`) | **retires** | All seven are one-line `redirect()` files. They go away with the destinations they redirect to. |

---

## 2. Components (`web/src/components/`)

### Components the new corpus actively wants

These will need to be either built fresh or substantially rewritten against the new spec. None of them exist today.

| Spec ref | New surface | Closest existing component |
|---|---|---|
| §1, WORKSPACE-DESIGN-SPEC.md "the workspace" | Workspace floor (grey-100 surface holding ⊔ vessels with persistent layout) | none |
| §2, CARDS-AND-PIP-PANEL-HANDOFF.md | ⊔ vessel chassis (heavy-walled, with brightness/density/orientation gestures) | `FeedView.tsx` is the closest functional precedent but the visual chassis is novel |
| §1.3 | ∀ workspace control + four-item menu | `web/src/components/workspace/ForallMenu.tsx` (slice 2: button + menu shell). All five item handlers now wired: *new note* → `Composer` (slice 2.5), *new feed* → `NewFeedPrompt` (slice 3), *write an article* → `Composer` in article mode (slice 10), *fork feed by URL* → `ForkFeedPrompt` (slice 8), *reset workspace layout* → `ResetLayoutConfirm` (slice 6). The wireframe Step 4 spec lists four ∀ items; the fifth (*write an article*) is additive and matches the spec's intent of making elevation reachable as a workspace gesture rather than only via the in-composer note→article switch. |
| §4, CARDS-AND-PIP-PANEL-HANDOFF.md | Pip panel (popover/sheet with TRUST polling section + VOLUME bar + FOLLOW + SUBSCRIBE) | `TrustPip.tsx` exists as the inline pip; the panel itself is new |
| §3.1–3.6, CARDS-AND-PIP-PANEL-HANDOFF.md | Unified card grammar (opaque-white block, no left bar, paywall chip in header) | `ArticleCard.tsx`, `NoteCard.tsx`, `ExternalCard.tsx`, `QuoteCard.tsx` — current chassis is the deprecated 4px-left-bar variant |
| §6 | Note→article composer (single surface, To field, 400-word nudge) | `web/src/components/workspace/Composer.tsx` — slice 10 lights up article mode. TipTap-backed editor mounts up-front while open and survives a note→article elevation in-place; first-line `# Heading` promotes to the title field. Article-mode chrome adds title (Literata serif italic 22px), standfirst (Literata serif italic 15px), `Publish as` selector pulled from `publications.myMemberships()` (PERSONAL default; non-publish memberships get `(review)` annotation + `Submit for review` button label), toolbar `B · I · H2 · H3 · " · IMG | PAYWALL` with crimson PAYWALL accent, paywall price row when the gate is inserted, word-count + read-time readout, and a crimson Publish button. Publish dispatches to `publishToPublication` (publication selected) or `publishArticle` (PERSONAL) — both helpers in `web/src/lib/publish.ts` are reused as-is. Draft autosave via `createAutoSaver(3000)` against the existing `/api/v1/drafts` route, gated on a non-empty title. The 400-word nudge ships per spec — inline panel reading *This is getting long. Switch to article mode?* with Switch (crimson) and Dismiss buttons; dismissal is per-Composer-session. Cross-protocol broadcast row is hidden in article mode (article path anchors on Nostr kind 30023; ActivityPub / Bluesky article fan-out is its own slice). Person chips disable publish with *Articles can't be sent privately*. The retiring `ComposeOverlay.tsx` + `ArticleComposePanel.tsx` is the three-mode shell it replaces. Schedule button, tag input, edit-published-article, draft resumption, embed toolbar, comments-toggle, and price-suggestion-by-word-count remain on `/write` until they polish into the panel. Per-slice detail in `WORKSPACE-EXPERIMENT-ADR.md` build log. |
| WORKSPACE-DESIGN-SPEC.md "the composer" | Feed composer (configuration depth — list of sources, add-source-by-URL, per-source weights, feed renaming, deletion) | `web/src/components/workspace/FeedComposer.tsx` (slices 4 + 7) — list + add-by-resolver + remove + inline rename + delete-feed (two-step confirm, last-feed guard). Per-source weights / mute toggle still deferred. |
| §11 | First-login + feed-creation animations (∀ → H → ⊔) | none |

### Existing components — verdicts

#### `feed/`
| Component | Verdict | Reason |
|---|---|---|
| `FeedView.tsx` | **retires** | Single-stream feed page replaced by workspace + vessels. The reach selector, end-of-feed states, layout-block pairing logic, etc. are all single-feed concepts. |
| `ArticleCard.tsx` | **retires (rewrite)** | Carries the 4px left bar (dropped), avatar-less mono-caps byline (changes to pip + Literata 16px name + plex-caps platform/date), and a different action strip. The new card is in §3 of the cards/panel handoff. |
| `NoteCard.tsx` | **retires (rewrite)** | Same reasoning as `ArticleCard`. |
| `ExternalCard.tsx` | **retires (rewrite)** | Provenance badge migrates to header platform metadata; otherwise same chassis change. Per §3.10 carryover the *via X* line is the source platform line under another name. |
| `QuoteCard.tsx` | **retires (rewrite)** | Embedded-quote treatment is specced in §3.5 but with different geometry (inset block, smaller pip, no action row, inner pip tappable). |
| `SubscribeInput.tsx` | **folds → feed composer §2.3** | Omnivorous resolver-backed input; the surface it lives in (top of `/feed`) goes away, but the input pattern is exactly the *add-source-by-URL* affordance the feed composer needs. |

#### `compose/`
| Component | Verdict | Reason |
|---|---|---|
| `ComposeOverlay.tsx` | **retires (rewrite)** | Three-mode shell (note/reply/article) collapses per §6.7. Reply is the composer with reply context; article is the composer when the writing surface gets more room. |
| `ArticleComposePanel.tsx` | **retires (rewrite)** | Same — the article-mode-as-overlay pattern doesn't survive the elevation model. |

#### `editor/`
| Component | Verdict | Reason |
|---|---|---|
| `ArticleEditor.tsx` | **undecided** | Whether the full editor (`/write`) survives at all is open per §6.7. The TipTap stack and node extensions (`PaywallGateNode`, `EmbedNode`, `ImageUpload`) are valuable infrastructure that would migrate into whatever the article composer becomes. |
| `EmbedNode.ts`, `ImageUpload.ts`, `PaywallGateNode.ts`, `TagInput.tsx` | **survives (infrastructure)** | TipTap extensions are protocol-neutral. They'll move with the editor. |

#### `replies/`
| Component | Verdict | Reason |
|---|---|---|
| `PlayscriptReply.tsx`, `PlayscriptThread.tsx`, `ReplySection.tsx`, `types.ts` | **survives** | Per §8.3 — the playscript thread treatment survives intact, with the speaker-line pip semantics aligning with the new four-state pip. |
| `ReplyComposer.tsx` | **folds → composer §6** | The dedicated reply composer disappears; replies open the unified composer with reply context. |

#### `trust/`
| Component | Verdict | Reason |
|---|---|---|
| `TrustProfile.tsx` | **retires** | Four-dimension dimension bars (humanity/encounter/identity/integrity) are explicitly rejected per §5.3. Replaced by the pip panel's three-poll-question TRUST section + italic in-person line. |
| `VouchModal.tsx` | **retires** | Vouching as a reader-facing primitive ceases per §5.3 — replaced by anonymous secure polling. |
| `VouchList.tsx` | **retires** | Lives on `/network?tab=vouches`; both the route-tab and the surface are gone. |

#### `ui/`
| Component | Verdict | Reason |
|---|---|---|
| `TrustPip.tsx` | **survives (rewrite)** | Stays as inline pip on cards and reply speaker lines; states change from three (known/partial/unknown) to four (green/amber/grey/crimson) per §5.3 — a content rewrite, not a structural one. |
| `BookmarkButton.tsx` | **retires** | Cross-feed bookmarks dropped per §0/§7. Save is per-feed via long-press. |
| `VoteControls.tsx`, `VoteConfirmModal.tsx` | **survives** | Paid voting model unchanged per §3.7. May migrate visually into the new card action strip but the mechanics are intact. |
| `ReportButton.tsx` | **survives (carry-over)** | Report stays on the action strip per §3.6. The submit modal itself is undesigned (§20.1). |
| `ShareButton.tsx` | **survives (carry-over)** | Not addressed in the new corpus. Carry-over. |
| `Avatar.tsx` | **survives** | Used outside cards (profile masthead, DM list, dashboard). Cards no longer carry avatars per §0. |
| `PageShell.tsx` | **retires (gradually)** | The page-with-title pattern is a top-level admin/settings convention. As surfaces fold into user-scope or the workspace, it becomes vestigial. Some carry-over surfaces (dashboard, traffology) keep using it. |
| `CommissionForm.tsx` | **survives (carry-over)** | DM-side commission flow §13. |
| `AllowanceExhaustedModal.tsx`, `MediaContent.tsx`, `MediaPreview.tsx` | **survives** | Allowance modal is paywall-tab-related, dim at launch (§10.2). Media renderers are infrastructure. |

#### `social/`
| Component | Verdict | Reason |
|---|---|---|
| `FeedDial.tsx` | **retires** | Four-mode reach framing dropped per `ALLHAUS-UI-SURFACE.md` §638. |
| `BlockList.tsx`, `MuteList.tsx` | **folds** | Block moves to author profile / DM surface per §4.8; mute = 0% volume on pip panel. The list surfaces themselves likely fold into user-scope settings as a "Blocked accounts" subsection. |
| `DmFeeSettings.tsx` | **folds → user-scope §21** | DM fees are a per-user setting, not a per-feed concern. |
| `NotificationPreferences.tsx` | **survives (folds → user-scope §21)** | §21.2 lists notifications as a user-scope section; this component is already shaped for that home. |

#### `account/`
| Component | Verdict | Reason |
|---|---|---|
| `AccountLedger.tsx`, `BalanceHeader.tsx` | **dormant at launch** | Per §10.2 — micropayments deferred, so balance + accrual + tab history go dark. Reactivates with the tab. |
| `SubscriptionsSection.tsx` | **folds → pip-panel `SUBSCRIBED — MANAGE ›`** | §10.3 — subscription management home is undecided but the surface flows through the pip panel's SUBSCRIBE footer. |
| `PledgesSection.tsx` | **survives (carry-over)** | Pledge drives are a writer-side flow; reader-side surface unchanged at this level. |
| `ReadingHistory.tsx` | **retires (page-level)** | Cross-history list folds into user-scope reading preferences only as the resumption mechanic — there's no list surface in the new model. |
| `ReadingPreferences.tsx` | **survives → user-scope §21** | Already the right shape; relocates with `/settings`. |
| `EmailChange.tsx`, `LinkedAccountsPanel.tsx`, `PaymentSection.tsx`, `DangerZone.tsx` | **survives → user-scope §21** | All listed in §21.2 as user-scope sections. |

#### `profile/`
| Component | Verdict | Reason |
|---|---|---|
| `WorkTab.tsx`, `SocialTab.tsx`, `WriterActivity.tsx`, `ProfileDriveCard.tsx` | **survives (carry-over)** | Writer profile page survives per §9. Tabs reconcile against the new pip semantics but persist. |
| `FollowingTab.tsx`, `FollowersTab.tsx` | **folds → per-vessel composer + pip-panel** | Per §19.4: following list is subsumed by the per-vessel composer (sources) and the pip panel's FOLLOW toggle. |
| `UsernameChange.tsx` | **survives → user-scope §21** | |

#### `dashboard/`
| All components | **survives (carry-over)** | Writer-side reframe deferred per §22. |

#### `messages/`, `admin/`, `publication/`, `traffology/`, `home/`, `payment/`
All **survives (carry-over)** — the new corpus does not yet reach these surfaces.

#### `layout/`
| Component | Verdict | Reason |
|---|---|---|
| `Nav.tsx` | **retires (suppressed on /workspace as of slice 1.5)** | The workspace metaphor has no header bar (`ALLHAUS-UI-SURFACE.md` §1.4 unresolved + §22 deprecation list). The `NotificationBell`, `AvatarDropdown`, mobile sheet, search input — all collapse: avatar contents into user-scope, search undecided, bell home undecided. Still rendered on `/feed` and other platform-mode routes during the experiment. |
| `Footer.tsx` | **undecided (suppressed on /workspace)** | Footer not addressed in workspace spec (§1.4). Workspace fills the viewport so footer is hidden in workspace mode. |
| `LayoutShell.tsx`, `AuthProvider.tsx` | **survives (extended in slice 1.5)** | Auth provider is mechanism, not surface. `LayoutShell` now owns Nav / `ComposeOverlay` / `Footer` rendering and conditionalises on `useLayoutMode` — `workspace` mode suppresses all platform chrome. The shell becomes the workspace floor host once the workspace lands. |

---

## 3. Stores and hooks

| File | Verdict | Reason |
|---|---|---|
| `stores/auth.ts` | **survives** | Auth state, untouched. |
| `stores/compose.ts` | **retires (rewrite)** | Three-mode (note/reply/article) coordination retires with the overlay shell. The note→article elevation needs its own state model. |
| `stores/unread.ts` | **survives** | Notification unread counts; reused wherever the bell ends up. |
| `stores/workspace.ts` | **new (slice 5a)** | Vessel layout (`positions: Record<feedId, {x,y}>`), localStorage-backed per ADR §3. `hydrate / setVesselPosition / removeVessel / reset`. Resize / brightness / density / rotation extend this in later slices. |
| `hooks/useLayoutMode.ts` | **survives (extended in slice 1.5)** | Now also returns `workspace` for `/workspace` routes, used by `LayoutShell` to suppress platform chrome. |
| `hooks/useLinkedAccounts.ts`, `useMediaAttachments.ts` | **survives** | Composer infrastructure. |
| `hooks/useReadingPosition.ts` | **survives** | Reading-history resumption per §8.4. |
| `hooks/useWriterName.ts` | **survives** | Display-name lookup. |

---

## 4. Backend orphan check

The UI reframe doesn't automatically retire backend infrastructure. Verdicts here are independent.

### Endpoints whose UI retires

| Endpoint(s) | UI verdict | Backend verdict |
|---|---|---|
| `POST/DELETE/GET /vouches`, `GET /my/vouches` (`gateway/src/routes/trust.ts`) | UI retires | **Keep for now.** Per `ALLHAUS-UI-SURFACE.md` §5.3, "Layer 1 precomputed signals (`trust_layer1`) and Layer 2 epoch aggregation (`trust_profiles`, `trust_epochs`) survive as backend infrastructure — what the pip panel renders draws on those." Whether the existing public vouch corpus survives as a pre-poll seed signal is open. Holding the data is cheap; deleting it is not recoverable. |
| `POST/DELETE /bookmarks`, `GET /bookmarks`, `GET /bookmarks/ids` (`gateway/src/routes/bookmarks.ts`) | UI retires | **Retire alongside.** Cross-feed bookmarks are explicitly dropped (`ALLHAUS-UI-SURFACE.md` §0/§7). The new per-feed `Save` is a different mechanism (item marker scoped to a vessel) with no carry-over data. Migration 047 (`bookmarks` table) becomes orphan; consider a no-op until launch then drop, since users may have data they care about losing. |
| `GET/PATCH/PUT /feed-dial-*` (in `gateway/src/routes/follows.ts` or `social.ts`) | UI retires | **Retire alongside** — four-mode reach framing dropped. |
| Reach selector params on `GET /feed` (`gateway/src/routes/timeline.ts`) | UI retires (single-stream feed gone) | **Survives.** The query underneath becomes the per-vessel content fetch. Slices 1–2 used `?reach=explore` against this endpoint as a temporary backing for the single hardcoded vessel. Slice 3 swapped that for `GET /api/v1/feeds/:id/items` (`gateway/src/routes/feeds.ts`) backed by `feeds` + `feed_sources` (migration 077); empty source sets keep the inline explore mirror. Slice 4 added a non-empty branch that fans out across four OR-ed `EXISTS` clauses against `feed_sources` (account / publication / external_source / tag); the explore mirror still serves freshly-created empty feeds until the user adds the first source. The original `/feed?reach=…` endpoint stays live for `/feed` until that route retires. |

### Endpoints whose UI folds (functionality preserved, surface relocates)

All these stay live. The frontend rewires call sites once the workspace surfaces are built.

- `GET /api/v1/notifications`, `PATCH /notifications/:id/read` — wherever the bell ends up.
- `POST/DELETE /follows` — moves from `/network?tab=following` to the pip panel `FOLLOW`.
- `POST/DELETE /blocks`, `/mutes` — block to profile/DM, mute folds into 0% volume.
- `GET /resolve` — drives feed composer, ∀-menu *fork by URL*, To-field autocomplete. More used, not less.
- `POST /subscriptions/:writerId`, `DELETE /subscriptions/:writerId` — pip-panel SUBSCRIBE flow.
- `GET /external-feeds`, `POST /external-feeds`, etc. (`gateway/src/routes/external-feeds.ts`) — sources in the per-vessel composer.

### Endpoints with no UI change at the backend level

`auth.*`, `messages.*`, `articles.*`, `replies.*`, `votes.*`, `traffology.*`, `publications.*`, `payment-service.*`, `linked-accounts.*`, `relay-outbox.*`, `tags.*`, `search.*` — survive as-is.

### Migrations created for retired/folded UI

| Migration | Status |
|---|---|
| 047 (`bookmarks`) | Orphans with the bookmark feature. Holding pattern. |
| 048 (`tags`) | Tags survive (§19.2); unaffected. |
| 050 (`publications.homepage_layout`) | Publication carry-over; unaffected. |
| 051 (`article_drafts.scheduled_at`) | Scheduling status undecided per §6.7; data harmless if unused. |
| 065 (`trust_layer1`), 066 (`vouches`, `trust_profiles`), 067 (`trust_epochs`) | Survive as backend per §5.3 — repurposed. |
| 068 (`articles.size_tier`) | Survives as a content-shape variable per §3.3. |
| 069 (`reading_positions`) | Survives per §8.4. |
| 076 (`relay_outbox`) | Infrastructure; unaffected. |

---

## 5. Open carry-over decisions the corpus flags

These are the resolved-in-corpus-but-undecided-on-implementation gaps. Each blocks at least one surface in the table above.

1. **∀ workspace control position** — corner vs floating edge (`WORKSPACE-DESIGN-SPEC.md` open Q + `WIREFRAME-PLAN.md` step 4). Resolved by prototyping on hardware.
2. **User-scope avatar position vs ∀** — both want a corner; conflict per `ALLHAUS-UI-SURFACE.md` §21 unresolved. The two corners might coexist if they take different ones.
3. **Notification bell home** — corner / ∀ adjunct / peripheral vessel / user-scope (§14). Open.
4. **Search entry point** — workspace-floor input / ∀-menu item / fold into universal-input (§19.1). Open.
5. **DM surface fate** — `/messages` survives / becomes a vessel / reached via To-field history (§13). The most consequential single open question for the symmetry claim in PRINCIPLES (a message and a post are the same object).
6. **`/write` page fate** — survives as deep-link form / folds entirely (§6.7).
7. **Reading-mode vs arranging-mode coupling** — explicitly deferred to its own design pass (`WORKSPACE-DESIGN-SPEC.md` open Q + `WIREFRAME-PLAN.md` "out of scope"). Until landed, vessel→article is URL navigation.
8. **Brightness baseline** — absolute per-feed (committed) vs offset from workspace global. Revisit after lived experience.
9. **Dark mode** — unspecified beyond per-vessel brightness gradient (§23 unresolved).
10. **Footer** — not addressed in workspace spec (§1.4 unresolved).
11. **Cross-protocol replies** — Bluesky reply that adds a Mastodon user. Deferred.
12. **Same-author-multi-platform volume** — Craig Mod on Nostr and RSS as one source or two (§4.6 unresolved + CARDS-AND-PIP-PANEL-HANDOFF.md "Open architectural questions").
13. **Pip-colour composition function** — how three poll results + in-person count compose into pip colour (§4.5 + handoff). Trust-system-spec-proper territory.
14. **Cross-feed bookmark migration story** — existing data + user expectations need a graceful exit (§638 + global #6).
15. **Magazine publication layout, theming, custom domains** — Phase 4 publication work undesigned (§15.4).
16. **Owner dashboard component design** — paper spec only (§22.2).
17. **Reader-side report modal** — undesigned (§20.1).
18. **Mobile gesture vocabulary** — pinch / two-finger-rotate / two-finger-vertical-drag / long-press needs SR + keyboard analogues (§23 unresolved + global #8).
19. **Publication workspace fit** — vessel / separate workspace / external URL space (§15 unresolved).
20. **Subscription management surface** — where `SUBSCRIBED — MANAGE ›` points (§10.3).

---

## 6. Implications for ongoing work

Three classes of work, in order of safety:

**Safe to continue.** Anything tagged *survives* or *survives (carry-over)* above. The carry-over caveat is real but the work isn't waste — it ships under the prior product corpus and reframes later. Examples: dashboard improvements, publication theming, owner dashboard, traffology phases 2–4, subscription Phase 2 (free trials, gift subs, welcome email, analytics, custom landing page), email-on-publish, reposts, currency strategy.

**Stop building on.** Anything tagged *retires* or *folds*. Investing in the four-dimension trust UI, the cross-feed bookmark surface, the reach selector, the four-mode FeedDial, the topbar `Nav`, or the three-mode `ComposeOverlay` deepens code that the workspace replaces. If a bug lands here, fix it minimally; don't extend.

**Don't touch until decided.** Anything tagged *undecided*. The list above (§5) is the agenda. Each item is a small design call, not a programme — most can be resolved in a session.

The wireframing pass (`WIREFRAME-PLAN.md`) does not need any of the *undecided* items resolved before starting steps 1–3 (the vessel rendering study, the density/brightness matrix, and the workspace at rest). It does need them resolved before steps 4 onward overlap with the carry-over surfaces.

---

*This map is a snapshot. Revise when the corpus revises, when wireframing decisions land, and when retired surfaces are actually deleted from the codebase.*

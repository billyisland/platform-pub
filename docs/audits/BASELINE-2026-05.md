# Static Analysis Baseline — May 2026

Measured 2026-05-15 against the `workspace-experiment` branch.

---

## 1. TypeScript Compilation (`tsc --noEmit`)

| Workspace         | Errors |
| ----------------- | ------ |
| shared            | 0      |
| gateway           | 0      |
| payment-service   | 0      |
| key-service       | 0      |
| key-custody       | 0      |
| feed-ingest       | 0      |
| traffology-ingest | 0      |
| traffology-worker | 0      |
| web               | 0      |
| **Total**         | **0**  |

All 9 workspaces compile cleanly.

---

## 2. Dead Code (knip)

**47 items total** — all in `web/`.

### Unused files (8)

| File                     | Notes                        |
| ------------------------ | ---------------------------- |
| `public/traffology.js`   | Analytics beacon script      |
| `src/lib/traffology.ts`  | Traffology client lib        |
| `tests/format.test.ts`   | Not wired into vitest config |
| `tests/markdown.test.ts` | "                            |
| `tests/media.test.ts`    | "                            |
| `tests/publish.test.ts`  | "                            |
| `tests/vault.test.ts`    | "                            |
| `tests/voting.test.ts`   | "                            |

The 6 test files are likely false positives — knip can't see vitest's glob entrypoints. The 2 traffology files may be genuinely unused if the beacon is loaded via `<script>` in HTML rather than imported.

### Unused exports (16)

| Export                           | Kind     | Location                                        |
| -------------------------------- | -------- | ----------------------------------------------- |
| `CommissionsTab`                 | function | `src/components/dashboard/CommissionsTab.tsx:6` |
| `PageHeader`                     | function | `src/components/ui/PageShell.tsx:11`            |
| `BAR_H`                          | const    | `src/components/workspace/VesselBar.tsx:30`     |
| `invalidateLinkedAccounts`       | function | `src/hooks/useLinkedAccounts.ts:32`             |
| `ApiError`                       | class    | `src/lib/api/client.ts:13`                      |
| `renderMarkdownSync`             | function | `src/lib/markdown.ts:85`                        |
| `enhanceEmbedUrls`               | function | `src/lib/markdown.ts:124`                       |
| `generateDTag`                   | function | `src/lib/publish.ts:222`                        |
| `decryptVaultContentXChaCha`     | function | `src/lib/vault.ts:37`                           |
| `decryptVaultContentAesGcm`      | function | `src/lib/vault.ts:56`                           |
| `base64ToUint8Array`             | function | `src/lib/vault.ts:130`                          |
| `VESSEL_DRAG_TRANSITION`         | const    | `src/lib/workspace/motion.ts:6`                 |
| `VESSEL_DRAG_TRANSITION_REDUCED` | const    | `src/lib/workspace/motion.ts:13`                |
| `ceremonyTotal`                  | function | `src/lib/workspace/motion.ts:75`                |
| `matchToOptions`                 | function | `src/lib/workspace/resolve.ts:11`               |
| `tagFallback`                    | function | `src/lib/workspace/resolve.ts:62`               |

### Unused exported types (23)

| Type                         | Kind      | Location                                     |
| ---------------------------- | --------- | -------------------------------------------- |
| `EmbedNodeOptions`           | interface | `src/components/editor/EmbedNode.ts:16`      |
| `ImageUploadOptions`         | interface | `src/components/editor/ImageUpload.ts:15`    |
| `ExternalFeedItem`           | interface | `src/components/feed/ExternalCard.tsx:27`    |
| `VoteTally`                  | interface | `src/components/ui/VoteControls.tsx:9`       |
| `MyVoteCount`                | interface | `src/components/ui/VoteControls.tsx:15`      |
| `HiddenFeed`                 | interface | `src/components/workspace/ForallMenu.tsx:24` |
| `PipOpen`                    | type      | `src/components/workspace/VesselCard.tsx:25` |
| `UseResolverInput`           | interface | `src/hooks/useResolverInput.ts:8`            |
| `ArticleEarnings`            | interface | `src/lib/api/account.ts:15`                  |
| `ReadingPosition`            | interface | `src/lib/api/articles.ts:238`                |
| `ReplyResponse`              | interface | `src/lib/api/feed.ts:16`                     |
| `WorkspaceFeedItemsResponse` | interface | `src/lib/api/feeds.ts:14`                    |
| `WorkspaceFeedSavesResponse` | interface | `src/lib/api/feeds.ts:184`                   |
| `DraftData`                  | interface | `src/lib/drafts.ts:17`                       |
| `UploadResult`               | interface | `src/lib/media.ts:14`                        |
| `ExtractedMedia`             | interface | `src/lib/media.ts:129`                       |
| `VaultEvent`                 | interface | `src/lib/ndk.ts:75`                          |
| `NostrEventTemplate`         | interface | `src/lib/sign.ts:10`                         |
| `SignedNostrEvent`           | interface | `src/lib/sign.ts:17`                         |
| `FeedResponse`               | interface | `src/lib/traffology-api.ts:34`               |
| `ConcurrentResponse`         | interface | `src/lib/traffology-api.ts:133`              |
| `Observation`                | interface | `src/lib/traffology-templates.ts:9`          |
| `VesselLayout`               | interface | `src/stores/workspace.ts:27`                 |

---

## 3. npm Audit

### Backend (root workspace, production deps only)

**8 vulnerabilities** — 2 moderate, 5 high, 1 critical.

| Package                 | Severity      | Issue                                                                                                                                                                                                                          | Fix                                    |
| ----------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `sanitize-html` ≤2.17.3 | **Critical**  | XSS via `xmp` raw-text passthrough (GHSA-rpr9-rxv7-x643)                                                                                                                                                                       | `npm audit fix`                        |
| `fast-uri` ≤3.1.1       | **High** (×5) | Path traversal via percent-encoded dot segments (GHSA-q3j6-qgpj-74h6); host confusion via percent-encoded authority delimiters (GHSA-v39h-62p7-jpjc). Chains through `@fastify/ajv-compiler`, `fast-json-stringify`, `fastify` | Requires `fastify@5.8.5` (breaking)    |
| `ip-address` ≤10.1.0    | **Moderate**  | XSS in Address6 HTML-emitting methods (GHSA-v2v4-37r5-5v8g). Chains through `geoip-lite`                                                                                                                                       | Requires `geoip-lite@2.0.2` (breaking) |

### Web (separate workspace)

**6 vulnerabilities** — 5 moderate, 1 high.

| Package                | Severity        | Issue                                                                           | Fix                                                   |
| ---------------------- | --------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `next` (13 advisories) | High / Moderate | DoS, cache poisoning, XSS, SSRF, request smuggling across multiple Next.js CVEs | Requires `next@16.2.6` (breaking — currently on 14.x) |
| `postcss` <8.5.10      | Moderate        | XSS via unescaped `</style>` in CSS stringify (GHSA-qx2v-qp2m-jg93)             | Transitive via next                                   |

---

## 4. ESLint

### Backend (8 workspaces): 0 errors, 285 warnings

| Rule                                               | Count   | Fixable    |
| -------------------------------------------------- | ------- | ---------- |
| `@typescript-eslint/no-unnecessary-type-assertion` | 175     | Yes (auto) |
| `@typescript-eslint/no-explicit-any`               | 83      | No         |
| `@typescript-eslint/no-unused-vars`                | 25      | No         |
| **Total**                                          | **285** | **175**    |

**By service:**

| Service           | Warning count |
| ----------------- | ------------- |
| gateway           | 243           |
| feed-ingest       | 20            |
| shared            | 9             |
| payment-service   | 8             |
| traffology-worker | 2             |
| key-custody       | 2             |
| key-service       | 1             |
| traffology-ingest | 0             |

### Web: ESLint not configured

No `.eslintrc.*` or `eslint.config.*` file exists. `next lint` prompts for initial setup. This is a gap — the web frontend (207 source files, 3,400+ total including generated) has no linting.

---

## 5. `as any` Casts

**22 total** across source files (excluding tests).

| Service     | Count |
| ----------- | ----- |
| gateway     | 16    |
| web         | 2     |
| feed-ingest | 2     |
| shared      | 1     |

### By category

| Category                              | Count | Files                                                                                                                                         |
| ------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Untyped Fastify route params**      | 4     | `gateway/src/middleware/publication-auth.ts`                                                                                                  |
| **Untyped Fastify query params**      | 4     | `gateway/src/routes/publications/cms.ts`, `public.ts`                                                                                         |
| **Untyped response/body destructure** | 4     | `media.ts` (oEmbed), `trust.ts` (vouch body), `publications/cms.ts`, `members.ts`                                                             |
| **Enum/union `.includes()` widening** | 3     | `notifications.ts`, `trust.ts` (×2)                                                                                                           |
| **Library type gaps**                 | 3     | `shared/logger.ts` (pino), `feed-ingest/text.ts` (Intl.Segmenter), `feed-ingest/nostr.ts` (verifyEvent)                                       |
| **Workarounds**                       | 4     | `scheduler.ts` (created_at hack), `WorkspaceView.tsx` (authorId), `MessageThread.tsx` (React type), `publication-auth.ts` (member perm check) |

---

## 6. TODO / FIXME / HACK Comments

**0 occurrences.** The codebase is clean of annotation debt.

---

## 7. Test Coverage

| Service           | Source files | Test files | Ratio    |
| ----------------- | ------------ | ---------- | -------- |
| key-custody       | 4            | 2          | 50.0%    |
| payment-service   | 10           | 3          | 30.0%    |
| shared            | 21           | 3          | 14.3%    |
| feed-ingest       | 36           | 4          | 11.1%    |
| key-service       | 9            | 1          | 11.1%    |
| gateway           | 73           | 4          | 5.5%     |
| web               | 207          | 6          | 2.9%     |
| traffology-ingest | 8            | 0          | 0.0%     |
| traffology-worker | 7            | 0          | 0.0%     |
| **Total**         | **375**      | **23**     | **6.1%** |

### Notable gaps

- **traffology-ingest** and **traffology-worker**: zero tests
- **gateway**: 4 tests for 73 source files (the largest service)
- **web**: 6 tests for 207 source files (knip flags all 6 as "unused" — they may not be wired into the vitest config properly)

### What is tested

| Area                          | Test file                                            | Approx. cases |
| ----------------------------- | ---------------------------------------------------- | ------------- |
| Relay outbox state machine    | `feed-ingest/src/tasks/relay-publish.test.ts`        | 10            |
| Trust weighting + aggregation | `feed-ingest/src/lib/trust-*.test.ts`                | 42            |
| Article access / gate pass    | `gateway/src/services/article-access/access.test.ts` | ~10           |
| Payment accrual/settlement    | `payment-service/src/services/*.test.ts`             | ~15           |
| Shared auth/crypto/utils      | `shared/src/**/*.test.ts`                            | ~10           |
| Key custody crypto            | `key-custody/src/**/*.test.ts`                       | ~8            |
| Web formatting/vault/voting   | `web/tests/*.test.ts`                                | ~20           |

### What is not tested

- Auth flow (magic link → session → refresh → logout)
- Article publish pipeline (create → sign → relay outbox → feed_items)
- External feed ingest (RSS, Nostr, Bluesky, ActivityPub adapters)
- Resolver pattern classification and Phase B polling
- Timeline query / cursor pagination
- Outbound cross-posting
- All traffology paths
- Any frontend component behavior

---

## 8. Summary Scorecard

| Metric              | Value          | Assessment                                                                     |
| ------------------- | -------------- | ------------------------------------------------------------------------------ |
| tsc errors          | 0              | Clean                                                                          |
| ESLint errors       | 0              | Clean                                                                          |
| ESLint warnings     | 285            | 175 auto-fixable; 83 explicit-any worth triaging                               |
| `as any` casts      | 22             | Low; mostly Fastify param typing gaps                                          |
| TODO/FIXME/HACK     | 0              | Clean                                                                          |
| knip findings       | 47             | 8 files + 16 exports + 23 types; all in web                                    |
| npm audit (backend) | 8 (1 critical) | `sanitize-html` fix is non-breaking; `fastify`/`geoip-lite` need major bumps   |
| npm audit (web)     | 6 (1 high)     | All Next.js transitive — fix requires Next.js 16 upgrade                       |
| Test ratio          | 6.1%           | Low; critical payment/trust paths covered, but gateway and web are underserved |
| Web ESLint          | Not configured | Gap — 207+ source files unlinted                                               |

### Priority actions

1. **`npm audit fix`** — patch `sanitize-html` (critical XSS, non-breaking fix available)
2. **Configure web ESLint** — 207 source files have no linting
3. **`npx eslint --fix`** — auto-remove 175 unnecessary type assertions
4. **Triage `as any` in gateway** — 8 of 16 gateway casts are missing Fastify route typing (fixable with generic route schemas)
5. **Wire web tests into vitest** — 6 test files exist but may not be discovered
6. **Plan Next.js upgrade path** — 13 advisories require Next.js 16 (breaking)
7. **Plan Fastify upgrade path** — 5 `fast-uri` advisories require Fastify 5.8.5 (breaking)

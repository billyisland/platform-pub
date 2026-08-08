# Archive import — bringing a writer's back catalogue in

**Status:** proposed, 2026-08-07. Design pass only — nothing built.
**Scope:** Substack first (CONSOLIDATED-TODO §3.5, frontend audit #8); Ghost and WordPress behind the same adapter boundary later.
**Why now:** it is the launch cohort's switching cost. Twenty to thirty writers each have an archive, and an archive that cannot come with them is a reason not to come.

---

## I. What a Substack export actually is

Established from Substack's own docs plus two independent write-ups of real exports ([support.substack.com](https://support.substack.com/hc/en-us/articles/360037466012-How-do-I-export-my-posts), [letters.byburk.net](https://letters.byburk.net/p/how-to-back-up-your-substack), [docs.buttondown.com](https://docs.buttondown.com/substack)). **Not yet verified against a real archive** — see §XI, which is the first build step and not a formality.

A ZIP containing:

- **`posts.csv`** — one row per post, published *and* draft. Carries `post_id`, `post_date`, `is_published`, `title`, `subtitle`, `audience`, `type`, and email-send timestamps. Exact column set varies by export era, which is a design constraint, not a footnote (§IX).
- **`posts/`** — one HTML file per **published** post, named `<post_id>.<slug>.html`.
- **`email_list.<name>.csv`** — the subscriber list. Out of scope here; it belongs with §4.4 subscriber CSV import.
- Per-post `delivers`/`opens` CSVs. Ignored.

Three properties of that shape drive most of the design below.

**The HTML files are body fragments, not pages.** No `<html>`, no `<head>`, no title, no date, no byline. Title, subtitle and date live *only* in `posts.csv`. So the two must be joined on `post_id`, and a row whose HTML file is missing is not an error to abort on — it is a draft.

**Drafts appear in `posts.csv` with `is_published=false` and have no HTML file at all.** There is no body to import. They are a count to report, not content to bring.

**The export contains no images whatsoever.** Every `<img>` points back at Substack's CDN. "Import the archive" therefore means making several hundred outbound HTTP requests to a third party — a fact that decides §VI and pulls the SSRF invariant into the middle of this feature.

---

## II. D1 — It runs on the server, and it reuses the one publish pipeline

The importer is a gateway service. It does **not** run in the browser reusing `web/src/lib/publish.ts`.

Three reasons, in order of weight:

1. **The browser pipeline cannot survive the job.** Two hundred posts × five round trips each, with a vault call and a relay publish per paywalled one. A closed tab mid-run leaves an archive half-imported and no record of where it stopped.
2. **Image rehosting is an outbound fetch** to `substackcdn.com`, which must go through `safeFetch` (`shared/src/lib/http-client.ts`). That is server-side by construction.
3. **The server pipeline already exists, complete.** `publishPersonalDraft` in `gateway/src/workers/scheduler.ts` signs via key-custody, indexes `articles` + `feed_items` as one dual-write, enqueues to `relay_outbox` inside that transaction, seals the vault and swings to v2. Its paywall arm goes unused here (D4 — nothing imported is ever paywalled), but everything before it is exactly what an import needs and is already correct.

**So the first commit of this feature contains no import code at all.** It extracts `publishPersonalDraft` (and `splitContent`/`createVault`) out of the scheduler into `gateway/src/services/article-publisher.ts`, behaviour-preserving, with the scheduler calling it. The importer is then a second caller.

This is the load-bearing decision. A bulk publisher written alongside the real one is how the vault step, the outbox enqueue, or the `access_mode`/`price_pence` lockstep gets quietly dropped for the import path — and the paywall invariants say a paywalled article with no vault key is a live article the platform charges for and cannot deliver. **One pipeline, two callers.**

The extracted signature gains an options object; every new field defaults to today's behaviour, so the scheduler's call is unchanged:

```ts
publishArticle(input, {
  publishedAt?: Date        // D2 — defaults to now
  sendEmail?: boolean       // D3 — defaults to true
  matchDrives?: boolean     // D3 — defaults to true
})
```

---

## III. D2 — Dates: the `published_at` tag is backdated, `created_at` is not

**The bug this closes before it ships.** Both publish paths hardcode the present in four places: the NIP-23 `published_at` tag, the event `created_at`, `articles.published_at`, and `feed_items.published_at` — all `now()` (`articles/publish.ts:104`, `scheduler.ts:202`/`253`/`310`). Import an archive through them unchanged and every post from 2019 is dated today. That is not a cosmetic defect: it destroys the chronology that *is* the archive, and it lands two hundred articles at the top of every follower's feed simultaneously.

NIP-23 already distinguishes the two, and its distinction is exactly right here:

| Field | Value | Why |
| --- | --- | --- |
| `published_at` tag | **original** post date | First publication. The post genuinely was published in 2019. |
| event `created_at` | **now** | This event genuinely was created today. It is a new signature over old words. |
| `articles.published_at` | **original** | Feeds, profile and archive order by it. |
| `feed_items.published_at` | **original** | Same, and it is what keeps the archive buried where it belongs. |

Backdating `created_at` as well would *also* work — strfry's `rejectEventsOlderThanSeconds` is 315360000, ten years (`relay/strfry.conf:65`) — but only for ten years, after which posts silently fail to reach the relay while the DB row indexes fine. A split that is both semantically correct and has no cliff beats one that is merely usually correct. **Do not backdate `created_at`.**

Note the paywalled path pins v2 at `v1.created_at + 1`; with `created_at` left at now that arithmetic is untouched.

---

## IV. D3 — An import notifies nobody and fulfils nothing

`publishPersonalDraft` calls `sendPublishNotifications` and `checkAndTriggerDriveFulfilment` on every publish. Both must be **off** for imports, unconditionally.

- **Email.** Two hundred imported posts is two hundred broadcast emails to a list the writer has just brought over. This is the single most damaging thing this feature could do, it is irreversible, and it would happen on the very first real use.
- **Pledge drives.** A drive matches on `draft_id`; an import has no working draft, so a match is meaningless — but `matchDriveForPublish` runs inside the index transaction and a spurious match charges pledgers. Off.

Neither is a flag the writer gets to set. They are properties of what an import *is*: publishing something that was already published somewhere else, to an audience that has not asked to be told about it again.

---

## V. D4 — A paid post becomes a draft. Nothing imported is ever paywalled

**Owner ruling 2026-08-07: the importer never creates a paywalled article.** Not at a flat price, not at a writer-chosen gate, not at all.

The mismatch that decides it is structural rather than a mapping detail: **Substack's paywall is a subscription, ours is a per-article price plus a gate position.** There is no faithful translation, and it is not established that the export marks the free-preview boundary inside the HTML at all — so a gate position would be invented, not imported. Inventing the number that decides how much of a writer's paid work is given away free is not a default anyone should ship.

Substack's `audience` column is `everyone` / `only_free` / `only_paid` / `founding`. The first two publish as public articles. **The paid ones (`only_paid`, `founding`, and any unrecognised value) land in `article_drafts` with their full body, and the preview says so in as many words.** The writer publishes them when and how they choose, through the editor that already knows how to price and gate.

Two consequences worth stating plainly:

- **Import-as-public is banned for paid posts** — it publishes a paid back catalogue for free, to the relay, in one click, irreversibly. An unrecognised `audience` value therefore fails *closed*, to the draft, never to public.
- **Silence is the other failure.** A writer whose best work is the paid work must not find it simply absent. The count is reported in the preview *before* confirmation and again in the result, and the drafts are visible in the dashboard where the writer already looks.

**This removes the vault path from the importer entirely**, and with it the whole paywall invariant surface: the price/gate lockstep across the editor, `IndexArticleSchema` and the key-service `PublishVaultSchema`; the `performGatePass` deliverability check; the publication paywall hard-block, which is now simply never reached. That is the largest single de-risking in this design and it came from a scope decision, not from code.

---

## VI. D5 — Images are rehosted, and it is its own resumable phase

The export has no images. The choice is hotlink or rehost.

**Rehost.** A writer's archive whose pictures are served by the platform they left is not an archive they own, and the platform's whole thesis is that they own it. Hotlinking also leaks every reader's IP to Substack and dies whenever Substack rotates a URL.

The pipeline already exists inside `POST /media/upload` (`routes/media.ts`): sharp → WebP → sha256 → dedupe → BUD-02 signed PUT to Blossom → verify the returned hash → `media_uploads` row. Extract its core from the multipart wrapper so the importer feeds it a buffer instead of a file part. The dedupe on `sha256` is free and material — a writer's header image repeated across 200 posts fetches 200 times and stores once.

Two rules:

- **`safeFetch`, always.** The image URL comes from an uploaded file. It is attacker-controlled by definition, even when the attacker is a confused writer, and the SSRF invariant admits no exception. `substackcdn.com` is a public host, so `safeFetch` reaches it fine.
- **It is a separate phase with its own cursor and its own failure counters.** Six hundred outbound fetches is the slowest and flakiest part of the job by an order of magnitude. A failed image must degrade to the original URL and be counted, never fail the post. An article that imports with three of its four pictures is a good outcome; an archive that stops on post 47 because a CDN blipped is not.

Cover image: `posts.csv` carries no cover. Promoting the body's first image to `cover_image_url` is the obvious heuristic and changes how every card renders, so it is a checkbox in the preview, not a silent default.

---

## VII. D6 — Idempotency comes from a deterministic d-tag

`generateDTag` appends a base-36 timestamp, so it is non-deterministic by design. Re-run an import through it and the archive lands twice — the `articles` upsert is on `(writer_id, nostr_d_tag)` and the second run collides with nothing.

Imports derive the d-tag from the source identity instead:

```
<slugify(title, 80)>-sub<post_id>
```

Stable across runs, so a re-run of a partially-failed import converges through the existing upsert rather than duplicating. This is the follow-import lesson (a sync that cannot tell "already there" from "new" is a sync that grows the list every time it runs), and it is also what makes the resume story in §VIII cheap.

The `sub` segment is the adapter's prefix — `gh` for Ghost, `wp` for WordPress — which keeps two archives of the same post distinguishable if a writer imports both.

---

## VIII. D7 — The job model, copied from follow-import

`follow_imports` is the right shape and is proven in production. Mirror it: `article_imports` with `account_id`, `source` (`substack`), `status` (`pending`/`preview`/`running`/`done`/`failed`), `total`/`imported`/`skipped`/`failed`, a `cursor`, an `error`, a `manifest` jsonb, and the writer's `options` from the preview.

The flow is **parse → preview → confirm → sweep**, and the preview is not optional:

1. **Upload** the ZIP. Parse it, write the manifest, land at `status='preview'`. Nothing is published.
2. **Preview** reports what is in the archive and what will happen to each part of it — *"34 posts will publish, 5 paid-subscriber-only posts will land as drafts, 3 unpublished posts have no body and will be skipped, 112 images, dated March 2019 to July 2026"* — and takes the one remaining decision, the §VI cover-image checkbox.
3. **Confirm** flips to `running`.
4. **The sweep** works the cursor, one post per step, resumable. The follow-import sweep and its advisory lock are the template.

A one-click "import 200 posts to your live feed" is not on offer. With D4 settled the preview is no longer where the writer *chooses* what happens to their paid work — it is where they are **told**, before anything is written, and that is the whole reason it survives as a step rather than collapsing into the upload.

UI home: a new **Import** tab on `DashboardPanel` (`web/src/components/dashboard/`), sitting alongside Articles/Subscribers/Pricing. It is writer tooling, so it belongs in the writer's dashboard, and the dashboard already renders both as a page and in the overlay.

---

## IX. D8 — HTML → markdown, behind an adapter boundary

Articles are stored and signed as markdown. Substack ships HTML. The conversion is where this feature will be judged: for a writer's own archive, a lossy import is worse than no import.

**Converter:** `unified` + `rehype-parse` → `rehype-remark` → `remark-gfm` → `remark-stringify`. The web already renders the opposite direction on that exact stack (`web/src/lib/markdown.ts`), so it is the house pipeline run backwards rather than a new dependency family. The gateway additionally already has `jsdom`.

**Substack-specific constructs** needing explicit handling before they degrade into soup: `div.captioned-image-container` and `figure`/`figcaption`, footnote anchors, pullquotes, subscribe-button wrappers (drop them — they point at Substack), and tweet and YouTube embeds (down to a bare URL on its own line, which the reader's `enhanceEmbedUrls` already re-inflates). Whatever marks the paywall boundary, if anything does, is **not** handled — under D4 a paid post is carried whole into a draft, boundary and all, and the writer decides where the gate goes when they publish it.

**The adapter boundary.** Everything format-specific — how the archive is unpacked, how metadata is read, which HTML constructs matter — sits in `gateway/src/services/archive-import/adapters/substack.ts` behind an interface returning a normalised `ImportedPost[]`. Ghost and WordPress are then new adapters against a working engine, which is the difference between "later" meaning a week and meaning a rewrite. `feed-ingest/src/adapters/` is the precedent.

**Tolerance is a requirement, not politeness.** The column set differs by export era, so the parser reads columns by name, treats every non-essential one as optional, and reports what it did not recognise rather than failing. `post_id`, `title` and `post_date` are the only genuinely required fields.

---

## X. D9 — Transport and the safety of an uploaded ZIP

Two new dependencies: a streaming unzip (`yauzl` or `unzipper` — streaming, not `adm-zip`, which buffers whole archives) and a real CSV parser (`csv-parse`). Titles and subtitles contain commas and quotes; hand-rolled splitting will corrupt them.

The global multipart limit is 12 MB (`gateway/src/index.ts:122`). An image-less archive of several hundred posts is plausibly 5–50 MB, so this route needs its own raised limit via `req.file({ limits })` — never by raising the global, which governs every avatar and cover upload on the platform.

**This is untrusted input, and the two classic zip attacks both apply.** Reject any entry whose normalised path escapes the archive root (zip-slip); cap total uncompressed bytes and entry count and abort past them (zip-bomb). Only `posts.csv` and `posts/*.html` are read; everything else is ignored by name, which incidentally means the subscriber list is never parsed by this feature.

---

## XI. First build step: get a real archive

Everything in §I is sourced from documentation and second-hand accounts. Each of the following is currently an assumption, and each one is load-bearing:

- The exact `posts.csv` column names, and whether `audience` is spelled as assumed — D4 routes on that column, so a misread value must fail closed to the draft rather than to public (§V).
- **Whether the paid body is in the export at all.** D4 makes this sharper, not softer: the whole point of landing a paid post as a draft is that the writer's work comes with them, and a draft holding only a free preview is a worse outcome than an honest skip. If the body is truncated, the preview must say *"5 paid posts, body not included in the export"* and skip them.
- Whether `post_date` is ISO, and in what timezone.
- Whether unpublished posts really carry no HTML file.
- What the image `<img>` tags actually look like, and whether the CDN serves them without a referer or cookie.

**Ask the launch cohort for one real export before writing the adapter.** One archive from one cooperating writer answers all five in an afternoon and costs nothing; guessing costs a rewrite of the only part of this feature that is hard to test. If none is available, the fallback is a throwaway Substack with three posts (one free, one paid, one unpublished), which answers all five for the price of an hour.

---

## XII. Build order

| Slice | Work | Ships behind |
| --- | --- | --- |
| **0** | Get a real archive; confirm §I; write the fixture into the repo | — |
| **1** | Extract `publishPersonalDraft` → `services/article-publisher.ts`, behaviour-preserving, scheduler calls it. Add the three options (§II) plumbed through all four date sites (§III). Tests pin: a backdated publish lands the original date in `articles` *and* `feed_items` *and* the `published_at` tag while `created_at` stays now; `sendEmail:false` sends nothing. | — |
| **2** | Extract the media core out of `POST /media/upload`; no behaviour change | — |
| **3** | `article_imports` table + sweep + routes, mirroring follow-import. Substack adapter: unzip, CSV, HTML→markdown. Public posts publish; paid posts land as drafts (§V); bodyless rows are counted and skipped. | `ARCHIVE_IMPORT_ENABLED` |
| **4** | Image rehosting phase (§VI) | same |
| **5** | Dashboard Import tab: upload, preview, progress, result | same |
| **6** | Ghost / WordPress adapters | same |

Slices 1 and 2 are pure refactors with no import code in them, and both are worth landing on their own merits.

**D4 collapsed what was slice 5.** Paid-post handling was a phase of its own — the preview choice, the vault call, the publication refusal, and the price/gate lockstep to keep in step with three other validators. It is now an `INSERT INTO article_drafts` inside slice 3. That is the whole saving, and it is the reason this feature is now a week of work rather than the money-path session it was shaping into.

**Brake:** `ARCHIVE_IMPORT_ENABLED`, default off, gating the routes at the gateway — the narrowest shared choke point, so no `NEXT_PUBLIC_*` twin. Needs a `DEPLOYMENT.md` row and a `docker-compose.yml` default.

---

## XIII. Decisions taken (owner, 2026-08-07)

All four questions this pass opened were called the same day. Recorded here so a later reader does not reopen them.

1. **No paywalled import.** The importer never creates a paywalled article; paid posts become drafts (§V). This removes the vault path, the price/gate lockstep and the publication hard-block from the feature entirely.
2. **No email, ever — not even a digest.** §IV stands unqualified: an import notifies nobody. The "I've brought my archive over" announcement was considered and declined; a writer who wants to say that can write a post saying it.
3. **No URL preservation.** Substack `/p/<slug>` permalinks are not redirected and no slug alias table is built. The cohort's existing links keep pointing at Substack.
4. **Bodyless rows are skipped and counted.** Unpublished Substack posts carry no HTML, so nothing is minted for them — no empty `article_drafts` row carrying a bare title. They appear in the preview and the result as a number.

**One call not taken from the owner, flagged here so it can be overturned in a word.** Q1's answer settled that paid posts are not imported *paywalled*; it did not by itself choose between landing them as drafts and dropping them. §V takes drafts. The reasoning: the body has to be converted either way, so the marginal cost over dropping them is a single INSERT, and the failure mode of the alternative is the one this repo's rules keep naming — a writer's best work silently absent, with the import reporting success. If dropping them outright is wanted, §V and slice 3 are a small edit.

The residual question is not a decision but a measurement: **§XI, whether the paid body is in the export at all.** If it is truncated to the free preview, the draft is worth less than an honest skip and §V changes.

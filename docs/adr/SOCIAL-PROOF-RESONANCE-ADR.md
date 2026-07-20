# SOCIAL-PROOF-RESONANCE-ADR

**Status:** Accepted · 2026-07-19 (rev. 2 — corrected against codebase; supersedes 2026-07-17 draft)
**Scope:** `feed-ingest/src/tasks/external-engagement-refresh.ts`,
`feed-ingest/src/tasks/feed-scores-refresh.ts`,
`feed-ingest/src/tasks/engagement-baseline-refresh.ts` (new),
`gateway/src/lib/post-mapper.ts`, `gateway/src/lib/feed-sql.ts`,
`gateway/src/routes/feeds/items.ts`, `web/src/components/post/PostCard.tsx`,
`web/src/lib/post/level-spec.ts`, migration 158
**Relates to:** UNIVERSAL-POST-ADR §5 (hotness) / §6 (native vs. origin counts),
CARD-BEHAVIOUR-ADR (glyph grammar), EXPLAIN-ADR (new card glyph ⇒ new caption)

**Rev. 2 changes:** corrected the Context claim that external counts already
feed ranking (they don't — D6 is net-new, not a swap); native E re-grounded in
its actual source tables (D2a); incremental median folding replaced with daily
recomputation (D3); `ambient_pctl` stored per item and the D6 blend moved to
read time for all item types (D6); shrinkage k 8→3; `post_type` native-only;
`ewma_e` dropped.

**Rev. 2.1 (2026-07-19, pre-ship review):** fixed `articles.writer_id` (the
draft task selected a nonexistent `author_id`); corrected the stale "paid
up-vote" premise — voting is free since F9 — and made the keep-at-5 weight
decision explicit in D2.

## Context

The platform carries five incommensurable social-proof regimes:

| Source | Signals | Character |
|---|---|---|
| Native all.haus | free up/down votes (capped 1/voter/target/direction, F9), gate passes (paid), replies | identity-bound, sparse, strong |
| Nostr | kind-7 reactions, kind-1 replies (dark-flagged count refresh); zaps not ingested | free, niche population |
| Bluesky | like / reply / repost via appview batch | free, large population |
| ActivityPub | like / reply / boost per-status | free, instance-fragmented |
| RSS / email | none | structurally silent |

Raw counts from these regimes are not comparable: different populations,
different cost-per-signal, different bot floors. Any conversion table
("1 like = 0.2 votes") is arbitrary, contestable, Goodhartable, and biases
every mixed surface toward the largest network.

**Current state, corrected:** external engagement counts feed *nothing* in
ranking today. `feed-scores-refresh.ts` scores only native items (via
`feed_engagement`, keyed on `nostr_event_id`); external items carry
`score = 0` on every scored surface, and `like_count` / `reply_count` /
`repost_count` on `external_items` are display-only (`PostCounters`). So this
ADR does not *de-bias* an existing mixed signal — it introduces external
engagement into ranking for the first time. That raises the bar for the
dark-ship verification (Sequencing step 3) rather than lowering it: there is
no incumbent behaviour to fall back on for external items, only chronology.

Separately: the native hotness score is currently reply-only in practice. The
`reaction` / `quote_comment` / `gate_pass` engagement types that
`feed-scores-refresh` weights have no live writer — the only code path that
inserts into `feed_engagement` is `replies.ts`. Votes live in `votes` (paid,
with `cost_pence`), gate passes in `read_events`, and native reposts of native
content are not recorded at all yet (`repost_edges` binds to external targets
only — see `repost-edge.ts` "bind lazily"). D2a below re-grounds native E in
those source tables.

What *is* commensurable across all regimes is a dimensionless quantity:
**response relative to expectation for this author on this network**. A Nostr
writer at 40 reactions against a personal median of 3 is having a larger
moment than a Bluesky account at 400 against a median of 600.
Ratio-to-own-baseline is naturally normalised across protocols and partially
self-defending against purchased engagement (inflating your counts inflates
your baseline).

Two candidate baselines exist — per-author ("a moment for this writer") and
per-network ambient ("big on Nostr right now") — with different politics.
This ADR blends them at three distinct layers rather than averaging their
semantics into one displayed hybrid.

## Decisions

### D1 — The universal idiom is resonance, not magnitude

One stored, displayed, cross-protocol quantity per post: a resonance **band**
derived from response-vs-expectation. Raw origin counts remain untouched and
per-protocol (§6 provenance layer, `PostCounters`). The two layers never
blend in the UI.

### D2 — Within-origin weighted engagement

Per protocol, collapse counts to one scalar `E` with an effort ordering.
Weights live in `platform_config` under a distinct `resonance_*` namespace —
deliberately **not** the `feed_weight_*` hotness keys, so tuning hotness never
silently moves every author's baseline and vice versa. Weights never cross
protocols — they are only ever used to compare a post against its own
network's baseline.

Initial weights: reply 3 · repost 2 · like/reaction 1. Native: up-vote 5,
gate-pass 5, repost 2 (seeded, inert — see D2a). Zaps: reserved weight 4,
inactive until zap ingestion lands (see Open Questions). Down-votes do not
subtract in v1 (a controversial post *is* resonating; valence is a separate
product question).

**Native weight rationale (corrected):** voting has been FREE since F9
(2026-07-06) — the draft's "paid signals weighted heaviest" applied a dead
premise. The explicit v1 decision is to keep up-vote at 5 anyway: a native
vote is identity-bound and hard-capped at one per (voter, target, direction),
so per-account it is scarcer than an external like even without a price.
Gate-pass 5 keeps the genuine paid-signal rationale. If step 3's dark-ship
distributions show native bands running hot, the up-vote weight is the first
dial to turn down (it's `platform_config`, no deploy).

**E is lifetime, not windowed.** External counts are cumulative snapshots;
native E counts all engagement per post for parity. The 48h window belongs to
hotness, not resonance. Consequence: a young post's partial E is compared
against baselines built from near-final Es, so bands **ramp in** over
~24–48h and "surging" fires late rather than early. Accepted for v1 — the
band honestly means "above this author's typical *final* engagement", which
is conservative in the right direction. Age-expectation curves are a possible
v2 refinement, not a v1 requirement.

### D2a — Native E sources

Native E is computed by **union over the source-of-truth tables**, not via
`feed_engagement` mirror rows:

- up-votes: `votes` where `direction = 'up'`
- gate passes: `read_events` where `state <> 'charged_back'`, **including**
  free-allowance reads (a gate pass is an attention signal here; money is
  D8's axis)
- replies: `feed_engagement` where `engagement_type = 'reply'` (its one live
  writer)
- reposts: absent until native-target repost recording lands; the weight is
  seeded so the term activates without a config change

Rationale for union-over-mirror: `votes` and `read_events` are payment-path
tables with reversal states; a mirrored event row can drift (missed code
path, refund, replayed job) and drift here silently corrupts scores. Reading
truth every run costs one fatter query in one cron and nothing in the
payment paths. If engagement types proliferate later, introduce an event log
then, with the union as its backfill source. The vestigial `feed_engagement`
types (`reaction`, `quote_comment`, `gate_pass`) are deprecated, not revived.

### D3 — Author baselines: daily recomputation, not incremental folding

New table (migration 158):

```sql
CREATE TABLE author_engagement_baseline (
  author_ref  TEXT NOT NULL,   -- external_authors.id::text | accounts.id::text
  protocol    TEXT NOT NULL,   -- 'atproto' | 'activitypub' | 'nostr_external' | 'native'
  post_type   TEXT NOT NULL DEFAULT 'all',  -- native: 'note'|'article'; external: 'all'
  median_e    NUMERIC NOT NULL DEFAULT 0,
  n           INT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (author_ref, protocol, post_type)
);
```

Plus `protocol_engagement_ambient (protocol, post_type, p50_e, p90_e,
sample_n, updated_at)`, same task.

**The draft's incremental fold is abandoned.** Two independent defects: a
true median cannot be updated from `(median, n)` alone, and the <7d daily
engagement sweep touches each item ~6 times, so fold-on-batch-write would
multiple-count every post into its author's baseline absent an idempotency
marker. Instead, a new daily task (`engagement-baseline-refresh`, 04:45 UTC,
after the daily engagement sweep) **recomputes** each author's `median_e`
over their last ≤20 posts older than 48h, within a 180-day sample window.
This is idempotent, self-healing after any outage, and delivers the lag
guarantee structurally: only near-final Es enter a baseline, so a surging
post is always measured against the author's *prior* expectation, never
against itself. `ewma_e` is dropped (no consumer). Baselines untouched for
30 days are pruned — a long-silent author decays back to pure-ambient
scoring, which is what they are again.

`post_type` is native-only: external items have no note/article axis in the
data model (`feed_items.item_type` is just `'external'`), so external rows
key on `(author_ref, protocol, 'all')`.

The baseline used for scoring is **shrunk toward ambient** in proportion to
observed history:

```
baseline = (n · median_e + k · ambient_p50) / (n + k)      k = 3
```

(k=3, not the draft's 8: at n=20, k=8 still leaves ambient at ~29% of the
baseline, contradicting the wash-out intent; k=3 gives ~13%.) A new author
(n=0) is judged entirely against network ambient; by ~20 posts the ambient
has substantially washed out. This dissolves cold-start and small-n noise
inside the estimator — no separate confidence flag needed on the band.

### D4 — Resonance score and band gates

```
resonance = log2( (1 + E) / (1 + baseline) )
```

Bands are assigned with the ambient percentile as a **veto, never a boost** —
pure ratios would let 3 replies against a shrunk baseline of 0.4 read as
"surging":

| Band | Requires |
|---|---|
| 0 quiet | default |
| 1 noticed | resonance ≥ `resonance_band1_min` **and** E ≥ ambient p50 |
| 2 resonant | resonance ≥ `resonance_band2_min` **and** E ≥ ambient p50 |
| 3 surging | resonance ≥ `resonance_band3_min` **and** E ≥ ambient p90 |

**Gates are `platform_config`, not constants** (migration 160, from the step-3
measurement below): tuning a band must never need a deploy, for the same reason
the weights don't. Shipped values 2.5 / 4 / 6 — the draft's 1 / 2 / 3 ran 2–3×
hot against this ADR's own targets.

Every band has a two-clause English gloss for the tooltip/Explain caption:
"well above this writer's usual, and non-trivial for Bluesky."

RSS/email: **absence, not zero** — no band computed, no glyph rendered.
A silent protocol must not read as an unpopular writer.

### D5 — Storage and computation

**Three** nullable columns on `feed_items`: `resonance NUMERIC`,
`resonance_band SMALLINT`, `ambient_pctl NUMERIC` (the item's E as a
percentile of its network ambient — stored because the D6 read-time blend
needs it per item; interpolating from p50/p90 at query time is uglier than
one numeric). NULL means "not computed" (rss/email; nostr while dark) and
renders as no glyph — never band-0 styling.

Computed by the existing cron passes, not at read time:

- `external-engagement-refresh` already touches every external count on an
  age-tiered schedule; extend each batch write to recompute
  `resonance` / `resonance_band` / `ambient_pctl` for the touched rows
  (joined through `feed_items.external_item_id` — the author ref and the
  resonance columns live on `feed_items`, the counts on `external_items`).
  Marginal cost ≈ one additional UPDATE per batch. Baseline folding is
  **removed** from this task (D3).
- `feed-scores-refresh` does the same for native items using the D2a union.
- `engagement-baseline-refresh` (new, daily) owns baselines + ambient, and
  doubles as the bootstrap: its first run populates both tables from
  existing stored counts, so distributions are meaningful from day one.

Known staleness, accepted: the refresh crons skip rows whose counts didn't
move, so a static post's band is not recomputed when its author's baseline
or the ambient shifts underneath it. Bands drift back into line the next
time the item's counts change or age it out of relevance.

### D6 — Feed-ranking consumption: read-time blend, uniform across item types

The draft treated D6 as replacing an existing engagement term. Corrected
framing (see Context): for external items this is the **first** ranking
signal; for native items it replaces the cron-baked `fi.score` numerator.
Two consequences drive the design:

1. α is per-feed-surface, but `fi.score` is computed surface-agnostically at
   cron time — so the blend must happen at **read time** in `items.ts`.
2. If native kept cron-baked gravity scores while external got read-time
   proof terms, the two would be in incommensurable units and ordering
   between them meaningless — precisely the disease this ADR exists to cure.

Therefore, when the flag is on, **every** item in scored mode ranks by one
expression, computed in the `scored` CTE from stored columns:

```
proof_term      = α · resonance_norm + (1 − α) · ambient_pctl
resonance_norm  = clamp(resonance, 0, 4) / 4
effective_score = proof_term / power(age_hours + 2, gravity) · weight
```

NULL-band items (rss/email, dark nostr) take `proof_term = 0` and rank on
recency alone within the gravity expression. `α` is a per-feed-surface
constant in `platform_config` (`feed_alpha_following = 0.8`,
`feed_alpha_explore = 0.4` initial). The blend of "moment for this writer"
vs. "big on the network" thereby becomes a per-surface product decision,
tunable post-launch without touching the estimator or bands. `fi.score` and
`feed-scores-refresh`'s gravity write remain untouched as the flag-off
fallback; per-row `power()` over the already-bounded matched set is noise.

### D7 — UI: one glyph, one sentence

A single typographic mark on the card in the existing pip/glyph grammar,
rendered in `palette.cardMeta`: nothing / `·` / `··` / `···` for bands 0–3,
positioned in the byline metadata cluster (exact slot per CARD-BEHAVIOUR-ADR
review). Shown at **feed and thread-focal levels only**; suppressed on
quoted/condensed via the `resolveSpec` matrix — the metadata cluster is
already tight there, and band-at-a-glance matters most where the reader is
deciding whether to read. Plumbing: `resonance_band` flows
`FEED_SELECT` (`feed-sql.ts`) → `post-mapper.ts` → `Post` type → spec matrix.

Interactions:

- Tooltip: the D4 two-clause gloss.
- Explain: one new caption in `web/src/lib/explain/copy.ts`
  (kind `card.resonance`), registered per EXPLAIN-ADR §4.
- Optional (later slice): a workspace feed filter "resonant only"
  (`resonance_band ≥ 2`; partial index ships in 158).

`PostCounters` is untouched.

### D8 — Exclusions

Money signals (tributes, pledges, zap *amounts*) are **not** folded into the
resonance axis. Paid backing is the platform's distinctive signal and gets its
own future axis; averaging it into attention weakens both. No cross-network
leaderboards; no absolute "score" is ever displayed.

## Consequences

- One universal, honest idiom across all protocols; small-network writers are
  legible next to large-network ones without conversion tables.
- External engagement enters ranking for the first time (corrected from the
  draft's "stops being an amplifier" — there was no amplifier). The explore
  feed's composition will change qualitatively, not incrementally; the
  dark-ship distribution check and the D6 A/B are load-bearing, not
  ceremony.
- The native hotness path is repaired as a side effect: D2a scores votes and
  gate passes that the current reply-only `feed_engagement` flow never sees.
- Bands ramp in over ~24–48h for young posts (D2 lifetime-E decision) —
  "surging" is a confirmation, not an early-warning. Accepted for v1.
- Purchased engagement inflates the buyer's own baseline (self-defeating over
  weeks) but can still buy a transient band; the ambient veto caps how cheap
  that is on small networks. Accepted for v1.
- Nostr resonance is gated on `NOSTR_ENGAGEMENT_COUNTS_ENABLED`; until it
  ships light, Nostr cards carry no band (absence semantics, same as RSS) and
  Nostr rows are excluded from baselines/ambient (dark zeros would poison
  both).
- New-author bands are ambient-relative by construction (D3) — a deliberate
  bias toward "non-trivial for the network" until history accrues.
- Two crons gain writes and one daily cron is added; bounded by existing
  per-run budgets.

## Sequencing

1. Migration 158 (two tables, three columns, partial index, `resonance_*` +
   `feed_alpha_*` config) — drafted.
2. `engagement-baseline-refresh` task + cron registration
   (`45 4 * * *`) — drafted. Ships immediately; read-only with respect to
   feed behaviour, and its first run is the bootstrap.
3. Resonance computation in the two refresh crons (D5) — **shipped
   2026-07-20**, `feed-ingest/src/lib/resonance.ts` + migration 160. Dark by
   construction: nothing reads the three columns until steps 4/5. See
   *Step-3 measurement* below.
4. D7 glyph + tooltip + Explain caption + `Post`/mapper/`FEED_SELECT`
   plumbing.
5. D6 read-time blend in `items.ts` behind a feature flag; A/B the explore
   feed.
6. Later: zap ingestion, native repost recording (activates the seeded
   weight), "resonant only" filter, financial-backing axis.

## Test battery

- **Shrinkage:** n=0 author scores against pure ambient; n=20 author is
  ≥87% own-median (k=3).
- **Veto:** E=3 vs. baseline 0.4 never exceeds band 0 when ambient p50 > 3.
- **Lag (structural):** no post <48h old appears in any baseline window; a
  post's own E therefore never contaminates the baseline it is scored
  against while young.
- **Fold idempotency (regression):** running `engagement-baseline-refresh`
  twice consecutively is a no-op on `median_e` and `n`.
- **Absence:** rss/email and dark-flagged nostr rows have NULL
  resonance/band/pctl; card renders no glyph (not band-0 styling); NULL rows
  take proof_term = 0 in D6, ranking on recency.
- **D2a parity:** a native article's E equals
  5·up + 5·(read_events ≠ charged_back) + 3·replies; charged-back reads and
  down-votes contribute 0.
- **Monotonic writes:** partial relay reads never lower a stored Nostr E
  (inherits the existing monotonic-count guarantee).
- **α isolation:** changing `feed_alpha_explore` alters explore ordering
  only; stored resonance/band/pctl unchanged.
- **Unit commensurability:** with the D6 flag on, native and external items
  interleave under one expression; no path consumes `fi.score` for external
  items.

## Step-3 measurement (2026-07-20, dev corpus)

26,719 real Bluesky + Mastodon items scored; 8 native (dev has almost no native
engagement). Targets from Sequencing step 3: band ≥ 1 on ~10–15 %, band 3 on ~1 %.

| | band ≥ 1 (draft gates) | band 3 (draft) | band ≥ 1 (shipped 2.5/4/6) | band 3 (shipped) |
|---|---|---|---|---|
| atproto | 35.1 % | 9.1 % | 15.5 % | 3.2 % |
| activitypub | 30.1 % | 6.0 % | 11.7 % | 1.3 % |

Three findings:

1. **The gates, not the veto, were mis-set.** 66 % of atproto items clear the
   ambient p50 (corpus median E is only 4), so the veto rarely binds; the
   resonance clause does all the work, and observed resonance p85 is already
   ~2.1–2.6. A "≥ 1" gate sat near the 65th percentile. Retuned in migration 160.
2. **Band-3 incidence is protocol-dependent and one global gate cannot land
   both.** At 6.0, activitypub is on target (1.3 %) while atproto is 3×
   (3.2 %); at 8.0 atproto reaches 1.5 % but activitypub band 3 nearly goes
   extinct (0.18 %). Atproto's fatter upper tail traces to a handful of
   very-high-baseline accounts in dev's source mix, so per-protocol gates would
   be over-fitting to dev. Kept global at 6.0; re-measure on prod (new open
   question below).
3. **Absence semantics hold.** All 7,392 `nostr_external` (dark flag) and 230
   `rss` rows scored NULL, as did native items outside the 7-day window;
   `ambient_pctl` was within [0,1] on every scored row.

Not retuned, for want of evidence: the native up-vote weight of 5, which D2
flagged for revisit here. Dev has 8 scored native items and a native-note
ambient of p50 = p90 = 0 — no signal. Deferred to prod volume.

## Open questions

- Zap ingestion (count vs. amount; amount belongs to the future backing axis).
- Whether down-votes should ever dampen native resonance (valence product
  question, deferred).
- Age-expectation curves to un-lag "surging" for young posts (v2 candidate;
  requires per-protocol engagement-accrual profiles — measure from step 3's
  dark data before deciding).
- **Whether band gates need per-protocol values** (step-3 finding 2): one
  global band-3 gate lands ~1 % on activitypub or ~1.5 % on atproto, not both.
  Deliberately deferred rather than fixed — dev's atproto tail may be an
  artifact of its narrow source mix. Re-measure on prod; if the gap persists,
  the fix is per-protocol keys, which is a modest dent in the "resonance is
  already protocol-normalised" claim (the author baseline normalises the
  centre; the spread of author-relative outliers can still differ by network).
- A degenerate ambient (p50 = p90 = 0, e.g. native notes in dev) makes the veto
  vacuous — every band then rests on the resonance gate alone. Correct in
  principle (on a silent corpus any response *is* exceptional) and mitigated by
  the raised gates, but worth re-checking once native volume exists.
- Ambient segmentation finer than protocol (× post_type for native) — e.g.
  follower-count strata — deferred until step 3 distributions say it is
  needed.
- Whether native reposts should write `feed_engagement` or a dedicated table
  when native-target recording lands (D2a union makes either consumable).

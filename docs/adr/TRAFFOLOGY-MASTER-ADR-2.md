# Traffology — Master Architecture Decision Record

**Status:** Active
**Date:** 11 April 2026 (v2)
**Author:** Ed / Claude (design conversation)
**Supersedes:** TRAFFOLOGY-MASTER-ADR-1.md
**Changes in v2:** Added Section 8 (integration with all.haus codebase),
revised Section 8 technical architecture to reflect concrete stack decisions
(Graphile Worker, Postgres-only, no Redis, two new services), added
Charcuterie-influenced design notes to Section 7.

---

## 0. Build priorities

This section governs what to build and in what order.

### Scope

Traffology is being built as an **MVP feature of all.haus**, supplied free to all
all.haus writers. There is no external user onboarding, no standalone frontend,
no multi-tenancy, and no pricing logic in the first build. The page script is
built in, not pasted. Authentication is handled by the platform. Every piece
automatically has a Nostr event ID. All four data channels are available to every
writer from day one.

If the product works and the feedback warrants it, Traffology can later be
separated into an independent product with external integrations. For now it is
a feature with ambitions for independence.

**Portability note:** The data model uses `Writer.platform` as an enum with a
single value (`"allhaus"`). Several of the richest data channels — platform-
internal signals, authenticated subscriber status, automatic Nostr event IDs —
depend on all.haus integration that would not survive extraction unchanged. No
work is being done on portability in this build. The enum is a structural
placeholder, not a promise. If and when external support becomes a priority, it
will require its own design pass to determine which observations are available
without platform integration and what a non-all.haus writer's experience looks
like.

### Build order

**Phase 1 — Foundation (build first)**

1. **Page script and ingest service.** The collection layer that captures
   session data (referrer, geography, device, scroll depth, reading time,
   conversions) and writes to the session store. This is the foundation
   everything else depends on and it starts generating data immediately.

   Study Plausible Analytics' open-source script architecture before building.
   Key decisions: beacon API for data transmission, session deduplication
   without cookies, scroll depth and reading time measurement approach, ingest
   endpoint schema. Target: under 5KB gzipped, no render blocking.

2. **Data model and aggregation.** Implement the core entities (Piece, Writer,
   Session, Source) and the aggregated tables (PieceStats, SourceStats,
   HalfDayBucket, WriterBaseline). The aggregator runs hourly for stats, daily
   for baselines. Some real-time counters (concurrent readers) must be
   maintained outside the aggregation cycle by the ingest service.

3. **Interpretation layer and feed.** Build these together. The interpreter
   reads aggregated data, applies trigger conditions, and produces Observation
   records. The feed renders observations from fixed templates. Building them
   simultaneously allows testing the observation templates, density control,
   and voice against real data. The feed should feel complete and useful with
   page script data alone — arrivals, milestones, anomalies, source breakdowns
   all work before the Nostr or URL search channels exist.

**Phase 2 — Nostr channel**

4. **Nostr monitor service.** Background service polling relays for events
   referencing tracked Nostr event IDs. Self-contained: writes to the event
   store, which the interpreter then reads. Adds propagation chain
   observations, share-without-click-through data, and identity-resolved
   attribution. This is the most distinctive channel and the strongest
   differentiator for all.haus writers.

**Phase 3 — Outbound search and patterns**

5. **Outbound URL search service.** The most complex channel: multiple platform
   APIs (Bluesky AT Protocol, Reddit API, HN Algolia, Mastodon/Fediverse
   aggregators), rate limiting, caching, reactive triggers. Build last because
   it benefits from having real traffic data to detect anomalies against, and
   because the API landscape is the most fragile.

6. **Pattern observations.** Topic, day-of-week, length, and source loyalty
   patterns require enough historical data to be meaningful. These
   observations are low-priority (surfaced on quiet days) and can be added
   once the system has accumulated several weeks of data.

**Phase 4 — Publication layer**

7. **Editor view for Publications.** A metadata lens on top of the existing
   feed: filter observations by publication_id, attach writer attribution
   to each observation, and add publication-level baselines for relative
   performance. This is not a separate architecture — it is the same feed
   with an author column and a publication-scoped WriterBaseline.

### What the editor view requires

The data model already has `publication_id` on Piece and `writer_id` on Writer.
The editor's view is the existing feed filtered to a publication, with:

- Writer name visible on each observation (suppressed in the per-writer feed).
- A summary table aggregating PieceStats per writer.
- A publication-level baseline (`PublicationBaseline`) alongside the existing
  WriterBaseline, enabling observations like: "This piece by [writer] reached
  340 readers — 2.1× the publication average this month."

This is a single additional aggregation, not a new architecture.

---

## 1. What Traffology is

Traffology is a standalone analytics product for writers and publishers. It
shows a writer, for each piece of content they publish, where their readers
came from and how the piece travelled through the open internet. It is
designed to be used by people with no technical knowledge or interest in
analytics. Its first and best-integrated client is all.haus.

Traffology is not a general-purpose web analytics tool. It does not compete
with Google Analytics. It answers one question well: *who sent you these
readers, and when?*

### Positioning

Chartbeat for indie publishers. Real-time, per-piece referral intelligence
with a presentation layer designed for writers, not newsroom ops teams.
Priced for individuals and small publications. Opinionated about design.

### Competitive landscape

**Chartbeat** is the nearest conceptual neighbour. It tracks engaged time,
scroll depth, recirculation, and referral sources in real time for about
60,000 media brands. But it is built for newsroom operations teams (pricing,
interface, feature set all assume an organisation with an audience team), it
is a dashboard product rather than a narrative one, and it has no concept of
outbound discovery — it only sees traffic that arrives.

Chartbeat's own data (March 2026) shows search referral traffic to small
publishers dropped 60% in two years. This is exactly the environment where
provenance intelligence — knowing *who* sent the readers — becomes more
valuable than aggregate traffic counts.

**Substack, Beehiiv, Ghost** offer built-in analytics dashboards showing
subscriber counts, open rates, views, and traffic source categories.
Beehiiv's source tracking is the strongest (engagement by acquisition source).
None of these platforms do outbound URL search, reconstruct propagation
chains, or narrate the results in plain language. They all stop at what
arrives at the door.

**Plausible, Fathom, Simple Analytics** are privacy-first web analytics tools
(lightweight scripts, no cookies, GDPR-compliant). These are potential
building blocks, not rivals. Plausible's open-source page script architecture
(beacon API, IP hashing, sub-1KB) is closely aligned with Traffology's
collection layer spec and should be studied before building.

**BrandMentions, Mention, Awario, Semrush Brand Monitoring** are social
listening tools that crawl the web for brand mentions. They search for
*keywords*, not *URLs*, and are built for marketing teams tracking sentiment
across millions of conversations. The underlying platform APIs (Bluesky AT
Protocol, Reddit API, HN Algolia) are more useful to Traffology than the
tools themselves.

**Nostr ecosystem tools** (nostr.watch, NostrDeck, Nostr WoT Analytics,
RelayGuardian) focus on relay health and individual user analytics. Nothing
exists that tracks the propagation of a specific piece of content across
relays, reconstructs repost chains, and correlates share events with web
traffic. That capability is genuinely novel.

**What no one is doing:** the synthesis across channels. No product combines
page analytics, outbound URL search, Nostr propagation monitoring, and
platform-internal signals into a single provenance view for a single piece
of content, correlates timing across channels to infer attribution, and
narrates the result. That integration layer is Traffology's actual
competitive position.

### Relationship to all.haus

Traffology is built for all.haus and, in this MVP, works only within
all.haus. All.haus writers get the richest possible data: platform-internal
signals, automatic Nostr event creation, built-in page script, and
authenticated subscriber status. Future external users would get a subset —
conventional referral analytics plus outbound URL search — which would still
be better than anything else available at this tier.

---

## 2. Design principles

These govern every decision about what Traffology shows and how it shows it.

**It narrates rather than displays.** The primary interface is a stream of
plain-language observations, not a grid of charts. Numbers support the
narrative; they are not the narrative.

**It rewards attention without punishing inattention.** If you check it
daily, there is always something new. If you don't check it for two weeks,
it catches you up without guilt.

**It makes the invisible visible.** The distinctive value is provenance —
not how many people read something but the specific trail by which they
found it.

**It looks like nothing else in the analytics space.** The visual language
is Bauhaus-derived, consistent with the all.haus design system: solid
colour blocks, thick rules, square geometry, the ∀ mark. No gradients, no
drop shadows, no wispy gridlines.

**It teaches without lecturing.** Over time, using it makes the writer
better at understanding their audience. It never gives advice. The learning
happens through pattern recognition.

**Its voice is templated, not generated.** All observations are produced
from fixed sentence templates with values slotted in. There is no language
model involved. The voice is precise, calm, consistent, and recognisably
mechanical. A thoughtful person wrote the templates; a machine fills in
the values.

---

## 3. Collection layer

Four data channels, each with different characteristics.

### 3.1 Page script

A lightweight JavaScript snippet that runs on every page where the writer's
content lives. Built in for all.haus content.

**Captures on each page load:**

| Signal | Method | Limitations |
|---|---|---|
| Referrer URL | HTTP Referer header | Stripped by many apps, messaging platforms, AI tools, and email clients. Only captures last hop. Growing share of traffic arrives with no referrer. |
| URL parameters | URL parsing (UTM, custom params) | Only present if the link was generated with tracking params. Writers rarely use platform-generated share links. |
| Geography | IP geolocation | Country and city level. Not precise. |
| Device and browser | User agent string | Standard; no significant limitations. |
| Language | Accept-Language header | Indicates browser language, not necessarily reader's language. |
| Subscriber status | Session/auth state | Available on all.haus. Anonymous for external sites without integration. |

**Captures during the session:**

| Signal | Method | Limitations |
|---|---|---|
| Scroll depth | Scroll event listener with throttling | Reliable. Measures how far down the page the reader scrolled. |
| Reading time | Active engagement detection (scroll, click, visibility API) | Distinguishes active reading from background tabs. More meaningful than raw time-on-page. |
| Interaction events | Click listeners on links, subscribe buttons, paywall triggers | Requires instrumentation of the page. Built in for all.haus. |
| Conversion events | Triggered by subscription, upgrade, or custom goal actions | Requires integration with payment/membership system. Native on all.haus. |

**What the page script cannot capture:**

- Shares that don't result in a click (no visibility into distribution)
- The chain of shares that preceded the click (only the last hop)
- Anything about the reader's identity unless they are logged in
- Traffic from sources that strip referrer headers (shows as "direct")

**Implementation notes:**

- The script must be as small as possible. Target: under 5KB gzipped.
- It should not block page rendering or affect load performance.
- Data is sent via beacon API (navigator.sendBeacon) on page unload and
  at intervals during the session.
- First-party data collection only. No third-party cookies. No cross-site
  tracking. No fingerprinting.
- The script sends data to a Traffology ingest endpoint, not to any third
  party.

### 3.2 Nostr event monitoring

A background service that monitors Nostr relays for events referencing the
content's Nostr event ID. Automatic for all.haus content.

**Captures:**

| Signal | Method | Limitations |
|---|---|---|
| Reposts (kind 6) | Relay subscription filtered by referenced event ID | Depends on which relays are monitored. Some reposts may be missed. |
| Reactions (kind 7) | Relay subscription filtered by referenced event ID | Same relay coverage limitation. |
| Quotes and replies | Relay subscription filtered by referenced event ID | Same. |
| Sharer identity | Public key (npub) resolved to profile (display name, bio, follower count, website) | Profile resolution depends on relay availability. Some keys have no profile. |
| Propagation chain | Following the chain of reposts (A reposts original, B reposts A's repost) | Can reconstruct multi-hop propagation trees. |
| Relay distribution | Recording which relays each event appears on | Indicates which corners of the Nostr ecosystem the piece is reaching. |
| Timestamps | Event created_at field | Signed and reasonably reliable, though relay clocks may vary. |

**What Nostr monitoring gives you that the page script cannot:**

- Share events that generate no click-throughs
- The social graph of propagation (who shared, who reshared)
- Identity of sharers (resolved from public keys)
- Distribution breadth independent of traffic

**Implementation notes:**

- Polling interval: approximately 5 minutes when a piece is new (first 48
  hours), 15 minutes for the first week, hourly thereafter.
- Monitor a configurable set of relays. Start with the major public relays
  and expand based on where all.haus content is actually appearing.
- Store raw Nostr events for replay and reprocessing.
- Correlate Nostr shares with page script arrivals by matching timestamps
  and inferring causation (share event at time T, click-throughs arriving
  shortly after T from Nostr-associated referrers or with no referrer).

### 3.3 Outbound URL search

An active search service that looks for the writer's URLs on public
platforms. Triggered on a schedule and reactively when the interpretation
layer detects unexplained traffic patterns.

**Principle:** What is private should stay private. What is published on
the open internet is fair game to find and use for attribution.

**Platforms and methods:**

| Platform | Method | Data available |
|---|---|---|
| Bluesky | AT Protocol API, search by URL | Post author, text, timestamp, likes, reposts, replies |
| Mastodon / Fediverse | Per-instance search API and aggregators | Post author, text, timestamp, boosts, favourites |
| Reddit | Reddit API, search by URL in submissions and comments | Author, subreddit, score, comment count, timestamp |
| Hacker News | Algolia HN API, search by URL | Author, title, points, comment count, timestamp |
| Nostr | Already covered by channel 3.2 | — |
| Threads | Not currently feasible (no public search API) | — |
| Twitter/X | Limited. Third-party search services may provide partial coverage. | Variable and unreliable. |

**Trigger conditions:**

- **Scheduled:** Every 10 minutes for the first 48 hours after publication,
  hourly for the first week, daily thereafter.
- **Reactive:** When the interpretation layer detects a traffic anomaly —
  a cluster of readers arriving in a short window with no referrer or with
  a referrer that doesn't explain the volume.

**Attribution logic:**

When a public post containing the writer's URL is found, and the timing
correlates with an observed traffic pattern (e.g. unexplained arrivals
within a plausible window after the post), the system infers a likely
attribution. This inference is presented honestly:

> Your link was found in a public post on Bluesky by @someone, posted three
> hours ago. 40 readers arrived around that time with no other source —
> likely from this post.

The word "likely" is used because the correlation is not proof. The system
does not claim certainty for inferred attributions.

**What outbound URL search gives you:**

- Attribution for traffic from platforms that strip referrer headers
- Context about the post that sent traffic (who posted it, what they said,
  how much engagement it got)
- Discovery of public mentions that generated no traffic at all (the piece
  was posted but nobody clicked — still interesting to the writer)
- Direct links to the posts/threads for the writer to follow up

**Implementation notes:**

- Rate-limit API calls per platform to avoid hitting quotas.
- Cache search results to avoid redundant queries.
- Store found posts with their metadata for historical analysis.
- Do not scrape or circumvent API restrictions. Only use public,
  documented APIs and search endpoints.
- Accept that Twitter/X coverage will be incomplete and do not over-promise.

### 3.4 Platform-internal signals (all.haus only)

When both the referring writer and the destination writer are on all.haus,
the platform knows both sides of the transaction. This is the richest
attribution data available.

**Captures:**

| Signal | Method | Limitations |
|---|---|---|
| Inbound attribution | Platform knows which all.haus piece linked to this piece, and who wrote it | Only works within the all.haus ecosystem |
| Outbound tracking | Platform knows which links in the piece were clicked, and where readers went next | Same |
| Recirculation | Readers who finish one piece and navigate to another on all.haus | Same |
| Writer identity | Full profile resolution — name, publication, subscriber count | Same |
| Subscriber-to-subscriber | Whether the arriving reader is a subscriber of the referring writer | Same |

**What platform-internal signals give you:**

- Full identity resolution: not just "a link on all.haus" but "a link in
  [piece title] by [writer name] on [publication name]"
- Bidirectional tracking: the writer can see both who sends them traffic
  and where their readers go next
- Social signalling: "this piece sent you 340 readers this week" becomes
  a visible relationship between writers on the platform
- Cross-publication analytics for Publications: editors can see how traffic
  flows between writers in their publication

---

## 4. Data model

### 4.1 Core entities

**Piece** — a single piece of published content.

| Field | Type | Notes |
|---|---|---|
| piece_id | UUID | Internal identifier |
| external_url | URL | The canonical URL of the piece |
| title | String | |
| writer_id | UUID | Foreign key to Writer |
| publication_id | UUID | Nullable. Foreign key to Publication (all.haus only) |
| published_at | Timestamp | |
| word_count | Integer | |
| nostr_event_id | String | Nullable. The Nostr event ID if one exists |
| tags | String[] | Writer-assigned tags or topics |

**Writer** — a person who publishes content.

| Field | Type | Notes |
|---|---|---|
| writer_id | UUID | |
| platform | Enum | "allhaus" (only value in MVP) |
| site_domain | String | The writer's site domain |
| baseline_first_day_readers | Float | Rolling mean, updated daily |
| baseline_reading_time | Float | Rolling mean, updated daily |
| baseline_open_rate | Float | Trailing 20-send average |
| last_feed_open | Timestamp | When the writer last opened the feed |

**Session** — a single reader's visit to a single piece.

| Field | Type | Notes |
|---|---|---|
| session_id | UUID | |
| piece_id | UUID | |
| started_at | Timestamp | |
| referrer_url | URL | Nullable. Raw HTTP Referer |
| referrer_domain | String | Nullable. Extracted domain |
| resolved_source_id | UUID | Nullable. Foreign key to Source, assigned by interpretation layer |
| utm_source | String | Nullable |
| utm_medium | String | Nullable |
| utm_campaign | String | Nullable |
| country | String | ISO country code |
| city | String | Nullable |
| device_type | Enum | "desktop", "mobile", "tablet" |
| subscriber_status | Enum | "anonymous", "free", "paying" |
| scroll_depth | Float | 0.0 to 1.0. Updated during session |
| reading_time_seconds | Integer | Active engagement time. Updated during session |
| is_bounce | Boolean | True if scroll_depth < 0.1 and reading_time < 15s |

**Source** — a resolved origin of traffic.

| Field | Type | Notes |
|---|---|---|
| source_id | UUID | |
| writer_id | UUID | The writer this source sends traffic to |
| source_type | Enum | "mailing-list", "search", "link", "nostr", "direct", "platform-internal" |
| domain | String | Nullable. For link sources |
| display_name | String | Human-readable name. E.g. "Littoral Drift", "Google search", "@jmcee" |
| nostr_npub | String | Nullable. For Nostr sources |
| allhaus_writer_id | UUID | Nullable. For platform-internal sources |
| first_seen_at | Timestamp | When this source first sent traffic to this writer |
| is_new_for_writer | Boolean | True if first_seen_at is within the last 30 days |

**Design note on Source:** The `display_name` field requires a
resolution/enrichment step that maps raw referrer domains to human-readable
names. For Nostr sources, resolution comes from profile lookup. For
platform-internal sources, resolution comes from the all.haus writer
profile. For referrer-only sources, the domain is used as a fallback (e.g.
"theoverspill.com"), with writers able to override display names manually
in a future iteration.

**Source display_name enrichment pipeline:**

The enrichment step runs when a new Source record is created. It attempts
resolution in the following order:

1. **Platform-internal:** If the referrer is an all.haus URL, resolve to
   the writer's display name and piece title. Always succeeds.
2. **Nostr:** If the source is a Nostr share, resolve the npub to a
   profile display name via relay lookup. Falls back to the truncated npub.
3. **Known platform domains:** A curated lookup table maps common domains
   to human-readable names (e.g. "google.com" → "Google search",
   "news.ycombinator.com" → "Hacker News", "bsky.app" → "Bluesky").
4. **Opaque shortener domains:** For t.co, bit.ly, and similar shorteners,
   the system attempts a single HEAD request to follow the redirect and
   recover the destination domain, then resolves that domain via step 3 or
   5. If the redirect fails or times out, the shortener domain is mapped to
   its known platform where unambiguous (t.co → "a link via Twitter/X") or
   stored as-is with a flag for manual review.
5. **Raw domain fallback:** If no resolution succeeds, the domain itself is
   used as the display name (e.g. "theoverspill.com"). This is an honest
   outcome, not a failure — most domains are recognisable to the writer
   even without enrichment.

The lookup table (step 3) is a static file shipped with the application,
covering the ~200 most common referrer domains. It should be reviewed
quarterly. Writers cannot edit it directly in the MVP, but manual
display_name overrides are a natural future addition.

**NostrEvent** — a Nostr event referencing a piece.

| Field | Type | Notes |
|---|---|---|
| event_id | String | Nostr event ID |
| piece_id | UUID | The piece being referenced |
| event_kind | Integer | 1, 6, 7, etc. |
| author_npub | String | Public key of the event author |
| author_display_name | String | Nullable. Resolved from profile |
| parent_event_id | String | Nullable. For reposts/quotes, the event being reposted |
| relay | String | The relay where this event was found |
| created_at | Timestamp | Event timestamp |
| attributed_sessions | Integer | Number of sessions likely caused by this event |

**PublicMention** — a public post on an external platform containing the piece's URL.

| Field | Type | Notes |
|---|---|---|
| mention_id | UUID | |
| piece_id | UUID | |
| platform | Enum | "bluesky", "mastodon", "reddit", "hackernews", "twitter", "other" |
| post_url | URL | Direct link to the post |
| author_handle | String | |
| author_display_name | String | Nullable |
| post_text | String | The text of the post (or a truncation) |
| posted_at | Timestamp | |
| engagement_count | Integer | Likes + reposts/boosts/points, platform-dependent |
| comment_count | Integer | Nullable |
| attributed_sessions | Integer | Number of sessions likely caused by this mention |
| attribution_confidence | Enum | "direct" (referrer matched), "inferred" (timing correlation), "found" (mention found but no correlated traffic) |

### 4.2 Aggregated tables (materialised, updated periodically)

**PieceStats** — per-piece summary, updated hourly.

| Field | Type |
|---|---|
| piece_id | UUID |
| total_readers | Integer |
| readers_today | Integer |
| first_day_readers | Integer |
| unique_countries | Integer |
| avg_reading_time_seconds | Integer |
| avg_scroll_depth | Float |
| open_rate | Float (for emailed pieces) |
| rank_this_year | Integer |
| rank_all_time | Integer |
| top_source_id | UUID |
| top_source_pct | Float |
| free_conversions | Integer |
| paid_conversions | Integer |
| last_reader_at | Timestamp |

**SourceStats** — per-source-per-piece summary, updated hourly.

| Field | Type |
|---|---|
| piece_id | UUID |
| source_id | UUID |
| reader_count | Integer |
| pct_of_total | Float |
| first_reader_at | Timestamp |
| last_reader_at | Timestamp |
| avg_reading_time_seconds | Integer |
| avg_scroll_depth | Float |
| bounce_rate | Float |

**HalfDayBucket** — traffic volume per source per 12-hour period, used to
render the provenance bar stripes.

| Field | Type | Notes |
|---|---|---|
| piece_id | UUID | |
| source_id | UUID | |
| bucket_start | Timestamp | Always 06:00 or 18:00 in the piece's timezone |
| is_day | Boolean | True for 06:00–18:00, false for 18:00–06:00 |
| reader_count | Integer | Number of sessions starting in this bucket |

This table directly powers the op-art bar rendering. Each row becomes a
stripe (colour) or a gap (void). The stripe's width is proportional to
reader_count relative to the source's total. Buckets are returned in
reverse chronological order (newest first = left edge of bar).

**WriterBaseline** — rolling baselines per writer, updated daily.

| Field | Type |
|---|---|
| writer_id | UUID |
| mean_first_day_readers | Float |
| stddev_first_day_readers | Float |
| mean_reading_time | Float |
| mean_open_rate | Float |
| mean_piece_lifespan_days | Float |
| total_free_subscribers | Integer |
| total_paying_subscribers | Integer |
| monthly_revenue | Decimal |

**PublicationBaseline** — rolling baselines per publication, updated daily.

| Field | Type |
|---|---|
| publication_id | UUID |
| mean_first_day_readers | Float |
| stddev_first_day_readers | Float |
| mean_reading_time | Float |
| mean_open_rate | Float |
| writer_count | Integer |
| total_readers_this_month | Integer |

**TopicPerformance** — per-topic aggregates, updated weekly.

| Field | Type |
|---|---|
| writer_id | UUID |
| topic | String |
| piece_count | Integer |
| mean_readers | Float |
| mean_reading_time | Float |
| mean_search_readers | Float |

---

## 5. Interpretation layer

The interpretation layer reads from the data model and produces structured
**observations** — typed records with values that the presentation layer
renders as templated sentences.

### 5.1 Observation record

Every observation has:

| Field | Type | Notes |
|---|---|---|
| observation_id | UUID | |
| writer_id | UUID | |
| piece_id | UUID | Nullable. Some observations are publication-level |
| observation_type | Enum | See taxonomy below |
| created_at | Timestamp | When the observation was generated |
| priority | Integer | 1 (highest) to 5 (lowest). Used for feed density control |
| values | JSON | The specific values to slot into the template |
| suppressed | Boolean | True if a similar observation was generated within the suppression window |

### 5.2 Observation taxonomy

Directly maps to the template categories in the observation templates
section of this document.

| Type code | Category | Trigger | Priority | Suppression window |
|---|---|---|---|---|
| ARRIVAL_CURRENT | Arrivals | On feed open, if concurrent readers > 0 | 4 | 2 hours or >50% change |
| ARRIVAL_NONE | Arrivals | On feed open, if concurrent readers = 0 | 4 | 4 hours |
| SOURCE_NEW | Sources | New source_id created for this writer | 2 | None (always show) |
| SOURCE_FAMILIAR | Sources | Known source sends > 1.5× its mean | 2 | 24 hours |
| SOURCE_BREAKDOWN | Sources | End of piece's first calendar day | 4 | None (once per piece) |
| SOURCE_SHIFT | Sources | Top source for a piece changes | 2 | 48 hours |
| NOSTR_SHARES | Sources | Nostr events found referencing piece | 2 | 6 hours |
| NOSTR_CHAIN | Sources | Multi-hop propagation chain detected | 2 | 12 hours |
| MENTION_FOUND | Sources | PublicMention found via outbound URL search | 2 | None (always show) |
| MENTION_NO_TRAFFIC | Sources | PublicMention found but no correlated traffic | 3 | None (always show) |
| SOURCE_UNATTRIBUTED | Sources | Direct/unattributed traffic exceeds threshold for a piece | 4 | 7 days per piece |
| FIRST_DAY_SUMMARY | Summaries | End of piece's first calendar day | 1 | None (once per piece) |
| MILESTONE_READERS | Milestones | Piece crosses reader threshold (100, 500, 1k, 5k, 10k) | 3 | None (once per threshold) |
| MILESTONE_SUBSCRIBERS | Milestones | Subscriber count crosses threshold | 3 | None (once per threshold) |
| MILESTONE_GEO | Milestones | Piece read in a new country for this writer | 3 | 24 hours |
| MILESTONE_LONGEVITY | Milestones | Piece still active beyond threshold days (7, 14, 30, 60, 90) | 3 | None (once per threshold) |
| PATTERN_TOPIC | Patterns | Topic cluster identified with > 1.5× baseline, min 3 pieces | 5 | 30 days |
| PATTERN_DAY | Patterns | Day-of-week pattern identified, min 4 data points per day | 5 | 30 days |
| PATTERN_LENGTH | Patterns | Length-performance correlation identified | 5 | 30 days |
| PATTERN_SOURCE_LOYALTY | Patterns | External source has sent traffic to 3+ pieces | 5 | 30 days |
| ANOMALY_HIGH | Anomalies | First-day readers > 2× writer's mean | 1 | None (once per piece) |
| ANOMALY_LOW | Anomalies | First-day readers < 0.5× writer's mean | 1 | None (once per piece) |
| ANOMALY_LATE_SPIKE | Anomalies | Piece quiet > 7 days, then > 20 readers in a day | 1 | 24 hours |
| ANOMALY_READING_TIME | Anomalies | Reading time > 1.5× or < 0.5× writer's mean | 1 | 48 hours per piece |
| ANOMALY_SCROLL_DEPTH | Anomalies | Scroll depth > 1.5× or < 0.5× writer's mean | 1 | 48 hours per piece |
| ANOMALY_OPEN_RATE | Anomalies | Open rate deviates > 15pp from trailing 20-send mean | 1 | None (once per piece) |
| SUBSCRIBER_NEW | Subscribers | New free or paying subscriber | 4 | 12 hours (batched) |
| SUBSCRIBER_LOST | Subscribers | Paying subscriber cancelled | 4 | 12 hours (batched) |
| SUBSCRIBER_CONVERSION | Subscribers | Piece identified as top converter | 3 | 7 days |
| SUBSCRIBER_REVENUE | Subscribers | End of calendar month | 3 | None (once per month) |
| CATCHUP | Catch-up | Writer opens feed after > 48 hours absence | 1 | None (once per return) |
| SYSTEM_DEGRADED | System | A data channel is delayed or unavailable | 4 | 6 hours per channel |

### 5.3 Feed density control

Target observation density per day:

| Condition | Observations per day |
|---|---|
| Publication day (day 0) | 3–5 |
| Day 1 | 2–4 |
| Days 2–7 | 1–2 |
| Quiet period (no new publication) | 0–1, never more than one consecutive day with zero |

When multiple observations are generated in the same period, the feed
shows them in priority order (1 = highest). Observations with priority 5
(Patterns) are only surfaced on quiet days when no higher-priority
observations are available.

**Quiet-period promotion:** During quiet periods, pattern observations are
promoted to fill the feed. This is the only time patterns appear.

### 5.4 Inference engine for outbound URL search

When the outbound URL search finds a PublicMention, the system attempts to
correlate it with observed traffic:

1. Find all sessions for the piece that started within a plausible window
   after the mention's posted_at (0 to 6 hours).
2. Of those sessions, filter to those with no referrer or a referrer
   matching the mention's platform domain.
3. If the count exceeds a threshold, attribute those sessions to the
   mention with confidence "inferred". The threshold scales with the
   writer's baseline: `max(3, writer's mean_first_day_readers × 0.02)`,
   floored at 3 sessions to avoid false positives for very small writers,
   but never so high that a meaningful signal is ignored for large ones.
   These are initial values and should be revised once real data is
   available.
4. If the mention's platform domain matches the session referrer directly,
   attribute with confidence "direct".
5. If no correlated traffic is found, store the mention with confidence
   "found" — it's still interesting to the writer even without
   click-throughs.

### 5.5 Real-time counters

The ingest service must maintain real-time counters for concurrent readers
(per piece and total) outside the hourly aggregation cycle. These counters
power the ARRIVAL_CURRENT and ARRIVAL_NONE observations, which trigger on
feed open. Implementation options: in-memory counters with a sliding window
(e.g. sessions active in the last 5 minutes), or a lightweight pub/sub
mechanism.

**Reconciliation with aggregated data:** The real-time counters and the
hourly aggregation are independent measurements. The feed shows live
counters for concurrent-reader observations (ARRIVAL_CURRENT, ARRIVAL_NONE)
and hourly-aggregated figures for everything else (total readers, source
breakdowns, baselines). The two will occasionally disagree within an
aggregation cycle; this is expected and not surfaced to the writer. The
hourly aggregation reads from the same session store that the real-time
counters track, so they converge after each aggregation run.

---

## 6. Observation templates

### 6.1 Voice and usage rules

The feed is a reverse-chronological stream of observations about a writer's
content and publication. Every observation is generated from a template.
There is no language model involved. The voice is precise, calm, and
consistent. It reads as if a thoughtful person designed the sentences and a
machine is filling in the values.

### 6.2 Word list (preferred terms)

Use only these words for the concepts they describe. Do not substitute synonyms.

| Concept | Use | Never use |
|---|---|---|
| A person who reads a piece | reader | visitor, user, view, session, hit |
| A piece of writing | piece | article, post, story, content, entry |
| The act of reading | read | viewed, visited, consumed, engaged with |
| Arriving at a piece | found, arrived | landed, hit, drove traffic to |
| A source of readers | source | channel, referrer, medium, vector |
| Appeared for the first time | new source | new referrer, new channel, emerged |
| A writer's typical number | usual | average, normal, typical, benchmark |
| More than usual | higher than usual | above average, outperforming |
| Fewer than usual | lower than usual | below average, underperforming |
| A person who subscribes free | free subscriber | follower, free member |
| A person who pays | paying subscriber | paid member, customer, patron |
| The mailing list | your mailing list | your newsletter, your email list |
| A link on another site | a link | a backlink, an inbound link |
| The Nostr protocol | Nostr | the Nostr network, the protocol |
| Sharing on Nostr | reposted, quoted | boosted, reshared, amplified |
| Time spent reading | reading time | engaged time, dwell time, time on page |
| How far down | scroll depth | scroll percentage, completion rate |
| Traffic with no referrer | direct visit | organic, unattributed, unknown source, dark traffic |
| Inferred attribution | likely from this [post/share] | probably, we think, it seems |

### 6.3 Temporal anchors

Every observation begins with a temporal anchor. Use these forms only:

- **Right now** — for live/real-time observations
- **In the last hour** — for very recent events
- **This morning / This afternoon / This evening** — for same-day events
- **Today** — for same-day summaries
- **Yesterday** — for previous-day events
- **This week** — for current-week summaries
- **Last week** — for previous-week summaries
- **[N] days ago** — for specific recent events beyond yesterday
- **In [Month]** — for monthly summaries
- **Since [date or event]** — for cumulative observations

Never use precise timestamps (e.g. "at 14:32") in the feed. The drill-down
view may show precise times; the feed does not.

### 6.4 Formatting rules

- Piece titles are always italicised: *The Disappearing Coast*
- Numbers below 10 are written as words in running text: "three readers"
- Numbers of 10 and above are written as numerals: "48 readers"
- Percentages are always numerals with the symbol: "62%"
- External sources are named plainly: "a Ghost blog called *Littoral Drift*"
- Domains are written as-is when no name is available: "from theoverspill.com"
- Nostr accounts are referenced by display name if available, npub if not
- No exclamation marks. No emoji. No questions addressed to the writer.
- No advice, suggestions, or calls to action. Observations only.

### 6.5 Conditional clauses

Many templates have optional clauses that attach when a condition is true.
These are shown in square brackets with the condition in parentheses.

Example:
> *The Disappearing Coast* has now been read 500 times[, which makes it your
> most-read piece this year]. ← appended when rank = 1 for current year

When no condition is met, the sentence ends without the clause. Do not
substitute a different clause or add filler.

---

### Template 1: ARRIVALS

Real-time and near-real-time observations about current readership.

**Data required:** concurrent reader count per piece, total concurrent readers,
referrer of current session, reader geography (country), subscriber status of
current reader (free, paying, anonymous).

---

#### 1.1 Current readers (single piece)

**Type code:** ARRIVAL_CURRENT
**Trigger:** Writer views a piece that has active readers.

**Template:**
> [N] [readers/person] reading *[title]* right now.

**Examples:**
> 3 people reading *The Disappearing Coast* right now.
> 24 readers reading *Salt and Stone* right now.

---

#### 1.2 Current readers (all pieces)

**Type code:** ARRIVAL_CURRENT
**Trigger:** Writer opens the feed and has active readers across multiple pieces.

**Template:**
> [N] [readers/people] on your site right now, across [M] pieces.
> [Most are reading *[title]*.] ← (when one piece has >50% of concurrents)

**Examples:**
> 12 people on your site right now, across four pieces.
> 31 readers on your site right now, across six pieces. Most are reading
> *The Disappearing Coast*.

---

#### 1.3 No current readers

**Type code:** ARRIVAL_NONE
**Trigger:** Writer opens the feed and there are zero concurrent readers.

**Template:**
> No one reading right now. [Your last reader was [duration] ago.]

**Examples:**
> No one reading right now. Your last reader was 40 minutes ago.
> No one reading right now. Your last reader was yesterday.

Note: do not hide this or replace it with something else. Honesty about quiet
periods is essential to trust.

---

### Template 2: SOURCES

Observations about where readers came from.

**Data required:** HTTP referrer (domain and, where available, full path),
resolved source name (e.g. platform name, publication name), first-seen flag
for source, reader count per source per piece, reader count per source
across all pieces, Nostr event data (repost/quote events referencing the
piece's event ID, authoring npub, relay).

---

#### 2.1 New source detected

**Type code:** SOURCE_NEW
**Trigger:** Readers arrive from a domain or Nostr account that has never
previously sent traffic to this writer.

**Template:**
> A new source appeared — [source description] has sent [N] readers to
> *[title]* [since time].

**Examples:**
> A new source appeared — a Ghost blog called *Littoral Drift* has sent
> 18 readers to *The Disappearing Coast* since this morning.
> A new source appeared — theoverspill.com has sent four readers to
> *Salt and Stone* since yesterday.
> A new source appeared — a Nostr account (@jmcee) has sent three readers
> to *The Disappearing Coast* in the last hour.

---

#### 2.2 Familiar source activity

**Type code:** SOURCE_FAMILIAR
**Trigger:** A previously seen source sends a notable number of readers
(above that source's usual contribution).

**Template:**
> [Source description] sent [N] readers to *[title]* [time period].
> [That's higher than usual from this source.] ← (when > 1.5× the source's
> mean contribution)

**Examples:**
> Google search sent 42 readers to *Salt and Stone* yesterday. That's
> higher than usual from this source.
> Your mailing list sent 180 readers to *The Disappearing Coast* today.

---

#### 2.3 Source breakdown (first-day summary)

**Type code:** SOURCE_BREAKDOWN
**Trigger:** End of a piece's first calendar day.

**Template:**
> First-day readers of *[title]* came from: your mailing list ([N]%),
> direct visits ([N]%)[, [source] ([N]%)][, and other sources ([N]%)].

**Example:**
> First-day readers of *The Disappearing Coast* came from: your mailing
> list (78%), direct visits (14%), and other sources (8%).

Note: list a maximum of four named sources plus "other sources." Always
list mailing list first if it is the largest.

---

#### 2.4 Source shift

**Type code:** SOURCE_SHIFT
**Trigger:** The largest source of readers for a piece changes from one
source to another.

**Template:**
> The main source of readers for *[title]* has shifted from [source A]
> to [source B]. [Source B] now accounts for [N]% of all readers.

**Example:**
> The main source of readers for *Salt and Stone* has shifted from your
> mailing list to Google search. Google search now accounts for 54% of
> all readers.

---

#### 2.5 Nostr propagation (no click-through yet)

**Type code:** NOSTR_SHARES
**Trigger:** The piece's Nostr event has been reposted or quoted, but
no click-through traffic has been detected from those shares.

**Template:**
> *[title]* has been [reposted/quoted] by [N] accounts on Nostr.
> No readers have arrived from these shares yet.

**Example:**
> *The Disappearing Coast* has been reposted by seven accounts on Nostr.
> No readers have arrived from these shares yet.

---

#### 2.6 Nostr propagation (with click-through)

**Type code:** NOSTR_SHARES
**Trigger:** Readers have arrived via Nostr share links and Nostr
propagation data is available.

**Template:**
> *[title]* has been reposted by [N] accounts on Nostr. [M] readers
> have arrived from these shares[, most of them via [display name or npub]].

**Example:**
> *The Disappearing Coast* has been reposted by 12 accounts on Nostr.
> 34 readers have arrived from these shares, most of them via @jmcee.

---

#### 2.7 Nostr propagation chain

**Type code:** NOSTR_CHAIN
**Trigger:** A multi-hop propagation chain is detected (A reposts original,
B reposts A's repost, generating traffic at each hop).

**Template:**
> *[title]* is travelling on Nostr. [Name A] reposted it, then [Name B]
> reposted [Name A]'s share. [N] readers arrived from this chain.

**Example:**
> *The Disappearing Coast* is travelling on Nostr. @jmcee reposted it,
> then @primal reposted @jmcee's share. 52 readers arrived from this chain.

---

#### 2.8 Public mention found (with correlated traffic)

**Type code:** MENTION_FOUND
**Trigger:** The outbound URL search finds a public post containing the
piece's URL, and correlated traffic is detected within the attribution
window.

**Template:**
> Your link was found in a public post on [platform] by [author handle],
> posted [time]. [N] readers arrived around that time with no other
> source — likely from this post.

**Example:**
> Your link was found in a public post on Bluesky by @someone, posted
> three hours ago. 40 readers arrived around that time with no other
> source — likely from this post.

---

#### 2.9 Public mention found (no correlated traffic)

**Type code:** MENTION_NO_TRAFFIC
**Trigger:** The outbound URL search finds a public post containing the
piece's URL, but no correlated traffic is detected.

**Template:**
> Your link was found in a public post on [platform] by [author handle],
> posted [time]. No readers have arrived from it yet.

**Example:**
> Your link was found in a public post on Reddit by u/someone in
> r/architecture, posted yesterday. No readers have arrived from it yet.

---

#### 2.10 Unattributed traffic

**Type code:** SOURCE_UNATTRIBUTED
**Trigger:** More than 40% of a piece's readers arrived as direct visits
(no referrer, no UTM, no inferred attribution) and the piece has at least
50 total readers.

**Template:**
> [N]% of readers who found *[title]* arrived as direct visits — no
> referrer, no link we could trace. [That's higher than usual for you.]
> ← (when > writer's mean direct-visit share + 10pp)

**Examples:**
> 48% of readers who found *The Disappearing Coast* arrived as direct
> visits — no referrer, no link we could trace.
> 52% of readers who found *Salt and Stone* arrived as direct visits —
> no referrer, no link we could trace. That's higher than usual for you.

Note: direct visits include readers arriving via private shares (DMs, email
forwards, messaging apps), bookmarks, and any source that strips the HTTP
referrer header. This proportion is growing across the web and is not a
failure of the system — it reflects a genuine limit on what any analytics
tool can see. The template states the fact without apology or anxiety.

---

### Template 3: SUMMARIES

End-of-day synthesis observations.

---

#### 3.1 First-day summary

**Type code:** FIRST_DAY_SUMMARY
**Trigger:** End of a piece's first calendar day.

**Template:**
> *[title]* had [N] readers on its first day[, [higher/lower] than usual].
> [Top source] sent the most ([M]%).

**Examples:**
> *The Disappearing Coast* had 680 readers on its first day, higher than
> usual. Your mailing list sent the most (78%).
> *Salt and Stone* had 45 readers on its first day, lower than usual.
> Your mailing list sent the most (82%).

Note: this observation always appears. The comparison to "usual" uses the
writer's mean_first_day_readers baseline. If the piece is within 0.75× to
1.25× of the baseline, omit the comparison clause.

---

### Template 4: MILESTONES

Calm acknowledgements of notable moments.

**Data required:** cumulative reader count per piece, rank of piece by
readers (this year, all time), subscriber counts (free, paying), revenue
figures, unique countries reached.

---

#### 4.1 Reader count milestone

**Type code:** MILESTONE_READERS
**Trigger:** A piece passes a round-number threshold (100, 500, 1000, 5000,
10000, etc.).

**Template:**
> *[title]* has now been read [N] times[, which makes it your [ordinal]
> most-read piece [this year / of all time]].

**Examples:**
> *The Disappearing Coast* has now been read 500 times, which makes it
> your most-read piece this year.
> *Salt and Stone* has now been read 1,000 times.

Note: only attach the ranking clause when the rank is 1st, 2nd, or 3rd.
For other ranks, omit it.

---

#### 4.2 Subscriber milestone

**Type code:** MILESTONE_SUBSCRIBERS
**Trigger:** Total subscriber count (free or paying) passes a round-number
threshold.

**Template:**
> You now have [N] [free/paying] subscribers[, up from [M] [time period]].

**Examples:**
> You now have 100 free subscribers, up from 72 last month.
> You now have 50 paying subscribers.

---

#### 4.3 Geographic milestone

**Type code:** MILESTONE_GEO
**Trigger:** A piece is read in a country from which the writer has never
previously had readers.

**Template:**
> *[title]* has been read in [country] — that's a first for you.

**Example:**
> *The Disappearing Coast* has been read in South Korea — that's a first
> for you.

---

#### 4.4 Longevity milestone

**Type code:** MILESTONE_LONGEVITY
**Trigger:** A piece continues to receive meaningful daily traffic
(>5 readers/day) beyond a threshold number of days after publication
(7, 14, 30, 60, 90).

**Template:**
> *[title]* is still drawing readers [N] days after publication —
> [M] readers in the last week. Most of your pieces go quiet after
> [typical lifespan].

**Example:**
> *Salt and Stone* is still drawing readers 30 days after publication —
> 48 readers in the last week. Most of your pieces go quiet after
> about a week.

---

### Template 5: PATTERNS

Reflective observations drawn from the writer's history. Surfaced only
during quiet periods when no higher-priority observations are available.

**Data required:** per-piece performance metrics over time (readers, sources,
reading time, scroll depth, subscriber conversions), publication-day and
publication-time metadata, piece length (word count), piece tags/topics,
cumulative source data across all pieces.

---

#### 5.1 Topic pattern

**Type code:** PATTERN_TOPIC
**Trigger:** The system identifies that pieces on a particular topic
consistently perform above or below the writer's baseline, with a minimum
of three pieces in the cluster.

**Template:**
> Your pieces about [topic] tend to find more readers than your other work.
> Your [N] pieces on this topic have been read [M] times on average,
> compared to [P] for everything else.

**Example:**
> Your pieces about architecture tend to find more readers than your
> other work. Your four pieces on this topic have been read 620 times
> on average, compared to 280 for everything else.

Note: only surface this pattern when the difference is at least 1.5×.
Never phrase it as advice.

---

#### 5.2 Day-of-week pattern

**Type code:** PATTERN_DAY
**Trigger:** The system identifies a consistent performance difference by
publication day, with a minimum of four data points per day being compared.

**Template:**
> Pieces you publish on [day] tend to get [higher/lower] first-day
> readership than pieces published on other days. [Day] pieces average
> [N] first-day readers; your overall average is [M].

**Example:**
> Pieces you publish on Tuesday tend to get higher first-day readership
> than pieces published on other days. Tuesday pieces average 310
> first-day readers; your overall average is 220.

---

#### 5.3 Length pattern

**Type code:** PATTERN_LENGTH
**Trigger:** The system identifies a consistent relationship between piece
length and a performance metric.

**Template:**
> Your longer pieces (over [N] words) tend to get [more/less] [metric]
> than your shorter ones. [Longer: average M] [Shorter: average P].

**Example:**
> Your longer pieces (over 2,000 words) tend to get more search traffic
> than your shorter ones. Longer pieces average 85 search readers;
> shorter pieces average 22.

---

#### 5.4 Source loyalty pattern

**Type code:** PATTERN_SOURCE_LOYALTY
**Trigger:** The system identifies that a particular external source has
sent readers to multiple pieces over time.

**Template:**
> [Source] has now sent readers to [N] of your pieces over the last
> [time period]. They've sent [M] readers in total.

**Example:**
> theoverspill.com has now sent readers to five of your pieces over the
> last three months. They've sent 126 readers in total.

---

### Template 6: ANOMALIES

Observations about things that deviate from the writer's baseline.

**Data required:** all data from Arrivals and Sources, plus historical
baselines (mean and standard deviation) for: first-day readers, readers per
day at day N, reading time, scroll depth, bounce rate from each source
category, mailing list open rate.

---

#### 6.1 Unusually high first-day performance

**Type code:** ANOMALY_HIGH
**Trigger:** A piece's first-day readership exceeds the writer's mean
first-day readership by more than 2×.

**Template:**
> *[title]* had [N] readers on its first day. Your usual first-day
> readership is around [M].

**Example:**
> *The Disappearing Coast* had 680 readers on its first day. Your usual
> first-day readership is around 220.

---

#### 6.2 Unusually low first-day performance

**Type code:** ANOMALY_LOW
**Trigger:** A piece's first-day readership is below 50% of the writer's
mean first-day readership.

**Template:**
> *[title]* had [N] readers on its first day. Your usual first-day
> readership is around [M].

**Example:**
> *Salt and Stone* had 45 readers on its first day. Your usual first-day
> readership is around 220.

Note: the template is identical to 6.1. The data speaks for itself. No
softening, no consolation, no explanation.

---

#### 6.3 Late traffic spike

**Type code:** ANOMALY_LATE_SPIKE
**Trigger:** A piece that has been quiet (below 5 readers/day) for at least
seven days suddenly receives a spike (>20 readers in a single day).

**Template:**
> *[title]*, published [N] days ago, is getting traffic again — [M]
> readers [today/yesterday][, mostly from [source]].

**Example:**
> *Salt and Stone*, published 42 days ago, is getting traffic again —
> 38 readers today, mostly from a link on reddit.com.

---

#### 6.4 Unusual reading time

**Type code:** ANOMALY_READING_TIME
**Trigger:** A piece's average reading time is more than 1.5× or less
than 0.5× the writer's baseline.

**Template:**
> Readers are spending [more/less] time on *[title]* than usual.
> Average reading time is [N] minutes; your usual is around [M] minutes.

**Example:**
> Readers are spending more time on *The Disappearing Coast* than usual.
> Average reading time is 8 minutes; your usual is around 4 minutes.

---

#### 6.5 Unusual scroll depth

**Type code:** ANOMALY_SCROLL_DEPTH
**Trigger:** A piece's average scroll depth is more than 1.5× or less
than 0.5× the writer's baseline.

**Template:**
> Readers are scrolling [further/less far] through *[title]* than usual.
> Average scroll depth is [N]%; your usual is around [M]%.

**Example:**
> Readers are scrolling less far through *Salt and Stone* than usual.
> Average scroll depth is 38%; your usual is around 72%.

Note: high scroll depth with low reading time suggests skimming. Low scroll
depth with high reading time suggests readers are re-reading or stuck. The
template does not interpret this — the writer will recognise the pattern
over time.

Scroll depth is confounded by piece length: a 500-word piece will have
near-universal high scroll depth regardless of engagement quality. The
writer's baseline for this metric should be calculated per length bucket
(short: <1,000 words, medium: 1,000–3,000, long: >3,000) rather than as
a single mean across all pieces. The anomaly trigger compares a piece's
scroll depth against the baseline for its length bucket.

---

#### 6.6 Unusual mailing list open rate

**Type code:** ANOMALY_OPEN_RATE
**Trigger:** A piece's email open rate deviates from the writer's trailing
20-send average by more than 15 percentage points.

**Template:**
> Your mailing list opened *[title]* at [N]%[, which is [higher/lower]
> than usual for you]. Your usual open rate is around [M]%.

**Example:**
> Your mailing list opened *The Disappearing Coast* at 62%, which is
> higher than usual for you. Your usual open rate is around 45%.

---

### Template 7: SUBSCRIBERS

Observations about the writer's subscriber base and conversions.

**Data required:** free subscriber count, paying subscriber count, new/lost
subscribers per day, subscriber source (which piece or page they subscribed
from), conversion events (free to paid), churn events (cancellation),
revenue per period.

---

#### 7.1 New subscribers

**Type code:** SUBSCRIBER_NEW
**Trigger:** One or more new free or paying subscribers in the last 24 hours.

**Template:**
> [N] new [free/paying] [subscriber/subscribers] [today/yesterday].
> [Most signed up from *[title]*.] ← (when >50% from a single piece)

**Examples:**
> 3 new free subscribers today. Most signed up from *The Disappearing Coast*.
> 1 new paying subscriber yesterday.

---

#### 7.2 Subscriber loss

**Type code:** SUBSCRIBER_LOST
**Trigger:** One or more paying subscribers cancelled in the last 24 hours.

**Template:**
> [N] paying [subscriber/subscribers] cancelled [today/yesterday].
> You now have [M] paying subscribers.

**Example:**
> 1 paying subscriber cancelled yesterday. You now have 47 paying subscribers.

Note: no softening. No "don't worry." State the fact and the current total.

---

#### 7.3 Conversion observation

**Type code:** SUBSCRIBER_CONVERSION
**Trigger:** The system identifies that a particular piece has driven a
disproportionate share of free-to-paid conversions.

**Template:**
> *[title]* has been the last free piece read before subscribing for [N]
> of your paying subscribers. No other piece has converted more.

**Example:**
> *Salt and Stone* has been the last free piece read before subscribing
> for 8 of your paying subscribers. No other piece has converted more.

---

#### 7.4 Revenue summary

**Type code:** SUBSCRIBER_REVENUE
**Trigger:** End of calendar month.

**Template:**
> In [month], your paying subscribers generated [currency][amount] in
> revenue. [That's [up/down] from [currency][amount] in [previous month].]

**Example:**
> In March, your paying subscribers generated £236 in revenue. That's up
> from £198 in February.

---

### Template 8: CATCH-UP

Observations for writers who haven't checked the feed recently.

**Data required:** last-seen timestamp for the writer, all observations
generated since that timestamp, summary metrics for the intervening period.

---

#### 8.1 Returning after short absence (2–14 days)

**Type code:** CATCHUP
**Trigger:** Writer opens the feed for the first time in more than 48 hours
but fewer than 14 days.

**Template:**
> Since you last checked [N] days ago: [total readers] readers across
> [M] pieces. [Top observation from the intervening period.]

**Examples:**
> Since you last checked three days ago: 482 readers across two pieces.
> A new source appeared — *Littoral Drift* sent 63 readers to
> *The Disappearing Coast*.
> Since you last checked 11 days ago: 1,204 readers across four pieces.
> Your piece *Salt and Stone* passed 1,000 total readers.

Note: the catch-up observation appears once at the top of the feed,
followed by the regular feed items from the intervening period. It is a
summary, not a replacement.

---

#### 8.2 Returning after long absence (14+ days)

**Type code:** CATCHUP
**Trigger:** Writer opens the feed for the first time in more than 14 days.

**Template:**
> Since you last checked [N] days ago: [total readers] readers across
> [M] pieces. [Top three observations from the intervening period,
> each on a new line.]

**Example:**
> Since you last checked 32 days ago: 3,840 readers across six pieces.
> A new source appeared — Google search sent 220 readers to *Salt and Stone*.
> Your piece *The Disappearing Coast* passed 5,000 total readers.
> 14 new free subscribers signed up, mostly from *Salt and Stone*.

Note: the long-absence variant includes up to three highlights rather than
one. Select the three highest-priority observations from the intervening
period, deduplicated by category.

---

### Template 9: SYSTEM

Observations about the system's own data coverage.

---

#### 9.1 Data channel degraded

**Type code:** SYSTEM_DEGRADED
**Trigger:** A data channel has been unable to update within its expected
cycle (e.g. Nostr monitor has not completed a poll in > 30 minutes, URL
searcher has not completed a cycle in > 2 hours, aggregator has not run
in > 90 minutes).

**Template:**
> [Channel] data is delayed — last updated [duration] ago.

**Examples:**
> Nostr data is delayed — last updated 3 hours ago.
> Outbound search data is delayed — last updated 6 hours ago.

Note: this observation appears inline in the feed, not as a banner or
alert. It is subject to the same voice rules as every other observation:
no alarm, no apology, no exclamation marks. The writer sees it, registers
that some data may be stale, and moves on. Suppressed after the channel
recovers.

---

## 7. Presentation layer

### 7.1 Three screens

**The Feed** — reverse-chronological stream of observations. The default
view. Each observation is rendered from a fixed template with values slotted
in. Observations are interleaved across all pieces and all categories. No
filtering by default; optional filtering available.

**The Piece** — the life of a single piece. Accessed by tapping a piece
title in the feed.

Top: summary strip with four values (Readers, Rank, Top source,
Conversions).

Middle: provenance diagram — horizontal bars, one per source, sorted by
reader count descending. Each bar is rendered as alternating stripes of
IKB blue (#002FA7) and background (#FAFAFA). Blue stripes represent
daytime traffic (06:00–18:00). Gaps represent night-time. Stripe width is
proportional to traffic volume in that half-day period, not to clock time.
Newest traffic at the left edge; oldest at the right. Hovering or sliding
a thumb along a bar shows the corresponding date in a readout, which
updates live — speeding through dates when the stripes are compressed
(quiet periods) and slowing when they are wide (heavy traffic).

**Edge cases:** A minimum stripe width of 2px prevents quiet periods from
compressing to invisibility — the diagram should always communicate that
traffic existed, even if the volume was small. For pieces with heavily
front-loaded traffic (a large spike on day one, then a trickle), the
date readout provides the temporal context that the stripe widths alone
cannot. For pieces with only one source (common when mailing list
dominates), the diagram renders a single bar; this is informative enough
when read alongside the summary strip above it, which names the source
and its share. No special treatment is needed — a single solid bar is
an honest representation of a single-source piece.

Below: filtered feed showing only observations about this piece.

Behind: raw data tables (referrer list, readers per day, geography,
open/click rates) for writers who want to drill in. Accessible but never
the default view.

**The Overview** — publication-level trends. The slow, reflective view.
A narrative summary at the top, followed by a dense grid of piece tiles
(see 7.4 below) and trend charts in the all.haus design idiom (heavy
bars, solid fills, no gradients).

### 7.2 Design language

Consistent with all.haus identity (ALLHAUS-DESIGN.md):

- Typeface: Jost for UI, system monospace for data labels where appropriate
- Colour: IKB blue (#002FA7) for data visualisation. #1A1A1A for text and
  structural rules. #FAFAFA for background. Crimson strictly functional
  (errors, cancellations).
- Geometry: square inputs, solid black nav and footer beams, no hairlines,
  4px minimum rule weight.
- No gradients, no drop shadows, no rounded corners on data elements.
- "New" source badge: outlined in IKB, uppercase, 8px.

### 7.3 Voice

All observation text is generated from fixed templates. No language model
is involved. See the observation templates section of this document for
the complete template file, word list, formatting rules, and density rules.

Key constraints:
- Constrained vocabulary (see word list)
- No exclamation marks, no emoji, no questions to the writer
- No advice, suggestions, or calls to action
- Identical templates for good and bad news (the data speaks for itself)
- Conditional clauses attached when conditions are met, omitted otherwise
- Inferred attributions use "likely" language

### 7.4 Density and navigability (Charcuterie influence)

**Reference:** charcuterie.elastiq.ch (David Aerne, 2026) — a visual
Unicode explorer that organises glyphs in a dense, navigable grid where
clicking any element reorients the surrounding landscape around it.
Spatial navigation is the primary interaction model; the data is the
interface. Relevant design cues for Traffology:

**Provenance diagram as entry point.** The provenance diagram (stacked
source bars with half-day bucket stripes) should be interactive and
navigable, not a static illustration. Clicking a source segment in the
bar pivots the view to show: all pieces that source has sent traffic to,
the source's history with this writer, and the timing pattern of its
contributions. The source becomes a node the writer can explore around,
not just a coloured stripe to read. This is the same traversal-as-
exploration quality that makes Charcuterie compelling — you learn about
the data by moving through it.

**The Overview grid.** The Overview screen uses a dense grid of piece
tiles, each rendered as a miniature provenance bar (the same half-day
bucket stripes, compressed to thumbnail scale). The grid is sortable
(by date, by total readers, by source diversity) and filterable. At a
glance, the writer sees which pieces have varied source palettes vs.
single-source dominance, which have long tails vs. sharp spikes, just
from the colour patterns in the miniature bars. Clicking a tile expands
it into the full Piece screen. The grid itself is the trend visualisation
— no separate chart is needed to communicate the shape of the writer's
output over time.

**Formal consistency enables density.** Charcuterie achieves legibility
at high density because every element follows the same formal rules
(same size, same weight, same rendering). The Traffology equivalent: every
observation card in the feed, every miniature provenance bar in the
Overview grid, and every source segment in the Piece diagram must follow
identical formal rules — same type size, same colour vocabulary, same
geometry. Density is only legible when the elements are predictable.

**Immediacy.** Charcuterie runs entirely in the browser with no loading
states between interactions. Traffology cannot fully replicate this (data
lives server-side), but the provenance diagram and real-time counters
should update without visible loading spinners. The in-memory concurrent-
reader counters in traffology-ingest (Section 8.4) support this: the
feed opens and the live count is there immediately. Transitions between
states in the provenance diagram should feel continuous, not paged.

**What not to take from Charcuterie.** The spotlight/traversal UI that
confused some users on Hacker News — the implicit spatial metaphor
without visible affordances — is a risk. Traffology's navigation should
be explicit: tappable source labels, clear back-navigation, visible
sort/filter controls on the Overview grid. The density and formal
consistency are the transferable ideas. The implicit spatial model is not.

---

## 8. Technical architecture

### 8.0 Integration with all.haus codebase

Traffology is built as an MVP feature of all.haus and its architecture
follows the established patterns of the platform-pub monorepo. The key
decisions in this section are grounded in what already exists.

**The existing stack (platform-pub):**

```
┌─────────────────────────────────────────────────────┐
│  Web Client (Next.js + NDK)                         │
│  ├── Reading experience + paywall gate UI           │
│  ├── Article editor (TipTap + draggable gate)       │
│  ├── Social feed (Following + For You)              │
│  └── Editorial dashboard                            │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  API Gateway (Fastify)                     port 3000│
│  ├── Session management (JWT + httpOnly cookies)    │
│  ├── Auth (magic link, Google OAuth)                │
│  ├── Article management, comments, media, search    │
│  ├── Stripe Connect + card onboarding               │
│  └── Proxy to internal services                     │
└───────┬─────────────────────────┬───────────────────┘
        │                         │
┌───────▼──────────┐    ┌────────▼─────────┐
│ Payment Service  │    │ Key Service      │
│         port 3001│    │        port 3002 │
└──────────────────┘    └──────────────────┘
        │                         │
┌───────▼─────────────────────────▼───────────────────┐
│  PostgreSQL (shared database)                       │
└─────────────────────────────────────────────────────┘
        │
┌───────▼─────────────────────────┐
│  strfry (Nostr relay)  port 4848│
└─────────────────────────────────┘
        │
┌───────▼─────────────────────────┐
│  Blossom (media)       port 3003│
└─────────────────────────────────┘
```

All services are TypeScript. Docker Compose orchestrates infrastructure.
Nginx handles reverse proxying with TLS. PostgreSQL is the only database.
There is no Redis anywhere in the stack.

**Architectural principles for Traffology's integration:**

1. **Follow the service pattern.** Each concern in platform-pub gets its
   own service sharing the same Postgres database. Traffology adds two
   new services (ingest and worker), not a monolith.

2. **No new infrastructure dependencies.** The existing stack runs
   Postgres, strfry, and Blossom. Traffology does not introduce Redis
   or any other new infrastructure. This is a deliberate decision: at
   launch-cohort scale (20–30 writers), Postgres handles every workload
   Traffology requires, including job queuing and real-time counters.
   If scale later demands it, Redis can be introduced in a future pass.

3. **Extend the existing schema.** Traffology tables live in the same
   Postgres instance, namespaced in a `traffology` schema. Foreign keys
   reference the existing `accounts` and `articles` tables where
   appropriate. Migrations use the existing runner
   (`shared/src/db/migrate.ts`).

4. **Reuse existing Nostr infrastructure.** The key-service already
   uses `nostr-tools` for keypair management and NIP-44 encryption.
   The web client uses NDK. The Nostr monitor reuses these libraries
   for relay subscriptions, not a separate protocol integration.

5. **Surface Traffology through the existing gateway.** The feed API
   is a new route namespace (`/traffology/*`) on the existing Fastify
   gateway. The frontend is new pages/components within the existing
   Next.js web client. No separate HTTP service for reads.

### 8.1 Components

**With all.haus integration:**

```
┌─────────────────────────────────────────────────────┐
│  Web Client (Next.js + NDK)                         │
│  ├── [existing] Reading, editor, dashboard, feed    │
│  ├── [new] Traffology Feed page                     │
│  ├── [new] Traffology Piece page                    │
│  ├── [new] Traffology Overview page                 │
│  └── [new] Page script (inline, <5KB gzipped)       │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  API Gateway (Fastify)                     port 3000│
│  ├── [existing] Auth, articles, comments, media     │
│  └── [new] /traffology/* routes (feed, piece, stats)│
└───────┬─────────┬───────────┬───────────────────────┘
        │         │           │
┌───────▼───┐ ┌───▼─────┐ ┌──▼──────────────┐ ┌─────────────────┐
│ Payment   │ │ Key     │ │ Traffology      │ │ Traffology      │
│ Service   │ │ Service │ │ Ingest          │ │ Worker          │
│ port 3001 │ │ port 3002│ │ port 3004      │ │ (no HTTP port)  │
└───────────┘ └─────────┘ └────────────────┘ └─────────────────┘
        │         │           │                   │
┌───────▼─────────▼───────────▼───────────────────▼───┐
│  PostgreSQL                                         │
│  ├── public schema (existing 18 tables)             │
│  └── traffology schema (new tables)                 │
└─────────────────────────────────────────────────────┘
```

| Component | Service | Role | Notes |
|---|---|---|---|
| Page script | Web client (inline) | Client-side JS, collects session data, sends to ingest endpoint via beacon API | < 5KB gzipped. First-party only. Injected by Next.js on every article page. No separate script tag to paste. |
| Ingest service | traffology-ingest (port 3004) | Receives beacon data, writes to session store, maintains real-time concurrent-reader counters | Fastify. Append-only writes. Real-time counters held in-memory with Postgres fallback (see 8.4). |
| Nostr monitor | traffology-worker (job type) | Polls external relays for events referencing tracked Nostr event IDs | Uses nostr-tools (already in monorepo). Configurable relay list. Variable polling interval. |
| URL searcher | traffology-worker (job type) | Queries public platform APIs for tracked URLs | One Graphile Worker queue per platform. Per-platform rate limiting. Scheduled + reactive triggers. |
| Aggregator | traffology-worker (job type) | Periodic job materialising PieceStats, SourceStats, HalfDayBucket, WriterBaseline, PublicationBaseline, TopicPerformance | Cron-scheduled: hourly for stats, daily for baselines, weekly for patterns. |
| Interpreter | traffology-worker (job type) | Reads aggregated data, applies trigger conditions, produces Observation records | Runs after each aggregation cycle and on reactive triggers. |
| Feed API | Gateway (new routes) | Serves observations and piece data to the frontend | Paginated, filtered by writer, piece, publication, or type. New route namespace `/traffology/*` on existing Fastify gateway. |
| Frontend | Web client (new pages) | Next.js pages rendering the Feed, Piece, and Overview screens | New pages within the existing Next.js app. No separate frontend. |

### 8.2 Job queuing and background work

**Decision: Graphile Worker (Postgres-backed), not BullMQ/Redis.**

The all.haus stack has no Redis. Introducing Redis solely for Traffology's
job queue would add a new infrastructure dependency, a new Docker service,
and a new failure mode. At launch-cohort scale (20–30 writers, perhaps
a few thousand readers per day), Postgres handles the job queuing workload
comfortably.

**Graphile Worker** is a Postgres-backed job queue for Node.js. It
provides:

- Cron-scheduled jobs (hourly/daily/weekly aggregation cycles)
- One-off jobs with priority and retry (reactive URL search triggers)
- Concurrency limiting per task type (per-platform rate limits)
- Transactional job creation (the interpreter can enqueue a URL search
  job in the same transaction that writes an anomaly observation)
- LISTEN/NOTIFY for near-instant job pickup (not pure polling)

**Job types registered with Graphile Worker:**

| Job type | Schedule | Concurrency | Notes |
|---|---|---|---|
| `nostr_poll` | Cron: every 5 min (new pieces), 15 min (first week), hourly (thereafter) | 1 | Polls configured relays. Writes to `traffology.nostr_events`. |
| `url_search_bluesky` | Cron: every 10 min (first 48h), hourly (first week), daily | 1 | AT Protocol API. Rate limit: ~300 req/min. |
| `url_search_reddit` | Same schedule | 1 | Reddit API. Rate limit: 60 req/min with OAuth. Most restrictive. |
| `url_search_hn` | Same schedule | 1 | Algolia HN API. Rate limit: generous (~10k req/hr). |
| `url_search_mastodon` | Same schedule | 1 | Per-instance APIs + aggregators. Rate limits vary. |
| `url_search_reactive` | On demand (enqueued by interpreter) | 4 (1 per platform) | Triggered when interpreter detects unexplained traffic anomaly. Higher priority than scheduled searches. |
| `aggregate_hourly` | Cron: every hour | 1 | Materialises PieceStats, SourceStats, HalfDayBucket. |
| `aggregate_daily` | Cron: daily at 04:00 UTC | 1 | Materialises WriterBaseline, PublicationBaseline. |
| `aggregate_weekly` | Cron: weekly (Monday 05:00 UTC) | 1 | Materialises TopicPerformance. |
| `interpret` | After each aggregation + on reactive triggers | 1 | Reads aggregated data, applies trigger conditions, writes Observations. |
| `source_enrich` | On demand (new Source record created) | 2 | Runs the five-step display_name enrichment pipeline. |

**Rate-limit management:**

At MVP scale, per-platform rate limiting is implemented as a simple
approach within each job handler: track the timestamp of the last API
call and sleep if the interval is too short. This is adequate when
concurrency per platform is 1. If Traffology later scales to support
external users with much higher API call volumes, a proper token-bucket
or sliding-window implementation can be added — either in-process or
via a lightweight Postgres counter table.

The key architectural benefit of per-platform job types is **failure
isolation**: if Reddit's API goes down or rate-limits aggressively, only
`url_search_reddit` jobs back off. Bluesky and HN searches continue
normally. The `SYSTEM_DEGRADED` observation type surfaces this to the
writer in the feed.

**Scaling note:** Graphile Worker polls Postgres using LISTEN/NOTIFY
with a 200ms fallback. At launch scale this is negligible. If Traffology
later supports thousands of writers and tens of thousands of pieces,
the job queue may need to migrate to BullMQ with Redis. That migration
would affect only the traffology-worker service — the job handler code
and the rest of the architecture remain unchanged. No work on this
migration is planned or needed now.

### 8.3 Data stores

All data lives in the existing PostgreSQL instance. Traffology tables
are namespaced in a `traffology` schema to keep them separate from the
existing `public` schema (18 tables: accounts, articles, follows,
sessions, etc.).

**Schema integration points:**

| Traffology entity | Relationship to existing schema |
|---|---|
| Piece | Foreign key to `public.articles(id)`. A thin `traffology.pieces` view or table adds Traffology-specific fields (tags, word_count if not present on articles). The `nostr_event_id` is already on `public.articles`. |
| Writer | Foreign key to `public.accounts(id)` where `is_writer = TRUE`. WriterBaseline references `accounts.id` directly. |
| Publication | Foreign key to any future `public.publications` table (per the Publications feature design). Nullable until Publications ship. |
| Session | New table: `traffology.sessions`. No foreign key to `public.sessions` (different concept — platform sessions vs. reader visit sessions). |
| Source, NostrEvent, PublicMention, Observation | New tables in `traffology` schema with no dependencies on existing tables beyond `accounts.id` and `articles.id`. |
| Aggregated tables | New tables in `traffology` schema. Overwritten on each aggregation cycle. |

**Data store characteristics:**

| Store | Tables | Characteristics |
|---|---|---|
| Session store | `traffology.sessions` | High write volume (relative to other Traffology tables), append-only, time-partitioned. Retention: 13 months. Consider Postgres table partitioning by month if write volume warrants it. |
| Event store | `traffology.nostr_events`, `traffology.public_mentions` | Moderate write volume. Permanent retention. |
| Aggregation store | `traffology.piece_stats`, `traffology.source_stats`, `traffology.half_day_buckets`, `traffology.writer_baselines`, `traffology.publication_baselines`, `traffology.topic_performance` | Moderate volume. Overwritten on each aggregation cycle. |
| Observation store | `traffology.observations` | Low volume. Permanent retention. |
| Job queue | `graphile_worker.*` | Managed by Graphile Worker. Automatic cleanup of completed jobs. |

**Migrations:** Added to the existing migration sequence via
`shared/src/db/migrate.ts`. Traffology migrations create the
`traffology` schema and all tables within it. They do not modify
existing tables in the `public` schema.

### 8.4 Real-time counters without Redis

The concurrent-reader count (powering ARRIVAL_CURRENT and ARRIVAL_NONE
observations) requires real-time data outside the hourly aggregation
cycle. Without Redis, two approaches are available:

**Primary approach (MVP): in-memory state within traffology-ingest.**

The ingest service receives every beacon. It maintains a
`Map<piece_id, Set<session_token>>` with a 5-minute sliding window.
Sessions that have not sent a beacon within 5 minutes are expired.
The gateway queries the ingest service via an internal HTTP endpoint
(`GET traffology-ingest:3004/concurrent/:piece_id`) when the feed
API needs the live count.

This is single-process state. If the ingest service restarts, the
counters rebuild within 5 minutes as new beacons arrive. At launch
scale (20–30 writers, a few hundred concurrent readers at peak),
this is adequate and adds zero infrastructure.

**Fallback approach (if needed): Postgres heartbeat table.**

A `traffology.active_sessions` table, upserted by the ingest service
on each beacon, with a cleanup job deleting rows older than 5 minutes.
The feed API queries this directly. Postgres handles this volume
easily — a few hundred rows at peak. This approach survives ingest
service restarts without a rebuild window but adds write load to
Postgres on every beacon.

**Decision:** Start with in-memory. Move to the Postgres heartbeat
table only if operational experience shows the 5-minute rebuild window
after restarts is a problem.

**Reconciliation with aggregated data:** The real-time counters and
the hourly aggregation are independent measurements. The feed shows
live counters for concurrent-reader observations and hourly-aggregated
figures for everything else. The two may briefly disagree within an
aggregation cycle; this is expected and not surfaced to the writer.
They converge after each aggregation run.

### 8.5 Docker Compose integration

Two new services added to `docker-compose.yml`, following the existing
pattern:

```yaml
traffology-ingest:
  build:
    context: .
    dockerfile: traffology-ingest/Dockerfile
  ports:
    - "3004:3004"
  depends_on:
    - postgres
  environment:
    - DATABASE_URL=${DATABASE_URL}
  restart: unless-stopped

traffology-worker:
  build:
    context: .
    dockerfile: traffology-worker/Dockerfile
  depends_on:
    - postgres
  environment:
    - DATABASE_URL=${DATABASE_URL}
  restart: unless-stopped
```

The traffology-worker has no HTTP port — it is a pure background
process. It connects to Postgres for job queuing (Graphile Worker)
and to external APIs (Nostr relays, Bluesky, Reddit, HN, Mastodon)
for outbound data collection.

The nginx configuration gains a new location block proxying
`/traffology-ingest/*` to the ingest service for beacon data
reception. The gateway's `/traffology/*` routes are proxied via
the existing gateway location block.

### 8.6 Nostr monitor implementation

The Nostr monitor reuses libraries already in the monorepo:

- **nostr-tools** (used by key-service for keypair generation,
  NIP-44 encryption, event signing) — provides relay connection,
  subscription filters, and event parsing.
- **NDK** (used by the web client) — an alternative if a higher-level
  abstraction is preferred for relay management. NDK handles
  reconnection, relay scoring, and deduplication.

The monitor subscribes to external relays (not just the platform's
strfry instance) for events referencing tracked `nostr_event_id`
values. Subscription filters use NIP-01 `#e` tag filters to
efficiently find reposts (kind 6), reactions (kind 7), and quotes
(kind 1 with `q` tags).

**Relay list:** Start with the major public relays
(relay.damus.io, relay.nostr.band, nos.lol, relay.snort.social)
and expand based on where all.haus content actually appears. The
list is configurable via environment variable.

**Polling schedule:** Implemented as Graphile Worker cron jobs with
different intervals based on piece age. The `nostr_poll` job checks
piece age and adjusts its own re-enqueue interval accordingly:
~5 minutes for pieces under 48 hours old, ~15 minutes for pieces
under 7 days old, hourly thereafter.

### 8.7 Privacy

- No third-party cookies. No cross-site tracking. No fingerprinting.
- IP addresses used for geolocation only, not stored in raw form.
- Session records are keyed to piece and writer, not to individual readers.
- No personally identifiable information is collected about readers unless
  they are logged in to all.haus.
- Nostr data is public by definition. Outbound URL search only finds
  public posts. What is private stays private; what is published is found
  and used.

---

## 9. Data dependencies summary

Every template implies a data query. The interpretation layer must be able
to answer these questions:

| Question | Updates |
|---|---|
| How many concurrent readers on each piece? | Real-time (ingest service counters) |
| What is the HTTP referrer for each current session? | Real-time |
| What country is each reader in? | Real-time |
| Is this reader a free subscriber, paying subscriber, or anonymous? | Real-time |
| How many total readers has each piece had? | Hourly |
| What is the referrer breakdown for each piece? | Hourly |
| Has this referrer domain been seen before for this writer? | On each new session |
| What is this writer's mean first-day readership? | Daily |
| What is this writer's mean reading time per piece? | Daily |
| What is this writer's mean scroll depth per piece? | Daily (per length bucket: short/medium/long) |
| What is this writer's mean mailing list open rate? | Per send |
| What proportion of a piece's traffic is unattributed (direct visits)? | Hourly |
| What Nostr events reference this piece's event ID? | Polled, ~5 min |
| What public mentions exist for this piece's URL? | Polled, variable |
| How many subscribers (free and paying) does this writer have? | On change |
| Which piece was last read before each conversion event? | On conversion |
| What is this writer's monthly revenue? | Daily |
| What is the publication's baseline performance? | Daily |
| What topics/tags cluster with higher-than-usual performance? | Weekly |
| What day-of-week patterns exist for this writer? | Weekly |
| When did this writer last open the feed? | On open |
| When did each data channel last complete a successful cycle? | On each cycle |

---

## 10. Open questions

- **Naming and branding:** Traffology is the working name. Does it hold up?
  It lives within the all.haus design system rather than having its own
  visual identity.
- **Mobile:** The provenance diagram with hover/touch date readout works
  on mobile. But is the feed the right primary mobile experience, or does
  mobile need its own view?
- **API:** Should Traffology expose a public API for writers who want to
  pull their data into other tools? (Not for MVP.)
- **Redis migration threshold:** At what scale (number of writers, job
  volume, concurrent-reader count) should the stack migrate from Graphile
  Worker to BullMQ/Redis? No answer needed now, but the question should
  be revisited if Traffology becomes an independent product.

### Resolved questions

- **Source display_name enrichment:** Resolved in Section 4.1 (Source
  design note). A five-step enrichment pipeline handles platform-internal
  resolution, Nostr profile lookup, a curated domain lookup table,
  shortener redirect following, and raw-domain fallback.
- **Twitter/X coverage:** Accepted as incomplete. The templated language
  is candid about what the system can and cannot see (see the candour
  principle below). If third-party search services improve, the outbound
  URL searcher can add Twitter/X as another platform; no architectural
  change is needed.
- **Overview screen design:** Resolved in Section 7.4. A dense grid of
  miniature provenance bars (one per piece), sortable and filterable,
  with a narrative summary above. Design influenced by Charcuterie
  (charcuterie.elastiq.ch) — density as aesthetic, formal consistency
  enabling legibility at scale.
- **Technical architecture and stack:** Resolved in Section 8. Two new
  services (traffology-ingest, traffology-worker) following the existing
  platform-pub service pattern. Postgres-only, no Redis. Graphile Worker
  for job queuing. Traffology schema namespaced in existing database.
  Feed API served through existing gateway. Frontend pages in existing
  Next.js app.
- **Job queuing and rate-limit management:** Resolved in Section 8.2.
  Graphile Worker with per-platform job types providing failure isolation.
  Simple in-process rate limiting at MVP scale. Per-platform concurrency
  of 1 ensures API quotas are respected.
- **Real-time counters:** Resolved in Section 8.4. In-memory state within
  traffology-ingest (Map with 5-minute sliding window), with Postgres
  heartbeat table as documented fallback.

### The candour principle

Traffology will never have perfect information. Referrer headers are
increasingly stripped. Private shares are invisible. Twitter/X has no
reliable public search API. A growing share of traffic arrives with no
attribution at all.

The product's response to this is candour, not silence. The templated
language is upfront about what the system found, what it inferred, and
what it could not discover. "Likely from this post" acknowledges
inference. "No referrer, no link we could trace" acknowledges a blind
spot. "Nostr data is delayed" acknowledges a system limitation.

Writers will not expect perfect information. They will value two things:
the unusual thoroughness of the methods (outbound URL search, Nostr
propagation tracking, cross-channel correlation) and the honesty about
where those methods reach their limits. The edge Traffology offers is not
omniscience — it is the combination of unusually diligent investigation
with unusually straightforward reporting of the results.

# Feed Algorithm Spec

Reference document for implementing Platform's graduated feed system. The feed gives readers a single "reach" control that widens the pool of content from strict chronological following through to platform-wide trending.

---

## Mental model

A dial, not a toggle. Four named positions on a slider, each widening the candidate pool and (optionally) applying ranking. The narrowest setting is pure chronological from followed authors. The widest is engagement-ranked content from across the entire platform. Everything in between blends those poles predictably.

The four positions map to the existing `content_tier` enum and the existing `feed_engagement` table.

---

## The four reach modes

### 1. `following` — pure chronological

- **Pool:** Only articles and notes from accounts in the user's `follows` table.
- **Ordering:** Reverse chronological (`published_at DESC`).
- **Ranking:** None.
- **Status:** Already built. This is the existing "Following" feed.

### 2. `following_plus` — following with light boosting

- **Pool:** Same as `following` — only followed authors.
- **Ordering:** Engagement-scored (see scoring formula below).
- **Notes:** This is the "Top Tweets within Following" model. Same authors, reordered by quality signal. Useful once the platform has enough engagement data to make ranking meaningful.

### 3. `extended` — friends-of-friends / social graph hop

- **Pool:** Followed authors + authors that followed accounts have recently engaged with. Two-hop through `feed_engagement`: user's follows → their engagement targets → those targets' authors.
- **Ordering:** Engagement-scored.
- **Notes:** This is the Bluesky / pre-2023-Twitter discovery model — social proof as the bridge. Constrain the hop to `content_tier = 'tier1'` initially; open to `'tier2'` (federated Nostr) as the network grows.

### 4. `explore` — platform-wide trending

- **Pool:** All platform content (eventually including federated/bridged tiers).
- **Ordering:** Engagement velocity — what's popular right now, time-decayed.
- **Notes:** This is the existing "For You" placeholder made real. No social graph needed. Straight query against `feed_engagement` grouped by target, scored by engagement density in a recent window (24–48 hours).

---

## API shape

Single endpoint, `reach` parameter selects the mode:

```
GET /api/feed?reach=following|following_plus|extended|explore&cursor=<published_at>&limit=20
```

| Reach | Candidate pool | Ordering |
|---|---|---|
| `following` | `follows` WHERE followee published | chronological |
| `following_plus` | same | engagement-scored |
| `extended` | follows + follows' engagement targets | engagement-scored |
| `explore` | all platform content | engagement velocity |

Blocks and mutes apply as a universal exclusion filter at every level — join against `blocks` and `mutes` to exclude content from blocked/muted authors. This filter is always on regardless of reach mode.

Default reach for new users: `explore` (they have no follows yet). Default for users with follows: `following`.

---

## Scoring formula

Used by `following_plus`, `extended`, and `explore` modes. Based on the Hacker News gravity model with Platform-specific signal weights.

```
score = (reactions + 2 × replies + 3 × quote_comments + 5 × gate_passes) / (hours_since_publish + 2) ^ gravity
```

- **gravity:** `1.5` (the HN default; battle-tested time-decay curve)
- **gate_passes weighted highest** because they represent actual payment — the strongest signal Platform has and one almost no other platform can use.
- All weight constants and gravity are tunable. Store them in `platform_config`:

```sql
INSERT INTO platform_config (key, value, description) VALUES
('feed_gravity', '1.5', 'Time-decay exponent for feed scoring (HN-style)'),
('feed_weight_reaction', '1', 'Score weight for reactions'),
('feed_weight_reply', '2', 'Score weight for replies'),
('feed_weight_quote_comment', '3', 'Score weight for quote comments'),
('feed_weight_gate_pass', '5', 'Score weight for gate passes (paid reads)');
```

The existing `for_you_engagement_weight` and `for_you_revenue_weight` config rows can be retired or repurposed — the new formula folds revenue signal (gate_pass) directly into the unified score rather than treating it as a separate axis.

---

## New table: `feed_scores`

Pre-computed scores, refreshed by a background worker. Keeps the feed query fast and pageable.

```sql
CREATE TABLE feed_scores (
    nostr_event_id  TEXT PRIMARY KEY,
    author_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    content_type    content_type NOT NULL,       -- 'article' or 'note'
    score           FLOAT NOT NULL DEFAULT 0,
    engagement_count INT NOT NULL DEFAULT 0,     -- total raw engagements
    gate_pass_count INT NOT NULL DEFAULT 0,      -- paid reads specifically
    published_at    TIMESTAMPTZ NOT NULL,
    scored_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_feed_scores_score ON feed_scores (score DESC);
CREATE INDEX idx_feed_scores_author ON feed_scores (author_id, score DESC);
CREATE INDEX idx_feed_scores_published ON feed_scores (published_at DESC);
```

---

## Scoring worker

A background job in `gateway` (or a standalone worker) that refreshes `feed_scores`. Runs on a cron interval — every 5 minutes is fine for launch.

### Logic

1. Query `feed_engagement` for all events with engagement in the last 48 hours (or since last run, whichever is wider).
2. For each `target_nostr_event_id`, count engagements by type.
3. Look up `published_at` from `articles` or `notes` (join on `nostr_event_id`).
4. Compute score using the gravity formula.
5. Upsert into `feed_scores`.
6. Optionally prune rows where `published_at` is older than 7 days and `score < 0.1` to keep the table lean.

### Sketch (TypeScript, runs in payment-service or gateway worker)

```typescript
async function refreshFeedScores(db: PoolClient) {
  const weights = await loadWeightsFromConfig(db);
  const gravity = parseFloat(weights.feed_gravity);

  await db.query(`
    WITH engagement_counts AS (
      SELECT
        target_nostr_event_id,
        target_author_id,
        COUNT(*) FILTER (WHERE engagement_type = 'reaction')      AS reactions,
        COUNT(*) FILTER (WHERE engagement_type = 'reply')          AS replies,
        COUNT(*) FILTER (WHERE engagement_type = 'quote_comment')  AS quotes,
        COUNT(*) FILTER (WHERE engagement_type = 'gate_pass')      AS gate_passes
      FROM feed_engagement
      WHERE engaged_at > now() - interval '48 hours'
      GROUP BY target_nostr_event_id, target_author_id
    ),
    scored AS (
      SELECT
        ec.target_nostr_event_id AS nostr_event_id,
        ec.target_author_id AS author_id,
        COALESCE(a.published_at, n.published_at) AS published_at,
        CASE WHEN a.id IS NOT NULL THEN 'article' ELSE 'note' END AS content_type,
        (ec.reactions * $1 + ec.replies * $2 + ec.quotes * $3 + ec.gate_passes * $4)
          / POWER(EXTRACT(EPOCH FROM (now() - COALESCE(a.published_at, n.published_at))) / 3600 + 2, $5)
          AS score,
        (ec.reactions + ec.replies + ec.quotes + ec.gate_passes) AS engagement_count,
        ec.gate_passes AS gate_pass_count
      FROM engagement_counts ec
      LEFT JOIN articles a ON a.nostr_event_id = ec.target_nostr_event_id AND a.deleted_at IS NULL
      LEFT JOIN notes n ON n.nostr_event_id = ec.target_nostr_event_id
      WHERE COALESCE(a.published_at, n.published_at) IS NOT NULL
    )
    INSERT INTO feed_scores (nostr_event_id, author_id, content_type, score, engagement_count, gate_pass_count, published_at, scored_at)
    SELECT nostr_event_id, author_id, content_type, score, engagement_count, gate_pass_count, published_at, now()
    FROM scored
    ON CONFLICT (nostr_event_id) DO UPDATE SET
      score = EXCLUDED.score,
      engagement_count = EXCLUDED.engagement_count,
      gate_pass_count = EXCLUDED.gate_pass_count,
      scored_at = EXCLUDED.scored_at
  `, [weights.reaction, weights.reply, weights.quote_comment, weights.gate_pass, gravity]);
}
```

---

## Feed queries by reach mode

All queries exclude blocked/muted authors and soft-deleted content. Pseudocode — adapt to the existing gateway query patterns.

### `following`

```sql
SELECT a.*, n.*
FROM (
  SELECT nostr_event_id, 'article' AS type, writer_id AS author_id, published_at
  FROM articles WHERE writer_id IN (SELECT followee_id FROM follows WHERE follower_id = $1)
    AND deleted_at IS NULL AND published_at IS NOT NULL
  UNION ALL
  SELECT nostr_event_id, 'note' AS type, author_id, published_at
  FROM notes WHERE author_id IN (SELECT followee_id FROM follows WHERE follower_id = $1)
) feed
WHERE feed.author_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = $1)
  AND feed.author_id NOT IN (SELECT muted_id FROM mutes WHERE muter_id = $1)
ORDER BY feed.published_at DESC
LIMIT 20 OFFSET ...;
```

### `following_plus`

Same candidate pool as `following`, but join against `feed_scores` for ordering:

```sql
...same FROM/WHERE as following...
LEFT JOIN feed_scores fs ON fs.nostr_event_id = feed.nostr_event_id
ORDER BY COALESCE(fs.score, 0) DESC, feed.published_at DESC
LIMIT 20;
```

Falls back to chronological for items with no score (new posts that haven't been scored yet).

### `extended`

Two-hop social graph expansion:

```sql
WITH my_follows AS (
  SELECT followee_id FROM follows WHERE follower_id = $1
),
extended_authors AS (
  -- Authors my follows have engaged with recently
  SELECT DISTINCT fe.target_author_id AS author_id
  FROM feed_engagement fe
  WHERE fe.actor_id IN (SELECT followee_id FROM my_follows)
    AND fe.engaged_at > now() - interval '7 days'
    AND fe.target_author_id NOT IN (SELECT followee_id FROM my_follows)  -- exclude already-followed
),
candidates AS (
  SELECT followee_id AS author_id FROM my_follows
  UNION
  SELECT author_id FROM extended_authors
)
SELECT ...
FROM (articles UNION ALL notes) feed
WHERE feed.author_id IN (SELECT author_id FROM candidates)
  AND ...block/mute filters...
LEFT JOIN feed_scores fs ON fs.nostr_event_id = feed.nostr_event_id
ORDER BY COALESCE(fs.score, 0) DESC, feed.published_at DESC
LIMIT 20;
```

### `explore`

No social graph constraint at all — platform-wide:

```sql
SELECT fs.*, ...
FROM feed_scores fs
LEFT JOIN articles a ON a.nostr_event_id = fs.nostr_event_id
LEFT JOIN notes n ON n.nostr_event_id = fs.nostr_event_id
WHERE fs.author_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = $1)
  AND fs.author_id NOT IN (SELECT muted_id FROM mutes WHERE muter_id = $1)
  AND fs.published_at > now() - interval '48 hours'
ORDER BY fs.score DESC
LIMIT 20;
```

---

## Implementation priority

### Phase 1 (launch)

Build `following` (already done) and `explore`. These are the two poles of the dial and sufficient for a 20–30 writer launch cohort. The social graph is too thin at launch for `extended` to produce meaningfully different results from `explore`.

Requires:
- [ ] `feed_scores` table (migration)
- [ ] Scoring worker (cron job, 5-min interval)
- [ ] `GET /api/feed` endpoint with `reach` parameter
- [ ] `platform_config` rows for weight constants
- [ ] Feed UI: reach selector (two options initially: "Following" / "Explore")

### Phase 2 (post-launch, once graph is denser)

- [ ] `following_plus` mode
- [ ] `extended` mode (friends-of-friends hop)
- [ ] Feed UI: expand reach selector to all four positions
- [ ] Consider `content_tier` filtering in extended mode (tier1 only → tier1+tier2 as federation lands)

### Phase 3 (optimisation)

- [ ] Cursor-based pagination on scored feeds (keyset on `(score, nostr_event_id)`)
- [ ] Materialised view or Redis cache for hot feed_scores
- [ ] Per-user score personalisation (weight recent reading history)
- [ ] A/B testing infrastructure for weight tuning

---

## Design principles

- **Transparency over magic.** Users should understand what each reach mode does. The names should be self-explanatory. No "algorithm" black box — the dial is the explanation.
- **Payment is the strongest signal.** Gate passes (paid reads) are weighted highest in the scoring formula. This is Platform's unique advantage over ad-supported feeds.
- **Chronological is always available.** The `following` mode is never removed or demoted. It's the escape hatch and the trust anchor.
- **Blocks and mutes are absolute.** They apply at every reach level, no exceptions.
- **Tunable without deploys.** All weights and thresholds live in `platform_config`. Adjustments are a database update, not a code change.

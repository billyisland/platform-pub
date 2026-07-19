-- Migration 158: resonance baselines + scoring columns
-- (SOCIAL-PROOF-RESONANCE-ADR D3/D5, as revised)
--
-- Universal social proof = response relative to expectation for this author on
-- this network. Two support tables plus three derived columns on feed_items.
--
-- Revisions vs. the ADR draft, agreed in review:
--   * No incremental median folding — median_e is unimplementable as a rolling
--     update from (median, n) alone, and the daily <7d engagement sweep would
--     multiple-count each post into an incremental fold. Instead the daily
--     engagement_baseline_refresh task RECOMPUTES each author's median from
--     their last 20 posts older than 48h (near-final E ⇒ honest baseline; the
--     lag guarantee comes free; the table is a pure cache). ewma_e is dropped.
--   * post_type is native-only ('note' | 'article'); external items have no
--     note/article axis in the data model, so external rows use 'all'.
--   * ambient_pctl is stored per item (D6 read-time blend needs the item's
--     percentile-vs-ambient; interpolating from p50/p90 at query time is
--     uglier than one numeric).
--   * Shrinkage k = 3, not 8 (k=8 leaves ambient at ~29% of the baseline at
--     n=20, contradicting the "washed out by ~20 posts" intent; k=3 ⇒ ~13%).
--     Applied at score time: baseline = (n·median_e + k·ambient_p50)/(n + k).
--
-- Absence semantics: the three feed_items columns are NULLABLE and stay NULL
-- for rss/email (structurally silent) and for nostr_external while
-- NOSTR_ENGAGEMENT_COUNTS_ENABLED is off. NULL means "no band computed", which
-- the card renders as no glyph — never band-0 styling. Do not add defaults.

-- ---------------------------------------------------------------------------
-- Author baselines — recomputed daily, never incrementally folded.
-- author_ref: external_authors.id::text for external, accounts.id::text for
-- native ('native' protocol). Text because the two id spaces are disjoint.
-- ---------------------------------------------------------------------------
CREATE TABLE author_engagement_baseline (
  author_ref  TEXT NOT NULL,
  protocol    TEXT NOT NULL,           -- 'atproto' | 'activitypub' | 'nostr_external' | 'native'
  post_type   TEXT NOT NULL DEFAULT 'all',  -- native: 'note'|'article'; external: 'all'
  median_e    NUMERIC NOT NULL DEFAULT 0,   -- median per-post E, last ≤20 posts >48h old
  n           INT NOT NULL DEFAULT 0,       -- posts in the window (caps shrinkage)
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (author_ref, protocol, post_type)
);

-- ---------------------------------------------------------------------------
-- Network ambient — corpus percentiles per protocol, refreshed by the same
-- daily task. Feeds (a) baseline shrinkage for low-n authors, (b) the D4 band
-- veto (resonance alone never grants a band; E must also clear ambient p50/p90).
-- ---------------------------------------------------------------------------
CREATE TABLE protocol_engagement_ambient (
  protocol   TEXT NOT NULL,
  post_type  TEXT NOT NULL DEFAULT 'all',
  p50_e      NUMERIC NOT NULL DEFAULT 0,
  p90_e      NUMERIC NOT NULL DEFAULT 0,
  sample_n   INT NOT NULL DEFAULT 0,   -- posts sampled (sanity signal for tuning)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (protocol, post_type)
);

-- ---------------------------------------------------------------------------
-- Derived per-item values, written by the two refresh crons (D5):
--   resonance      = log2((1 + E) / (1 + shrunk_baseline))
--   resonance_band = 0..3 after the ambient veto (NULL = not computed)
--   ambient_pctl   = this item's E as a percentile of its network ambient,
--                    consumed by the D6 read-time blend
-- ---------------------------------------------------------------------------
ALTER TABLE feed_items
  ADD COLUMN resonance      NUMERIC,
  ADD COLUMN resonance_band SMALLINT,
  ADD COLUMN ambient_pctl   NUMERIC;

-- Future "resonant only" workspace filter (D7 later slice); tiny partial index.
CREATE INDEX idx_feed_items_resonant
  ON feed_items (resonance_band)
  WHERE resonance_band >= 2 AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Weights + tuning (D2/D6). Distinct resonance_* keys — deliberately NOT the
-- feed_weight_* hotness keys, so tuning hotness never silently moves every
-- author's baseline and vice versa.
--
-- resonance_weight_native_repost is seeded but inert: native reposts of native
-- content aren't recorded yet (repost_edges binds to external targets only —
-- see repost-edge.ts "bind lazily"). It activates when that lands.
-- resonance_weight_zap (4) is reserved per D2, inert until zap ingestion.
--
-- Native up-vote weight: votes are FREE since F9 (2026-07-06) — the pre-F9
-- "paid signal" rationale is dead. 5 is retained deliberately: a native vote
-- is identity-bound and hard-capped at one per (voter, target, direction) on
-- accounts with a real signup, so it stays scarcer than an external like.
-- Revisit against the step-3 dark-ship distributions (ADR Sequencing).
-- ---------------------------------------------------------------------------
INSERT INTO platform_config (key, value, description) VALUES
  ('resonance_weight_like',           '1', 'Resonance E weight: external like/reaction/favourite'),
  ('resonance_weight_reply',          '3', 'Resonance E weight: reply (all protocols)'),
  ('resonance_weight_repost',         '2', 'Resonance E weight: external repost/boost'),
  ('resonance_weight_zap',            '4', 'Resonance E weight: nostr zap count (reserved; inert until zap ingestion)'),
  ('resonance_weight_native_up',      '5', 'Resonance E weight: native up-vote (free, capped one per voter/target/direction — see migration header)'),
  ('resonance_weight_native_gate',    '5', 'Resonance E weight: native gate pass (paid read)'),
  ('resonance_weight_native_repost',  '2', 'Resonance E weight: native repost (inert until native repost recording lands)'),
  ('resonance_shrink_k',              '3', 'Baseline shrinkage toward ambient: baseline=(n*median+k*p50)/(n+k)'),
  ('feed_alpha_following',            '0.8', 'D6 proof blend on following surfaces: alpha*resonance + (1-alpha)*ambient percentile'),
  ('feed_alpha_explore',              '0.4', 'D6 proof blend on explore surfaces')
ON CONFLICT (key) DO NOTHING;

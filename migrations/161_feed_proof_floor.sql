-- Migration 161: proof-term floor for the D6 read-time blend
-- (SOCIAL-PROOF-RESONANCE-ADR D6, sequencing step 5)
--
-- Step 5 ranks scored feeds on
--
--   effective_score = proof_term / power(age_hours + 2, gravity) * weight
--   proof_term      = alpha * clamp(resonance,0,4)/4 + (1-alpha) * ambient_pctl
--
-- D6 as drafted says NULL-band items (rss/email, and nostr_external while its
-- count refresh is dark) "take proof_term = 0 and rank on recency alone within
-- the gravity expression". They cannot. 0 / (age+2)^g is 0 at every age, so a
-- proof_term of exactly zero collapses every silent item onto one constant
-- score and the ORDER BY falls through to its uuid tiebreak — arbitrary order,
-- not recency. A structurally silent protocol would then rank by random uuid,
-- which is strictly worse than the chronology D6 replaces.
--
-- Hence a small floor under proof_term: silent items keep a positive numerator,
-- order among themselves by age exactly as D6 intended, and still sit below any
-- item carrying real proof. It is a dial, not a constant, because its right
-- value is only knowable by watching a live mixed feed: it sets how far a
-- silent-but-fresh item may outrank a resonant-but-older one. At 0.05 with
-- gravity 1.5, a silent item outranks an item at proof_term 1.0 only once the
-- latter is ~7.4x older in (age+2) terms.
--
-- Not a new namespace: this is the feed-ranking family (feed_alpha_*,
-- feed_gravity), which step 5's blend already shares with feed-scores-refresh.
-- The resonance_* keys stay separate, per the ADR's D2 rationale.

INSERT INTO platform_config (key, value, description) VALUES
  ('feed_proof_floor', '0.05', 'D6 read-time blend: floor under proof_term so zero-proof items still order by recency instead of collapsing to a constant (see migration header)')
ON CONFLICT (key) DO NOTHING;

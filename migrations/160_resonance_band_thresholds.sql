-- Migration 160: resonance band thresholds as config
-- (SOCIAL-PROOF-RESONANCE-ADR D4, sequencing step 3 outcome)
--
-- Step 3 shipped the per-item resonance computation dark and measured the band
-- distributions the ADR asked for. The draft's band gates (resonance >= 1/2/3)
-- ran 2-3x hot against the stated targets (~10-15% band >= 1, ~1% band 3) on
-- the dev corpus of ~26.7k real Bluesky + Mastodon items:
--
--            band>=1   band 3
--   atproto    35.1%     9.1%
--   activitypub 30.1%    6.0%
--
-- Diagnosis: the ambient veto is not the binding clause (66% of atproto items
-- clear p50 — the corpus median E is only 4), the resonance gate is. Observed
-- resonance p85 is already ~2.1 (activitypub) / ~2.6 (atproto), so a ">= 1"
-- gate is near the 65th percentile, not the 85th. Re-gating on the measured
-- distribution:
--
--   band 1 at 2.5  -> 13.8% pooled   (target 10-15%)
--   band 3 at 6.0  ->  2.3% pooled   (target ~1%)
--
-- The thresholds move OUT of the code and into config for the same reason the
-- weights are here: tuning a band must never need a deploy. Band 3 at 6.0 is
-- deliberately not over-fitted down to exactly 1% — the dev corpus is a small
-- sample from a handful of subscribed sources, and "surging" is meant to be a
-- confirmation rather than an early warning (ADR D2). Re-measure against prod
-- distributions and turn this dial, not the code.
--
-- NOT retuned here, for want of evidence: the native up-vote weight of 5, which
-- the ADR flagged for revisit at this step. Dev has 8 scored native items and a
-- native-note ambient of p50=p90=0 — no signal to tune against. Deferred to
-- prod volume.

INSERT INTO platform_config (key, value, description) VALUES
  ('resonance_band1_min', '2.5', 'Resonance gate for band 1 "noticed" (also requires E >= ambient p50)'),
  ('resonance_band2_min', '4',   'Resonance gate for band 2 "resonant" (also requires E >= ambient p50)'),
  ('resonance_band3_min', '6',   'Resonance gate for band 3 "surging" (also requires E >= ambient p90)')
ON CONFLICT (key) DO NOTHING;

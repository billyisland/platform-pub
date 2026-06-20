-- Slice 8 P1 — cross-source identity linking: dedup core.
--
-- Ships the machinery only; it stays inert until P2 (the "Link to…" action)
-- creates the first link. With zero links the dedup CTEs in sourceFilteredItems
-- short-circuit to empty, so this adds near-zero query cost.
--
-- Two halves:
--   1. external_identity_links — pairs of external_sources asserted to be the
--      same identity cross-posting the same content. Owner-aware: NULL owner_id
--      = a global, re-verifiable fact (P3 detection); a set owner_id = one
--      reader's unverified assertion (P2 "Link to…"). See SLICE-8 plan §"Link
--      ownership".
--   2. external_items.dedup_fingerprint — a precomputed equality key folding
--      §8D tier-1 (canonical URL) and tier-3 (normalised text hash) into one
--      column, maintained by a BEFORE INSERT/UPDATE trigger so every ingest
--      path (rss/atproto/activitypub/email/nostr) populates it for free.

-- ---------------------------------------------------------------------------
-- 1. Link table
-- ---------------------------------------------------------------------------
CREATE TABLE external_identity_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_a_id UUID NOT NULL REFERENCES external_sources(id) ON DELETE CASCADE,
  source_b_id UUID NOT NULL REFERENCES external_sources(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL CHECK (link_type IN (
    'user_asserted',   -- P2: one reader's unverified claim (owner-scoped)
    'bridge',          -- P3: objective, re-verifiable (global)
    'cross_link',      -- P3
    'domain_match',    -- P3
    'user_unlinked'    -- P3: owner-scoped negative override (tombstone)
  )),
  confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  owner_id UUID REFERENCES accounts(id) ON DELETE CASCADE,  -- NULL = global
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Normalised insertion order so A/B and B/A collapse to one row; the unique
  -- indexes below rely on it. Callers must order the pair before insert.
  CONSTRAINT external_identity_links_ordered CHECK (source_a_id < source_b_id)
);

-- One global link per pair; one assertion per user per pair.
CREATE UNIQUE INDEX uq_idlink_global ON external_identity_links(source_a_id, source_b_id)
  WHERE owner_id IS NULL;
CREATE UNIQUE INDEX uq_idlink_owned ON external_identity_links(source_a_id, source_b_id, owner_id)
  WHERE owner_id IS NOT NULL;
CREATE INDEX idx_identity_links_source_a ON external_identity_links(source_a_id);
CREATE INDEX idx_identity_links_source_b ON external_identity_links(source_b_id);

-- ---------------------------------------------------------------------------
-- 2. Dedup fingerprint on external_items
-- ---------------------------------------------------------------------------
ALTER TABLE external_items ADD COLUMN dedup_fingerprint text;

-- norm(): lower-case, strip URLs, collapse whitespace, first 200 chars. Kept
-- conservative on purpose — the text-hash fallback can collide on short/generic
-- posts, so the fingerprint function applies a minimum-length floor on top.
CREATE OR REPLACE FUNCTION external_items_norm_text(t text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$
  SELECT btrim(left(
    regexp_replace(                                  -- collapse whitespace
      regexp_replace(lower(coalesce(t, '')),         -- strip URLs
        '(https?://|www\.)\S+', ' ', 'g'),
      '\s+', ' ', 'g'),
    200))
$$;

-- Fingerprint: prefer the canonical URL (an exact cross-post identity); else a
-- hash of the normalised text, but only when there's enough text to be
-- distinctive (floor 32 chars) — too-short content stays NULL and is never
-- deduped.
CREATE OR REPLACE FUNCTION external_items_compute_fingerprint(p_canonical_url text, p_content_text text)
  RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  normed text;
BEGIN
  IF p_canonical_url IS NOT NULL AND btrim(p_canonical_url) <> '' THEN
    RETURN btrim(p_canonical_url);
  END IF;
  normed := external_items_norm_text(p_content_text);
  IF length(normed) < 32 THEN
    RETURN NULL;
  END IF;
  RETURN 'h:' || encode(digest(normed, 'sha256'), 'hex');
END;
$$;

CREATE OR REPLACE FUNCTION external_items_set_fingerprint() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.dedup_fingerprint := external_items_compute_fingerprint(NEW.canonical_url, NEW.content_text);
  RETURN NEW;
END;
$$;

CREATE TRIGGER external_items_dedup_fp
  BEFORE INSERT OR UPDATE OF canonical_url, content_text ON external_items
  FOR EACH ROW EXECUTE FUNCTION external_items_set_fingerprint();

-- Backfill existing rows.
UPDATE external_items
  SET dedup_fingerprint = external_items_compute_fingerprint(canonical_url, content_text);

CREATE INDEX idx_external_items_dedup_fp ON external_items(dedup_fingerprint)
  WHERE dedup_fingerprint IS NOT NULL;

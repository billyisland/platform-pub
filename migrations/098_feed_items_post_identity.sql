-- Migration 098: Phase 0a — Post identity on feed_items
-- UNIVERSAL-POST-ADR §2.2/§2.3/§0.1: feed_items IS the per-THING ("Post") table.
-- Mint a deterministic, opaque PostId per THING, an edit-detecting `version`, and
-- persist the biddability tier (today render-time-derived in timeline.ts/feeds.ts).
--
-- Implementation note (deviation from the ADR's "compute at each adapter dual-write"):
-- there are many scattered `INSERT INTO feed_items` sites (gateway article/note
-- routes + every feed-ingest adapter + reconcile crons). Rather than wire identical
-- logic into each, derivation lives in ONE BEFORE INSERT/UPDATE trigger so the DB is
-- the sole authority. This covers every write path AND the backfill with one
-- definition, and removes the TS-vs-SQL parity hazard of two implementations.
--
-- Derivation (§2.3 table):
--   post_id  = sha256(protocol \x1f stableOriginHandle), opaque hex. Stable across edits.
--              native article  -> protocol 'nostr', handle '30023:<pubkey>:<d-tag>' (naddr coord)
--              native note     -> protocol 'nostr', handle = nostr_event_id (immutable)
--              external        -> protocol = source_protocol, handle = source_item_uri
--   version  = edit detector (§2.4). native -> nostr_event_id (replaceable edit => new id
--              => supplant; note immutable => stable). external -> content hash of the
--              normalised body (text + title + media uris) from external_items.
--   biddability_tier (§7) = A native/nostr_external/atproto, B activitypub,
--              C rss/email with a known author_uri, D otherwise.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE feed_items
  ADD COLUMN post_id          TEXT,
  ADD COLUMN version          TEXT,
  ADD COLUMN biddability_tier TEXT;

-- ── derivation helpers ──────────────────────────────────────────────────────

-- Opaque, deterministic PostId. \x1f (unit separator) cannot occur in a URI/handle,
-- so it is a collision-safe delimiter between protocol and handle.
CREATE OR REPLACE FUNCTION feed_items_derive_post_id(p_protocol TEXT, p_handle TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(digest(p_protocol || E'\x1f' || p_handle, 'sha256'), 'hex');
$$;

-- Canonical content fingerprint for external items (§2.4): normalise line endings,
-- strip trailing whitespace per line, trim, then hash text + title + ordered media uris.
-- Incidental noise (fetch time, counts, served wrapper) is excluded by construction.
CREATE OR REPLACE FUNCTION feed_items_content_version(p_external_item_id UUID)
RETURNS TEXT LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_text  TEXT;
  v_title TEXT;
  v_media TEXT;
BEGIN
  SELECT
    btrim(regexp_replace(regexp_replace(coalesce(ei.content_text, ''), E'\r\n?', E'\n', 'g'),
                         E'[ \t]+\n', E'\n', 'g')),
    coalesce(ei.title, ''),
    coalesce((SELECT string_agg(coalesce(m->>'uri', m->>'url', ''), ',' ORDER BY ord)
              FROM jsonb_array_elements(coalesce(ei.media, '[]'::jsonb)) WITH ORDINALITY x(m, ord)), '')
  INTO v_text, v_title, v_media
  FROM external_items ei
  WHERE ei.id = p_external_item_id;

  RETURN encode(digest(coalesce(v_text, '') || E'\x1f' || v_title || E'\x1f' || v_media, 'sha256'), 'hex');
END;
$$;

-- ── trigger ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION feed_items_post_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_pubkey TEXT;
  v_dtag   TEXT;
BEGIN
  -- PostId is stable: mint once (NULL on INSERT/backfill), preserve thereafter.
  IF NEW.post_id IS NULL THEN
    IF NEW.article_id IS NOT NULL THEN
      SELECT ac.nostr_pubkey, a.nostr_d_tag INTO v_pubkey, v_dtag
      FROM articles a JOIN accounts ac ON ac.id = a.writer_id
      WHERE a.id = NEW.article_id;
      IF v_pubkey IS NOT NULL AND v_dtag IS NOT NULL THEN
        NEW.post_id := feed_items_derive_post_id('nostr', '30023:' || v_pubkey || ':' || v_dtag);
      ELSE
        -- writer unlinked: fall back to the stable feed_items article identity
        NEW.post_id := feed_items_derive_post_id('nostr_article', NEW.article_id::text);
      END IF;
    ELSIF NEW.note_id IS NOT NULL THEN
      NEW.post_id := feed_items_derive_post_id('nostr', coalesce(NEW.nostr_event_id, NEW.note_id::text));
    ELSIF NEW.external_item_id IS NOT NULL THEN
      NEW.post_id := feed_items_derive_post_id(coalesce(NEW.source_protocol, 'unknown'),
                                               coalesce(NEW.source_item_uri, NEW.external_item_id::text));
    END IF;
  END IF;

  -- version: edit detector. Recompute only when identity/content-bearing columns
  -- change, so hot UPDATEs that touch only `score` (feed_scores_refresh) or author
  -- fields (feed_items_author_refresh) don't pay for the external_items join + hash.
  -- The content-edit dual-write paths always rewrite content_preview/title/event id,
  -- so this proxy detects every real edit.
  IF TG_OP = 'INSERT'
     OR NEW.version IS NULL  -- backfill / never-computed
     OR NEW.nostr_event_id   IS DISTINCT FROM OLD.nostr_event_id
     OR NEW.external_item_id IS DISTINCT FROM OLD.external_item_id
     OR NEW.content_preview  IS DISTINCT FROM OLD.content_preview
     OR NEW.title            IS DISTINCT FROM OLD.title
  THEN
    IF NEW.external_item_id IS NOT NULL THEN
      NEW.version := feed_items_content_version(NEW.external_item_id);
    ELSE
      NEW.version := NEW.nostr_event_id;  -- native: the replaceable/immutable event token
    END IF;
  END IF;

  -- biddability tier (§7). Inputs only change on INSERT or a (rare) protocol/source flip.
  IF TG_OP = 'UPDATE'
     AND NEW.biddability_tier IS NOT NULL  -- already computed (don't skip on backfill)
     AND NEW.item_type        IS NOT DISTINCT FROM OLD.item_type
     AND NEW.source_protocol  IS NOT DISTINCT FROM OLD.source_protocol
     AND NEW.external_item_id IS NOT DISTINCT FROM OLD.external_item_id THEN
    RETURN NEW;  -- biddability inputs unchanged; keep existing value
  END IF;

  IF NEW.item_type IN ('article', 'note') THEN
    NEW.biddability_tier := 'A';
  ELSIF NEW.source_protocol IN ('nostr_external', 'atproto') THEN
    NEW.biddability_tier := 'A';
  ELSIF NEW.source_protocol = 'activitypub' THEN
    NEW.biddability_tier := 'B';
  ELSIF NEW.source_protocol IN ('rss', 'email') THEN
    NEW.biddability_tier := CASE
      WHEN (SELECT ei.author_uri FROM external_items ei WHERE ei.id = NEW.external_item_id) IS NOT NULL
      THEN 'C' ELSE 'D' END;
  ELSE
    NEW.biddability_tier := 'D';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER feed_items_post_identity_trg
  BEFORE INSERT OR UPDATE ON feed_items
  FOR EACH ROW EXECUTE FUNCTION feed_items_post_identity();

-- ── backfill ────────────────────────────────────────────────────────────────
-- A no-op UPDATE fires the BEFORE UPDATE trigger for every existing row; post_id,
-- version, and biddability_tier are all NULL on existing rows (new columns) so the
-- trigger's NULL-guards mint them.
UPDATE feed_items SET deleted_at = deleted_at;

ALTER TABLE feed_items
  ADD CONSTRAINT feed_items_biddability_tier_check
  CHECK (biddability_tier IN ('A', 'B', 'C', 'D'));

-- Assembler groups candidate edges by post_id (§5); index the grouping key.
CREATE INDEX idx_feed_items_post_id ON feed_items (post_id);

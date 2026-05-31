-- Migration 099: Phase 0b — External-author identity records (tier A/B)
-- UNIVERSAL-POST-ADR §2.2/§4.4/§0.4/§10 Phase 0b: mint a stable identity record
-- ("author.id") for every external author that carries a stable origin handle —
-- TIER A/B ONLY (nostr pubkey, atproto DID, activitypub actor URI). This is the
-- load-bearing key for the later §4.4 / VI.3 constructed external-author profile,
-- which aggregates one author's Posts across all sources by author.id.
--
-- Tier-C rss/email authors have no reliable key (author_uri null or inconsistent
-- across items) and get NO record — plain-text byline. Tier D has no author at all.
--
-- Implementation note (same deviation/rationale as Phase 0a, migration 098):
-- derivation lives in the ONE existing BEFORE INSERT/UPDATE trigger on feed_items
-- (feed_items_post_identity), not per-adapter. That trigger already joins
-- external_items for version/biddability, so the author handle + metadata are at
-- hand; one definition covers every dual-write site AND the backfill with no
-- TS-vs-SQL parity hazard. feed_items.author_id is left untouched — it is the
-- internal accounts(id) for NATIVE rows (joined to accounts/trust_layer1, used by
-- block/mute filters in timeline.ts) and is NULL for external rows. The external
-- author link is a SEPARATE column, external_author_id.
--
-- Stable handle source differs per protocol:
--   nostr_external -> external_items.interaction_data->>'pubkey'   (author_uri is null), tier A
--   atproto        -> external_items.author_uri (the DID)                              , tier A
--   activitypub    -> external_items.author_uri (the actor URI)                        , tier B
--   rss/email      -> no stable handle                            -> no record (tier C/D)

-- ── identity table ──────────────────────────────────────────────────────────
-- One record per external author. UNIQUE(protocol, stable_handle) is the dedup
-- key: the same author seen via two A/B sources resolves to one id. account_id is
-- the lazy claim slot (§2.1 "mint eagerly, bind lazily") — NULL until an all.haus
-- account claims this identity; filling it never changes the id.
CREATE TABLE external_authors (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  protocol      external_protocol NOT NULL,
  stable_handle text NOT NULL,            -- pubkey | DID | actor URI
  tier          text NOT NULL CHECK (tier IN ('A', 'B')),
  account_id    uuid REFERENCES accounts(id) ON DELETE SET NULL,
  display_name  text,
  handle        text,                     -- handle@host (activitypub); NULL for nostr/atproto
  handle_uri    text,                     -- link to origin profile, where known
  avatar        text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (protocol, stable_handle)
);

CREATE INDEX idx_external_authors_account_id ON external_authors (account_id);

-- ── feed_items link column ──────────────────────────────────────────────────
-- Non-null only for tier-A/B external rows; NULL for native (which use author_id)
-- and for tier-C/D external rows. Profile aggregation (later phase) groups by this.
ALTER TABLE feed_items
  ADD COLUMN external_author_id uuid REFERENCES external_authors(id);

CREATE INDEX idx_feed_items_external_author_id ON feed_items (external_author_id);

-- ── trigger: extend feed_items_post_identity with author minting ────────────
-- Replaces the Phase 0a function verbatim plus a final mint-once author block.
CREATE OR REPLACE FUNCTION feed_items_post_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_pubkey TEXT;
  v_dtag   TEXT;
  v_protocol     TEXT;
  v_handle       TEXT;
  v_tier         TEXT;
  v_author_name  TEXT;
  v_author_handle TEXT;
  v_author_avatar TEXT;
  v_author_uri   TEXT;
  v_interaction  JSONB;
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
    NULL;  -- biddability inputs unchanged; fall through (author block still mint-once-guarded)
  ELSIF NEW.item_type IN ('article', 'note') THEN
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

  -- external-author identity (§4.4 / Phase 0b). Mint once: only when this row is an
  -- external THING with no author link yet AND it is tier A/B (the tiers that carry a
  -- stable origin handle). Tier C/D (rss/email) keep external_author_id NULL forever
  -- (plain-text byline); excluding them here also keeps the hot score/author-refresh
  -- UPDATE path off the external_items join — biddability_tier is already set above.
  IF NEW.external_item_id IS NOT NULL
     AND NEW.external_author_id IS NULL
     AND NEW.biddability_tier IN ('A', 'B') THEN
    SELECT ei.author_name, ei.author_handle, ei.author_avatar_url, ei.author_uri, ei.interaction_data
      INTO v_author_name, v_author_handle, v_author_avatar, v_author_uri, v_interaction
      FROM external_items ei WHERE ei.id = NEW.external_item_id;

    v_protocol := NEW.source_protocol;
    IF v_protocol = 'nostr_external' THEN
      v_handle := v_interaction->>'pubkey';   -- author_uri is null for nostr
      v_tier   := 'A';
    ELSIF v_protocol = 'atproto' THEN
      v_handle := v_author_uri;               -- the DID
      v_tier   := 'A';
    ELSIF v_protocol = 'activitypub' THEN
      v_handle := v_author_uri;               -- the actor URI
      v_tier   := 'B';
    ELSE
      v_handle := NULL;                       -- rss/email -> tier C/D, no record
    END IF;

    IF v_handle IS NOT NULL AND v_handle <> '' THEN
      INSERT INTO external_authors (protocol, stable_handle, tier, display_name, handle, handle_uri, avatar)
      VALUES (v_protocol::external_protocol, v_handle, v_tier,
              v_author_name, v_author_handle,
              CASE WHEN v_protocol IN ('atproto', 'activitypub') THEN v_author_uri ELSE NULL END,
              v_author_avatar)
      ON CONFLICT (protocol, stable_handle) DO UPDATE
        SET last_seen_at = now(),
            display_name = COALESCE(EXCLUDED.display_name, external_authors.display_name),
            handle       = COALESCE(EXCLUDED.handle,       external_authors.handle),
            handle_uri   = COALESCE(EXCLUDED.handle_uri,   external_authors.handle_uri),
            avatar       = COALESCE(EXCLUDED.avatar,       external_authors.avatar)
      RETURNING id INTO NEW.external_author_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ── backfill ────────────────────────────────────────────────────────────────
-- No-op UPDATE fires the BEFORE UPDATE trigger for every existing row; the
-- external_author_id IS NULL guard mints/links a record for each existing tier-A/B
-- external row and leaves native + tier-C/D rows NULL.
UPDATE feed_items SET deleted_at = deleted_at;

-- Migration 105: C4 (#11 denormalise) — carry reply-parent author on feed_items
--
-- The read path (timeline.ts + feeds.ts FEED_SELECT) resolved a reply's parent
-- author with a correlated subquery PER candidate row:
--   native   -> notes n_p JOIN accounts ON nostr_event_id = n.reply_to_event_id
--   external -> external_items ei_p ON (protocol, source_item_uri) = source_reply_uri
-- Cheap individually, but N of them over the whole materialised candidate set
-- (the `scored` CTE materialises before LIMIT). Denormalise the resolved value
-- onto the row so the projection is a plain column read.
--
-- Population mirrors the existing denormalised author columns (author_name etc.):
--   * at ingest  -> the ONE feed_items_post_identity BEFORE INSERT/UPDATE trigger
--                   resolves it once on INSERT (best-effort: NULL if the parent
--                   isn't ingested yet), gated on the already-set NEW.is_reply.
--   * maintained -> feed_items_author_refresh (daily) fills late-arriving parents
--                   and tracks parent renames. Up to 24h staleness is acceptable
--                   per design, same as the other denormalised author fields.
-- The trigger block is INSERT-only so the cron's UPDATEs (and hot score-refresh
-- UPDATEs) never clobber the maintained value; reply_to_author is not in the
-- version-recompute column set, so refreshing it costs no version churn.

ALTER TABLE feed_items ADD COLUMN IF NOT EXISTS reply_to_author text;

-- ── trigger: extend feed_items_post_identity with reply-author resolution ────
-- Replaces the Phase 0b function (migration 099) verbatim plus a final
-- INSERT-only reply_to_author block.
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

  -- reply-parent author (§C4 / #11 denormalise). Resolve once on INSERT for reply
  -- rows; best-effort (NULL if the parent isn't ingested yet — feed_items_author_refresh
  -- fills it later). INSERT-only so the cron's maintenance UPDATEs are never clobbered.
  -- Mirrors the read-path subqueries this replaces: native -> parent note author's
  -- display_name; external -> parent item's author_handle (constrained on protocol so
  -- the lookup hits the UNIQUE(protocol, source_item_uri) composite).
  IF TG_OP = 'INSERT' AND NEW.is_reply THEN
    IF NEW.note_id IS NOT NULL THEN
      SELECT acc_p.display_name INTO NEW.reply_to_author
      FROM notes n
      JOIN notes n_p ON n_p.nostr_event_id = n.reply_to_event_id
      JOIN accounts acc_p ON acc_p.id = n_p.author_id
      WHERE n.id = NEW.note_id
      LIMIT 1;
    ELSIF NEW.external_item_id IS NOT NULL THEN
      SELECT ei_p.author_handle INTO NEW.reply_to_author
      FROM external_items ei
      JOIN external_items ei_p
        ON ei_p.protocol = ei.protocol
       AND ei_p.source_item_uri = ei.source_reply_uri
      WHERE ei.id = NEW.external_item_id
      LIMIT 1;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ── backfill ────────────────────────────────────────────────────────────────
-- Resolve reply_to_author for every existing reply row. Direct UPDATEs fire the
-- BEFORE UPDATE trigger, but its reply_to_author block is INSERT-only (no clobber)
-- and reply_to_author is not in the version-recompute set (no version churn).
UPDATE feed_items fi SET reply_to_author = acc_p.display_name
FROM notes n
JOIN notes n_p ON n_p.nostr_event_id = n.reply_to_event_id
JOIN accounts acc_p ON acc_p.id = n_p.author_id
WHERE fi.note_id = n.id
  AND fi.is_reply
  AND fi.deleted_at IS NULL;

UPDATE feed_items fi SET reply_to_author = ei_p.author_handle
FROM external_items ei
JOIN external_items ei_p
  ON ei_p.protocol = ei.protocol
 AND ei_p.source_item_uri = ei.source_reply_uri
WHERE fi.external_item_id = ei.id
  AND fi.is_reply
  AND fi.deleted_at IS NULL;

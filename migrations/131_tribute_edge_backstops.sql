-- 131_tribute_edge_backstops.sql
--
-- Upstream Edges — audit P2 defense-in-depth (F5, F6).
-- Companion: docs/adr/UPSTREAM-EDGES-AUDIT-FIXES.md.
--
-- Three route-enforced invariants gain a path-independent DB backstop. None has
-- a live exploit today (the routes already hold them); these close the gap the
-- audit opened against the compliance posture ("every held share traces up an
-- unbroken chain of consented earners") and bring the edge tables level with the
-- consistency CHECKs their siblings (credit_edges/tributes) already carry.

-- ---------------------------------------------------------------------------
-- F5 · A child tribute must trace up to a LIVE parent (ADR C6).
--
-- The authoring route enforces this at insert (loadLiveParent → "live and
-- yours", C1) and `live` is terminal (consent/decline both guard
-- status='proposed'), so only a manual DB edit could orphan a held child under a
-- declined/withdrawn/proposed parent. The compliance posture leans on the chain
-- being unbroken, so it earns a backstop in the same BEFORE INSERT/UPDATE trigger
-- that owns the ceiling + D1 invariants. (CREATE OR REPLACE — the body is the
-- migration-128 function plus the new clause (3).)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tributes_validate_write() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  total int;
  ceiling int := 9000;  -- each node keeps >= 10% of its inflow
BEGIN
  -- A row that no longer reserves a share imposes neither constraint.
  IF NEW.deleted_at IS NOT NULL OR NEW.status IN ('declined', 'lapsed') THEN
    RETURN NEW;
  END IF;
  -- (1) D1 forward: reject a tribute on an article that is in a publication.
  IF EXISTS (
    SELECT 1 FROM public.articles a
     WHERE a.id = NEW.article_id AND a.publication_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Article % is in a publication; it cannot carry a tribute (D1)',
      NEW.article_id USING ERRCODE = 'check_violation';
  END IF;
  -- (2) Parent-scoped share ceiling. Roots compete among the article's roots;
  -- children compete among their siblings under the same parent.
  IF NEW.parent_tribute_id IS NULL THEN
    SELECT COALESCE(SUM(percentage_bps), 0) INTO total
      FROM public.tributes
     WHERE article_id = NEW.article_id
       AND parent_tribute_id IS NULL
       AND id <> NEW.id
       AND deleted_at IS NULL
       AND status IN ('proposed', 'live');
  ELSE
    SELECT COALESCE(SUM(percentage_bps), 0) INTO total
      FROM public.tributes
     WHERE parent_tribute_id = NEW.parent_tribute_id
       AND id <> NEW.id
       AND deleted_at IS NULL
       AND status IN ('proposed', 'live');
  END IF;
  IF total + NEW.percentage_bps > ceiling THEN
    RAISE EXCEPTION
      'Tribute shares would exceed the ceiling under this parent (have % bps, adding % bps, ceiling % bps)',
      total, NEW.percentage_bps, ceiling
      USING ERRCODE = 'check_violation';
  END IF;
  -- (3) F5 / C6: a child's source-of-funds is its parent's share, so a reserving
  -- child requires a LIVE, non-deleted parent. Route-enforced at insert; this is
  -- the path-independent guarantee that a held child can never trace up to a
  -- parent that never consented (or that was withdrawn).
  IF NEW.parent_tribute_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.tributes p
       WHERE p.id = NEW.parent_tribute_id
         AND p.status = 'live'
         AND p.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION
        'Child tribute % requires a live parent (C6)', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- F6a · citation_edges source consistency.
--
-- The route populates the Nostr-only addressing columns (source_author_pubkey /
-- nostr_event_id / nostr_d_tag / source_naddr) ONLY for a native (NULL protocol)
-- or `nostr_external` source; atproto/activitypub/rss/email sources carry a
-- source_uri instead and leave all four NULL. And a `nostr_external` source is
-- always pubkey-addressed. Mirror exactly that (so it can never reject a row the
-- route legitimately writes):
--   - nostr_external  ⇒ source_author_pubkey present
--   - non-Nostr external (atproto/ap/rss/email) ⇒ no Nostr addressing columns
-- excerpt/excerpt_sha256 stay the integrity anchor (already NOT NULL).
-- ---------------------------------------------------------------------------
ALTER TABLE public.citation_edges
  ADD CONSTRAINT citation_edges_source_consistency CHECK (
    (source_protocol <> 'nostr_external' OR source_author_pubkey IS NOT NULL)
    AND (source_protocol IS NULL
         OR source_protocol = 'nostr_external'
         OR (source_author_pubkey IS NULL
             AND source_naddr IS NULL
             AND nostr_event_id IS NULL
             AND nostr_d_tag IS NULL))
  );

-- ---------------------------------------------------------------------------
-- F6b · dispute_edges wider_excerpt is all-or-nothing.
--
-- The optional re-pin carries its own integrity hash; the route sets both or
-- neither (data.widerExcerpt + its sha256). A row with text but no hash (or vice
-- versa) is meaningless — assert the pairing.
-- ---------------------------------------------------------------------------
ALTER TABLE public.dispute_edges
  ADD CONSTRAINT dispute_edges_wider_excerpt_consistency CHECK (
    (wider_excerpt IS NULL) = (wider_excerpt_sha256 IS NULL)
  );

-- ---------------------------------------------------------------------------
-- F6c · A third-party (staked) dispute must hold its stake ledger entry.
--
-- `is_by_cited_author = false ⇒ stake_ledger_entry_id IS NOT NULL`. This CANNOT
-- be a row CHECK: the stake entry references the dispute (recordLedger
-- refTable='dispute_edges') and the dispute references the entry — a circular
-- ref the route resolves by inserting the dispute first (stake NULL), then
-- back-filling stake_ledger_entry_id in a second UPDATE inside the same txn. So
-- the invariant only holds at COMMIT, which is exactly what a DEFERRABLE
-- INITIALLY DEFERRED constraint trigger checks (Postgres has no deferrable CHECK).
-- (Withdrawal sets withdrawn_at but RETAINS stake_ledger_entry_id — the refund is
-- a separate reversing entry — so the invariant holds for withdrawn rows too.)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.dispute_edges_check_stake() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW.is_by_cited_author AND NEW.stake_ledger_entry_id IS NULL THEN
    RAISE EXCEPTION
      'Third-party dispute % must hold a stake ledger entry', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_dispute_edges_check_stake
  AFTER INSERT OR UPDATE ON public.dispute_edges
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.dispute_edges_check_stake();

-- 126_tributes.sql
--
-- Upstream Edges — Phase 2: tribute (the money edge) authoring schema.
-- Companion: docs/adr/UPSTREAM-EDGES-ADR.md, docs/adr/UPSTREAM-EDGES-BUILD-PLAN.md.
--
-- A tribute routes a share of a piece's writer-side earnings to a source as a
-- co-earner. This migration ships the AUTHORING half: the `tributes` record and
-- its (still-empty) `tribute_accruals` suspense table. NO money moves yet —
-- accrual rows are written only by Phase 3's settlement apportionment, gated on
-- the third-party-funds compliance question. Phase 2 builds identification,
-- consent, and the contact pipeline behind the TRIBUTES_ENABLED dark flag.
--
-- Target grammar matches the Phase-1 edges exactly: there is NO target_kind.
-- NULL target_protocol = a NATIVE all.haus source (a resolved member account, or
-- an unaddressable display-name label); a non-NULL external_protocol = that
-- external network.

-- ---------------------------------------------------------------------------
-- tributes — the author's offer: "X% of this piece's earnings goes to Y."
--
-- proposed = created and (in Phase 3) accruing, awaiting the inspirer's consent.
-- live     = inspirer consented + Stripe-Connect onboarded; the held share releases.
-- declined = inspirer declined; the held share sweeps back to the author.
-- lapsed   = the contact window expired with no response; held share swept.
-- ---------------------------------------------------------------------------
CREATE TABLE public.tributes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id uuid NOT NULL REFERENCES public.articles(id),
  author_account_id uuid NOT NULL REFERENCES public.accounts(id),
  percentage_bps int NOT NULL CHECK (percentage_bps BETWEEN 1 AND 10000),  -- share of the piece's writer-side net
  -- Target (one grammar across all edge tables): NULL protocol = native.
  target_protocol public.external_protocol,
  target_external_id text,                             -- npub / DID / handle / email (external)
  target_display_name text,                            -- fallback label for an unaddressable native source
  resolved_account_id uuid REFERENCES public.accounts(id),  -- set when the inspirer is/becomes a native account
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'live', 'declined', 'lapsed')),
  invite_email text,                                   -- external-contact branch; always collected (oracle-close)
  invite_token_hash text,                              -- SHA-256 of the external-email claim token (bind signup→tribute)
  first_contact_at timestamptz,                        -- when the offer was delivered (window anchor)
  window_expires_at timestamptz,                       -- first_contact_at + 60d
  reminder_sent_at timestamptz,                        -- lifecycle worker's 30d reminder marker
  consent_at timestamptz,
  citation_edge_id uuid REFERENCES public.citation_edges(id),  -- Phase-4 composition seam (unused in v1)
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  -- Same target consistency as credit_edges: external rows carry an external id;
  -- native rows carry either a resolved account (a member) or a display name.
  CONSTRAINT tributes_target_consistency CHECK (
    (target_protocol IS NULL
       AND (resolved_account_id IS NOT NULL OR target_display_name IS NOT NULL))
    OR (target_protocol IS NOT NULL AND target_external_id IS NOT NULL)
  )
);

CREATE INDEX idx_tributes_article ON public.tributes(article_id);
-- The inspirer's "offers to me" listing + the consent-route lookup.
CREATE INDEX idx_tributes_resolved_account ON public.tributes(resolved_account_id);
-- The lifecycle worker sweeps proposed tributes by window; partial keeps it tiny.
CREATE INDEX idx_tributes_proposed_window ON public.tributes(window_expires_at)
  WHERE status = 'proposed' AND deleted_at IS NULL;
-- The external-email claim looks the tribute up by token hash.
CREATE UNIQUE INDEX uq_tributes_invite_token ON public.tributes(invite_token_hash)
  WHERE invite_token_hash IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Tribute-write validation (BEFORE INSERT/UPDATE). Two invariants no per-row
-- CHECK can express, so a trigger owns them:
--
--  (1) D1 — a tributed piece may not live in a publication. Publications already
--      split an article's revenue at payout; a tribute carves the writer-side net
--      at settlement. Composing the two double-splits the same money (deferred to
--      Phase 4). The reverse direction (an article gaining a publication while a
--      tribute exists) is guarded on `articles` below; this is the forward half.
--
--  (2) Cross-row share ceiling — Σ percentage_bps over the article's non-deleted
--      proposed+live tributes (incl. the NEW row) must leave the author a
--      meaningful share: it may not exceed 9000 bps (author keeps >= 10%).
--      declined/lapsed/deleted rows release their share, so they're excluded.
--
-- The route serialises concurrent adds on the article with an advisory xact lock
-- so two simultaneous inserts can't each read under-ceiling and both commit; this
-- trigger is the backstop / single-writer guarantee.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.tributes_validate_write() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  total int;
  ceiling int := 9000;  -- author keeps >= 10%
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
  -- (2) Share ceiling.
  SELECT COALESCE(SUM(percentage_bps), 0) INTO total
    FROM public.tributes
   WHERE article_id = NEW.article_id
     AND id <> NEW.id
     AND deleted_at IS NULL
     AND status IN ('proposed', 'live');
  IF total + NEW.percentage_bps > ceiling THEN
    RAISE EXCEPTION
      'Tribute shares on article % would exceed the ceiling (have % bps, adding % bps, ceiling % bps)',
      NEW.article_id, total, NEW.percentage_bps, ceiling
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tributes_validate_write
  BEFORE INSERT OR UPDATE ON public.tributes
  FOR EACH ROW EXECUTE FUNCTION public.tributes_validate_write();

-- D1 reverse: an article may not gain a publication while a live/proposed tribute
-- exists on it. Publication assignment is scattered across draft/publish paths, so
-- this DB trigger is the path-independent guarantee. Fires only when publication_id
-- transitions to a new non-null value, so the subquery cost is paid almost never.
CREATE FUNCTION public.articles_block_publication_when_tributed() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.publication_id IS NOT NULL
     AND NEW.publication_id IS DISTINCT FROM OLD.publication_id
     AND EXISTS (
       SELECT 1 FROM public.tributes t
        WHERE t.article_id = NEW.id
          AND t.deleted_at IS NULL
          AND t.status IN ('proposed', 'live')
     ) THEN
    RAISE EXCEPTION
      'Article % has a live or proposed tribute and cannot be added to a publication (D1)',
      NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_articles_block_publication_when_tributed
  BEFORE UPDATE OF publication_id ON public.articles
  FOR EACH ROW EXECUTE FUNCTION public.articles_block_publication_when_tributed();

-- ---------------------------------------------------------------------------
-- tribute_accruals — the inspirer's SUSPENSE. A held share is money the
-- platform has collected but not yet attributed to a final owner, so it lives
-- HERE, outside ledger_entries (whose account_id is NOT NULL) — exactly as an
-- un-onboarded writer's earnings wait in read_events until payout. It only
-- touches the ledger (a single tribute_payout entry) when it reaches a real
-- account. STAYS EMPTY until Phase 3 flips settlement apportionment on.
--
-- The beneficiary account is resolved through the parent tribute
-- (tributes.resolved_account_id), never denormalised here (drift hazard, per the
-- build plan) — `state` alone tracks lifecycle.
-- ---------------------------------------------------------------------------
CREATE TABLE public.tribute_accruals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tribute_id uuid NOT NULL REFERENCES public.tributes(id),
  read_event_id uuid NOT NULL REFERENCES public.read_events(id),
  amount_pence bigint NOT NULL,                        -- frozen at settlement (fee bps of the moment), never recomputed
  state text NOT NULL CHECK (state IN ('held', 'released', 'paid', 'swept')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One accrual per (tribute, settled read).
CREATE UNIQUE INDEX uq_tribute_accruals_tribute_read
  ON public.tribute_accruals(tribute_id, read_event_id);
CREATE INDEX idx_tribute_accruals_tribute ON public.tribute_accruals(tribute_id);
-- The Phase-3 inspirer-payout sweep selects state='released'; the author sweep
-- returns state='swept'.
CREATE INDEX idx_tribute_accruals_state ON public.tribute_accruals(state);

-- ---------------------------------------------------------------------------
-- Notifications: the in-app tribute offer (recipient = inspirer, actor = author,
-- type = 'tribute_offer_received', article_id = the tributed piece). No new
-- dedup index is needed — the existing global idx_notifications_dedup
-- (recipient_id, actor_id, type, COALESCE(article_id,…), …) already keys on
-- (recipient, actor, type, article), so a repeat offer for the same piece
-- de-duplicates by construction. `type` is plain text (no enum), so no DDL.
-- ---------------------------------------------------------------------------

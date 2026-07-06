-- =============================================================================
-- 139_read_events_publication_id.sql  (audit F2, 2026-07-05)
--
-- Isolate publication-article revenue from the individual writer payout cycle.
-- Publication articles carry the human author's writer_id on their read_events,
-- so the writer cycle's eligibility/recompute/claim queries — which have no
-- publication filter — steal publication reads and pay them to the author
-- personally before the publication split cycle can pool them (audit finding 2).
--
-- The clean fix is a publication_id filter on those queries, but read_events did
-- not carry it. Denormalising publication_id onto read_events (set at gate-pass
-- insert going forward, backfilled here for history) lets the payout claim add
-- `AND publication_id IS NULL` with no hot join to articles.
-- =============================================================================

ALTER TABLE public.read_events
  ADD COLUMN IF NOT EXISTS publication_id uuid;

-- Backfill from the article each read belongs to. Only publication articles get
-- a non-null value; individual-writer reads stay NULL (the writer-cycle case).
UPDATE public.read_events re
   SET publication_id = a.publication_id
  FROM public.articles a
 WHERE a.id = re.article_id
   AND a.publication_id IS NOT NULL
   AND re.publication_id IS DISTINCT FROM a.publication_id;

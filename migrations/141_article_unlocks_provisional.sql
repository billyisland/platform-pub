-- =============================================================================
-- 141_article_unlocks_provisional.sql  (audit F3, 2026-07-05)
--
-- A gate pass writes a PERMANENT article_unlocks row even for a provisional
-- (card-less) read, so a card-less reader's free reads granted permanent access
-- pre-payment (audit finding 3). The hard-gate floor (accrual.ts) now bounds how
-- much a card-less reader can read; this flag marks the unlocks those reads
-- produce as NOT-yet-paid, cleared to permanent when the reader connects a card
-- (convertProvisionalReads). It is a marker + upgrade hook — access-check still
-- grants access for a provisional unlock (so the reader gets their key); a future
-- GC can reap unlocks left provisional by a never-paying account.
-- =============================================================================

ALTER TABLE public.article_unlocks
  ADD COLUMN IF NOT EXISTS is_provisional boolean NOT NULL DEFAULT false;

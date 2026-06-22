-- 125_upstream_edges.sql
--
-- Upstream Edges — Phase 1: credit / citation / dispute edges + dispute stake.
-- Companion: docs/adr/UPSTREAM-EDGES-ADR.md, docs/adr/UPSTREAM-EDGES-BUILD-PLAN.md.
--
-- A piece stands on prior work; this ships the three directed edges that mark
-- that debt, plus the dispute counter-edge and its refundable stake. Money-free
-- except the third-party disputant's own stake (a tab debit, same shape as a
-- vote_charge), so it ships independently of the tribute compliance question
-- (Phase 2/3) and establishes the ledger-guard wiring early.
--
-- Target grammar (one convention across all three edge tables, per the build
-- plan): there is NO target_kind. NULL target/source protocol means a NATIVE
-- all.haus source; a non-NULL external_protocol means that external network.
-- An "unaddressable" native target (a tradition, a dead author, a book) is a
-- NULL protocol with no resolved account — just a display name.
--
-- The dispute stake adds two LedgerTriggerType values (dispute_stake /
-- dispute_stake_refund). Both MOVE the disputant's reading_tabs.balance_pence,
-- so they MUST be counted by ledger_reader_balance or the keystone invariant
-- −SUM(ledger) == reading_tabs.balance_pence (reconcile B1) breaks. The view is
-- widened here, in the same migration that introduces the triggers.

-- ---------------------------------------------------------------------------
-- credit_edges — "this work draws on X." No money, no consent, piece-level.
-- ---------------------------------------------------------------------------
CREATE TABLE public.credit_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id uuid NOT NULL REFERENCES public.articles(id),
  target_protocol public.external_protocol,            -- NULL = native all.haus source
  target_external_id text,                             -- npub / DID / handle / email (external)
  target_display_name text,                            -- fallback for an unaddressable native source
  resolved_account_id uuid REFERENCES public.accounts(id),  -- set when the source is a known native account
  note text,                                           -- the author's gloss on the debt
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  -- Target consistency: external rows carry an external id; native rows carry
  -- either a resolved account (a member) or a display name (unaddressable).
  CONSTRAINT credit_edges_target_consistency CHECK (
    (target_protocol IS NULL
       AND (resolved_account_id IS NOT NULL OR target_display_name IS NOT NULL))
    OR (target_protocol IS NOT NULL AND target_external_id IS NOT NULL)
  )
);

CREATE INDEX idx_credit_edges_article ON public.credit_edges(article_id);
-- Dispute-privilege lookup: a credited member disputes (disclaims) their own credit.
CREATE INDEX idx_credit_edges_resolved_account ON public.credit_edges(resolved_account_id);

-- ---------------------------------------------------------------------------
-- citation_edges — "X argues Y." A faithfulness claim pinned to source bytes.
-- The excerpt + excerpt_sha256 ARE the integrity anchor (self-contained,
-- survives source supersession). source_version_event_id is a best-effort hint
-- only — native NIP-23 articles are replaceable and signed bytes are not
-- retained, so a byte-identical native version generally cannot be reproduced.
-- ---------------------------------------------------------------------------
CREATE TABLE public.citation_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id uuid NOT NULL REFERENCES public.articles(id),
  source_protocol public.external_protocol,            -- NULL = native all.haus source
  source_author_pubkey text,                           -- native/Nostr only; p-tag + dispute privilege
  nostr_event_id text,                                 -- native/Nostr only
  nostr_d_tag text,                                    -- native/Nostr only; addressable, corrects in place
  source_naddr text,                                   -- native/Nostr only; 30023:<pubkey>:<d_tag>
  source_version_event_id text,                        -- best-effort hint, NOT a guarantee
  source_external_item_id uuid REFERENCES public.external_items(id),  -- non-Nostr ingested source
  source_uri text,
  excerpt text NOT NULL,
  excerpt_sha256 bytea NOT NULL,
  char_start int,
  char_end int,
  characterisation text NOT NULL,                      -- "X argues Y"
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX idx_citation_edges_article ON public.citation_edges(article_id);
-- Dispute-privilege lookup: the cited author disputes via pubkey match.
CREATE INDEX idx_citation_edges_author_pubkey ON public.citation_edges(source_author_pubkey);

-- ---------------------------------------------------------------------------
-- dispute_edges — the counter-edge. Against a credit it renders as a disclaimer;
-- against a citation, as a dispute. Exactly one target. Filed only by an account
-- holder (account + pubkey). The cited/credited party stakes nothing
-- (is_by_cited_author); anyone else holds a refundable dispute_stake.
-- ---------------------------------------------------------------------------
CREATE TABLE public.dispute_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  citation_edge_id uuid REFERENCES public.citation_edges(id),
  credit_edge_id uuid REFERENCES public.credit_edges(id),
  disputant_account_id uuid NOT NULL REFERENCES public.accounts(id),
  disputant_pubkey text NOT NULL,
  is_by_cited_author boolean NOT NULL,                 -- pubkey/account match vs the target
  nostr_event_id text,                                 -- native/Nostr targets only
  nostr_d_tag text,                                    -- addressable: disputant revises in place
  wider_excerpt text,                                  -- optional re-pin to expose stripped context
  wider_excerpt_sha256 bytea,
  counter_characterisation text NOT NULL,
  stake_ledger_entry_id uuid REFERENCES public.ledger_entries(id),  -- set for third-party (staked) disputes
  withdrawn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT dispute_edges_single_target CHECK ((citation_edge_id IS NULL) <> (credit_edge_id IS NULL))
);

CREATE INDEX idx_dispute_edges_citation ON public.dispute_edges(citation_edge_id);
CREATE INDEX idx_dispute_edges_credit ON public.dispute_edges(credit_edge_id);

-- ---------------------------------------------------------------------------
-- Ledger: widen ledger_reader_balance to count the two new tab-affecting
-- triggers. Columns unchanged (account_id, balance_pence), so CREATE OR REPLACE
-- is safe. The triggers themselves are added to the TS LedgerTriggerType union
-- in shared/src/lib/ledger.ts (no DDL — the column is plain text).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.ledger_reader_balance AS
SELECT account_id,
       (-SUM(amount_pence))::bigint AS balance_pence
FROM public.ledger_entries
WHERE trigger_type IN (
  'read_accrual', 'vote_charge', 'pledge_fulfil',
  'tab_settlement', 'subscription_credit', 'opening_balance',
  'dispute_stake', 'dispute_stake_refund'
)
GROUP BY account_id;

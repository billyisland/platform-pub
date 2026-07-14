-- 155: pre-position the VAT/tax schema on tab_settlements (empty, unused)
--
-- PAYMENTS-FIXES-AND-DILEMMAS §1.5 / §D. Part 2 (§2.1) may resolve to Merchant
-- of Record, at which point the platform becomes seller-of-record and every
-- settlement carries a VAT position. Retro-deriving tax positions from
-- historical settlement rows is miserable; carrying nullable columns now is
-- cheap. These stay UNUSED until a Part-2 pivot fills them (Branch B) — the
-- settlement is the natural invoice unit (one settlement = one consolidated
-- supply; per-read VAT at pence granularity is not viable under any model).
--
--   vat_pence     — VAT charged on the settlement, in pence (NULL = not computed)
--   vat_rate_bps  — the VAT rate applied, in basis points (2000 = 20%)
--   tax_point     — the tax point (time of supply) for the settlement
--
-- The `vat` ledger trigger type is added alongside in shared/src/lib/ledger.ts
-- (a TS union, not a DB CHECK — see §D correction 4); no DB change needed there.

ALTER TABLE tab_settlements
  ADD COLUMN vat_pence integer,
  ADD COLUMN vat_rate_bps integer,
  ADD COLUMN tax_point timestamptz;

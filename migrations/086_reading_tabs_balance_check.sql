ALTER TABLE reading_tabs ADD CONSTRAINT reading_tabs_balance_non_negative CHECK (balance_pence >= 0);

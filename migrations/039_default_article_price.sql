-- Add default per-article price to accounts.
-- NULL means "use auto-suggest based on word count" (existing behaviour).
-- When set, the editor uses this as the starting price for new paywalled articles.
ALTER TABLE accounts ADD COLUMN default_article_price_pence INT;

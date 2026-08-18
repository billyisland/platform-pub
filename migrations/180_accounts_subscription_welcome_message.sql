-- =============================================================================
-- 180 — a writer's own words at the one moment a reader is listening
--
-- CONSOLIDATED-TODO §4.2 (Subscriptions Phase 2, step 8 of
-- `docs/audits/SUBSCRIPTIONS-GAP-ANALYSIS.md`). Subscribing is the only moment
-- in the product where a reader has just chosen a particular writer and is
-- waiting to hear from them. Today that moment is silent on the reader's side:
-- `sendNewSubscriberEmail` tells the WRITER they have gained someone, and the
-- reader gets nothing at all. This column is the writer's half of that
-- exchange.
--
-- WHY ON `accounts` AND NOT ON `subscriptions`. The message is a fact about the
-- writer — one string they compose once and every future subscriber receives —
-- not a fact about any particular subscription. Putting it on `subscriptions`
-- would copy it per reader and leave every historical row holding a stale draft
-- the writer has since rewritten. It sits beside the writer's other standing
-- subscription settings (`subscription_price_pence`, `annual_discount_pct`,
-- `default_article_price_pence`), which is where the settings route already
-- looks.
--
-- WHY PLAIN TEXT, NOT HTML. The value is escaped into the email body at send
-- time (`escapeHtml`, as every other string in `subscription-emails.ts` is).
-- Storing HTML would make a writer-authored string a markup injection surface
-- reaching every one of their subscribers' inboxes, and no part of this feature
-- needs it: the template already supplies the heading, the wrapper and the
-- button. A writer wanting emphasis gets it in Phase 3 or not at all.
--
-- NULL IS NOT THE EMPTY STRING, and the difference is the whole feature. NULL
-- means "this writer has never set one", and the reader is sent the default
-- template — a real welcome, in the platform's voice, naming the writer. The
-- empty string means "this writer deliberately cleared it". Both send the
-- default today, and they are kept distinct so that a later "send nothing at
-- all" opt-out has a value to hang on without a second column and without
-- silently reinterpreting every row that predates it.
--
-- NULLABLE, NO DEFAULT — the deploy-safety statement §0p.2 asks every migration
-- to make. Safe in BOTH orderings: old code never names the column and is
-- unaffected by a migrated DB; new code reads NULL as "use the default", which
-- is the correct reading for every row that exists when this runs. There is no
-- window in which either half is broken by the other, and no backfill: every
-- existing writer correctly reads as never having set one.
--
-- THE CHECK IS A CEILING, NOT VALIDATION. The route validates with zod and is
-- where a writer's mistake is reported to them. This bound exists so that no
-- path which forgets to — a future import, a script, a hand-run UPDATE — can
-- put an unbounded blob into a string that is rendered into an email body and
-- sent to every subscriber the writer has. 2,000 characters is roughly three
-- times the longest sensible welcome and well under any provider's body limit.
-- =============================================================================

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS subscription_welcome_message text;

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_subscription_welcome_message_length;
ALTER TABLE accounts ADD CONSTRAINT accounts_subscription_welcome_message_length
  CHECK (subscription_welcome_message IS NULL
         OR char_length(subscription_welcome_message) <= 2000);

COMMENT ON COLUMN accounts.subscription_welcome_message IS
  'Writer-composed plain-text welcome, sent to a reader on subscribing. NULL = never set, send the default template. Escaped at send time; never store HTML.';

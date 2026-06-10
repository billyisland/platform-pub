# Schema Reference (2026-05-15)

Companion to `schema.sql` (83 tables, 151 indexes, 157 FKs, 50 CHECK constraints, 8 triggers, 5 functions). This document covers non-obvious structural decisions. Do not duplicate here what the DDL already says plainly.

---

## 1. CHECK Constraints Catalogue

### Content & Articles

| Table             | Constraint                                  | Enforces                                                                                                  |
| ----------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `articles`        | `access_mode_price`                         | `paywalled` requires `price_pence IS NOT NULL`; `public` and `invitation_only` have no price requirement  |
| `articles`        | `articles_gate_position_pct_check`          | Paywall gate position must be 1-99%                                                                       |
| `articles`        | `articles_publication_article_status_check` | Enum: `submitted`, `approved`, `published`, `unpublished`                                                 |
| `articles`        | `articles_size_tier_check`                  | Nullable; when set must be `lead`, `standard`, or `brief`                                                 |
| `article_unlocks` | `article_unlocks_unlocked_via_check`        | Enum: `purchase`, `subscription`, `own_content`, `free_allowance`, `author_grant`, `pledge`, `invitation` |

### Publications

| Table                        | Constraint                                    | Enforces                                        |
| ---------------------------- | --------------------------------------------- | ----------------------------------------------- |
| `publications`               | `publications_status_check`                   | Enum: `active`, `suspended`, `archived`         |
| `publications`               | `publications_article_price_mode_check`       | Enum: `per_article`, `per_1000_words`           |
| `publications`               | `publications_homepage_layout_check`          | Enum: `blog`, `magazine`, `minimal`             |
| `accounts`                   | `accounts_annual_discount_pct_check`          | 0-30% range                                     |
| `accounts`                   | `accounts_hosting_type_check`                 | Enum: `hosted`, `self_hosted`                   |
| `publication_article_shares` | `publication_article_shares_share_type_check` | Enum: `revenue_bps`, `flat_fee_pence`           |
| `publication_payout_splits`  | `publication_payout_splits_share_type_check`  | Enum: `standing`, `article_revenue`, `flat_fee` |

### Payments & Reading

| Table                 | Constraint                               | Enforces                                                                                        |
| --------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `reading_positions`   | `reading_positions_scroll_ratio_check`   | 0.0-1.0 range                                                                                   |
| `tab_settlements`     | `tab_settlements_trigger_type_check`     | Enum: `threshold`, `monthly_fallback`                                                           |
| `votes`               | `votes_direction_check`                  | Enum: `up`, `down`                                                                              |
| `subscription_events` | `subscription_events_event_type_check`   | Enum: `subscription_charge`, `subscription_earning`, `subscription_read`, `expiry_warning_sent` |
| `subscription_offers` | `subscription_offers_discount_pct_check` | 0-100% range                                                                                    |
| `subscription_offers` | `subscription_offers_mode_check`         | Enum: `code`, `grant`                                                                           |
| `subscriptions`       | `subscriptions_status_check`             | Enum: `active`, `cancelled`, `expired`                                                          |
| `subscriptions`       | `subscriptions_target_check`             | Exactly one of `writer_id` or `publication_id` must be non-null (`num_nonnulls = 1`)            |

### Feeds & External

| Table              | Constraint                         | Enforces                                                                                                            |
| ------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `external_sources` | `protocol_tier_consistency`        | `nostr_external` = tier2, `atproto`/`activitypub` = tier3, `rss` = tier4. Encodes content quality hierarchy         |
| `feed_items`       | `exactly_one_source`               | Exactly one of `article_id`, `note_id`, `external_item_id` must be non-null. Union-table discipline                 |
| `feed_items`       | `feed_items_item_type_check`       | Enum: `article`, `note`, `external`                                                                                 |
| `feed_items`       | `tier_consistency`                 | Native items (`article`/`note`) must be tier1; external items have no tier constraint (tier set by source protocol) |
| `feed_sources`     | `feed_sources_source_type_check`   | Enum: `account`, `publication`, `external_source`, `tag`                                                            |
| `feed_sources`     | `feed_sources_sampling_mode_check` | Enum: `chronological`, `scored`, `random`                                                                           |
| `feed_sources`     | `feed_sources_target_matches_type` | Discriminated union: each `source_type` must have exactly its corresponding FK set, all others null                 |
| `feed_sources`     | `feed_sources_tag_name_length`     | `tag_name` 1-64 characters when non-null (migration 089)                                                            |
| `feeds`            | `feeds_name_length`                | 1-80 characters                                                                                                     |
| `outbound_posts`   | `outbound_posts_action_type_check` | Enum: `reply`, `quote`, `repost`, `original`                                                                        |
| `outbound_posts`   | `outbound_posts_status_check`      | Enum: `pending`, `sent`, `failed`, `retrying`                                                                       |

### Relay Outbox

| Table          | Constraint                       | Enforces                                                                                                                                                                            |
| -------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relay_outbox` | `relay_outbox_entity_type_check` | Enum: `article`, `article_deletion`, `note`, `note_deletion`, `subscription`, `receipt`, `drive`, `drive_deletion`, `signing_passthrough`, `conversation_pulse`, `account_deletion` |
| `relay_outbox` | `relay_outbox_status_check`      | Enum: `pending`, `sent`, `failed`, `abandoned`                                                                                                                                      |

### Trust Graph

| Table            | Constraint                       | Enforces                                                                                                                      |
| ---------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `vouches`        | `vouches_check`                  | No self-vouching (`attestor_id <> subject_id`)                                                                                |
| `vouches`        | `vouches_check1`                 | Contests must be aggregate visibility (`value = 'contest'` implies `visibility = 'aggregate'`). Public contests are forbidden |
| `vouches`        | `vouches_dimension_check`        | Enum: `humanity`, `encounter`, `identity`, `integrity`                                                                        |
| `vouches`        | `vouches_value_check`            | Enum: `affirm`, `contest`                                                                                                     |
| `vouches`        | `vouches_visibility_check`       | Enum: `public`, `aggregate`                                                                                                   |
| `trust_profiles` | `trust_profiles_dimension_check` | Same four dimensions as vouches                                                                                               |
| `trust_layer1`   | `trust_layer1_pip_status_check`  | Enum: `known`, `partial`, `unknown`, `contested`                                                                              |
| `trust_polls`    | `trust_polls_no_self`            | No self-polling (`respondent_id <> subject_id`)                                                                               |
| `trust_polls`    | `trust_polls_question_check`     | Enum: `humanity`, `authenticity`, `good_faith`                                                                                |
| `trust_polls`    | `trust_polls_answer_check`       | Enum: `yes`, `no`                                                                                                             |
| `trust_epochs`   | `trust_epochs_type_check`        | Enum: `full`, `mopup`                                                                                                         |

### Pledge Drives

| Table           | Constraint                               | Enforces                  |
| --------------- | ---------------------------------------- | ------------------------- |
| `pledge_drives` | `pledge_drives_backer_access_mode_check` | Enum: `free`, `paywalled` |

### Traffology

| Table                        | Constraint                                     | Enforces                                                                       |
| ---------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `traffology.observations`    | `observations_priority_check`                  | 1-5 range                                                                      |
| `traffology.public_mentions` | `public_mentions_platform_check`               | Enum: `bluesky`, `mastodon`, `reddit`, `hackernews`, `twitter`, `other`        |
| `traffology.public_mentions` | `public_mentions_attribution_confidence_check` | Enum: `direct`, `inferred`, `found`                                            |
| `traffology.sessions`        | `sessions_device_type_check`                   | Enum: `desktop`, `mobile`, `tablet`                                            |
| `traffology.sessions`        | `sessions_subscriber_status_check`             | Enum: `anonymous`, `free`, `paying`                                            |
| `traffology.sources`         | `sources_source_type_check`                    | Enum: `mailing-list`, `search`, `link`, `nostr`, `direct`, `platform-internal` |

---

## 2. Partial Indexes

Partial indexes (with WHERE clauses) encode the query patterns the application actually uses. Grouped by purpose.

### Soft-delete filters (`deleted_at IS NULL`)

| Index                   | Table        | Columns                           | Purpose                                                                 |
| ----------------------- | ------------ | --------------------------------- | ----------------------------------------------------------------------- |
| `idx_feed_items_cursor` | `feed_items` | `(published_at DESC, id DESC)`    | Primary timeline cursor. Compound for keyset pagination                 |
| `idx_feed_items_author` | `feed_items` | `(author_id, published_at DESC)`  | Per-author feed view                                                    |
| `idx_feed_items_score`  | `feed_items` | `(score DESC, published_at DESC)` | Explore/ranked feed                                                     |
| `idx_feed_items_source` | `feed_items` | `(source_id, published_at DESC)`  | Per-external-source windowed cap. Also requires `source_id IS NOT NULL` |
| `idx_feed_items_type`   | `feed_items` | `(item_type, published_at DESC)`  | Type-filtered feeds                                                     |
| `idx_comments_target`   | `comments`   | `(target_event_id, published_at)` | Thread loading for non-deleted comments                                 |

### Active-record filters

| Index                          | Table                 | Columns                    | WHERE                                            | Purpose                                             |
| ------------------------------ | --------------------- | -------------------------- | ------------------------------------------------ | --------------------------------------------------- |
| `idx_subscriptions_status`     | `subscriptions`       | `(status)`                 | `status IN ('active','cancelled')`               | Active subscription lookups (excludes expired)      |
| `idx_subscriptions_period_end` | `subscriptions`       | `(current_period_end)`     | `status IN ('active','cancelled')`               | Expiry worker scans                                 |
| `idx_pub_members_account`      | `publication_members` | `(account_id)`             | `removed_at IS NULL`                             | "My publications" query                             |
| `idx_pub_members_publication`  | `publication_members` | `(publication_id)`         | `removed_at IS NULL`                             | Publication roster                                  |
| `idx_pub_invites_email`        | `publication_invites` | `(invited_email)`          | `accepted_at IS NULL AND declined_at IS NULL`    | Pending invite lookup                               |
| `idx_pub_invites_token`        | `publication_invites` | `(token)`                  | `accepted_at IS NULL AND declined_at IS NULL`    | Token redemption                                    |
| `idx_vouches_attestor`         | `vouches`             | `(attestor_id)`            | `withdrawn_at IS NULL`                           | "My active vouches"                                 |
| `idx_vouches_subject`          | `vouches`             | `(subject_id)`             | `withdrawn_at IS NULL`                           | Trust profile aggregation                           |
| `idx_vouches_public`           | `vouches`             | `(subject_id, dimension)`  | `visibility = 'public' AND withdrawn_at IS NULL` | Public endorsement display                          |
| `feed_sources_feed_active_idx` | `feed_sources`        | `(feed_id, sampling_mode)` | `muted_at IS NULL`                               | `sourceFilteredItems` feed_mode CTE (migration 089) |
| `idx_ext_sources_next_fetch`   | `external_sources`    | `(last_fetched_at)`        | `is_active = true`                               | Poll scheduler picks next source to fetch           |
| `idx_ext_sources_protocol`     | `external_sources`    | `(protocol)`               | `is_active = true`                               | Protocol-filtered source listing                    |
| `idx_ext_sources_orphaned`     | `external_sources`    | `(orphaned_at)`            | `orphaned_at IS NOT NULL`                        | Orphan cleanup cron                                 |

### Sparse/nullable column indexes

| Index                            | Table                 | Columns                           | WHERE                                | Purpose                                     |
| -------------------------------- | --------------------- | --------------------------------- | ------------------------------------ | ------------------------------------------- |
| `idx_accounts_email`             | `accounts`            | `(email)`                         | `email IS NOT NULL`                  | Login lookup (some accounts have no email)  |
| `idx_accounts_display_name_trgm` | `accounts`            | GIN `(display_name gin_trgm_ops)` | `display_name IS NOT NULL`           | Fuzzy name search                           |
| `idx_accounts_is_writer`         | `accounts`            | `(is_writer)`                     | `is_writer = true`                   | Writer-only queries                         |
| `idx_articles_publication`       | `articles`            | `(publication_id)`                | `publication_id IS NOT NULL`         | Publication article listing                 |
| `idx_articles_published_at`      | `articles`            | `(published_at DESC)`             | `published_at IS NOT NULL`           | Published articles only (excludes drafts)   |
| `idx_drafts_scheduled`           | `article_drafts`      | `(scheduled_at)`                  | `scheduled_at IS NOT NULL`           | Scheduler worker picks due drafts           |
| `idx_comments_parent`            | `comments`            | `(parent_comment_id)`             | `parent_comment_id IS NOT NULL`      | Thread child lookup                         |
| `idx_dm_reply_to`                | `direct_messages`     | `(reply_to_id)`                   | `reply_to_id IS NOT NULL`            | DM reply chain                              |
| `idx_notes_reply_to`             | `notes`               | `(reply_to_event_id)`             | `reply_to_event_id IS NOT NULL`      | Note reply threads                          |
| `idx_notifications_note`         | `notifications`       | `(note_id)`                       | `note_id IS NOT NULL`                | Note-triggered notification dedup           |
| `idx_publications_custom_domain` | `publications`        | `(custom_domain)`                 | `custom_domain IS NOT NULL`          | Custom domain routing                       |
| `idx_sub_offers_code`            | `subscription_offers` | `(code)`                          | `code IS NOT NULL`                   | Promo code redemption                       |
| `idx_sub_offers_recipient`       | `subscription_offers` | `(recipient_id)`                  | `recipient_id IS NOT NULL`           | Grant-mode offer lookup                     |
| `idx_ext_items_source_reply`     | `external_items`      | `(source_reply_uri)`              | `source_reply_uri IS NOT NULL`       | Reply thread stitching for external content |
| `idx_feed_scores_publication`    | `feed_scores`         | `(publication_id, score DESC)`    | `publication_id IS NOT NULL`         | Per-publication ranked content              |
| `idx_drives_parent_conv`         | `pledge_drives`       | `(parent_conversation_id)`        | `parent_conversation_id IS NOT NULL` | Conversation-anchored drives                |
| `idx_drives_parent_note`         | `pledge_drives`       | `(parent_note_event_id)`          | `parent_note_event_id IS NOT NULL`   | Note-anchored drives                        |
| `idx_vote_charges_recipient_id`  | `vote_charges`        | `(recipient_id)`                  | `recipient_id IS NOT NULL`           | Payout aggregation                          |
| `idx_vote_charges_tab_id`        | `vote_charges`        | `(tab_id)`                        | `tab_id IS NOT NULL`                 | Tab settlement joins                        |

### Job queue indexes

| Index                         | Table             | Columns              | WHERE                                             | Purpose                             |
| ----------------------------- | ----------------- | -------------------- | ------------------------------------------------- | ----------------------------------- |
| `relay_outbox_ready_idx`      | `relay_outbox`    | `(next_attempt_at)`  | `status IN ('pending','failed')`                  | Worker picks next relay publish job |
| `idx_outbound_posts_pending`  | `outbound_posts`  | `(status)`           | `status IN ('pending','retrying')`                | Cross-post worker queue scan        |
| `idx_magic_links_token_hash`  | `magic_links`     | `(token_hash)`       | `used_at IS NULL`                                 | Unused magic link verification      |
| `idx_magic_links_expires`     | `magic_links`     | `(expires_at)`       | `used_at IS NULL`                                 | Expiry cleanup of unused links      |
| `idx_network_presences_refresh` | `network_presences` | `(token_expires_at)` | `is_valid = true AND credentials_enc IS NOT NULL` | OAuth token refresh cron (was `idx_linked_accounts_refresh` on `linked_accounts`; renamed by migration 109) |

### Traffology partial indexes

| Index                         | Table                     | Columns                       | WHERE                        | Purpose                    |
| ----------------------------- | ------------------------- | ----------------------------- | ---------------------------- | -------------------------- |
| `idx_traf_observations_piece` | `traffology.observations` | `(piece_id, created_at DESC)` | `piece_id IS NOT NULL`       | Per-piece observation feed |
| `idx_traf_pieces_nostr`       | `traffology.pieces`       | `(nostr_event_id)`            | `nostr_event_id IS NOT NULL` | Nostr event correlation    |
| `idx_traf_pieces_publication` | `traffology.pieces`       | `(publication_id)`            | `publication_id IS NOT NULL` | Publication analytics      |
| `idx_traf_sources_domain`     | `traffology.sources`      | `(writer_id, domain)`         | `domain IS NOT NULL`         | Per-writer source dedup    |

---

## 3. Triggers

8 triggers using 5 functions.

| Trigger                        | Table           | Event                      | Function                         | Behaviour                                                                                                              |
| ------------------------------ | --------------- | -------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `trg_accounts_updated_at`      | `accounts`      | BEFORE UPDATE              | `set_updated_at()`               | Sets `updated_at = now()`                                                                                              |
| `trg_articles_updated_at`      | `articles`      | BEFORE UPDATE              | `set_updated_at()`               | Sets `updated_at = now()`                                                                                              |
| `trg_pledge_drives_updated_at` | `pledge_drives` | BEFORE UPDATE              | `set_updated_at()`               | Sets `updated_at = now()`                                                                                              |
| `trg_reading_tabs_updated_at`  | `reading_tabs`  | BEFORE UPDATE              | `set_updated_at()`               | Sets `updated_at = now()`                                                                                              |
| `feeds_touch_updated_at`       | `feeds`         | BEFORE UPDATE              | `feeds_touch_updated_at()`       | Sets `updated_at = now()` (identical to `set_updated_at` but separately defined)                                       |
| `trust_polls_touch_updated_at` | `trust_polls`   | BEFORE UPDATE              | `trust_polls_touch_updated_at()` | Sets `updated_at = now()` (identical to `set_updated_at` but separately defined)                                       |
| `articles_size_tier_default`   | `articles`      | BEFORE INSERT              | `articles_derive_size_tier()`    | Auto-derives `size_tier` from `word_count` when not explicitly set: >=3000 = `lead`, <1000 = `brief`, else `standard`  |
| `feed_sources_touch_parent`    | `feed_sources`  | AFTER INSERT/DELETE/UPDATE | `feed_sources_touch_parent()`    | Propagates change timestamp to parent `feeds.updated_at`. This is a cross-table side-effect trigger, not a self-update |

Note: `feeds_touch_updated_at` and `trust_polls_touch_updated_at` are functionally identical to `set_updated_at`. They were likely created in separate migrations. Consolidating to `set_updated_at` would be a safe cleanup.

---

## 4. Notable FK Patterns

### 4a. FKs with no ON DELETE action (default NO ACTION)

These FKs will block deletion of the referenced row if any referencing rows exist. This is the strictest behavior -- stricter even than RESTRICT in PostgreSQL (both block, but NO ACTION is deferrable while RESTRICT is not, though none of these are declared DEFERRABLE).

**Content ownership (articles, drafts, subscriptions on publication_id)**

| Constraint                           | Table.Column                    | References         |
| ------------------------------------ | ------------------------------- | ------------------ |
| `articles_publication_id_fkey`       | `articles.publication_id`       | `publications(id)` |
| `article_drafts_publication_id_fkey` | `article_drafts.publication_id` | `publications(id)` |
| `subscriptions_publication_id_fkey`  | `subscriptions.publication_id`  | `publications(id)` |
| `subscriptions_reader_id_fkey`       | `subscriptions.reader_id`       | `accounts(id)`     |
| `subscriptions_writer_id_fkey`       | `subscriptions.writer_id`       | `accounts(id)`     |

Effect: cannot delete a publication that has articles, drafts, or subscriptions. Must archive/reassign first.

**Trust graph (vouches, trust_profiles, trust_layer1 on user_id)**

| Constraint                    | Table.Column             | References     |
| ----------------------------- | ------------------------ | -------------- |
| `vouches_attestor_id_fkey`    | `vouches.attestor_id`    | `accounts(id)` |
| `vouches_subject_id_fkey`     | `vouches.subject_id`     | `accounts(id)` |
| `trust_profiles_user_id_fkey` | `trust_profiles.user_id` | `accounts(id)` |
| `trust_layer1_user_id_fkey`   | `trust_layer1.user_id`   | `accounts(id)` |

Effect: cannot delete an account that has trust data. The trust cron tables (`trust_layer1`, `trust_profiles`) and vouches must be cleaned up first.

**Payment chain**

| Constraint                              | Table.Column                       | References                |
| --------------------------------------- | ---------------------------------- | ------------------------- |
| `article_unlocks_article_id_fkey`       | `article_unlocks.article_id`       | `articles(id)`            |
| `article_unlocks_reader_id_fkey`        | `article_unlocks.reader_id`        | `accounts(id)`            |
| `article_unlocks_subscription_id_fkey`  | `article_unlocks.subscription_id`  | `subscriptions(id)`       |
| `pledges_drive_id_fkey`                 | `pledges.drive_id`                 | `pledge_drives(id)`       |
| `pledges_pledger_id_fkey`               | `pledges.pledger_id`               | `accounts(id)`            |
| `pledges_read_event_id_fkey`            | `pledges.read_event_id`            | `read_events(id)`         |
| `pledge_drives_article_id_fkey`         | `pledge_drives.article_id`         | `articles(id)`            |
| `pledge_drives_creator_id_fkey`         | `pledge_drives.creator_id`         | `accounts(id)`            |
| `pledge_drives_draft_id_fkey`           | `pledge_drives.draft_id`           | `article_drafts(id)`      |
| `pledge_drives_target_writer_id_fkey`   | `pledge_drives.target_writer_id`   | `accounts(id)`            |
| `subscription_offers_recipient_id_fkey` | `subscription_offers.recipient_id` | `accounts(id)`            |
| `subscriptions_offer_id_fkey`           | `subscriptions.offer_id`           | `subscription_offers(id)` |

**Other NO ACTION FKs**

| Constraint                                    | Table.Column                             | References          |
| --------------------------------------------- | ---------------------------------------- | ------------------- |
| `conversations_created_by_fkey`               | `conversations.created_by`               | `accounts(id)`      |
| `dm_pricing_owner_id_fkey`                    | `dm_pricing.owner_id`                    | `accounts(id)`      |
| `dm_pricing_target_id_fkey`                   | `dm_pricing.target_id`                   | `accounts(id)`      |
| `feed_scores_publication_id_fkey`             | `feed_scores.publication_id`             | `publications(id)`  |
| `publication_invites_invited_account_id_fkey` | `publication_invites.invited_account_id` | `accounts(id)`      |
| `publication_payout_splits_account_id_fkey`   | `publication_payout_splits.account_id`   | `accounts(id)`      |
| `publication_payout_splits_article_id_fkey`   | `publication_payout_splits.article_id`   | `articles(id)`      |
| `publication_payouts_publication_id_fkey`     | `publication_payouts.publication_id`     | `publications(id)`  |
| `read_events_via_subscription_id_fkey`        | `read_events.via_subscription_id`        | `subscriptions(id)` |
| `subscription_events_article_id_fkey`         | `subscription_events.article_id`         | `articles(id)`      |
| `subscription_events_reader_id_fkey`          | `subscription_events.reader_id`          | `accounts(id)`      |
| `subscription_events_writer_id_fkey`          | `subscription_events.writer_id`          | `accounts(id)`      |
| `subscription_nudge_log_publication_id_fkey`  | `subscription_nudge_log.publication_id`  | `publications(id)`  |
| `vote_charges_recipient_id_fkey`              | `vote_charges.recipient_id`              | `accounts(id)`      |
| `vote_charges_vote_id_fkey`                   | `vote_charges.vote_id`                   | `votes(id)`         |
| `vote_charges_voter_id_fkey`                  | `vote_charges.voter_id`                  | `accounts(id)`      |

### 4b. Cross-schema FKs (traffology -> public)

All traffology tables reference the public schema for identity and content linkage:

| traffology Table        | FK                  | References                         |
| ----------------------- | ------------------- | ---------------------------------- |
| `pieces`                | `article_id`        | `public.articles(id)` CASCADE      |
| `pieces`                | `writer_id`         | `public.accounts(id)` CASCADE      |
| `pieces`                | `publication_id`    | `public.publications(id)` SET NULL |
| `observations`          | `writer_id`         | `public.accounts(id)` CASCADE      |
| `sources`               | `writer_id`         | `public.accounts(id)` CASCADE      |
| `sources`               | `allhaus_writer_id` | `public.accounts(id)` SET NULL     |
| `publication_baselines` | `publication_id`    | `public.publications(id)` CASCADE  |
| `writer_baselines`      | `writer_id`         | `public.accounts(id)` CASCADE      |
| `topic_performance`     | `writer_id`         | `public.accounts(id)` CASCADE      |

Note: `pieces.publication_id` uses SET NULL (not CASCADE) so analytics survive publication archival.

### 4c. Surprising cascade chains

**Account deletion → feed_items author nullification**: `feed_items.author_id` uses SET NULL on account deletion, preserving the timeline row with a null author. But `feed_items.article_id` / `note_id` / `external_item_id` use CASCADE, so deleting the underlying content removes the feed row entirely.

**External source deletion → multi-table cascade**: Deleting an `external_source` cascades to `external_items` (CASCADE), which cascades to `feed_items` (CASCADE). It also cascades to `external_subscriptions` and `feed_sources`. A single source deletion can thus remove content across three tables.

**Articles are deletion-resistant**: `articles` accumulate NO ACTION FKs from `article_unlocks`, `pledge_drives`, `publication_payout_splits`, `subscription_events`, plus RESTRICT from `read_events`, `content_key_issuances`, `vault_keys`. An article with any payment history, unlock record, key issuance, or payout split cannot be hard-deleted. This is by design -- articles use soft-delete (`deleted_at`).

**Reading tab → payment chain**: `reading_tabs` has RESTRICT from `tab_settlements.tab_id`. Tab-linked FKs from `read_events`, `vote_charges`, and `votes` use SET NULL, so those records survive tab changes but the tab itself cannot be deleted while settlements reference it.

---

## 5. Tables with `updated_at` but No Trigger

These tables have an `updated_at` column defaulting to `now()` but no BEFORE UPDATE trigger to auto-maintain it. Application code must set `updated_at` explicitly on updates, or the column will remain at its creation-time value.

| Table                         | Domain        | Risk                                                                                                           |
| ----------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------- |
| `subscriptions`               | Payments      | High -- frequently updated (status, period, auto_renew). Stale `updated_at` could mislead expiry/renewal logic |
| `network_presences`           | Outbound      | Medium -- updated on token refresh, validity changes (was `linked_accounts`; renamed + extended by migration 109, NETWORK-CONCIERGE-ADR) |
| `external_sources`            | Feeds         | Medium -- updated on fetch cycle, error_count changes                                                          |
| `activitypub_instance_health` | Feeds         | Low -- counter table, updated by UPSERT                                                                        |
| `notification_preferences`    | Notifications | Low -- rarely updated                                                                                          |
| `vote_tallies`                | Payments      | Low -- counter table, updated atomically                                                                       |
| `platform_config`             | System        | Low -- rarely updated key-value store                                                                          |
| `atproto_oauth_sessions`      | Auth          | Low -- updated on session refresh                                                                              |

Additional public tables with `updated_at` and no trigger (lower concern): `oauth_app_registrations`, `publication_members`, `publications`, `reading_positions`, `trust_profiles`.

Traffology tables with `updated_at` and no trigger (all are cron-refreshed aggregates where application code controls the timestamp): `piece_stats`, `public_mentions`, `publication_baselines`, `source_stats`, `topic_performance`, `writer_baselines`.

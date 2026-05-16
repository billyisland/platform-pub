-- =============================================================================
-- all.haus — PostgreSQL Schema
-- Generated from migrations 001–084 (2026-05-15).
-- Loaded by Docker initdb.d on first boot; migration runner applies incremental
-- changes after.
--
-- 83 tables (66 public + 17 traffology)
-- 151 indexes | 157 foreign keys | 50 CHECK constraints | 8 triggers
-- =============================================================================



-- Schema: traffology

CREATE SCHEMA traffology;


-- Extension: pg_trgm

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


-- Extension: pgcrypto

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


-- public.account_status

CREATE TYPE public.account_status AS ENUM (
    'active',
    'suspended',
    'moderated',
    'deactivated'
);


-- public.content_tier

CREATE TYPE public.content_tier AS ENUM (
    'tier1',
    'tier2',
    'tier3',
    'tier4'
);


-- public.content_type

CREATE TYPE public.content_type AS ENUM (
    'note',
    'article'
);


-- public.contributor_type

CREATE TYPE public.contributor_type AS ENUM (
    'permanent',
    'one_off'
);


-- public.drive_origin

CREATE TYPE public.drive_origin AS ENUM (
    'crowdfund',
    'commission'
);


-- public.drive_status

CREATE TYPE public.drive_status AS ENUM (
    'open',
    'funded',
    'published',
    'fulfilled',
    'expired',
    'cancelled'
);


-- public.external_protocol

CREATE TYPE public.external_protocol AS ENUM (
    'atproto',
    'activitypub',
    'rss',
    'nostr_external'
);


-- public.payout_status

CREATE TYPE public.payout_status AS ENUM (
    'pending',
    'initiated',
    'completed',
    'failed'
);


-- public.pledge_status

CREATE TYPE public.pledge_status AS ENUM (
    'active',
    'fulfilled',
    'void'
);


-- public.publication_role

CREATE TYPE public.publication_role AS ENUM (
    'editor_in_chief',
    'editor',
    'contributor'
);


-- public.read_state

CREATE TYPE public.read_state AS ENUM (
    'provisional',
    'accrued',
    'platform_settled',
    'writer_paid'
);


-- public.report_category

CREATE TYPE public.report_category AS ENUM (
    'illegal_content',
    'harassment',
    'spam',
    'other'
);


-- public.report_status

CREATE TYPE public.report_status AS ENUM (
    'open',
    'under_review',
    'resolved_removed',
    'resolved_no_action'
);


-- Function: public.articles_derive_size_tier()

CREATE FUNCTION public.articles_derive_size_tier() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.size_tier IS NULL THEN
    NEW.size_tier := CASE
      WHEN NEW.word_count IS NULL       THEN 'standard'
      WHEN NEW.word_count >= 3000       THEN 'lead'
      WHEN NEW.word_count <  1000       THEN 'brief'
      ELSE 'standard'
    END;
  END IF;
  RETURN NEW;
END;
$$;


-- Function: public.feed_sources_touch_parent()

CREATE FUNCTION public.feed_sources_touch_parent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE feeds SET updated_at = now() WHERE id = COALESCE(NEW.feed_id, OLD.feed_id);
  RETURN COALESCE(NEW, OLD);
END;
$$;


-- Function: public.feeds_touch_updated_at()

CREATE FUNCTION public.feeds_touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


-- Function: public.set_updated_at()

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


-- Function: public.trust_polls_touch_updated_at()

CREATE FUNCTION public.trust_polls_touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


-- public._migrations

CREATE TABLE public._migrations (
    id integer NOT NULL,
    filename text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


CREATE SEQUENCE public._migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public._migrations_id_seq OWNED BY public._migrations.id;


-- public.accounts

CREATE TABLE public.accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    nostr_pubkey text NOT NULL,
    nostr_privkey_enc text,
    username text,
    display_name text,
    bio text,
    avatar_blossom_url text,
    is_writer boolean DEFAULT false NOT NULL,
    is_reader boolean DEFAULT true NOT NULL,
    status public.account_status DEFAULT 'active'::public.account_status NOT NULL,
    stripe_customer_id text,
    stripe_connect_id text,
    stripe_connect_kyc_complete boolean DEFAULT false NOT NULL,
    hosting_type text DEFAULT 'hosted'::text NOT NULL,
    self_hosted_relay_url text,
    free_allowance_remaining_pence integer DEFAULT 500 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    email text,
    subscription_price_pence integer DEFAULT 500 NOT NULL,
    annual_discount_pct integer DEFAULT 15 NOT NULL,
    show_commission_button boolean DEFAULT true NOT NULL,
    default_article_price_pence integer,
    sessions_invalidated_at timestamp with time zone,
    username_changed_at timestamp with time zone,
    previous_username text,
    username_redirect_until timestamp with time zone,
    pending_email text,
    email_verification_token text,
    always_open_articles_at_top boolean DEFAULT false NOT NULL,
    email_verification_requested_at timestamp with time zone,
    CONSTRAINT accounts_annual_discount_pct_check CHECK (((annual_discount_pct >= 0) AND (annual_discount_pct <= 30))),
    CONSTRAINT accounts_hosting_type_check CHECK ((hosting_type = ANY (ARRAY['hosted'::text, 'self_hosted'::text])))
);


-- public.activitypub_instance_health

CREATE TABLE public.activitypub_instance_health (
    host text NOT NULL,
    success_count bigint DEFAULT 0 NOT NULL,
    failure_count bigint DEFAULT 0 NOT NULL,
    last_success_at timestamp with time zone,
    last_failure_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.article_drafts

CREATE TABLE public.article_drafts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    writer_id uuid NOT NULL,
    nostr_draft_event_id text,
    nostr_d_tag text,
    title text,
    content_raw text,
    gate_position_pct integer,
    price_pence integer,
    auto_saved_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    publication_id uuid,
    scheduled_at timestamp with time zone,
    cover_image_url text
);


-- public.article_tags

CREATE TABLE public.article_tags (
    article_id uuid NOT NULL,
    tag_id uuid NOT NULL
);


-- public.article_unlocks

CREATE TABLE public.article_unlocks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reader_id uuid NOT NULL,
    article_id uuid NOT NULL,
    unlocked_via text NOT NULL,
    subscription_id uuid,
    unlocked_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT article_unlocks_unlocked_via_check CHECK ((unlocked_via = ANY (ARRAY['purchase'::text, 'subscription'::text, 'own_content'::text, 'free_allowance'::text, 'author_grant'::text, 'pledge'::text, 'invitation'::text])))
);


-- public.articles

CREATE TABLE public.articles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    writer_id uuid NOT NULL,
    nostr_event_id text NOT NULL,
    nostr_d_tag text NOT NULL,
    nostr_kind integer DEFAULT 30023 NOT NULL,
    title text NOT NULL,
    slug text NOT NULL,
    summary text,
    content_free text,
    word_count integer,
    tier public.content_tier DEFAULT 'tier1'::public.content_tier NOT NULL,
    price_pence integer,
    gate_position_pct integer,
    vault_event_id text,
    comments_enabled boolean DEFAULT true NOT NULL,
    published_at timestamp with time zone,
    deleted_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    access_mode text DEFAULT 'public'::text NOT NULL,
    pinned_on_profile boolean DEFAULT false NOT NULL,
    profile_pin_order integer DEFAULT 0 NOT NULL,
    publication_id uuid,
    publication_article_status text,
    show_on_writer_profile boolean DEFAULT true NOT NULL,
    email_sent_at timestamp with time zone,
    size_tier text,
    cover_image_url text,
    CONSTRAINT access_mode_price CHECK (((access_mode = 'public'::text) OR ((access_mode = 'paywalled'::text) AND (price_pence IS NOT NULL)) OR (access_mode = 'invitation_only'::text))),
    CONSTRAINT articles_gate_position_pct_check CHECK (((gate_position_pct >= 1) AND (gate_position_pct <= 99))),
    CONSTRAINT articles_publication_article_status_check CHECK ((publication_article_status = ANY (ARRAY['submitted'::text, 'approved'::text, 'published'::text, 'unpublished'::text]))),
    CONSTRAINT articles_size_tier_check CHECK (((size_tier IS NULL) OR (size_tier = ANY (ARRAY['lead'::text, 'standard'::text, 'brief'::text]))))
);


-- public.atproto_oauth_pending_states

CREATE TABLE public.atproto_oauth_pending_states (
    key text NOT NULL,
    state_data_enc text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.atproto_oauth_sessions

CREATE TABLE public.atproto_oauth_sessions (
    did text NOT NULL,
    session_data_enc text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.blocks

CREATE TABLE public.blocks (
    blocker_id uuid NOT NULL,
    blocked_id uuid NOT NULL,
    blocked_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.bookmarks

CREATE TABLE public.bookmarks (
    user_id uuid NOT NULL,
    article_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.comments

CREATE TABLE public.comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    author_id uuid NOT NULL,
    nostr_event_id text NOT NULL,
    target_event_id text NOT NULL,
    target_kind integer NOT NULL,
    parent_comment_id uuid,
    content text NOT NULL,
    published_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.content_key_issuances

CREATE TABLE public.content_key_issuances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vault_key_id uuid NOT NULL,
    reader_id uuid NOT NULL,
    article_id uuid NOT NULL,
    read_event_id uuid,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    is_reissuance boolean DEFAULT false NOT NULL
);


-- public.conversation_members

CREATE TABLE public.conversation_members (
    conversation_id uuid NOT NULL,
    user_id uuid NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.conversations

CREATE TABLE public.conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_by uuid NOT NULL,
    last_message_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.direct_messages

CREATE TABLE public.direct_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    sender_id uuid NOT NULL,
    recipient_id uuid NOT NULL,
    content_enc text NOT NULL,
    nostr_event_id text,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reply_to_id uuid,
    send_id uuid DEFAULT gen_random_uuid() NOT NULL
);


-- public.dm_likes

CREATE TABLE public.dm_likes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.dm_pricing

CREATE TABLE public.dm_pricing (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid NOT NULL,
    target_id uuid,
    price_pence integer NOT NULL
);


-- public.external_items

CREATE TABLE public.external_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_id uuid NOT NULL,
    protocol public.external_protocol NOT NULL,
    tier public.content_tier NOT NULL,
    source_item_uri text NOT NULL,
    author_name text,
    author_handle text,
    author_avatar_url text,
    author_uri text,
    content_text text,
    content_html text,
    summary text,
    title text,
    language text,
    media jsonb DEFAULT '[]'::jsonb,
    source_reply_uri text,
    source_quote_uri text,
    is_repost boolean DEFAULT false NOT NULL,
    original_item_uri text,
    interaction_data jsonb DEFAULT '{}'::jsonb,
    published_at timestamp with time zone NOT NULL,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT protocol_tier_consistency CHECK ((((protocol = 'nostr_external'::public.external_protocol) AND (tier = 'tier2'::public.content_tier)) OR ((protocol = ANY (ARRAY['atproto'::public.external_protocol, 'activitypub'::public.external_protocol])) AND (tier = 'tier3'::public.content_tier)) OR ((protocol = 'rss'::public.external_protocol) AND (tier = 'tier4'::public.content_tier))))
);


-- public.external_sources

CREATE TABLE public.external_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    protocol public.external_protocol NOT NULL,
    source_uri text NOT NULL,
    display_name text,
    avatar_url text,
    description text,
    relay_urls text[],
    last_fetched_at timestamp with time zone,
    cursor text,
    fetch_interval_seconds integer DEFAULT 300 NOT NULL,
    error_count integer DEFAULT 0 NOT NULL,
    last_error text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    orphaned_at timestamp with time zone,
    metadata_updated_at timestamp with time zone
);


-- public.external_subscriptions

CREATE TABLE public.external_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    subscriber_id uuid NOT NULL,
    source_id uuid NOT NULL,
    is_muted boolean DEFAULT false NOT NULL,
    daily_cap integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.feed_engagement

CREATE TABLE public.feed_engagement (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor_id uuid,
    target_nostr_event_id text NOT NULL,
    target_author_id uuid,
    engagement_type text NOT NULL,
    engaged_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.feed_items

CREATE TABLE public.feed_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_type text NOT NULL,
    article_id uuid,
    note_id uuid,
    external_item_id uuid,
    author_id uuid,
    author_name text NOT NULL,
    author_avatar text,
    author_username text,
    title text,
    content_preview text,
    nostr_event_id text,
    tier public.content_tier DEFAULT 'tier1'::public.content_tier NOT NULL,
    published_at timestamp with time zone NOT NULL,
    source_protocol text,
    source_item_uri text,
    source_id uuid,
    media jsonb,
    score double precision DEFAULT 0 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT exactly_one_source CHECK ((((((article_id IS NOT NULL))::integer + ((note_id IS NOT NULL))::integer) + ((external_item_id IS NOT NULL))::integer) = 1)),
    CONSTRAINT feed_items_item_type_check CHECK ((item_type = ANY (ARRAY['article'::text, 'note'::text, 'external'::text]))),
    CONSTRAINT tier_consistency CHECK ((((item_type = ANY (ARRAY['article'::text, 'note'::text])) AND (tier = 'tier1'::public.content_tier)) OR (item_type = 'external'::text)))
);


-- public.feed_saves

CREATE TABLE public.feed_saves (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid NOT NULL,
    feed_item_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.feed_scores

CREATE TABLE public.feed_scores (
    nostr_event_id text NOT NULL,
    author_id uuid NOT NULL,
    content_type public.content_type NOT NULL,
    score double precision DEFAULT 0 NOT NULL,
    engagement_count integer DEFAULT 0 NOT NULL,
    gate_pass_count integer DEFAULT 0 NOT NULL,
    published_at timestamp with time zone NOT NULL,
    scored_at timestamp with time zone DEFAULT now() NOT NULL,
    publication_id uuid
);


-- public.feed_sources

CREATE TABLE public.feed_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid NOT NULL,
    source_type text NOT NULL,
    account_id uuid,
    publication_id uuid,
    external_source_id uuid,
    tag_name text,
    weight numeric DEFAULT 4.0 NOT NULL,
    sampling_mode text DEFAULT 'chronological'::text NOT NULL,
    muted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT feed_sources_sampling_mode_check CHECK ((sampling_mode = ANY (ARRAY['chronological'::text, 'scored'::text, 'random'::text]))),
    CONSTRAINT feed_sources_source_type_check CHECK ((source_type = ANY (ARRAY['account'::text, 'publication'::text, 'external_source'::text, 'tag'::text]))),
    CONSTRAINT feed_sources_target_matches_type CHECK ((((source_type = 'account'::text) AND (account_id IS NOT NULL) AND (publication_id IS NULL) AND (external_source_id IS NULL) AND (tag_name IS NULL)) OR ((source_type = 'publication'::text) AND (publication_id IS NOT NULL) AND (account_id IS NULL) AND (external_source_id IS NULL) AND (tag_name IS NULL)) OR ((source_type = 'external_source'::text) AND (external_source_id IS NOT NULL) AND (account_id IS NULL) AND (publication_id IS NULL) AND (tag_name IS NULL)) OR ((source_type = 'tag'::text) AND (tag_name IS NOT NULL) AND (account_id IS NULL) AND (publication_id IS NULL) AND (external_source_id IS NULL))))
);


-- public.feeds

CREATE TABLE public.feeds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT feeds_name_length CHECK (((char_length(name) >= 1) AND (char_length(name) <= 80)))
);


-- public.follows

CREATE TABLE public.follows (
    follower_id uuid NOT NULL,
    followee_id uuid NOT NULL,
    followed_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.gift_links

CREATE TABLE public.gift_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    article_id uuid NOT NULL,
    creator_id uuid NOT NULL,
    token text NOT NULL,
    max_redemptions integer DEFAULT 5 NOT NULL,
    redemption_count integer DEFAULT 0 NOT NULL,
    revoked_at timestamp with time zone,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.linked_accounts

CREATE TABLE public.linked_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    protocol public.external_protocol NOT NULL,
    external_id text NOT NULL,
    external_handle text,
    instance_url text,
    credentials_enc text,
    token_expires_at timestamp with time zone,
    last_refreshed_at timestamp with time zone,
    is_valid boolean DEFAULT true NOT NULL,
    cross_post_default boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.magic_links

CREATE TABLE public.magic_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.media_uploads

CREATE TABLE public.media_uploads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    uploader_id uuid NOT NULL,
    blossom_url text NOT NULL,
    sha256 text NOT NULL,
    mime_type text NOT NULL,
    size_bytes integer NOT NULL,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.moderation_reports

CREATE TABLE public.moderation_reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reporter_id uuid,
    target_nostr_event_id text,
    target_account_id uuid,
    category public.report_category NOT NULL,
    notes text,
    status public.report_status DEFAULT 'open'::public.report_status NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.mutes

CREATE TABLE public.mutes (
    muter_id uuid NOT NULL,
    muted_id uuid NOT NULL,
    muted_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.notes

CREATE TABLE public.notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    author_id uuid NOT NULL,
    nostr_event_id text NOT NULL,
    content text NOT NULL,
    char_count integer,
    tier public.content_tier DEFAULT 'tier1'::public.content_tier NOT NULL,
    is_quote_comment boolean DEFAULT false NOT NULL,
    quoted_event_id text,
    quoted_event_kind integer,
    reply_to_event_id text,
    comments_enabled boolean DEFAULT true NOT NULL,
    published_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    quoted_excerpt text,
    quoted_title text,
    quoted_author text
);


-- public.notification_preferences

CREATE TABLE public.notification_preferences (
    user_id uuid NOT NULL,
    category text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.notifications

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    recipient_id uuid NOT NULL,
    actor_id uuid,
    type text NOT NULL,
    article_id uuid,
    comment_id uuid,
    read boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    note_id uuid,
    conversation_id uuid,
    drive_id uuid
);


-- public.oauth_app_registrations

CREATE TABLE public.oauth_app_registrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    protocol public.external_protocol NOT NULL,
    instance_url text NOT NULL,
    client_id text NOT NULL,
    client_secret_enc text NOT NULL,
    scopes text,
    redirect_uri text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.outbound_posts

CREATE TABLE public.outbound_posts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    linked_account_id uuid,
    protocol public.external_protocol NOT NULL,
    nostr_event_id text NOT NULL,
    action_type text NOT NULL,
    source_item_id uuid,
    body_text text,
    external_post_uri text,
    status text DEFAULT 'pending'::text NOT NULL,
    error_message text,
    retry_count integer DEFAULT 0 NOT NULL,
    max_retries integer DEFAULT 3 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    signed_event jsonb,
    CONSTRAINT outbound_posts_action_type_check CHECK ((action_type = ANY (ARRAY['reply'::text, 'quote'::text, 'repost'::text, 'original'::text]))),
    CONSTRAINT outbound_posts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text, 'retrying'::text])))
);


-- public.platform_config

CREATE TABLE public.platform_config (
    key text NOT NULL,
    value text NOT NULL,
    description text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.pledge_drives

CREATE TABLE public.pledge_drives (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    creator_id uuid NOT NULL,
    origin public.drive_origin NOT NULL,
    target_writer_id uuid NOT NULL,
    title text NOT NULL,
    description text,
    funding_target_pence integer,
    current_total_pence integer DEFAULT 0 NOT NULL,
    suggested_price_pence integer,
    status public.drive_status DEFAULT 'open'::public.drive_status NOT NULL,
    article_id uuid,
    draft_id uuid,
    nostr_event_id text,
    pinned boolean DEFAULT true NOT NULL,
    accepted_at timestamp with time zone,
    deadline timestamp with time zone,
    published_at timestamp with time zone,
    fulfilled_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    parent_note_event_id text,
    acceptance_terms text,
    backer_access_mode text DEFAULT 'free'::text,
    parent_conversation_id uuid,
    CONSTRAINT pledge_drives_backer_access_mode_check CHECK ((backer_access_mode = ANY (ARRAY['free'::text, 'paywalled'::text])))
);


-- public.pledges

CREATE TABLE public.pledges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    drive_id uuid NOT NULL,
    pledger_id uuid NOT NULL,
    amount_pence integer NOT NULL,
    status public.pledge_status DEFAULT 'active'::public.pledge_status NOT NULL,
    read_event_id uuid,
    fulfilled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.publication_article_shares

CREATE TABLE public.publication_article_shares (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    publication_id uuid NOT NULL,
    article_id uuid NOT NULL,
    account_id uuid NOT NULL,
    share_type text NOT NULL,
    share_value integer NOT NULL,
    paid_out boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT publication_article_shares_share_type_check CHECK ((share_type = ANY (ARRAY['revenue_bps'::text, 'flat_fee_pence'::text])))
);


-- public.publication_follows

CREATE TABLE public.publication_follows (
    follower_id uuid NOT NULL,
    publication_id uuid NOT NULL,
    followed_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.publication_invites

CREATE TABLE public.publication_invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    publication_id uuid NOT NULL,
    invited_by uuid NOT NULL,
    invited_email text,
    invited_account_id uuid,
    role public.publication_role DEFAULT 'contributor'::public.publication_role NOT NULL,
    contributor_type public.contributor_type DEFAULT 'permanent'::public.contributor_type NOT NULL,
    token text DEFAULT encode(public.gen_random_bytes(32), 'hex'::text) NOT NULL,
    message text,
    expires_at timestamp with time zone DEFAULT (now() + '14 days'::interval) NOT NULL,
    accepted_at timestamp with time zone,
    declined_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.publication_members

CREATE TABLE public.publication_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    publication_id uuid NOT NULL,
    account_id uuid NOT NULL,
    role public.publication_role NOT NULL,
    contributor_type public.contributor_type DEFAULT 'permanent'::public.contributor_type NOT NULL,
    title text,
    is_owner boolean DEFAULT false NOT NULL,
    revenue_share_bps integer,
    can_publish boolean DEFAULT false NOT NULL,
    can_edit_others boolean DEFAULT false NOT NULL,
    can_manage_members boolean DEFAULT false NOT NULL,
    can_manage_finances boolean DEFAULT false NOT NULL,
    can_manage_settings boolean DEFAULT false NOT NULL,
    invited_at timestamp with time zone DEFAULT now() NOT NULL,
    accepted_at timestamp with time zone,
    removed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.publication_payout_splits

CREATE TABLE public.publication_payout_splits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    publication_payout_id uuid NOT NULL,
    account_id uuid NOT NULL,
    share_bps integer,
    amount_pence integer NOT NULL,
    share_type text NOT NULL,
    article_id uuid,
    stripe_transfer_id text,
    status public.payout_status DEFAULT 'pending'::public.payout_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT publication_payout_splits_share_type_check CHECK ((share_type = ANY (ARRAY['standing'::text, 'article_revenue'::text, 'flat_fee'::text])))
);


-- public.publication_payouts

CREATE TABLE public.publication_payouts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    publication_id uuid NOT NULL,
    total_pool_pence integer NOT NULL,
    platform_fee_pence integer NOT NULL,
    flat_fees_paid_pence integer DEFAULT 0 NOT NULL,
    remaining_pool_pence integer NOT NULL,
    status public.payout_status DEFAULT 'pending'::public.payout_status NOT NULL,
    triggered_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.publications

CREATE TABLE public.publications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    tagline text,
    about text,
    logo_blossom_url text,
    cover_blossom_url text,
    nostr_pubkey text NOT NULL,
    nostr_privkey_enc text NOT NULL,
    subscription_price_pence integer DEFAULT 800 NOT NULL,
    annual_discount_pct integer DEFAULT 15 NOT NULL,
    default_article_price_pence integer DEFAULT 20 NOT NULL,
    custom_domain text,
    custom_domain_verified boolean DEFAULT false NOT NULL,
    theme_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    custom_css text,
    stripe_connect_id text,
    stripe_connect_kyc_complete boolean DEFAULT false NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    founded_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    article_price_mode text DEFAULT 'per_article'::text NOT NULL,
    homepage_layout text DEFAULT 'blog'::text NOT NULL,
    CONSTRAINT publications_article_price_mode_check CHECK ((article_price_mode = ANY (ARRAY['per_article'::text, 'per_1000_words'::text]))),
    CONSTRAINT publications_homepage_layout_check CHECK ((homepage_layout = ANY (ARRAY['blog'::text, 'magazine'::text, 'minimal'::text]))),
    CONSTRAINT publications_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'archived'::text])))
);


-- public.read_events

CREATE TABLE public.read_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reader_id uuid NOT NULL,
    article_id uuid NOT NULL,
    writer_id uuid NOT NULL,
    tab_id uuid,
    amount_pence integer NOT NULL,
    state public.read_state DEFAULT 'provisional'::public.read_state NOT NULL,
    receipt_nostr_event_id text,
    reader_pubkey_hash text,
    reader_pubkey text,
    receipt_token text,
    tab_settlement_id uuid,
    writer_payout_id uuid,
    on_free_allowance boolean DEFAULT false NOT NULL,
    read_at timestamp with time zone DEFAULT now() NOT NULL,
    state_updated_at timestamp with time zone DEFAULT now() NOT NULL,
    via_subscription_id uuid,
    is_subscription_read boolean DEFAULT false NOT NULL
);


-- public.reading_positions

CREATE TABLE public.reading_positions (
    user_id uuid NOT NULL,
    article_id uuid NOT NULL,
    scroll_ratio real NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reading_positions_scroll_ratio_check CHECK (((scroll_ratio >= (0)::double precision) AND (scroll_ratio <= (1)::double precision)))
);


-- public.reading_tabs

CREATE TABLE public.reading_tabs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reader_id uuid NOT NULL,
    balance_pence integer DEFAULT 0 NOT NULL,
    last_read_at timestamp with time zone,
    last_settled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.relay_outbox

CREATE TABLE public.relay_outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid,
    signed_event jsonb NOT NULL,
    target_relay_urls text[] DEFAULT ARRAY[]::text[] NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 10 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_attempt_at timestamp with time zone,
    last_error text,
    sent_at timestamp with time zone,
    CONSTRAINT relay_outbox_entity_type_check CHECK ((entity_type = ANY (ARRAY['article'::text, 'article_deletion'::text, 'note'::text, 'note_deletion'::text, 'subscription'::text, 'receipt'::text, 'drive'::text, 'drive_deletion'::text, 'signing_passthrough'::text, 'conversation_pulse'::text, 'account_deletion'::text]))),
    CONSTRAINT relay_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text, 'abandoned'::text])))
);


-- public.resolver_async_results

CREATE TABLE public.resolver_async_results (
    request_id uuid NOT NULL,
    initiator_id uuid NOT NULL,
    result jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.stripe_webhook_events

CREATE TABLE public.stripe_webhook_events (
    event_id text NOT NULL,
    event_type text NOT NULL,
    processed_at timestamp with time zone,
    received_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.subscription_events

CREATE TABLE public.subscription_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    subscription_id uuid NOT NULL,
    event_type text NOT NULL,
    reader_id uuid NOT NULL,
    writer_id uuid NOT NULL,
    article_id uuid,
    amount_pence integer DEFAULT 0 NOT NULL,
    period_start timestamp with time zone,
    period_end timestamp with time zone,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscription_events_event_type_check CHECK ((event_type = ANY (ARRAY['subscription_charge'::text, 'subscription_earning'::text, 'subscription_read'::text, 'expiry_warning_sent'::text])))
);


-- public.subscription_nudge_log

CREATE TABLE public.subscription_nudge_log (
    reader_id uuid NOT NULL,
    writer_id uuid NOT NULL,
    month date NOT NULL,
    shown_at timestamp with time zone DEFAULT now() NOT NULL,
    converted boolean DEFAULT false NOT NULL,
    publication_id uuid
);


-- public.subscription_offers

CREATE TABLE public.subscription_offers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    writer_id uuid NOT NULL,
    label text NOT NULL,
    mode text NOT NULL,
    discount_pct integer NOT NULL,
    duration_months integer,
    code text,
    recipient_id uuid,
    max_redemptions integer,
    redemption_count integer DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscription_offers_discount_pct_check CHECK (((discount_pct >= 0) AND (discount_pct <= 100))),
    CONSTRAINT subscription_offers_mode_check CHECK ((mode = ANY (ARRAY['code'::text, 'grant'::text])))
);


-- public.subscriptions

CREATE TABLE public.subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reader_id uuid NOT NULL,
    writer_id uuid,
    price_pence integer NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    current_period_start timestamp with time zone DEFAULT now() NOT NULL,
    current_period_end timestamp with time zone DEFAULT (now() + '1 mon'::interval) NOT NULL,
    cancelled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    nostr_event_id text,
    hidden boolean DEFAULT false NOT NULL,
    auto_renew boolean DEFAULT true NOT NULL,
    subscription_period text DEFAULT 'monthly'::text NOT NULL,
    is_comp boolean DEFAULT false NOT NULL,
    offer_id uuid,
    offer_periods_remaining integer,
    publication_id uuid,
    notify_on_publish boolean DEFAULT true NOT NULL,
    CONSTRAINT subscriptions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'cancelled'::text, 'expired'::text]))),
    CONSTRAINT subscriptions_target_check CHECK ((num_nonnulls(writer_id, publication_id) = 1))
);


-- public.tab_settlements

CREATE TABLE public.tab_settlements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reader_id uuid NOT NULL,
    tab_id uuid NOT NULL,
    amount_pence integer NOT NULL,
    platform_fee_pence integer NOT NULL,
    net_to_writers_pence integer NOT NULL,
    stripe_payment_intent_id text,
    stripe_charge_id text,
    trigger_type text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    settled_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tab_settlements_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT tab_settlements_trigger_type_check CHECK ((trigger_type = ANY (ARRAY['threshold'::text, 'monthly_fallback'::text])))
);


-- public.tags

CREATE TABLE public.tags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.trust_epochs

CREATE TABLE public.trust_epochs (
    epoch_id text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    type text NOT NULL,
    CONSTRAINT trust_epochs_type_check CHECK ((type = ANY (ARRAY['full'::text, 'mopup'::text])))
);


-- public.trust_layer1

CREATE TABLE public.trust_layer1 (
    user_id uuid NOT NULL,
    account_age_days integer DEFAULT 0 NOT NULL,
    paying_reader_count integer DEFAULT 0 NOT NULL,
    article_count integer DEFAULT 0 NOT NULL,
    payment_verified boolean DEFAULT false NOT NULL,
    nip05_verified boolean DEFAULT false NOT NULL,
    pip_status text DEFAULT 'unknown'::text NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT trust_layer1_pip_status_check CHECK ((pip_status = ANY (ARRAY['known'::text, 'partial'::text, 'unknown'::text, 'contested'::text])))
);


-- public.trust_polls

CREATE TABLE public.trust_polls (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    respondent_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    question text NOT NULL,
    answer text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT trust_polls_answer_check CHECK ((answer = ANY (ARRAY['yes'::text, 'no'::text]))),
    CONSTRAINT trust_polls_no_self CHECK ((respondent_id <> subject_id)),
    CONSTRAINT trust_polls_question_check CHECK ((question = ANY (ARRAY['humanity'::text, 'authenticity'::text, 'good_faith'::text])))
);


-- public.trust_profiles

CREATE TABLE public.trust_profiles (
    user_id uuid NOT NULL,
    dimension text NOT NULL,
    score numeric DEFAULT 0 NOT NULL,
    attestation_count integer DEFAULT 0 NOT NULL,
    epoch text DEFAULT 'pre-epoch'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT trust_profiles_dimension_check CHECK ((dimension = ANY (ARRAY['humanity'::text, 'encounter'::text, 'identity'::text, 'integrity'::text])))
);


-- public.vault_keys

CREATE TABLE public.vault_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    article_id uuid NOT NULL,
    nostr_article_event_id text NOT NULL,
    content_key_enc text NOT NULL,
    algorithm text DEFAULT 'aes-256-gcm'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    rotated_at timestamp with time zone,
    ciphertext text
);


-- public.vote_charges

CREATE TABLE public.vote_charges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vote_id uuid NOT NULL,
    voter_id uuid NOT NULL,
    recipient_id uuid,
    amount_pence bigint NOT NULL,
    tab_id uuid,
    on_free_allowance boolean DEFAULT false NOT NULL,
    state public.read_state DEFAULT 'provisional'::public.read_state NOT NULL,
    writer_payout_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.vote_tallies

CREATE TABLE public.vote_tallies (
    target_nostr_event_id text NOT NULL,
    upvote_count integer DEFAULT 0 NOT NULL,
    downvote_count integer DEFAULT 0 NOT NULL,
    net_score integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


-- public.votes

CREATE TABLE public.votes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    voter_id uuid NOT NULL,
    target_nostr_event_id text NOT NULL,
    target_author_id uuid NOT NULL,
    direction text NOT NULL,
    sequence_number integer NOT NULL,
    cost_pence bigint DEFAULT 0 NOT NULL,
    tab_id uuid,
    on_free_allowance boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT votes_direction_check CHECK ((direction = ANY (ARRAY['up'::text, 'down'::text])))
);


-- public.vouches

CREATE TABLE public.vouches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    attestor_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    dimension text NOT NULL,
    value text NOT NULL,
    visibility text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    withdrawn_at timestamp with time zone,
    last_reaffirmed_at timestamp with time zone DEFAULT now() NOT NULL,
    epochs_since_reaffirm integer DEFAULT 0 NOT NULL,
    CONSTRAINT vouches_check CHECK ((attestor_id <> subject_id)),
    CONSTRAINT vouches_check1 CHECK (((value <> 'contest'::text) OR (visibility = 'aggregate'::text))),
    CONSTRAINT vouches_dimension_check CHECK ((dimension = ANY (ARRAY['humanity'::text, 'encounter'::text, 'identity'::text, 'integrity'::text]))),
    CONSTRAINT vouches_value_check CHECK ((value = ANY (ARRAY['affirm'::text, 'contest'::text]))),
    CONSTRAINT vouches_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'aggregate'::text])))
);


-- public.writer_payouts

CREATE TABLE public.writer_payouts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    writer_id uuid NOT NULL,
    amount_pence integer NOT NULL,
    stripe_transfer_id text,
    stripe_connect_id text NOT NULL,
    status public.payout_status DEFAULT 'pending'::public.payout_status NOT NULL,
    triggered_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    failed_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


-- traffology.half_day_buckets

CREATE TABLE traffology.half_day_buckets (
    piece_id uuid NOT NULL,
    source_id uuid NOT NULL,
    bucket_start timestamp with time zone NOT NULL,
    is_day boolean NOT NULL,
    reader_count integer DEFAULT 0 NOT NULL
);


-- traffology.nostr_events

CREATE TABLE traffology.nostr_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id text NOT NULL,
    piece_id uuid NOT NULL,
    event_kind integer NOT NULL,
    author_npub text NOT NULL,
    author_display_name text,
    parent_event_id text,
    relay text NOT NULL,
    event_created_at timestamp with time zone NOT NULL,
    attributed_sessions integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


-- traffology.observations

CREATE TABLE traffology.observations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    writer_id uuid NOT NULL,
    piece_id uuid,
    observation_type text NOT NULL,
    priority integer NOT NULL,
    "values" jsonb DEFAULT '{}'::jsonb NOT NULL,
    suppressed boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT observations_priority_check CHECK (((priority >= 1) AND (priority <= 5)))
);


-- traffology.piece_stats

CREATE TABLE traffology.piece_stats (
    piece_id uuid NOT NULL,
    total_readers integer DEFAULT 0 NOT NULL,
    readers_today integer DEFAULT 0 NOT NULL,
    first_day_readers integer DEFAULT 0 NOT NULL,
    unique_countries integer DEFAULT 0 NOT NULL,
    avg_reading_time_seconds integer DEFAULT 0 NOT NULL,
    avg_scroll_depth real DEFAULT 0.0 NOT NULL,
    open_rate real,
    rank_this_year integer,
    rank_all_time integer,
    top_source_id uuid,
    top_source_pct real,
    free_conversions integer DEFAULT 0 NOT NULL,
    paid_conversions integer DEFAULT 0 NOT NULL,
    last_reader_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


-- traffology.pieces

CREATE TABLE traffology.pieces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    article_id uuid NOT NULL,
    writer_id uuid NOT NULL,
    publication_id uuid,
    title text NOT NULL,
    external_url text NOT NULL,
    word_count integer,
    nostr_event_id text,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


-- traffology.public_mentions

CREATE TABLE traffology.public_mentions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    piece_id uuid NOT NULL,
    platform text NOT NULL,
    post_url text NOT NULL,
    author_handle text NOT NULL,
    author_display_name text,
    post_text text,
    posted_at timestamp with time zone NOT NULL,
    engagement_count integer DEFAULT 0 NOT NULL,
    comment_count integer,
    attributed_sessions integer DEFAULT 0 NOT NULL,
    attribution_confidence text DEFAULT 'found'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT public_mentions_attribution_confidence_check CHECK ((attribution_confidence = ANY (ARRAY['direct'::text, 'inferred'::text, 'found'::text]))),
    CONSTRAINT public_mentions_platform_check CHECK ((platform = ANY (ARRAY['bluesky'::text, 'mastodon'::text, 'reddit'::text, 'hackernews'::text, 'twitter'::text, 'other'::text])))
);


-- traffology.publication_baselines

CREATE TABLE traffology.publication_baselines (
    publication_id uuid NOT NULL,
    mean_first_day_readers real DEFAULT 0.0 NOT NULL,
    stddev_first_day_readers real DEFAULT 0.0 NOT NULL,
    mean_reading_time real DEFAULT 0.0 NOT NULL,
    mean_open_rate real DEFAULT 0.0 NOT NULL,
    writer_count integer DEFAULT 0 NOT NULL,
    total_readers_this_month integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


-- traffology.sessions

CREATE TABLE traffology.sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    piece_id uuid NOT NULL,
    session_token text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    last_beacon_at timestamp with time zone DEFAULT now() NOT NULL,
    referrer_url text,
    referrer_domain text,
    resolved_source_id uuid,
    utm_source text,
    utm_medium text,
    utm_campaign text,
    country text,
    city text,
    device_type text DEFAULT 'desktop'::text NOT NULL,
    browser_family text,
    subscriber_status text DEFAULT 'anonymous'::text NOT NULL,
    scroll_depth real DEFAULT 0.0 NOT NULL,
    reading_time_seconds integer DEFAULT 0 NOT NULL,
    is_bounce boolean DEFAULT true NOT NULL,
    ip_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sessions_device_type_check CHECK ((device_type = ANY (ARRAY['desktop'::text, 'mobile'::text, 'tablet'::text]))),
    CONSTRAINT sessions_subscriber_status_check CHECK ((subscriber_status = ANY (ARRAY['anonymous'::text, 'free'::text, 'paying'::text])))
);


-- traffology.source_stats

CREATE TABLE traffology.source_stats (
    piece_id uuid NOT NULL,
    source_id uuid NOT NULL,
    reader_count integer DEFAULT 0 NOT NULL,
    pct_of_total real DEFAULT 0.0 NOT NULL,
    first_reader_at timestamp with time zone,
    last_reader_at timestamp with time zone,
    avg_reading_time_seconds integer DEFAULT 0 NOT NULL,
    avg_scroll_depth real DEFAULT 0.0 NOT NULL,
    bounce_rate real DEFAULT 0.0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


-- traffology.sources

CREATE TABLE traffology.sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    writer_id uuid NOT NULL,
    source_type text NOT NULL,
    domain text,
    display_name text NOT NULL,
    nostr_npub text,
    allhaus_writer_id uuid,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    is_new_for_writer boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sources_source_type_check CHECK ((source_type = ANY (ARRAY['mailing-list'::text, 'search'::text, 'link'::text, 'nostr'::text, 'direct'::text, 'platform-internal'::text])))
);


-- traffology.topic_performance

CREATE TABLE traffology.topic_performance (
    writer_id uuid NOT NULL,
    topic text NOT NULL,
    piece_count integer DEFAULT 0 NOT NULL,
    mean_readers real DEFAULT 0.0 NOT NULL,
    mean_reading_time real DEFAULT 0.0 NOT NULL,
    mean_search_readers real DEFAULT 0.0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


-- traffology.writer_baselines

CREATE TABLE traffology.writer_baselines (
    writer_id uuid NOT NULL,
    mean_first_day_readers real DEFAULT 0.0 NOT NULL,
    stddev_first_day_readers real DEFAULT 0.0 NOT NULL,
    mean_reading_time real DEFAULT 0.0 NOT NULL,
    mean_open_rate real DEFAULT 0.0 NOT NULL,
    mean_piece_lifespan_days real DEFAULT 0.0 NOT NULL,
    total_free_subscribers integer DEFAULT 0 NOT NULL,
    total_paying_subscribers integer DEFAULT 0 NOT NULL,
    monthly_revenue numeric(10,2) DEFAULT 0.00 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE ONLY public._migrations ALTER COLUMN id SET DEFAULT nextval('public._migrations_id_seq'::regclass);


ALTER TABLE ONLY public._migrations
    ADD CONSTRAINT _migrations_filename_key UNIQUE (filename);


ALTER TABLE ONLY public._migrations
    ADD CONSTRAINT _migrations_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_email_key UNIQUE (email);


ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_nostr_pubkey_key UNIQUE (nostr_pubkey);


ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_stripe_connect_id_key UNIQUE (stripe_connect_id);


ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_stripe_customer_id_key UNIQUE (stripe_customer_id);


ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_username_key UNIQUE (username);


ALTER TABLE ONLY public.activitypub_instance_health
    ADD CONSTRAINT activitypub_instance_health_pkey PRIMARY KEY (host);


ALTER TABLE ONLY public.article_drafts
    ADD CONSTRAINT article_drafts_nostr_draft_event_id_key UNIQUE (nostr_draft_event_id);


ALTER TABLE ONLY public.article_drafts
    ADD CONSTRAINT article_drafts_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.article_tags
    ADD CONSTRAINT article_tags_pkey PRIMARY KEY (article_id, tag_id);


ALTER TABLE ONLY public.article_unlocks
    ADD CONSTRAINT article_unlocks_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.article_unlocks
    ADD CONSTRAINT article_unlocks_reader_id_article_id_key UNIQUE (reader_id, article_id);


ALTER TABLE ONLY public.articles
    ADD CONSTRAINT articles_nostr_event_id_key UNIQUE (nostr_event_id);


ALTER TABLE ONLY public.articles
    ADD CONSTRAINT articles_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.articles
    ADD CONSTRAINT articles_vault_event_id_key UNIQUE (vault_event_id);


ALTER TABLE ONLY public.atproto_oauth_pending_states
    ADD CONSTRAINT atproto_oauth_pending_states_pkey PRIMARY KEY (key);


ALTER TABLE ONLY public.atproto_oauth_sessions
    ADD CONSTRAINT atproto_oauth_sessions_pkey PRIMARY KEY (did);


ALTER TABLE ONLY public.blocks
    ADD CONSTRAINT blocks_pkey PRIMARY KEY (blocker_id, blocked_id);


ALTER TABLE ONLY public.bookmarks
    ADD CONSTRAINT bookmarks_pkey PRIMARY KEY (user_id, article_id);


ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_nostr_event_id_key UNIQUE (nostr_event_id);


ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.content_key_issuances
    ADD CONSTRAINT content_key_issuances_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.conversation_members
    ADD CONSTRAINT conversation_members_pkey PRIMARY KEY (conversation_id, user_id);


ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.direct_messages
    ADD CONSTRAINT direct_messages_nostr_event_id_key UNIQUE (nostr_event_id);


ALTER TABLE ONLY public.direct_messages
    ADD CONSTRAINT direct_messages_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.dm_likes
    ADD CONSTRAINT dm_likes_message_id_user_id_key UNIQUE (message_id, user_id);


ALTER TABLE ONLY public.dm_likes
    ADD CONSTRAINT dm_likes_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.dm_pricing
    ADD CONSTRAINT dm_pricing_owner_id_target_id_key UNIQUE (owner_id, target_id);


ALTER TABLE ONLY public.dm_pricing
    ADD CONSTRAINT dm_pricing_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.external_items
    ADD CONSTRAINT external_items_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.external_sources
    ADD CONSTRAINT external_sources_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.external_subscriptions
    ADD CONSTRAINT external_subscriptions_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.feed_engagement
    ADD CONSTRAINT feed_engagement_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.feed_items
    ADD CONSTRAINT feed_items_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.feed_saves
    ADD CONSTRAINT feed_saves_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.feed_saves
    ADD CONSTRAINT feed_saves_unique UNIQUE (feed_id, feed_item_id);


ALTER TABLE ONLY public.feed_scores
    ADD CONSTRAINT feed_scores_pkey PRIMARY KEY (nostr_event_id);


ALTER TABLE ONLY public.feed_sources
    ADD CONSTRAINT feed_sources_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.feeds
    ADD CONSTRAINT feeds_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.follows
    ADD CONSTRAINT follows_pkey PRIMARY KEY (follower_id, followee_id);


ALTER TABLE ONLY public.gift_links
    ADD CONSTRAINT gift_links_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.gift_links
    ADD CONSTRAINT gift_links_token_key UNIQUE (token);


ALTER TABLE ONLY public.linked_accounts
    ADD CONSTRAINT linked_accounts_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.magic_links
    ADD CONSTRAINT magic_links_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.magic_links
    ADD CONSTRAINT magic_links_token_hash_key UNIQUE (token_hash);


ALTER TABLE ONLY public.media_uploads
    ADD CONSTRAINT media_uploads_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.moderation_reports
    ADD CONSTRAINT moderation_reports_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.mutes
    ADD CONSTRAINT mutes_pkey PRIMARY KEY (muter_id, muted_id);


ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_nostr_event_id_key UNIQUE (nostr_event_id);


ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_pkey PRIMARY KEY (user_id, category);


ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.oauth_app_registrations
    ADD CONSTRAINT oauth_app_registrations_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.reading_tabs
    ADD CONSTRAINT one_tab_per_reader UNIQUE (reader_id);


ALTER TABLE ONLY public.outbound_posts
    ADD CONSTRAINT outbound_posts_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.platform_config
    ADD CONSTRAINT platform_config_pkey PRIMARY KEY (key);


ALTER TABLE ONLY public.pledge_drives
    ADD CONSTRAINT pledge_drives_nostr_event_id_key UNIQUE (nostr_event_id);


ALTER TABLE ONLY public.pledge_drives
    ADD CONSTRAINT pledge_drives_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.pledges
    ADD CONSTRAINT pledges_drive_id_pledger_id_key UNIQUE (drive_id, pledger_id);


ALTER TABLE ONLY public.pledges
    ADD CONSTRAINT pledges_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.publication_article_shares
    ADD CONSTRAINT publication_article_shares_article_id_account_id_key UNIQUE (article_id, account_id);


ALTER TABLE ONLY public.publication_article_shares
    ADD CONSTRAINT publication_article_shares_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.publication_follows
    ADD CONSTRAINT publication_follows_pkey PRIMARY KEY (follower_id, publication_id);


ALTER TABLE ONLY public.publication_invites
    ADD CONSTRAINT publication_invites_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.publication_invites
    ADD CONSTRAINT publication_invites_token_key UNIQUE (token);


ALTER TABLE ONLY public.publication_members
    ADD CONSTRAINT publication_members_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.publication_payout_splits
    ADD CONSTRAINT publication_payout_splits_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.publication_payouts
    ADD CONSTRAINT publication_payouts_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.publications
    ADD CONSTRAINT publications_custom_domain_key UNIQUE (custom_domain);


ALTER TABLE ONLY public.publications
    ADD CONSTRAINT publications_nostr_pubkey_key UNIQUE (nostr_pubkey);


ALTER TABLE ONLY public.publications
    ADD CONSTRAINT publications_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.publications
    ADD CONSTRAINT publications_slug_key UNIQUE (slug);


ALTER TABLE ONLY public.publications
    ADD CONSTRAINT publications_stripe_connect_id_key UNIQUE (stripe_connect_id);


ALTER TABLE ONLY public.read_events
    ADD CONSTRAINT read_events_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.read_events
    ADD CONSTRAINT read_events_receipt_nostr_event_id_key UNIQUE (receipt_nostr_event_id);


ALTER TABLE ONLY public.reading_positions
    ADD CONSTRAINT reading_positions_pkey PRIMARY KEY (user_id, article_id);


ALTER TABLE ONLY public.reading_tabs
    ADD CONSTRAINT reading_tabs_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.relay_outbox
    ADD CONSTRAINT relay_outbox_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.resolver_async_results
    ADD CONSTRAINT resolver_async_results_pkey PRIMARY KEY (request_id);


ALTER TABLE ONLY public.stripe_webhook_events
    ADD CONSTRAINT stripe_webhook_events_pkey PRIMARY KEY (event_id);


ALTER TABLE ONLY public.subscription_events
    ADD CONSTRAINT subscription_events_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.subscription_nudge_log
    ADD CONSTRAINT subscription_nudge_log_pkey PRIMARY KEY (reader_id, writer_id, month);


ALTER TABLE ONLY public.subscription_offers
    ADD CONSTRAINT subscription_offers_code_key UNIQUE (code);


ALTER TABLE ONLY public.subscription_offers
    ADD CONSTRAINT subscription_offers_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.tab_settlements
    ADD CONSTRAINT tab_settlements_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.tab_settlements
    ADD CONSTRAINT tab_settlements_stripe_charge_id_key UNIQUE (stripe_charge_id);


ALTER TABLE ONLY public.tab_settlements
    ADD CONSTRAINT tab_settlements_stripe_payment_intent_id_key UNIQUE (stripe_payment_intent_id);


ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_name_key UNIQUE (name);


ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.trust_epochs
    ADD CONSTRAINT trust_epochs_pkey PRIMARY KEY (epoch_id);


ALTER TABLE ONLY public.trust_layer1
    ADD CONSTRAINT trust_layer1_pkey PRIMARY KEY (user_id);


ALTER TABLE ONLY public.trust_polls
    ADD CONSTRAINT trust_polls_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.trust_polls
    ADD CONSTRAINT trust_polls_unique UNIQUE (respondent_id, subject_id, question);


ALTER TABLE ONLY public.trust_profiles
    ADD CONSTRAINT trust_profiles_pkey PRIMARY KEY (user_id, dimension);


ALTER TABLE ONLY public.publication_members
    ADD CONSTRAINT unique_active_member UNIQUE (publication_id, account_id);


ALTER TABLE ONLY public.oauth_app_registrations
    ADD CONSTRAINT unique_app_registration UNIQUE (protocol, instance_url);


ALTER TABLE ONLY public.linked_accounts
    ADD CONSTRAINT unique_linked_identity UNIQUE (account_id, protocol, external_id);


ALTER TABLE ONLY public.external_sources
    ADD CONSTRAINT unique_source UNIQUE (protocol, source_uri);


ALTER TABLE ONLY public.external_items
    ADD CONSTRAINT unique_source_item UNIQUE (protocol, source_item_uri);


ALTER TABLE ONLY public.external_subscriptions
    ADD CONSTRAINT unique_subscription UNIQUE (subscriber_id, source_id);


ALTER TABLE ONLY public.vault_keys
    ADD CONSTRAINT vault_keys_nostr_article_event_id_key UNIQUE (nostr_article_event_id);


ALTER TABLE ONLY public.vault_keys
    ADD CONSTRAINT vault_keys_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.vote_charges
    ADD CONSTRAINT vote_charges_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.vote_tallies
    ADD CONSTRAINT vote_tallies_pkey PRIMARY KEY (target_nostr_event_id);


ALTER TABLE ONLY public.votes
    ADD CONSTRAINT votes_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.vouches
    ADD CONSTRAINT vouches_attestor_id_subject_id_dimension_key UNIQUE (attestor_id, subject_id, dimension);


ALTER TABLE ONLY public.vouches
    ADD CONSTRAINT vouches_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.writer_payouts
    ADD CONSTRAINT writer_payouts_pkey PRIMARY KEY (id);


ALTER TABLE ONLY public.writer_payouts
    ADD CONSTRAINT writer_payouts_stripe_transfer_id_key UNIQUE (stripe_transfer_id);


ALTER TABLE ONLY traffology.half_day_buckets
    ADD CONSTRAINT half_day_buckets_pkey PRIMARY KEY (piece_id, source_id, bucket_start);


ALTER TABLE ONLY traffology.nostr_events
    ADD CONSTRAINT nostr_events_event_id_key UNIQUE (event_id);


ALTER TABLE ONLY traffology.nostr_events
    ADD CONSTRAINT nostr_events_pkey PRIMARY KEY (id);


ALTER TABLE ONLY traffology.observations
    ADD CONSTRAINT observations_pkey PRIMARY KEY (id);


ALTER TABLE ONLY traffology.piece_stats
    ADD CONSTRAINT piece_stats_pkey PRIMARY KEY (piece_id);


ALTER TABLE ONLY traffology.pieces
    ADD CONSTRAINT pieces_article_id_key UNIQUE (article_id);


ALTER TABLE ONLY traffology.pieces
    ADD CONSTRAINT pieces_pkey PRIMARY KEY (id);


ALTER TABLE ONLY traffology.public_mentions
    ADD CONSTRAINT public_mentions_pkey PRIMARY KEY (id);


ALTER TABLE ONLY traffology.publication_baselines
    ADD CONSTRAINT publication_baselines_pkey PRIMARY KEY (publication_id);


ALTER TABLE ONLY traffology.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


ALTER TABLE ONLY traffology.source_stats
    ADD CONSTRAINT source_stats_pkey PRIMARY KEY (piece_id, source_id);


ALTER TABLE ONLY traffology.sources
    ADD CONSTRAINT sources_pkey PRIMARY KEY (id);


ALTER TABLE ONLY traffology.topic_performance
    ADD CONSTRAINT topic_performance_pkey PRIMARY KEY (writer_id, topic);


ALTER TABLE ONLY traffology.writer_baselines
    ADD CONSTRAINT writer_baselines_pkey PRIMARY KEY (writer_id);


CREATE INDEX atproto_oauth_pending_states_expires_at_idx ON public.atproto_oauth_pending_states USING btree (expires_at);


CREATE INDEX feed_saves_feed_idx ON public.feed_saves USING btree (feed_id, created_at DESC, id DESC);


CREATE UNIQUE INDEX feed_sources_account_uniq ON public.feed_sources USING btree (feed_id, account_id) WHERE (source_type = 'account'::text);


CREATE UNIQUE INDEX feed_sources_external_uniq ON public.feed_sources USING btree (feed_id, external_source_id) WHERE (source_type = 'external_source'::text);


CREATE INDEX feed_sources_feed_idx ON public.feed_sources USING btree (feed_id);


CREATE UNIQUE INDEX feed_sources_publication_uniq ON public.feed_sources USING btree (feed_id, publication_id) WHERE (source_type = 'publication'::text);


CREATE UNIQUE INDEX feed_sources_tag_uniq ON public.feed_sources USING btree (feed_id, tag_name) WHERE (source_type = 'tag'::text);


CREATE INDEX feeds_owner_idx ON public.feeds USING btree (owner_id, created_at DESC);


CREATE INDEX idx_accounts_display_name_trgm ON public.accounts USING gin (display_name public.gin_trgm_ops) WHERE (display_name IS NOT NULL);


CREATE INDEX idx_accounts_email ON public.accounts USING btree (email) WHERE (email IS NOT NULL);


CREATE INDEX idx_accounts_is_writer ON public.accounts USING btree (is_writer) WHERE (is_writer = true);


CREATE INDEX idx_accounts_nostr_pubkey ON public.accounts USING btree (nostr_pubkey);


CREATE INDEX idx_accounts_username ON public.accounts USING btree (username);


CREATE INDEX idx_accounts_username_trgm ON public.accounts USING gin (username public.gin_trgm_ops);


CREATE INDEX idx_ap_instance_health_updated ON public.activitypub_instance_health USING btree (updated_at DESC);


CREATE INDEX idx_article_tags_tag ON public.article_tags USING btree (tag_id);


CREATE INDEX idx_article_unlocks_article ON public.article_unlocks USING btree (article_id);


CREATE INDEX idx_article_unlocks_reader ON public.article_unlocks USING btree (reader_id);


CREATE INDEX idx_articles_content_free_trgm ON public.articles USING gin (content_free public.gin_trgm_ops);


CREATE INDEX idx_articles_nostr_d_tag ON public.articles USING btree (writer_id, nostr_d_tag);


CREATE INDEX idx_articles_publication ON public.articles USING btree (publication_id) WHERE (publication_id IS NOT NULL);


CREATE INDEX idx_articles_published_at ON public.articles USING btree (published_at DESC) WHERE (published_at IS NOT NULL);


CREATE INDEX idx_articles_title_trgm ON public.articles USING gin (title public.gin_trgm_ops);


CREATE UNIQUE INDEX idx_articles_unique_live ON public.articles USING btree (writer_id, nostr_d_tag) WHERE (deleted_at IS NULL);


CREATE INDEX idx_articles_writer_id ON public.articles USING btree (writer_id);


CREATE INDEX idx_bookmarks_user ON public.bookmarks USING btree (user_id, created_at DESC);


CREATE INDEX idx_comments_author ON public.comments USING btree (author_id);


CREATE INDEX idx_comments_parent ON public.comments USING btree (parent_comment_id) WHERE (parent_comment_id IS NOT NULL);


CREATE INDEX idx_comments_target ON public.comments USING btree (target_event_id, published_at) WHERE (deleted_at IS NULL);


CREATE INDEX idx_conv_members_user ON public.conversation_members USING btree (user_id);


CREATE INDEX idx_dm_conversation ON public.direct_messages USING btree (conversation_id, created_at DESC);


CREATE INDEX idx_dm_likes_message ON public.dm_likes USING btree (message_id);


CREATE UNIQUE INDEX idx_dm_pricing_default ON public.dm_pricing USING btree (owner_id) WHERE (target_id IS NULL);


CREATE INDEX idx_dm_recipient ON public.direct_messages USING btree (recipient_id);


CREATE INDEX idx_dm_reply_to ON public.direct_messages USING btree (reply_to_id) WHERE (reply_to_id IS NOT NULL);


CREATE INDEX idx_dm_send_id ON public.direct_messages USING btree (send_id);


CREATE INDEX idx_dm_sender ON public.direct_messages USING btree (sender_id);


CREATE INDEX idx_drafts_scheduled ON public.article_drafts USING btree (scheduled_at) WHERE (scheduled_at IS NOT NULL);


CREATE UNIQUE INDEX idx_drafts_writer_dtag ON public.article_drafts USING btree (writer_id, nostr_d_tag) WHERE (nostr_d_tag IS NOT NULL);


CREATE INDEX idx_drafts_writer_id ON public.article_drafts USING btree (writer_id);


CREATE INDEX idx_drives_creator ON public.pledge_drives USING btree (creator_id);


CREATE INDEX idx_drives_nostr ON public.pledge_drives USING btree (nostr_event_id);


CREATE INDEX idx_drives_parent_conv ON public.pledge_drives USING btree (parent_conversation_id) WHERE (parent_conversation_id IS NOT NULL);


CREATE INDEX idx_drives_parent_note ON public.pledge_drives USING btree (parent_note_event_id) WHERE (parent_note_event_id IS NOT NULL);


CREATE INDEX idx_drives_status ON public.pledge_drives USING btree (status);


CREATE INDEX idx_drives_writer ON public.pledge_drives USING btree (target_writer_id);


CREATE INDEX idx_ext_items_author_uri ON public.external_items USING btree (author_uri);


CREATE INDEX idx_ext_items_published_at ON public.external_items USING btree (published_at DESC);


CREATE INDEX idx_ext_items_source_id ON public.external_items USING btree (source_id);


CREATE INDEX idx_ext_items_source_reply ON public.external_items USING btree (source_reply_uri) WHERE (source_reply_uri IS NOT NULL);


CREATE INDEX idx_ext_sources_next_fetch ON public.external_sources USING btree (last_fetched_at) WHERE (is_active = true);


CREATE INDEX idx_ext_sources_orphaned ON public.external_sources USING btree (orphaned_at) WHERE (orphaned_at IS NOT NULL);


CREATE INDEX idx_ext_sources_protocol ON public.external_sources USING btree (protocol) WHERE (is_active = true);


CREATE INDEX idx_ext_subs_source ON public.external_subscriptions USING btree (source_id);


CREATE INDEX idx_ext_subs_subscriber ON public.external_subscriptions USING btree (subscriber_id);


CREATE INDEX idx_feed_engagement_author ON public.feed_engagement USING btree (target_author_id, engaged_at DESC);


CREATE INDEX idx_feed_engagement_target ON public.feed_engagement USING btree (target_nostr_event_id, engaged_at DESC);


CREATE UNIQUE INDEX idx_feed_items_article ON public.feed_items USING btree (article_id) WHERE (article_id IS NOT NULL);


CREATE INDEX idx_feed_items_author ON public.feed_items USING btree (author_id, published_at DESC) WHERE (deleted_at IS NULL);


CREATE INDEX idx_feed_items_cursor ON public.feed_items USING btree (published_at DESC, id DESC) WHERE (deleted_at IS NULL);


CREATE UNIQUE INDEX idx_feed_items_external ON public.feed_items USING btree (external_item_id) WHERE (external_item_id IS NOT NULL);


CREATE UNIQUE INDEX idx_feed_items_note ON public.feed_items USING btree (note_id) WHERE (note_id IS NOT NULL);


CREATE INDEX idx_feed_items_score ON public.feed_items USING btree (score DESC, published_at DESC) WHERE (deleted_at IS NULL);


CREATE INDEX idx_feed_items_source ON public.feed_items USING btree (source_id, published_at DESC) WHERE ((source_id IS NOT NULL) AND (deleted_at IS NULL));


CREATE INDEX idx_feed_items_type ON public.feed_items USING btree (item_type, published_at DESC) WHERE (deleted_at IS NULL);


CREATE INDEX idx_feed_scores_author ON public.feed_scores USING btree (author_id, score DESC);


CREATE INDEX idx_feed_scores_publication ON public.feed_scores USING btree (publication_id, score DESC) WHERE (publication_id IS NOT NULL);


CREATE INDEX idx_feed_scores_published ON public.feed_scores USING btree (published_at DESC);


CREATE INDEX idx_feed_scores_score ON public.feed_scores USING btree (score DESC);


CREATE INDEX idx_follows_followee_id ON public.follows USING btree (followee_id);


CREATE INDEX idx_gift_links_article ON public.gift_links USING btree (article_id);


CREATE INDEX idx_gift_links_token ON public.gift_links USING btree (token);


CREATE INDEX idx_key_issuances_reader_article ON public.content_key_issuances USING btree (reader_id, article_id);


CREATE INDEX idx_key_issuances_vault_key_id ON public.content_key_issuances USING btree (vault_key_id);


CREATE INDEX idx_linked_accounts_account ON public.linked_accounts USING btree (account_id);


CREATE INDEX idx_linked_accounts_refresh ON public.linked_accounts USING btree (token_expires_at) WHERE ((is_valid = true) AND (credentials_enc IS NOT NULL));


CREATE INDEX idx_magic_links_expires ON public.magic_links USING btree (expires_at) WHERE (used_at IS NULL);


CREATE INDEX idx_magic_links_token_hash ON public.magic_links USING btree (token_hash) WHERE (used_at IS NULL);


CREATE INDEX idx_media_uploads_sha256 ON public.media_uploads USING btree (sha256);


CREATE INDEX idx_media_uploads_uploader ON public.media_uploads USING btree (uploader_id);


CREATE INDEX idx_notes_author_id ON public.notes USING btree (author_id);


CREATE INDEX idx_notes_published_at ON public.notes USING btree (published_at DESC);


CREATE INDEX idx_notes_reply_to ON public.notes USING btree (reply_to_event_id) WHERE (reply_to_event_id IS NOT NULL);


CREATE UNIQUE INDEX idx_notifications_dedup ON public.notifications USING btree (recipient_id, actor_id, type, COALESCE(article_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(note_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(comment_id, '00000000-0000-0000-0000-000000000000'::uuid));


CREATE INDEX idx_notifications_note ON public.notifications USING btree (note_id) WHERE (note_id IS NOT NULL);


CREATE INDEX idx_notifications_recipient ON public.notifications USING btree (recipient_id, created_at DESC);


CREATE INDEX idx_outbound_posts_account ON public.outbound_posts USING btree (account_id);


CREATE INDEX idx_outbound_posts_linked ON public.outbound_posts USING btree (linked_account_id);


CREATE INDEX idx_outbound_posts_pending ON public.outbound_posts USING btree (status) WHERE (status = ANY (ARRAY['pending'::text, 'retrying'::text]));


CREATE INDEX idx_pledges_drive ON public.pledges USING btree (drive_id);


CREATE INDEX idx_pledges_pledger ON public.pledges USING btree (pledger_id);


CREATE INDEX idx_pledges_status ON public.pledges USING btree (status);


CREATE INDEX idx_pub_follows_publication ON public.publication_follows USING btree (publication_id);


CREATE INDEX idx_pub_invites_email ON public.publication_invites USING btree (invited_email) WHERE ((accepted_at IS NULL) AND (declined_at IS NULL));


CREATE INDEX idx_pub_invites_token ON public.publication_invites USING btree (token) WHERE ((accepted_at IS NULL) AND (declined_at IS NULL));


CREATE INDEX idx_pub_members_account ON public.publication_members USING btree (account_id) WHERE (removed_at IS NULL);


CREATE UNIQUE INDEX idx_pub_members_one_owner ON public.publication_members USING btree (publication_id) WHERE ((is_owner = true) AND (removed_at IS NULL));


CREATE INDEX idx_pub_members_publication ON public.publication_members USING btree (publication_id) WHERE (removed_at IS NULL);


CREATE INDEX idx_pub_payout_splits_account ON public.publication_payout_splits USING btree (account_id);


CREATE INDEX idx_pub_payout_splits_payout ON public.publication_payout_splits USING btree (publication_payout_id);


CREATE INDEX idx_pub_payouts_publication ON public.publication_payouts USING btree (publication_id);


CREATE INDEX idx_pub_payouts_status ON public.publication_payouts USING btree (status);


CREATE INDEX idx_publications_custom_domain ON public.publications USING btree (custom_domain) WHERE (custom_domain IS NOT NULL);


CREATE INDEX idx_publications_name_trgm ON public.publications USING gin (name public.gin_trgm_ops);


CREATE INDEX idx_publications_nostr_pubkey ON public.publications USING btree (nostr_pubkey);


CREATE INDEX idx_publications_slug ON public.publications USING btree (slug);


CREATE INDEX idx_read_events_article_id ON public.read_events USING btree (article_id);


CREATE INDEX idx_read_events_reader_id ON public.read_events USING btree (reader_id);


CREATE INDEX idx_read_events_state ON public.read_events USING btree (state);


CREATE INDEX idx_read_events_tab_id ON public.read_events USING btree (tab_id);


CREATE INDEX idx_read_events_writer_id ON public.read_events USING btree (writer_id);


CREATE INDEX idx_reading_positions_user ON public.reading_positions USING btree (user_id, updated_at DESC);


CREATE INDEX idx_reading_tabs_reader_id ON public.reading_tabs USING btree (reader_id);


CREATE INDEX idx_reports_status ON public.moderation_reports USING btree (status, created_at DESC);


CREATE INDEX idx_stripe_webhook_events_processed ON public.stripe_webhook_events USING btree (processed_at);


CREATE INDEX idx_sub_events_created ON public.subscription_events USING btree (created_at DESC);


CREATE INDEX idx_sub_events_reader ON public.subscription_events USING btree (reader_id);


CREATE INDEX idx_sub_events_subscription ON public.subscription_events USING btree (subscription_id);


CREATE INDEX idx_sub_events_type ON public.subscription_events USING btree (event_type);


CREATE INDEX idx_sub_events_writer ON public.subscription_events USING btree (writer_id);


CREATE INDEX idx_sub_offers_code ON public.subscription_offers USING btree (code) WHERE (code IS NOT NULL);


CREATE INDEX idx_sub_offers_recipient ON public.subscription_offers USING btree (recipient_id) WHERE (recipient_id IS NOT NULL);


CREATE INDEX idx_sub_offers_writer ON public.subscription_offers USING btree (writer_id);


CREATE INDEX idx_subscriptions_period_end ON public.subscriptions USING btree (current_period_end) WHERE (status = ANY (ARRAY['active'::text, 'cancelled'::text]));


CREATE INDEX idx_subscriptions_reader ON public.subscriptions USING btree (reader_id);


CREATE UNIQUE INDEX idx_subscriptions_reader_publication ON public.subscriptions USING btree (reader_id, publication_id) WHERE (publication_id IS NOT NULL);


CREATE UNIQUE INDEX idx_subscriptions_reader_writer ON public.subscriptions USING btree (reader_id, writer_id) WHERE (writer_id IS NOT NULL);


CREATE INDEX idx_subscriptions_status ON public.subscriptions USING btree (status) WHERE ((status = 'active'::text) OR (status = 'cancelled'::text));


CREATE INDEX idx_subscriptions_writer ON public.subscriptions USING btree (writer_id);


CREATE INDEX idx_tab_settlements_reader_id ON public.tab_settlements USING btree (reader_id);


CREATE INDEX idx_tab_settlements_settled_at ON public.tab_settlements USING btree (settled_at DESC);

CREATE INDEX idx_tab_settlements_pending ON public.tab_settlements USING btree (status) WHERE (status = 'pending'::text);


CREATE INDEX idx_tags_name ON public.tags USING btree (name);


CREATE INDEX idx_vault_keys_article_id ON public.vault_keys USING btree (article_id);


CREATE INDEX idx_vote_charges_recipient_id ON public.vote_charges USING btree (recipient_id) WHERE (recipient_id IS NOT NULL);


CREATE INDEX idx_vote_charges_state ON public.vote_charges USING btree (state);


CREATE INDEX idx_vote_charges_tab_id ON public.vote_charges USING btree (tab_id) WHERE (tab_id IS NOT NULL);


CREATE INDEX idx_vote_charges_vote_id ON public.vote_charges USING btree (vote_id);


CREATE INDEX idx_vote_charges_voter_id ON public.vote_charges USING btree (voter_id);


CREATE INDEX idx_votes_author ON public.votes USING btree (target_author_id);


CREATE INDEX idx_votes_created ON public.votes USING btree (created_at DESC);


CREATE INDEX idx_votes_target ON public.votes USING btree (target_nostr_event_id);


CREATE INDEX idx_votes_voter_target ON public.votes USING btree (voter_id, target_nostr_event_id, direction);


CREATE INDEX idx_vouches_attestor ON public.vouches USING btree (attestor_id) WHERE (withdrawn_at IS NULL);


CREATE INDEX idx_vouches_public ON public.vouches USING btree (subject_id, dimension) WHERE ((visibility = 'public'::text) AND (withdrawn_at IS NULL));


CREATE INDEX idx_vouches_subject ON public.vouches USING btree (subject_id) WHERE (withdrawn_at IS NULL);


CREATE INDEX idx_writer_payouts_status ON public.writer_payouts USING btree (status);


CREATE INDEX idx_writer_payouts_writer_id ON public.writer_payouts USING btree (writer_id);


CREATE INDEX relay_outbox_entity_idx ON public.relay_outbox USING btree (entity_type, entity_id);


CREATE UNIQUE INDEX relay_outbox_event_id_idx ON public.relay_outbox USING btree (((signed_event ->> 'id'::text)));


CREATE INDEX relay_outbox_ready_idx ON public.relay_outbox USING btree (next_attempt_at) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text]));


CREATE INDEX resolver_async_results_expires_at_idx ON public.resolver_async_results USING btree (expires_at);


CREATE INDEX resolver_async_results_initiator_created_idx ON public.resolver_async_results USING btree (initiator_id, created_at DESC);


CREATE INDEX trust_polls_subject_idx ON public.trust_polls USING btree (subject_id, question);


CREATE UNIQUE INDEX uniq_outbound_posts_dedup ON public.outbound_posts USING btree (account_id, nostr_event_id, linked_account_id, action_type) NULLS NOT DISTINCT;


CREATE INDEX idx_traf_mentions_piece ON traffology.public_mentions USING btree (piece_id);


CREATE INDEX idx_traf_nostr_events_piece ON traffology.nostr_events USING btree (piece_id);


CREATE INDEX idx_traf_observations_piece ON traffology.observations USING btree (piece_id, created_at DESC) WHERE (piece_id IS NOT NULL);


CREATE INDEX idx_traf_observations_type ON traffology.observations USING btree (observation_type, created_at DESC);


CREATE INDEX idx_traf_observations_writer ON traffology.observations USING btree (writer_id, created_at DESC);


CREATE INDEX idx_traf_pieces_nostr ON traffology.pieces USING btree (nostr_event_id) WHERE (nostr_event_id IS NOT NULL);


CREATE INDEX idx_traf_pieces_publication ON traffology.pieces USING btree (publication_id) WHERE (publication_id IS NOT NULL);


CREATE INDEX idx_traf_pieces_writer ON traffology.pieces USING btree (writer_id);


CREATE UNIQUE INDEX idx_traf_sessions_dedup ON traffology.sessions USING btree (session_token, piece_id);


CREATE INDEX idx_traf_sessions_piece ON traffology.sessions USING btree (piece_id, started_at DESC);


CREATE INDEX idx_traf_sessions_piece_last_beacon ON traffology.sessions USING btree (piece_id, last_beacon_at DESC);


CREATE INDEX idx_traf_sessions_started ON traffology.sessions USING btree (started_at DESC);


CREATE INDEX idx_traf_sources_domain ON traffology.sources USING btree (writer_id, domain) WHERE (domain IS NOT NULL);


CREATE INDEX idx_traf_sources_writer ON traffology.sources USING btree (writer_id);


CREATE TRIGGER articles_size_tier_default BEFORE INSERT ON public.articles FOR EACH ROW EXECUTE FUNCTION public.articles_derive_size_tier();


CREATE TRIGGER feed_sources_touch_parent AFTER INSERT OR DELETE OR UPDATE ON public.feed_sources FOR EACH ROW EXECUTE FUNCTION public.feed_sources_touch_parent();


CREATE TRIGGER feeds_touch_updated_at BEFORE UPDATE ON public.feeds FOR EACH ROW EXECUTE FUNCTION public.feeds_touch_updated_at();


CREATE TRIGGER trg_accounts_updated_at BEFORE UPDATE ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


CREATE TRIGGER trg_articles_updated_at BEFORE UPDATE ON public.articles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


CREATE TRIGGER trg_pledge_drives_updated_at BEFORE UPDATE ON public.pledge_drives FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


CREATE TRIGGER trg_reading_tabs_updated_at BEFORE UPDATE ON public.reading_tabs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


CREATE TRIGGER trust_polls_touch_updated_at BEFORE UPDATE ON public.trust_polls FOR EACH ROW EXECUTE FUNCTION public.trust_polls_touch_updated_at();


ALTER TABLE ONLY public.article_drafts
    ADD CONSTRAINT article_drafts_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.publications(id);


ALTER TABLE ONLY public.article_drafts
    ADD CONSTRAINT article_drafts_writer_id_fkey FOREIGN KEY (writer_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.article_tags
    ADD CONSTRAINT article_tags_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.article_tags
    ADD CONSTRAINT article_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.article_unlocks
    ADD CONSTRAINT article_unlocks_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id);


ALTER TABLE ONLY public.article_unlocks
    ADD CONSTRAINT article_unlocks_reader_id_fkey FOREIGN KEY (reader_id) REFERENCES public.accounts(id);


ALTER TABLE ONLY public.article_unlocks
    ADD CONSTRAINT article_unlocks_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.subscriptions(id);


ALTER TABLE ONLY public.articles
    ADD CONSTRAINT articles_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.publications(id);


ALTER TABLE ONLY public.articles
    ADD CONSTRAINT articles_writer_id_fkey FOREIGN KEY (writer_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.blocks
    ADD CONSTRAINT blocks_blocked_id_fkey FOREIGN KEY (blocked_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.blocks
    ADD CONSTRAINT blocks_blocker_id_fkey FOREIGN KEY (blocker_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.bookmarks
    ADD CONSTRAINT bookmarks_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.bookmarks
    ADD CONSTRAINT bookmarks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_parent_comment_id_fkey FOREIGN KEY (parent_comment_id) REFERENCES public.comments(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.content_key_issuances
    ADD CONSTRAINT content_key_issuances_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.content_key_issuances
    ADD CONSTRAINT content_key_issuances_read_event_id_fkey FOREIGN KEY (read_event_id) REFERENCES public.read_events(id) ON DELETE SET NULL;


ALTER TABLE ONLY public.content_key_issuances
    ADD CONSTRAINT content_key_issuances_reader_id_fkey FOREIGN KEY (reader_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.content_key_issuances
    ADD CONSTRAINT content_key_issuances_vault_key_id_fkey FOREIGN KEY (vault_key_id) REFERENCES public.vault_keys(id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.conversation_members
    ADD CONSTRAINT conversation_members_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.conversation_members
    ADD CONSTRAINT conversation_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.accounts(id);


ALTER TABLE ONLY public.direct_messages
    ADD CONSTRAINT direct_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.direct_messages
    ADD CONSTRAINT direct_messages_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.direct_messages
    ADD CONSTRAINT direct_messages_reply_to_id_fkey FOREIGN KEY (reply_to_id) REFERENCES public.direct_messages(id) ON DELETE SET NULL;


ALTER TABLE ONLY public.direct_messages
    ADD CONSTRAINT direct_messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.dm_likes
    ADD CONSTRAINT dm_likes_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.direct_messages(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.dm_likes
    ADD CONSTRAINT dm_likes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.dm_pricing
    ADD CONSTRAINT dm_pricing_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.accounts(id);


ALTER TABLE ONLY public.dm_pricing
    ADD CONSTRAINT dm_pricing_target_id_fkey FOREIGN KEY (target_id) REFERENCES public.accounts(id);


ALTER TABLE ONLY public.external_items
    ADD CONSTRAINT external_items_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.external_sources(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.external_subscriptions
    ADD CONSTRAINT external_subscriptions_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.external_sources(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.external_subscriptions
    ADD CONSTRAINT external_subscriptions_subscriber_id_fkey FOREIGN KEY (subscriber_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.feed_engagement
    ADD CONSTRAINT feed_engagement_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


ALTER TABLE ONLY public.feed_engagement
    ADD CONSTRAINT feed_engagement_target_author_id_fkey FOREIGN KEY (target_author_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


ALTER TABLE ONLY public.feed_items
    ADD CONSTRAINT feed_items_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.feed_items
    ADD CONSTRAINT feed_items_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


ALTER TABLE ONLY public.feed_items
    ADD CONSTRAINT feed_items_external_item_id_fkey FOREIGN KEY (external_item_id) REFERENCES public.external_items(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.feed_items
    ADD CONSTRAINT feed_items_note_id_fkey FOREIGN KEY (note_id) REFERENCES public.notes(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.feed_items
    ADD CONSTRAINT feed_items_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.external_sources(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.feed_saves
    ADD CONSTRAINT feed_saves_feed_id_fkey FOREIGN KEY (feed_id) REFERENCES public.feeds(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.feed_saves
    ADD CONSTRAINT feed_saves_feed_item_id_fkey FOREIGN KEY (feed_item_id) REFERENCES public.feed_items(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.feed_scores
    ADD CONSTRAINT feed_scores_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.feed_scores
    ADD CONSTRAINT feed_scores_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.publications(id);


ALTER TABLE ONLY public.feed_sources
    ADD CONSTRAINT feed_sources_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.feed_sources
    ADD CONSTRAINT feed_sources_external_source_id_fkey FOREIGN KEY (external_source_id) REFERENCES public.external_sources(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.feed_sources
    ADD CONSTRAINT feed_sources_feed_id_fkey FOREIGN KEY (feed_id) REFERENCES public.feeds(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.feed_sources
    ADD CONSTRAINT feed_sources_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.publications(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.feeds
    ADD CONSTRAINT feeds_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.read_events
    ADD CONSTRAINT fk_read_events_tab_settlement FOREIGN KEY (tab_settlement_id) REFERENCES public.tab_settlements(id) ON DELETE SET NULL;


ALTER TABLE ONLY public.read_events
    ADD CONSTRAINT fk_read_events_writer_payout FOREIGN KEY (writer_payout_id) REFERENCES public.writer_payouts(id) ON DELETE SET NULL;


ALTER TABLE ONLY public.vote_charges
    ADD CONSTRAINT fk_vote_charges_writer_payout FOREIGN KEY (writer_payout_id) REFERENCES public.writer_payouts(id) ON DELETE SET NULL;


ALTER TABLE ONLY public.follows
    ADD CONSTRAINT follows_followee_id_fkey FOREIGN KEY (followee_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.follows
    ADD CONSTRAINT follows_follower_id_fkey FOREIGN KEY (follower_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.gift_links
    ADD CONSTRAINT gift_links_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.gift_links
    ADD CONSTRAINT gift_links_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.linked_accounts
    ADD CONSTRAINT linked_accounts_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.magic_links
    ADD CONSTRAINT magic_links_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.media_uploads
    ADD CONSTRAINT media_uploads_uploader_id_fkey FOREIGN KEY (uploader_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.moderation_reports
    ADD CONSTRAINT moderation_reports_reporter_id_fkey FOREIGN KEY (reporter_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


ALTER TABLE ONLY public.moderation_reports
    ADD CONSTRAINT moderation_reports_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.accounts(id) ON DELETE SET NULL;


ALTER TABLE ONLY public.moderation_reports
    ADD CONSTRAINT moderation_reports_target_account_id_fkey FOREIGN KEY (target_account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


ALTER TABLE ONLY public.mutes
    ADD CONSTRAINT mutes_muted_id_fkey FOREIGN KEY (muted_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.mutes
    ADD CONSTRAINT mutes_muter_id_fkey FOREIGN KEY (muter_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_comment_id_fkey FOREIGN KEY (comment_id) REFERENCES public.comments(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE SET NULL;


ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_drive_id_fkey FOREIGN KEY (drive_id) REFERENCES public.pledge_drives(id) ON DELETE SET NULL;


ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_note_id_fkey FOREIGN KEY (note_id) REFERENCES public.notes(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.outbound_posts
    ADD CONSTRAINT outbound_posts_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.outbound_posts
    ADD CONSTRAINT outbound_posts_linked_account_id_fkey FOREIGN KEY (linked_account_id) REFERENCES public.linked_accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.outbound_posts
    ADD CONSTRAINT outbound_posts_source_item_id_fkey FOREIGN KEY (source_item_id) REFERENCES public.external_items(id) ON DELETE SET NULL;


ALTER TABLE ONLY public.pledge_drives
    ADD CONSTRAINT pledge_drives_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id);


ALTER TABLE ONLY public.pledge_drives
    ADD CONSTRAINT pledge_drives_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.accounts(id);


ALTER TABLE ONLY public.pledge_drives
    ADD CONSTRAINT pledge_drives_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.article_drafts(id);


ALTER TABLE ONLY public.pledge_drives
    ADD CONSTRAINT pledge_drives_parent_conversation_id_fkey FOREIGN KEY (parent_conversation_id) REFERENCES public.conversations(id) ON DELETE SET NULL;


ALTER TABLE ONLY public.pledge_drives
    ADD CONSTRAINT pledge_drives_target_writer_id_fkey FOREIGN KEY (target_writer_id) REFERENCES public.accounts(id);


ALTER TABLE ONLY public.pledges
    ADD CONSTRAINT pledges_drive_id_fkey FOREIGN KEY (drive_id) REFERENCES public.pledge_drives(id);


ALTER TABLE ONLY public.pledges
    ADD CONSTRAINT pledges_pledger_id_fkey FOREIGN KEY (pledger_id) REFERENCES public.accounts(id);


ALTER TABLE ONLY public.pledges
    ADD CONSTRAINT pledges_read_event_id_fkey FOREIGN KEY (read_event_id) REFERENCES public.read_events(id);


ALTER TABLE ONLY public.publication_article_shares
    ADD CONSTRAINT publication_article_shares_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.publication_article_shares
    ADD CONSTRAINT publication_article_shares_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.publication_article_shares
    ADD CONSTRAINT publication_article_shares_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.publications(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.publication_follows
    ADD CONSTRAINT publication_follows_follower_id_fkey FOREIGN KEY (follower_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.publication_follows
    ADD CONSTRAINT publication_follows_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.publications(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.publication_invites
    ADD CONSTRAINT publication_invites_invited_account_id_fkey FOREIGN KEY (invited_account_id) REFERENCES public.accounts(id);


ALTER TABLE ONLY public.publication_invites
    ADD CONSTRAINT publication_invites_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.publication_invites
    ADD CONSTRAINT publication_invites_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.publications(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.publication_members
    ADD CONSTRAINT publication_members_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.publication_members
    ADD CONSTRAINT publication_members_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.publications(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.publication_payout_splits
    ADD CONSTRAINT publication_payout_splits_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);


ALTER TABLE ONLY public.publication_payout_splits
    ADD CONSTRAINT publication_payout_splits_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id);


ALTER TABLE ONLY public.publication_payout_splits
    ADD CONSTRAINT publication_payout_splits_publication_payout_id_fkey FOREIGN KEY (publication_payout_id) REFERENCES public.publication_payouts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.publication_payouts
    ADD CONSTRAINT publication_payouts_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.publications(id);


ALTER TABLE ONLY public.read_events
    ADD CONSTRAINT read_events_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.read_events
    ADD CONSTRAINT read_events_reader_id_fkey FOREIGN KEY (reader_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.read_events
    ADD CONSTRAINT read_events_tab_id_fkey FOREIGN KEY (tab_id) REFERENCES public.reading_tabs(id) ON DELETE SET NULL;


ALTER TABLE ONLY public.read_events
    ADD CONSTRAINT read_events_via_subscription_id_fkey FOREIGN KEY (via_subscription_id) REFERENCES public.subscriptions(id);


ALTER TABLE ONLY public.read_events
    ADD CONSTRAINT read_events_writer_id_fkey FOREIGN KEY (writer_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.reading_positions
    ADD CONSTRAINT reading_positions_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.reading_positions
    ADD CONSTRAINT reading_positions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.reading_tabs
    ADD CONSTRAINT reading_tabs_reader_id_fkey FOREIGN KEY (reader_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.resolver_async_results
    ADD CONSTRAINT resolver_async_results_initiator_id_fkey FOREIGN KEY (initiator_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.subscription_events
    ADD CONSTRAINT subscription_events_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id);


ALTER TABLE ONLY public.subscription_events
    ADD CONSTRAINT subscription_events_reader_id_fkey FOREIGN KEY (reader_id) REFERENCES public.accounts(id);


ALTER TABLE ONLY public.subscription_events
    ADD CONSTRAINT subscription_events_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.subscriptions(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.subscription_events
    ADD CONSTRAINT subscription_events_writer_id_fkey FOREIGN KEY (writer_id) REFERENCES public.accounts(id);


ALTER TABLE ONLY public.subscription_nudge_log
    ADD CONSTRAINT subscription_nudge_log_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.publications(id);


ALTER TABLE ONLY public.subscription_nudge_log
    ADD CONSTRAINT subscription_nudge_log_reader_id_fkey FOREIGN KEY (reader_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.subscription_nudge_log
    ADD CONSTRAINT subscription_nudge_log_writer_id_fkey FOREIGN KEY (writer_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.subscription_offers
    ADD CONSTRAINT subscription_offers_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.accounts(id);


ALTER TABLE ONLY public.subscription_offers
    ADD CONSTRAINT subscription_offers_writer_id_fkey FOREIGN KEY (writer_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_offer_id_fkey FOREIGN KEY (offer_id) REFERENCES public.subscription_offers(id);


ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.publications(id);


ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_reader_id_fkey FOREIGN KEY (reader_id) REFERENCES public.accounts(id);


ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_writer_id_fkey FOREIGN KEY (writer_id) REFERENCES public.accounts(id);


ALTER TABLE ONLY public.tab_settlements
    ADD CONSTRAINT tab_settlements_reader_id_fkey FOREIGN KEY (reader_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.tab_settlements
    ADD CONSTRAINT tab_settlements_tab_id_fkey FOREIGN KEY (tab_id) REFERENCES public.reading_tabs(id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.trust_layer1
    ADD CONSTRAINT trust_layer1_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.accounts(id);


ALTER TABLE ONLY public.trust_polls
    ADD CONSTRAINT trust_polls_respondent_id_fkey FOREIGN KEY (respondent_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.trust_polls
    ADD CONSTRAINT trust_polls_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.trust_profiles
    ADD CONSTRAINT trust_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.accounts(id);


ALTER TABLE ONLY public.vault_keys
    ADD CONSTRAINT vault_keys_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE RESTRICT;


ALTER TABLE ONLY public.vote_charges
    ADD CONSTRAINT vote_charges_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.accounts(id);


ALTER TABLE ONLY public.vote_charges
    ADD CONSTRAINT vote_charges_tab_id_fkey FOREIGN KEY (tab_id) REFERENCES public.reading_tabs(id) ON DELETE SET NULL;


ALTER TABLE ONLY public.vote_charges
    ADD CONSTRAINT vote_charges_vote_id_fkey FOREIGN KEY (vote_id) REFERENCES public.votes(id);


ALTER TABLE ONLY public.vote_charges
    ADD CONSTRAINT vote_charges_voter_id_fkey FOREIGN KEY (voter_id) REFERENCES public.accounts(id);


ALTER TABLE ONLY public.votes
    ADD CONSTRAINT votes_tab_id_fkey FOREIGN KEY (tab_id) REFERENCES public.reading_tabs(id) ON DELETE SET NULL;


ALTER TABLE ONLY public.votes
    ADD CONSTRAINT votes_target_author_id_fkey FOREIGN KEY (target_author_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.votes
    ADD CONSTRAINT votes_voter_id_fkey FOREIGN KEY (voter_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.vouches
    ADD CONSTRAINT vouches_attestor_id_fkey FOREIGN KEY (attestor_id) REFERENCES public.accounts(id);


ALTER TABLE ONLY public.vouches
    ADD CONSTRAINT vouches_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES public.accounts(id);


ALTER TABLE ONLY public.writer_payouts
    ADD CONSTRAINT writer_payouts_writer_id_fkey FOREIGN KEY (writer_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;


ALTER TABLE ONLY traffology.sessions
    ADD CONSTRAINT fk_sessions_source FOREIGN KEY (resolved_source_id) REFERENCES traffology.sources(id) ON DELETE SET NULL;


ALTER TABLE ONLY traffology.half_day_buckets
    ADD CONSTRAINT half_day_buckets_piece_id_fkey FOREIGN KEY (piece_id) REFERENCES traffology.pieces(id) ON DELETE CASCADE;


ALTER TABLE ONLY traffology.half_day_buckets
    ADD CONSTRAINT half_day_buckets_source_id_fkey FOREIGN KEY (source_id) REFERENCES traffology.sources(id) ON DELETE CASCADE;


ALTER TABLE ONLY traffology.nostr_events
    ADD CONSTRAINT nostr_events_piece_id_fkey FOREIGN KEY (piece_id) REFERENCES traffology.pieces(id) ON DELETE CASCADE;


ALTER TABLE ONLY traffology.observations
    ADD CONSTRAINT observations_piece_id_fkey FOREIGN KEY (piece_id) REFERENCES traffology.pieces(id) ON DELETE CASCADE;


ALTER TABLE ONLY traffology.observations
    ADD CONSTRAINT observations_writer_id_fkey FOREIGN KEY (writer_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY traffology.piece_stats
    ADD CONSTRAINT piece_stats_piece_id_fkey FOREIGN KEY (piece_id) REFERENCES traffology.pieces(id) ON DELETE CASCADE;


ALTER TABLE ONLY traffology.piece_stats
    ADD CONSTRAINT piece_stats_top_source_id_fkey FOREIGN KEY (top_source_id) REFERENCES traffology.sources(id) ON DELETE SET NULL;


ALTER TABLE ONLY traffology.pieces
    ADD CONSTRAINT pieces_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


ALTER TABLE ONLY traffology.pieces
    ADD CONSTRAINT pieces_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.publications(id) ON DELETE SET NULL;


ALTER TABLE ONLY traffology.pieces
    ADD CONSTRAINT pieces_writer_id_fkey FOREIGN KEY (writer_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY traffology.public_mentions
    ADD CONSTRAINT public_mentions_piece_id_fkey FOREIGN KEY (piece_id) REFERENCES traffology.pieces(id) ON DELETE CASCADE;


ALTER TABLE ONLY traffology.publication_baselines
    ADD CONSTRAINT publication_baselines_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.publications(id) ON DELETE CASCADE;


ALTER TABLE ONLY traffology.sessions
    ADD CONSTRAINT sessions_piece_id_fkey FOREIGN KEY (piece_id) REFERENCES traffology.pieces(id) ON DELETE CASCADE;


ALTER TABLE ONLY traffology.source_stats
    ADD CONSTRAINT source_stats_piece_id_fkey FOREIGN KEY (piece_id) REFERENCES traffology.pieces(id) ON DELETE CASCADE;


ALTER TABLE ONLY traffology.source_stats
    ADD CONSTRAINT source_stats_source_id_fkey FOREIGN KEY (source_id) REFERENCES traffology.sources(id) ON DELETE CASCADE;


ALTER TABLE ONLY traffology.sources
    ADD CONSTRAINT sources_allhaus_writer_id_fkey FOREIGN KEY (allhaus_writer_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


ALTER TABLE ONLY traffology.sources
    ADD CONSTRAINT sources_writer_id_fkey FOREIGN KEY (writer_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY traffology.topic_performance
    ADD CONSTRAINT topic_performance_writer_id_fkey FOREIGN KEY (writer_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


ALTER TABLE ONLY traffology.writer_baselines
    ADD CONSTRAINT writer_baselines_writer_id_fkey FOREIGN KEY (writer_id) REFERENCES public.accounts(id) ON DELETE CASCADE;



-- =============================================================================
-- Table documentation (COMMENT ON)
-- =============================================================================

-- Core identity
COMMENT ON TABLE accounts IS 'User accounts — writers and readers. Custodial Nostr keypair per account (privkey in key-custody).';
COMMENT ON TABLE magic_links IS 'Passwordless login tokens — 32-byte random, SHA-256 hashed, 15-min TTL, single-use.';

-- Content
COMMENT ON TABLE articles IS 'Published articles (Nostr kind 30023). Dual-written to feed_items on publish.';
COMMENT ON TABLE article_drafts IS 'Autosaved article drafts. One active draft per (writer_id, d_tag) pair.';
COMMENT ON TABLE notes IS 'Short-form posts (Nostr kind 1). Dual-written to feed_items on create.';
COMMENT ON TABLE vault_keys IS 'Encrypted content keys for paywalled articles. Envelope-encrypted with KMS master key.';
COMMENT ON TABLE content_key_issuances IS 'Audit log of NIP-44 key issuances to readers for paywall unlock.';
COMMENT ON TABLE article_unlocks IS 'Permanent unlock records — reader has lifetime access after payment.';

-- Feed system
COMMENT ON TABLE feed_items IS 'Denormalised unified timeline. Articles, notes, and external items dual-written here. Single-table scan for all feed queries.';
COMMENT ON TABLE feed_engagement IS 'Vote/reply counts driving HN-style gravity scoring. Refreshed every 5 min.';
COMMENT ON TABLE feed_scores IS 'Publication-scoped content scoring for explore feed.';
COMMENT ON TABLE external_sources IS 'Canonical external feed sources (RSS URLs, Nostr pubkeys, atproto DIDs, AP actor URIs). Shared across users.';
COMMENT ON TABLE external_subscriptions IS 'Per-user subscription to an external_source. Controls what appears in their following feed.';
COMMENT ON TABLE external_items IS 'Normalised content from external protocols. Source of truth for external content; feed_items references these via source_item_uri.';

-- Workspace (experiment)
COMMENT ON TABLE feeds IS 'User-created feed containers for the workspace experiment. Each feed has sources and a sampling/ordering strategy.';
COMMENT ON TABLE feed_sources IS 'Discriminated union: what populates a workspace feed. Types: native_account, native_publication, external_source, tag.';
COMMENT ON TABLE feed_saves IS 'User-saved feed items within a workspace feed. Equivalent of bookmarks scoped to a feed.';

-- Payments
COMMENT ON TABLE reading_tabs IS 'Stripe-backed reading tab per reader. Accumulates spend, settles at threshold or monthly.';
COMMENT ON TABLE read_events IS 'Individual read charges. State machine: provisional → accrued → platform_settled → writer_paid.';
COMMENT ON TABLE tab_settlements IS 'Stripe PaymentIntent records for tab settlement charges.';
COMMENT ON TABLE writer_payouts IS 'Stripe Connect transfer records for writer earnings payouts.';
COMMENT ON TABLE pledge_drives IS 'Crowdfunding drives where readers pledge toward article unlock goals.';
COMMENT ON TABLE pledges IS 'Individual pledges toward a drive. Converted to read_events when drive succeeds.';

-- Subscriptions
COMMENT ON TABLE subscriptions IS 'Writer and publication subscriptions with auto-renewal, free allowance, annual/monthly pricing.';
COMMENT ON TABLE subscription_events IS 'Immutable log of subscription lifecycle events (create, renew, cancel, expire, reactivate).';
COMMENT ON TABLE subscription_offers IS 'Time-limited promotional pricing for subscriptions.';
COMMENT ON TABLE subscription_nudge_log IS 'Rate-limits subscription nudge UI to once per reader/publication/month.';

-- Publications
COMMENT ON TABLE publications IS 'Multi-author publications. Ownership, branding, payout config.';
COMMENT ON TABLE publication_members IS 'Role-based membership (editor_in_chief, editor, contributor).';
COMMENT ON TABLE publication_invites IS 'Pending membership invitations with role and revenue share.';
COMMENT ON TABLE publication_follows IS 'Reader follows on publications (distinct from writer follows).';
COMMENT ON TABLE publication_article_shares IS 'Cross-publication article syndication records.';
COMMENT ON TABLE publication_payout_splits IS 'Per-article revenue share overrides for publication contributors.';
COMMENT ON TABLE publication_payouts IS 'Publication-level payout aggregation and Stripe transfer records.';

-- Trust graph
COMMENT ON TABLE trust_layer1 IS 'Precomputed per-user trust signals (account age, paying readers, article count, Stripe KYC, NIP-05). Daily cron refresh.';
COMMENT ON TABLE trust_profiles IS 'Dimension scores from epoch aggregation. Four dimensions: humanity, encounter, identity, integrity.';
COMMENT ON TABLE vouches IS 'Per-attestor/subject/dimension endorsements. Values: affirm/contest. Visibility: public/aggregate.';
COMMENT ON TABLE trust_epochs IS 'Audit trail of trust aggregation runs (quarterly full + Mon/Thu mop-ups).';
COMMENT ON TABLE trust_polls IS 'Pip poll voting per subject — allows network to weigh in on trust signals.';

-- Social
COMMENT ON TABLE follows IS 'Writer-to-writer follow graph.';
COMMENT ON TABLE blocks IS 'User block list. Excluded from feeds, replies, DMs.';
COMMENT ON TABLE mutes IS 'User mute list. Hidden from feeds without blocking interaction.';
COMMENT ON TABLE votes IS 'Per-user votes on articles/notes/comments. Exponential cost curve.';
COMMENT ON TABLE vote_tallies IS 'Precomputed net vote scores per target. Updated atomically via advisory locks.';
COMMENT ON TABLE vote_charges IS 'Tab charges for votes (votes cost pence, tracked separately from reads).';
COMMENT ON TABLE comments IS 'Threaded replies on articles and notes. parentCommentId for tree structure.';
COMMENT ON TABLE bookmarks IS 'User article bookmarks.';

-- Messaging
COMMENT ON TABLE conversations IS 'DM conversations. Members joined via conversation_members.';
COMMENT ON TABLE conversation_members IS 'Conversation membership with per-member read cursor.';
COMMENT ON TABLE direct_messages IS 'NIP-44 encrypted DM content per recipient. One row per (message, recipient).';
COMMENT ON TABLE dm_pricing IS 'Per-user DM access pricing (pay-to-message). Per-user overrides.';
COMMENT ON TABLE dm_likes IS 'Message reactions within DM conversations.';

-- External feed integration
COMMENT ON TABLE linked_accounts IS 'OAuth credentials for cross-posting (Mastodon, Bluesky). AES-256-GCM encrypted.';
COMMENT ON TABLE outbound_posts IS 'Cross-post queue with retry state. Protocol dispatch by linked account type.';
COMMENT ON TABLE oauth_app_registrations IS 'Per-Mastodon-instance dynamic OAuth client registrations.';
COMMENT ON TABLE atproto_oauth_sessions IS 'AT Protocol OAuth session store (DPoP-bound, AES-256-GCM encrypted).';
COMMENT ON TABLE atproto_oauth_pending_states IS 'PKCE/DPoP state for in-flight AT Protocol OAuth authorize→callback flow.';
COMMENT ON TABLE activitypub_instance_health IS 'Per-Mastodon-instance success/failure counters for operational monitoring.';

-- Relay outbox
COMMENT ON TABLE relay_outbox IS 'Durable queue for Nostr event relay publishing. Worker owns retry with advisory locks.';

-- Resolver
COMMENT ON TABLE resolver_async_results IS 'Phase B async resolution results. Initiator-bound, 60s TTL, pruned every 5 min.';

-- Notifications & platform
COMMENT ON TABLE notifications IS 'In-app notification queue with type routing and actor/target references.';
COMMENT ON TABLE notification_preferences IS 'Per-user notification type opt-out preferences.';
COMMENT ON TABLE reading_positions IS 'Scroll position saves for reading-history resumption.';
COMMENT ON TABLE moderation_reports IS 'User-submitted content/account reports for admin review.';
COMMENT ON TABLE platform_config IS 'Singleton platform configuration (fee BPS, admin account IDs, feature flags).';
COMMENT ON TABLE stripe_webhook_events IS 'Webhook deduplication. processed_at nullable for crash-between-receipt-and-completion.';
COMMENT ON TABLE gift_links IS 'Shareable article access links with redemption limits and tracking.';
COMMENT ON TABLE tags IS 'Normalised tag names for article categorisation.';
COMMENT ON TABLE article_tags IS 'Many-to-many article↔tag join table.';
COMMENT ON TABLE media_uploads IS 'Content-addressed media uploads. SHA-256 dedup, Sharp-processed.';

-- Traffology (analytics)
COMMENT ON SCHEMA traffology IS 'Writer analytics pipeline. Separate schema for isolation. Ingests page-view beacons, aggregates hourly/daily/weekly, generates observations.';
COMMENT ON TABLE traffology.sessions IS 'Page-view sessions from beacon heartbeats. IP hashed with SHA-256 + salt, no raw PII stored.';
COMMENT ON TABLE traffology.pieces IS 'Traffology mirror of articles — maps article_id to writer_id for analytics ownership.';
COMMENT ON TABLE traffology.sources IS 'Resolved traffic sources (referrer → categorised source with domain/path).';
COMMENT ON TABLE traffology.piece_stats IS 'Hourly aggregated per-article metrics (readers, time, new vs returning).';
COMMENT ON TABLE traffology.source_stats IS 'Hourly aggregated per-source traffic metrics.';
COMMENT ON TABLE traffology.half_day_buckets IS 'AM/PM bucketed read distribution for time-of-day analysis.';
COMMENT ON TABLE traffology.observations IS 'AI-generated editorial observations about traffic patterns and anomalies.';
COMMENT ON TABLE traffology.writer_baselines IS 'Rolling writer-level baselines for anomaly detection.';
COMMENT ON TABLE traffology.publication_baselines IS 'Rolling publication-level baselines for anomaly detection.';
COMMENT ON TABLE traffology.topic_performance IS 'Per-tag/topic performance aggregates for content strategy insights.';
COMMENT ON TABLE traffology.nostr_events IS 'Reserved for Phase 2: Nostr social signal ingestion (mentions, zaps, reposts).';
COMMENT ON TABLE traffology.public_mentions IS 'Reserved for Phase 3: web mention discovery and tracking.';

-- =============================================================================
-- Seed _migrations to prevent re-running on existing databases
-- =============================================================================

INSERT INTO _migrations (filename) VALUES
  ('001_add_email_and_magic_links.sql'),
  ('002_draft_upsert_index.sql'),
  ('003_comments.sql'),
  ('004_media_uploads.sql'),
  ('005_subscriptions.sql'),
  ('006_receipt_portability.sql'),
  ('007_subscription_nostr_event.sql'),
  ('008_deduplicate_articles.sql'),
  ('009_notifications.sql'),
  ('010_votes.sql'),
  ('011_store_ciphertext.sql'),
  ('012_notification_note_id.sql'),
  ('013_note_excerpt_fields.sql'),
  ('014_notification_dedup.sql'),
  ('015_access_mode_and_unlock_types.sql'),
  ('016_direct_messages.sql'),
  ('017_pledge_drives.sql'),
  ('018_add_on_delete_clauses.sql'),
  ('019_fix_notification_dedup.sql'),
  ('020_notification_routing_columns.sql'),
  ('021_missing_on_delete_clauses.sql'),
  ('022_composite_index_read_events.sql'),
  ('023_subscription_auto_renew.sql'),
  ('024_annual_subscriptions.sql'),
  ('025_comp_subscriptions.sql'),
  ('026_article_profile_pins.sql'),
  ('027_subscription_visibility.sql'),
  ('028_subscription_nudge.sql'),
  ('029_gift_links.sql'),
  ('030_commissions_expansion.sql'),
  ('031_fix_media_urls_domain.sql'),
  ('032_dm_likes.sql'),
  ('033_admin_account_ids_config.sql'),
  ('034_dm_replies.sql'),
  ('035_feed_scores.sql'),
  ('036_commission_conversation.sql'),
  ('037_subscription_offers.sql'),
  ('038_publications.sql'),
  ('039_default_article_price.sql'),
  ('040_traffology_schema.sql'),
  ('041_webhook_dedup_and_fk_fixes.sql'),
  ('042_email_on_publish.sql'),
  ('043_session_invalidation.sql'),
  ('044_email_on_publish_v2.sql'),
  ('045_article_price_mode.sql'),
  ('046_notification_preferences.sql'),
  ('047_bookmarks.sql'),
  ('048_tags.sql'),
  ('049_account_deletion.sql'),
  ('050_publication_management.sql'),
  ('051_article_scheduling.sql'),
  ('052_universal_feed_external.sql'),
  ('053_feed_items.sql'),
  ('054_feed_items_backfill.sql'),
  ('055_universal_feed_atproto.sql'),
  ('056_universal_feed_activitypub.sql'),
  ('057_universal_feed_outbound.sql'),
  ('058_outbound_nostr_queue.sql'),
  ('059_atproto_oauth_sessions.sql'),
  ('060_atproto_oauth_pending_states.sql'),
  ('061_resolver_async_results.sql'),
  ('062_outbound_posts_dedup.sql'),
  ('063_external_sources_gc.sql'),
  ('064_resolver_async_results_initiator_idx.sql'),
  ('065_trust_layer1.sql'),
  ('066_vouches_trust_profiles.sql'),
  ('067_trust_epochs.sql'),
  ('068_article_size_tier.sql'),
  ('069_reading_positions.sql'),
  ('070_harmonize_size_tier_trigger.sql'),
  ('071_stripe_webhook_processed_at_nullable.sql'),
  ('072_subscription_events_expiry_warning.sql'),
  ('073_dm_send_id.sql'),
  ('074_accounts_search_trgm.sql'),
  ('075_external_sources_metadata_updated_at.sql'),
  ('076_relay_outbox.sql'),
  ('077_workspace_feeds.sql'),
  ('078_trust_polls.sql'),
  ('079_pip_status_contested.sql'),
  ('080_feed_saves.sql'),
  ('081_article_cover_image.sql'),
  ('082_feed_sources_default_volume.sql'),
  ('083_search_content_trgm_index.sql'),
  ('084_email_verification_requested_at.sql')
ON CONFLICT (filename) DO NOTHING;

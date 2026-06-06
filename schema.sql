--
-- PostgreSQL database dump
--

\restrict onI46j7hnaW5pnrjeiahuI2efghI6TfxQMbEL1tOCjtrzOx3jHpMqks3a3muPHc

-- Dumped from database version 16.13
-- Dumped by pg_dump version 16.13

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: graphile_worker; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA graphile_worker;


--
-- Name: traffology; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA traffology;


--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: job_spec; Type: TYPE; Schema: graphile_worker; Owner: -
--

CREATE TYPE graphile_worker.job_spec AS (
	identifier text,
	payload json,
	queue_name text,
	run_at timestamp with time zone,
	max_attempts smallint,
	job_key text,
	priority smallint,
	flags text[]
);


--
-- Name: account_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.account_status AS ENUM (
    'active',
    'suspended',
    'moderated',
    'deactivated'
);


--
-- Name: content_tier; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.content_tier AS ENUM (
    'tier1',
    'tier2',
    'tier3',
    'tier4'
);


--
-- Name: content_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.content_type AS ENUM (
    'note',
    'article'
);


--
-- Name: contributor_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.contributor_type AS ENUM (
    'permanent',
    'one_off'
);


--
-- Name: drive_origin; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.drive_origin AS ENUM (
    'crowdfund',
    'commission'
);


--
-- Name: drive_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.drive_status AS ENUM (
    'open',
    'funded',
    'published',
    'fulfilled',
    'expired',
    'cancelled'
);


--
-- Name: external_protocol; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.external_protocol AS ENUM (
    'atproto',
    'activitypub',
    'rss',
    'nostr_external',
    'farcaster',
    'matrix',
    'telegram',
    'email'
);


--
-- Name: payout_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.payout_status AS ENUM (
    'pending',
    'initiated',
    'completed',
    'failed'
);


--
-- Name: pledge_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.pledge_status AS ENUM (
    'active',
    'fulfilled',
    'void'
);


--
-- Name: publication_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.publication_role AS ENUM (
    'editor_in_chief',
    'editor',
    'contributor'
);


--
-- Name: read_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.read_state AS ENUM (
    'provisional',
    'accrued',
    'platform_settled',
    'writer_paid'
);


--
-- Name: report_category; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.report_category AS ENUM (
    'illegal_content',
    'harassment',
    'spam',
    'other'
);


--
-- Name: report_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.report_status AS ENUM (
    'open',
    'under_review',
    'resolved_removed',
    'resolved_no_action'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: _private_jobs; Type: TABLE; Schema: graphile_worker; Owner: -
--

CREATE TABLE graphile_worker._private_jobs (
    id bigint NOT NULL,
    job_queue_id integer,
    task_id integer NOT NULL,
    payload json DEFAULT '{}'::json NOT NULL,
    priority smallint DEFAULT 0 NOT NULL,
    run_at timestamp with time zone DEFAULT now() NOT NULL,
    attempts smallint DEFAULT 0 NOT NULL,
    max_attempts smallint DEFAULT 25 NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    key text,
    locked_at timestamp with time zone,
    locked_by text,
    revision integer DEFAULT 0 NOT NULL,
    flags jsonb,
    is_available boolean GENERATED ALWAYS AS (((locked_at IS NULL) AND (attempts < max_attempts))) STORED NOT NULL,
    CONSTRAINT jobs_key_check CHECK (((length(key) > 0) AND (length(key) <= 512))),
    CONSTRAINT jobs_max_attempts_check CHECK ((max_attempts >= 1))
);


--
-- Name: add_job(text, json, text, timestamp with time zone, integer, text, integer, text[], text); Type: FUNCTION; Schema: graphile_worker; Owner: -
--

CREATE FUNCTION graphile_worker.add_job(identifier text, payload json DEFAULT NULL::json, queue_name text DEFAULT NULL::text, run_at timestamp with time zone DEFAULT NULL::timestamp with time zone, max_attempts integer DEFAULT NULL::integer, job_key text DEFAULT NULL::text, priority integer DEFAULT NULL::integer, flags text[] DEFAULT NULL::text[], job_key_mode text DEFAULT 'replace'::text) RETURNS graphile_worker._private_jobs
    LANGUAGE plpgsql
    AS $$
declare
  v_job "graphile_worker"._private_jobs;
begin
  if (job_key is null or job_key_mode is null or job_key_mode in ('replace', 'preserve_run_at')) then
    select * into v_job
    from "graphile_worker".add_jobs(
      ARRAY[(
        identifier,
        payload,
        queue_name,
        run_at,
        max_attempts::smallint,
        job_key,
        priority::smallint,
        flags
      )::"graphile_worker".job_spec],
      (job_key_mode = 'preserve_run_at')
    )
    limit 1;
    return v_job;
  elsif job_key_mode = 'unsafe_dedupe' then
    -- Ensure all the tasks exist
    insert into "graphile_worker"._private_tasks as tasks (identifier)
    values (add_job.identifier)
    on conflict do nothing;
    -- Ensure all the queues exist
    if add_job.queue_name is not null then
      insert into "graphile_worker"._private_job_queues as job_queues (queue_name)
      values (add_job.queue_name)
      on conflict do nothing;
    end if;
    -- Insert job, but if one already exists then do nothing, even if the
    -- existing job has already started (and thus represents an out-of-date
    -- world state). This is dangerous because it means that whatever state
    -- change triggered this add_job may not be acted upon (since it happened
    -- after the existing job started executing, but no further job is being
    -- scheduled), but it is useful in very rare circumstances for
    -- de-duplication. If in doubt, DO NOT USE THIS.
    insert into "graphile_worker"._private_jobs as jobs (
      job_queue_id,
      task_id,
      payload,
      run_at,
      max_attempts,
      key,
      priority,
      flags
    )
      select
        job_queues.id,
        tasks.id,
        coalesce(add_job.payload, '{}'::json),
        coalesce(add_job.run_at, now()),
        coalesce(add_job.max_attempts::smallint, 25::smallint),
        add_job.job_key,
        coalesce(add_job.priority::smallint, 0::smallint),
        (
          select jsonb_object_agg(flag, true)
          from unnest(add_job.flags) as item(flag)
        )
      from "graphile_worker"._private_tasks as tasks
      left join "graphile_worker"._private_job_queues as job_queues
      on job_queues.queue_name = add_job.queue_name
      where tasks.identifier = add_job.identifier
    on conflict (key)
      -- Bump the updated_at so that there's something to return
      do update set
        revision = jobs.revision + 1,
        updated_at = now()
      returning *
      into v_job;
    if v_job.revision = 0 then
      perform pg_notify('jobs:insert', '{"r":' || random()::text || ',"count":1}');
    end if;
    return v_job;
  else
    raise exception 'Invalid job_key_mode value, expected ''replace'', ''preserve_run_at'' or ''unsafe_dedupe''.' using errcode = 'GWBKM';
  end if;
end;
$$;


--
-- Name: add_jobs(graphile_worker.job_spec[], boolean); Type: FUNCTION; Schema: graphile_worker; Owner: -
--

CREATE FUNCTION graphile_worker.add_jobs(specs graphile_worker.job_spec[], job_key_preserve_run_at boolean DEFAULT false) RETURNS SETOF graphile_worker._private_jobs
    LANGUAGE plpgsql
    AS $$
begin
  -- Ensure all the tasks exist
  insert into "graphile_worker"._private_tasks as tasks (identifier)
  select distinct spec.identifier
  from unnest(specs) spec
  on conflict do nothing;
  -- Ensure all the queues exist
  insert into "graphile_worker"._private_job_queues as job_queues (queue_name)
  select distinct spec.queue_name
  from unnest(specs) spec
  where spec.queue_name is not null
  on conflict do nothing;
  -- Ensure any locked jobs have their key cleared - in the case of locked
  -- existing job create a new job instead as it must have already started
  -- executing (i.e. it's world state is out of date, and the fact add_job
  -- has been called again implies there's new information that needs to be
  -- acted upon).
  update "graphile_worker"._private_jobs as jobs
  set
    key = null,
    attempts = jobs.max_attempts,
    updated_at = now()
  from unnest(specs) spec
  where spec.job_key is not null
  and jobs.key = spec.job_key
  and is_available is not true;

  -- WARNING: this count is not 100% accurate; 'on conflict' clause will cause it to be an overestimate
  perform pg_notify('jobs:insert', '{"r":' || random()::text || ',"count":' || array_length(specs, 1)::text || '}');

  -- TODO: is there a risk that a conflict could occur depending on the
  -- isolation level?
  return query insert into "graphile_worker"._private_jobs as jobs (
    job_queue_id,
    task_id,
    payload,
    run_at,
    max_attempts,
    key,
    priority,
    flags
  )
    select
      job_queues.id,
      tasks.id,
      coalesce(spec.payload, '{}'::json),
      coalesce(spec.run_at, now()),
      coalesce(spec.max_attempts, 25),
      spec.job_key,
      coalesce(spec.priority, 0),
      (
        select jsonb_object_agg(flag, true)
        from unnest(spec.flags) as item(flag)
      )
    from unnest(specs) spec
    inner join "graphile_worker"._private_tasks as tasks
    on tasks.identifier = spec.identifier
    left join "graphile_worker"._private_job_queues as job_queues
    on job_queues.queue_name = spec.queue_name
  on conflict (key) do update set
    job_queue_id = excluded.job_queue_id,
    task_id = excluded.task_id,
    payload =
      case
      when json_typeof(jobs.payload) = 'array' and json_typeof(excluded.payload) = 'array' then
        (jobs.payload::jsonb || excluded.payload::jsonb)::json
      else
        excluded.payload
      end,
    max_attempts = excluded.max_attempts,
    run_at = (case
      when job_key_preserve_run_at is true and jobs.attempts = 0 then jobs.run_at
      else excluded.run_at
    end),
    priority = excluded.priority,
    revision = jobs.revision + 1,
    flags = excluded.flags,
    -- always reset error/retry state
    attempts = 0,
    last_error = null,
    updated_at = now()
  where jobs.locked_at is null
  returning *;
end;
$$;


--
-- Name: complete_jobs(bigint[]); Type: FUNCTION; Schema: graphile_worker; Owner: -
--

CREATE FUNCTION graphile_worker.complete_jobs(job_ids bigint[]) RETURNS SETOF graphile_worker._private_jobs
    LANGUAGE sql
    AS $$
  delete from "graphile_worker"._private_jobs as jobs
    where id = any(job_ids)
    and (
      locked_at is null
    or
      locked_at < now() - interval '4 hours'
    )
    returning *;
$$;


--
-- Name: force_unlock_workers(text[]); Type: FUNCTION; Schema: graphile_worker; Owner: -
--

CREATE FUNCTION graphile_worker.force_unlock_workers(worker_ids text[]) RETURNS void
    LANGUAGE sql
    AS $$
update "graphile_worker"._private_jobs as jobs
set locked_at = null, locked_by = null
where locked_by = any(worker_ids);
update "graphile_worker"._private_job_queues as job_queues
set locked_at = null, locked_by = null
where locked_by = any(worker_ids);
$$;


--
-- Name: permanently_fail_jobs(bigint[], text); Type: FUNCTION; Schema: graphile_worker; Owner: -
--

CREATE FUNCTION graphile_worker.permanently_fail_jobs(job_ids bigint[], error_message text DEFAULT NULL::text) RETURNS SETOF graphile_worker._private_jobs
    LANGUAGE sql
    AS $$
  update "graphile_worker"._private_jobs as jobs
    set
      last_error = coalesce(error_message, 'Manually marked as failed'),
      attempts = max_attempts,
      updated_at = now()
    where id = any(job_ids)
    and (
      locked_at is null
    or
      locked_at < NOW() - interval '4 hours'
    )
    returning *;
$$;


--
-- Name: remove_job(text); Type: FUNCTION; Schema: graphile_worker; Owner: -
--

CREATE FUNCTION graphile_worker.remove_job(job_key text) RETURNS graphile_worker._private_jobs
    LANGUAGE plpgsql STRICT
    AS $$
declare
  v_job "graphile_worker"._private_jobs;
begin
  -- Delete job if not locked
  delete from "graphile_worker"._private_jobs as jobs
    where key = job_key
    and (
      locked_at is null
    or
      locked_at < NOW() - interval '4 hours'
    )
  returning * into v_job;
  if not (v_job is null) then
    perform pg_notify('jobs:insert', '{"r":' || random()::text || ',"count":-1}');
    return v_job;
  end if;
  -- Otherwise prevent job from retrying, and clear the key
  update "graphile_worker"._private_jobs as jobs
  set
    key = null,
    attempts = jobs.max_attempts,
    updated_at = now()
  where key = job_key
  returning * into v_job;
  return v_job;
end;
$$;


--
-- Name: reschedule_jobs(bigint[], timestamp with time zone, integer, integer, integer); Type: FUNCTION; Schema: graphile_worker; Owner: -
--

CREATE FUNCTION graphile_worker.reschedule_jobs(job_ids bigint[], run_at timestamp with time zone DEFAULT NULL::timestamp with time zone, priority integer DEFAULT NULL::integer, attempts integer DEFAULT NULL::integer, max_attempts integer DEFAULT NULL::integer) RETURNS SETOF graphile_worker._private_jobs
    LANGUAGE sql
    AS $$
  update "graphile_worker"._private_jobs as jobs
    set
      run_at = coalesce(reschedule_jobs.run_at, jobs.run_at),
      priority = coalesce(reschedule_jobs.priority::smallint, jobs.priority),
      attempts = coalesce(reschedule_jobs.attempts::smallint, jobs.attempts),
      max_attempts = coalesce(reschedule_jobs.max_attempts::smallint, jobs.max_attempts),
      updated_at = now()
    where id = any(job_ids)
    and (
      locked_at is null
    or
      locked_at < NOW() - interval '4 hours'
    )
    returning *;
$$;


--
-- Name: articles_derive_size_tier(); Type: FUNCTION; Schema: public; Owner: -
--

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


--
-- Name: feed_items_content_version(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.feed_items_content_version(p_external_item_id uuid) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  v_text  TEXT;
  v_title TEXT;
  v_media TEXT;
BEGIN
  SELECT
    btrim(regexp_replace(regexp_replace(coalesce(ei.content_text, ''), E'\r\n?', E'\n', 'g'),
                         E'[ \t]+\n', E'\n', 'g')),
    coalesce(ei.title, ''),
    coalesce((SELECT string_agg(coalesce(m->>'uri', m->>'url', ''), ',' ORDER BY ord)
              FROM jsonb_array_elements(coalesce(ei.media, '[]'::jsonb)) WITH ORDINALITY x(m, ord)), '')
  INTO v_text, v_title, v_media
  FROM external_items ei
  WHERE ei.id = p_external_item_id;

  RETURN encode(digest(coalesce(v_text, '') || E'\x1f' || v_title || E'\x1f' || v_media, 'sha256'), 'hex');
END;
$$;


--
-- Name: feed_items_derive_post_id(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.feed_items_derive_post_id(p_protocol text, p_handle text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT encode(digest(p_protocol || E'\x1f' || p_handle, 'sha256'), 'hex');
$$;


--
-- Name: feed_items_post_identity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.feed_items_post_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_pubkey TEXT;
  v_dtag   TEXT;
  v_protocol     TEXT;
  v_handle       TEXT;
  v_tier         TEXT;
  v_author_name  TEXT;
  v_author_handle TEXT;
  v_author_avatar TEXT;
  v_author_uri   TEXT;
  v_interaction  JSONB;
BEGIN
  -- PostId is stable: mint once (NULL on INSERT/backfill), preserve thereafter.
  IF NEW.post_id IS NULL THEN
    IF NEW.article_id IS NOT NULL THEN
      SELECT ac.nostr_pubkey, a.nostr_d_tag INTO v_pubkey, v_dtag
      FROM articles a JOIN accounts ac ON ac.id = a.writer_id
      WHERE a.id = NEW.article_id;
      IF v_pubkey IS NOT NULL AND v_dtag IS NOT NULL THEN
        NEW.post_id := feed_items_derive_post_id('nostr', '30023:' || v_pubkey || ':' || v_dtag);
      ELSE
        -- writer unlinked: fall back to the stable feed_items article identity
        NEW.post_id := feed_items_derive_post_id('nostr_article', NEW.article_id::text);
      END IF;
    ELSIF NEW.note_id IS NOT NULL THEN
      NEW.post_id := feed_items_derive_post_id('nostr', coalesce(NEW.nostr_event_id, NEW.note_id::text));
    ELSIF NEW.external_item_id IS NOT NULL THEN
      NEW.post_id := feed_items_derive_post_id(coalesce(NEW.source_protocol, 'unknown'),
                                               coalesce(NEW.source_item_uri, NEW.external_item_id::text));
    END IF;
  END IF;

  -- version: edit detector. Recompute only when identity/content-bearing columns
  -- change, so hot UPDATEs that touch only `score` (feed_scores_refresh) or author
  -- fields (feed_items_author_refresh) don't pay for the external_items join + hash.
  -- The content-edit dual-write paths always rewrite content_preview/title/event id,
  -- so this proxy detects every real edit.
  IF TG_OP = 'INSERT'
     OR NEW.version IS NULL  -- backfill / never-computed
     OR NEW.nostr_event_id   IS DISTINCT FROM OLD.nostr_event_id
     OR NEW.external_item_id IS DISTINCT FROM OLD.external_item_id
     OR NEW.content_preview  IS DISTINCT FROM OLD.content_preview
     OR NEW.title            IS DISTINCT FROM OLD.title
  THEN
    IF NEW.external_item_id IS NOT NULL THEN
      NEW.version := feed_items_content_version(NEW.external_item_id);
    ELSE
      NEW.version := NEW.nostr_event_id;  -- native: the replaceable/immutable event token
    END IF;
  END IF;

  -- biddability tier (§7). Inputs only change on INSERT or a (rare) protocol/source flip.
  IF TG_OP = 'UPDATE'
     AND NEW.biddability_tier IS NOT NULL  -- already computed (don't skip on backfill)
     AND NEW.item_type        IS NOT DISTINCT FROM OLD.item_type
     AND NEW.source_protocol  IS NOT DISTINCT FROM OLD.source_protocol
     AND NEW.external_item_id IS NOT DISTINCT FROM OLD.external_item_id THEN
    NULL;  -- biddability inputs unchanged; fall through (author block still mint-once-guarded)
  ELSIF NEW.item_type IN ('article', 'note') THEN
    NEW.biddability_tier := 'A';
  ELSIF NEW.source_protocol IN ('nostr_external', 'atproto') THEN
    NEW.biddability_tier := 'A';
  ELSIF NEW.source_protocol = 'activitypub' THEN
    NEW.biddability_tier := 'B';
  ELSIF NEW.source_protocol IN ('rss', 'email') THEN
    NEW.biddability_tier := CASE
      WHEN (SELECT ei.author_uri FROM external_items ei WHERE ei.id = NEW.external_item_id) IS NOT NULL
      THEN 'C' ELSE 'D' END;
  ELSE
    NEW.biddability_tier := 'D';
  END IF;

  -- external-author identity (§4.4 / Phase 0b). Mint once: only when this row is an
  -- external THING with no author link yet AND it is tier A/B (the tiers that carry a
  -- stable origin handle). Tier C/D (rss/email) keep external_author_id NULL forever
  -- (plain-text byline); excluding them here also keeps the hot score/author-refresh
  -- UPDATE path off the external_items join — biddability_tier is already set above.
  IF NEW.external_item_id IS NOT NULL
     AND NEW.external_author_id IS NULL
     AND NEW.biddability_tier IN ('A', 'B') THEN
    SELECT ei.author_name, ei.author_handle, ei.author_avatar_url, ei.author_uri, ei.interaction_data
      INTO v_author_name, v_author_handle, v_author_avatar, v_author_uri, v_interaction
      FROM external_items ei WHERE ei.id = NEW.external_item_id;

    v_protocol := NEW.source_protocol;
    IF v_protocol = 'nostr_external' THEN
      v_handle := v_interaction->>'pubkey';   -- author_uri is null for nostr
      v_tier   := 'A';
    ELSIF v_protocol = 'atproto' THEN
      v_handle := v_author_uri;               -- the DID
      v_tier   := 'A';
    ELSIF v_protocol = 'activitypub' THEN
      v_handle := v_author_uri;               -- the actor URI
      v_tier   := 'B';
    ELSE
      v_handle := NULL;                       -- rss/email -> tier C/D, no record
    END IF;

    IF v_handle IS NOT NULL AND v_handle <> '' THEN
      INSERT INTO external_authors (protocol, stable_handle, tier, display_name, handle, handle_uri, avatar)
      VALUES (v_protocol::external_protocol, v_handle, v_tier,
              v_author_name, v_author_handle,
              CASE WHEN v_protocol IN ('atproto', 'activitypub') THEN v_author_uri ELSE NULL END,
              v_author_avatar)
      ON CONFLICT (protocol, stable_handle) DO UPDATE
        SET last_seen_at = now(),
            display_name = COALESCE(EXCLUDED.display_name, external_authors.display_name),
            handle       = COALESCE(EXCLUDED.handle,       external_authors.handle),
            handle_uri   = COALESCE(EXCLUDED.handle_uri,   external_authors.handle_uri),
            avatar       = COALESCE(EXCLUDED.avatar,       external_authors.avatar)
      RETURNING id INTO NEW.external_author_id;
    END IF;
  END IF;

  -- reply-parent author (§C4 / #11 denormalise). Resolve once on INSERT for reply
  -- rows; best-effort (NULL if the parent isn't ingested yet — feed_items_author_refresh
  -- fills it later). INSERT-only so the cron's maintenance UPDATEs are never clobbered.
  -- Mirrors the read-path subqueries this replaces: native -> parent note author's
  -- display_name; external -> parent item's author_handle (constrained on protocol so
  -- the lookup hits the UNIQUE(protocol, source_item_uri) composite).
  IF TG_OP = 'INSERT' AND NEW.is_reply THEN
    IF NEW.note_id IS NOT NULL THEN
      SELECT acc_p.display_name INTO NEW.reply_to_author
      FROM notes n
      JOIN notes n_p ON n_p.nostr_event_id = n.reply_to_event_id
      JOIN accounts acc_p ON acc_p.id = n_p.author_id
      WHERE n.id = NEW.note_id
      LIMIT 1;
    ELSIF NEW.external_item_id IS NOT NULL THEN
      SELECT ei_p.author_handle INTO NEW.reply_to_author
      FROM external_items ei
      JOIN external_items ei_p
        ON ei_p.protocol = ei.protocol
       AND ei_p.source_item_uri = ei.source_reply_uri
      WHERE ei.id = NEW.external_item_id
      LIMIT 1;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: feed_sources_touch_parent(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.feed_sources_touch_parent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE feeds SET updated_at = now() WHERE id = COALESCE(NEW.feed_id, OLD.feed_id);
  RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: feeds_touch_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.feeds_touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: trust_polls_touch_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trust_polls_touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: _private_job_queues; Type: TABLE; Schema: graphile_worker; Owner: -
--

CREATE TABLE graphile_worker._private_job_queues (
    id integer NOT NULL,
    queue_name text NOT NULL,
    locked_at timestamp with time zone,
    locked_by text,
    is_available boolean GENERATED ALWAYS AS ((locked_at IS NULL)) STORED NOT NULL,
    CONSTRAINT job_queues_queue_name_check CHECK ((length(queue_name) <= 128))
);


--
-- Name: _private_known_crontabs; Type: TABLE; Schema: graphile_worker; Owner: -
--

CREATE TABLE graphile_worker._private_known_crontabs (
    identifier text NOT NULL,
    known_since timestamp with time zone NOT NULL,
    last_execution timestamp with time zone
);


--
-- Name: _private_tasks; Type: TABLE; Schema: graphile_worker; Owner: -
--

CREATE TABLE graphile_worker._private_tasks (
    id integer NOT NULL,
    identifier text NOT NULL,
    CONSTRAINT tasks_identifier_check CHECK ((length(identifier) <= 128))
);


--
-- Name: job_queues_id_seq; Type: SEQUENCE; Schema: graphile_worker; Owner: -
--

ALTER TABLE graphile_worker._private_job_queues ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME graphile_worker.job_queues_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: jobs; Type: VIEW; Schema: graphile_worker; Owner: -
--

CREATE VIEW graphile_worker.jobs AS
 SELECT jobs.id,
    job_queues.queue_name,
    tasks.identifier AS task_identifier,
    jobs.priority,
    jobs.run_at,
    jobs.attempts,
    jobs.max_attempts,
    jobs.last_error,
    jobs.created_at,
    jobs.updated_at,
    jobs.key,
    jobs.locked_at,
    jobs.locked_by,
    jobs.revision,
    jobs.flags
   FROM ((graphile_worker._private_jobs jobs
     JOIN graphile_worker._private_tasks tasks ON ((tasks.id = jobs.task_id)))
     LEFT JOIN graphile_worker._private_job_queues job_queues ON ((job_queues.id = jobs.job_queue_id)));


--
-- Name: jobs_id_seq1; Type: SEQUENCE; Schema: graphile_worker; Owner: -
--

ALTER TABLE graphile_worker._private_jobs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME graphile_worker.jobs_id_seq1
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: migrations; Type: TABLE; Schema: graphile_worker; Owner: -
--

CREATE TABLE graphile_worker.migrations (
    id integer NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    breaking boolean DEFAULT false NOT NULL
);


--
-- Name: tasks_id_seq; Type: SEQUENCE; Schema: graphile_worker; Owner: -
--

ALTER TABLE graphile_worker._private_tasks ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME graphile_worker.tasks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: _migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public._migrations (
    id integer NOT NULL,
    filename text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: _migrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public._migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: _migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public._migrations_id_seq OWNED BY public._migrations.id;


--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

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
    publish_follow_graph boolean DEFAULT true NOT NULL,
    follow_list_dirty boolean DEFAULT false NOT NULL,
    discovery_synced_at timestamp with time zone,
    CONSTRAINT accounts_annual_discount_pct_check CHECK (((annual_discount_pct >= 0) AND (annual_discount_pct <= 30))),
    CONSTRAINT accounts_hosting_type_check CHECK ((hosting_type = ANY (ARRAY['hosted'::text, 'self_hosted'::text])))
);


--
-- Name: activitypub_instance_health; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: article_drafts; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: article_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.article_tags (
    article_id uuid NOT NULL,
    tag_id uuid NOT NULL
);


--
-- Name: article_unlocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.article_unlocks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reader_id uuid NOT NULL,
    article_id uuid NOT NULL,
    unlocked_via text NOT NULL,
    subscription_id uuid,
    unlocked_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT article_unlocks_unlocked_via_check CHECK ((unlocked_via = ANY (ARRAY['purchase'::text, 'subscription'::text, 'own_content'::text, 'free_allowance'::text, 'author_grant'::text, 'pledge'::text, 'invitation'::text])))
);


--
-- Name: articles; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: atproto_oauth_pending_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.atproto_oauth_pending_states (
    key text NOT NULL,
    state_data_enc text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: atproto_oauth_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.atproto_oauth_sessions (
    did text NOT NULL,
    session_data_enc text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: blocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blocks (
    blocker_id uuid NOT NULL,
    blocked_id uuid NOT NULL,
    blocked_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: bookmarks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bookmarks (
    user_id uuid NOT NULL,
    article_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: comments; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: content_key_issuances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content_key_issuances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vault_key_id uuid NOT NULL,
    reader_id uuid NOT NULL,
    article_id uuid NOT NULL,
    read_event_id uuid,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    is_reissuance boolean DEFAULT false NOT NULL
);


--
-- Name: conversation_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_members (
    conversation_id uuid NOT NULL,
    user_id uuid NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_by uuid NOT NULL,
    last_message_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: direct_messages; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: dm_likes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dm_likes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dm_pricing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dm_pricing (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid NOT NULL,
    target_id uuid,
    price_pence integer NOT NULL
);


--
-- Name: external_authors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.external_authors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    protocol public.external_protocol NOT NULL,
    stable_handle text NOT NULL,
    tier text NOT NULL,
    account_id uuid,
    display_name text,
    handle text,
    handle_uri text,
    avatar text,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT external_authors_tier_check CHECK ((tier = ANY (ARRAY['A'::text, 'B'::text])))
);


--
-- Name: external_items; Type: TABLE; Schema: public; Owner: -
--

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
    like_count integer DEFAULT 0 NOT NULL,
    reply_count integer DEFAULT 0 NOT NULL,
    repost_count integer DEFAULT 0 NOT NULL,
    is_context_only boolean DEFAULT false NOT NULL,
    content_warning text,
    canonical_url text,
    CONSTRAINT protocol_tier_consistency CHECK ((((protocol = 'nostr_external'::public.external_protocol) AND (tier = 'tier2'::public.content_tier)) OR ((protocol = ANY (ARRAY['atproto'::public.external_protocol, 'activitypub'::public.external_protocol, 'farcaster'::public.external_protocol])) AND (tier = 'tier3'::public.content_tier)) OR ((protocol = ANY (ARRAY['rss'::public.external_protocol, 'telegram'::public.external_protocol, 'matrix'::public.external_protocol, 'email'::public.external_protocol])) AND (tier = 'tier4'::public.content_tier))))
);


--
-- Name: external_sources; Type: TABLE; Schema: public; Owner: -
--

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
    metadata_updated_at timestamp with time zone,
    ingest_address text
);


--
-- Name: external_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.external_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    subscriber_id uuid NOT NULL,
    source_id uuid NOT NULL,
    is_muted boolean DEFAULT false NOT NULL,
    daily_cap integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: feed_engagement; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feed_engagement (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor_id uuid,
    target_nostr_event_id text NOT NULL,
    target_author_id uuid,
    engagement_type text NOT NULL,
    engaged_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: feed_items; Type: TABLE; Schema: public; Owner: -
--

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
    is_reply boolean DEFAULT false NOT NULL,
    post_id text,
    version text,
    biddability_tier text,
    external_author_id uuid,
    reply_to_author text,
    CONSTRAINT exactly_one_source CHECK ((((((article_id IS NOT NULL))::integer + ((note_id IS NOT NULL))::integer) + ((external_item_id IS NOT NULL))::integer) = 1)),
    CONSTRAINT feed_items_biddability_tier_check CHECK ((biddability_tier = ANY (ARRAY['A'::text, 'B'::text, 'C'::text, 'D'::text]))),
    CONSTRAINT feed_items_item_type_check CHECK ((item_type = ANY (ARRAY['article'::text, 'note'::text, 'external'::text]))),
    CONSTRAINT tier_consistency CHECK ((((item_type = ANY (ARRAY['article'::text, 'note'::text])) AND (tier = 'tier1'::public.content_tier)) OR (item_type = 'external'::text)))
);


--
-- Name: feed_saves; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feed_saves (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_id uuid NOT NULL,
    feed_item_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: feed_scores; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: feed_sources; Type: TABLE; Schema: public; Owner: -
--

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
    exclude_replies boolean DEFAULT false NOT NULL,
    CONSTRAINT feed_sources_sampling_mode_check CHECK ((sampling_mode = ANY (ARRAY['chronological'::text, 'scored'::text, 'random'::text]))),
    CONSTRAINT feed_sources_source_type_check CHECK ((source_type = ANY (ARRAY['account'::text, 'publication'::text, 'external_source'::text, 'tag'::text]))),
    CONSTRAINT feed_sources_tag_name_length CHECK (((tag_name IS NULL) OR ((char_length(tag_name) >= 1) AND (char_length(tag_name) <= 64)))),
    CONSTRAINT feed_sources_target_matches_type CHECK ((((source_type = 'account'::text) AND (account_id IS NOT NULL) AND (publication_id IS NULL) AND (external_source_id IS NULL) AND (tag_name IS NULL)) OR ((source_type = 'publication'::text) AND (publication_id IS NOT NULL) AND (account_id IS NULL) AND (external_source_id IS NULL) AND (tag_name IS NULL)) OR ((source_type = 'external_source'::text) AND (external_source_id IS NOT NULL) AND (account_id IS NULL) AND (publication_id IS NULL) AND (tag_name IS NULL)) OR ((source_type = 'tag'::text) AND (tag_name IS NOT NULL) AND (account_id IS NULL) AND (publication_id IS NULL) AND (external_source_id IS NULL))))
);


--
-- Name: feeds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feeds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT feeds_name_length CHECK (((char_length(name) >= 1) AND (char_length(name) <= 80)))
);


--
-- Name: follows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.follows (
    follower_id uuid NOT NULL,
    followee_id uuid NOT NULL,
    followed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: gift_links; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: linked_accounts; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: magic_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.magic_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: media_uploads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_uploads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    uploader_id uuid NOT NULL,
    blossom_url text NOT NULL,
    sha256 text NOT NULL,
    mime_type text NOT NULL,
    size_bytes integer NOT NULL,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: moderation_reports; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: mutes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mutes (
    muter_id uuid NOT NULL,
    muted_id uuid NOT NULL,
    muted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: notes; Type: TABLE; Schema: public; Owner: -
--

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
    quoted_author text,
    external_parent_id uuid,
    quoted_post_id text,
    quoted_url text,
    quoted_source text
);


--
-- Name: notification_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_preferences (
    user_id uuid NOT NULL,
    category text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: oauth_app_registrations; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: outbound_posts; Type: TABLE; Schema: public; Owner: -
--

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
    CONSTRAINT outbound_posts_action_type_check CHECK ((action_type = ANY (ARRAY['reply'::text, 'quote'::text, 'repost'::text, 'original'::text, 'like'::text, 'poll_vote'::text]))),
    CONSTRAINT outbound_posts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text, 'retrying'::text])))
);


--
-- Name: platform_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_config (
    key text NOT NULL,
    value text NOT NULL,
    description text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pledge_drives; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: pledges; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: publication_article_shares; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: publication_follows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.publication_follows (
    follower_id uuid NOT NULL,
    publication_id uuid NOT NULL,
    followed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: publication_invites; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: publication_members; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: publication_payout_splits; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: publication_payouts; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: publications; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: read_events; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: reading_positions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reading_positions (
    user_id uuid NOT NULL,
    article_id uuid NOT NULL,
    scroll_ratio real NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reading_positions_scroll_ratio_check CHECK (((scroll_ratio >= (0)::double precision) AND (scroll_ratio <= (1)::double precision)))
);


--
-- Name: reading_tabs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reading_tabs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reader_id uuid NOT NULL,
    balance_pence integer DEFAULT 0 NOT NULL,
    last_read_at timestamp with time zone,
    last_settled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reading_tabs_balance_non_negative CHECK ((balance_pence >= 0))
);


--
-- Name: relay_outbox; Type: TABLE; Schema: public; Owner: -
--

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
    CONSTRAINT relay_outbox_entity_type_check CHECK ((entity_type = ANY (ARRAY['article'::text, 'article_deletion'::text, 'note'::text, 'note_deletion'::text, 'subscription'::text, 'receipt'::text, 'drive'::text, 'drive_deletion'::text, 'signing_passthrough'::text, 'conversation_pulse'::text, 'account_deletion'::text, 'profile'::text, 'follow_list'::text, 'relay_list'::text]))),
    CONSTRAINT relay_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text, 'abandoned'::text])))
);


--
-- Name: repost_edges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.repost_edges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    protocol public.external_protocol NOT NULL,
    target_post_id text NOT NULL,
    actor_handle text NOT NULL,
    actor_external_author_id uuid,
    trust_weight numeric DEFAULT 1 NOT NULL,
    boosted_at timestamp with time zone NOT NULL,
    origin_uri text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: resolver_async_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resolver_async_results (
    request_id uuid NOT NULL,
    initiator_id uuid NOT NULL,
    result jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stripe_webhook_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stripe_webhook_events (
    event_id text NOT NULL,
    event_type text NOT NULL,
    processed_at timestamp with time zone,
    received_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: subscription_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    subscription_id uuid NOT NULL,
    event_type text NOT NULL,
    reader_id uuid NOT NULL,
    writer_id uuid,
    article_id uuid,
    amount_pence integer DEFAULT 0 NOT NULL,
    period_start timestamp with time zone,
    period_end timestamp with time zone,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    publication_id uuid,
    CONSTRAINT subscription_events_event_type_check CHECK ((event_type = ANY (ARRAY['subscription_charge'::text, 'subscription_earning'::text, 'subscription_read'::text, 'expiry_warning_sent'::text]))),
    CONSTRAINT subscription_events_target_check CHECK (((writer_id IS NOT NULL) OR (publication_id IS NOT NULL)))
);


--
-- Name: subscription_nudge_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_nudge_log (
    reader_id uuid NOT NULL,
    writer_id uuid NOT NULL,
    month date NOT NULL,
    shown_at timestamp with time zone DEFAULT now() NOT NULL,
    converted boolean DEFAULT false NOT NULL,
    publication_id uuid
);


--
-- Name: subscription_offers; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: tab_settlements; Type: TABLE; Schema: public; Owner: -
--

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
    settled_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    CONSTRAINT tab_settlements_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT tab_settlements_trigger_type_check CHECK ((trigger_type = ANY (ARRAY['threshold'::text, 'monthly_fallback'::text])))
);


--
-- Name: tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: trust_epochs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trust_epochs (
    epoch_id text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    type text NOT NULL,
    CONSTRAINT trust_epochs_type_check CHECK ((type = ANY (ARRAY['full'::text, 'mopup'::text])))
);


--
-- Name: trust_layer1; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: trust_polls; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: trust_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trust_profiles (
    user_id uuid NOT NULL,
    dimension text NOT NULL,
    score numeric DEFAULT 0 NOT NULL,
    attestation_count integer DEFAULT 0 NOT NULL,
    epoch text DEFAULT 'pre-epoch'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT trust_profiles_dimension_check CHECK ((dimension = ANY (ARRAY['humanity'::text, 'encounter'::text, 'identity'::text, 'integrity'::text])))
);


--
-- Name: vault_keys; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: vote_charges; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: vote_tallies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vote_tallies (
    target_nostr_event_id text NOT NULL,
    upvote_count integer DEFAULT 0 NOT NULL,
    downvote_count integer DEFAULT 0 NOT NULL,
    net_score integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: votes; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: vouches; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: writer_payouts; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: half_day_buckets; Type: TABLE; Schema: traffology; Owner: -
--

CREATE TABLE traffology.half_day_buckets (
    piece_id uuid NOT NULL,
    source_id uuid NOT NULL,
    bucket_start timestamp with time zone NOT NULL,
    is_day boolean NOT NULL,
    reader_count integer DEFAULT 0 NOT NULL
);


--
-- Name: nostr_events; Type: TABLE; Schema: traffology; Owner: -
--

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


--
-- Name: observations; Type: TABLE; Schema: traffology; Owner: -
--

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


--
-- Name: piece_stats; Type: TABLE; Schema: traffology; Owner: -
--

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


--
-- Name: pieces; Type: TABLE; Schema: traffology; Owner: -
--

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


--
-- Name: public_mentions; Type: TABLE; Schema: traffology; Owner: -
--

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


--
-- Name: publication_baselines; Type: TABLE; Schema: traffology; Owner: -
--

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


--
-- Name: sessions; Type: TABLE; Schema: traffology; Owner: -
--

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


--
-- Name: source_stats; Type: TABLE; Schema: traffology; Owner: -
--

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


--
-- Name: sources; Type: TABLE; Schema: traffology; Owner: -
--

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


--
-- Name: topic_performance; Type: TABLE; Schema: traffology; Owner: -
--

CREATE TABLE traffology.topic_performance (
    writer_id uuid NOT NULL,
    topic text NOT NULL,
    piece_count integer DEFAULT 0 NOT NULL,
    mean_readers real DEFAULT 0.0 NOT NULL,
    mean_reading_time real DEFAULT 0.0 NOT NULL,
    mean_search_readers real DEFAULT 0.0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: writer_baselines; Type: TABLE; Schema: traffology; Owner: -
--

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


--
-- Name: _migrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._migrations ALTER COLUMN id SET DEFAULT nextval('public._migrations_id_seq'::regclass);


--
-- Name: _private_job_queues job_queues_pkey1; Type: CONSTRAINT; Schema: graphile_worker; Owner: -
--

ALTER TABLE ONLY graphile_worker._private_job_queues
    ADD CONSTRAINT job_queues_pkey1 PRIMARY KEY (id);


--
-- Name: _private_job_queues job_queues_queue_name_key; Type: CONSTRAINT; Schema: graphile_worker; Owner: -
--

ALTER TABLE ONLY graphile_worker._private_job_queues
    ADD CONSTRAINT job_queues_queue_name_key UNIQUE (queue_name);


--
-- Name: _private_jobs jobs_key_key1; Type: CONSTRAINT; Schema: graphile_worker; Owner: -
--

ALTER TABLE ONLY graphile_worker._private_jobs
    ADD CONSTRAINT jobs_key_key1 UNIQUE (key);


--
-- Name: _private_jobs jobs_pkey1; Type: CONSTRAINT; Schema: graphile_worker; Owner: -
--

ALTER TABLE ONLY graphile_worker._private_jobs
    ADD CONSTRAINT jobs_pkey1 PRIMARY KEY (id);


--
-- Name: _private_known_crontabs known_crontabs_pkey; Type: CONSTRAINT; Schema: graphile_worker; Owner: -
--

ALTER TABLE ONLY graphile_worker._private_known_crontabs
    ADD CONSTRAINT known_crontabs_pkey PRIMARY KEY (identifier);


--
-- Name: migrations migrations_pkey; Type: CONSTRAINT; Schema: graphile_worker; Owner: -
--

ALTER TABLE ONLY graphile_worker.migrations
    ADD CONSTRAINT migrations_pkey PRIMARY KEY (id);


--
-- Name: _private_tasks tasks_identifier_key; Type: CONSTRAINT; Schema: graphile_worker; Owner: -
--

ALTER TABLE ONLY graphile_worker._private_tasks
    ADD CONSTRAINT tasks_identifier_key UNIQUE (identifier);


--
-- Name: _private_tasks tasks_pkey; Type: CONSTRAINT; Schema: graphile_worker; Owner: -
--

ALTER TABLE ONLY graphile_worker._private_tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: _migrations _migrations_filename_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._migrations
    ADD CONSTRAINT _migrations_filename_key UNIQUE (filename);


--
-- Name: _migrations _migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._migrations
    ADD CONSTRAINT _migrations_pkey PRIMARY KEY (id);


--
-- Name: accounts accounts_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_email_key UNIQUE (email);


--
-- Name: accounts accounts_nostr_pubkey_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_nostr_pubkey_key UNIQUE (nostr_pubkey);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: accounts accounts_stripe_connect_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_stripe_connect_id_key UNIQUE (stripe_connect_id);


--
-- Name: accounts accounts_stripe_customer_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_stripe_customer_id_key UNIQUE (stripe_customer_id);


--
-- Name: accounts accounts_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_username_key UNIQUE (username);


--
-- Name: activitypub_instance_health activitypub_instance_health_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activitypub_instance_health
    ADD CONSTRAINT activitypub_instance_health_pkey PRIMARY KEY (host);


--
-- Name: article_drafts article_drafts_nostr_draft_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_drafts
    ADD CONSTRAINT article_drafts_nostr_draft_event_id_key UNIQUE (nostr_draft_event_id);


--
-- Name: article_drafts article_drafts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_drafts
    ADD CONSTRAINT article_drafts_pkey PRIMARY KEY (id);


--
-- Name: article_tags article_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_tags
    ADD CONSTRAINT article_tags_pkey PRIMARY KEY (article_id, tag_id);


--
-- Name: article_unlocks article_unlocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_unlocks
    ADD CONSTRAINT article_unlocks_pkey PRIMARY KEY (id);


--
-- Name: article_unlocks article_unlocks_reader_id_article_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_unlocks
    ADD CONSTRAINT article_unlocks_reader_id_article_id_key UNIQUE (reader_id, article_id);


--
-- Name: articles articles_nostr_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.articles
    ADD CONSTRAINT articles_nostr_event_id_key UNIQUE (nostr_event_id);


--
-- Name: articles articles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.articles
    ADD CONSTRAINT articles_pkey PRIMARY KEY (id);


--
-- Name: articles articles_vault_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.articles
    ADD CONSTRAINT articles_vault_event_id_key UNIQUE (vault_event_id);


--
-- Name: atproto_oauth_pending_states atproto_oauth_pending_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.atproto_oauth_pending_states
    ADD CONSTRAINT atproto_oauth_pending_states_pkey PRIMARY KEY (key);


--
-- Name: atproto_oauth_sessions atproto_oauth_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.atproto_oauth_sessions
    ADD CONSTRAINT atproto_oauth_sessions_pkey PRIMARY KEY (did);


--
-- Name: blocks blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocks
    ADD CONSTRAINT blocks_pkey PRIMARY KEY (blocker_id, blocked_id);


--
-- Name: bookmarks bookmarks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookmarks
    ADD CONSTRAINT bookmarks_pkey PRIMARY KEY (user_id, article_id);


--
-- Name: comments comments_nostr_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_nostr_event_id_key UNIQUE (nostr_event_id);


--
-- Name: comments comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_pkey PRIMARY KEY (id);


--
-- Name: content_key_issuances content_key_issuances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_key_issuances
    ADD CONSTRAINT content_key_issuances_pkey PRIMARY KEY (id);


--
-- Name: conversation_members conversation_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_members
    ADD CONSTRAINT conversation_members_pkey PRIMARY KEY (conversation_id, user_id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: direct_messages direct_messages_nostr_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_messages
    ADD CONSTRAINT direct_messages_nostr_event_id_key UNIQUE (nostr_event_id);


--
-- Name: direct_messages direct_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_messages
    ADD CONSTRAINT direct_messages_pkey PRIMARY KEY (id);


--
-- Name: dm_likes dm_likes_message_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_likes
    ADD CONSTRAINT dm_likes_message_id_user_id_key UNIQUE (message_id, user_id);


--
-- Name: dm_likes dm_likes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_likes
    ADD CONSTRAINT dm_likes_pkey PRIMARY KEY (id);


--
-- Name: dm_pricing dm_pricing_owner_id_target_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_pricing
    ADD CONSTRAINT dm_pricing_owner_id_target_id_key UNIQUE (owner_id, target_id);


--
-- Name: dm_pricing dm_pricing_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_pricing
    ADD CONSTRAINT dm_pricing_pkey PRIMARY KEY (id);


--
-- Name: external_authors external_authors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_authors
    ADD CONSTRAINT external_authors_pkey PRIMARY KEY (id);


--
-- Name: external_authors external_authors_protocol_stable_handle_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_authors
    ADD CONSTRAINT external_authors_protocol_stable_handle_key UNIQUE (protocol, stable_handle);


--
-- Name: external_items external_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_items
    ADD CONSTRAINT external_items_pkey PRIMARY KEY (id);


--
-- Name: external_sources external_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_sources
    ADD CONSTRAINT external_sources_pkey PRIMARY KEY (id);


--
-- Name: external_subscriptions external_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_subscriptions
    ADD CONSTRAINT external_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: feed_engagement feed_engagement_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed_engagement
    ADD CONSTRAINT feed_engagement_pkey PRIMARY KEY (id);


--
-- Name: feed_items feed_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed_items
    ADD CONSTRAINT feed_items_pkey PRIMARY KEY (id);


--
-- Name: feed_saves feed_saves_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed_saves
    ADD CONSTRAINT feed_saves_pkey PRIMARY KEY (id);


--
-- Name: feed_saves feed_saves_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed_saves
    ADD CONSTRAINT feed_saves_unique UNIQUE (feed_id, feed_item_id);


--
-- Name: feed_scores feed_scores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed_scores
    ADD CONSTRAINT feed_scores_pkey PRIMARY KEY (nostr_event_id);


--
-- Name: feed_sources feed_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed_sources
    ADD CONSTRAINT feed_sources_pkey PRIMARY KEY (id);


--
-- Name: feeds feeds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feeds
    ADD CONSTRAINT feeds_pkey PRIMARY KEY (id);


--
-- Name: follows follows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.follows
    ADD CONSTRAINT follows_pkey PRIMARY KEY (follower_id, followee_id);


--
-- Name: gift_links gift_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gift_links
    ADD CONSTRAINT gift_links_pkey PRIMARY KEY (id);


--
-- Name: gift_links gift_links_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gift_links
    ADD CONSTRAINT gift_links_token_key UNIQUE (token);


--
-- Name: linked_accounts linked_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.linked_accounts
    ADD CONSTRAINT linked_accounts_pkey PRIMARY KEY (id);


--
-- Name: magic_links magic_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.magic_links
    ADD CONSTRAINT magic_links_pkey PRIMARY KEY (id);


--
-- Name: magic_links magic_links_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.magic_links
    ADD CONSTRAINT magic_links_token_hash_key UNIQUE (token_hash);


--
-- Name: media_uploads media_uploads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_uploads
    ADD CONSTRAINT media_uploads_pkey PRIMARY KEY (id);


--
-- Name: moderation_reports moderation_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moderation_reports
    ADD CONSTRAINT moderation_reports_pkey PRIMARY KEY (id);


--
-- Name: mutes mutes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mutes
    ADD CONSTRAINT mutes_pkey PRIMARY KEY (muter_id, muted_id);


--
-- Name: notes notes_nostr_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_nostr_event_id_key UNIQUE (nostr_event_id);


--
-- Name: notes notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_pkey PRIMARY KEY (id);


--
-- Name: notification_preferences notification_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_pkey PRIMARY KEY (user_id, category);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: oauth_app_registrations oauth_app_registrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_app_registrations
    ADD CONSTRAINT oauth_app_registrations_pkey PRIMARY KEY (id);


--
-- Name: reading_tabs one_tab_per_reader; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reading_tabs
    ADD CONSTRAINT one_tab_per_reader UNIQUE (reader_id);


--
-- Name: outbound_posts outbound_posts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_posts
    ADD CONSTRAINT outbound_posts_pkey PRIMARY KEY (id);


--
-- Name: platform_config platform_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_config
    ADD CONSTRAINT platform_config_pkey PRIMARY KEY (key);


--
-- Name: pledge_drives pledge_drives_nostr_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pledge_drives
    ADD CONSTRAINT pledge_drives_nostr_event_id_key UNIQUE (nostr_event_id);


--
-- Name: pledge_drives pledge_drives_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pledge_drives
    ADD CONSTRAINT pledge_drives_pkey PRIMARY KEY (id);


--
-- Name: pledges pledges_drive_id_pledger_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pledges
    ADD CONSTRAINT pledges_drive_id_pledger_id_key UNIQUE (drive_id, pledger_id);


--
-- Name: pledges pledges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pledges
    ADD CONSTRAINT pledges_pkey PRIMARY KEY (id);


--
-- Name: publication_article_shares publication_article_shares_article_id_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_article_shares
    ADD CONSTRAINT publication_article_shares_article_id_account_id_key UNIQUE (article_id, account_id);


--
-- Name: publication_article_shares publication_article_shares_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_article_shares
    ADD CONSTRAINT publication_article_shares_pkey PRIMARY KEY (id);


--
-- Name: publication_follows publication_follows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_follows
    ADD CONSTRAINT publication_follows_pkey PRIMARY KEY (follower_id, publication_id);


--
-- Name: publication_invites publication_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_invites
    ADD CONSTRAINT publication_invites_pkey PRIMARY KEY (id);


--
-- Name: publication_invites publication_invites_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_invites
    ADD CONSTRAINT publication_invites_token_key UNIQUE (token);


--
-- Name: publication_members publication_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_members
    ADD CONSTRAINT publication_members_pkey PRIMARY KEY (id);


--
-- Name: publication_payout_splits publication_payout_splits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_payout_splits
    ADD CONSTRAINT publication_payout_splits_pkey PRIMARY KEY (id);


--
-- Name: publication_payouts publication_payouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_payouts
    ADD CONSTRAINT publication_payouts_pkey PRIMARY KEY (id);


--
-- Name: publications publications_custom_domain_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publications
    ADD CONSTRAINT publications_custom_domain_key UNIQUE (custom_domain);


--
-- Name: publications publications_nostr_pubkey_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publications
    ADD CONSTRAINT publications_nostr_pubkey_key UNIQUE (nostr_pubkey);


--
-- Name: publications publications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publications
    ADD CONSTRAINT publications_pkey PRIMARY KEY (id);


--
-- Name: publications publications_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publications
    ADD CONSTRAINT publications_slug_key UNIQUE (slug);


--
-- Name: publications publications_stripe_connect_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publications
    ADD CONSTRAINT publications_stripe_connect_id_key UNIQUE (stripe_connect_id);


--
-- Name: read_events read_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.read_events
    ADD CONSTRAINT read_events_pkey PRIMARY KEY (id);


--
-- Name: read_events read_events_receipt_nostr_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.read_events
    ADD CONSTRAINT read_events_receipt_nostr_event_id_key UNIQUE (receipt_nostr_event_id);


--
-- Name: reading_positions reading_positions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reading_positions
    ADD CONSTRAINT reading_positions_pkey PRIMARY KEY (user_id, article_id);


--
-- Name: reading_tabs reading_tabs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reading_tabs
    ADD CONSTRAINT reading_tabs_pkey PRIMARY KEY (id);


--
-- Name: relay_outbox relay_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relay_outbox
    ADD CONSTRAINT relay_outbox_pkey PRIMARY KEY (id);


--
-- Name: repost_edges repost_edges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repost_edges
    ADD CONSTRAINT repost_edges_pkey PRIMARY KEY (id);


--
-- Name: resolver_async_results resolver_async_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resolver_async_results
    ADD CONSTRAINT resolver_async_results_pkey PRIMARY KEY (request_id);


--
-- Name: stripe_webhook_events stripe_webhook_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stripe_webhook_events
    ADD CONSTRAINT stripe_webhook_events_pkey PRIMARY KEY (event_id);


--
-- Name: subscription_events subscription_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_events
    ADD CONSTRAINT subscription_events_pkey PRIMARY KEY (id);


--
-- Name: subscription_nudge_log subscription_nudge_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_nudge_log
    ADD CONSTRAINT subscription_nudge_log_pkey PRIMARY KEY (reader_id, writer_id, month);


--
-- Name: subscription_offers subscription_offers_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_offers
    ADD CONSTRAINT subscription_offers_code_key UNIQUE (code);


--
-- Name: subscription_offers subscription_offers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_offers
    ADD CONSTRAINT subscription_offers_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- Name: tab_settlements tab_settlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tab_settlements
    ADD CONSTRAINT tab_settlements_pkey PRIMARY KEY (id);


--
-- Name: tab_settlements tab_settlements_stripe_charge_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tab_settlements
    ADD CONSTRAINT tab_settlements_stripe_charge_id_key UNIQUE (stripe_charge_id);


--
-- Name: tab_settlements tab_settlements_stripe_payment_intent_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tab_settlements
    ADD CONSTRAINT tab_settlements_stripe_payment_intent_id_key UNIQUE (stripe_payment_intent_id);


--
-- Name: tags tags_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_name_key UNIQUE (name);


--
-- Name: tags tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);


--
-- Name: trust_epochs trust_epochs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trust_epochs
    ADD CONSTRAINT trust_epochs_pkey PRIMARY KEY (epoch_id);


--
-- Name: trust_layer1 trust_layer1_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trust_layer1
    ADD CONSTRAINT trust_layer1_pkey PRIMARY KEY (user_id);


--
-- Name: trust_polls trust_polls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trust_polls
    ADD CONSTRAINT trust_polls_pkey PRIMARY KEY (id);


--
-- Name: trust_polls trust_polls_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trust_polls
    ADD CONSTRAINT trust_polls_unique UNIQUE (respondent_id, subject_id, question);


--
-- Name: trust_profiles trust_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trust_profiles
    ADD CONSTRAINT trust_profiles_pkey PRIMARY KEY (user_id, dimension);


--
-- Name: publication_members unique_active_member; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_members
    ADD CONSTRAINT unique_active_member UNIQUE (publication_id, account_id);


--
-- Name: oauth_app_registrations unique_app_registration; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_app_registrations
    ADD CONSTRAINT unique_app_registration UNIQUE (protocol, instance_url);


--
-- Name: linked_accounts unique_linked_identity; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.linked_accounts
    ADD CONSTRAINT unique_linked_identity UNIQUE (account_id, protocol, external_id);


--
-- Name: external_sources unique_source; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_sources
    ADD CONSTRAINT unique_source UNIQUE (protocol, source_uri);


--
-- Name: external_items unique_source_item; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_items
    ADD CONSTRAINT unique_source_item UNIQUE (protocol, source_item_uri);


--
-- Name: external_subscriptions unique_subscription; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_subscriptions
    ADD CONSTRAINT unique_subscription UNIQUE (subscriber_id, source_id);


--
-- Name: vault_keys vault_keys_nostr_article_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_keys
    ADD CONSTRAINT vault_keys_nostr_article_event_id_key UNIQUE (nostr_article_event_id);


--
-- Name: vault_keys vault_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_keys
    ADD CONSTRAINT vault_keys_pkey PRIMARY KEY (id);


--
-- Name: vote_charges vote_charges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vote_charges
    ADD CONSTRAINT vote_charges_pkey PRIMARY KEY (id);


--
-- Name: vote_tallies vote_tallies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vote_tallies
    ADD CONSTRAINT vote_tallies_pkey PRIMARY KEY (target_nostr_event_id);


--
-- Name: votes votes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.votes
    ADD CONSTRAINT votes_pkey PRIMARY KEY (id);


--
-- Name: vouches vouches_attestor_id_subject_id_dimension_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vouches
    ADD CONSTRAINT vouches_attestor_id_subject_id_dimension_key UNIQUE (attestor_id, subject_id, dimension);


--
-- Name: vouches vouches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vouches
    ADD CONSTRAINT vouches_pkey PRIMARY KEY (id);


--
-- Name: writer_payouts writer_payouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.writer_payouts
    ADD CONSTRAINT writer_payouts_pkey PRIMARY KEY (id);


--
-- Name: writer_payouts writer_payouts_stripe_transfer_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.writer_payouts
    ADD CONSTRAINT writer_payouts_stripe_transfer_id_key UNIQUE (stripe_transfer_id);


--
-- Name: half_day_buckets half_day_buckets_pkey; Type: CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.half_day_buckets
    ADD CONSTRAINT half_day_buckets_pkey PRIMARY KEY (piece_id, source_id, bucket_start);


--
-- Name: nostr_events nostr_events_event_id_key; Type: CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.nostr_events
    ADD CONSTRAINT nostr_events_event_id_key UNIQUE (event_id);


--
-- Name: nostr_events nostr_events_pkey; Type: CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.nostr_events
    ADD CONSTRAINT nostr_events_pkey PRIMARY KEY (id);


--
-- Name: observations observations_pkey; Type: CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.observations
    ADD CONSTRAINT observations_pkey PRIMARY KEY (id);


--
-- Name: piece_stats piece_stats_pkey; Type: CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.piece_stats
    ADD CONSTRAINT piece_stats_pkey PRIMARY KEY (piece_id);


--
-- Name: pieces pieces_article_id_key; Type: CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.pieces
    ADD CONSTRAINT pieces_article_id_key UNIQUE (article_id);


--
-- Name: pieces pieces_pkey; Type: CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.pieces
    ADD CONSTRAINT pieces_pkey PRIMARY KEY (id);


--
-- Name: public_mentions public_mentions_pkey; Type: CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.public_mentions
    ADD CONSTRAINT public_mentions_pkey PRIMARY KEY (id);


--
-- Name: publication_baselines publication_baselines_pkey; Type: CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.publication_baselines
    ADD CONSTRAINT publication_baselines_pkey PRIMARY KEY (publication_id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: source_stats source_stats_pkey; Type: CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.source_stats
    ADD CONSTRAINT source_stats_pkey PRIMARY KEY (piece_id, source_id);


--
-- Name: sources sources_pkey; Type: CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.sources
    ADD CONSTRAINT sources_pkey PRIMARY KEY (id);


--
-- Name: topic_performance topic_performance_pkey; Type: CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.topic_performance
    ADD CONSTRAINT topic_performance_pkey PRIMARY KEY (writer_id, topic);


--
-- Name: writer_baselines writer_baselines_pkey; Type: CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.writer_baselines
    ADD CONSTRAINT writer_baselines_pkey PRIMARY KEY (writer_id);


--
-- Name: jobs_main_index; Type: INDEX; Schema: graphile_worker; Owner: -
--

CREATE INDEX jobs_main_index ON graphile_worker._private_jobs USING btree (priority, run_at) INCLUDE (id, task_id, job_queue_id) WHERE (is_available = true);


--
-- Name: jobs_no_queue_index; Type: INDEX; Schema: graphile_worker; Owner: -
--

CREATE INDEX jobs_no_queue_index ON graphile_worker._private_jobs USING btree (priority, run_at) INCLUDE (id, task_id) WHERE ((is_available = true) AND (job_queue_id IS NULL));


--
-- Name: accounts_discovery_sweep_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX accounts_discovery_sweep_idx ON public.accounts USING btree (discovery_synced_at NULLS FIRST) WHERE (status = 'active'::public.account_status);


--
-- Name: accounts_follow_list_dirty_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX accounts_follow_list_dirty_idx ON public.accounts USING btree (id) WHERE follow_list_dirty;


--
-- Name: atproto_oauth_pending_states_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX atproto_oauth_pending_states_expires_at_idx ON public.atproto_oauth_pending_states USING btree (expires_at);


--
-- Name: feed_saves_feed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feed_saves_feed_idx ON public.feed_saves USING btree (feed_id, created_at DESC, id DESC);


--
-- Name: feed_sources_account_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX feed_sources_account_uniq ON public.feed_sources USING btree (feed_id, account_id) WHERE (source_type = 'account'::text);


--
-- Name: feed_sources_external_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX feed_sources_external_uniq ON public.feed_sources USING btree (feed_id, external_source_id) WHERE (source_type = 'external_source'::text);


--
-- Name: feed_sources_feed_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feed_sources_feed_active_idx ON public.feed_sources USING btree (feed_id, sampling_mode) WHERE (muted_at IS NULL);


--
-- Name: feed_sources_feed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feed_sources_feed_idx ON public.feed_sources USING btree (feed_id);


--
-- Name: feed_sources_publication_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX feed_sources_publication_uniq ON public.feed_sources USING btree (feed_id, publication_id) WHERE (source_type = 'publication'::text);


--
-- Name: feed_sources_tag_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX feed_sources_tag_uniq ON public.feed_sources USING btree (feed_id, tag_name) WHERE (source_type = 'tag'::text);


--
-- Name: feeds_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feeds_owner_idx ON public.feeds USING btree (owner_id, created_at DESC);


--
-- Name: idx_accounts_display_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_display_name_trgm ON public.accounts USING gin (display_name public.gin_trgm_ops) WHERE (display_name IS NOT NULL);


--
-- Name: idx_accounts_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_email ON public.accounts USING btree (email) WHERE (email IS NOT NULL);


--
-- Name: idx_accounts_is_writer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_is_writer ON public.accounts USING btree (is_writer) WHERE (is_writer = true);


--
-- Name: idx_accounts_nostr_pubkey; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_nostr_pubkey ON public.accounts USING btree (nostr_pubkey);


--
-- Name: idx_accounts_username; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_username ON public.accounts USING btree (username);


--
-- Name: idx_accounts_username_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_username_trgm ON public.accounts USING gin (username public.gin_trgm_ops);


--
-- Name: idx_ap_instance_health_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_instance_health_updated ON public.activitypub_instance_health USING btree (updated_at DESC);


--
-- Name: idx_article_tags_tag; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_article_tags_tag ON public.article_tags USING btree (tag_id);


--
-- Name: idx_article_unlocks_article; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_article_unlocks_article ON public.article_unlocks USING btree (article_id);


--
-- Name: idx_article_unlocks_reader; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_article_unlocks_reader ON public.article_unlocks USING btree (reader_id);


--
-- Name: idx_articles_content_free_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_articles_content_free_trgm ON public.articles USING gin (content_free public.gin_trgm_ops);


--
-- Name: idx_articles_nostr_d_tag; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_articles_nostr_d_tag ON public.articles USING btree (writer_id, nostr_d_tag);


--
-- Name: idx_articles_publication; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_articles_publication ON public.articles USING btree (publication_id) WHERE (publication_id IS NOT NULL);


--
-- Name: idx_articles_published_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_articles_published_at ON public.articles USING btree (published_at DESC) WHERE (published_at IS NOT NULL);


--
-- Name: idx_articles_title_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_articles_title_trgm ON public.articles USING gin (title public.gin_trgm_ops);


--
-- Name: idx_articles_unique_live; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_articles_unique_live ON public.articles USING btree (writer_id, nostr_d_tag) WHERE (deleted_at IS NULL);


--
-- Name: idx_articles_writer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_articles_writer_id ON public.articles USING btree (writer_id);


--
-- Name: idx_bookmarks_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookmarks_user ON public.bookmarks USING btree (user_id, created_at DESC);


--
-- Name: idx_comments_author; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_comments_author ON public.comments USING btree (author_id);


--
-- Name: idx_comments_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_comments_parent ON public.comments USING btree (parent_comment_id) WHERE (parent_comment_id IS NOT NULL);


--
-- Name: idx_comments_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_comments_target ON public.comments USING btree (target_event_id, published_at) WHERE (deleted_at IS NULL);


--
-- Name: idx_conv_members_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conv_members_user ON public.conversation_members USING btree (user_id);


--
-- Name: idx_dm_conversation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dm_conversation ON public.direct_messages USING btree (conversation_id, created_at DESC);


--
-- Name: idx_dm_likes_message; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dm_likes_message ON public.dm_likes USING btree (message_id);


--
-- Name: idx_dm_pricing_default; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_dm_pricing_default ON public.dm_pricing USING btree (owner_id) WHERE (target_id IS NULL);


--
-- Name: idx_dm_recipient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dm_recipient ON public.direct_messages USING btree (recipient_id);


--
-- Name: idx_dm_reply_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dm_reply_to ON public.direct_messages USING btree (reply_to_id) WHERE (reply_to_id IS NOT NULL);


--
-- Name: idx_dm_send_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dm_send_id ON public.direct_messages USING btree (send_id);


--
-- Name: idx_dm_sender; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dm_sender ON public.direct_messages USING btree (sender_id);


--
-- Name: idx_drafts_scheduled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_drafts_scheduled ON public.article_drafts USING btree (scheduled_at) WHERE (scheduled_at IS NOT NULL);


--
-- Name: idx_drafts_writer_dtag; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_drafts_writer_dtag ON public.article_drafts USING btree (writer_id, nostr_d_tag) WHERE (nostr_d_tag IS NOT NULL);


--
-- Name: idx_drafts_writer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_drafts_writer_id ON public.article_drafts USING btree (writer_id);


--
-- Name: idx_drives_creator; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_drives_creator ON public.pledge_drives USING btree (creator_id);


--
-- Name: idx_drives_nostr; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_drives_nostr ON public.pledge_drives USING btree (nostr_event_id);


--
-- Name: idx_drives_parent_conv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_drives_parent_conv ON public.pledge_drives USING btree (parent_conversation_id) WHERE (parent_conversation_id IS NOT NULL);


--
-- Name: idx_drives_parent_note; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_drives_parent_note ON public.pledge_drives USING btree (parent_note_event_id) WHERE (parent_note_event_id IS NOT NULL);


--
-- Name: idx_drives_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_drives_status ON public.pledge_drives USING btree (status);


--
-- Name: idx_drives_writer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_drives_writer ON public.pledge_drives USING btree (target_writer_id);


--
-- Name: idx_ext_items_author_uri; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ext_items_author_uri ON public.external_items USING btree (author_uri);


--
-- Name: idx_ext_items_canonical; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ext_items_canonical ON public.external_items USING btree (canonical_url) WHERE (canonical_url IS NOT NULL);


--
-- Name: idx_ext_items_published_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ext_items_published_at ON public.external_items USING btree (published_at DESC);


--
-- Name: idx_ext_items_source_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ext_items_source_id ON public.external_items USING btree (source_id);


--
-- Name: idx_ext_items_source_reply; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ext_items_source_reply ON public.external_items USING btree (source_reply_uri) WHERE (source_reply_uri IS NOT NULL);


--
-- Name: idx_ext_sources_ingest_addr; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_ext_sources_ingest_addr ON public.external_sources USING btree (ingest_address) WHERE (ingest_address IS NOT NULL);


--
-- Name: idx_ext_sources_next_fetch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ext_sources_next_fetch ON public.external_sources USING btree (last_fetched_at) WHERE (is_active = true);


--
-- Name: idx_ext_sources_orphaned; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ext_sources_orphaned ON public.external_sources USING btree (orphaned_at) WHERE (orphaned_at IS NOT NULL);


--
-- Name: idx_ext_sources_protocol; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ext_sources_protocol ON public.external_sources USING btree (protocol) WHERE (is_active = true);


--
-- Name: idx_ext_subs_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ext_subs_source ON public.external_subscriptions USING btree (source_id);


--
-- Name: idx_ext_subs_subscriber; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ext_subs_subscriber ON public.external_subscriptions USING btree (subscriber_id);


--
-- Name: idx_external_authors_account_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_external_authors_account_id ON public.external_authors USING btree (account_id);


--
-- Name: idx_feed_engagement_author; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feed_engagement_author ON public.feed_engagement USING btree (target_author_id, engaged_at DESC);


--
-- Name: idx_feed_engagement_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feed_engagement_target ON public.feed_engagement USING btree (target_nostr_event_id, engaged_at DESC);


--
-- Name: idx_feed_items_article; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_feed_items_article ON public.feed_items USING btree (article_id) WHERE (article_id IS NOT NULL);


--
-- Name: idx_feed_items_author; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feed_items_author ON public.feed_items USING btree (author_id, published_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_feed_items_cursor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feed_items_cursor ON public.feed_items USING btree (published_at DESC, id DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_feed_items_external; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_feed_items_external ON public.feed_items USING btree (external_item_id) WHERE (external_item_id IS NOT NULL);


--
-- Name: idx_feed_items_external_author_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feed_items_external_author_id ON public.feed_items USING btree (external_author_id);


--
-- Name: idx_feed_items_note; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_feed_items_note ON public.feed_items USING btree (note_id) WHERE (note_id IS NOT NULL);


--
-- Name: idx_feed_items_post_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feed_items_post_id ON public.feed_items USING btree (post_id);


--
-- Name: idx_feed_items_score; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feed_items_score ON public.feed_items USING btree (score DESC, published_at DESC, id DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_feed_items_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feed_items_source ON public.feed_items USING btree (source_id, published_at DESC) WHERE ((source_id IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: idx_feed_items_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feed_items_type ON public.feed_items USING btree (item_type, published_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_feed_scores_author; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feed_scores_author ON public.feed_scores USING btree (author_id, score DESC);


--
-- Name: idx_feed_scores_publication; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feed_scores_publication ON public.feed_scores USING btree (publication_id, score DESC) WHERE (publication_id IS NOT NULL);


--
-- Name: idx_feed_scores_published; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feed_scores_published ON public.feed_scores USING btree (published_at DESC);


--
-- Name: idx_feed_scores_score; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feed_scores_score ON public.feed_scores USING btree (score DESC);


--
-- Name: idx_follows_followee_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_follows_followee_id ON public.follows USING btree (followee_id);


--
-- Name: idx_gift_links_article; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gift_links_article ON public.gift_links USING btree (article_id);


--
-- Name: idx_gift_links_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gift_links_token ON public.gift_links USING btree (token);


--
-- Name: idx_key_issuances_reader_article; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_key_issuances_reader_article ON public.content_key_issuances USING btree (reader_id, article_id);


--
-- Name: idx_key_issuances_vault_key_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_key_issuances_vault_key_id ON public.content_key_issuances USING btree (vault_key_id);


--
-- Name: idx_linked_accounts_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_linked_accounts_account ON public.linked_accounts USING btree (account_id);


--
-- Name: idx_linked_accounts_refresh; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_linked_accounts_refresh ON public.linked_accounts USING btree (token_expires_at) WHERE ((is_valid = true) AND (credentials_enc IS NOT NULL));


--
-- Name: idx_magic_links_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_magic_links_expires ON public.magic_links USING btree (expires_at) WHERE (used_at IS NULL);


--
-- Name: idx_magic_links_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_magic_links_token_hash ON public.magic_links USING btree (token_hash) WHERE (used_at IS NULL);


--
-- Name: idx_media_uploads_sha256; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_uploads_sha256 ON public.media_uploads USING btree (sha256);


--
-- Name: idx_media_uploads_uploader; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_uploads_uploader ON public.media_uploads USING btree (uploader_id);


--
-- Name: idx_notes_author_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notes_author_id ON public.notes USING btree (author_id);


--
-- Name: idx_notes_published_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notes_published_at ON public.notes USING btree (published_at DESC);


--
-- Name: idx_notes_reply_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notes_reply_to ON public.notes USING btree (reply_to_event_id) WHERE (reply_to_event_id IS NOT NULL);


--
-- Name: idx_notifications_dedup; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_notifications_dedup ON public.notifications USING btree (recipient_id, actor_id, type, COALESCE(article_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(note_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(comment_id, '00000000-0000-0000-0000-000000000000'::uuid));


--
-- Name: idx_notifications_note; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_note ON public.notifications USING btree (note_id) WHERE (note_id IS NOT NULL);


--
-- Name: idx_notifications_recipient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_recipient ON public.notifications USING btree (recipient_id, created_at DESC);


--
-- Name: idx_outbound_posts_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbound_posts_account ON public.outbound_posts USING btree (account_id);


--
-- Name: idx_outbound_posts_linked; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbound_posts_linked ON public.outbound_posts USING btree (linked_account_id);


--
-- Name: idx_outbound_posts_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbound_posts_pending ON public.outbound_posts USING btree (status) WHERE (status = ANY (ARRAY['pending'::text, 'retrying'::text]));


--
-- Name: idx_pledges_drive; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pledges_drive ON public.pledges USING btree (drive_id);


--
-- Name: idx_pledges_pledger; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pledges_pledger ON public.pledges USING btree (pledger_id);


--
-- Name: idx_pledges_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pledges_status ON public.pledges USING btree (status);


--
-- Name: idx_pub_article_shares_article; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pub_article_shares_article ON public.publication_article_shares USING btree (article_id);


--
-- Name: idx_pub_article_shares_pub; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pub_article_shares_pub ON public.publication_article_shares USING btree (publication_id);


--
-- Name: idx_pub_follows_publication; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pub_follows_publication ON public.publication_follows USING btree (publication_id);


--
-- Name: idx_pub_invites_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pub_invites_email ON public.publication_invites USING btree (invited_email) WHERE ((accepted_at IS NULL) AND (declined_at IS NULL));


--
-- Name: idx_pub_invites_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pub_invites_token ON public.publication_invites USING btree (token) WHERE ((accepted_at IS NULL) AND (declined_at IS NULL));


--
-- Name: idx_pub_members_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pub_members_account ON public.publication_members USING btree (account_id) WHERE (removed_at IS NULL);


--
-- Name: idx_pub_members_one_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_pub_members_one_owner ON public.publication_members USING btree (publication_id) WHERE ((is_owner = true) AND (removed_at IS NULL));


--
-- Name: idx_pub_members_publication; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pub_members_publication ON public.publication_members USING btree (publication_id) WHERE (removed_at IS NULL);


--
-- Name: idx_pub_payout_splits_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pub_payout_splits_account ON public.publication_payout_splits USING btree (account_id);


--
-- Name: idx_pub_payout_splits_article; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pub_payout_splits_article ON public.publication_payout_splits USING btree (article_id) WHERE (article_id IS NOT NULL);


--
-- Name: idx_pub_payout_splits_payout; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pub_payout_splits_payout ON public.publication_payout_splits USING btree (publication_payout_id);


--
-- Name: idx_pub_payouts_publication; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pub_payouts_publication ON public.publication_payouts USING btree (publication_id);


--
-- Name: idx_pub_payouts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pub_payouts_status ON public.publication_payouts USING btree (status);


--
-- Name: idx_publications_custom_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_publications_custom_domain ON public.publications USING btree (custom_domain) WHERE (custom_domain IS NOT NULL);


--
-- Name: idx_publications_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_publications_name_trgm ON public.publications USING gin (name public.gin_trgm_ops);


--
-- Name: idx_publications_nostr_pubkey; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_publications_nostr_pubkey ON public.publications USING btree (nostr_pubkey);


--
-- Name: idx_publications_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_publications_slug ON public.publications USING btree (slug);


--
-- Name: idx_read_events_article_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_read_events_article_id ON public.read_events USING btree (article_id);


--
-- Name: idx_read_events_reader_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_read_events_reader_id ON public.read_events USING btree (reader_id);


--
-- Name: idx_read_events_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_read_events_state ON public.read_events USING btree (state);


--
-- Name: idx_read_events_tab_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_read_events_tab_id ON public.read_events USING btree (tab_id);


--
-- Name: idx_read_events_writer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_read_events_writer_id ON public.read_events USING btree (writer_id);


--
-- Name: idx_reading_positions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reading_positions_user ON public.reading_positions USING btree (user_id, updated_at DESC);


--
-- Name: idx_reading_tabs_reader_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reading_tabs_reader_id ON public.reading_tabs USING btree (reader_id);


--
-- Name: idx_reports_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reports_status ON public.moderation_reports USING btree (status, created_at DESC);


--
-- Name: idx_repost_edges_actor_author; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_repost_edges_actor_author ON public.repost_edges USING btree (actor_external_author_id);


--
-- Name: idx_repost_edges_origin; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_repost_edges_origin ON public.repost_edges USING btree (protocol, origin_uri) WHERE (origin_uri IS NOT NULL);


--
-- Name: idx_repost_edges_synthetic; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_repost_edges_synthetic ON public.repost_edges USING btree (protocol, target_post_id, actor_handle) WHERE (origin_uri IS NULL);


--
-- Name: idx_repost_edges_target_boosted; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_repost_edges_target_boosted ON public.repost_edges USING btree (target_post_id, boosted_at);


--
-- Name: idx_stripe_webhook_events_processed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stripe_webhook_events_processed ON public.stripe_webhook_events USING btree (processed_at);


--
-- Name: idx_sub_events_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sub_events_created ON public.subscription_events USING btree (created_at DESC);


--
-- Name: idx_sub_events_reader; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sub_events_reader ON public.subscription_events USING btree (reader_id);


--
-- Name: idx_sub_events_subscription; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sub_events_subscription ON public.subscription_events USING btree (subscription_id);


--
-- Name: idx_sub_events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sub_events_type ON public.subscription_events USING btree (event_type);


--
-- Name: idx_sub_events_writer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sub_events_writer ON public.subscription_events USING btree (writer_id);


--
-- Name: idx_sub_offers_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sub_offers_code ON public.subscription_offers USING btree (code) WHERE (code IS NOT NULL);


--
-- Name: idx_sub_offers_recipient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sub_offers_recipient ON public.subscription_offers USING btree (recipient_id) WHERE (recipient_id IS NOT NULL);


--
-- Name: idx_sub_offers_writer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sub_offers_writer ON public.subscription_offers USING btree (writer_id);


--
-- Name: idx_subscription_events_publication; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscription_events_publication ON public.subscription_events USING btree (publication_id) WHERE (publication_id IS NOT NULL);


--
-- Name: idx_subscriptions_period_end; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_period_end ON public.subscriptions USING btree (current_period_end) WHERE (status = ANY (ARRAY['active'::text, 'cancelled'::text]));


--
-- Name: idx_subscriptions_publication; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_publication ON public.subscriptions USING btree (publication_id) WHERE (publication_id IS NOT NULL);


--
-- Name: idx_subscriptions_reader; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_reader ON public.subscriptions USING btree (reader_id);


--
-- Name: idx_subscriptions_reader_publication; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_subscriptions_reader_publication ON public.subscriptions USING btree (reader_id, publication_id) WHERE (publication_id IS NOT NULL);


--
-- Name: idx_subscriptions_reader_writer; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_subscriptions_reader_writer ON public.subscriptions USING btree (reader_id, writer_id) WHERE (writer_id IS NOT NULL);


--
-- Name: idx_subscriptions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_status ON public.subscriptions USING btree (status) WHERE ((status = 'active'::text) OR (status = 'cancelled'::text));


--
-- Name: idx_subscriptions_writer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_writer ON public.subscriptions USING btree (writer_id);


--
-- Name: idx_tab_settlements_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tab_settlements_pending ON public.tab_settlements USING btree (status) WHERE (status = 'pending'::text);


--
-- Name: idx_tab_settlements_reader_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tab_settlements_reader_id ON public.tab_settlements USING btree (reader_id);


--
-- Name: idx_tab_settlements_settled_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tab_settlements_settled_at ON public.tab_settlements USING btree (settled_at DESC);


--
-- Name: idx_tags_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tags_name ON public.tags USING btree (name);


--
-- Name: idx_vault_keys_article_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vault_keys_article_id ON public.vault_keys USING btree (article_id);


--
-- Name: idx_vote_charges_recipient_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vote_charges_recipient_id ON public.vote_charges USING btree (recipient_id) WHERE (recipient_id IS NOT NULL);


--
-- Name: idx_vote_charges_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vote_charges_state ON public.vote_charges USING btree (state);


--
-- Name: idx_vote_charges_tab_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vote_charges_tab_id ON public.vote_charges USING btree (tab_id) WHERE (tab_id IS NOT NULL);


--
-- Name: idx_vote_charges_vote_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vote_charges_vote_id ON public.vote_charges USING btree (vote_id);


--
-- Name: idx_vote_charges_voter_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vote_charges_voter_id ON public.vote_charges USING btree (voter_id);


--
-- Name: idx_votes_author; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_votes_author ON public.votes USING btree (target_author_id);


--
-- Name: idx_votes_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_votes_created ON public.votes USING btree (created_at DESC);


--
-- Name: idx_votes_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_votes_target ON public.votes USING btree (target_nostr_event_id);


--
-- Name: idx_votes_voter_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_votes_voter_target ON public.votes USING btree (voter_id, target_nostr_event_id, direction);


--
-- Name: idx_vouches_attestor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vouches_attestor ON public.vouches USING btree (attestor_id) WHERE (withdrawn_at IS NULL);


--
-- Name: idx_vouches_public; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vouches_public ON public.vouches USING btree (subject_id, dimension) WHERE ((visibility = 'public'::text) AND (withdrawn_at IS NULL));


--
-- Name: idx_vouches_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vouches_subject ON public.vouches USING btree (subject_id) WHERE (withdrawn_at IS NULL);


--
-- Name: idx_writer_payouts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_writer_payouts_status ON public.writer_payouts USING btree (status);


--
-- Name: idx_writer_payouts_writer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_writer_payouts_writer_id ON public.writer_payouts USING btree (writer_id);


--
-- Name: relay_outbox_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX relay_outbox_entity_idx ON public.relay_outbox USING btree (entity_type, entity_id);


--
-- Name: relay_outbox_event_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX relay_outbox_event_id_idx ON public.relay_outbox USING btree (((signed_event ->> 'id'::text)));


--
-- Name: relay_outbox_ready_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX relay_outbox_ready_idx ON public.relay_outbox USING btree (next_attempt_at) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text]));


--
-- Name: resolver_async_results_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX resolver_async_results_expires_at_idx ON public.resolver_async_results USING btree (expires_at);


--
-- Name: resolver_async_results_initiator_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX resolver_async_results_initiator_created_idx ON public.resolver_async_results USING btree (initiator_id, created_at DESC);


--
-- Name: trust_polls_subject_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trust_polls_subject_idx ON public.trust_polls USING btree (subject_id, question);


--
-- Name: uniq_outbound_posts_dedup; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_outbound_posts_dedup ON public.outbound_posts USING btree (account_id, nostr_event_id, linked_account_id, action_type) NULLS NOT DISTINCT;


--
-- Name: idx_traf_mentions_piece; Type: INDEX; Schema: traffology; Owner: -
--

CREATE INDEX idx_traf_mentions_piece ON traffology.public_mentions USING btree (piece_id);


--
-- Name: idx_traf_nostr_events_piece; Type: INDEX; Schema: traffology; Owner: -
--

CREATE INDEX idx_traf_nostr_events_piece ON traffology.nostr_events USING btree (piece_id);


--
-- Name: idx_traf_observations_piece; Type: INDEX; Schema: traffology; Owner: -
--

CREATE INDEX idx_traf_observations_piece ON traffology.observations USING btree (piece_id, created_at DESC) WHERE (piece_id IS NOT NULL);


--
-- Name: idx_traf_observations_type; Type: INDEX; Schema: traffology; Owner: -
--

CREATE INDEX idx_traf_observations_type ON traffology.observations USING btree (observation_type, created_at DESC);


--
-- Name: idx_traf_observations_writer; Type: INDEX; Schema: traffology; Owner: -
--

CREATE INDEX idx_traf_observations_writer ON traffology.observations USING btree (writer_id, created_at DESC);


--
-- Name: idx_traf_pieces_nostr; Type: INDEX; Schema: traffology; Owner: -
--

CREATE INDEX idx_traf_pieces_nostr ON traffology.pieces USING btree (nostr_event_id) WHERE (nostr_event_id IS NOT NULL);


--
-- Name: idx_traf_pieces_publication; Type: INDEX; Schema: traffology; Owner: -
--

CREATE INDEX idx_traf_pieces_publication ON traffology.pieces USING btree (publication_id) WHERE (publication_id IS NOT NULL);


--
-- Name: idx_traf_pieces_writer; Type: INDEX; Schema: traffology; Owner: -
--

CREATE INDEX idx_traf_pieces_writer ON traffology.pieces USING btree (writer_id);


--
-- Name: idx_traf_sessions_dedup; Type: INDEX; Schema: traffology; Owner: -
--

CREATE UNIQUE INDEX idx_traf_sessions_dedup ON traffology.sessions USING btree (session_token, piece_id);


--
-- Name: idx_traf_sessions_piece; Type: INDEX; Schema: traffology; Owner: -
--

CREATE INDEX idx_traf_sessions_piece ON traffology.sessions USING btree (piece_id, started_at DESC);


--
-- Name: idx_traf_sessions_piece_last_beacon; Type: INDEX; Schema: traffology; Owner: -
--

CREATE INDEX idx_traf_sessions_piece_last_beacon ON traffology.sessions USING btree (piece_id, last_beacon_at DESC);


--
-- Name: idx_traf_sessions_started; Type: INDEX; Schema: traffology; Owner: -
--

CREATE INDEX idx_traf_sessions_started ON traffology.sessions USING btree (started_at DESC);


--
-- Name: idx_traf_sources_domain; Type: INDEX; Schema: traffology; Owner: -
--

CREATE INDEX idx_traf_sources_domain ON traffology.sources USING btree (writer_id, domain) WHERE (domain IS NOT NULL);


--
-- Name: idx_traf_sources_unique_null_domain; Type: INDEX; Schema: traffology; Owner: -
--

CREATE UNIQUE INDEX idx_traf_sources_unique_null_domain ON traffology.sources USING btree (writer_id, source_type, display_name) WHERE (domain IS NULL);


--
-- Name: idx_traf_sources_unique_with_domain; Type: INDEX; Schema: traffology; Owner: -
--

CREATE UNIQUE INDEX idx_traf_sources_unique_with_domain ON traffology.sources USING btree (writer_id, source_type, domain, display_name) WHERE (domain IS NOT NULL);


--
-- Name: idx_traf_sources_writer; Type: INDEX; Schema: traffology; Owner: -
--

CREATE INDEX idx_traf_sources_writer ON traffology.sources USING btree (writer_id);


--
-- Name: articles articles_size_tier_default; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER articles_size_tier_default BEFORE INSERT ON public.articles FOR EACH ROW EXECUTE FUNCTION public.articles_derive_size_tier();


--
-- Name: feed_items feed_items_post_identity_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER feed_items_post_identity_trg BEFORE INSERT OR UPDATE ON public.feed_items FOR EACH ROW EXECUTE FUNCTION public.feed_items_post_identity();


--
-- Name: feed_sources feed_sources_touch_parent; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER feed_sources_touch_parent AFTER INSERT OR DELETE OR UPDATE ON public.feed_sources FOR EACH ROW EXECUTE FUNCTION public.feed_sources_touch_parent();


--
-- Name: feeds feeds_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER feeds_touch_updated_at BEFORE UPDATE ON public.feeds FOR EACH ROW EXECUTE FUNCTION public.feeds_touch_updated_at();


--
-- Name: accounts trg_accounts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_accounts_updated_at BEFORE UPDATE ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: activitypub_instance_health trg_activitypub_instance_health_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_activitypub_instance_health_updated_at BEFORE UPDATE ON public.activitypub_instance_health FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: articles trg_articles_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_articles_updated_at BEFORE UPDATE ON public.articles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: atproto_oauth_sessions trg_atproto_oauth_sessions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_atproto_oauth_sessions_updated_at BEFORE UPDATE ON public.atproto_oauth_sessions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: external_sources trg_external_sources_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_external_sources_updated_at BEFORE UPDATE ON public.external_sources FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: linked_accounts trg_linked_accounts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_linked_accounts_updated_at BEFORE UPDATE ON public.linked_accounts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: notification_preferences trg_notification_preferences_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_notification_preferences_updated_at BEFORE UPDATE ON public.notification_preferences FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: platform_config trg_platform_config_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_platform_config_updated_at BEFORE UPDATE ON public.platform_config FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: pledge_drives trg_pledge_drives_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_pledge_drives_updated_at BEFORE UPDATE ON public.pledge_drives FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: reading_tabs trg_reading_tabs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_reading_tabs_updated_at BEFORE UPDATE ON public.reading_tabs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: subscriptions trg_subscriptions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_subscriptions_updated_at BEFORE UPDATE ON public.subscriptions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: vote_tallies trg_vote_tallies_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_vote_tallies_updated_at BEFORE UPDATE ON public.vote_tallies FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: trust_polls trust_polls_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trust_polls_touch_updated_at BEFORE UPDATE ON public.trust_polls FOR EACH ROW EXECUTE FUNCTION public.trust_polls_touch_updated_at();


--
-- Name: article_drafts article_drafts_publication_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_drafts
    ADD CONSTRAINT article_drafts_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.publications(id) ON DELETE SET NULL;


--
-- Name: article_drafts article_drafts_writer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_drafts
    ADD CONSTRAINT article_drafts_writer_id_fkey FOREIGN KEY (writer_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: article_tags article_tags_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_tags
    ADD CONSTRAINT article_tags_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


--
-- Name: article_tags article_tags_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_tags
    ADD CONSTRAINT article_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE CASCADE;


--
-- Name: article_unlocks article_unlocks_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_unlocks
    ADD CONSTRAINT article_unlocks_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id);


--
-- Name: article_unlocks article_unlocks_reader_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_unlocks
    ADD CONSTRAINT article_unlocks_reader_id_fkey FOREIGN KEY (reader_id) REFERENCES public.accounts(id);


--
-- Name: article_unlocks article_unlocks_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_unlocks
    ADD CONSTRAINT article_unlocks_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.subscriptions(id);


--
-- Name: articles articles_publication_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.articles
    ADD CONSTRAINT articles_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.publications(id) ON DELETE SET NULL;


--
-- Name: articles articles_writer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.articles
    ADD CONSTRAINT articles_writer_id_fkey FOREIGN KEY (writer_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;


--
-- Name: blocks blocks_blocked_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocks
    ADD CONSTRAINT blocks_blocked_id_fkey FOREIGN KEY (blocked_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: blocks blocks_blocker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocks
    ADD CONSTRAINT blocks_blocker_id_fkey FOREIGN KEY (blocker_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: bookmarks bookmarks_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookmarks
    ADD CONSTRAINT bookmarks_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


--
-- Name: bookmarks bookmarks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookmarks
    ADD CONSTRAINT bookmarks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: comments comments_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;


--
-- Name: comments comments_parent_comment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_parent_comment_id_fkey FOREIGN KEY (parent_comment_id) REFERENCES public.comments(id) ON DELETE CASCADE;


--
-- Name: content_key_issuances content_key_issuances_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_key_issuances
    ADD CONSTRAINT content_key_issuances_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE RESTRICT;


--
-- Name: content_key_issuances content_key_issuances_read_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_key_issuances
    ADD CONSTRAINT content_key_issuances_read_event_id_fkey FOREIGN KEY (read_event_id) REFERENCES public.read_events(id) ON DELETE SET NULL;


--
-- Name: content_key_issuances content_key_issuances_reader_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_key_issuances
    ADD CONSTRAINT content_key_issuances_reader_id_fkey FOREIGN KEY (reader_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;


--
-- Name: content_key_issuances content_key_issuances_vault_key_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_key_issuances
    ADD CONSTRAINT content_key_issuances_vault_key_id_fkey FOREIGN KEY (vault_key_id) REFERENCES public.vault_keys(id) ON DELETE RESTRICT;


--
-- Name: conversation_members conversation_members_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_members
    ADD CONSTRAINT conversation_members_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: conversation_members conversation_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_members
    ADD CONSTRAINT conversation_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: conversations conversations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.accounts(id);


--
-- Name: direct_messages direct_messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_messages
    ADD CONSTRAINT direct_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: direct_messages direct_messages_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_messages
    ADD CONSTRAINT direct_messages_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: direct_messages direct_messages_reply_to_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_messages
    ADD CONSTRAINT direct_messages_reply_to_id_fkey FOREIGN KEY (reply_to_id) REFERENCES public.direct_messages(id) ON DELETE SET NULL;


--
-- Name: direct_messages direct_messages_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.direct_messages
    ADD CONSTRAINT direct_messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: dm_likes dm_likes_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_likes
    ADD CONSTRAINT dm_likes_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.direct_messages(id) ON DELETE CASCADE;


--
-- Name: dm_likes dm_likes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_likes
    ADD CONSTRAINT dm_likes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: dm_pricing dm_pricing_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_pricing
    ADD CONSTRAINT dm_pricing_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.accounts(id);


--
-- Name: dm_pricing dm_pricing_target_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_pricing
    ADD CONSTRAINT dm_pricing_target_id_fkey FOREIGN KEY (target_id) REFERENCES public.accounts(id);


--
-- Name: external_authors external_authors_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_authors
    ADD CONSTRAINT external_authors_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: external_items external_items_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_items
    ADD CONSTRAINT external_items_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.external_sources(id) ON DELETE CASCADE;


--
-- Name: external_subscriptions external_subscriptions_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_subscriptions
    ADD CONSTRAINT external_subscriptions_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.external_sources(id) ON DELETE CASCADE;


--
-- Name: external_subscriptions external_subscriptions_subscriber_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_subscriptions
    ADD CONSTRAINT external_subscriptions_subscriber_id_fkey FOREIGN KEY (subscriber_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: feed_engagement feed_engagement_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed_engagement
    ADD CONSTRAINT feed_engagement_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: feed_engagement feed_engagement_target_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed_engagement
    ADD CONSTRAINT feed_engagement_target_author_id_fkey FOREIGN KEY (target_author_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: feed_items feed_items_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed_items
    ADD CONSTRAINT feed_items_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


--
-- Name: feed_items feed_items_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed_items
    ADD CONSTRAINT feed_items_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: feed_items feed_items_external_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed_items
    ADD CONSTRAINT feed_items_external_author_id_fkey FOREIGN KEY (external_author_id) REFERENCES public.external_authors(id);


--
-- Name: feed_items feed_items_external_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed_items
    ADD CONSTRAINT feed_items_external_item_id_fkey FOREIGN KEY (external_item_id) REFERENCES public.external_items(id) ON DELETE CASCADE;


--
-- Name: feed_items feed_items_note_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed_items
    ADD CONSTRAINT feed_items_note_id_fkey FOREIGN KEY (note_id) REFERENCES public.notes(id) ON DELETE CASCADE;


--
-- Name: feed_items feed_items_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed_items
    ADD CONSTRAINT feed_items_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.external_sources(id) ON DELETE CASCADE;


--
-- Name: feed_saves feed_saves_feed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed_saves
    ADD CONSTRAINT feed_saves_feed_id_fkey FOREIGN KEY (feed_id) REFERENCES public.feeds(id) ON DELETE CASCADE;


--
-- Name: feed_saves feed_saves_feed_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed_saves
    ADD CONSTRAINT feed_saves_feed_item_id_fkey FOREIGN KEY (feed_item_id) REFERENCES public.feed_items(id) ON DELETE CASCADE;


--
-- Name: feed_scores feed_scores_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed_scores
    ADD CONSTRAINT feed_scores_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: feed_scores feed_scores_publication_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed_scores
    ADD CONSTRAINT feed_scores_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.publications(id);


--
-- Name: feed_sources feed_sources_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed_sources
    ADD CONSTRAINT feed_sources_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: feed_sources feed_sources_external_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed_sources
    ADD CONSTRAINT feed_sources_external_source_id_fkey FOREIGN KEY (external_source_id) REFERENCES public.external_sources(id) ON DELETE CASCADE;


--
-- Name: feed_sources feed_sources_feed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed_sources
    ADD CONSTRAINT feed_sources_feed_id_fkey FOREIGN KEY (feed_id) REFERENCES public.feeds(id) ON DELETE CASCADE;


--
-- Name: feed_sources feed_sources_publication_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed_sources
    ADD CONSTRAINT feed_sources_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.publications(id) ON DELETE CASCADE;


--
-- Name: feeds feeds_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feeds
    ADD CONSTRAINT feeds_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: read_events fk_read_events_tab_settlement; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.read_events
    ADD CONSTRAINT fk_read_events_tab_settlement FOREIGN KEY (tab_settlement_id) REFERENCES public.tab_settlements(id) ON DELETE SET NULL;


--
-- Name: read_events fk_read_events_writer_payout; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.read_events
    ADD CONSTRAINT fk_read_events_writer_payout FOREIGN KEY (writer_payout_id) REFERENCES public.writer_payouts(id) ON DELETE SET NULL;


--
-- Name: vote_charges fk_vote_charges_writer_payout; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vote_charges
    ADD CONSTRAINT fk_vote_charges_writer_payout FOREIGN KEY (writer_payout_id) REFERENCES public.writer_payouts(id) ON DELETE SET NULL;


--
-- Name: follows follows_followee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.follows
    ADD CONSTRAINT follows_followee_id_fkey FOREIGN KEY (followee_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: follows follows_follower_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.follows
    ADD CONSTRAINT follows_follower_id_fkey FOREIGN KEY (follower_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: gift_links gift_links_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gift_links
    ADD CONSTRAINT gift_links_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


--
-- Name: gift_links gift_links_creator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gift_links
    ADD CONSTRAINT gift_links_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: linked_accounts linked_accounts_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.linked_accounts
    ADD CONSTRAINT linked_accounts_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: magic_links magic_links_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.magic_links
    ADD CONSTRAINT magic_links_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: media_uploads media_uploads_uploader_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_uploads
    ADD CONSTRAINT media_uploads_uploader_id_fkey FOREIGN KEY (uploader_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;


--
-- Name: moderation_reports moderation_reports_reporter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moderation_reports
    ADD CONSTRAINT moderation_reports_reporter_id_fkey FOREIGN KEY (reporter_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: moderation_reports moderation_reports_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moderation_reports
    ADD CONSTRAINT moderation_reports_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: moderation_reports moderation_reports_target_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moderation_reports
    ADD CONSTRAINT moderation_reports_target_account_id_fkey FOREIGN KEY (target_account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: mutes mutes_muted_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mutes
    ADD CONSTRAINT mutes_muted_id_fkey FOREIGN KEY (muted_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: mutes mutes_muter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mutes
    ADD CONSTRAINT mutes_muter_id_fkey FOREIGN KEY (muter_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: notes notes_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;


--
-- Name: notes notes_external_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_external_parent_id_fkey FOREIGN KEY (external_parent_id) REFERENCES public.external_items(id) ON DELETE SET NULL;


--
-- Name: notification_preferences notification_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: notifications notifications_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_comment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_comment_id_fkey FOREIGN KEY (comment_id) REFERENCES public.comments(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE SET NULL;


--
-- Name: notifications notifications_drive_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_drive_id_fkey FOREIGN KEY (drive_id) REFERENCES public.pledge_drives(id) ON DELETE SET NULL;


--
-- Name: notifications notifications_note_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_note_id_fkey FOREIGN KEY (note_id) REFERENCES public.notes(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: outbound_posts outbound_posts_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_posts
    ADD CONSTRAINT outbound_posts_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: outbound_posts outbound_posts_linked_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_posts
    ADD CONSTRAINT outbound_posts_linked_account_id_fkey FOREIGN KEY (linked_account_id) REFERENCES public.linked_accounts(id) ON DELETE CASCADE;


--
-- Name: outbound_posts outbound_posts_source_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_posts
    ADD CONSTRAINT outbound_posts_source_item_id_fkey FOREIGN KEY (source_item_id) REFERENCES public.external_items(id) ON DELETE SET NULL;


--
-- Name: pledge_drives pledge_drives_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pledge_drives
    ADD CONSTRAINT pledge_drives_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id);


--
-- Name: pledge_drives pledge_drives_creator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pledge_drives
    ADD CONSTRAINT pledge_drives_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.accounts(id);


--
-- Name: pledge_drives pledge_drives_draft_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pledge_drives
    ADD CONSTRAINT pledge_drives_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.article_drafts(id);


--
-- Name: pledge_drives pledge_drives_parent_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pledge_drives
    ADD CONSTRAINT pledge_drives_parent_conversation_id_fkey FOREIGN KEY (parent_conversation_id) REFERENCES public.conversations(id) ON DELETE SET NULL;


--
-- Name: pledge_drives pledge_drives_target_writer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pledge_drives
    ADD CONSTRAINT pledge_drives_target_writer_id_fkey FOREIGN KEY (target_writer_id) REFERENCES public.accounts(id);


--
-- Name: pledges pledges_drive_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pledges
    ADD CONSTRAINT pledges_drive_id_fkey FOREIGN KEY (drive_id) REFERENCES public.pledge_drives(id);


--
-- Name: pledges pledges_pledger_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pledges
    ADD CONSTRAINT pledges_pledger_id_fkey FOREIGN KEY (pledger_id) REFERENCES public.accounts(id);


--
-- Name: pledges pledges_read_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pledges
    ADD CONSTRAINT pledges_read_event_id_fkey FOREIGN KEY (read_event_id) REFERENCES public.read_events(id);


--
-- Name: publication_article_shares publication_article_shares_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_article_shares
    ADD CONSTRAINT publication_article_shares_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: publication_article_shares publication_article_shares_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_article_shares
    ADD CONSTRAINT publication_article_shares_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


--
-- Name: publication_article_shares publication_article_shares_publication_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_article_shares
    ADD CONSTRAINT publication_article_shares_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.publications(id) ON DELETE CASCADE;


--
-- Name: publication_follows publication_follows_follower_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_follows
    ADD CONSTRAINT publication_follows_follower_id_fkey FOREIGN KEY (follower_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: publication_follows publication_follows_publication_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_follows
    ADD CONSTRAINT publication_follows_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.publications(id) ON DELETE CASCADE;


--
-- Name: publication_invites publication_invites_invited_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_invites
    ADD CONSTRAINT publication_invites_invited_account_id_fkey FOREIGN KEY (invited_account_id) REFERENCES public.accounts(id);


--
-- Name: publication_invites publication_invites_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_invites
    ADD CONSTRAINT publication_invites_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: publication_invites publication_invites_publication_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_invites
    ADD CONSTRAINT publication_invites_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.publications(id) ON DELETE CASCADE;


--
-- Name: publication_members publication_members_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_members
    ADD CONSTRAINT publication_members_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: publication_members publication_members_publication_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_members
    ADD CONSTRAINT publication_members_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.publications(id) ON DELETE CASCADE;


--
-- Name: publication_payout_splits publication_payout_splits_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_payout_splits
    ADD CONSTRAINT publication_payout_splits_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);


--
-- Name: publication_payout_splits publication_payout_splits_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_payout_splits
    ADD CONSTRAINT publication_payout_splits_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id);


--
-- Name: publication_payout_splits publication_payout_splits_publication_payout_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_payout_splits
    ADD CONSTRAINT publication_payout_splits_publication_payout_id_fkey FOREIGN KEY (publication_payout_id) REFERENCES public.publication_payouts(id) ON DELETE CASCADE;


--
-- Name: publication_payouts publication_payouts_publication_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_payouts
    ADD CONSTRAINT publication_payouts_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.publications(id);


--
-- Name: read_events read_events_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.read_events
    ADD CONSTRAINT read_events_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE RESTRICT;


--
-- Name: read_events read_events_reader_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.read_events
    ADD CONSTRAINT read_events_reader_id_fkey FOREIGN KEY (reader_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;


--
-- Name: read_events read_events_tab_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.read_events
    ADD CONSTRAINT read_events_tab_id_fkey FOREIGN KEY (tab_id) REFERENCES public.reading_tabs(id) ON DELETE SET NULL;


--
-- Name: read_events read_events_via_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.read_events
    ADD CONSTRAINT read_events_via_subscription_id_fkey FOREIGN KEY (via_subscription_id) REFERENCES public.subscriptions(id);


--
-- Name: read_events read_events_writer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.read_events
    ADD CONSTRAINT read_events_writer_id_fkey FOREIGN KEY (writer_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;


--
-- Name: reading_positions reading_positions_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reading_positions
    ADD CONSTRAINT reading_positions_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


--
-- Name: reading_positions reading_positions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reading_positions
    ADD CONSTRAINT reading_positions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: reading_tabs reading_tabs_reader_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reading_tabs
    ADD CONSTRAINT reading_tabs_reader_id_fkey FOREIGN KEY (reader_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;


--
-- Name: repost_edges repost_edges_actor_external_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repost_edges
    ADD CONSTRAINT repost_edges_actor_external_author_id_fkey FOREIGN KEY (actor_external_author_id) REFERENCES public.external_authors(id) ON DELETE SET NULL;


--
-- Name: resolver_async_results resolver_async_results_initiator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resolver_async_results
    ADD CONSTRAINT resolver_async_results_initiator_id_fkey FOREIGN KEY (initiator_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: subscription_events subscription_events_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_events
    ADD CONSTRAINT subscription_events_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id);


--
-- Name: subscription_events subscription_events_publication_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_events
    ADD CONSTRAINT subscription_events_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.publications(id);


--
-- Name: subscription_events subscription_events_reader_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_events
    ADD CONSTRAINT subscription_events_reader_id_fkey FOREIGN KEY (reader_id) REFERENCES public.accounts(id);


--
-- Name: subscription_events subscription_events_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_events
    ADD CONSTRAINT subscription_events_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.subscriptions(id) ON DELETE CASCADE;


--
-- Name: subscription_events subscription_events_writer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_events
    ADD CONSTRAINT subscription_events_writer_id_fkey FOREIGN KEY (writer_id) REFERENCES public.accounts(id);


--
-- Name: subscription_nudge_log subscription_nudge_log_publication_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_nudge_log
    ADD CONSTRAINT subscription_nudge_log_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.publications(id);


--
-- Name: subscription_nudge_log subscription_nudge_log_reader_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_nudge_log
    ADD CONSTRAINT subscription_nudge_log_reader_id_fkey FOREIGN KEY (reader_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: subscription_nudge_log subscription_nudge_log_writer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_nudge_log
    ADD CONSTRAINT subscription_nudge_log_writer_id_fkey FOREIGN KEY (writer_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: subscription_offers subscription_offers_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_offers
    ADD CONSTRAINT subscription_offers_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.accounts(id);


--
-- Name: subscription_offers subscription_offers_writer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_offers
    ADD CONSTRAINT subscription_offers_writer_id_fkey FOREIGN KEY (writer_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_offer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_offer_id_fkey FOREIGN KEY (offer_id) REFERENCES public.subscription_offers(id);


--
-- Name: subscriptions subscriptions_publication_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.publications(id) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_reader_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_reader_id_fkey FOREIGN KEY (reader_id) REFERENCES public.accounts(id);


--
-- Name: subscriptions subscriptions_writer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_writer_id_fkey FOREIGN KEY (writer_id) REFERENCES public.accounts(id);


--
-- Name: tab_settlements tab_settlements_reader_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tab_settlements
    ADD CONSTRAINT tab_settlements_reader_id_fkey FOREIGN KEY (reader_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;


--
-- Name: tab_settlements tab_settlements_tab_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tab_settlements
    ADD CONSTRAINT tab_settlements_tab_id_fkey FOREIGN KEY (tab_id) REFERENCES public.reading_tabs(id) ON DELETE RESTRICT;


--
-- Name: trust_layer1 trust_layer1_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trust_layer1
    ADD CONSTRAINT trust_layer1_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: trust_polls trust_polls_respondent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trust_polls
    ADD CONSTRAINT trust_polls_respondent_id_fkey FOREIGN KEY (respondent_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: trust_polls trust_polls_subject_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trust_polls
    ADD CONSTRAINT trust_polls_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: trust_profiles trust_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trust_profiles
    ADD CONSTRAINT trust_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: vault_keys vault_keys_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_keys
    ADD CONSTRAINT vault_keys_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE RESTRICT;


--
-- Name: vote_charges vote_charges_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vote_charges
    ADD CONSTRAINT vote_charges_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.accounts(id);


--
-- Name: vote_charges vote_charges_tab_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vote_charges
    ADD CONSTRAINT vote_charges_tab_id_fkey FOREIGN KEY (tab_id) REFERENCES public.reading_tabs(id) ON DELETE SET NULL;


--
-- Name: vote_charges vote_charges_vote_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vote_charges
    ADD CONSTRAINT vote_charges_vote_id_fkey FOREIGN KEY (vote_id) REFERENCES public.votes(id);


--
-- Name: vote_charges vote_charges_voter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vote_charges
    ADD CONSTRAINT vote_charges_voter_id_fkey FOREIGN KEY (voter_id) REFERENCES public.accounts(id);


--
-- Name: votes votes_tab_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.votes
    ADD CONSTRAINT votes_tab_id_fkey FOREIGN KEY (tab_id) REFERENCES public.reading_tabs(id) ON DELETE SET NULL;


--
-- Name: votes votes_target_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.votes
    ADD CONSTRAINT votes_target_author_id_fkey FOREIGN KEY (target_author_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: votes votes_voter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.votes
    ADD CONSTRAINT votes_voter_id_fkey FOREIGN KEY (voter_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: vouches vouches_attestor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vouches
    ADD CONSTRAINT vouches_attestor_id_fkey FOREIGN KEY (attestor_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: vouches vouches_subject_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vouches
    ADD CONSTRAINT vouches_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: writer_payouts writer_payouts_writer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.writer_payouts
    ADD CONSTRAINT writer_payouts_writer_id_fkey FOREIGN KEY (writer_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;


--
-- Name: sessions fk_sessions_source; Type: FK CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.sessions
    ADD CONSTRAINT fk_sessions_source FOREIGN KEY (resolved_source_id) REFERENCES traffology.sources(id) ON DELETE SET NULL;


--
-- Name: half_day_buckets half_day_buckets_piece_id_fkey; Type: FK CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.half_day_buckets
    ADD CONSTRAINT half_day_buckets_piece_id_fkey FOREIGN KEY (piece_id) REFERENCES traffology.pieces(id) ON DELETE CASCADE;


--
-- Name: half_day_buckets half_day_buckets_source_id_fkey; Type: FK CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.half_day_buckets
    ADD CONSTRAINT half_day_buckets_source_id_fkey FOREIGN KEY (source_id) REFERENCES traffology.sources(id) ON DELETE CASCADE;


--
-- Name: nostr_events nostr_events_piece_id_fkey; Type: FK CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.nostr_events
    ADD CONSTRAINT nostr_events_piece_id_fkey FOREIGN KEY (piece_id) REFERENCES traffology.pieces(id) ON DELETE CASCADE;


--
-- Name: observations observations_piece_id_fkey; Type: FK CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.observations
    ADD CONSTRAINT observations_piece_id_fkey FOREIGN KEY (piece_id) REFERENCES traffology.pieces(id) ON DELETE CASCADE;


--
-- Name: observations observations_writer_id_fkey; Type: FK CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.observations
    ADD CONSTRAINT observations_writer_id_fkey FOREIGN KEY (writer_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: piece_stats piece_stats_piece_id_fkey; Type: FK CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.piece_stats
    ADD CONSTRAINT piece_stats_piece_id_fkey FOREIGN KEY (piece_id) REFERENCES traffology.pieces(id) ON DELETE CASCADE;


--
-- Name: piece_stats piece_stats_top_source_id_fkey; Type: FK CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.piece_stats
    ADD CONSTRAINT piece_stats_top_source_id_fkey FOREIGN KEY (top_source_id) REFERENCES traffology.sources(id) ON DELETE SET NULL;


--
-- Name: pieces pieces_article_id_fkey; Type: FK CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.pieces
    ADD CONSTRAINT pieces_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


--
-- Name: pieces pieces_publication_id_fkey; Type: FK CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.pieces
    ADD CONSTRAINT pieces_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.publications(id) ON DELETE SET NULL;


--
-- Name: pieces pieces_writer_id_fkey; Type: FK CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.pieces
    ADD CONSTRAINT pieces_writer_id_fkey FOREIGN KEY (writer_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: public_mentions public_mentions_piece_id_fkey; Type: FK CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.public_mentions
    ADD CONSTRAINT public_mentions_piece_id_fkey FOREIGN KEY (piece_id) REFERENCES traffology.pieces(id) ON DELETE CASCADE;


--
-- Name: publication_baselines publication_baselines_publication_id_fkey; Type: FK CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.publication_baselines
    ADD CONSTRAINT publication_baselines_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.publications(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_piece_id_fkey; Type: FK CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.sessions
    ADD CONSTRAINT sessions_piece_id_fkey FOREIGN KEY (piece_id) REFERENCES traffology.pieces(id) ON DELETE CASCADE;


--
-- Name: source_stats source_stats_piece_id_fkey; Type: FK CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.source_stats
    ADD CONSTRAINT source_stats_piece_id_fkey FOREIGN KEY (piece_id) REFERENCES traffology.pieces(id) ON DELETE CASCADE;


--
-- Name: source_stats source_stats_source_id_fkey; Type: FK CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.source_stats
    ADD CONSTRAINT source_stats_source_id_fkey FOREIGN KEY (source_id) REFERENCES traffology.sources(id) ON DELETE CASCADE;


--
-- Name: sources sources_allhaus_writer_id_fkey; Type: FK CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.sources
    ADD CONSTRAINT sources_allhaus_writer_id_fkey FOREIGN KEY (allhaus_writer_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: sources sources_writer_id_fkey; Type: FK CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.sources
    ADD CONSTRAINT sources_writer_id_fkey FOREIGN KEY (writer_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: topic_performance topic_performance_writer_id_fkey; Type: FK CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.topic_performance
    ADD CONSTRAINT topic_performance_writer_id_fkey FOREIGN KEY (writer_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: writer_baselines writer_baselines_writer_id_fkey; Type: FK CONSTRAINT; Schema: traffology; Owner: -
--

ALTER TABLE ONLY traffology.writer_baselines
    ADD CONSTRAINT writer_baselines_writer_id_fkey FOREIGN KEY (writer_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: _private_job_queues; Type: ROW SECURITY; Schema: graphile_worker; Owner: -
--

ALTER TABLE graphile_worker._private_job_queues ENABLE ROW LEVEL SECURITY;

--
-- Name: _private_jobs; Type: ROW SECURITY; Schema: graphile_worker; Owner: -
--

ALTER TABLE graphile_worker._private_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: _private_known_crontabs; Type: ROW SECURITY; Schema: graphile_worker; Owner: -
--

ALTER TABLE graphile_worker._private_known_crontabs ENABLE ROW LEVEL SECURITY;

--
-- Name: _private_tasks; Type: ROW SECURITY; Schema: graphile_worker; Owner: -
--

ALTER TABLE graphile_worker._private_tasks ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict onI46j7hnaW5pnrjeiahuI2efghI6TfxQMbEL1tOCjtrzOx3jHpMqks3a3muPHc




--
-- Seed _migrations: record every migration folded into this dump as applied.
--
-- A fresh database is bootstrapped from this file (docker-entrypoint-initdb.d),
-- which builds the schema THROUGH the latest migration but leaves _migrations
-- empty. Without this seed the runner (shared/src/db/migrate.ts) would treat
-- all migrations/ files as pending on a fresh DB and re-run 001+ against the
-- already-built schema, which fails. With it, migrate is a clean no-op on a
-- fresh DB and applies only genuinely-new files on an existing one.
--
-- KEEP IN SYNC: when you add a migration and fold it into this schema.sql,
-- add its filename below (regenerating this file from a fully-migrated DB
-- with a seeded _migrations table does this automatically).
--

INSERT INTO public._migrations (filename) VALUES
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
    ('084_email_verification_requested_at.sql'),
    ('085_settlement_status.sql'),
    ('086_reading_tabs_balance_check.sql'),
    ('087_schema_hardening.sql'),
    ('088_traffology_sources_unique.sql'),
    ('089_workspace_hardening.sql'),
    ('090_external_engagement_counts.sql'),
    ('091_external_items_context_only.sql'),
    ('092_interaction_foundation.sql'),
    ('093_content_warning.sql'),
    ('094_external_protocol_expansion.sql'),
    ('095_external_protocol_check_constraint.sql'),
    ('096_email_ingest.sql'),
    ('097_feed_items_is_reply.sql'),
    ('098_feed_items_post_identity.sql'),
    ('099_external_author_identity.sql'),
    ('100_repost_edges.sql'),
    ('101_nostr_relay_free_identity.sql'),
    ('102_notes_external_quote.sql'),
    ('103_subscription_events_publication.sql'),
    ('104_repost_edges_boosted_at.sql'),
    ('105_feed_items_reply_to_author.sql'),
    ('106_feed_ingest_enqueue_cap.sql'),
    ('107_feed_sources_exclude_replies.sql'),
    ('108_nostr_outbound_discovery.sql');

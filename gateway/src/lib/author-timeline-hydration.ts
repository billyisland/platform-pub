// Profile-view timeline hydration (EXTERNAL-AUTHOR-HISTORY-ADR §3) — the
// profile twin of thread hydration (external-hydration.ts): an on-demand,
// best-effort fetch of an external author's recent timeline into the DB
// substrate GET /author/:id/posts reads, kicked in the background when a
// profile is viewed. Rows are written is_context_only = TRUE (feed-excluded,
// context-GC'd, thread-expandable) AND is_profile_hydrated = TRUE (included in
// /posts). Never throws: every failure logs and returns.
//
// Phase 3 ships nostr_external; Phase 4 extends the protocol switch to atproto
// + activitypub. rss/email are out of scope (no external_authors record, no
// /author route).
import { verifyEvent } from "nostr-tools";
import { pool } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { mergeNostrRelayUrls } from "@platform-pub/shared/lib/nip65.js";
import {
  fetchNostrEvents,
  fetchNostrWriteRelays,
  NOSTR_FALLBACK_RELAYS,
} from "./nostr-relay.js";
import {
  parseNostrProfile,
  normaliseNostrThreadNode,
  type RawNostrEvent,
  type NostrProfile,
} from "./nostr-thread.js";
import { persistHydratedThreadNodes } from "./external-hydration.js";
import { CACHE_MAX_ENTRIES } from "./external-items-shared.js";

const HYDRATABLE_PROTOCOLS = new Set(["nostr_external"]);

// Match the thread-hydration budget/caps (external-hydration.ts).
const TIMELINE_RELAY_CAP = 6;
const TIMELINE_REQ_TIMEOUT_MS = 6_000;
const TIMELINE_FETCH_LIMIT = 50;

// Kill switch (§3.7): Part B is the platform's first request-path-triggered
// outbound fetch fan-out — even bounded and backgrounded it deserves an
// operator brake that doesn't need a deploy. Default ON; "0"/"false" disables.
export function authorTimelineHydrationEnabled(): boolean {
  const v = process.env.AUTHOR_TIMELINE_HYDRATION_ENABLED;
  return v !== "0" && v !== "false";
}

// Per-AUTHOR TTL guard — hydrateGuard's shape including its size-capped
// eviction, but 10 minutes rather than 60s: a hot profile hydrates once, not
// per viewer, and a stale cache refreshes on the next view past the TTL.
const timelineGuard = new Map<string, number>();
const TIMELINE_TTL_MS = 10 * 60_000;

// Would a hydrate run right now (kill switch on, protocol supported, guard
// clear)? Lets the /posts handler decide synchronously whether to kick
// background hydration and flag the response `hydrating`.
export function willHydrateAuthorTimeline(
  authorId: string,
  protocol: string,
): boolean {
  if (!authorTimelineHydrationEnabled()) return false;
  if (!HYDRATABLE_PROTOCOLS.has(protocol)) return false;
  const until = timelineGuard.get(authorId);
  return !(until && until > Date.now());
}

// Exposed for tests only — the guard is otherwise stamped by
// hydrateAuthorTimeline itself.
export function resetAuthorTimelineGuard(): void {
  timelineGuard.clear();
}

function stampGuard(authorId: string): void {
  timelineGuard.set(authorId, Date.now() + TIMELINE_TTL_MS);
  if (timelineGuard.size > CACHE_MAX_ENTRIES) {
    const oldest = timelineGuard.keys().next().value;
    if (oldest !== undefined) timelineGuard.delete(oldest);
  }
}

interface Queryable {
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: any[]; rowCount: number | null }>;
}

// §3.2 — where an unfollowed author's rows live. external_items.source_id is
// NOT NULL and an unfollowed author often has no source row, so hydration
// upserts a SHADOW source: is_active = FALSE (the poll scheduler never fetches
// it), keyed on the same (protocol, source_uri) identity the subscribe path
// uses — so a later real subscribe lands on this exact row and reactivates it
// (addSource clears is_active/orphaned_at on both its paths). No
// external_subscriptions row is written: this is a storage anchor, not a
// follow — the feed-derived-subscriptions invariant is untouched. The GC then
// treats it as an orphan (deactivate no-op, 90-day cull) — profile-hydrated
// history is a self-refreshing cache, not an archive.
//
// ON CONFLICT DO NOTHING RETURNING returns no row on conflict, hence the
// two-step. Never touches is_active on an existing row — a real subscribed
// source must not be flipped, and a previously shadowed row stays shadowed.
export async function ensureShadowSource(
  protocol: string,
  sourceUri: string,
  db: Queryable = pool,
): Promise<{ id: string; relay_urls: string[] | null } | null> {
  const ins = await db.query(
    `INSERT INTO external_sources (protocol, source_uri, is_active)
     VALUES ($1::external_protocol, $2, FALSE)
     ON CONFLICT (protocol, source_uri) DO NOTHING
     RETURNING id, relay_urls`,
    [protocol, sourceUri],
  );
  if (ins.rows[0]) return ins.rows[0];
  const sel = await db.query(
    `SELECT id, relay_urls FROM external_sources
      WHERE protocol = $1::external_protocol AND source_uri = $2`,
    [protocol, sourceUri],
  );
  return sel.rows[0] ?? null;
}

export interface AuthorTimelineTarget {
  authorId: string; // external_authors.id — the TTL-guard key
  protocol: string;
  followUri: string; // authorFollowUri(xa) — the subscribe-path identity
}

// ── nostr_external (§3.5 phase 1) ───────────────────────────────────────────

async function hydrateNostrTimeline(target: AuthorTimelineTarget): Promise<void> {
  const pubkey = target.followUri.toLowerCase();
  const source = await ensureShadowSource(target.protocol, target.followUri);
  if (!source) return;
  const hints = source.relay_urls ?? [];

  // NIP-65 write relays ∪ shadow/real source relay_urls ∪ fallbacks, cap 6.
  const writeRelays = await fetchNostrWriteRelays(pubkey, hints);
  const relays = [...new Set([...writeRelays, ...hints, ...NOSTR_FALLBACK_RELAYS])]
    .filter((r) => r.startsWith("ws://") || r.startsWith("wss://"))
    .slice(0, TIMELINE_RELAY_CAP);
  if (relays.length === 0) return;

  // One REQ — a request-path warm, not an archive pull; depth is the backfill
  // task's job (Part A).
  const events = await fetchNostrEvents(
    relays,
    [
      { kinds: [1, 30023], authors: [pubkey], limit: TIMELINE_FETCH_LIMIT },
      { kinds: [0], authors: [pubkey], limit: 1 },
    ],
    TIMELINE_REQ_TIMEOUT_MS,
  );

  // Pubkey match + signature verification. The gateway trusts relays for
  // thread hydration, but an author timeline feeds a profile claiming to BE
  // this author — verification is required here.
  const valid = events.filter(
    (ev) =>
      ev?.pubkey?.toLowerCase() === pubkey &&
      verifyEvent(ev as unknown as Parameters<typeof verifyEvent>[0]),
  );

  let latestProfile: RawNostrEvent | null = null;
  const items: RawNostrEvent[] = [];
  for (const ev of valid) {
    if (ev.kind === 0) {
      if (!latestProfile || ev.created_at > latestProfile.created_at) {
        latestProfile = ev;
      }
    } else if (ev.kind === 1 || ev.kind === 30023) {
      items.push(ev);
    }
  }

  const profile: NostrProfile = latestProfile
    ? parseNostrProfile(latestProfile.content)
    : { name: null, picture: null, nip05: null, about: null, website: null, lud16: null };

  const nodes = items.map((ev) => normaliseNostrThreadNode(ev, relays, profile));
  await persistHydratedThreadNodes(source.id, "nostr_external", nodes, {
    profileHydrated: true,
  });

  // Persist the discovered write relays onto the shadow row (same union/cap
  // rule as the backfill, §2.2) so a later real subscribe inherits a working
  // relay set.
  if (writeRelays.length > 0) {
    const merged = mergeNostrRelayUrls(hints, writeRelays);
    if (merged.length !== hints.length || merged.some((r, i) => r !== hints[i])) {
      await pool.query(
        `UPDATE external_sources SET relay_urls = $2, updated_at = now()
          WHERE id = $1`,
        [source.id, merged],
      );
    }
  }

  logger.debug(
    {
      authorId: target.authorId,
      relays: relays.length,
      nip65Relays: writeRelays.length,
      fetched: events.length,
      persisted: nodes.length,
    },
    "author timeline hydrate complete",
  );
}

// Public entrypoint: best-effort, TTL-guarded hydration of an external
// author's recent timeline. Kicked `void` (never awaited) from the /posts
// handler; never throws.
export async function hydrateAuthorTimeline(
  target: AuthorTimelineTarget,
): Promise<void> {
  if (!willHydrateAuthorTimeline(target.authorId, target.protocol)) return;
  stampGuard(target.authorId);
  try {
    if (target.protocol === "nostr_external") {
      await hydrateNostrTimeline(target);
    }
  } catch (err) {
    logger.debug(
      {
        err: err instanceof Error ? err.message : String(err),
        authorId: target.authorId,
        protocol: target.protocol,
      },
      "Author timeline hydration failed",
    );
  }
}

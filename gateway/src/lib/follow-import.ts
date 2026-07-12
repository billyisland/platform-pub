import { nip19 } from "nostr-tools";
import { pool } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
import { ADVISORY_LOCKS } from "@platform-pub/shared/lib/advisory-locks.js";
import {
  addSource,
  type AddSourceInput,
} from "../routes/feeds/sources.js";
import { getProfile as atprotoGetProfile, getFollows } from "./atproto-resolve.js";
import { fetchNostrContacts } from "./nostr-relay.js";
import { getDefaultProfileRelays } from "./nostr-search.js";

// =============================================================================
// Follow-graph import engine (FOLLOW-GRAPH-IMPORT-ADR §6, §11.3).
//
// "Import my follows from <network>" = create a feed and add each followed
// account as a source, through the same addSource core every interactive add
// uses (D2 — the feed-derived-subscription invariant lives there). The remote
// graph is read ONCE at POST time and persisted on the follow_imports row
// (identities jsonb + cursor), so the sweep is restartable without re-reading
// a graph that may have changed under the run.
//
// The sweep is a gateway scheduler worker (advisory-locked, single-instance,
// same pattern as runDiscoverySweep). It loops batches WITHIN one invocation —
// at one batch per 60s tick a 1000-source import would take ~40 minutes.
//
// Everything ships dark behind the operator master switch
// FOLLOW_IMPORT_ENABLED=1 (house pattern, cf. DISCOVERY_PUBLISH_ENABLED).
// =============================================================================

export function followImportEnabled(): boolean {
  return process.env.FOLLOW_IMPORT_ENABLED === "1";
}

// Per-import cap (§6.5, v1: 1000, most-recently-followed first). Truncation is
// surfaced in the POST response and the run summary — never silent.
export const FOLLOW_IMPORT_CAP = 1000;

// §6.1 — progress-update granularity (NOT lock granularity: addSource takes
// its own short per-call advisory lock inside its own transaction).
const BATCH_SIZE = 25;

// §6.5 — an imported feed above this many sources defaults to sampled volume:
// weight 1.0 = volume step 3 (from the shared VOLUME_WEIGHTS scale) instead of
// the show-everything default 4.0. A 500-source feed at full volume is
// unreadable and would read as a bug.
const VOLUME_SAMPLE_THRESHOLD = 50;
const SAMPLED_WEIGHT = 1.0;

// §6.4b — spacing between consecutive sources' subscribe-time ingest jobs.
// A 500-source import trickles its jobs over ~4 minutes instead of dumping
// 500 immediate fetches on a 10-concurrency worker.
const ENQUEUE_SPACING_MS = 500;

// One resolved followed account, as persisted in follow_imports.identities.
// `uri` is the canonical stored form for the protocol (DID / hex pubkey /
// actor URI / feed URL) — addSource is called with skipProbe, so canonical
// form is this module's obligation (D6 amendment). Display metadata rides
// along because with the probe skipped nothing else backfills labels.
export interface ImportIdentity {
  uri: string;
  displayName?: string;
  avatarUrl?: string;
  relayUrls?: string[];
}

export type ImportProtocol = "atproto" | "nostr_external" | "activitypub" | "rss";

export type FollowGraphResult =
  | {
      ok: true;
      /** Canonical origin identity (handle → DID, npub → hex, …). */
      originIdentity: string;
      /** Human label for the origin (handle etc.), for feed naming/UI. */
      originLabel: string;
      identities: ImportIdentity[];
      /** Remote graph size before the cap (best known). */
      total: number;
      truncated: boolean;
    }
  | {
      ok: false;
      reason: "unsupported" | "malformed" | "unreachable";
      message: string;
    };

// Default name for the minted feed, per origin network.
export function importFeedName(protocol: ImportProtocol): string {
  switch (protocol) {
    case "atproto":
      return "Bluesky follows";
    case "nostr_external":
      return "Nostr follows";
    case "activitypub":
      return "Fediverse follows";
    case "rss":
      return "Imported feeds";
  }
}

// -----------------------------------------------------------------------------
// Graph readers (Phase 1a atproto, 1b Nostr). activitypub is Phase 1c (gated
// on the §6.4 fairness work having soaked); rss/OPML is Phase 1d (file upload,
// different liveness policy) — both refuse here for now.
// -----------------------------------------------------------------------------

export async function readFollowGraph(
  protocol: ImportProtocol,
  originIdentity: string,
): Promise<FollowGraphResult> {
  switch (protocol) {
    case "atproto":
      return readAtprotoGraph(originIdentity.trim());
    case "nostr_external":
      return readNostrGraph(originIdentity.trim());
    default:
      return {
        ok: false,
        reason: "unsupported",
        message: `Importing follows is not yet available for ${protocol}`,
      };
  }
}

// atproto (§5.1): DID or handle → public AppView getFollows, no token. The
// AppView returns most-recently-followed first, so the cap keeps the freshest
// slice for free.
async function readAtprotoGraph(input: string): Promise<FollowGraphResult> {
  const profile = await atprotoGetProfile(input);
  if (!profile) {
    return {
      ok: false,
      reason: "unreachable",
      message: "No account found for this identity on the AT Protocol network",
    };
  }
  const follows = await getFollows(profile.did, FOLLOW_IMPORT_CAP);
  if (follows === null) {
    return {
      ok: false,
      reason: "unreachable",
      message: "Could not read the follow list from the AT Protocol network",
    };
  }
  const identities: ImportIdentity[] = follows.map((f) => ({
    uri: f.did,
    // Handle as the label fallback — a DID-only label is the §V.1 trap.
    displayName: f.displayName || `@${f.handle}`,
    avatarUrl: f.avatar,
  }));
  const total = Math.max(profile.followsCount ?? 0, identities.length);
  return {
    ok: true,
    originIdentity: profile.did,
    originLabel: `@${profile.handle}`,
    identities,
    total,
    truncated: total > identities.length,
  };
}

// Nostr (§5.2): hex / npub / nprofile / NIP-05 → kind-3 contact list from
// relays. p tags are append-ordered oldest-first, so "most recently followed
// first" takes the TAIL under the cap, then reverses. Relay hints seed
// relay_urls metadata only — never the identity (relay-free invariant).
async function readNostrGraph(input: string): Promise<FollowGraphResult> {
  let pubkey: string | null = null;
  let hintRelays: string[] = [];
  let label: string | null = null;

  if (/^[0-9a-f]{64}$/i.test(input)) {
    pubkey = input.toLowerCase();
  } else if (/^n(pub|profile)1/i.test(input)) {
    try {
      const decoded = nip19.decode(input.toLowerCase());
      if (decoded.type === "npub") {
        pubkey = decoded.data;
      } else if (decoded.type === "nprofile") {
        pubkey = decoded.data.pubkey;
        hintRelays = decoded.data.relays ?? [];
      }
    } catch {
      // falls through to malformed
    }
  } else if (input.includes("@")) {
    // NIP-05 (name@domain) — the .well-known/nostr.json lookup.
    const resolved = await resolveNip05Pubkey(input.replace(/^@+/, ""));
    if (resolved === null) {
      return {
        ok: false,
        reason: "unreachable",
        message: `Could not resolve ${input} as a NIP-05 identifier`,
      };
    }
    pubkey = resolved.pubkey;
    hintRelays = resolved.relays;
    label = input.replace(/^@+/, "");
  }

  if (!pubkey) {
    return {
      ok: false,
      reason: "malformed",
      message: "Expected an npub, nprofile, 64-hex pubkey, or NIP-05 address",
    };
  }

  const contacts = await fetchNostrContacts(pubkey, [
    ...hintRelays,
    ...getDefaultProfileRelays(),
  ]);
  if (contacts === null) {
    return {
      ok: false,
      reason: "unreachable",
      message:
        "No contact list (kind 3) found for this key on the queried relays",
    };
  }

  const tail = contacts.slice(-FOLLOW_IMPORT_CAP).reverse();
  const identities: ImportIdentity[] = tail.map((c) => ({
    uri: c.pubkey,
    // No display metadata on kind 3 — labels self-heal via the ingest kind-0
    // fetch within minutes (say so in the summary UI).
    relayUrls: c.relayHint ? [c.relayHint] : undefined,
  }));
  return {
    ok: true,
    originIdentity: pubkey,
    originLabel: label ?? nip19.npubEncode(pubkey),
    identities,
    total: contacts.length,
    truncated: contacts.length > identities.length,
  };
}

async function resolveNip05Pubkey(
  identifier: string,
): Promise<{ pubkey: string; relays: string[] } | null> {
  const [name, domain] = identifier.split("@");
  if (!name || !domain) return null;
  try {
    const res = await safeFetch(
      `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`,
      { timeout: 5000 },
    );
    if (!res.ok) return null;
    const data = JSON.parse(res.text) as {
      names?: Record<string, unknown>;
      relays?: Record<string, unknown>;
    };
    const pubkey = data?.names?.[name];
    if (typeof pubkey !== "string" || !/^[0-9a-f]{64}$/i.test(pubkey))
      return null;
    const relays = data?.relays?.[pubkey.toLowerCase()] ?? data?.relays?.[pubkey];
    return {
      pubkey: pubkey.toLowerCase(),
      relays: Array.isArray(relays)
        ? relays.filter((r): r is string => typeof r === "string")
        : [],
    };
  } catch (err) {
    logger.warn({ identifier, err }, "NIP-05 resolution failed");
    return null;
  }
}

// -----------------------------------------------------------------------------
// The sweep
// -----------------------------------------------------------------------------

interface FollowImportRow {
  id: string;
  account_id: string;
  protocol: ImportProtocol;
  feed_id: string;
  identities: ImportIdentity[];
  cursor: number;
  imported: number;
  skipped: number;
  failed: number;
}

// Process every unfinished run, oldest first, batches looped within this one
// invocation. Single-instance via the FOLLOW_IMPORT advisory lock (taken by
// the caller — index.ts's withAdvisoryLock or kickFollowImportSweep below).
export async function runFollowImportSweep(): Promise<void> {
  if (!followImportEnabled()) return;

  for (;;) {
    // Claim the oldest unfinished run. 'running' rows are claimed too — a
    // gateway restart mid-run leaves one behind, and cursor/counters make
    // resuming it deterministic (§6.2).
    const { rows } = await pool.query<FollowImportRow>(
      `UPDATE follow_imports
          SET status = 'running'
        WHERE id = (SELECT id FROM follow_imports
                     WHERE status IN ('pending', 'running')
                     ORDER BY created_at ASC, id ASC
                     LIMIT 1)
        RETURNING id, account_id, protocol, feed_id, identities, cursor,
                  imported, skipped, failed`,
    );
    if (rows.length === 0) return;
    const run = rows[0];
    try {
      await processRun(run);
    } catch (err) {
      logger.error({ err, importId: run.id }, "follow import run failed");
      await pool
        .query(
          `UPDATE follow_imports
              SET status = 'failed', error = $2, finished_at = now()
            WHERE id = $1`,
          [run.id, err instanceof Error ? err.message : String(err)],
        )
        .catch((e) =>
          logger.error(
            { err: e, importId: run.id },
            "failed to mark follow import failed",
          ),
        );
    }
  }
}

async function processRun(run: FollowImportRow): Promise<void> {
  const identities = Array.isArray(run.identities) ? run.identities : [];
  let { cursor, imported, skipped, failed } = run;

  while (cursor < identities.length) {
    const batch = identities.slice(cursor, cursor + BATCH_SIZE);
    const mintedSourceIds: string[] = [];
    for (const [i, identity] of batch.entries()) {
      const input: AddSourceInput = {
        sourceType: "external_source",
        protocol: run.protocol,
        sourceUri: identity.uri,
        displayName: identity.displayName,
        avatarUrl: identity.avatarUrl,
        relayUrls: identity.relayUrls,
      };
      try {
        const result = await addSource(run.feed_id, run.account_id, input, {
          // D6: graph membership is liveness evidence; identities were
          // canonicalised at graph-read time. The poller's failure handling
          // marks any stragglers dead.
          skipProbe: true,
          // §6.4b: trickle the subscribe-time ingest jobs instead of dumping
          // N immediate fetches on the worker.
          enqueueRunAt: new Date(
            Date.now() + (i + 1) * ENQUEUE_SPACING_MS +
              Math.floor(Math.random() * ENQUEUE_SPACING_MS),
          ),
        });
        imported++;
        if (result.ensured) mintedSourceIds.push(result.ensured.externalSourceId);
      } catch (err) {
        if ((err as { code?: string } | null)?.code === "DUPLICATE") {
          // Already on the feed (idempotent re-import / overlapping runs).
          skipped++;
        } else {
          // Individual failures never fail the run (§6.2) — count + log.
          failed++;
          logger.warn(
            { err, importId: run.id, uri: identity.uri },
            "follow import: addSource failed",
          );
        }
      }
    }
    cursor += batch.length;

    // §6.4a(2): stagger the poll scheduler's first-due times for freshly
    // minted sources — a synthetic last_fetched_at lands first polls uniformly
    // across one fetch interval instead of all-due-now NULLs monopolising the
    // selection window. Only rows never fetched (a shared source another user
    // already polls keeps its real timestamp).
    if (mintedSourceIds.length > 0) {
      await pool.query(
        `UPDATE external_sources
            SET last_fetched_at = now()
                + (floor(random() * fetch_interval_seconds) || ' seconds')::interval
                - (fetch_interval_seconds || ' seconds')::interval
          WHERE id = ANY($1::uuid[]) AND last_fetched_at IS NULL`,
        [mintedSourceIds],
      );
    }

    const { rowCount } = await pool.query(
      `UPDATE follow_imports
          SET imported = $2, skipped = $3, failed = $4, cursor = $5
        WHERE id = $1`,
      [run.id, imported, skipped, failed, cursor],
    );
    // The feed (and, by cascade, this run row) was deleted mid-run — stop.
    // addSource failures from the missing feed were counted above; nothing
    // else to persist.
    if (rowCount === 0) return;
  }

  // Completion. Volume default first (§6.5): above the threshold the feed
  // defaults to sampled volume — a post-import bulk UPDATE, guarded to rows
  // still at the 4.0 default so a re-run never clobbers user tuning.
  if (identities.length > VOLUME_SAMPLE_THRESHOLD) {
    await pool.query(
      `UPDATE feed_sources
          SET weight = $2
        WHERE feed_id = $1 AND source_type = 'external_source'
          AND weight = 4.0`,
      [run.feed_id, SAMPLED_WEIGHT],
    );
  }
  // The snapshot IS a sync — stamp the binding so "Sync now" (Phase 2) has a
  // baseline even before it ships.
  await pool.query(
    `UPDATE feed_import_bindings SET last_synced_at = now() WHERE feed_id = $1`,
    [run.feed_id],
  );
  await pool.query(
    `UPDATE follow_imports SET status = 'done', finished_at = now()
      WHERE id = $1`,
    [run.id],
  );
  logger.info(
    { importId: run.id, feedId: run.feed_id, imported, skipped, failed },
    "follow import completed",
  );
}

// Fire the sweep immediately (best-effort) after POST /follow-imports creates
// a run, instead of waiting up to 60s for the scheduler tick. Same try-lock
// discipline as index.ts's withAdvisoryLock — if the scheduler (or another
// kick) holds the lock, skip; the pending row is picked up by the running
// sweep's claim loop or the next tick.
export async function kickFollowImportSweep(): Promise<void> {
  if (!followImportEnabled()) return;
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [ADVISORY_LOCKS.FOLLOW_IMPORT],
    );
    if (!rows[0].locked) return;
    try {
      await runFollowImportSweep();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [
        ADVISORY_LOCKS.FOLLOW_IMPORT,
      ]);
    }
  } finally {
    client.release();
  }
}

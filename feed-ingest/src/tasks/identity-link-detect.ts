import type { Task } from "graphile-worker";
import { nip19 } from "nostr-tools";
import { getDomain } from "tldts";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";

// =============================================================================
// identity_link_detect — Slice 8 P3: automated cross-source identity detection.
//
// Writes GLOBAL identity links (owner_id NULL) that the feed-dedup CTEs consume
// to collapse cross-posted duplicates for every reader. Objective + re-verifiable
// signals only, computed from metadata ALREADY in the DB (no remote fetch, no
// SSRF surface — SLICE-8 decision "stored metadata only").
//
// Shipped signal — DOMAIN MATCH (link_type 'domain_match', confidence 0.6):
//   Two distinct external sources that assert ownership of the same *custom*
//   domain are the same identity cross-posting. A source's owned domains come
//   from: its RSS feed host; its author's `website` host; and an atproto custom
//   handle host. Self-healing: each run fully recomputes the global domain_match
//   set in one transaction (DELETE + re-INSERT), so stale links heal when
//   metadata changes; owner-scoped tombstones (`user_unlinked`) match on the
//   pair, not the link row, so they survive the recompute.
//
//   False-positive guard (this is content suppression — correctness is the whole
//   game): an explicit denylist of shared platform domains, PLUS a count guard —
//   any domain claimed by more than MAX_SOURCES_PER_DOMAIN sources is treated as
//   a platform (e.g. an instance host we didn't denylist) and dropped. So only a
//   domain owned by a small number of sources can ever link them.
//
// Shipped signal — BRIDGE (link_type 'bridge', confidence 0.95): a protocol
// bridge mirrors one identity onto another network, and the bridged mirror
// EMBEDS the original identity, so the mirror and the native original are the
// same person. All three signals are read straight off the stored identity
// string — no remote fetch:
//   • Bridgy Fed, Bluesky→fediverse: the AP mirror's actor URL is
//     https://bsky.brid.gy/ap/<original DID> → link to the native atproto source
//     whose source_uri IS that DID.
//   • mostr.pub, Nostr→fediverse: the AP mirror's actor URL embeds the original
//     npub → decode to hex → link to the native nostr_external source.
//   • Bridgy Fed, fediverse→Bluesky: the atproto mirror's handle is
//     <user>.<instance>.ap.brid.gy → reconstruct <user>@<instance> → link to the
//     native activitypub source with that handle.
// Each match keys on a globally-unique original identifier (DID / hex / acct);
// a pair links only when ≥1 endpoint is a bridge mirror, so two natives can't
// link via this path. Self-healing full recompute, same as domain_match.
//
// Deferred signal (the link_type vocab already carries it): 'cross_link'
// (bidirectional profile references parsed from bios — needs cached bio metadata).
// It is just another detector writing its own link_type with its own recompute.
//
// Ships dark behind IDENTITY_LINK_DETECT_ENABLED (feed-ingest only schedules the
// cron when on). Spec: SLICE-8-IDENTITY-LINKING-PLAN.md §P3.
// =============================================================================

// A domain owned by more than this many sources is a shared platform, not a
// personal domain — never link on it. Conservative: a real person's domain backs
// a handful of their own surfaces (site + RSS + a Mastodon on it), not dozens.
export const MAX_SOURCES_PER_DOMAIN = 4;

// Known shared platform domains — links must never form on these. The count
// guard catches the long tail; this short list catches the obvious giants fast
// (and small instances that happen to host ≤ MAX sources we follow).
const PLATFORM_DOMAINS = new Set([
  "bsky.social",
  "bsky.app",
  "mastodon.social",
  "mastodon.online",
  "mas.to",
  "fosstodon.org",
  "hachyderm.io",
  "threads.net",
  "substack.com",
  "medium.com",
  "wordpress.com",
  "blogspot.com",
  "tumblr.com",
  "github.io",
  "gitlab.io",
  "pages.dev",
  "netlify.app",
  "vercel.app",
  "nostr.com",
  "njump.me",
  "brid.gy",
  "web.brid.gy",
  "ap.brid.gy",
  "bsky.brid.gy",
  "mostr.pub",
]);

/**
 * The registrable domain of a host (eTLD+1), lower-cased — the part below the
 * public suffix. Returns null for an IP / single label / public-suffix-only /
 * empty input.
 *
 * Backed by the full Public Suffix List via `tldts` rather than a hand-curated
 * multi-label-suffix set: the curated set silently mis-derived any ccTLD it
 * missed (e.g. `alice.co.id` → `co.id`, the *public suffix itself*, which every
 * `*.co.id` source shares), so two unrelated sources could falsely link up to the
 * `MAX_SOURCES_PER_DOMAIN` count guard. The PSL collapses that class entirely:
 * `alice.co.id` → `alice.co.id`, distinct from `bob.co.id`. ICANN-only
 * (`allowPrivateDomains:false`, the default made explicit) so private-section
 * suffixes (`pages.dev`, `github.io`, …) still resolve to the two-label platform
 * domain the `PLATFORM_DOMAINS` denylist expects — no denylist regression. tldts
 * also strips `www.`/subdomains and rejects IPs and single labels (→ null).
 */
export function registrableDomain(host: string | null | undefined): string | null {
  if (!host) return null;
  const h = host.trim().toLowerCase();
  if (!h) return null;
  return getDomain(h, { allowPrivateDomains: false }) || null;
}

/** Parse a host out of a URL or a bare host string; null if unparseable. */
function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;
  try {
    return new URL(v.includes("://") ? v : `https://${v}`).hostname || null;
  } catch {
    return null;
  }
}

export interface DetectSourceRow {
  source_id: string;
  protocol: string;
  source_uri: string;
  website: string | null;
  handle: string | null;
}

/**
 * The custom (non-platform) registrable domains a source claims to own. Pure —
 * unit-tested without a DB. Returns a deduped, denylist-filtered set.
 */
export function ownedDomains(row: DetectSourceRow): string[] {
  const domains = new Set<string>();
  const add = (host: string | null) => {
    const d = registrableDomain(host);
    if (d && !PLATFORM_DOMAINS.has(d)) domains.add(d);
  };

  // The author's stated website — the strongest ownership claim, any protocol.
  add(hostOf(row.website));

  switch (row.protocol) {
    case "rss":
      // The feed lives on the owner's own host.
      add(hostOf(row.source_uri));
      break;
    case "atproto":
      // A custom handle (alice.example.com) is a domain the user proved control
      // of via DNS/well-known. *.bsky.social handles resolve to the platform
      // domain and are dropped by the denylist.
      add(hostOf(row.handle));
      break;
    // activitypub instance hosts and nostr pubkeys are shared / not domains;
    // their website (added above) is the only ownership signal we trust.
  }

  return [...domains];
}

/**
 * Group sources by owned domain, drop platform/shared domains (count guard),
 * and emit the ordered source-id pairs to link. Pure — unit-tested.
 */
export function domainMatchPairs(
  rows: DetectSourceRow[],
  maxPerDomain = MAX_SOURCES_PER_DOMAIN,
): Array<[string, string]> {
  const byDomain = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const d of ownedDomains(row)) {
      let set = byDomain.get(d);
      if (!set) byDomain.set(d, (set = new Set()));
      set.add(row.source_id);
    }
  }

  const pairs: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const [, sourceSet] of byDomain) {
    if (sourceSet.size < 2 || sourceSet.size > maxPerDomain) continue;
    const ids = [...sourceSet];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        // Order the pair so it matches the table's source_a_id < source_b_id
        // CHECK, and dedupe pairs claimed via more than one shared domain.
        const [a, b] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
        const key = `${a}|${b}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push([a, b]);
      }
    }
  }
  return pairs;
}

// =============================================================================
// Bridge detection (link_type 'bridge', confidence 0.95)
// =============================================================================

// Bridge actor hosts (exact hostname, not registrable domain — the subdomain
// carries the meaning: bsky.brid.gy ≠ ap.brid.gy).
const BRIDGE_HOST_BSKY = "bsky.brid.gy"; // Bluesky→fediverse mirror (an AP source)
const BRIDGE_HOST_MOSTR = "mostr.pub"; // Nostr→fediverse mirror (an AP source)
const BRIDGE_SUFFIX_AP = ".ap.brid.gy"; // fediverse→Bluesky mirror (an atproto handle)

const BRIDGE_CONFIDENCE = 0.95;

/** npub → 64-char hex pubkey via NIP-19; null if not a valid npub. Pure. */
export function npubToHex(npub: string): string | null {
  try {
    const decoded = nip19.decode(npub.trim());
    return decoded.type === "npub" ? decoded.data : null;
  } catch {
    return null;
  }
}

/** First `did:plc:`/`did:web:` substring of a string, lower-cased; null if none. */
function extractDid(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = value.match(/did:(?:plc|web):[a-zA-Z0-9._:%-]+/);
  return m ? m[0].toLowerCase() : null;
}

/** First bech32 `npub1…` substring of a string; null if none. */
function extractNpub(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = value.match(/npub1[023456789acdefghjklmnpqrstuvwxyz]+/);
  return m ? m[0] : null;
}

/**
 * Decode a Bridgy Fed fediverse→Bluesky handle (`<user>.<instance>.ap.brid.gy`)
 * back to the original fediverse acct (`user@instance`), lower-cased. Returns
 * null when the handle isn't a Bridgy AP handle or can't be split into a
 * user + a host (the instance part must itself look like a domain). Pure.
 */
export function decodeApBridgeHandle(handle: string | null | undefined): string | null {
  if (!handle) return null;
  const h = handle.trim().toLowerCase();
  if (!h.endsWith(BRIDGE_SUFFIX_AP)) return null;
  const inner = h.slice(0, -BRIDGE_SUFFIX_AP.length); // user.instance.tld
  const dot = inner.indexOf(".");
  if (dot <= 0) return null;
  const user = inner.slice(0, dot);
  const instance = inner.slice(dot + 1);
  if (!user || !instance.includes(".")) return null; // instance must be a host
  return `${user}@${instance}`;
}

/** A source is a bridge mirror when its identity string lives on a bridge host. */
function isBridgeMirror(row: DetectSourceRow): boolean {
  if (row.protocol === "activitypub") {
    const host = hostOf(row.source_uri)?.toLowerCase() ?? null;
    return host === BRIDGE_HOST_BSKY || host === BRIDGE_HOST_MOSTR;
  }
  if (row.protocol === "atproto") {
    return (row.handle ?? "").trim().toLowerCase().endsWith(BRIDGE_SUFFIX_AP);
  }
  return false;
}

/**
 * The decoded ORIGINAL identity key(s) a bridge mirror points at, in the
 * native key-space of the bridged-from network (so they collide with that
 * network's `nativeIdentityKey`). Empty for a non-mirror. Pure.
 */
export function bridgeIdentityKeys(row: DetectSourceRow): string[] {
  const keys: string[] = [];
  if (row.protocol === "activitypub") {
    const host = hostOf(row.source_uri)?.toLowerCase() ?? null;
    if (host === BRIDGE_HOST_BSKY) {
      const did = extractDid(row.source_uri);
      if (did) keys.push(`atproto:${did}`);
    } else if (host === BRIDGE_HOST_MOSTR) {
      const npub = extractNpub(row.source_uri);
      const hex = npub ? npubToHex(npub) : null;
      if (hex) keys.push(`nostr:${hex}`);
    }
  } else if (row.protocol === "atproto") {
    const acct = decodeApBridgeHandle(row.handle);
    if (acct) keys.push(`ap:${acct}`);
  }
  return keys;
}

/** The canonical identity key a NATIVE (non-mirror) source owns. Pure. */
function nativeIdentityKey(row: DetectSourceRow): string | null {
  switch (row.protocol) {
    case "atproto":
      return `atproto:${row.source_uri.trim().toLowerCase()}`; // a DID
    case "nostr_external":
      return `nostr:${row.source_uri.trim().toLowerCase()}`; // a hex pubkey
    case "activitypub":
      return row.handle ? `ap:${row.handle.trim().toLowerCase()}` : null; // user@instance
    default:
      return null; // rss/email — never a bridge endpoint
  }
}

/**
 * Group sources by identity key — a bridge mirror contributes its decoded
 * original key(s), a native its own key — and emit the ordered source-id pairs
 * to link. A pair links only when ≥1 endpoint is a bridge mirror, so two
 * unrelated natives that happen to share a key never link. Pure — unit-tested.
 */
export function bridgeMatchPairs(rows: DetectSourceRow[]): Array<[string, string]> {
  interface Emit {
    sourceId: string;
    key: string;
    isBridge: boolean;
  }
  const emits: Emit[] = [];
  for (const row of rows) {
    const decoded = bridgeIdentityKeys(row);
    if (decoded.length) {
      for (const key of decoded) emits.push({ sourceId: row.source_id, key, isBridge: true });
    } else if (!isBridgeMirror(row)) {
      // A bridge mirror whose identity failed to decode contributes nothing —
      // never fall back to its (bridge-host) native key.
      const key = nativeIdentityKey(row);
      if (key) emits.push({ sourceId: row.source_id, key, isBridge: false });
    }
  }

  const byKey = new Map<string, Emit[]>();
  for (const e of emits) {
    let arr = byKey.get(e.key);
    if (!arr) byKey.set(e.key, (arr = []));
    arr.push(e);
  }

  const pairs: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const [, group] of byKey) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (a.sourceId === b.sourceId) continue; // same source via two keys
        if (!a.isBridge && !b.isBridge) continue; // need a bridge endpoint
        const [x, y] = a.sourceId < b.sourceId ? [a.sourceId, b.sourceId] : [b.sourceId, a.sourceId];
        const k = `${x}|${y}`;
        if (seen.has(k)) continue;
        seen.add(k);
        pairs.push([x, y]);
      }
    }
  }
  return pairs;
}

export const identityLinkDetect: Task = async (_payload, _helpers) => {
  // Pull every source plus (when tier A/B) its author's website + handle. The
  // author maps to the source on (protocol, source_uri = the author's stable
  // handle), the same mapping loadAuthorLinkSource uses.
  const { rows } = await pool.query<DetectSourceRow>(
    `SELECT es.id AS source_id, es.protocol::text AS protocol, es.source_uri,
            xa.website, xa.handle
       FROM external_sources es
       LEFT JOIN external_authors xa
         ON xa.protocol = es.protocol AND xa.stable_handle = es.source_uri`,
  );

  const domainPairs = domainMatchPairs(rows);
  const bridgePairs = bridgeMatchPairs(rows);

  // Self-healing full recompute in one transaction: replace the global automated
  // sets wholesale so stale links (metadata changed) heal. Tombstones
  // (user_unlinked) live in separate rows keyed on the pair, so they survive.
  //
  // uq_idlink_global is unique on the PAIR alone (one global link per pair, any
  // link_type), so a pair claimed by both detectors keeps just one row. Insert
  // bridge (0.95) BEFORE domain_match (0.6) so the higher-confidence, more
  // specific signal wins the conflict.
  const inserted = await withTransaction(async (client) => {
    await client.query(
      `DELETE FROM external_identity_links
        WHERE link_type IN ('bridge', 'domain_match') AND owner_id IS NULL`,
    );
    const insertGlobal = async (
      candidatePairs: Array<[string, string]>,
      linkType: string,
      confidence: number,
    ): Promise<number> => {
      let n = 0;
      for (const [a, b] of candidatePairs) {
        const { rowCount } = await client.query(
          `INSERT INTO external_identity_links
             (source_a_id, source_b_id, link_type, confidence, owner_id)
           VALUES ($1, $2, $3, $4, NULL)
           ON CONFLICT (source_a_id, source_b_id) WHERE owner_id IS NULL
             DO NOTHING`,
          [a, b, linkType, confidence],
        );
        n += rowCount ?? 0;
      }
      return n;
    };
    const bridge = await insertGlobal(bridgePairs, "bridge", BRIDGE_CONFIDENCE);
    const domainMatch = await insertGlobal(domainPairs, "domain_match", 0.6);
    return { bridge, domainMatch };
  });

  logger.info(
    {
      sources: rows.length,
      bridgePairs: bridgePairs.length,
      domainPairs: domainPairs.length,
      inserted,
    },
    "identity_link_detect",
  );
};

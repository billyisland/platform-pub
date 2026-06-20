import type { Task } from "graphile-worker";
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
// Deferred signals (the link_type vocab already carries them): 'cross_link'
// (bidirectional profile references) and 'bridge' (Bridgy-style bridged actors).
// Each is just another detector writing its own link_type with its own recompute.
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
]);

// Multi-part public suffixes where the registrable domain is the last THREE
// labels (e.g. example.co.uk), not two. Small curated set — the count guard
// backstops anything missed. Not a full Public Suffix List by design (heavy).
const THREE_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "me.uk", "ac.uk", "gov.uk",
  "com.au", "net.au", "org.au",
  "co.nz", "co.za", "co.jp", "com.br", "co.in",
]);

/**
 * The registrable domain of a host, lower-cased: the last two labels, or the
 * last three for a known multi-part suffix. Returns null for an IP / single
 * label / empty input.
 */
export function registrableDomain(host: string | null | undefined): string | null {
  if (!host) return null;
  let h = host.trim().toLowerCase();
  if (!h) return null;
  // Strip a leading "www.".
  h = h.replace(/^www\./, "");
  // Bare IPv4 (and obvious non-domains) → not a registrable domain.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return null;
  const labels = h.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join(".");
  if (THREE_LABEL_SUFFIXES.has(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }
  return lastTwo;
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

  const pairs = domainMatchPairs(rows);

  // Self-healing full recompute in one transaction: replace the global
  // domain_match set wholesale so stale links (metadata changed) heal. Tombstones
  // (user_unlinked) live in separate rows keyed on the pair, so they survive.
  const inserted = await withTransaction(async (client) => {
    await client.query(
      `DELETE FROM external_identity_links
        WHERE link_type = 'domain_match' AND owner_id IS NULL`,
    );
    let n = 0;
    for (const [a, b] of pairs) {
      const { rowCount } = await client.query(
        `INSERT INTO external_identity_links
           (source_a_id, source_b_id, link_type, confidence, owner_id)
         VALUES ($1, $2, 'domain_match', 0.6, NULL)
         ON CONFLICT (source_a_id, source_b_id) WHERE owner_id IS NULL
           DO NOTHING`,
        [a, b],
      );
      n += rowCount ?? 0;
    }
    return n;
  });

  logger.info(
    { sources: rows.length, candidatePairs: pairs.length, inserted },
    "identity_link_detect",
  );
};

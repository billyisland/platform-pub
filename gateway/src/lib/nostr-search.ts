import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { pinnedWebSocketOptions } from "@platform-pub/shared/lib/http-client.js";
import logger from "@platform-pub/shared/lib/logger.js";

// =============================================================================
// Nostr relay lookups for the universal resolver, extracted from resolver.ts
// (RESOLVER-DISCOVERY-ADR Phase 0 / CONSOLIDATED-TODO §8.5 decomposition).
//
// - fetchNostrProfile: kind-0 metadata for one pubkey (Phase B enrichment of
//   npub/nprofile/hex matches).
// - searchNostrProfiles: NIP-50 full-text name search against a search relay
//   (discovery fallback branch 2, UNIVERSAL-FEED-ADR §V.5.8).
//
// Both are fail-soft: any relay/socket problem resolves to null/[] — the
// resolver treats these as candidate pools, never as required chains.
// =============================================================================

const HEX_64 = /^[0-9a-f]{64}$/i;

const NOSTR_PROFILE_TIMEOUT_MS = 4_000;
const DEFAULT_NOSTR_PROFILE_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.nostr.band",
  "wss://nos.lol",
];

export interface NostrProfile {
  displayName?: string;
  about?: string;
  picture?: string;
}

function getDefaultProfileRelays(): string[] {
  const env = process.env.NOSTR_PROFILE_RELAYS;
  if (!env) return DEFAULT_NOSTR_PROFILE_RELAYS;
  return env
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Parse a kind-0 metadata event's JSON content into the fields we surface.
// Shared by single-profile enrichment (fetchNostrProfile) and name search
// (searchNostrProfiles). Returns null on malformed JSON.
export function parseNostrProfileContent(content: string): NostrProfile | null {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return {
      displayName:
        typeof parsed.display_name === "string" && parsed.display_name
          ? parsed.display_name
          : typeof parsed.name === "string"
            ? parsed.name
            : undefined,
      about: typeof parsed.about === "string" ? parsed.about : undefined,
      picture: typeof parsed.picture === "string" ? parsed.picture : undefined,
    };
  } catch {
    return null;
  }
}

export async function fetchNostrProfile(
  pubkey: string,
  relayHints?: string[],
): Promise<NostrProfile | null> {
  if (!HEX_64.test(pubkey)) return null;
  const relays =
    relayHints && relayHints.length > 0
      ? relayHints
      : getDefaultProfileRelays();
  // Race relays — first successful kind-0 wins. Newest createdAt as tiebreaker.
  const results = await Promise.allSettled(
    relays.map((relayUrl) => fetchKind0FromRelay(relayUrl, pubkey)),
  );

  let best: { event: { content: string; created_at: number } } | null = null;
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      if (!best || r.value.created_at > best.event.created_at) {
        best = { event: r.value };
      }
    }
  }
  if (!best) return null;
  return parseNostrProfileContent(best.event.content);
}

// =============================================================================
// Nostr name search (NIP-50) — discovery fallback branch 2 (§V.5.8)
//
// Opens a temporary WebSocket to a search relay and runs a NIP-50 full-text
// query (`{ kinds: [0], search }`) for profiles matching a bare name. Returns
// candidate pubkeys with their kind-0 metadata. Mirrors fetchKind0FromRelay's
// connection lifecycle; the only difference is the search filter and that we
// collect multiple results (newest kind-0 per pubkey wins).
// =============================================================================

const NOSTR_SEARCH_TIMEOUT_MS = 4_000;
const DEFAULT_NOSTR_SEARCH_RELAY = "wss://relay.nostr.band";

export interface NostrCandidate {
  pubkey: string;
  displayName?: string;
  about?: string;
  picture?: string;
  /** Raw kind-0 event tags (RESOLVER-DISCOVERY-ADR §6.1): a `["proxy",
   *  <origin-id>, <protocol>]` tag (NIP-48) marks a bridged mirror whose
   *  origin key joins the merge step's bridge-collision set. */
  tags?: string[][];
}

function getNostrSearchRelay(): string {
  return (
    process.env.NOSTR_SEARCH_RELAY ?? DEFAULT_NOSTR_SEARCH_RELAY
  ).trim();
}

export async function searchNostrProfiles(
  query: string,
  limit = 5,
): Promise<NostrCandidate[]> {
  const q = query.trim();
  if (!q) return [];

  const relayUrl = getNostrSearchRelay();
  let wsOpts;
  try {
    wsOpts = await pinnedWebSocketOptions(relayUrl);
  } catch (err) {
    logger.warn(
      { relayUrl, err },
      "Nostr search relay rejected by SSRF guard",
    );
    return [];
  }

  return new Promise((resolve) => {
    const ws = new WebSocket(relayUrl, wsOpts);
    const subId = `resolver-search-${randomUUID()}`;
    // Newest kind-0 per pubkey wins, so a relay returning stale + fresh
    // metadata for the same author collapses to one candidate.
    const collected = new Map<
      string,
      { content: string; created_at: number; tags?: string[][] }
    >();
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        ws.send(JSON.stringify(["CLOSE", subId]));
      } catch {}
      try {
        ws.close();
      } catch {}
      const out: NostrCandidate[] = [];
      for (const [pubkey, ev] of collected) {
        const profile = parseNostrProfileContent(ev.content);
        out.push({
          pubkey,
          displayName: profile?.displayName,
          about: profile?.about,
          picture: profile?.picture,
          tags: ev.tags,
        });
        if (out.length >= limit) break;
      }
      resolve(out);
    };

    const timeout = setTimeout(finish, NOSTR_SEARCH_TIMEOUT_MS);

    ws.on("open", () => {
      ws.send(
        JSON.stringify(["REQ", subId, { kinds: [0], search: q, limit }]),
      );
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg[0] === "EVENT" && msg[1] === subId) {
          const event = msg[2];
          if (
            event &&
            typeof event.content === "string" &&
            typeof event.created_at === "number" &&
            typeof event.pubkey === "string" &&
            HEX_64.test(event.pubkey)
          ) {
            const prev = collected.get(event.pubkey);
            if (!prev || event.created_at > prev.created_at) {
              collected.set(event.pubkey, {
                content: event.content,
                created_at: event.created_at,
                tags:
                  Array.isArray(event.tags) &&
                  event.tags.every((t: unknown) => Array.isArray(t))
                    ? (event.tags as string[][])
                    : undefined,
              });
            }
          }
        } else if (msg[0] === "EOSE" && msg[1] === subId) {
          clearTimeout(timeout);
          finish();
        }
      } catch {
        // ignore parse errors
      }
    });

    ws.on("error", () => {
      clearTimeout(timeout);
      finish();
    });

    ws.on("close", () => {
      clearTimeout(timeout);
      finish();
    });
  });
}

function fetchKind0FromRelay(
  relayUrl: string,
  pubkey: string,
): Promise<{ content: string; created_at: number } | null> {
  return new Promise(async (resolve) => {
    let wsOpts;
    try {
      wsOpts = await pinnedWebSocketOptions(relayUrl);
    } catch (err) {
      logger.warn(
        { relayUrl, err },
        "Nostr profile relay rejected by SSRF guard",
      );
      resolve(null);
      return;
    }

    const ws = new WebSocket(relayUrl, wsOpts);
    const subId = `resolver-profile-${randomUUID()}`;
    let latest: { content: string; created_at: number } | null = null;
    let settled = false;
    const finish = (value: { content: string; created_at: number } | null) => {
      if (settled) return;
      settled = true;
      try {
        ws.send(JSON.stringify(["CLOSE", subId]));
      } catch {}
      try {
        ws.close();
      } catch {}
      resolve(value);
    };

    const timeout = setTimeout(() => finish(latest), NOSTR_PROFILE_TIMEOUT_MS);

    ws.on("open", () => {
      ws.send(
        JSON.stringify([
          "REQ",
          subId,
          { kinds: [0], authors: [pubkey], limit: 1 },
        ]),
      );
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg[0] === "EVENT" && msg[1] === subId) {
          const event = msg[2];
          if (
            event &&
            typeof event.content === "string" &&
            typeof event.created_at === "number" &&
            event.pubkey === pubkey
          ) {
            if (!latest || event.created_at > latest.created_at) {
              latest = { content: event.content, created_at: event.created_at };
            }
          }
        } else if (msg[0] === "EOSE" && msg[1] === subId) {
          clearTimeout(timeout);
          finish(latest);
        }
      } catch {
        // ignore parse errors
      }
    });

    ws.on("error", () => {
      clearTimeout(timeout);
      finish(null);
    });

    ws.on("close", () => {
      clearTimeout(timeout);
      finish(latest);
    });
  });
}

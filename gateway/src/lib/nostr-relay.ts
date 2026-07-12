// Read-only Nostr relay access for the gateway request path. The low-level REQ
// runner (fetchNostrEvents) and the high-coverage fallback relay set were lifted
// out of routes/external-items.ts so both thread hydration AND the author hover
// bio (routes/author.ts) can reuse one implementation instead of duplicating the
// WebSocket REQ dance. All sockets are pinned via the SSRF-hardened helper.
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  pinnedWebSocketOptions,
  type PinnedWebSocketOptions,
} from "@platform-pub/shared/lib/http-client.js";
import { parseNostrProfile, type RawNostrEvent, type NostrProfile } from "./nostr-thread.js";
import { pickNostrWriteRelays } from "@platform-pub/shared/lib/nip65.js";

// High-coverage public relays/aggregators, merged in *behind* a post's or
// source's own relay hints (which are often just 1–2 relays that no longer carry
// the whole thread / a current profile). relay.nostr.band is a broad indexer;
// the rest are large general relays.
export const NOSTR_FALLBACK_RELAYS = [
  "wss://relay.nostr.band",
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
];

// Open one REQ against each relay (in parallel), collect EVENTs until EOSE or a
// short timeout, dedupe by event id. Mirrors feed-ingest's fetchFromRelay but
// takes arbitrary filters and runs read-only in the gateway request path.
export async function fetchNostrEvents(
  relays: string[],
  filters: Record<string, unknown>[],
  timeoutMs: number,
): Promise<RawNostrEvent[]> {
  const byId = new Map<string, RawNostrEvent>();
  await Promise.all(
    relays.map(async (relayUrl) => {
      let wsOpts: PinnedWebSocketOptions;
      try {
        wsOpts = await pinnedWebSocketOptions(relayUrl);
      } catch {
        return; // unresolvable / blocked host — skip this relay
      }
      await new Promise<void>((resolve) => {
        let settled = false;
        const ws = new WebSocket(relayUrl, wsOpts);
        const subId = `gw-${randomUUID()}`;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(["CLOSE", subId]));
            }
          } catch {
            /* draining */
          }
          try {
            ws.close();
          } catch {
            /* already closed */
          }
          resolve();
        };
        const timer = setTimeout(done, timeoutMs);
        ws.on("open", () => {
          try {
            ws.send(JSON.stringify(["REQ", subId, ...filters]));
          } catch {
            done();
          }
        });
        ws.on("message", (raw) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg[0] === "EVENT" && msg[1] === subId) {
              const ev = msg[2] as RawNostrEvent;
              if (ev?.id && !byId.has(ev.id)) byId.set(ev.id, ev);
            } else if (msg[0] === "EOSE" && msg[1] === subId) {
              done();
            }
          } catch {
            /* ignore parse errors */
          }
        });
        ws.on("error", done);
        ws.on("close", done);
      });
    }),
  );
  return [...byId.values()];
}

const NOSTR_PROFILE_RELAY_CAP = 6;
const NOSTR_PROFILE_REQ_TIMEOUT_MS = 5_000;
const NIP65_REQ_TIMEOUT_MS = 6_000;
const CONTACTS_REQ_TIMEOUT_MS = 8_000;

// One followed account from a kind-3 contact list. The relay hint is
// connection metadata ONLY — it may seed external_sources.relay_urls but must
// never enter the source identity (relay-free Nostr identity invariant).
export interface NostrContact {
  pubkey: string; // 64-hex, lowercase — the canonical source identity
  relayHint?: string;
}

// Fetch an author's kind-3 contact list (FOLLOW-GRAPH-IMPORT-ADR §5.2).
// Every reachable relay's answer is collected and the newest event wins
// (replaceable-event semantics across a fallback-relay race). Returns the
// deduped contacts in the list's own append order — kind-3 `p` tags are
// append-ordered oldest-first, so callers wanting "most recently followed
// first" take the TAIL and reverse. A duplicate pubkey keeps its LAST
// occurrence (the more recent follow). Returns null when no kind 3 is
// reachable at all — distinct from a reachable-but-empty list ([]).
export async function fetchNostrContacts(
  pubkey: string,
  hintRelays: string[] = [],
): Promise<NostrContact[] | null> {
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) return null;
  const relays = [...new Set([...hintRelays, ...NOSTR_FALLBACK_RELAYS])]
    .filter((r) => r.startsWith("ws://") || r.startsWith("wss://"))
    .slice(0, NOSTR_PROFILE_RELAY_CAP);
  if (relays.length === 0) return null;

  const events = await fetchNostrEvents(
    relays,
    [{ kinds: [3], authors: [pubkey.toLowerCase()], limit: 1 }],
    CONTACTS_REQ_TIMEOUT_MS,
  );
  if (events.length === 0) return null;
  const newest = events.reduce((a, b) => (b.created_at > a.created_at ? b : a));

  const byPubkey = new Map<string, NostrContact>();
  for (const tag of newest.tags ?? []) {
    if (!Array.isArray(tag) || tag[0] !== "p") continue;
    const contactPk = typeof tag[1] === "string" ? tag[1].toLowerCase() : "";
    if (!/^[0-9a-f]{64}$/.test(contactPk)) continue;
    const hint =
      typeof tag[2] === "string" &&
      (tag[2].startsWith("ws://") || tag[2].startsWith("wss://"))
        ? tag[2]
        : undefined;
    // Keep the LAST occurrence's position: delete-then-set so a re-follow
    // moves the contact to its newer place in the append order.
    byPubkey.delete(contactPk);
    byPubkey.set(contactPk, { pubkey: contactPk, relayHint: hint });
  }
  return [...byPubkey.values()];
}

// Fetch an author's NIP-65 relay list (kind 10002) and pick their write relays
// (EXTERNAL-AUTHOR-HISTORY-ADR §4.1). The discovery set is the caller's hints
// plus the broad fallbacks; every relay's answer is collected and the shared
// parser keeps the newest event. Returns [] when no 10002 is reachable — the
// caller then falls back to hints + NOSTR_FALLBACK_RELAYS.
export async function fetchNostrWriteRelays(
  pubkey: string,
  hintRelays: string[] = [],
): Promise<string[]> {
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) return [];
  const relays = [...new Set([...hintRelays, ...NOSTR_FALLBACK_RELAYS])]
    .filter((r) => r.startsWith("ws://") || r.startsWith("wss://"))
    .slice(0, NOSTR_PROFILE_RELAY_CAP);
  if (relays.length === 0) return [];
  const events = await fetchNostrEvents(
    relays,
    [{ kinds: [10002], authors: [pubkey.toLowerCase()], limit: 1 }],
    NIP65_REQ_TIMEOUT_MS,
  );
  return pickNostrWriteRelays(events);
}

// Fetch a single author's kind-0 profile metadata live from the relay graph,
// keeping the newest one. Nostr has no profile REST API (unlike Bluesky /
// Mastodon), so the hover bio falls back to this read-through fetch — the source
// hints first, then the broad fallback aggregators. Returns null when no current
// kind-0 is reachable (⇒ the caller shows stored fields only / marks partial).
export async function fetchNostrAuthorProfile(
  pubkey: string,
  hintRelays: string[] = [],
): Promise<NostrProfile | null> {
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) return null;
  const relays = [...new Set([...hintRelays, ...NOSTR_FALLBACK_RELAYS])]
    .filter((r) => r.startsWith("ws://") || r.startsWith("wss://"))
    .slice(0, NOSTR_PROFILE_RELAY_CAP);
  if (relays.length === 0) return null;

  const events = await fetchNostrEvents(
    relays,
    [{ kinds: [0], authors: [pubkey.toLowerCase()], limit: 1 }],
    NOSTR_PROFILE_REQ_TIMEOUT_MS,
  );
  if (events.length === 0) return null;
  // A relay may return a stale cached kind-0; keep the newest by created_at.
  const newest = events.reduce((a, b) => (b.created_at > a.created_at ? b : a));
  return parseNostrProfile(newest.content);
}

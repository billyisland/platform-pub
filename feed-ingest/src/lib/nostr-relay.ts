// Read-only Nostr relay access for periodic engagement refresh. The base
// per-source ingest (feed-ingest-nostr.ts) filters on `authors:[pubkey]`, so it
// never sees engagement — reactions (kind 7) and replies (kind 1) come from
// OTHER pubkeys. external-engagement-refresh.ts uses these helpers to fetch them
// by `#e`-tagging a batch of the source's notes and tally per note.
//
// All sockets are pinned through the SSRF-hardened helper. Best-effort and
// bounded (relay cap, id chunking, per-REQ timeout); a flaky relay just yields
// fewer events, never an exception that aborts the run.
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  pinnedWebSocketOptions,
  type PinnedWebSocketOptions,
} from "@platform-pub/shared/lib/http-client.js";

interface RelayEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

// High-coverage public relays/aggregators, merged in *behind* an item's own
// relay hints. relay.nostr.band is a broad indexer that carries most reactions;
// the rest are large general relays.
export const NOSTR_FALLBACK_RELAYS = [
  "wss://relay.nostr.band",
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
];

const RELAY_CAP = 5;
const ID_CHUNK = 100; // `#e` filter ids per REQ
const FETCH_LIMIT = 500; // per-filter relay cap
const REQ_TIMEOUT_MS = 6_000;

export interface EngagementCount {
  like: number;
  reply: number;
}

// NIP-10 reply target of a kind-1 event (explicit "reply" marker, else last `e`).
function replyTargetId(ev: RelayEvent): string | null {
  const eTags = ev.tags.filter((t) => t[0] === "e" && t[1]);
  const tag =
    eTags.find((t) => t[3] === "reply") ??
    (eTags.length > 0 ? eTags[eTags.length - 1] : null);
  return tag ? tag[1] : null;
}

// NIP-25 reaction target: the last `e` tag the reaction carries.
function reactionTargetId(ev: RelayEvent): string | null {
  const eTags = ev.tags.filter((t) => t[0] === "e" && t[1]);
  return eTags.length > 0 ? eTags[eTags.length - 1][1] : null;
}

// Open one REQ with arbitrary filters against one relay, collect EVENTs until
// EOSE or timeout. A generic sibling of feed-ingest-nostr's fetchFromRelay
// (which is hardwired to the author filter).
function fetchFromRelay(
  relayUrl: string,
  filters: Record<string, unknown>[],
  wsOpts: PinnedWebSocketOptions,
  timeoutMs: number,
): Promise<RelayEvent[]> {
  return new Promise((resolve) => {
    const events: RelayEvent[] = [];
    const ws = new WebSocket(relayUrl, wsOpts);
    const subId = `fi-eng-${randomUUID()}`;
    let settled = false;
    const finish = () => {
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
      resolve(events);
    };
    const timer = setTimeout(finish, timeoutMs);
    ws.on("open", () => {
      try {
        ws.send(JSON.stringify(["REQ", subId, ...filters]));
      } catch {
        finish();
      }
    });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg[0] === "EVENT" && msg[1] === subId) {
          events.push(msg[2] as RelayEvent);
        } else if (msg[0] === "EOSE" && msg[1] === subId) {
          finish();
        }
      } catch {
        /* ignore parse errors */
      }
    });
    ws.on("error", finish);
    ws.on("close", finish);
  });
}

// Fetch reactions + replies that `#e`-tag any of `noteIds` (raw hex event ids)
// and tally per note. Returns a Map keyed on the lowercased hex id; absent ids
// had no engagement reachable on the relay set. Counts are absolute over what
// the relays returned (the caller writes them monotonically, so a partial
// relay set can only under-report, never flicker a stored count down).
export async function fetchNostrEngagementCounts(
  noteIds: string[],
  hintRelays: string[],
): Promise<Map<string, EngagementCount>> {
  const ids = noteIds.filter((id) => /^[0-9a-f]{64}$/i.test(id));
  const out = new Map<string, EngagementCount>();
  if (ids.length === 0) return out;

  const relays = [...new Set([...hintRelays, ...NOSTR_FALLBACK_RELAYS])]
    .filter((r) => r.startsWith("ws://") || r.startsWith("wss://"))
    .slice(0, RELAY_CAP);
  if (relays.length === 0) return out;

  const known = new Set(ids.map((id) => id.toLowerCase()));

  // Resolve each relay's pinned options once, up front.
  const opened = (
    await Promise.all(
      relays.map(async (url) => {
        try {
          return { url, opts: await pinnedWebSocketOptions(url) };
        } catch {
          return null; // unresolvable / blocked host
        }
      }),
    )
  ).filter((r): r is { url: string; opts: PinnedWebSocketOptions } => !!r);

  const byId = new Map<string, RelayEvent>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const filters = [
      { kinds: [7], "#e": chunk, limit: FETCH_LIMIT },
      { kinds: [1], "#e": chunk, limit: FETCH_LIMIT },
    ];
    const perRelay = await Promise.all(
      opened.map(({ url, opts }) =>
        fetchFromRelay(url, filters, opts, REQ_TIMEOUT_MS).catch(
          () => [] as RelayEvent[],
        ),
      ),
    );
    for (const evs of perRelay) {
      for (const ev of evs) {
        if (ev?.id && !byId.has(ev.id)) byId.set(ev.id, ev);
      }
    }
  }

  const bump = (id: string, key: keyof EngagementCount) => {
    const cur = out.get(id) ?? { like: 0, reply: 0 };
    cur[key] += 1;
    out.set(id, cur);
  };
  for (const ev of byId.values()) {
    if (ev.kind === 7) {
      // NIP-25: "-" content is a downvote/dislike; only non-negative is a like.
      if (ev.content.trim() === "-") continue;
      const target = reactionTargetId(ev)?.toLowerCase();
      if (target && known.has(target)) bump(target, "like");
    } else if (ev.kind === 1) {
      const target = replyTargetId(ev)?.toLowerCase();
      if (target && known.has(target)) bump(target, "reply");
    }
  }
  return out;
}

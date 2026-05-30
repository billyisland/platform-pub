"use client";

import { useEffect, useState, useRef } from "react";
import { replies, type ConversationNode } from "../lib/api";

interface ConversationState {
  nodes: ConversationNode[];
  rootEventId: string | null;
  repliesEnabled: boolean;
  paywallLocked: boolean;
  loading: boolean;
  error: boolean;
}

interface CachedConversation {
  nodes: ConversationNode[];
  rootEventId: string;
  repliesEnabled: boolean;
  paywallLocked: boolean;
  ts: number;
}

// Module-level cache keyed by the conversation's resolved root event id. Because
// the endpoint returns the WHOLE conversation, every node in a thread shares one
// cache entry — re-focusing on any node is a pure client-side re-root with no
// refetch. Bounded by a TTL + entry cap so it can't grow without limit (M3).
const cache = new Map<string, CachedConversation>();
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 200;

function readCache(key: string): CachedConversation | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return entry;
}

function writeCache(key: string, entry: CachedConversation): void {
  cache.set(key, entry);
  if (cache.size > CACHE_MAX) {
    // Evict the oldest insertion (Map preserves insertion order).
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

const EMPTY: ConversationState = {
  nodes: [],
  rootEventId: null,
  repliesEnabled: true,
  paywallLocked: false,
  loading: false,
  error: false,
};

/**
 * Fetch a native conversation by any node's event id. The whole tree comes back
 * as a flat node list (see GET /conversation/:eventId); callers re-root locally.
 *
 * `refreshKey` bumps force a refetch (e.g. after a new reply is published).
 */
export function useConversation(
  eventId: string | null,
  enabled: boolean,
  refreshKey?: number,
): ConversationState {
  const [state, setState] = useState<ConversationState>(() => {
    if (eventId) {
      const cached = readCache(eventId);
      if (cached) {
        return {
          nodes: cached.nodes,
          rootEventId: cached.rootEventId,
          repliesEnabled: cached.repliesEnabled,
          paywallLocked: cached.paywallLocked,
          loading: false,
          error: false,
        };
      }
    }
    return EMPTY;
  });
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !eventId) return;

    // Refetch when the requested event or the refresh tick changes.
    const fetchKey = `${eventId}:${refreshKey ?? 0}`;
    if (lastKey.current === fetchKey) return;
    lastKey.current = fetchKey;

    // On a forced refresh, drop the stale entry first so a concurrent mount
    // reading the cache can't serve pre-reply nodes mid-refetch (M3).
    if (refreshKey) cache.delete(eventId);
    const cached = refreshKey ? undefined : readCache(eventId);
    if (cached) {
      setState({
        nodes: cached.nodes,
        rootEventId: cached.rootEventId,
        repliesEnabled: cached.repliesEnabled,
        paywallLocked: cached.paywallLocked,
        loading: false,
        error: false,
      });
      return;
    }

    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: false }));

    replies
      .conversation(eventId)
      .then((res) => {
        const entry: CachedConversation = {
          nodes: res.nodes,
          rootEventId: res.rootEventId,
          repliesEnabled: res.repliesEnabled,
          paywallLocked: res.paywallLocked,
          ts: Date.now(),
        };
        // Cache under both the requested id and the resolved root so a later
        // expansion from any angle hits the same entry.
        writeCache(eventId, entry);
        writeCache(res.rootEventId, entry);
        if (cancelled) return;
        setState({ ...entry, loading: false, error: false });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ ...EMPTY, error: true });
      });

    return () => {
      cancelled = true;
    };
  }, [eventId, enabled, refreshKey]);

  return state;
}

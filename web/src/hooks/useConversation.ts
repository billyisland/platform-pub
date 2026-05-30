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
}

// Module-level cache keyed by the conversation's resolved root event id. Because
// the endpoint returns the WHOLE conversation, every node in a thread shares one
// cache entry — re-focusing on any node is a pure client-side re-root with no
// refetch.
const cache = new Map<string, CachedConversation>();

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
      const cached = cache.get(eventId);
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

    const cached = refreshKey ? undefined : cache.get(eventId);
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
        };
        // Cache under both the requested id and the resolved root so a later
        // expansion from any angle hits the same entry.
        cache.set(eventId, entry);
        cache.set(res.rootEventId, entry);
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

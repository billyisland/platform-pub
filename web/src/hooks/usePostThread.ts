"use client";

// =============================================================================
// usePostThread — UNIVERSAL-POST-ADR §8 (one thread engine, replacing three)
//
// Fetches GET /thread/:postId once for the host, then keeps an accumulating pool
// of Posts keyed by post_id. Re-rooting onto a node already in the pool is pure
// client-side (deriveThreadView); re-rooting onto a node whose subtree isn't
// loaded fetches /thread/:focalId and merges. "Show more replies" paginates the
// current focal's descendants by the server keyset cursor.
//
// Replaces useConversation (native) + useExternalThread/useNeighbourhood
// (external): one model, one fetch shape, one re-root semantics for both.
// =============================================================================

import { useCallback, useEffect, useReducer, useRef } from "react";
import { postThread, type PostThreadResponse } from "../lib/api/post";
import type { Post, RepostEdge } from "../lib/post/types";

const REPLY_PAGE = 5; // §8 initial descendant page

// Per-focal pagination state: the cursor for the *next* page of that focal's
// flattened descendants, and the full subtree count for the "more" affordance.
interface FocalMeta {
  cursor?: string;
  total: number;
  descLoaded: boolean; // its descendant page has been fetched at least once
}

// ── module cache (TTL + cap), mirroring useConversation/useExternalThread ─────
const cache = new Map<string, { res: PostThreadResponse; ts: number }>();
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 200;
function readCache(id: string): PostThreadResponse | undefined {
  const e = cache.get(id);
  if (!e) return undefined;
  if (Date.now() - e.ts > CACHE_TTL_MS) {
    cache.delete(id);
    return undefined;
  }
  return e.res;
}
function writeCache(id: string, res: PostThreadResponse): void {
  cache.set(id, { res, ts: Date.now() });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

function edgeKey(e: RepostEdge): string {
  return `${e.targetPostId}|${e.actorId ?? e.actorHandle ?? ""}|${e.originUri ?? ""}`;
}

interface State {
  rootId: string | null; // the host focal; "↑ Full conversation" returns here
  focalId: string | null;
  pool: Map<string, Post>;
  edges: RepostEdge[];
  meta: Map<string, FocalMeta>;
  loading: boolean; // initial host fetch
  rerooting: boolean; // fetching an unloaded subtree on re-root
  loadingMore: boolean;
  error: boolean;
  paywallLocked: boolean;
}

type Action =
  | { kind: "init-start" }
  | { kind: "set-focal"; id: string }
  | { kind: "reroot-start" }
  | { kind: "more-start" }
  | { kind: "error" }
  | { kind: "ingest"; res: PostThreadResponse; root?: boolean };

const INITIAL: State = {
  rootId: null,
  focalId: null,
  pool: new Map(),
  edges: [],
  meta: new Map(),
  loading: false,
  rerooting: false,
  loadingMore: false,
  error: false,
  paywallLocked: false,
};

function reducer(state: State, action: Action): State {
  switch (action.kind) {
    case "init-start":
      return { ...INITIAL, loading: true };
    case "set-focal":
      return { ...state, focalId: action.id };
    case "reroot-start":
      return { ...state, rerooting: true, error: false };
    case "more-start":
      return { ...state, loadingMore: true };
    case "error":
      return { ...state, loading: false, rerooting: false, loadingMore: false, error: true };
    case "ingest": {
      const { res } = action;
      const pool = new Map(state.pool);
      for (const p of res.posts) pool.set(p.id, p);
      const edgeMap = new Map(state.edges.map((e) => [edgeKey(e), e]));
      for (const e of res.repostEdges) edgeMap.set(edgeKey(e), e);
      const meta = new Map(state.meta);
      meta.set(res.focalId, {
        cursor: res.replyCursor,
        total: res.totalDescendants,
        descLoaded: true,
      });
      return {
        ...state,
        pool,
        edges: [...edgeMap.values()],
        meta,
        rootId: action.root ? res.focalId : state.rootId,
        focalId: action.root ? res.focalId : state.focalId,
        loading: false,
        rerooting: false,
        loadingMore: false,
        error: false,
        // Lock state belongs to the gated root; only reflect it from the host fetch.
        paywallLocked: action.root ? !!res.paywallLocked : state.paywallLocked,
      };
    }
    default:
      return state;
  }
}

export interface PostThreadApi {
  rootId: string | null;
  focalId: string | null;
  pool: Map<string, Post>;
  edges: RepostEdge[];
  totalDescendants: number; // for the current focal
  hasMoreReplies: boolean;
  loading: boolean;
  rerooting: boolean;
  loadingMore: boolean;
  error: boolean;
  paywallLocked: boolean;
  reroot: (id: string) => void;
  backToRoot: () => void;
  loadMore: () => void;
}

export function usePostThread(
  rootPostId: string | null,
  enabled: boolean,
): PostThreadApi {
  const [state, dispatch] = useReducer(reducer, INITIAL);

  // Latest state for callbacks (reroot/loadMore read current meta/focal).
  const stateRef = useRef(state);
  stateRef.current = state;
  // Guard so a stale fetch's settle doesn't clear flags for a newer request.
  const reqSeq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Initial host fetch (on expand). Cache-first, like the legacy thread hooks.
  useEffect(() => {
    if (!enabled || !rootPostId) return;
    const cached = readCache(rootPostId);
    if (cached) {
      dispatch({ kind: "ingest", res: cached, root: true });
      return;
    }
    let cancelled = false;
    dispatch({ kind: "init-start" });
    postThread(rootPostId, { replyLimit: REPLY_PAGE })
      .then((res) => {
        writeCache(rootPostId, res);
        if (cancelled || !mounted.current) return;
        dispatch({ kind: "ingest", res, root: true });
      })
      .catch(() => {
        if (cancelled || !mounted.current) return;
        dispatch({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, rootPostId]);

  const fetchFocal = useCallback((id: string) => {
    const seq = ++reqSeq.current;
    dispatch({ kind: "reroot-start" });
    const cached = readCache(id);
    const p = cached
      ? Promise.resolve(cached)
      : postThread(id, { replyLimit: REPLY_PAGE });
    p.then((res) => {
      if (!cached) writeCache(id, res);
      if (!mounted.current || seq !== reqSeq.current) return;
      dispatch({ kind: "ingest", res });
    }).catch(() => {
      if (!mounted.current || seq !== reqSeq.current) return;
      dispatch({ kind: "error" });
    });
  }, []);

  const reroot = useCallback(
    (id: string) => {
      dispatch({ kind: "set-focal", id });
      // Already-loaded subtree → pure client-side (no fetch). Otherwise fill it.
      if (!stateRef.current.meta.get(id)?.descLoaded) fetchFocal(id);
    },
    [fetchFocal],
  );

  const backToRoot = useCallback(() => {
    const root = stateRef.current.rootId;
    if (root) dispatch({ kind: "set-focal", id: root });
  }, []);

  const loadMore = useCallback(() => {
    const s = stateRef.current;
    if (!s.focalId) return;
    const m = s.meta.get(s.focalId);
    if (!m?.cursor || s.loadingMore) return;
    const focal = s.focalId;
    dispatch({ kind: "more-start" });
    postThread(focal, { replyLimit: REPLY_PAGE, replyCursor: m.cursor })
      .then((res) => {
        if (!mounted.current) return;
        dispatch({ kind: "ingest", res });
      })
      .catch(() => {
        if (!mounted.current) return;
        dispatch({ kind: "error" });
      });
  }, []);

  const focalMeta = state.focalId ? state.meta.get(state.focalId) : undefined;

  return {
    rootId: state.rootId,
    focalId: state.focalId,
    pool: state.pool,
    edges: state.edges,
    totalDescendants: focalMeta?.total ?? 0,
    hasMoreReplies: !!focalMeta?.cursor,
    loading: state.loading,
    rerooting: state.rerooting,
    loadingMore: state.loadingMore,
    error: state.error,
    paywallLocked: state.paywallLocked,
    reroot,
    backToRoot,
    loadMore,
  };
}

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

// When the host thread fetch reports background hydration in flight, poll with
// backoff and merge whatever landed, STOPPING only when a response arrives with
// `hydrating: false` (the job genuinely settled — D1 guarantees that meaning).
// Bounded by a total budget so a hydrate that never settles can't poll forever.
// (Replaces the fixed [3000, 8000] merge offsets that stopped at 8 s and let a
// slow relay's result land on an empty DB — THREAD-HYDRATION-LATENCY-ADR D2.)
const HYDRATION_POLL_MS = [1_500, 3_000, 6_000, 12_000, 24_000]; // step, cap ~30 s
const HYDRATION_POLL_BUDGET_MS = 45_000;

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
// Exported for the cache-hygiene test (D2): a `hydrating: true` response must
// never round-trip through the cache. Test-only reset clears module state.
export function __resetThreadCache(): void {
  cache.clear();
}
export function readCache(id: string): PostThreadResponse | undefined {
  const e = cache.get(id);
  if (!e) return undefined;
  if (Date.now() - e.ts > CACHE_TTL_MS) {
    cache.delete(id);
    return undefined;
  }
  return e.res;
}
export function writeCache(id: string, res: PostThreadResponse): void {
  // Cache hygiene (D2): never persist a partial (`hydrating: true`) response.
  // Caching it for the 60 s TTL is exactly what pinned every re-expand to an
  // empty thread until both TTLs expired. Only settled results are cacheable.
  if (res.hydrating) return;
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
  | { kind: "reroot-failed"; revertTo: string | null }
  | { kind: "more-start" }
  | { kind: "error" }
  | { kind: "ingest"; res: PostThreadResponse; root?: boolean }
  | { kind: "merge"; res: PostThreadResponse };

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
    case "reroot-failed": {
      // A re-root target that couldn't be fetched (e.g. a quoted post whose
      // context-only twin was GC'd): put the focal back where it was so the
      // loaded thread stays intact instead of deriving against a missing node.
      // If the target is already in the pool the view still renders (only its
      // descendant page failed) — keep the user's click in that case.
      const focalMissing = !state.focalId || !state.pool.has(state.focalId);
      return {
        ...state,
        focalId: focalMissing ? (action.revertTo ?? state.focalId) : state.focalId,
        rerooting: false,
      };
    }
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
    case "merge": {
      // Background hydration landed: fold new nodes into the pool and refresh the
      // fetched focal's pagination meta WITHOUT touching root/focal/loading — the
      // user may have re-rooted in the meantime, and deriveThreadView recomputes
      // the visible tree from the enriched pool.
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
      return { ...state, pool, edges: [...edgeMap.values()], meta };
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
  // Bumping this busts the host's cached thread and refetches — used after a
  // reply is published so the new node appears without waiting out the TTL.
  refreshKey?: number,
): PostThreadApi {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  // The refreshKey we've already serviced; lets us tell a real refresh from the
  // initial mount (where cache-first is correct).
  const servicedKey = useRef<number | undefined>(undefined);

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
    // A changed refreshKey (after first mount) forces a network refetch.
    const isRefresh =
      refreshKey !== undefined &&
      servicedKey.current !== undefined &&
      refreshKey !== servicedKey.current;
    servicedKey.current = refreshKey;
    if (isRefresh) cache.delete(rootPostId);
    let cancelled = false;
    // Background-hydration poll (external threads): the host fetch may return
    // `hydrating: true` before ancestors/replies are in the DB. Poll with backoff
    // and merge whatever landed, stopping only when a response reports
    // `hydrating: false` (the job settled — D1 makes that meaning honest) or the
    // total budget elapses. Partials never enter the cache (writeCache hygiene),
    // so a re-expand mid-hydration re-fetches instead of serving an empty thread.
    const timers: ReturnType<typeof setTimeout>[] = [];
    const startHydrationPoll = () => {
      const startedAt = Date.now();
      let step = 0;
      const tick = () => {
        if (cancelled || !mounted.current) return;
        if (Date.now() - startedAt > HYDRATION_POLL_BUDGET_MS) return; // give up
        postThread(rootPostId, { replyLimit: REPLY_PAGE })
          .then((res) => {
            if (cancelled || !mounted.current) return;
            writeCache(rootPostId, res); // no-op while hydrating (hygiene)
            dispatch({ kind: "merge", res });
            if (res.hydrating) {
              const delay =
                HYDRATION_POLL_MS[Math.min(step, HYDRATION_POLL_MS.length - 1)];
              step++;
              timers.push(setTimeout(tick, delay));
            }
            // hydrating: false → stop; writeCache above persisted the clean result.
          })
          .catch(() => {
            // Keep the loaded thread; schedule one more attempt within budget.
            if (cancelled || !mounted.current) return;
            const delay =
              HYDRATION_POLL_MS[Math.min(step, HYDRATION_POLL_MS.length - 1)];
            step++;
            timers.push(setTimeout(tick, delay));
          });
      };
      timers.push(setTimeout(tick, HYDRATION_POLL_MS[0]));
    };
    const cached = isRefresh ? undefined : readCache(rootPostId);
    if (cached) {
      // Only settled results are ever cached now (writeCache hygiene), so a
      // cached response is complete — no poll needed on a cache hit.
      dispatch({ kind: "ingest", res: cached, root: true });
      return () => {
        cancelled = true;
        for (const t of timers) clearTimeout(t);
      };
    }
    dispatch({ kind: "init-start" });
    postThread(rootPostId, { replyLimit: REPLY_PAGE })
      .then((res) => {
        writeCache(rootPostId, res);
        if (cancelled || !mounted.current) return;
        dispatch({ kind: "ingest", res, root: true });
        if (res.hydrating) startHydrationPoll();
      })
      .catch(() => {
        if (cancelled || !mounted.current) return;
        dispatch({ kind: "error" });
      });
    return () => {
      cancelled = true;
      for (const t of timers) clearTimeout(t);
    };
  }, [enabled, rootPostId, refreshKey]);

  const fetchFocal = useCallback((id: string, revertTo: string | null) => {
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
      dispatch({ kind: "reroot-failed", revertTo });
    });
  }, []);

  const reroot = useCallback(
    (id: string) => {
      const prevFocal = stateRef.current.focalId;
      dispatch({ kind: "set-focal", id });
      // Already-loaded subtree → pure client-side (no fetch). Otherwise fill it.
      if (!stateRef.current.meta.get(id)?.descLoaded) fetchFocal(id, prevFocal);
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

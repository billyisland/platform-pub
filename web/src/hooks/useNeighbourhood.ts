"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import {
  externalItems,
  type ParentItem,
  type ExternalThreadEntry,
} from "../lib/api/feeds";

export interface NeighbourhoodParent {
  id: string;
  sourceProtocol: string;
  sourceItemUri: string;
  authorName: string | null;
  authorHandle: string | null;
  authorUri: string | null;
  contentText: string | null;
  contentHtml: string | null;
  title: string | null;
  publishedAt: number;
  likeCount: number;
  replyCount: number;
  repostCount: number;
  sourceReplyUri: string | null;
}

export interface NeighbourhoodReply {
  id: string;
  authorName: string;
  authorHandle: string;
  authorUri: string;
  contentHtml: string;
  contentText: string;
  publishedAt: string;
  likeCount: number;
  replyCount: number;
  repostCount: number;
  parentId: string | null;
  protocol: string;
}

export interface NeighbourhoodState {
  parent: NeighbourhoodParent | null;
  parentChain: NeighbourhoodParent[];
  replies: NeighbourhoodReply[];
  totalDescendants: number;
  loading: boolean;
  error: boolean;
  partial: boolean;
  instanceDomain: string | null;
}

interface CachedNeighbourhood {
  parent: NeighbourhoodParent | null;
  replies: NeighbourhoodReply[];
  totalDescendants: number;
  partial: boolean;
  instanceDomain: string | null;
}

// Module-level session cache. Bounded so it can't grow without limit as a user
// expands neighbourhood after neighbourhood over a long session; oldest insertion
// is evicted first (Map iterates in insertion order).
const cache = new Map<string, CachedNeighbourhood>();
const CACHE_MAX = 200;

function cacheSet(key: string, value: CachedNeighbourhood): void {
  cache.set(key, value);
  if (cache.size <= CACHE_MAX) return;
  const oldest = cache.keys().next().value;
  if (oldest !== undefined) cache.delete(oldest);
}

function extractDomain(uri: string | null | undefined): string | null {
  if (!uri) return null;
  try {
    return new URL(uri).hostname;
  } catch {
    return null;
  }
}

function parentItemToNeighbourhood(p: ParentItem): NeighbourhoodParent {
  return {
    id: p.id,
    sourceProtocol: p.sourceProtocol,
    sourceItemUri: p.sourceItemUri,
    authorName: p.authorName,
    authorHandle: p.authorHandle,
    authorUri: p.authorUri,
    contentText: p.contentText,
    contentHtml: p.contentHtml,
    title: p.title,
    publishedAt: p.publishedAt,
    likeCount: p.likeCount,
    replyCount: p.replyCount,
    repostCount: p.repostCount,
    sourceReplyUri: p.sourceReplyUri,
  };
}

const REPLY_PAGE_SIZE = 10;

export function useNeighbourhood(
  itemId: string,
  itemType: "article" | "note" | "external",
  expanded: boolean,
  biddabilityTier: "A" | "B" | "C" | "D" = "D",
  sourceItemUri?: string | null,
): NeighbourhoodState & {
  loadMoreReplies: () => void;
  loadParent: () => void;
} {
  const [state, setState] = useState<NeighbourhoodState>({
    parent: null,
    parentChain: [],
    replies: [],
    totalDescendants: 0,
    loading: false,
    error: false,
    partial: false,
    instanceDomain: null,
  });

  const fetched = useRef(false);
  const [replyPage, setReplyPage] = useState(1);
  const allRepliesRef = useRef<NeighbourhoodReply[]>([]);

  // The parent/thread fetches and loadParent settle asynchronously; if the card
  // collapses or unmounts first, a setState would warn and waste a render. Track
  // mount state and gate every async setState on it.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!expanded || fetched.current) return;
    if (itemType !== "external") return;
    if (biddabilityTier === "C" || biddabilityTier === "D") {
      fetched.current = true;
      setState((prev) => ({ ...prev, loading: false }));
      return;
    }

    const cached = cache.get(itemId);
    if (cached) {
      allRepliesRef.current = cached.replies;
      setState({
        parent: cached.parent,
        parentChain: cached.parent ? [cached.parent] : [],
        replies: cached.replies.slice(0, REPLY_PAGE_SIZE),
        totalDescendants: cached.totalDescendants,
        loading: false,
        error: false,
        partial: cached.partial,
        instanceDomain: cached.instanceDomain,
      });
      return;
    }

    fetched.current = true;
    setState((prev) => ({ ...prev, loading: true }));

    void Promise.allSettled([
      externalItems.parent(itemId),
      externalItems.thread(itemId),
    ]).then(([parentResult, threadResult]) => {
      let parent: NeighbourhoodParent | null = null;
      let partial = false;
      let instanceDomain: string | null = null;

      if (parentResult.status === "fulfilled") {
        if (parentResult.value.parent) {
          parent = parentItemToNeighbourhood(parentResult.value.parent);
        }
        // Prefer the server-signalled partial flag over inferring from rejection.
        if (parentResult.value.partial) partial = true;
      } else if (parentResult.status === "rejected") {
        partial = true;
      }

      let allReplies: NeighbourhoodReply[] = [];
      let totalDescendants = 0;
      if (threadResult.status === "fulfilled") {
        allReplies = threadResult.value.descendants;
        totalDescendants = allReplies.length;
        if (threadResult.value.partial) partial = true;
      } else if (threadResult.status === "rejected") {
        partial = true;
      }

      if (partial) {
        instanceDomain = extractDomain(sourceItemUri);
      }

      const cacheEntry: CachedNeighbourhood = {
        parent,
        replies: allReplies,
        totalDescendants,
        partial,
        instanceDomain,
      };
      cacheSet(itemId, cacheEntry);

      if (!mounted.current) return;
      allRepliesRef.current = allReplies;

      setState({
        parent,
        parentChain: parent ? [parent] : [],
        replies: allReplies.slice(0, REPLY_PAGE_SIZE),
        totalDescendants,
        loading: false,
        error: false,
        partial,
        instanceDomain,
      });
    });
  }, [expanded, itemId, itemType, biddabilityTier]);

  const loadMoreReplies = useCallback(() => {
    setReplyPage((prev) => {
      const next = prev + 1;
      setState((s) => ({
        ...s,
        replies: allRepliesRef.current.slice(0, next * REPLY_PAGE_SIZE),
      }));
      return next;
    });
  }, []);

  const loadParent = useCallback(() => {
    const chain = state.parentChain;
    const topParent = chain[chain.length - 1];
    if (!topParent?.sourceReplyUri || !topParent.id) return;

    externalItems
      .parent(topParent.id)
      .then((res) => {
        if (res.parent && mounted.current) {
          const grandparent = parentItemToNeighbourhood(res.parent);
          setState((s) => ({
            ...s,
            parentChain: [...s.parentChain, grandparent],
          }));
        }
      })
      .catch(() => {});
  }, [state.parentChain]);

  return { ...state, loadMoreReplies, loadParent };
}

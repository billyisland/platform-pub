"use client";

import { useEffect, useMemo, useState } from "react";
import { useConversation } from "../../hooks/useConversation";
import { replies as repliesApi, type ConversationNode } from "../../lib/api";
import { useAuth } from "../../stores/auth";
import { VoteControls } from "../ui/VoteControls";
import { Byline } from "./Byline";
import { TrustPip } from "../ui/TrustPip";
import type { VesselPalette } from "./tokens";
import { TEXT_SIZE_PX, DEFAULT_TEXT_SIZE } from "./tokens";
import type { ReplyTarget } from "./Composer";

interface Props {
  // The conversation root — the note/article event id of the host card. The
  // whole conversation is fetched once from this id; re-focusing on any node is
  // a pure client-side re-root (no refetch).
  hostEventId: string;
  palette: VesselPalette;
  bodyPx?: number;
  // Opens the compose overlay against a node (reply). When absent, replies are
  // disabled (e.g. logged-out).
  onReply?: (target: ReplyTarget) => void;
  // Bumped by the parent after a reply publishes so the thread refetches.
  refreshKey?: number;
}

interface FlatEntry {
  node: ConversationNode;
  replyingTo: { name: string } | null;
}

function nodeName(node: ConversationNode): string {
  return (
    node.author.displayName ||
    node.author.username ||
    node.author.pubkey.slice(0, 12) + "…"
  );
}

function nodeHref(node: ConversationNode): string | undefined {
  return node.author.username ? `/${node.author.username}` : undefined;
}

export function ConversationView({
  hostEventId,
  palette,
  bodyPx = TEXT_SIZE_PX[DEFAULT_TEXT_SIZE],
  onReply,
  refreshKey,
}: Props) {
  const { user } = useAuth();
  const { nodes, loading, error, repliesEnabled, paywallLocked } =
    useConversation(hostEventId, true, refreshKey);

  // The node the conversation is currently rooted on. Defaults to the host
  // (the post the user expanded); clicking any ancestor/descendant re-roots.
  const [focalId, setFocalId] = useState(hostEventId);
  // Reset to the host root only when the host card itself changes. A refreshKey
  // bump (e.g. after publishing a reply) deliberately does NOT reset — a
  // re-rooted reader stays on their focal node (M1).
  useEffect(() => setFocalId(hostEventId), [hostEventId]);

  // Locally-deleted comment ids (optimistic; the module cache is immutable).
  const [deleted, setDeleted] = useState<Set<string>>(new Set());

  const { byId, childrenOf } = useMemo(() => {
    const byId = new Map<string, ConversationNode>();
    const childrenOf = new Map<string, ConversationNode[]>();
    for (const n of nodes) byId.set(n.eventId, n);
    for (const n of nodes) {
      if (n.parentEventId) {
        const arr = childrenOf.get(n.parentEventId) ?? [];
        arr.push(n);
        childrenOf.set(n.parentEventId, arr);
      }
    }
    // Children already arrive ordered by publishedAt asc from the API.
    return { byId, childrenOf };
  }, [nodes]);

  // Ancestors of the focal node, oldest-first, EXCLUDING the host root (it's
  // the pinned card above this view) and the focal itself.
  const ancestors = useMemo<ConversationNode[]>(() => {
    if (focalId === hostEventId) return [];
    const chain: ConversationNode[] = [];
    // Visited guard: a corrupt parentEventId cycle (or self-parent) would
    // otherwise loop forever and hang the tab (H1).
    const seen = new Set<string>([focalId]);
    let cur = byId.get(focalId)?.parentEventId ?? null;
    while (cur && cur !== hostEventId && !seen.has(cur)) {
      const node = byId.get(cur);
      if (!node) break;
      seen.add(cur);
      chain.push(node);
      cur = node.parentEventId;
    }
    return chain.reverse();
  }, [focalId, hostEventId, byId]);

  // Descendants of the focal node as a flat chronological playscript. A
  // `replyingTo` arrow is set only when the parent isn't the immediately
  // preceding entry, disambiguating a non-adjacent parent.
  const descendants = useMemo<FlatEntry[]>(() => {
    const flat: ConversationNode[] = [];
    // Visited guard against parentEventId cycles (H1).
    const seen = new Set<string>([focalId]);
    const walk = (parentId: string) => {
      for (const child of childrenOf.get(parentId) ?? []) {
        if (seen.has(child.eventId)) continue;
        seen.add(child.eventId);
        flat.push(child);
        walk(child.eventId);
      }
    };
    walk(focalId);

    return flat.map((node, i) => {
      let replyingTo: { name: string } | null = null;
      const prev = i > 0 ? flat[i - 1] : null;
      // The focal node is the implicit parent of the first level; only annotate
      // when the parent is neither the focal nor the previous entry.
      if (
        node.parentEventId &&
        node.parentEventId !== focalId &&
        (!prev || prev.eventId !== node.parentEventId)
      ) {
        const parent = byId.get(node.parentEventId);
        if (parent) replyingTo = { name: nodeName(parent) };
      }
      return { node, replyingTo };
    });
  }, [focalId, childrenOf, byId]);

  // If a refetch drops the focal node (deleted upstream / stale id), fall back
  // to the root so ancestors don't render above an empty gap (M2).
  useEffect(() => {
    if (focalId !== hostEventId && nodes.length > 0 && !byId.has(focalId)) {
      setFocalId(hostEventId);
    }
  }, [focalId, hostEventId, byId, nodes.length]);

  async function handleDelete(node: ConversationNode) {
    if (!node.commentId) return;
    try {
      await repliesApi.deleteReply(node.commentId);
      setDeleted((prev) => new Set(prev).add(node.eventId));
    } catch {
      /* leave as-is on failure */
    }
  }

  if (loading) {
    return (
      <div className="mt-4 ml-8 space-y-[32px]">
        {[1, 2].map((i) => (
          <div
            key={i}
            className="h-10 animate-pulse rounded"
            style={{ background: palette.cardMeta, opacity: 0.15 }}
          />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-4 ml-8">
        <p className="label-ui text-grey-400">Couldn&apos;t load conversation</p>
      </div>
    );
  }

  if (paywallLocked) {
    return (
      <div className="mt-4 ml-8">
        <p className="label-ui text-grey-400">
          Unlock the article to read replies.
        </p>
      </div>
    );
  }

  const focal = byId.get(focalId) ?? null;
  const isFocused = focalId !== hostEventId;

  if (!isFocused && descendants.length === 0) {
    // Root with no replies — nothing to render below the host card.
    return null;
  }

  const ownId = user?.id;

  const entry = (
    node: ConversationNode,
    opts: { replyingTo?: { name: string } | null; focal?: boolean },
  ) => {
    const name = nodeName(node);
    const href = nodeHref(node);
    const publishedAtUnix = Math.floor(
      new Date(node.publishedAt).getTime() / 1000,
    );
    const isOwn = !!ownId && ownId === node.author.id;
    const isDeleted = node.isDeleted || deleted.has(node.eventId);
    const content = isDeleted ? "[deleted]" : node.content;

    return (
      <div
        key={node.eventId}
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          if (!opts.focal) setFocalId(node.eventId);
        }}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !opts.focal) {
            e.preventDefault();
            setFocalId(node.eventId);
          }
        }}
        className="group relative transition-colors"
        style={{
          cursor: opts.focal ? "default" : "pointer",
          ...(opts.focal
            ? {
                borderLeft: `2px solid ${palette.cardTitle}`,
                paddingLeft: 14,
                marginLeft: -16,
              }
            : {}),
        }}
      >
        <Byline
          pipNode={
            <span style={{ display: "inline-flex", opacity: palette.pipOpacity }}>
              <TrustPip status={node.author.pipStatus} />
            </span>
          }
          name={name}
          nameHref={href}
          publishedAt={publishedAtUnix}
          replyingTo={opts.replyingTo ?? null}
          palette={palette}
          className="mb-1"
        />
        <p
          className="font-sans whitespace-pre-wrap"
          style={{
            color: isDeleted ? palette.cardMeta : palette.cardTitle,
            fontSize: bodyPx,
            lineHeight: 1.5,
            fontStyle: isDeleted ? "italic" : undefined,
          }}
        >
          {content}
        </p>
        {!isDeleted && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="mt-2 flex items-center gap-4 label-ui"
            style={{ color: palette.cardMeta }}
          >
            <VoteControls
              targetEventId={node.eventId}
              targetKind={1}
              isOwnContent={isOwn}
            />
            {onReply && repliesEnabled && (
              <button
                type="button"
                onClick={() =>
                  onReply({
                    // Thread under the conversation root; link the comment as
                    // parent so it nests correctly (target_event_id stays root).
                    eventId: hostEventId,
                    eventKind: 1,
                    authorPubkey: node.author.pubkey,
                    authorName: name,
                    excerpt: content.slice(0, 120),
                    parentCommentId: node.commentId ?? undefined,
                    parentCommentEventId: node.eventId,
                  })
                }
                className="hover:text-black transition-colors"
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
              >
                Reply
              </button>
            )}
            {isOwn && node.commentId && (
              <button
                type="button"
                onClick={() => handleDelete(node)}
                className="hover:text-crimson transition-colors"
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
              >
                Delete
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div onClick={(e) => e.stopPropagation()} className="mt-4 ml-8">
      {isFocused && (
        <button
          type="button"
          onClick={() => setFocalId(hostEventId)}
          className="mb-[24px] label-ui text-grey-400 hover:text-black hover:underline transition-colors"
        >
          ↑ Full conversation
        </button>
      )}

      <ol className="space-y-[32px]">
        {/* Ancestors of the focal node, oldest-first, indented above it. Keys
            are group-prefixed so a node appearing in more than one group can't
            collide (L4). */}
        {ancestors.map((node) => (
          <li key={`anc-${node.eventId}`}>{entry(node, {})}</li>
        ))}

        {/* The focal node anchor (only when re-rooted onto a reply; at the root
            the host card above is the anchor). */}
        {isFocused && focal && (
          <li key={`focal-${focal.eventId}`}>{entry(focal, { focal: true })}</li>
        )}

        {/* Descendants below the focal. */}
        {descendants.map(({ node, replyingTo }) => (
          <li key={`desc-${node.eventId}`}>{entry(node, { replyingTo })}</li>
        ))}
      </ol>
    </div>
  );
}

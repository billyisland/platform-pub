"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
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
  // The note/article event id of the card the user opened. The whole
  // conversation is fetched once from this id and the view defaults to it as
  // the focal node; re-focusing on any node is a pure client-side re-root (no
  // refetch). The host has no special pinned status — it is just one entry.
  hostEventId: string;
  palette: VesselPalette;
  bodyPx?: number;
  // Opens the compose overlay against a node (reply). When absent, replies are
  // disabled (e.g. logged-out).
  onReply?: (target: ReplyTarget) => void;
  // Bumped by the parent after a reply publishes so the thread refetches.
  refreshKey?: number;
  // Collapses the expanded card. Wired to clicking the focal node — the note
  // you opened reads as focal, and clicking it again closes the conversation.
  onCollapse?: () => void;
  // Renders the host item's rich body (full content + media + actions) in the
  // focal slot. When provided and the host is the focal node, this is shown
  // instead of the lightweight playscript entry — so expanding reads as the
  // full post surrounded by its conversation (mirrors the external card). It
  // renders immediately (it doesn't depend on the conversation fetch); the
  // context fills in around it.
  renderFocal?: () => ReactNode;
  // Renders ANY conversation node as a rich focal body (same machinery as
  // renderFocal, parameterised by the node). Used when re-rooting onto a
  // reply/ancestor so the new focal reads as a full-width card identical to the
  // host focal — no lightweight stand-in, no left bar. `rootEventId` is threaded
  // through so the node's Reply wires under the conversation root.
  renderFocalNode?: (node: ConversationNode, rootEventId: string) => ReactNode;
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
  onCollapse,
  renderFocal,
  renderFocalNode,
}: Props) {
  const { user } = useAuth();
  const { nodes, loading, error, repliesEnabled, paywallLocked } =
    useConversation(hostEventId, true, refreshKey);

  // The node the conversation is currently rooted on. Defaults to the post the
  // user opened; clicking any ancestor/descendant re-roots freely (and the new
  // focal's own ancestors then walk all the way to the true root).
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

  // The true conversation root (parentEventId === null). Used for the "full
  // conversation" reset and as the target_event_id for new replies. Falls back
  // to the host if the root node hasn't loaded yet.
  const rootEventId = useMemo<string>(() => {
    const root = nodes.find((n) => n.parentEventId === null);
    return root?.eventId ?? hostEventId;
  }, [nodes, hostEventId]);

  // Ancestors of the focal node, oldest-first, walking all the way up to the
  // true root (the host has no special status). Excludes the focal itself.
  const ancestors = useMemo<ConversationNode[]>(() => {
    const chain: ConversationNode[] = [];
    // Visited guard: a corrupt parentEventId cycle (or self-parent) would
    // otherwise loop forever and hang the tab (H1).
    const seen = new Set<string>([focalId]);
    let cur = byId.get(focalId)?.parentEventId ?? null;
    while (cur && !seen.has(cur)) {
      const node = byId.get(cur);
      if (!node) break;
      seen.add(cur);
      chain.push(node);
      cur = node.parentEventId;
    }
    return chain.reverse();
  }, [focalId, byId]);

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
  // to the host (the opened item) so the rich focal re-appears rather than an
  // empty gap (M2).
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

  const focal = byId.get(focalId) ?? null;
  // The host is the opened item — its rich body renders in the focal slot and
  // "Full conversation" returns here. (Ancestors still walk above it to the
  // true root regardless.)
  const atHost = focalId === hostEventId;
  // The host body renders immediately, even before the conversation loads, so
  // expanding feels instant; ancestors/replies fill in once the fetch lands.
  const showHostFocal = atHost && !!renderFocal;

  if (paywallLocked) {
    return (
      <div className="mt-4 ml-8">
        <p className="label-ui text-grey-400">
          Unlock the article to read replies.
        </p>
      </div>
    );
  }

  // Only block the whole view when there's no host body to anchor it: a plain
  // load, or a re-rooted focal whose node hasn't arrived yet.
  if (!showHostFocal && !focal) {
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
          <p className="label-ui text-grey-400">
            Couldn&apos;t load conversation
          </p>
        </div>
      );
    }
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
          // Clicking the focal node collapses the card; clicking any other
          // entry re-roots the conversation onto it.
          if (opts.focal) onCollapse?.();
          else setFocalId(node.eventId);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (opts.focal) onCollapse?.();
            else setFocalId(node.eventId);
          }
        }}
        className="group relative transition-colors"
        style={{ cursor: "pointer" }}
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
                    eventId: rootEventId,
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
      {!atHost && (
        <button
          type="button"
          onClick={() => setFocalId(hostEventId)}
          className="mb-[24px] label-ui text-grey-400 hover:text-black hover:underline transition-colors"
        >
          ↑ Full conversation
        </button>
      )}

      <ol className="space-y-[32px]">
        {/* Ancestors of the focal node, oldest-first, above it. Keys are
            group-prefixed so a node appearing in more than one group can't
            collide (L4). */}
        {ancestors.map((node) => (
          <li key={`anc-${node.eventId}`}>{entry(node, {})}</li>
        ))}

        {/* The focal node always renders as a full-width rich card — the host
            via renderFocal, a re-rooted reply/ancestor via renderFocalNode
            (same machinery, parameterised by the node). There is no left bar and
            no lightweight stand-in: re-rooting reads as "this is now the focal
            card", indistinguishable from the originally-opened note. Clicking the
            body collapses the card (the byline link + action buttons stop
            propagation, so they keep their own behaviour); `entry()` is only a
            defensive fallback if no rich renderer was supplied. */}
        {showHostFocal ? (
          <li key={`focal-${focalId}`}>
            <div
              onClick={(e) => {
                e.stopPropagation();
                onCollapse?.();
              }}
            >
              {renderFocal!()}
            </div>
          </li>
        ) : focal ? (
          <li key={`focal-${focal.eventId}`}>
            {renderFocalNode ? (
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  onCollapse?.();
                }}
              >
                {renderFocalNode(focal, rootEventId)}
              </div>
            ) : (
              entry(focal, { focal: true })
            )}
          </li>
        ) : null}

        {/* Descendants below the focal. */}
        {descendants.map(({ node, replyingTo }) => (
          <li key={`desc-${node.eventId}`}>{entry(node, { replyingTo })}</li>
        ))}
      </ol>
    </div>
  );
}

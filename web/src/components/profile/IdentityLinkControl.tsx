"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createIdentityLink,
  deleteIdentityLink,
  type LinkedSource,
} from "../../lib/api/post";
import { invalidateAuthorCardCache } from "../../hooks/useAuthorCard";
import { useResolverInput } from "../../hooks/useResolverInput";
import {
  partitionMatchOptions,
  type MatchOption,
} from "../../lib/workspace/resolve";

// =============================================================================
// IdentityLinkControl — the "Link to…" / "Unlink" affordance on the external
// author profile (Slice 8 P2/P3). Asserts that the viewed author is the same
// person cross-posting under another source; the gateway records an owner-scoped
// `user_asserted` link the feed-dedup CTEs consume (drop the loser twin, surface
// "ALSO ON …"). One reader's claim, scoped to that reader.
//
// The chip list also renders GLOBAL links the P3 detection task found (tagged
// "DETECTED"); unlinking one isn't a delete (it's not yours) — the gateway writes
// an owner-scoped tombstone that hides the merge for you only.
//
// Omnivorous input via the universal resolver (paste a URL / handle / npub /
// DID); only external_source matches are linkable (a native account or #tag
// isn't another platform's identity). The chosen match's { protocol, sourceUri }
// is sent to POST /author/:id/links, which upserts the source and inserts the
// link. Lives in AuthorProfileView's actions cell beside ProfileFollowControl.
// =============================================================================

const PROTOCOL_LABELS: Record<string, string> = {
  rss: "RSS",
  atproto: "BLUESKY",
  activitypub: "FEDIVERSE",
  nostr_external: "NOSTR",
  email: "EMAIL",
};

function protoLabel(p: string): string {
  return PROTOCOL_LABELS[p] ?? p.toUpperCase();
}

export function IdentityLinkControl({
  authorId,
  initial,
}: {
  authorId: string;
  initial?: LinkedSource[];
}) {
  const [links, setLinks] = useState<LinkedSource[]>(initial ?? []);
  const [open, setOpen] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const ri = useResolverInput({ maxPolls: 3, context: "subscribe" });
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Server is the source of truth across remounts (e.g. an overlay reopen).
  useEffect(() => {
    setLinks(initial ?? []);
  }, [initial]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    function onPointerDown(e: PointerEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Only resolver matches carrying a { protocol, sourceUri } (the external-source
  // variant the resolver always emits — never the externalSourceId variant) are
  // linkable, and a target already linked is filtered out (no duplicate
  // assertions). `"protocol" in m.add` narrows the AddWorkspaceFeedSourceInput
  // union for the rest of the expression.
  const linkable = ri.matches.filter((m) => {
    if (!("protocol" in m.add) || !("sourceUri" in m.add)) return false;
    const { protocol, sourceUri } = m.add;
    return !links.some(
      (l) => l.protocol === protocol && l.sourceUri === sourceUri,
    );
  });
  // Confidence tiers (RESOLVER-DISCOVERY-ADR §6.4), partitioned AFTER the
  // linkable filter so section headers never label filtered-out rows.
  const linkableSections = partitionMatchOptions(linkable);

  const addLink = useCallback(
    async (key: string, protocol: string, sourceUri: string) => {
      if (busyKey) return;
      setBusyKey(key);
      setError(null);
      try {
        const { linkedSource } = await createIdentityLink(
          authorId,
          protocol,
          sourceUri,
        );
        setLinks((prev) =>
          prev.some((l) => l.linkId === linkedSource.linkId)
            ? prev
            : [...prev, linkedSource],
        );
        ri.reset();
        invalidateAuthorCardCache();
      } catch {
        setError("Couldn’t link that. Try a different identifier.");
      } finally {
        setBusyKey(null);
      }
    },
    [authorId, busyKey, ri],
  );

  const removeLink = useCallback(
    async (linkId: string) => {
      if (removing.has(linkId)) return;
      setRemoving((prev) => new Set(prev).add(linkId));
      setError(null);
      try {
        await deleteIdentityLink(authorId, linkId);
        setLinks((prev) => prev.filter((l) => l.linkId !== linkId));
        invalidateAuthorCardCache();
      } catch {
        setError("Couldn’t unlink. Try again.");
      } finally {
        setRemoving((prev) => {
          const next = new Set(prev);
          next.delete(linkId);
          return next;
        });
      }
    },
    [authorId, removing],
  );

  const count = links.length;

  const renderLinkOption = (opt: MatchOption) => {
    // Narrowed to the { protocol, sourceUri } variant by the linkable
    // filter above (TS can't carry that across the .filter).
    const add = opt.add as Extract<typeof opt.add, { protocol: string }>;
    return (
      <button
        key={opt.key}
        onClick={() => void addLink(opt.key, add.protocol, add.sourceUri)}
        disabled={busyKey === opt.key}
        className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-ui-xs text-black hover:bg-glasshouse-well transition-colors disabled:opacity-50"
      >
        <span className="truncate">{opt.label}</span>
        <span className="label-ui text-grey-600">
          {busyKey === opt.key ? "…" : protoLabel(add.protocol)}
        </span>
      </button>
    );
  };

  return (
    // C4: the tag rides the wrapper so the trigger and the open menu both
    // answer as identity linking.
    <div
      ref={wrapRef}
      data-explain="profile.identityLinks"
      className="relative inline-block"
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className={`transition-colors py-1.5 px-4 text-ui-xs ${
          count > 0 ? "btn-soft" : "btn-ghost"
        }`}
      >
        {count > 0 ? `Linked · ${count}` : "Link to…"}{" "}
        <span aria-hidden>▾</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-72 bg-glasshouse shadow-lg p-2">
          {count > 0 && (
            <div className="mb-2 flex flex-col gap-1">
              <p className="label-ui text-grey-600 px-1">SAME PERSON ON</p>
              {links.map((l) => (
                <div
                  key={l.linkId}
                  className="flex items-center justify-between gap-2 px-1 py-1"
                >
                  <span className="min-w-0 flex-1 text-ui-xs text-black">
                    <span className="truncate">
                      {l.displayName || l.sourceUri}
                    </span>{" "}
                    <span className="label-ui text-grey-600">
                      {protoLabel(l.protocol)}
                    </span>
                    {l.detected && (
                      // A global automated link (P3 detection), not the viewer's
                      // own assertion — so unlink hides it for them (a tombstone),
                      // it isn't theirs to delete.
                      <span className="label-ui text-grey-600" title="Automatically detected">
                        {" · DETECTED"}
                      </span>
                    )}
                  </span>
                  <button
                    onClick={() => void removeLink(l.linkId)}
                    disabled={removing.has(l.linkId)}
                    aria-label={l.detected ? "Stop merging this source" : "Unlink"}
                    className="flex-shrink-0 text-grey-400 hover:text-black transition-colors disabled:opacity-50"
                  >
                    {removing.has(l.linkId) ? "…" : "✕"}
                  </button>
                </div>
              ))}
            </div>
          )}

          <p className="label-ui text-grey-600 px-1 mb-1.5">LINK ANOTHER</p>
          <input
            ref={inputRef}
            type="text"
            value={ri.query}
            onChange={(e) => ri.onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                ri.submit();
              }
            }}
            placeholder="URL, handle, npub, DID…"
            className="w-full bg-glasshouse-well px-2 py-1.5 text-ui-sm text-black placeholder:text-grey-300 focus:outline-none"
          />

          <div className="mt-1.5 min-h-[24px]">
            {ri.resolving && (
              <p className="label-ui text-grey-600 px-1 py-1">RESOLVING…</p>
            )}
            {!ri.resolving && (ri.doneEmpty || ri.resolveError) && (
              <p className="text-ui-xs text-grey-600 px-1 py-1">
                No match. Press Enter to search, or paste a full URL.
              </p>
            )}
            {linkable.length > 0 && (
              // Confidence tiers (§6.4): MATCHES (exact + probable), then
              // SUGGESTIONS (speculative). Glasshouse surface — headers are
              // .label-ui text-grey-600, the local idiom. The MATCHES header
              // only appears when both sections are present.
              <div className="flex flex-col gap-0.5">
                {linkableSections.matches.length > 0 &&
                  linkableSections.suggestions.length > 0 && (
                    <p className="label-ui text-grey-600 px-1 pt-1">MATCHES</p>
                  )}
                {linkableSections.matches.map(renderLinkOption)}
                {linkableSections.suggestions.length > 0 && (
                  <p className="label-ui text-grey-600 px-1 pt-1">
                    SUGGESTIONS
                  </p>
                )}
                {linkableSections.suggestions.map(renderLinkOption)}
              </div>
            )}
          </div>

          {error && (
            <p className="text-ui-xs text-crimson px-1 pt-1">{error}</p>
          )}
        </div>
      )}
    </div>
  );
}

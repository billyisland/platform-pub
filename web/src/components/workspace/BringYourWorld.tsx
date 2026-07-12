"use client";

// =============================================================================
// BringYourWorld — the first-session "Bring your world" sheet (FOLLOW-GRAPH-
// IMPORT-ADR §7.4 / Phase 3). There is no signup wizard yet (CONSOLIDATED-TODO
// §3.3 is unbuilt), so the step rides the one first-session signal the
// workspace has: the bootstrap that mints the founder feed (zero feeds =
// brand-new account). WorkspaceView mounts this lazily, once per user
// (localStorage seen-key, written only when the sheet is actually dismissed).
//
// Strictly an offer (ADR D7): nothing imports until the user acts inside, and
// dismissing costs nothing — the same paths stay reachable forever in the
// Network panel and the FeedComposer. Renders nothing when the server
// capabilities expose no importable protocol and no OPML (FOLLOW_IMPORT_ENABLED
// dark ⇒ no sheet; the ✕ never renders so the caller never burns the
// seen-key).
// =============================================================================

import { useEffect, useState } from "react";
import { Glasshouse } from "./Glasshouse";
import { FollowImportSection } from "../network/FollowImportSection";
import { useFollowImportRun } from "../../hooks/useFollowImportRun";
import { getNetworkCapabilities } from "../../lib/api/linked-accounts";

export function BringYourWorld({ onClose }: { onClose: () => void }) {
  const followImport = useFollowImportRun();
  const [caps, setCaps] = useState<{
    importable: string[];
    opml: boolean;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    getNetworkCapabilities()
      .then((c) => {
        if (cancelled) return;
        setCaps({
          importable: c?.followImportProtocols ?? [],
          opml: c?.followImportOpml ?? false,
        });
      })
      .catch(() => {
        if (!cancelled) setCaps({ importable: [], opml: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Capabilities still loading, or import dark server-side: no sheet. Not a
  // loading state — the offer either appears complete or not at all.
  if (!caps || (caps.importable.length === 0 && !caps.opml)) return null;

  return (
    <Glasshouse onClose={onClose} maxWidth={620} ariaLabel="Bring your world">
      <div className="px-6 sm:px-10 py-10">
        <h1 className="font-sans text-2xl font-medium text-black tracking-tight">
          Bring your world
        </h1>
        <p className="text-ui-sm text-grey-600 mt-2 leading-relaxed">
          You don&rsquo;t have to start from an empty room. If you already
          follow people somewhere else, all.haus can rebuild that reading life
          here as a feed — and nothing changes on the other network.
        </p>
        <div className="mt-8">
          <FollowImportSection
            importable={caps.importable}
            opml={caps.opml}
            followImport={followImport}
          />
        </div>
        <p className="text-ui-xs text-grey-600 mt-8 leading-relaxed">
          No rush — this lives in the Network panel and every feed&rsquo;s
          &ldquo;Add a source&rdquo; field whenever you&rsquo;re ready. Started
          imports keep filling in the background.
        </p>
      </div>
    </Glasshouse>
  );
}

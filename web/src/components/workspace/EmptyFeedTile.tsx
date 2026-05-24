"use client";

import { useState } from "react";

interface EmptyFeedTileProps {
  variant: "no-sources" | "no-items";
  onAddSources?: () => void;
}

export function EmptyFeedTile({ variant, onAddSources }: EmptyFeedTileProps) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  if (variant === "no-sources") {
    return (
      <div className="px-6 py-8 text-center">
        <p className="label-ui text-grey-400 mb-2">NO SOURCES</p>
        <p className="text-ui-xs text-grey-500 mb-4">
          Add feeds, accounts, or publications to fill this vessel.
        </p>
        {onAddSources && (
          <button type="button" className="btn-accent" onClick={onAddSources}>
            ADD SOURCES
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="px-6 py-8 text-center">
      <p className="label-ui text-grey-400 mb-2">ALL CAUGHT UP</p>
      <p className="text-ui-xs text-grey-500 mb-4">
        No new items. Add more sources or check back later.
      </p>
      <div className="flex items-center justify-center gap-4">
        {onAddSources && (
          <button
            type="button"
            className="btn-text-muted"
            onClick={onAddSources}
          >
            ADD MORE
          </button>
        )}
        <button
          type="button"
          className="btn-text-muted"
          onClick={() => setDismissed(true)}
        >
          DISMISS
        </button>
      </div>
    </div>
  );
}

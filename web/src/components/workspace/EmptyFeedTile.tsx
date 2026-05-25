"use client";

interface EmptyFeedTileProps {
  variant: "no-sources" | "no-items" | "caught-up";
  onAddSources?: () => void;
  onDismiss?: () => void;
}

export function EmptyFeedTile({
  variant,
  onAddSources,
  onDismiss,
}: EmptyFeedTileProps) {
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

  if (variant === "caught-up") {
    return (
      <div className="px-4 py-4 text-center">
        <p className="text-ui-xs text-grey-500 mb-3">
          You&rsquo;re caught up. Add new sources or strengthen current ones to
          see more.
        </p>
        <div className="flex items-center justify-center gap-4">
          {onAddSources && (
            <button
              type="button"
              className="btn-text-muted"
              onClick={() => {
                onDismiss?.();
                onAddSources();
              }}
            >
              ADD SOURCES
            </button>
          )}
          <button
            type="button"
            className="btn-text-muted"
            onClick={() => onDismiss?.()}
          >
            DISMISS
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="px-6 py-8 text-center">
      <p className="label-ui text-grey-400 mb-2">NO ITEMS YET</p>
      <p className="text-ui-xs text-grey-500 mb-4">
        No new items. Add more sources or check back later.
      </p>
      {onAddSources && (
        <button type="button" className="btn-text-muted" onClick={onAddSources}>
          ADD MORE
        </button>
      )}
    </div>
  );
}

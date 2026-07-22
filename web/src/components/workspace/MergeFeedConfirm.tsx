"use client";

import { useEffect, useRef, useState } from "react";
import { apiErrorMessage } from "../../lib/api/client";

const TOKENS = {
  scrim: "rgb(var(--ah-ink-925-rgb) / 0.4)",
  panelBg: "var(--ah-white)",
  panelFg: "var(--ah-ink-925)",
  errorFg: "var(--ah-crimson)",
  primaryBg: "var(--ah-ink-925)",
  primaryFg: "var(--ah-bone)",
  primaryDisabled: "var(--ah-grey-300)",
};

interface MergeFeedConfirmProps {
  open: boolean;
  sourceName: string;
  targetName: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

export function MergeFeedConfirm({
  open,
  sourceName,
  targetName,
  onClose,
  onConfirm,
}: MergeFeedConfirmProps) {
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrimRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setMerging(false);
    setError(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !merging) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, merging]);

  if (!open) return null;

  async function handleConfirm() {
    if (merging) return;
    setMerging(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      // Prefer the server's own copy (the starter-template refusal explains what
      // to do); ApiError.message is the raw "API error 409: {...}" dump.
      setError(apiErrorMessage(err) ?? "Merge failed.");
      setMerging(false);
    }
  }

  function onScrimClick(e: React.MouseEvent) {
    if (e.target === scrimRef.current && !merging) onClose();
  }

  return (
    <div
      ref={scrimRef}
      onMouseDown={onScrimClick}
      role="dialog"
      aria-modal="true"
      aria-label="Merge feeds"
      style={{
        position: "fixed",
        inset: 0,
        background: TOKENS.scrim,
        zIndex: 60,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: 144,
      }}
    >
      <div
        style={{
          width: 420,
          maxWidth: "calc(100vw - 48px)",
          background: TOKENS.panelBg,
          // No enclosing rule — lifted by its shadow alone, per the Glasshouse
          // grammar. (Removed 2026-07-22; see the no-thin-line invariant.)
          padding: 24,
          boxShadow: "0 24px 48px rgba(0, 0, 0, 0.18)",
        }}
      >
        <p
          className="font-sans text-ui-sm leading-[1.5]"
          style={{ color: TOKENS.panelFg, marginBottom: 16 }}
        >
          Merge <strong>{sourceName}</strong> into <strong>{targetName}</strong>
          ? Sources will be combined. <strong>{sourceName}</strong> will be
          deleted.
        </p>

        {/* Own line, not inline beside the buttons: a server refusal is a full
            sentence (the starter-template guard) and would otherwise squeeze
            the actions out of the 420px panel. */}
        {error && (
          <p
            className="font-mono text-mono-xs leading-[1.5]"
            style={{ color: TOKENS.errorFg, marginBottom: 16 }}
          >
            {error}
          </p>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 16,
          }}
        >
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={onClose}
              disabled={merging}
              className="font-sans text-ui-xs"
              style={{
                padding: "8px 14px",
                background: "transparent",
                color: TOKENS.panelFg,
                border: "none",
                cursor: merging ? "default" : "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={merging}
              className="font-sans text-ui-xs"
              style={{
                padding: "8px 16px",
                background: merging ? TOKENS.primaryDisabled : TOKENS.primaryBg,
                color: TOKENS.primaryFg,
                border: "none",
                cursor: merging ? "default" : "pointer",
              }}
            >
              {merging ? "Merging…" : "Merge"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

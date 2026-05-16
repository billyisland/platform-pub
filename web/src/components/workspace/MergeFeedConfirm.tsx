"use client";

import { useEffect, useRef, useState } from "react";

const TOKENS = {
  scrim: "rgba(26, 26, 24, 0.4)",
  panelBg: "#FFFFFF",
  panelBorder: "#1A1A18",
  hintFg: "#8A8880",
  errorFg: "#B5242A",
  primaryBg: "#1A1A18",
  primaryFg: "#F0EFEB",
  primaryDisabled: "#BBBBBB",
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
      setError(err instanceof Error ? err.message : "Merge failed.");
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
          border: `1px solid ${TOKENS.panelBorder}`,
          padding: 24,
          boxShadow: "0 24px 48px rgba(0, 0, 0, 0.18)",
        }}
      >
        <p
          className="font-sans text-ui-sm leading-[1.5]"
          style={{ color: TOKENS.panelBorder, marginBottom: 16 }}
        >
          Merge <strong>{sourceName}</strong> into <strong>{targetName}</strong>
          ? Sources will be combined. <strong>{sourceName}</strong> will be
          deleted.
        </p>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <div
            className="font-mono text-mono-xs"
            style={{ color: TOKENS.hintFg }}
          >
            {error && <span style={{ color: TOKENS.errorFg }}>{error}</span>}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={onClose}
              disabled={merging}
              className="font-sans text-ui-xs"
              style={{
                padding: "8px 14px",
                background: "transparent",
                color: TOKENS.panelBorder,
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

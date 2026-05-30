"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  workspaceFeeds as workspaceFeedsApi,
  type WorkspaceFeed,
  type WorkspaceFeedSource,
} from "../../lib/api";
import { useResolverInput } from "../../hooks/useResolverInput";
import type { MatchOption } from "../../lib/workspace/resolve";
import {
  type Brightness,
  type Density,
  type Orientation,
  type TextSize,
  nextBrightness,
  nextDensity,
  nextOrientation,
  nextTextSize,
  DEFAULT_BRIGHTNESS,
  DEFAULT_DENSITY,
  DEFAULT_ORIENTATION,
  DEFAULT_TEXT_SIZE,
} from "./tokens";

const VOLUME_WEIGHTS = [1.0, 0.25, 0.5, 1.0, 2.0, 4.0];
function weightToStep(weight: number): number {
  let best = 3;
  let bestDelta = Infinity;
  for (let s = 1; s <= 5; s++) {
    const d = Math.abs(VOLUME_WEIGHTS[s] - weight);
    if (d < bestDelta) {
      bestDelta = d;
      best = s;
    }
  }
  return best;
}

const TOKENS = {
  scrim: "rgba(26, 26, 24, 0.4)",
  panelBg: "#FFFFFF",
  panelBorder: "#1A1A18",
  rowBg: "#F0EFEB",
  hintFg: "#8A8880",
  errorFg: "#B5242A",
  inputBorder: "#E6E5E0",
  closeBg: "#1A1A18",
  closeFg: "#F0EFEB",
  matchHoverBg: "#F0EFEB",
  removeFg: "#8A8880",
  removeHoverFg: "#B5242A",
};

interface FeedComposerProps {
  feed: WorkspaceFeed | null;
  open: boolean;
  onClose: () => void;
  onSourcesChanged?: () => void;
  onRenamed?: (feed: WorkspaceFeed) => void;
  onDeleted?: (feedId: string) => void;
  /** When true, the composer refuses to delete this feed and surfaces a hint
   *  explaining why. Used to prevent the user from deleting their last feed
   *  (which would leave the floor empty until next bootstrap reseeds). */
  deleteBlocked?: boolean;
  // Appearance controls (moved off the vessel bar — task 8). Current values +
  // commit callbacks, wired from WorkspaceView against the workspace store.
  brightness?: Brightness;
  density?: Density;
  orientation?: Orientation;
  textSize?: TextSize;
  onBrightnessChange?: (b: Brightness) => void;
  onDensityChange?: (d: Density) => void;
  onOrientationChange?: (o: Orientation) => void;
  onTextSizeChange?: (t: TextSize) => void;
}

const NAME_LIMIT = 80;

export function FeedComposer({
  feed,
  open,
  onClose,
  onSourcesChanged,
  onRenamed,
  onDeleted,
  deleteBlocked,
  brightness,
  density,
  orientation,
  textSize,
  onBrightnessChange,
  onDensityChange,
  onOrientationChange,
  onTextSizeChange,
}: FeedComposerProps) {
  const [sources, setSources] = useState<WorkspaceFeedSource[]>([]);
  const [loading, setLoading] = useState(false);
  const ri = useResolverInput({ maxPolls: 3 });
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);

  const refreshSources = useCallback(async (feedId: string) => {
    setLoading(true);
    try {
      const data = await workspaceFeedsApi.listSources(feedId);
      setSources(data.sources);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sources.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open || !feed) return;
    ri.reset();
    setBusyKey(null);
    setError(null);
    setEditingName(false);
    setNameDraft("");
    setSavingName(false);
    setConfirmingDelete(false);
    setDeleting(false);
    void refreshSources(feed.id);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, feed, onClose, refreshSources]);

  async function handleAdd(opt: MatchOption) {
    if (!feed || busyKey) return;
    setBusyKey(opt.key);
    setError(null);
    try {
      await workspaceFeedsApi.addSource(feed.id, opt.add);
      ri.reset();
      await refreshSources(feed.id);
      onSourcesChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add source.");
    } finally {
      setBusyKey(null);
    }
  }

  function startRename() {
    if (!feed) return;
    setNameDraft(feed.name);
    setEditingName(true);
    setError(null);
    // Focus on next tick after the input mounts.
    setTimeout(() => nameInputRef.current?.select(), 0);
  }

  function cancelRename() {
    setEditingName(false);
    setNameDraft("");
  }

  async function commitRename() {
    if (!feed || savingName) return;
    const trimmed = nameDraft.trim();
    if (trimmed.length > NAME_LIMIT) {
      setError(`Name must be ${NAME_LIMIT} characters or fewer.`);
      return;
    }
    if (trimmed === feed.name) {
      setEditingName(false);
      return;
    }
    setSavingName(true);
    setError(null);
    try {
      const { feed: updated } = await workspaceFeedsApi.rename(
        feed.id,
        trimmed,
      );
      onRenamed?.(updated);
      setEditingName(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rename feed.");
    } finally {
      setSavingName(false);
    }
  }

  async function handleDelete() {
    if (!feed || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await workspaceFeedsApi.remove(feed.id);
      onDeleted?.(feed.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete feed.");
      setDeleting(false);
      setConfirmingDelete(false);
    }
  }

  async function handleRemove(sourceId: string) {
    if (!feed) return;
    setBusyKey(`remove:${sourceId}`);
    setError(null);
    try {
      await workspaceFeedsApi.removeSource(feed.id, sourceId);
      await refreshSources(feed.id);
      onSourcesChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove source.");
    } finally {
      setBusyKey(null);
    }
  }

  function onScrimClick(e: React.MouseEvent) {
    if (e.target === scrimRef.current) onClose();
  }

  if (!open || !feed) return null;

  return (
    <div
      ref={scrimRef}
      onMouseDown={onScrimClick}
      role="dialog"
      aria-modal="true"
      aria-label={`Feed composer: ${feed.name}`}
      style={{
        position: "fixed",
        inset: 0,
        background: TOKENS.scrim,
        zIndex: 60,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: 96,
      }}
    >
      <div
        style={{
          width: 520,
          maxWidth: "calc(100vw - 48px)",
          background: TOKENS.panelBg,
          border: `1px solid ${TOKENS.panelBorder}`,
          padding: 24,
          boxShadow: "0 24px 48px rgba(0, 0, 0, 0.18)",
          maxHeight: "calc(100vh - 144px)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            marginBottom: 16,
            gap: 12,
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="label-ui" style={{ color: TOKENS.hintFg }}>
              Feed composer
            </div>
            {editingName ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginTop: 2,
                }}
              >
                <input
                  ref={nameInputRef}
                  type="text"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void commitRename();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancelRename();
                    }
                  }}
                  placeholder="Optional descriptive name"
                  className="font-sans text-[18px]"
                  style={{
                    flex: 1,
                    border: `1px solid ${TOKENS.inputBorder}`,
                    padding: "6px 8px",
                    outline: "none",
                    color: TOKENS.panelBorder,
                  }}
                />
                <button
                  type="button"
                  onClick={() => void commitRename()}
                  disabled={savingName}
                  className="label-ui"
                  style={{
                    padding: "6px 10px",
                    background: "transparent",
                    color: TOKENS.panelBorder,
                    border: "none",
                    cursor: savingName ? "default" : "pointer",
                  }}
                >
                  {savingName ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={cancelRename}
                  disabled={savingName}
                  className="label-ui"
                  style={{
                    padding: "6px 10px",
                    background: "transparent",
                    color: TOKENS.hintFg,
                    border: "none",
                    cursor: savingName ? "default" : "pointer",
                  }}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginTop: 2,
                }}
              >
                {feed.name ? (
                  <div
                    className="font-sans text-[18px]"
                    style={{
                      color: TOKENS.panelBorder,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {feed.name}
                  </div>
                ) : (
                  <div
                    className="font-sans text-[18px]"
                    style={{
                      color: TOKENS.hintFg,
                      fontStyle: "italic",
                    }}
                  >
                    No name
                  </div>
                )}
                <button
                  type="button"
                  onClick={startRename}
                  className="label-ui"
                  style={{
                    padding: "4px 8px",
                    background: "transparent",
                    color: TOKENS.hintFg,
                    border: "none",
                    cursor: "pointer",
                  }}
                >
                  {feed.name ? "Rename" : "Add name"}
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="label-ui"
            style={{
              padding: "6px 10px",
              background: "transparent",
              color: TOKENS.hintFg,
              border: "none",
              cursor: "pointer",
            }}
          >
            Close
          </button>
        </div>

        <div
          className="label-ui"
          style={{ color: TOKENS.hintFg, marginBottom: 6 }}
        >
          Sources
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            marginBottom: 16,
            overflowY: "auto",
          }}
        >
          {loading && (
            <div
              className="font-mono text-mono-xs"
              style={{ color: TOKENS.hintFg }}
            >
              LOADING…
            </div>
          )}
          {!loading && sources.length === 0 && (
            <div
              className="font-mono text-mono-xs"
              style={{ color: TOKENS.hintFg }}
            >
              No sources yet — this feed shows the explore stream until you add
              one.
            </div>
          )}
          {sources.map((s) => (
            <SourceRow
              key={s.id}
              source={s}
              feedId={feed.id}
              busy={busyKey === `remove:${s.id}`}
              onRemove={() => void handleRemove(s.id)}
              onChanged={(updated) => {
                setSources((prev) =>
                  prev.map((p) => (p.id === updated.id ? updated : p)),
                );
                onSourcesChanged?.();
              }}
            />
          ))}
        </div>

        <div
          className="label-ui"
          style={{ color: TOKENS.hintFg, marginBottom: 6 }}
        >
          Add a source
        </div>
        <input
          ref={inputRef}
          type="text"
          value={ri.query}
          onChange={(e) => ri.onQueryChange(e.target.value)}
          placeholder="Username, URL, npub, DID, #tag…"
          className="font-sans text-ui-sm w-full"
          style={{
            border: `1px solid ${TOKENS.inputBorder}`,
            padding: "10px 12px",
            outline: "none",
            marginBottom: 8,
          }}
        />
        <div style={{ minHeight: 24 }}>
          {ri.resolving && (
            <div
              className="font-mono text-mono-xs"
              style={{ color: TOKENS.hintFg }}
            >
              RESOLVING…
            </div>
          )}
          {(ri.doneEmpty || ri.resolveError) && (
            <div
              className="font-mono text-mono-xs"
              style={{ color: TOKENS.hintFg }}
            >
              No match. Try a full URL, an @username, an npub, or a #tag.
            </div>
          )}
          {ri.matches.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {ri.matches.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => void handleAdd(opt)}
                  disabled={busyKey === opt.key}
                  className="font-sans text-ui-xs"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "8px 10px",
                    background: "transparent",
                    border: "none",
                    borderTop: `1px solid ${TOKENS.inputBorder}`,
                    color: TOKENS.panelBorder,
                    cursor: busyKey === opt.key ? "default" : "pointer",
                    textAlign: "left",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = TOKENS.matchHoverBg)
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = "transparent")
                  }
                >
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {opt.label}
                  </span>
                  {opt.sublabel && (
                    <span
                      className="label-ui"
                      style={{ color: TOKENS.hintFg, marginLeft: 12 }}
                    >
                      {opt.sublabel}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {error && (
          <div
            className="font-mono text-mono-xs"
            style={{ color: TOKENS.errorFg, marginTop: 12 }}
          >
            {error}
          </div>
        )}

        {(onBrightnessChange ||
          onDensityChange ||
          onOrientationChange ||
          onTextSizeChange) && (
          <>
            <div
              className="label-ui"
              style={{
                color: TOKENS.hintFg,
                marginTop: 20,
                marginBottom: 8,
              }}
            >
              Appearance
            </div>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 16,
              }}
            >
              {onBrightnessChange && (
                <AppearanceControl
                  label="Brightness"
                  glyph={
                    { primary: "○", medium: "◐", dim: "●" }[
                      brightness ?? DEFAULT_BRIGHTNESS
                    ]
                  }
                  onClick={() =>
                    onBrightnessChange(
                      nextBrightness(brightness ?? DEFAULT_BRIGHTNESS),
                    )
                  }
                />
              )}
              {onDensityChange && (
                <AppearanceControl
                  label="View"
                  glyph={
                    {
                      compact: "Condensed",
                      standard: "Standard",
                      full: "Full",
                    }[density ?? DEFAULT_DENSITY]
                  }
                  onClick={() =>
                    onDensityChange(nextDensity(density ?? DEFAULT_DENSITY))
                  }
                />
              )}
              {onOrientationChange && (
                <AppearanceControl
                  label="Orientation"
                  glyph={
                    { vertical: "|", horizontal: "─" }[
                      orientation ?? DEFAULT_ORIENTATION
                    ]
                  }
                  onClick={() =>
                    onOrientationChange(
                      nextOrientation(orientation ?? DEFAULT_ORIENTATION),
                    )
                  }
                />
              )}
              {onTextSizeChange && (
                <AppearanceControl
                  label="Text size"
                  glyph={
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "baseline",
                        gap: 2,
                      }}
                    >
                      <span style={{ fontSize: 18, lineHeight: 1 }}>Ɐ</span>
                      <span style={{ fontSize: 12, lineHeight: 1 }}>Ɐ</span>
                    </span>
                  }
                  indicator={`${textSize ?? DEFAULT_TEXT_SIZE}/5`}
                  onClick={() =>
                    onTextSizeChange(nextTextSize(textSize ?? DEFAULT_TEXT_SIZE))
                  }
                />
              )}
            </div>
          </>
        )}

        <div
          style={{
            marginTop: 20,
            paddingTop: 16,
            borderTop: `1px solid ${TOKENS.inputBorder}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
            minHeight: 32,
          }}
        >
          {deleteBlocked ? (
            <div
              className="font-mono text-mono-xs"
              style={{ color: TOKENS.hintFg }}
            >
              Can&rsquo;t delete your only feed — create another first.
            </div>
          ) : confirmingDelete ? (
            <>
              <div
                className="font-mono text-mono-xs"
                style={{ color: TOKENS.hintFg, marginRight: "auto" }}
              >
                Delete this feed? Sources are removed; subscriptions are kept.
              </div>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                disabled={deleting}
                className="label-ui"
                style={{
                  padding: "6px 10px",
                  background: "transparent",
                  color: TOKENS.hintFg,
                  border: "none",
                  cursor: deleting ? "default" : "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={deleting}
                className="label-ui"
                style={{
                  padding: "6px 10px",
                  background: "transparent",
                  color: TOKENS.errorFg,
                  border: "none",
                  cursor: deleting ? "default" : "pointer",
                }}
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="label-ui"
              style={{
                padding: "6px 10px",
                background: "transparent",
                color: TOKENS.removeFg,
                border: "none",
                cursor: "pointer",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.color = TOKENS.errorFg)
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.color = TOKENS.removeFg)
              }
            >
              Delete feed
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function AppearanceControl({
  label,
  glyph,
  indicator,
  onClick,
}: {
  label: string;
  glyph: React.ReactNode;
  indicator?: string;
  onClick: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div className="label-ui" style={{ color: TOKENS.hintFg }}>
        {label}
      </div>
      <button
        type="button"
        onClick={onClick}
        className="font-sans text-ui-sm"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          minWidth: 88,
          padding: "6px 10px",
          background: "transparent",
          border: `1px solid ${TOKENS.inputBorder}`,
          color: TOKENS.panelBorder,
          cursor: "pointer",
        }}
        onMouseEnter={(e) =>
          (e.currentTarget.style.background = TOKENS.matchHoverBg)
        }
        onMouseLeave={(e) =>
          (e.currentTarget.style.background = "transparent")
        }
      >
        <span style={{ display: "inline-flex", alignItems: "center" }}>
          {glyph}
        </span>
        {indicator && (
          <span className="label-ui" style={{ color: TOKENS.hintFg }}>
            {indicator}
          </span>
        )}
      </button>
    </div>
  );
}

function SourceRow({
  source,
  feedId,
  busy,
  onRemove,
  onChanged,
}: {
  source: WorkspaceFeedSource;
  feedId: string;
  busy: boolean;
  onRemove: () => void;
  onChanged: (updated: WorkspaceFeedSource) => void;
}) {
  const [committing, setCommitting] = useState(false);
  const isMuted = source.mutedAt !== null;
  const currentStep = isMuted ? 0 : weightToStep(source.weight);
  const sampling = source.samplingMode as "random" | "top";

  async function commitStep(nextStep: number) {
    if (committing) return;
    setCommitting(true);
    try {
      const { source: updated } = await workspaceFeedsApi.patchSource(
        feedId,
        source.id,
        { step: nextStep, muted: nextStep === 0 },
      );
      onChanged(updated);
    } finally {
      setCommitting(false);
    }
  }

  async function commitSampling(next: "random" | "top") {
    if (committing) return;
    setCommitting(true);
    try {
      const { source: updated } = await workspaceFeedsApi.patchSource(
        feedId,
        source.id,
        { sampling: next },
      );
      onChanged(updated);
    } finally {
      setCommitting(false);
    }
  }

  return (
    <div style={{ background: TOKENS.rowBg, padding: "8px 10px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div
            className="font-sans text-ui-xs"
            style={{
              color: isMuted ? TOKENS.hintFg : TOKENS.panelBorder,
              overflow: "hidden",
              textOverflow: "ellipsis",
              textDecoration: isMuted ? "line-through" : undefined,
            }}
          >
            {source.display.label}
          </div>
          {source.display.sublabel && (
            <div className="label-ui" style={{ color: TOKENS.hintFg }}>
              {source.display.sublabel}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          aria-label={`Remove ${source.display.label}`}
          style={{
            background: "transparent",
            border: "none",
            color: TOKENS.removeFg,
            cursor: "pointer",
            fontSize: 16,
            padding: "4px 8px",
          }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.color = TOKENS.removeHoverFg)
          }
          onMouseLeave={(e) => (e.currentTarget.style.color = TOKENS.removeFg)}
        >
          ×
        </button>
      </div>

      {/* Volume: 0=mute, 1..5 = quieter→louder. Step 3 = default weight. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 3,
          marginTop: 6,
        }}
      >
        {[0, 1, 2, 3, 4, 5].map((s) => {
          const active = !isMuted && s > 0 && s <= currentStep;
          const muteActive = isMuted && s === 0;
          return (
            <button
              key={s}
              type="button"
              onClick={() => void commitStep(s)}
              disabled={committing}
              aria-label={s === 0 ? "Mute" : `Volume ${s}`}
              style={{
                width: s === 0 ? 20 : 16,
                height: 16,
                background: muteActive
                  ? TOKENS.errorFg
                  : active
                    ? TOKENS.panelBorder
                    : TOKENS.inputBorder,
                border: "none",
                cursor: committing ? "default" : "pointer",
                padding: 0,
                fontSize: 9,
                color: muteActive ? "#FFFFFF" : TOKENS.hintFg,
                fontFamily: "IBM Plex Mono, ui-monospace, monospace",
              }}
            >
              {s === 0 ? "×" : ""}
            </button>
          );
        })}

        {!isMuted && (
          <div style={{ display: "flex", gap: 3, marginLeft: 6 }}>
            {(["random", "top"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => void commitSampling(mode)}
                disabled={committing}
                className="font-mono text-[10px] uppercase tracking-[0.04em]"
                style={{
                  background:
                    sampling === mode ? TOKENS.panelBorder : "transparent",
                  color: sampling === mode ? "#FFFFFF" : TOKENS.hintFg,
                  border: `1px solid ${sampling === mode ? TOKENS.panelBorder : TOKENS.inputBorder}`,
                  cursor: committing ? "default" : "pointer",
                  padding: "2px 6px",
                }}
              >
                {mode}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  workspaceFeeds as workspaceFeedsApi,
  type WorkspaceFeed,
  type WorkspaceFeedSource,
} from "../../lib/api";
import { apiErrorMessage } from "../../lib/api/client";
import { useResolverInput } from "../../hooks/useResolverInput";
import type { MatchOption } from "../../lib/workspace/resolve";
import { Glasshouse } from "./Glasshouse";
import { AuthorModal, useAuthorHover } from "../feed/AuthorModal";
import { openProfileHref, isModifiedClick } from "../ui/ProfileLink";
import { openSurfaceHref } from "../../stores/surfaceOverlay";
import { LIGHT_ISLAND_STYLE } from "../../lib/palette/island";
import { useColorScheme } from "../../stores/colorScheme";
import {
  type FeedScheme,
  type Density,
  type Orientation,
  type TextSize,
  nextDensity,
  nextOrientation,
  nextTextSize,
  nextScheme,
  normalizeBrightness,
  paletteFor,
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

// The composer is an always-light Glasshouse surface (warm mid-light pane, dark
// text), so these are fixed tokens, not a brightness palette. Separation is fill
// + space — no borders anywhere (the site never renders thin rules). Fields read
// as bright (white) raised wells on the pane; rows are a lighter tile; emphasis
// is a dark fill.
const TOKENS = {
  panelBorder: "var(--ah-ink-925)",
  rowBg: "var(--ah-bone)",
  fieldBg: "var(--ah-white)",
  hintFg: "var(--ah-grey-600)",
  errorFg: "var(--ah-crimson)",
  matchHoverBg: "var(--ah-bone)",
  removeFg: "var(--ah-grey-600)",
  removeHoverFg: "var(--ah-crimson)",
  // The hover author-card portals above the Glasshouse pane (z-56); 70 also
  // clears the ForallMenu (z-60) so the transient card is never clipped.
  hoverZ: 70,
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
  // commit callbacks, wired from WorkspaceView against the workspace store
  // (and, for scheme, the server-side feeds.appearance — feature-debt §3).
  scheme?: FeedScheme;
  density?: Density;
  orientation?: Orientation;
  textSize?: TextSize;
  onSchemeChange?: (s: FeedScheme) => void;
  onDensityChange?: (d: Density) => void;
  onOrientationChange?: (o: Orientation) => void;
  onTextSizeChange?: (t: TextSize) => void;
  // Drag-to-rank (MOBILE-LAYOUT-ADR §VII.4): the caller's complete feed set
  // and a commit callback. The rank order is the numeral and the mobile swipe
  // order; the list shows every feed (hidden ones unnumbered, per §V).
  allFeeds?: WorkspaceFeed[];
  onReorder?: (feedIds: string[]) => void;
  // Hide toggle (MOBILE-LAYOUT-ADR §V): hide is feed character on the feed
  // row. On mobile this sheet is the only hide affordance (no vessel bar);
  // on desktop it complements the vessel bar's hide button.
  hidden?: boolean;
  onHiddenChange?: (hidden: boolean) => void;
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
  scheme,
  density,
  orientation,
  textSize,
  onSchemeChange,
  onDensityChange,
  onOrientationChange,
  onTextSizeChange,
  allFeeds,
  onReorder,
  hidden,
  onHiddenChange,
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

  // Escape + scroll-lock are owned by Glasshouse; this effect only resets the
  // composer's own state and loads sources when it opens.
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
    return () => clearTimeout(t);
  }, [open, feed, refreshSources]);

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
      setError(apiErrorMessage(err) ?? "Failed to add source.");
    } finally {
      setBusyKey(null);
    }
  }

  const renderMatchOption = (opt: MatchOption) => (
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
  );

  // Reach (Following/Explore) is the global feed dial as a composable source —
  // no text to resolve, so it's a direct add rather than a resolver match.
  async function handleAddReach(reachKind: "following" | "explore") {
    if (!feed || busyKey) return;
    const key = `reach:${reachKind}`;
    setBusyKey(key);
    setError(null);
    try {
      await workspaceFeedsApi.addSource(feed.id, { sourceType: "reach", reachKind });
      await refreshSources(feed.id);
      onSourcesChanged?.();
    } catch (err) {
      setError(apiErrorMessage(err) ?? "Failed to add source.");
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

  if (!open || !feed) return null;

  const showAppearance =
    onSchemeChange ||
    onDensityChange ||
    onOrientationChange ||
    onTextSizeChange;

  return (
    <Glasshouse
      onClose={onClose}
      maxWidth={520}
      ariaLabel={`Feed composer: ${feed.name}`}
      persistKey="feed-composer"
    >
      {/* Right padding clears the Glasshouse ✕ at top-right. */}
      <div className="overflow-y-auto max-h-[var(--gh-h)]" style={{ padding: 24 }}>
        <div style={{ marginBottom: 16, paddingRight: 28 }}>
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
                    e.stopPropagation();
                    cancelRename();
                  }
                }}
                placeholder="Optional descriptive name"
                className="font-sans text-[18px]"
                style={{
                  flex: 1,
                  background: TOKENS.fieldBg,
                  border: "none",
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
            maxHeight: 320,
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
              }}
              onCommitted={() => onSourcesChanged?.()}
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
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              ri.submit();
            }
          }}
          placeholder="Username, URL, npub, DID, #tag…"
          className="font-sans text-ui-sm w-full"
          style={{
            background: TOKENS.fieldBg,
            border: "none",
            padding: "10px 12px",
            outline: "none",
            marginBottom: 8,
          }}
        />
        {/* Reserve the match well so resolving/results don't grow the pane. */}
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
              No match. Press Enter to search, or try a full URL, an @username,
              an npub, or a #tag.
            </div>
          )}
          {ri.matches.length > 0 && (
            // Confidence tiers rendered as two sections (§6.4): "Matches"
            // (exact + probable) and "Suggestions" (speculative discovery
            // nominations). The Matches header only appears when both
            // sections are present — alone it would be noise.
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {ri.sections.matches.length > 0 &&
                ri.sections.suggestions.length > 0 && (
                  <div
                    className="label-ui"
                    style={{ color: TOKENS.hintFg, padding: "2px 10px 0" }}
                  >
                    Matches
                  </div>
                )}
              {ri.sections.matches.map(renderMatchOption)}
              {ri.sections.suggestions.length > 0 && (
                <div
                  className="label-ui"
                  style={{
                    color: TOKENS.hintFg,
                    padding:
                      ri.sections.matches.length > 0
                        ? "8px 10px 0"
                        : "2px 10px 0",
                  }}
                >
                  Suggestions
                </div>
              )}
              {ri.sections.suggestions.map(renderMatchOption)}
            </div>
          )}
        </div>

        {/* Reach — the global Following/Explore dial as a composable source.
            Added directly (no text to resolve); removed via the list above.
            A chip for a reach already on the feed reads "added" and is inert. */}
        <div
          style={{ display: "flex", gap: 6, marginTop: 4, marginBottom: 4 }}
        >
          {(["following", "explore"] as const).map((kind) => {
            const present = sources.some(
              (s) => s.sourceType === "reach" && s.reachKind === kind,
            );
            const key = `reach:${kind}`;
            const labelText = kind === "following" ? "Following" : "Explore";
            return (
              <button
                key={key}
                type="button"
                onClick={() => void handleAddReach(kind)}
                disabled={present || busyKey === key}
                className="label-ui"
                style={{
                  padding: "6px 10px",
                  background: present ? "transparent" : TOKENS.fieldBg,
                  border: "none",
                  color: present ? TOKENS.hintFg : TOKENS.panelBorder,
                  cursor: present || busyKey === key ? "default" : "pointer",
                }}
                onMouseEnter={(e) => {
                  if (!present && busyKey !== key)
                    e.currentTarget.style.background = TOKENS.matchHoverBg;
                }}
                onMouseLeave={(e) => {
                  if (!present && busyKey !== key)
                    e.currentTarget.style.background = TOKENS.fieldBg;
                }}
              >
                {present ? `${labelText} · added` : `+ ${labelText}`}
              </button>
            );
          })}
        </div>

        {error && (
          <div
            className="font-mono text-mono-xs"
            style={{ color: TOKENS.errorFg, marginTop: 12 }}
          >
            {error}
          </div>
        )}

        {showAppearance && (
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
              {onSchemeChange && (
                <AppearanceControl
                  label="Colour"
                  glyph={<SchemeSwatch scheme={normalizeBrightness(scheme)} />}
                  onClick={() =>
                    onSchemeChange(nextScheme(scheme ?? DEFAULT_BRIGHTNESS))
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
                    <OrientationGlyph
                      orientation={orientation ?? DEFAULT_ORIENTATION}
                    />
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

        {onReorder && allFeeds && allFeeds.length > 1 && (
          <>
            <div
              className="label-ui"
              style={{
                color: TOKENS.hintFg,
                marginTop: 20,
                marginBottom: 6,
              }}
            >
              Feed order
            </div>
            <FeedRankList
              feeds={allFeeds}
              currentFeedId={feed.id}
              onReorder={onReorder}
            />
          </>
        )}

        <div
          style={{
            marginTop: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
            minHeight: 32,
          }}
        >
          {onHiddenChange && (
            <button
              type="button"
              onClick={() => onHiddenChange(!hidden)}
              className="label-ui"
              style={{
                marginRight: "auto",
                padding: "6px 10px 6px 0",
                background: "transparent",
                color: TOKENS.hintFg,
                border: "none",
                cursor: "pointer",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.color = TOKENS.panelBorder)
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.color = TOKENS.hintFg)
              }
            >
              {hidden ? "Unhide feed" : "Hide feed"}
            </button>
          )}
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
    </Glasshouse>
  );
}

// The orientation glyph depicts the feed container itself as an open ⊔ vessel,
// open on the side it grows from: a tall portrait U open at the top for
// vertical, the same U on its side open to the right for horizontal. A 2px
// stroke keeps it clear of the sitewide thin-rule ban.
function OrientationGlyph({ orientation }: { orientation: Orientation }) {
  const portrait = orientation === "vertical";
  // Portrait: tall U open at top (left wall, floor, right wall).
  // Horizontal: wide U on its side open to the right (top wall, left wall, floor).
  const path = portrait
    ? "M4.5 1.5 L4.5 14.5 L11.5 14.5 L11.5 1.5"
    : "M14.5 4.5 L1.5 4.5 L1.5 11.5 L14.5 11.5";
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d={path}
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// The colour-scheme glyph (feature-debt §3, GLASSHOUSE-AND-PALETTE-ADR §III.4)
// — the scheme's three surfaces shown as three fat equal bars, French-flag
// style (walls · interior · card), echoing the vessel grammar inside the Colour
// AppearanceControl. Bigger and clearer than the old concentric-rectangle chip
// (which read as murky at small size). Every text colour derives from these
// surfaces in tokens.ts, so cycling can't produce an illegible feed. The
// schemes carry no display name (DESIGN-TUNING-FINDINGS §3), so this swatch is
// the sole identifier — the Colour control shows no text indicator. Each bar is
// ~14px wide (≥2px, per the sitewide no-thin-line rule); no outline. The
// colourway now adapts to the global light/dark toggle, so the swatch previews
// the variant for the CURRENT global mode (paletteFor(scheme, dark)); it carries
// the light island only so basic's neutral slugs resolve cleanly in the preview.
function SchemeSwatch({ scheme }: { scheme: FeedScheme }) {
  const dark = useColorScheme((s) => s.dark);
  const pal = paletteFor(scheme, dark);
  return (
    <span
      aria-hidden="true"
      style={{
        ...LIGHT_ISLAND_STYLE,
        display: "flex",
        width: 42,
        height: 22,
        overflow: "hidden",
        borderRadius: 2,
      }}
    >
      <span style={{ flex: 1, background: pal.walls }} />
      <span style={{ flex: 1, background: pal.interior }} />
      <span style={{ flex: 1, background: pal.cardBg }} />
    </span>
  );
}

// Drag-to-rank list (MOBILE-LAYOUT-ADR §VII.4). One component for both
// surfaces, so the drag is pointer-event based (HTML5 DnD has no touch
// translation). Rows live-reorder while dragging; the new order commits on
// release. Numerals are derived live over visible feeds only (§V — hidden
// feeds keep their place in the rank order but wear no number), so the list
// previews exactly what the desktop badges and the mobile pager will show.
const RANK_ROW_H = 34;
const RANK_ROW_GAP = 6;

function FeedRankList({
  feeds,
  currentFeedId,
  onReorder,
}: {
  feeds: WorkspaceFeed[];
  currentFeedId: string;
  onReorder: (feedIds: string[]) => void;
}) {
  const ranked = [...feeds].sort(
    (a, b) =>
      a.sortRank - b.sortRank ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
  const rankedIds = ranked.map((f) => f.id);
  const [order, setOrder] = useState<string[]>(rankedIds);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragRef = useRef<{
    id: string;
    startY: number;
    startIndex: number;
  } | null>(null);

  // Re-sync from the canonical order whenever it changes (rename, server
  // reconcile) — but never mid-drag, or the row would jump under the pointer.
  const rankedKey = rankedIds.join("|");
  useEffect(() => {
    if (!draggingId) setOrder(rankedKey.split("|"));
  }, [rankedKey, draggingId]);

  const byId = new Map(feeds.map((f) => [f.id, f]));
  const stride = RANK_ROW_H + RANK_ROW_GAP;

  function moveTo(id: string, target: number) {
    setOrder((prev) => {
      const clamped = Math.max(0, Math.min(prev.length - 1, target));
      if (prev.indexOf(id) === clamped) return prev;
      const next = prev.filter((x) => x !== id);
      next.splice(clamped, 0, id);
      return next;
    });
  }

  function handlePointerDown(e: React.PointerEvent<HTMLButtonElement>, id: string) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { id, startY: e.clientY, startIndex: order.indexOf(id) };
    setDraggingId(id);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const delta = Math.round((e.clientY - drag.startY) / stride);
    moveTo(drag.id, drag.startIndex + delta);
  }

  function handlePointerEnd() {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDraggingId(null);
    if (order.some((id, i) => id !== rankedIds[i])) onReorder(order);
  }

  // Keyboard re-rank on the same handle: each arrow press commits (feeds are
  // few; a PATCH per step is cheap and keeps the badges live).
  function handleKeyDown(e: React.KeyboardEvent, id: string) {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const index = order.indexOf(id);
    const target = e.key === "ArrowUp" ? index - 1 : index + 1;
    if (target < 0 || target >= order.length) return;
    const next = order.filter((x) => x !== id);
    next.splice(target, 0, id);
    setOrder(next);
    onReorder(next);
  }

  let numeral = 0;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: RANK_ROW_GAP,
        marginBottom: 4,
      }}
    >
      {order.map((id) => {
        const f = byId.get(id);
        if (!f) return null;
        const num = f.hidden ? null : ++numeral;
        const isCurrent = f.id === currentFeedId;
        const isDragging = draggingId === f.id;
        const name = f.name.trim();
        return (
          <div
            key={f.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              height: RANK_ROW_H,
              padding: "0 4px 0 10px",
              background: isDragging ? TOKENS.fieldBg : TOKENS.rowBg,
              boxShadow: isDragging ? "0 2px 6px rgba(0, 0, 0, 0.15)" : undefined,
              position: "relative",
              zIndex: isDragging ? 1 : undefined,
            }}
          >
            <span
              className="font-mono text-[11px]"
              style={{
                color: TOKENS.hintFg,
                width: 18,
                flexShrink: 0,
                textAlign: "right",
              }}
            >
              {num ?? "–"}
            </span>
            <span
              className="font-sans text-ui-xs"
              style={{
                color: f.hidden
                  ? TOKENS.hintFg
                  : TOKENS.panelBorder,
                fontWeight: isCurrent ? 600 : undefined,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flex: 1,
              }}
            >
              {name || "Unnamed feed"}
            </span>
            {f.hidden && (
              <span className="label-ui" style={{ color: TOKENS.hintFg }}>
                hidden
              </span>
            )}
            <button
              type="button"
              aria-label={`Reorder ${name || "unnamed feed"} (drag, or arrow keys)`}
              onPointerDown={(e) => handlePointerDown(e, f.id)}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerEnd}
              onPointerCancel={handlePointerEnd}
              onKeyDown={(e) => handleKeyDown(e, f.id)}
              style={{
                background: "transparent",
                border: "none",
                color: TOKENS.hintFg,
                cursor: isDragging ? "grabbing" : "grab",
                touchAction: "none",
                padding: "6px 10px",
                fontSize: 14,
                lineHeight: 1,
                flexShrink: 0,
              }}
            >
              ≡
            </button>
          </div>
        );
      })}
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
          // Fixed footprint: the glyph/indicator/label swap as the control
          // cycles, but the button must never change size — otherwise the
          // wrap row reflows and the whole modal visibly jumps. Content is
          // centred so each step recentres inside a stable box.
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          width: 104,
          height: 34,
          padding: "0 10px",
          boxSizing: "border-box",
          // Resting affordance is a subtle fill (the design system bans thin
          // rules sitewide); hover deepens it.
          background: TOKENS.matchHoverBg,
          color: TOKENS.panelBorder,
          cursor: "pointer",
          whiteSpace: "nowrap",
          overflow: "hidden",
        }}
        onMouseEnter={(e) =>
          (e.currentTarget.style.background = TOKENS.fieldBg)
        }
        onMouseLeave={(e) =>
          (e.currentTarget.style.background = TOKENS.matchHoverBg)
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
  onCommitted,
}: {
  source: WorkspaceFeedSource;
  feedId: string;
  busy: boolean;
  onRemove: () => void;
  // Optimistic local update of the composer's source list (no feed reload).
  onChanged: (updated: WorkspaceFeedSource) => void;
  // Fired once after a change is committed server-side, so the parent can
  // reload the feed behind the glass exactly once (not on the optimistic tick).
  onCommitted: () => void;
}) {
  const [committing, setCommitting] = useState(false);
  const isMuted = source.mutedAt !== null;
  const currentStep = isMuted ? 0 : weightToStep(source.weight);
  const sampling = source.samplingMode;
  const excludeReplies = source.excludeReplies;

  // Account sources route + hover exactly like a feed-card byline; the hover
  // author-card portals above the Glasshouse via the zIndex override.
  const hover = useAuthorHover(
    "author",
    source.sourceType === "account" ? (source.accountId ?? null) : null,
  );

  // Every commit updates the row optimistically (instant, no shudder) and
  // reconciles with the authoritative row, reverting on failure. The feed
  // behind the glass reloads once, after the commit settles.
  async function commit(
    optimistic: WorkspaceFeedSource,
    body: {
      step?: number;
      sampling?: "random" | "top";
      muted?: boolean;
      excludeReplies?: boolean;
    },
  ) {
    if (committing) return;
    const prev = source;
    setCommitting(true);
    onChanged(optimistic);
    try {
      const { source: updated } = await workspaceFeedsApi.patchSource(
        feedId,
        source.id,
        body,
      );
      onChanged(updated);
      onCommitted();
    } catch {
      onChanged(prev);
    } finally {
      setCommitting(false);
    }
  }

  function commitStep(nextStep: number) {
    void commit(
      {
        ...source,
        mutedAt: nextStep === 0 ? new Date().toISOString() : null,
        weight: nextStep === 0 ? source.weight : VOLUME_WEIGHTS[nextStep],
      },
      { step: nextStep, muted: nextStep === 0 },
    );
  }

  function commitSampling(next: "random" | "top") {
    void commit({ ...source, samplingMode: next }, { sampling: next });
  }

  function commitExcludeReplies(next: boolean) {
    void commit(
      { ...source, excludeReplies: next },
      { excludeReplies: next },
    );
  }

  const label = source.display.label;
  const href = source.display.href;

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
          {href ? (
            <Link
              href={href}
              ref={hover.bylineRef as React.Ref<HTMLAnchorElement>}
              onMouseEnter={hover.onMouseEnter}
              onMouseLeave={hover.onMouseLeave}
              onClick={(e) => {
                // Open the matching URL-synced Glasshouse overlay in place —
                // never a full-page navigation that would escape the workspace
                // to the black topbar. Account → profile overlay; publication /
                // external source / tag → surface overlay. Gate the account case
                // strictly on the source type: openProfileHref reads the href
                // alone and would mis-classify /pub/:slug, /source/:id and
                // /tag/:name as a native profile, so route those through
                // openSurfaceHref instead. Modified clicks (new tab) fall
                // through to the real link.
                if (isModifiedClick(e)) return;
                const handled =
                  source.sourceType === "account"
                    ? openProfileHref(href)
                    : openSurfaceHref(href);
                if (handled) {
                  e.preventDefault();
                  hover.onModalClose();
                }
              }}
              className="font-sans text-ui-xs hover:underline"
              style={{
                color: isMuted ? TOKENS.hintFg : TOKENS.panelBorder,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                textDecoration: isMuted ? "line-through" : undefined,
              }}
            >
              {label}
            </Link>
          ) : (
            <div
              className="font-sans text-ui-xs"
              style={{
                color: isMuted ? TOKENS.hintFg : TOKENS.panelBorder,
                overflow: "hidden",
                textOverflow: "ellipsis",
                textDecoration: isMuted ? "line-through" : undefined,
              }}
            >
              {label}
            </div>
          )}
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
          aria-label={`Remove ${label}`}
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

      {/* Controls always render (even when muted, dimmed) so toggling never
          reflows the row — the prior mute-driven show/hide was the shudder. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginTop: 6,
          flexWrap: "wrap",
        }}
      >
        {/* Volume: 0=mute, 1..5 = quieter→louder. Step 3 = default weight. */}
        <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
          {[0, 1, 2, 3, 4, 5].map((s) => {
            const active = !isMuted && s > 0 && s <= currentStep;
            const muteActive = isMuted && s === 0;
            return (
              <button
                key={s}
                type="button"
                onClick={() => commitStep(s)}
                disabled={committing}
                aria-label={s === 0 ? "Mute" : `Volume ${s}`}
                style={{
                  width: s === 0 ? 20 : 16,
                  height: 16,
                  background: muteActive
                    ? TOKENS.errorFg
                    : active
                      ? TOKENS.panelBorder
                      : TOKENS.fieldBg,
                  border: "none",
                  cursor: committing ? "default" : "pointer",
                  padding: 0,
                  fontSize: 9,
                  color: muteActive ? "var(--ah-white)" : TOKENS.hintFg,
                  fontFamily: "IBM Plex Mono, ui-monospace, monospace",
                }}
              >
                {s === 0 ? "×" : ""}
              </button>
            );
          })}
        </div>

        {/* Sampling + no-replies are moot while muted — dimmed but kept in place
            so unmuting doesn't jump the layout. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            opacity: isMuted ? 0.4 : 1,
          }}
        >
          <div style={{ display: "flex", gap: 3 }}>
            {(["random", "top"] as const).map((mode) => {
              const on = sampling === mode;
              return (
                <Chip
                  key={mode}
                  label={mode}
                  active={on}
                  disabled={committing || isMuted}
                  onClick={() => commitSampling(mode)}
                />
              );
            })}
          </div>
          <Chip
            label="no replies"
            active={excludeReplies}
            disabled={committing || isMuted}
            onClick={() => commitExcludeReplies(!excludeReplies)}
            title="Only freestanding posts — hide replies from this source"
          />
        </div>
      </div>

      {hover.open && hover.id && (
        <AuthorModal
          type="author"
          id={hover.id}
          anchorRef={hover.bylineRef}
          onClose={hover.onModalClose}
          onMouseEnter={hover.onModalMouseEnter}
          onMouseLeave={hover.onModalMouseLeave}
          zIndex={TOKENS.hoverZ}
          feedId={feedId}
        />
      )}
    </div>
  );
}

// Borderless mono-caps toggle chip — active is a dark fill, inactive a recessed
// fill. Fixed by its (constant) label text so toggling only swaps colour, never
// width, keeping the row steady.
function Chip({
  label,
  active,
  disabled,
  onClick,
  title,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="font-mono text-[10px] uppercase tracking-[0.04em]"
      style={{
        background: active ? TOKENS.panelBorder : TOKENS.fieldBg,
        color: active ? "var(--ah-white)" : TOKENS.hintFg,
        border: "none",
        cursor: disabled ? "default" : "pointer",
        padding: "3px 7px",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

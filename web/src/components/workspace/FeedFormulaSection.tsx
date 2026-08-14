"use client";

import { useCallback, useEffect, useState } from "react";
import {
  formulas as formulasApi,
  formulaSourceKind,
  type FormulaPreview,
  type OwnedFormula,
} from "../../lib/api/formulas";
import { apiErrorMessage } from "../../lib/api/client";
import { timeAgo } from "../../lib/format";

// =============================================================================
// FeedFormulaSection — the FeedComposer's "Publish as a formula" block
// (FEED-FORMULAS-ADR §3, §7; Phase 1's web half).
//
// PREVIEW BEFORE FREEZE, AND THE PREVIEW IS THE SERVER'S (§6, D5). The source
// list rendered here comes from GET …/formula/preview, which runs the real
// freezeSource over the real query — it is not derived client-side from the
// composer's own `sources` array. That array cannot answer the only question
// that matters: it carries no protocol, so the web cannot tell an email source
// from an RSS one, and a preview that guessed would show an author three
// sources that will never travel. Deriving it here would also put a second copy
// of the D5 allow-list in the web, to drift the first time a protocol joins the
// enum — the standing lesson of the three publish-side validators.
//
// THE EXCLUDED COUNT IS THE POINT OF THE PREVIEW, not a footnote on it. §6's
// reason for a pre-freeze preview is "publishing exposes a follow graph … so
// nobody publishes something whose legibility they had not considered", and D5
// adds that silent omission is the wrong failure: an author who cannot see "3
// email sources can't be shared" believes they published their whole feed.
// Both are rendered in words, never as a badge.
//
// REVOKE IS NOT AN UNDO AND SAYS SO (D10). It stops future redemptions and
// reaches into nobody's workspace. Written on the surface because "revoke"
// reads as though it ought to.
//
// NO NESTED GLASSHOUSE. This is inline composer state, like the delete
// confirmation beside it — panes never stack (the one-Glasshouse invariant), so
// the publish flow is a section that expands, not a second pane.
//
// It renders on the composer's fixed-light Glasshouse pane, so fixed neutral
// tokens are correct here, exactly as in FeedSyncSection. `fieldBg` matches the
// composer's own white fields rather than the newer `bg-glasshouse-well`: a
// third field colour inside one pane would read as a foreign control, and
// migrating the whole composer is not this section's business.
// =============================================================================

const T = {
  fg: "var(--ah-ink-925)",
  hintFg: "var(--ah-grey-600)",
  fieldBg: "var(--ah-white)",
  rowBg: "var(--ah-bone)",
  errorFg: "var(--ah-crimson)",
};

const NAME_LIMIT = 80;
const DESCRIPTION_LIMIT = 500;

function absoluteUrl(path: string): string {
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${path}`;
}

// ─── The small mono action button the composer uses everywhere ───────────────

function Action({
  children,
  onClick,
  disabled,
  tone = "default",
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "default" | "quiet" | "danger";
}) {
  const colour =
    tone === "danger" ? T.errorFg : tone === "quiet" ? T.hintFg : T.fg;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="label-ui"
      style={{
        padding: "6px 10px",
        background: tone === "default" && !disabled ? T.fieldBg : "transparent",
        border: "none",
        color: disabled ? T.hintFg : colour,
        cursor: disabled ? "default" : "pointer",
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}

export function FeedFormulaSection({ feedId }: { feedId: string }) {
  const [composing, setComposing] = useState(false);
  const [preview, setPreview] = useState<FormulaPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState<OwnedFormula | null>(null);
  const [mine, setMine] = useState<OwnedFormula[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The author's own list, so a link published last week is recoverable rather
  // than lost the moment the sheet closed (§7's "My formulas"). Live formulas
  // only — a revoked one is a link that no longer works, and listing it invites
  // sending it.
  const refreshMine = useCallback(async () => {
    try {
      setMine((await formulasApi.listMine()).filter((f) => !f.revoked));
    } catch {
      // The list is a convenience; failing to load it must not block publishing.
    }
  }, []);

  useEffect(() => {
    void refreshMine();
  }, [refreshMine]);

  // Reset when the composer is pointed at a different feed — the preview and
  // the freshly-published link both belong to the feed they were made from.
  useEffect(() => {
    setComposing(false);
    setPreview(null);
    setPublished(null);
    setError(null);
    setCopied(null);
  }, [feedId]);

  const startCompose = useCallback(async () => {
    setComposing(true);
    setLoadingPreview(true);
    setError(null);
    setPublished(null);
    try {
      const p = await formulasApi.preview(feedId);
      setPreview(p);
      setName(p.name);
      setDescription("");
    } catch (err) {
      setError(
        apiErrorMessage(err) ?? "Couldn’t read this feed’s composition.",
      );
      setComposing(false);
    } finally {
      setLoadingPreview(false);
    }
  }, [feedId]);

  const handlePublish = useCallback(async () => {
    if (publishing || !preview || preview.refusal) return;
    setPublishing(true);
    setError(null);
    try {
      const f = await formulasApi.publish(feedId, {
        name: name.trim() || undefined,
        description: description.trim() || undefined,
      });
      setPublished(f);
      setComposing(false);
      setPreview(null);
      void refreshMine();
    } catch (err) {
      setError(apiErrorMessage(err) ?? "Couldn’t publish this feed.");
    } finally {
      setPublishing(false);
    }
  }, [publishing, preview, feedId, name, description, refreshMine]);

  const handleCopy = useCallback((f: OwnedFormula) => {
    const url = absoluteUrl(f.url);
    void navigator.clipboard
      .writeText(url)
      .then(() => {
        setCopied(f.id);
        setTimeout(() => setCopied((c) => (c === f.id ? null : c)), 2000);
      })
      .catch(() => setError("Couldn’t reach the clipboard — the link is above."));
  }, []);

  const handleRevoke = useCallback(
    async (f: OwnedFormula) => {
      if (revoking) return;
      setRevoking(f.id);
      setError(null);
      try {
        await formulasApi.revoke(f.id);
        setMine((prev) => prev.filter((x) => x.id !== f.id));
        setPublished((p) => (p && p.id === f.id ? null : p));
      } catch (err) {
        setError(apiErrorMessage(err) ?? "Couldn’t withdraw that link.");
      } finally {
        setRevoking(null);
      }
    },
    [revoking],
  );

  const fieldStyle = {
    width: "100%",
    background: T.fieldBg,
    border: "none",
    padding: "8px 10px",
    outline: "none",
    color: T.fg,
  } as const;

  return (
    <div style={{ marginTop: 20 }}>
      <div className="label-ui" style={{ color: T.hintFg, marginBottom: 6 }}>
        Share this feed
      </div>

      {error && (
        <div
          className="font-mono text-mono-xs"
          style={{ color: T.errorFg, marginBottom: 8 }}
        >
          {error}
        </div>
      )}

      {/* ── Idle ────────────────────────────────────────────────────────── */}
      {!composing && !published && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <p className="text-ui-xs" style={{ color: T.hintFg, margin: 0 }}>
            Hand this feed to someone as a link. They get the composition — the
            sources and how you’ve tuned them — as a feed of their own, not a
            window onto yours.
          </p>
          <Action onClick={() => void startCompose()}>Publish</Action>
        </div>
      )}

      {/* ── Preview, before anything is frozen ──────────────────────────── */}
      {composing && (
        <div>
          {loadingPreview && (
            <div className="font-mono text-mono-xs" style={{ color: T.hintFg }}>
              READING THIS FEED…
            </div>
          )}

          {preview && (
            <>
              <input
                type="text"
                value={name}
                maxLength={NAME_LIMIT}
                onChange={(e) => setName(e.target.value)}
                placeholder="What to call it"
                className="font-sans text-ui-sm"
                style={{ ...fieldStyle, marginBottom: 6 }}
              />
              <textarea
                value={description}
                maxLength={DESCRIPTION_LIMIT}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="A line about what it’s for (optional)"
                rows={2}
                className="font-sans text-ui-sm"
                style={{ ...fieldStyle, marginBottom: 10, resize: "vertical" }}
              />

              <div
                className="label-ui"
                style={{ color: T.hintFg, marginBottom: 6 }}
              >
                They would receive
              </div>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  maxHeight: 200,
                  overflowY: "auto",
                  marginBottom: 8,
                }}
              >
                {preview.sources.map((s) => (
                  <div
                    key={s.position}
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      justifyContent: "space-between",
                      gap: 10,
                      background: T.rowBg,
                      padding: "5px 8px",
                    }}
                  >
                    <span
                      className="text-ui-xs"
                      style={{
                        color: T.fg,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {s.label}
                    </span>
                    <span
                      className="label-ui"
                      style={{ color: T.hintFg, flexShrink: 0 }}
                    >
                      {formulaSourceKind(s)}
                    </span>
                  </div>
                ))}
              </div>

              {/* D5 — stated, never silent. The author learns here, not by
                  opening their own link and counting. */}
              {preview.excludedCount > 0 && (
                <p
                  className="text-ui-xs"
                  style={{ color: T.hintFg, margin: "0 0 8px" }}
                >
                  {preview.excludedCount === 1
                    ? "One source can’t be shared"
                    : `${preview.excludedCount} sources can’t be shared`}{" "}
                  and won’t be in it — a newsletter’s private address belongs
                  to you alone, and a source that no longer exists can’t
                  travel.
                </p>
              )}

              {preview.refusal === "empty" && (
                <p
                  className="text-ui-xs"
                  style={{ color: T.errorFg, margin: "0 0 8px" }}
                >
                  {preview.excludedCount > 0
                    ? "None of this feed’s sources can be shared, so there is nothing to publish."
                    : "Add at least one source before publishing this feed."}
                </p>
              )}
              {preview.refusal === "too_large" && (
                <p
                  className="text-ui-xs"
                  style={{ color: T.errorFg, margin: "0 0 8px" }}
                >
                  A shared feed can carry {preview.maxSources} sources; this one
                  has {preview.sourceCount}.
                </p>
              )}

              <p
                className="text-ui-xs"
                style={{ color: T.hintFg, margin: "0 0 8px" }}
              >
                This is a snapshot. Whatever you change afterwards stays yours —
                it never reaches anyone who added it.
              </p>

              <div style={{ display: "flex", gap: 8 }}>
                <Action
                  onClick={() => void handlePublish()}
                  disabled={publishing || preview.refusal !== null}
                >
                  {publishing ? "Publishing…" : "Publish"}
                </Action>
                <Action
                  tone="quiet"
                  disabled={publishing}
                  onClick={() => {
                    setComposing(false);
                    setPreview(null);
                  }}
                >
                  Cancel
                </Action>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Just published ──────────────────────────────────────────────── */}
      {published && (
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 6,
            }}
          >
            <input
              type="text"
              readOnly
              value={absoluteUrl(published.url)}
              onFocus={(e) => e.currentTarget.select()}
              className="font-mono text-mono-xs"
              style={{ ...fieldStyle, flex: 1 }}
            />
            <Action onClick={() => handleCopy(published)}>
              {copied === published.id ? "Copied" : "Copy"}
            </Action>
          </div>
          <p className="text-ui-xs" style={{ color: T.hintFg, margin: 0 }}>
            Send it wherever you like — anyone with the link can add the feed.
            {published.excludedCount > 0 &&
              ` ${published.excludedCount} ${
                published.excludedCount === 1 ? "source" : "sources"
              } stayed behind.`}
          </p>
          <div style={{ marginTop: 8 }}>
            <Action tone="quiet" onClick={() => setPublished(null)}>
              Done
            </Action>
          </div>
        </div>
      )}

      {/* ── Links already out there ─────────────────────────────────────── */}
      {!composing && mine.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div
            className="label-ui"
            style={{ color: T.hintFg, marginBottom: 6 }}
          >
            Your links
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {mine.map((f) => (
              <div
                key={f.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  background: T.rowBg,
                  padding: "5px 8px",
                }}
              >
                <span
                  className="text-ui-xs"
                  style={{
                    color: T.fg,
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {f.name}
                </span>
                <span
                  className="label-ui"
                  style={{ color: T.hintFg, flexShrink: 0 }}
                >
                  {f.sourceCount} · {timeAgo(f.createdAt)}
                </span>
                <Action tone="quiet" onClick={() => handleCopy(f)}>
                  {copied === f.id ? "Copied" : "Copy"}
                </Action>
                {/* D11 — the designated default seed cannot be withdrawn. The
                    server refuses it (409) and the schema backs the refusal;
                    hiding the control is only so the operator isn't offered an
                    action that cannot work. */}
                {!f.isDefaultSeed && (
                  <Action
                    tone="danger"
                    disabled={revoking === f.id}
                    onClick={() => void handleRevoke(f)}
                  >
                    {revoking === f.id ? "…" : "Withdraw"}
                  </Action>
                )}
              </div>
            ))}
          </div>
          <p
            className="text-ui-xs"
            style={{ color: T.hintFg, margin: "6px 0 0" }}
          >
            Withdrawing stops new copies. It doesn’t reach anyone who already
            added the feed — theirs is theirs.
          </p>
        </div>
      )}
    </div>
  );
}

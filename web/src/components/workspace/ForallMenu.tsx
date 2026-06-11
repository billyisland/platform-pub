"use client";

import { forwardRef, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useUnreadCounts } from "../../stores/unread";
import { useMessagesOverlay } from "../../stores/messagesOverlay";
import { useDashboardOverlay } from "../../stores/dashboardOverlay";
import { useNotificationsOverlay } from "../../stores/notificationsOverlay";
import { useLedgerOverlay } from "../../stores/ledgerOverlay";
import { useSettingsOverlay } from "../../stores/settingsOverlay";
import { usePaletteDevtool } from "../../stores/paletteDevtool";
import { SearchPanel } from "./SearchPanel";

const TOKENS = {
  buttonBg: "var(--ah-ink-925)",
  buttonFg: "var(--ah-bone)",
  glyphFg: "var(--ah-bone)", // workspace floor colour (FLOOR in WorkspaceView)
  itemFg: "var(--ah-ink-925)",
  itemFocusBg: "rgb(var(--ah-ink-rgb) / 0.06)", // subtle dark wash on the warm pane
  itemMuted: "var(--ah-grey-600)", // grey-600 — legible on the mid-light glasshouse pane
  badgeBg: "var(--ah-crimson)",
  badgeFg: "var(--ah-white)",
};

export type ForallAction = "new-feed" | "new-note" | "new-article";

export interface HiddenFeed {
  id: string;
  name: string;
}

interface ForallMenuProps {
  onAction: (key: ForallAction) => void;
  hiddenFeeds?: HiddenFeed[];
  onRestore?: (feedId: string) => void;
}

type View = "closed" | "menu" | "search";

// Flattened, keyboard-navigable menu rows. Order here is the arrow-key order.
type FocusRow =
  | { kind: "action"; key: ForallAction; label: string }
  | { kind: "open"; target: "search"; label: string; count: number }
  | { kind: "overlay"; onOpen: () => void; label: string; count: number }
  | { kind: "link"; href: string; label: string; count: number }
  | { kind: "restore"; id: string; label: string };

export function ForallMenu({
  onAction,
  hiddenFeeds = [],
  onRestore,
}: ForallMenuProps) {
  const router = useRouter();
  const dmCount = useUnreadCounts((s) => s.dmCount);
  const notificationCount = useUnreadCounts((s) => s.notificationCount);
  const totalUnread = dmCount + notificationCount;

  const [view, setView] = useState<View>("closed");
  const [activeIndex, setActiveIndex] = useState(0);
  // ∀ glyph rotation. Hover rotates it to 180° (a right-side-up A) and holds;
  // leaving completes the turn to 360° (back to ∀), then snaps to 0 for next
  // time. `spinTransition` is dropped to "none" only for that invisible
  // 360°→0° reset so it doesn't visibly unwind.
  const [glyphRot, setGlyphRot] = useState(0);
  const [spinTransition, setSpinTransition] = useState(true);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Rows are grouped find → make → go: search first (the way in), then the
  // create actions, then the destinations, then any hidden-feed restores. The
  // groups render with a tight gap between them and flatten into `rows` for
  // arrow-key navigation.
  const findRows: FocusRow[] = [
    { kind: "open", target: "search", label: "Search", count: 0 },
  ];
  const createRows: FocusRow[] = [
    { kind: "action", key: "new-note", label: "New note" },
    { kind: "action", key: "new-article", label: "Write an article" },
    { kind: "action", key: "new-feed", label: "New feed" },
  ];
  const goRows: FocusRow[] = [
    {
      kind: "overlay",
      onOpen: () => useMessagesOverlay.getState().open(),
      label: "Messages",
      count: dmCount,
    },
    {
      kind: "overlay",
      onOpen: () => useNotificationsOverlay.getState().open(),
      label: "Notifications",
      count: notificationCount,
    },
    {
      kind: "overlay",
      onOpen: () => useDashboardOverlay.getState().open(),
      label: "Dashboard",
      count: 0,
    },
    {
      kind: "overlay",
      onOpen: () => useLedgerOverlay.getState().open(),
      label: "Ledger",
      count: 0,
    },
    {
      kind: "overlay",
      onOpen: () => useSettingsOverlay.getState().open(),
      label: "Settings",
      count: 0,
    },
    // TEMPORARY — live colour-tuning kit (PalettePanel). Not a Glasshouse:
    // opening it leaves every other overlay's state untouched. Remove this
    // row with the devtool once the colour scheme is finalised.
    {
      kind: "overlay",
      onOpen: () => usePaletteDevtool.getState().open(),
      label: "Palette",
      count: 0,
    },
  ];
  const restoreRows: FocusRow[] = hiddenFeeds.map((hf) => ({
    kind: "restore",
    id: hf.id,
    label: hf.name,
  }));
  const groups: FocusRow[][] = [
    findRows,
    createRows,
    goRows,
    restoreRows,
  ].filter((g) => g.length > 0);
  const rows: FocusRow[] = groups.flat();

  function closeAll() {
    setView("closed");
    buttonRef.current?.focus();
  }

  function selectRow(row: FocusRow) {
    switch (row.kind) {
      case "action":
        setView("closed");
        buttonRef.current?.focus();
        onAction(row.key);
        return;
      case "open":
        setView(row.target);
        return;
      case "overlay":
        setView("closed");
        buttonRef.current?.focus();
        row.onOpen();
        return;
      case "link":
        setView("closed");
        buttonRef.current?.focus();
        router.push(row.href);
        return;
      case "restore":
        setView("closed");
        buttonRef.current?.focus();
        onRestore?.(row.id);
        return;
    }
  }

  // Outside-click + Esc close any open surface (menu or panel). The panels
  // render inside this same container, so one handler covers all of them.
  useEffect(() => {
    if (view === "closed") return;
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current?.contains(e.target as Node)) return;
      setView("closed");
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setView("closed");
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [view]);

  // Reset + focus the first menu row each time the menu opens.
  useEffect(() => {
    if (view === "menu") setActiveIndex(0);
  }, [view]);

  useEffect(() => {
    if (view === "menu") itemRefs.current[activeIndex]?.focus();
  }, [view, activeIndex]);

  function onMenuKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % rows.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + rows.length) % rows.length);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(rows.length - 1);
    }
  }

  return (
    <div
      ref={containerRef}
      style={{ position: "fixed", right: 24, bottom: 24, zIndex: 60 }}
    >
      {view === "menu" && (
        <div
          role="menu"
          aria-label="Workspace actions"
          onKeyDown={onMenuKey}
          className="bg-glasshouse shadow-lg"
          style={{
            position: "absolute",
            right: 0,
            bottom: 64,
            minWidth: 240,
            padding: 6,
          }}
        >
          {(() => {
            let flat = 0;
            return groups.map((group, gi) => (
              <div key={gi} style={gi > 0 ? { marginTop: 6 } : undefined}>
                {group.map((row) => {
                  const idx = flat++;
                  return (
                    <MenuRow
                      key={idx}
                      ref={(el) => {
                        itemRefs.current[idx] = el;
                      }}
                      row={row}
                      active={idx === activeIndex}
                      onSelect={() => selectRow(row)}
                      onHover={() => setActiveIndex(idx)}
                    />
                  );
                })}
              </div>
            ));
          })()}
        </div>
      )}

      {view === "search" && <SearchPanel onClose={closeAll} />}

      <button
        ref={buttonRef}
        type="button"
        aria-label={`Workspace actions${
          totalUnread > 0 ? ` (${totalUnread} unread)` : ""
        }`}
        aria-haspopup="menu"
        aria-expanded={view !== "closed"}
        onClick={() => setView((v) => (v === "closed" ? "menu" : "closed"))}
        onMouseEnter={() => {
          setSpinTransition(true);
          setGlyphRot(180);
        }}
        onMouseLeave={() => {
          setSpinTransition(true);
          setGlyphRot(360);
        }}
        style={{
          position: "relative",
          width: 56,
          height: 56,
          borderRadius: "50%",
          background: TOKENS.buttonBg,
          color: TOKENS.buttonFg,
          border: "none",
          padding: 0,
          cursor: "pointer",
          transition: "transform 120ms ease-out",
          transform: view !== "closed" ? "scale(1.04)" : "scale(1)",
        }}
      >
        {/* The ∀ is constructed, not typed: three bars forming the A skeleton,
            in the workspace floor colour, dividing the black disc. The two
            diagonals run from the bottom of the rim up to the rim on each side
            — each cutting off a *complete* circle segment — and the crossbar
            joins them across the central region.

            The diagonals' endpoints overshoot the circumference (to r≈30) and
            the apex's cap spills past the bottom, so each leg fully reaches the
            rim with no anti-aliased gap — but the bar group is then *clipped to
            the disc* (`#forall-clip`, r=28). The overshoot lands the leg exactly
            on the rim while the clip guarantees nothing paints outside it, so no
            pale leg-ends ever poke past the edge (the old floor-on-floor trick
            leaked them once the open-menu scale + spin transforms stopped the
            compositor cancelling them against the floor).
            Inner SVG so the unread badge stays a sibling on the button. */}
        <svg
          aria-hidden="true"
          viewBox="0 0 56 56"
          onTransitionEnd={() => {
            // The completing turn has landed back at ∀ — snap 360°→0° with no
            // transition so the next hover starts cleanly from upside-down.
            if (glyphRot === 360) {
              setSpinTransition(false);
              setGlyphRot(0);
            }
          }}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            transformOrigin: "center",
            transform: `rotate(${glyphRot}deg)`,
            transition: spinTransition ? "transform 480ms ease-in-out" : "none",
          }}
        >
          <defs>
            {/* The disc itself — clips the bars so their overshoot can never
                paint past the rim. Centred on the rotation origin, so a circle
                is invariant under the spin and stays aligned with the button's
                border-radius disc. */}
            <clipPath id="forall-clip">
              <circle cx="28" cy="28" r="28" />
            </clipPath>
          </defs>
          {/* stroke via style, not the presentation attribute — the token
              is a var() reference, which attributes don't resolve */}
          <g
            clipPath="url(#forall-clip)"
            style={{ stroke: TOKENS.glyphFg }}
            strokeWidth={6}
            strokeLinecap="round"
            fill="none"
          >
            {/* left diagonal: bottom rim → upper-left rim (cuts off a segment) */}
            <line x1="28" y1="56" x2="8.5" y2="5" />
            {/* right diagonal: bottom rim → upper-right rim (cuts off a segment) */}
            <line x1="28" y1="56" x2="47.5" y2="5" />
            {/* crossbar: raised to pass through the disc centre (y=28); the x
                endpoints sit on the diagonals' centrelines at that height. */}
            <line x1="17.3" y1="28" x2="38.7" y2="28" />
          </g>
        </svg>
        {totalUnread > 0 && (
          <span
            aria-hidden="true"
            className="font-mono"
            style={{
              position: "absolute",
              top: -2,
              right: -2,
              minWidth: 20,
              height: 20,
              padding: "0 6px",
              borderRadius: 10,
              background: TOKENS.badgeBg,
              color: TOKENS.badgeFg,
              fontSize: 11,
              fontWeight: 600,
              lineHeight: "20px",
              textAlign: "center",
              border: `2px solid ${TOKENS.buttonBg}`,
            }}
          >
            {totalUnread > 99 ? "99+" : totalUnread}
          </span>
        )}
      </button>
    </div>
  );
}

interface MenuRowProps {
  row: FocusRow;
  active: boolean;
  onSelect: () => void;
  onHover: () => void;
}

const MenuRow = forwardRef<HTMLButtonElement, MenuRowProps>(function MenuRow(
  { row, active, onSelect, onHover },
  ref,
) {
  const isRestore = row.kind === "restore";
  const count =
    row.kind === "open" || row.kind === "link" || row.kind === "overlay"
      ? row.count
      : 0;
  return (
    <button
      ref={ref}
      role="menuitem"
      type="button"
      onClick={onSelect}
      onMouseEnter={onHover}
      className={`${isRestore ? "label-ui" : "font-sans text-ui-sm"} block w-full text-left`}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        color: isRestore ? TOKENS.itemMuted : TOKENS.itemFg,
        padding: isRestore ? "8px 14px 8px 24px" : "10px 14px",
        background: active ? TOKENS.itemFocusBg : "transparent",
        transition: "background 80ms linear",
        outline: "none",
        border: "none",
        cursor: "pointer",
      }}
    >
      <span>{row.label}</span>
      {count > 0 && (
        <span
          className="font-mono"
          style={{
            minWidth: 18,
            height: 18,
            padding: "0 5px",
            borderRadius: 9,
            background: TOKENS.badgeBg,
            color: TOKENS.badgeFg,
            fontSize: 10,
            fontWeight: 600,
            lineHeight: "18px",
            textAlign: "center",
          }}
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
    </button>
  );
});

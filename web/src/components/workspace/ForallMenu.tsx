"use client";

import { forwardRef, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useUnreadCounts } from "../../stores/unread";
import { useMessagesOverlay } from "../../stores/messagesOverlay";
import { NotificationsPanel } from "./NotificationsPanel";
import { SearchPanel } from "./SearchPanel";

const TOKENS = {
  buttonBg: "#1A1A18",
  buttonFg: "#F0EFEB",
  glyphFg: "#F0EFEB", // workspace floor colour (FLOOR in WorkspaceView)
  menuBg: "#FFFFFF",
  menuBorder: "#1A1A18",
  itemFg: "#1A1A18",
  itemFocusBg: "#E6E5E0",
  itemMuted: "#8A8880",
  badgeBg: "#B5242A",
  badgeFg: "#FFFFFF",
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

type View = "closed" | "menu" | "search" | "notifications";

// Flattened, keyboard-navigable menu rows. Order here is the arrow-key order.
type FocusRow =
  | { kind: "action"; key: ForallAction; label: string }
  | { kind: "open"; target: "search" | "notifications"; label: string; count: number }
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
  const buttonRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const createRows: FocusRow[] = [
    { kind: "action", key: "new-feed", label: "New feed" },
    { kind: "action", key: "new-note", label: "New note" },
    { kind: "action", key: "new-article", label: "Write an article" },
  ];
  const navRows: FocusRow[] = [
    { kind: "open", target: "search", label: "Search", count: 0 },
    {
      kind: "overlay",
      onOpen: () => useMessagesOverlay.getState().open(),
      label: "Messages",
      count: dmCount,
    },
    {
      kind: "open",
      target: "notifications",
      label: "Notifications",
      count: notificationCount,
    },
  ];
  const restoreRows: FocusRow[] = hiddenFeeds.map((hf) => ({
    kind: "restore",
    id: hf.id,
    label: hf.name,
  }));
  const rows: FocusRow[] = [...createRows, ...navRows, ...restoreRows];

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
          style={{
            position: "absolute",
            right: 0,
            bottom: 64,
            minWidth: 240,
            background: TOKENS.menuBg,
            border: `2px solid ${TOKENS.menuBorder}`,
            padding: 4,
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.12)",
          }}
        >
          {createRows.map((row, i) => (
            <MenuRow
              key={`create:${i}`}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              row={row}
              active={i === activeIndex}
              onSelect={() => selectRow(row)}
              onHover={() => setActiveIndex(i)}
            />
          ))}

          <div style={{ height: 8 }} />

          {navRows.map((row, ni) => {
            const idx = createRows.length + ni;
            return (
              <MenuRow
                key={`nav:${ni}`}
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

          {restoreRows.length > 0 && (
            <>
              <div style={{ height: 8 }} />
              {restoreRows.map((row, ri) => {
                const idx = createRows.length + navRows.length + ri;
                return (
                  <MenuRow
                    key={`restore:${row.kind === "restore" ? row.id : ri}`}
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
            </>
          )}
        </div>
      )}

      {view === "search" && <SearchPanel onClose={closeAll} />}
      {view === "notifications" && <NotificationsPanel onClose={closeAll} />}

      <button
        ref={buttonRef}
        type="button"
        aria-label={`Workspace actions${
          totalUnread > 0 ? ` (${totalUnread} unread)` : ""
        }`}
        aria-haspopup="menu"
        aria-expanded={view !== "closed"}
        onClick={() => setView((v) => (v === "closed" ? "menu" : "closed"))}
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
            diagonals run from a shared point at the bottom of the rim up to the
            rim on each side — each cutting off a *complete* circle segment — and
            the crossbar joins them across the central region. The bars are
            clipped to the disc so they terminate flush on the circumference;
            the floor-coloured bars read as the ground cutting through the disc,
            and the black segments they carve out are what mark the disc against
            the ground. Inner SVG so the unread badge stays an unclipped sibling. */}
        <svg
          aria-hidden="true"
          viewBox="0 0 56 56"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        >
          <defs>
            <clipPath id="forall-disc">
              <circle cx="28" cy="28" r="28" />
            </clipPath>
          </defs>
          <g
            clipPath="url(#forall-disc)"
            stroke={TOKENS.glyphFg}
            strokeWidth={5}
            strokeLinecap="round"
            fill="none"
          >
            {/* left diagonal: bottom rim → upper-left rim (cuts off a segment) */}
            <line x1="28" y1="56" x2="8.5" y2="5" />
            {/* right diagonal: bottom rim → upper-right rim (cuts off a segment) */}
            <line x1="28" y1="56" x2="47.5" y2="5" />
            {/* crossbar: joins the diagonals across the central region */}
            <line x1="18.1" y1="30" x2="37.9" y2="30" />
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

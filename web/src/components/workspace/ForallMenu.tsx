"use client";

import { forwardRef, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../stores/auth";
import { useUnreadCounts } from "../../stores/unread";
import { useMessagesOverlay } from "../../stores/messagesOverlay";
import { useDashboardOverlay } from "../../stores/dashboardOverlay";
import { useLedgerOverlay } from "../../stores/ledgerOverlay";
import { useSettingsOverlay } from "../../stores/settingsOverlay";
import { useLibraryOverlay } from "../../stores/libraryOverlay";
import { useNetworkOverlay } from "../../stores/networkOverlay";
import { useGlasshousePresence } from "../../stores/glasshouse";
import { useIsMobile } from "../../hooks/useIsMobile";
import { SearchPanel } from "./SearchPanel";
import { LIGHT_ISLAND_STYLE } from "../../lib/palette/island";

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
  /** Placement of the ∀ trigger. "floating" is the desktop disc at the
   *  bottom-right of the canvas; "bar" docks a smaller disc into the mobile
   *  bar's right end, with the menu dropping DOWN below the bar
   *  (MOBILE-LAYOUT-ADR §III — the bar's burger is the ∀, the existing
   *  command surface, not a second menu system). Same rows, same z-60
   *  crisp-above-the-frost invariant. */
  anchor?: "floating" | "bar";
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
  anchor = "floating",
}: ForallMenuProps) {
  const inBar = anchor === "bar";
  const discSize = inBar ? 36 : 56;
  const router = useRouter();
  const logout = useAuth((s) => s.logout);
  const dmCount = useUnreadCounts((s) => s.dmCount);
  const notificationCount = useUnreadCounts((s) => s.notificationCount);
  const totalUnread = dmCount + notificationCount;

  // True whenever a ∀-menu destination overlay is open (Messages / Dashboard /
  // Library / Network / Ledger / Settings). While one is, the disc is the way
  // back to the workspace: its glyph becomes an X and a click closes the overlay
  // (the workspace underneath resumes the feed you left — on mobile via the
  // resume key). This is the "always a way back" affordance — no in-panel
  // "back to workspace" prompts needed.
  const msgOpen = useMessagesOverlay((s) => s.isOpen);
  const dashOpen = useDashboardOverlay((s) => s.isOpen);
  const libOpen = useLibraryOverlay((s) => s.isOpen);
  const netOpen = useNetworkOverlay((s) => s.isOpen);
  const ledgerOpen = useLedgerOverlay((s) => s.isOpen);
  const settingsOpen = useSettingsOverlay((s) => s.isOpen);
  const menuOverlayOpen =
    msgOpen || dashOpen || libOpen || netOpen || ledgerOpen || settingsOpen;

  // On the mobile workspace every Glasshouse is a full-screen sheet (note /
  // article / feed composers, reader, profile, the six destinations …), so the
  // disc is the minimise-X for *any* of them — not just the six menu
  // destinations. The presence registry tracks whichever single sheet is live;
  // we collapse it to the disc-X and close it on tap. On desktop those non-menu
  // panes are draggable windows with their own ✕, so the disc stays the ∀ there
  // and only the six destinations flip it (the existing behaviour).
  const isMobile = useIsMobile();
  const glasshouseOpen = useGlasshousePresence((s) => s.isOpen);
  const mobileSheetOpen = isMobile && glasshouseOpen;

  const [view, setView] = useState<View>("closed");

  // On mobile the ∀ menu and its in-place panels (Search) are not Glasshouse
  // sheets, so they aren't tracked by the presence registry above — yet the
  // disc is still the only way to dismiss them (no outside-click target, no ✕
  // on the panel). So treat any open ∀ surface as a close state on mobile too:
  // the disc shows the X and `onTriggerClick`'s toggle (view !== "closed" →
  // "closed") dismisses it. Desktop keeps the disc as ∀ while the dropdown is
  // open — a mouse can click outside, and an X on a small anchored dropdown
  // would read oddly.
  const mobileMenuOpen = isMobile && view !== "closed";
  // The disc shows the close glyph whenever it would act as a minimise-X.
  const showClose = menuOverlayOpen || mobileSheetOpen || mobileMenuOpen;
  const [activeIndex, setActiveIndex] = useState(0);
  // ∀ glyph rotation. Hover rotates it to 180° (a right-side-up A) and holds;
  // leaving completes the turn to 360° (back to ∀), then snaps to 0 for next
  // time. `spinTransition` is dropped to "none" only for that invisible
  // 360°→0° reset so it doesn't visibly unwind.
  const [glyphRot, setGlyphRot] = useState(0);
  const [spinTransition, setSpinTransition] = useState(true);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const wordmarkRef = useRef<HTMLButtonElement>(null);
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
      // Notifications folded into Messages — one merged inbox surface. The count
      // is the combined unread (DMs + notifications).
      kind: "overlay",
      onOpen: () => useMessagesOverlay.getState().open(),
      label: "Messages",
      count: dmCount + notificationCount,
    },
    {
      kind: "overlay",
      onOpen: () => useDashboardOverlay.getState().open(),
      label: "Dashboard",
      count: 0,
    },
    {
      kind: "overlay",
      onOpen: () => useLibraryOverlay.getState().open(),
      label: "Library",
      count: 0,
    },
    {
      kind: "overlay",
      onOpen: () => useNetworkOverlay.getState().open(),
      label: "Network",
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
  ];
  const restoreRows: FocusRow[] = hiddenFeeds.map((hf) => ({
    kind: "restore",
    id: hf.id,
    label: hf.name,
  }));
  // Sign-out is the terminal action, in its own group at the very bottom. The
  // workspace is the only logged-in surface that renders no black topbar (the
  // ∀ is its sole nav), so the topbar's avatar-dropdown "Log out" is
  // unreachable here — the menu has to carry it. logout() clears the session;
  // WorkspaceView's `!user` guard then bounces to /auth.
  const accountRows: FocusRow[] = [
    {
      kind: "overlay",
      onOpen: () => {
        void logout();
      },
      label: "Log out",
      count: 0,
    },
  ];
  const groups: FocusRow[][] = [
    findRows,
    createRows,
    goRows,
    restoreRows,
    accountRows,
  ].filter((g) => g.length > 0);
  const rows: FocusRow[] = groups.flat();

  function closeAll() {
    setView("closed");
    buttonRef.current?.focus();
  }

  function closeMenuOverlays() {
    useMessagesOverlay.getState().close();
    useDashboardOverlay.getState().close();
    useLibraryOverlay.getState().close();
    useNetworkOverlay.getState().close();
    useLedgerOverlay.getState().close();
    useSettingsOverlay.getState().close();
  }

  // The disc / wordmark trigger. While a menu destination overlay is open it is
  // the back-to-workspace button (close the overlay); otherwise it toggles the
  // command menu.
  function onTriggerClick() {
    // Mobile: any open full-screen sheet (incl. the six destinations, which are
    // also Glasshouses) minimises through the presence registry.
    if (mobileSheetOpen) {
      useGlasshousePresence.getState().close();
      return;
    }
    if (menuOverlayOpen) {
      closeMenuOverlays();
      return;
    }
    setView((v) => (v === "closed" ? "menu" : "closed"));
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
      // The wordmark is a separate stacking-layer sibling (it sits BELOW the
      // scrim so a glasshouse hides it), but it's part of the trigger — a click
      // on it toggles the menu, so it must not count as an outside click.
      if (wordmarkRef.current?.contains(e.target as Node)) return;
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
    <>
      {/* Wordmark lockup — "all.haus" set to the LEFT of the ∀ disc so the two
          read as one mark (text · glyph). It's part of the trigger's click
          target (same toggle + glyph-spin as the disc) and, like the disc,
          stays CRISP above the frost: it sits at z-60 (the ForallMenu layer),
          above the Glasshouse scrim (z-[55]), so an open overlay never blurs or
          dims it. Floating only — the mobile bar already carries its own
          wordmark. */}
      {!inBar && (
        <button
          ref={wordmarkRef}
          type="button"
          aria-hidden="true"
          tabIndex={-1}
          onClick={onTriggerClick}
          onMouseEnter={() => {
            setSpinTransition(true);
            setGlyphRot(180);
          }}
          onMouseLeave={() => {
            setSpinTransition(true);
            setGlyphRot(360);
          }}
          style={{
            position: "fixed",
            right: 24 + discSize + 14,
            bottom: 24,
            height: discSize,
            display: "flex",
            alignItems: "center",
            zIndex: 60,
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
          }}
        >
          <span
            className="font-sans font-medium leading-none"
            style={{
              fontSize: 24,
              // var(--ah-ink) (not the locked ink-925) so the wordmark flips to
              // light on the dark workspace floor under the global dark mode.
              color: "var(--ah-ink)",
              letterSpacing: "-0.01em",
            }}
          >
            all.haus
          </span>
        </button>
      )}

      <div
        ref={containerRef}
        style={
          // Light island: the ∀ disc + dropdown are LOCKED chrome — they render
          // identically in light and dark mode (the disc stays dark ink-925 with
          // a light bone glyph; the menu stays light). The wordmark is a sibling
          // outside this island, so it flips to light on the dark floor.
          inBar
            ? { ...LIGHT_ISLAND_STYLE, position: "fixed", right: 8, top: 6, zIndex: 60 }
            : { ...LIGHT_ISLAND_STYLE, position: "fixed", right: 24, bottom: 24, zIndex: 60 }
        }
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
            ...(inBar ? { top: discSize + 8 } : { bottom: 64 }),
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

      {view === "search" && (
        <SearchPanel
          onClose={closeAll}
          placement={inBar ? "below" : "above"}
        />
      )}

      <button
        ref={buttonRef}
        type="button"
        className="forall-trigger"
        aria-label={
          mobileMenuOpen && !menuOverlayOpen && !mobileSheetOpen
            ? "Close menu"
            : showClose
              ? "Back to workspace"
              : `Workspace actions${
                  totalUnread > 0 ? ` (${totalUnread} unread)` : ""
                }`
        }
        aria-haspopup="menu"
        aria-expanded={view !== "closed"}
        onClick={onTriggerClick}
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
          width: discSize,
          height: discSize,
          borderRadius: "50%",
          background: TOKENS.buttonBg,
          color: TOKENS.buttonFg,
          border: "none",
          padding: 0,
          cursor: "pointer",
          transition: "transform 120ms ease-out",
          // translateZ(0) pins the disc to its own integer-pixel compositor
          // layer so the open-menu scale (and the SVG spin inside) introduce no
          // fractional offset that could nudge the clipped rim (§III.3 item 4).
          transform:
            view !== "closed"
              ? "scale(1.04) translateZ(0)"
              : "scale(1) translateZ(0)",
        }}
      >
        {/* The ∀ is constructed, not typed: three bars forming the A skeleton,
            in the workspace floor colour, dividing the black disc. The two
            diagonals run from the bottom of the rim up to the rim on each side
            — each cutting off a *complete* circle segment — and the crossbar
            joins them across the central region.

            The diagonals' endpoints overshoot the circumference and the apex's
            cap spills past the bottom, so each leg fully reaches the rim with no
            anti-aliased gap — but the bar group is then *doubly clipped to the
            disc the user sees* (§III.3): the SVG `#forall-clip` (r=27, inset a
            hair inside the literal rim so the anti-aliased seam never reaches it)
            AND the `overflow:hidden`+`borderRadius:50%` wrapper span below, which
            clips in the SAME scaled coordinate space as the rendered rim. The two
            together make the disc background-independent — leg overshoot can never
            paint past the edge under any transform or DPR, so the legs read
            identically over the workspace floor and over the frosted scrim (the
            old single floor-on-floor clip leaked once the open-menu scale + spin
            stopped the compositor cancelling the tips against the floor).
            Wrapper + inner SVG so the unread badge stays an UN-clipped sibling on
            the button. */}
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            overflow: "hidden",
          }}
        >
        <svg
          aria-hidden="true"
          viewBox="0 0 56 56"
          onTransitionEnd={(e) => {
            // The completing turn has landed back at ∀ — snap 360°→0° with no
            // transition so the next hover starts cleanly from upside-down. Only
            // the svg's own transform counts (the glyph groups bubble their
            // morph transitions up here too).
            if (
              e.target === e.currentTarget &&
              e.propertyName === "transform" &&
              glyphRot === 360
            ) {
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
            // The close glyph never spins — when it's showing, the hover spin is
            // pinned to 0 and the ∀↔X swap is carried by the two groups below.
            transform: `rotate(${showClose ? 0 : glyphRot}deg)`,
            transition: spinTransition ? "transform 480ms ease-in-out" : "none",
          }}
        >
          <defs>
            {/* The disc itself — clips the bars so their overshoot can never
                paint past the rim. Centred on the rotation origin (28,28), so a
                circle is invariant under both the hover spin and the group morph
                rotations and stays aligned with the button's border-radius disc. */}
            <clipPath id="forall-clip">
              <circle cx="28" cy="28" r="27" />
            </clipPath>
          </defs>
          {/* The ∀ and the close-X are stacked groups that cross-fade with a
              discreet quarter-turn between them — a soft morph, not a hard swap.
              The idle/∀ group fades+rotates out as the X fades+rotates in (and
              vice-versa). Both rotate about the view-box centre so the clipped
              disc never shifts. stroke via style, not the presentation
              attribute — the token is a var() reference, which attributes don't
              resolve. */}
          <g
            clipPath="url(#forall-clip)"
            style={{
              stroke: TOKENS.glyphFg,
              opacity: showClose ? 0 : 1,
              transform: `rotate(${showClose ? -90 : 0}deg)`,
              transformBox: "view-box",
              transformOrigin: "28px 28px",
              transition:
                "opacity 200ms ease, transform 260ms cubic-bezier(0.4, 0, 0.2, 1)",
            }}
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
          <g
            clipPath="url(#forall-clip)"
            style={{
              stroke: TOKENS.glyphFg,
              opacity: showClose ? 1 : 0,
              transform: `rotate(${showClose ? 0 : 90}deg)`,
              transformBox: "view-box",
              transformOrigin: "28px 28px",
              transition:
                "opacity 200ms ease, transform 260ms cubic-bezier(0.4, 0, 0.2, 1)",
            }}
            strokeWidth={6}
            strokeLinecap="round"
            fill="none"
          >
            {/* Close glyph: a large X spanning the disc, the same white bars
                construction as the ∀, signalling "back to workspace". */}
            <line x1="11" y1="11" x2="45" y2="45" />
            <line x1="45" y1="11" x2="11" y2="45" />
          </g>
        </svg>
        </span>
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
    </>
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

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
import { useColorScheme } from "../../stores/colorScheme";
import { useExplain } from "../../stores/explain";
import { useAboutOverlay } from "../../stores/aboutOverlay";
import { useOpenExplain, useExplainable } from "./ExplainProvider";
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
  /** The feed the menu is relativised to — the one under the reader's thumb on
   *  the mobile pager. When set, the menu carries a feed-scoped "Feed settings"
   *  row (the discoverable twin of tapping the active pip — MOBILE-LAYOUT-ADR
   *  §VI). Null on the desktop canvas, where there is no single active feed and
   *  each vessel carries its own gear, so the row is suppressed there. */
  currentFeed?: { id: string; name: string } | null;
  /** Open the FeedComposer for the feed-scoped row's target. */
  onFeedSettings?: (feedId: string) => void;
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
  | {
      kind: "overlay";
      onOpen: () => void;
      label: string;
      count: number;
      // Secondary-tier destinations (Library / Network / Ledger / Settings)
      // render in the muted weight so the menu reads as a primary pair
      // (Messages · Dashboard) over a quieter account cluster, without dropping
      // any destination (they all stay reachable here).
      muted?: boolean;
      // D10: the Explain row disables (dim + title, inert on select) while any
      // Glasshouse pane is open — v1 discovery never has to arbitrate occlusion.
      disabled?: boolean;
      disabledTitle?: string;
    }
  | { kind: "link"; href: string; label: string; count: number }
  | { kind: "restore"; id: string; label: string };

export function ForallMenu({
  onAction,
  hiddenFeeds = [],
  onRestore,
  currentFeed = null,
  onFeedSettings,
  anchor = "floating",
}: ForallMenuProps) {
  const inBar = anchor === "bar";
  const discSize = inBar ? 36 : 56;
  // The disc inverts under global dark mode — a light bone disc with a dark ink
  // glyph, the photo-negative of the light-mode dark disc. The disc stays
  // islanded (its tokens resolve to canonical light in both modes), so we pick
  // the swapped token explicitly rather than letting the root inversion do it.
  // The dropdown menu is unaffected (still light). See globals.css dark block.
  const dark = useColorScheme((s) => s.dark);
  const discBg = dark ? "var(--ah-bone)" : TOKENS.buttonBg;
  const discGlyph = dark ? "var(--ah-ink-925)" : TOKENS.glyphFg;
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

  // Explain chrome swap (EXPLAIN-ADR D3, 2026-07-15 form). While an Explain
  // program is active only the WORDMARK gives way to an "About all.haus"
  // button; the ∀ disc itself stays on screen, is annotated in place (hovering
  // it surfaces the `disc` label), and clicking it exits Explain — no more
  // awkwardly describing an invisible menu. `isActive` is only ever set on the
  // desktop floor (Explain is desktop-only), so this naturally scopes to the
  // floating anchor. While the About pane itself is open the About button is
  // suppressed (the pane owns its own dismiss) and the disc flips to the X,
  // closing the pane back to Explain.
  const explainActive = useExplain((s) => s.isActive);
  const aboutOpen = useAboutOverlay((s) => s.isOpen);
  const openExplain = useOpenExplain();

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
  // The disc shows the close glyph whenever it would act as a minimise-X —
  // including the About pane opened from Explain (a click closes it back to
  // Explain). During plain Explain the disc keeps the ∀: it is being annotated
  // as the menu, so it must look like the menu.
  const showClose =
    menuOverlayOpen ||
    mobileSheetOpen ||
    mobileMenuOpen ||
    (explainActive && aboutOpen);
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

  // The `disc` explainable root is the REAL ∀ disc (2026-07-15 rework: the
  // chrome swap keeps the disc on screen, replacing only the wordmark), so the
  // first-run beat-4 leader and any anchored fallback point at the disc itself.
  useExplainable<HTMLButtonElement>("disc", { ref: buttonRef });

  // Rows are grouped find → make → go: search first (the way in), then the
  // create actions, then the destinations, then any hidden-feed restores. The
  // groups render with a tight gap between them and flatten into `rows` for
  // arrow-key navigation.
  const findRows: FocusRow[] = [
    { kind: "open", target: "search", label: "Search", count: 0 },
  ];
  // Feed-scoped row — present only when the menu is relativised to a feed (the
  // mobile pager's active feed). Its own group, directly under Search, so the
  // action that's about "the thing you're looking at" sits at the top of the
  // make/do region. Reuses the overlay row (an onOpen closure) rather than a
  // new ForallAction, since it targets a specific feed, not a global create.
  const feedRows: FocusRow[] =
    currentFeed && onFeedSettings
      ? [
          {
            kind: "overlay",
            onOpen: () => onFeedSettings(currentFeed.id),
            label: "Feed settings",
            count: 0,
          },
        ]
      : [];
  const createRows: FocusRow[] = [
    { kind: "action", key: "new-note", label: "New note" },
    { kind: "action", key: "new-article", label: "Write an article" },
    { kind: "action", key: "new-feed", label: "New feed" },
  ];
  // Explain — its own group, single primary option (EXPLAIN-ADR §8, keep the
  // menu slim). Desktop only (Explain doesn't mount on the mobile branch), and
  // disabled while any Glasshouse pane is open (D10): v1 discovery never has to
  // arbitrate which surface is topmost.
  const explainRows: FocusRow[] = !isMobile
    ? [
        {
          kind: "overlay",
          onOpen: () => openExplain(),
          label: "Explain",
          count: 0,
          disabled: glasshouseOpen,
          disabledTitle: "close this pane to use Explain",
        },
      ]
    : [];
  // The go-group keeps all six destinations but reads in two tiers: a primary
  // pair (the high-traffic inbox + dashboard) over a muted account cluster.
  // Same group-gap separates them; the muted weight does the demoting.
  const goPrimaryRows: FocusRow[] = [
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
  ];
  const goSecondaryRows: FocusRow[] = [
    {
      kind: "overlay",
      onOpen: () => useLibraryOverlay.getState().open(),
      label: "Library",
      count: 0,
      muted: true,
    },
    {
      kind: "overlay",
      onOpen: () => useNetworkOverlay.getState().open(),
      label: "Network",
      count: 0,
      muted: true,
    },
    {
      kind: "overlay",
      onOpen: () => useLedgerOverlay.getState().open(),
      label: "Ledger",
      count: 0,
      muted: true,
    },
    {
      kind: "overlay",
      onOpen: () => useSettingsOverlay.getState().open(),
      label: "Settings",
      count: 0,
      muted: true,
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
    feedRows,
    createRows,
    explainRows,
    goPrimaryRows,
    goSecondaryRows,
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
    // While Explain is active the disc is the way back out (EXPLAIN-ADR D3,
    // 2026-07-15 form): close the About pane if it is open (back to Explain),
    // else close Explain itself. Never toggle the menu over the frozen floor.
    if (explainActive) {
      if (aboutOpen) useAboutOverlay.getState().close();
      else useExplain.getState().close();
      return;
    }
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
        if (row.disabled) return; // D10: inert while disabled (keep menu open)
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
      {/* D3 chrome swap (2026-07-15 form): while an Explain program is active
          only the WORDMARK gives way to an "About all.haus" button in the same
          spot — the disc stays, gets annotated as itself, and its click exits
          Explain (onTriggerClick above). The button is islanded like the disc
          so its tokens resolve canonical-light, then takes the same dark-mode
          photo-negative (bone pill + ink label). Suppressed while the About
          pane is open (the pane owns its own dismiss); restored on close. */}
      {!inBar && explainActive && !aboutOpen && (
        <div
          style={{
            ...LIGHT_ISLAND_STYLE,
            position: "fixed",
            right: 24 + discSize + 14,
            bottom: 24,
            zIndex: 60,
          }}
        >
          <button
            type="button"
            className="forall-trigger font-sans font-medium"
            aria-label="About all.haus"
            onClick={() => useAboutOverlay.getState().open()}
            // The button sits above the Explain scrim, so the scrim's
            // pointermove hit-test never reaches it — it reports its own hover
            // (the `about` label) to honour Explain's "hover anything, read its
            // label" contract. Click opens About; hover teaches.
            onMouseEnter={() =>
              useExplain.getState().setHover({ kind: "about" })
            }
            onMouseLeave={() => useExplain.getState().setHover(null)}
            style={{
              height: discSize,
              display: "flex",
              alignItems: "center",
              padding: "0 22px",
              borderRadius: discSize / 2,
              background: discBg,
              color: discGlyph,
              border: "none",
              cursor: "pointer",
              fontSize: 16,
              lineHeight: 1,
              whiteSpace: "nowrap",
            }}
          >
            About all.haus
          </button>
        </div>
      )}
      {/* Wordmark lockup — "all.haus" set to the LEFT of the ∀ disc so the two
          read as one mark (text · glyph). It's part of the trigger's click
          target (same toggle + glyph-spin as the disc) and, like the disc,
          stays CRISP above the frost: it sits at z-60 (the ForallMenu layer),
          above the Glasshouse scrim (z-[55]), so an open overlay never blurs or
          dims it. Floating only — the mobile bar already carries its own
          wordmark. Gives way to the About button while Explain is active. */}
      {!inBar && !explainActive && (
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
          // Light island: the dropdown is LOCKED chrome — it stays light in both
          // modes (its tokens resolve to canonical light here). The disc lives in
          // the same island so its tokens also resolve light, but it explicitly
          // INVERTS its fill/glyph under dark mode (discBg/discGlyph above): a
          // light bone disc + dark ink glyph, the photo-negative of light mode.
          // The wordmark is a sibling outside this island, so it flips to light
          // on the dark floor.
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
          explainActive
            ? aboutOpen
              ? "Back to Explain"
              : "Exit Explain"
            : mobileMenuOpen && !menuOverlayOpen && !mobileSheetOpen
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
          // The disc sits above the Explain scrim, so it reports its own hover
          // to the engine (the `disc` label) — the scrim's hit-test never
          // reaches it. Suppressed while the About pane is open (bubbles
          // render below the Glasshouse scrim).
          if (explainActive && !aboutOpen)
            useExplain.getState().setHover({ kind: "disc" });
        }}
        onMouseLeave={() => {
          setSpinTransition(true);
          setGlyphRot(360);
          if (explainActive) useExplain.getState().setHover(null);
        }}
        style={{
          position: "relative",
          width: discSize,
          height: discSize,
          borderRadius: "50%",
          background: discBg,
          color: discGlyph,
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
        {/* The ∀ is constructed, not typed: stroked bars forming the A
            skeleton, in the workspace floor colour, dividing the black disc.
            The legs are one mitred path — a sharp interior apex (miter tip
            ≈(28,52.2), ~2.9 clear of the r=27 clip) with both legs running up
            through the top rim — and the straight crossbar sits in the upper
            third of the glyph, slightly lighter than the legs (canonical
            geometry + disc placement: docs/adr/LOGO-REFINEMENT-SPEC.md).

            The legs' endpoints overshoot the top circumference, so each leg
            fully reaches the rim with no anti-aliased gap — but the bar group
            is then *doubly clipped to the
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
              stroke: discGlyph,
              opacity: showClose ? 0 : 1,
              transform: `rotate(${showClose ? -90 : 0}deg)`,
              transformBox: "view-box",
              transformOrigin: "28px 28px",
              transition:
                "opacity 200ms ease, transform 260ms cubic-bezier(0.4, 0, 0.2, 1)",
            }}
            strokeWidth={5}
            strokeLinecap="butt"
            fill="none"
          >
            {/* legs: one path so the interior apex miter-joins — two separate
                lines with butt caps would notch at the apex */}
            <path
              d="M10.6 -1.7 L28 45 L45.4 -1.7"
              strokeLinejoin="miter"
              strokeMiterlimit={6}
            />
            {/* crossbar: upper third, slightly lighter than the legs */}
            <line x1="18" y1="22" x2="38" y2="22" strokeWidth={4.2} />
          </g>
          <g
            clipPath="url(#forall-clip)"
            style={{
              stroke: discGlyph,
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
              border: `2px solid ${discBg}`,
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
  const disabled = row.kind === "overlay" && row.disabled === true;
  // Secondary-tier destinations dim to the muted weight too, but keep the
  // normal row font (only restores get the small label-ui treatment). A disabled
  // row (D10 Explain-while-pane-open) reads muted as well.
  const muted =
    disabled || isRestore || (row.kind === "overlay" && row.muted === true);
  const count =
    row.kind === "open" || row.kind === "link" || row.kind === "overlay"
      ? row.count
      : 0;
  return (
    <button
      ref={ref}
      role="menuitem"
      type="button"
      aria-disabled={disabled || undefined}
      title={
        row.kind === "overlay" && disabled ? row.disabledTitle : undefined
      }
      onClick={onSelect}
      onMouseEnter={onHover}
      className={`${isRestore ? "label-ui" : "font-sans text-ui-sm"} block w-full text-left`}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        color: muted ? TOKENS.itemMuted : TOKENS.itemFg,
        opacity: disabled ? 0.55 : 1,
        padding: isRestore ? "8px 14px 8px 24px" : "10px 14px",
        background: active ? TOKENS.itemFocusBg : "transparent",
        transition: "background 80ms linear",
        outline: "none",
        border: "none",
        cursor: disabled ? "default" : "pointer",
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

"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";

interface ActionSheetAction {
  label: string;
  onClick: (e: React.MouseEvent) => void;
  hidden?: boolean;
}

interface ActionSheetProps {
  actions: ActionSheetAction[];
}

export function ActionSheet({ actions }: ActionSheetProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  const visibleActions = actions.filter((a) => !a.hidden);
  if (visibleActions.length === 0) return null;

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setOpen((prev) => !prev);
  }, []);

  useEffect(() => {
    if (!open) return;
    function handleOutside(e: MouseEvent | TouchEvent) {
      const target = e.target as Node;
      if (
        sheetRef.current &&
        !sheetRef.current.contains(target) &&
        triggerRef.current &&
        !triggerRef.current.contains(target)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    document.addEventListener("touchstart", handleOutside);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      document.removeEventListener("touchstart", handleOutside);
    };
  }, [open]);

  return (
    <span className="relative inline-block">
      <button
        ref={triggerRef}
        onClick={handleToggle}
        className="text-grey-600 hover:text-black transition-colors px-1"
        aria-label="More actions"
      >
        ⋯
      </button>
      {open &&
        createPortal(
          <ActionSheetPopover
            ref={sheetRef}
            triggerRef={triggerRef}
            actions={visibleActions}
            onClose={() => setOpen(false)}
          />,
          document.body,
        )}
    </span>
  );
}

import { forwardRef } from "react";

const ActionSheetPopover = forwardRef<
  HTMLDivElement,
  {
    triggerRef: React.RefObject<HTMLButtonElement | null>;
    actions: ActionSheetAction[];
    onClose: () => void;
  }
>(function ActionSheetPopover({ triggerRef, actions, onClose }, ref) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const above = rect.top > window.innerHeight / 2;
    setPos({
      top: above ? rect.top - actions.length * 36 - 8 : rect.bottom + 4,
      left: Math.max(8, rect.left - 100),
    });
  }, [triggerRef, actions.length]);

  if (!pos) return null;

  return (
    <div
      ref={ref}
      style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 50 }}
      className="bg-white border border-grey-200 shadow-lg py-1 min-w-[140px]"
    >
      {actions.map((action) => (
        <button
          key={action.label}
          onClick={(e) => {
            action.onClick(e);
            onClose();
          }}
          className="block w-full text-left px-4 py-2 label-ui text-grey-600 hover:bg-grey-50 hover:text-black transition-colors"
        >
          {action.label}
        </button>
      ))}
    </div>
  );
});

"use client";

import React, {
  useRef,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";

interface PullToRefreshProps {
  onRefresh: () => Promise<void>;
  children: ReactNode;
}

const THRESHOLD = 60;
const WHEEL_DECAY_MS = 400;

function findScrollParent(el: HTMLElement): HTMLElement {
  let cur = el.parentElement;
  while (cur) {
    const { overflowY } = getComputedStyle(cur);
    if (overflowY === "auto" || overflowY === "scroll") return cur;
    cur = cur.parentElement;
  }
  return el;
}

export function PullToRefresh({ onRefresh, children }: PullToRefreshProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pulling, setPulling] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef(0);
  const active = useRef(false);
  const wheelAccum = useRef(0);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doRefresh = useCallback(() => {
    setRefreshing(true);
    setPullDistance(THRESHOLD * 0.6);
    onRefresh().finally(() => {
      setRefreshing(false);
      setPullDistance(0);
      setPulling(false);
    });
  }, [onRefresh]);

  // Touch handlers (mobile)
  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (refreshing) return;
      const el = containerRef.current;
      if (!el) return;
      const scroller = findScrollParent(el);
      if (scroller.scrollTop > 0) return;
      startY.current = e.touches[0].clientY;
      active.current = true;
    },
    [refreshing],
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!active.current || refreshing) return;
      const delta = e.touches[0].clientY - startY.current;
      if (delta <= 0) {
        setPullDistance(0);
        setPulling(false);
        return;
      }
      const dampened = Math.min(delta * 0.5, THRESHOLD * 1.5);
      setPullDistance(dampened);
      setPulling(dampened >= THRESHOLD);
    },
    [refreshing],
  );

  const onTouchEnd = useCallback(() => {
    if (!active.current) return;
    active.current = false;

    if (pulling && !refreshing) {
      doRefresh();
    } else {
      setPullDistance(0);
      setPulling(false);
    }
  }, [pulling, refreshing, doRefresh]);

  // Wheel handler (desktop): accumulate upward scroll while at top
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (refreshing) return;
      const el = containerRef.current;
      if (!el) return;
      const scroller = findScrollParent(el);
      if (scroller.scrollTop > 0 || e.deltaY >= 0) {
        wheelAccum.current = 0;
        if (pullDistance > 0 && !refreshing) {
          setPullDistance(0);
          setPulling(false);
        }
        return;
      }
      wheelAccum.current += Math.abs(e.deltaY);
      if (wheelTimer.current) clearTimeout(wheelTimer.current);
      wheelTimer.current = setTimeout(() => {
        wheelAccum.current = 0;
        if (!refreshing) {
          setPullDistance(0);
          setPulling(false);
        }
      }, WHEEL_DECAY_MS);

      const dampened = Math.min(wheelAccum.current * 0.4, THRESHOLD * 1.5);
      setPullDistance(dampened);
      if (dampened >= THRESHOLD) {
        wheelAccum.current = 0;
        if (wheelTimer.current) clearTimeout(wheelTimer.current);
        setPulling(false);
        doRefresh();
      } else {
        setPulling(dampened >= THRESHOLD * 0.8);
      }
    },
    [refreshing, pullDistance, doRefresh],
  );

  useEffect(() => {
    return () => {
      if (wheelTimer.current) clearTimeout(wheelTimer.current);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onWheel={onWheel}
      style={{ position: "relative" }}
    >
      {(pullDistance > 0 || refreshing) && (
        <div
          className="flex items-center justify-center"
          style={{
            height: pullDistance,
            overflow: "hidden",
            transition: active.current ? "none" : "height 0.2s ease",
          }}
        >
          <span className="label-ui text-grey-400">
            {refreshing
              ? "REFRESHING..."
              : pulling
                ? "RELEASE TO REFRESH"
                : "↑ PULL TO REFRESH"}
          </span>
        </div>
      )}
      {children}
    </div>
  );
}

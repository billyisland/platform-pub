"use client";

import React, {
  useRef,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
  type RefObject,
} from "react";

interface PullToRefreshProps {
  onRefresh: () => Promise<void>;
  children: ReactNode;
  scrollRef?: RefObject<HTMLElement | null>;
}

const THRESHOLD = 60;
const WHEEL_DECAY_MS = 400;
// How long the feed must rest at the top (no upward wheel events) before a
// fresh scroll-up is treated as an intentional refresh gesture. This keeps the
// single continuous scroll-to-top that opens the top card's conversation from
// rolling straight into a refresh — the user must stop, then scroll up again.
const ARM_IDLE_MS = 220;

function findScrollParent(el: HTMLElement): HTMLElement {
  let cur = el.parentElement;
  while (cur) {
    const { overflowY } = getComputedStyle(cur);
    if (overflowY === "auto" || overflowY === "scroll") return cur;
    cur = cur.parentElement;
  }
  return el;
}

export function PullToRefresh({
  onRefresh,
  children,
  scrollRef,
}: PullToRefreshProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pulling, setPulling] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef(0);
  const active = useRef(false);
  const wheelAccum = useRef(0);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Refresh is "armed" only once the feed has settled at the top; until then,
  // upward wheel deltas are ignored so the scroll-to-top gesture itself can't
  // trigger a refresh.
  const armed = useRef(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doRefresh = useCallback(() => {
    armed.current = false;
    if (armTimer.current) {
      clearTimeout(armTimer.current);
      armTimer.current = null;
    }
    setRefreshing(true);
    setPullDistance(THRESHOLD * 0.6);
    void onRefresh().finally(() => {
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
      const scroller = scrollRef?.current ?? findScrollParent(el);
      if (scroller.scrollTop > 0) return;
      startY.current = e.touches[0].clientY;
      active.current = true;
    },
    [refreshing, scrollRef],
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
      const scroller = scrollRef?.current ?? findScrollParent(el);
      if (scroller.scrollTop > 0 || e.deltaY >= 0) {
        // Scrolling through content or downward: disarm. Reaching the top via
        // this gesture must not count toward a refresh.
        wheelAccum.current = 0;
        armed.current = false;
        if (armTimer.current) {
          clearTimeout(armTimer.current);
          armTimer.current = null;
        }
        if (pullDistance > 0 && !refreshing) {
          setPullDistance(0);
          setPulling(false);
        }
        return;
      }
      // At the top, scrolling up. If not yet armed, this is (the tail of) the
      // gesture that brought us here — don't accumulate. Instead wait for a
      // quiet gap: a continuous gesture keeps resetting this timer, so it only
      // fires once the feed has come to rest, arming the next scroll-up.
      if (!armed.current) {
        if (armTimer.current) clearTimeout(armTimer.current);
        armTimer.current = setTimeout(() => {
          armed.current = true;
          armTimer.current = null;
        }, ARM_IDLE_MS);
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
    [refreshing, pullDistance, doRefresh, scrollRef],
  );

  useEffect(() => {
    return () => {
      if (wheelTimer.current) clearTimeout(wheelTimer.current);
      if (armTimer.current) clearTimeout(armTimer.current);
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

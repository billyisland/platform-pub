"use client";

import React, { useRef, useState, useCallback, type ReactNode } from "react";

interface PullToRefreshProps {
  onRefresh: () => Promise<void>;
  children: ReactNode;
}

const THRESHOLD = 60;

export function PullToRefresh({ onRefresh, children }: PullToRefreshProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pulling, setPulling] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef(0);
  const active = useRef(false);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (refreshing) return;
      const el = containerRef.current;
      if (!el || el.scrollTop > 0) return;
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
      setRefreshing(true);
      setPullDistance(THRESHOLD * 0.6);
      onRefresh().finally(() => {
        setRefreshing(false);
        setPullDistance(0);
        setPulling(false);
      });
    } else {
      setPullDistance(0);
      setPulling(false);
    }
  }, [pulling, refreshing, onRefresh]);

  return (
    <div
      ref={containerRef}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      style={{ position: "relative", height: "100%", overflowY: "auto" }}
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
                : "PULL TO REFRESH"}
          </span>
        </div>
      )}
      {children}
    </div>
  );
}

"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useAuthorCard, type AuthorCardData } from "../../hooks/useAuthorCard";
import { follows as followsApi, feeds as feedsApi } from "../../lib/api";

interface AuthorModalProps {
  type: "native" | "external";
  id: string;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function AuthorModal({
  type,
  id,
  anchorRef,
  onClose,
}: AuthorModalProps) {
  const { data, loading } = useAuthorCard(type, id, true);
  const modalRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    below: boolean;
  } | null>(null);

  useEffect(() => {
    if (!anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const below = rect.bottom + 320 < window.innerHeight;
    setPosition({
      top: below ? rect.bottom + 6 : rect.top - 6,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 316)),
      below,
    });
  }, [anchorRef]);

  if (!position) return null;

  const style: React.CSSProperties = {
    position: "fixed",
    left: position.left,
    width: 300,
    zIndex: 50,
    ...(position.below
      ? { top: position.top }
      : { bottom: window.innerHeight - position.top }),
  };

  return createPortal(
    <div
      ref={modalRef}
      style={style}
      className="bg-white border border-grey-200 shadow-lg p-4"
      onMouseLeave={onClose}
    >
      {loading && <ModalSkeleton />}
      {data && !loading && <ModalContent data={data} onClose={onClose} />}
      {!data && !loading && (
        <p className="text-ui-xs text-grey-400">Could not load profile</p>
      )}
    </div>,
    document.body,
  );
}

function ModalSkeleton() {
  return (
    <div className="animate-pulse space-y-3">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-grey-200 rounded-full" />
        <div className="flex-1 space-y-1.5">
          <div className="h-3 bg-grey-200 w-2/3" />
          <div className="h-2.5 bg-grey-100 w-1/2" />
        </div>
      </div>
      <div className="h-2.5 bg-grey-100 w-full" />
      <div className="h-2.5 bg-grey-100 w-3/4" />
    </div>
  );
}

function ModalContent({
  data,
  onClose,
}: {
  data: AuthorCardData;
  onClose: () => void;
}) {
  if (data.tier === "D") {
    return (
      <div>
        {data.displayName && (
          <p className="text-ui-sm font-medium">{data.displayName}</p>
        )}
        {data.sourceName && (
          <p className="text-ui-xs text-grey-600">{data.sourceName}</p>
        )}
        <p className="label-ui text-grey-400 mt-2">
          LIMITED INFO FROM THIS SOURCE
        </p>
        {data.followTarget && (
          <FollowButton target={data.followTarget} onClose={onClose} />
        )}
      </div>
    );
  }

  if (data.tier === "C") {
    return (
      <div>
        {data.sourceName && (
          <p className="text-ui-sm font-medium">{data.sourceName}</p>
        )}
        {data.sourceDescription && (
          <p className="text-ui-xs text-grey-600 mt-1 line-clamp-3">
            {data.sourceDescription}
          </p>
        )}
        {data.followTarget && (
          <FollowButton target={data.followTarget} onClose={onClose} />
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-start gap-3">
        {data.avatarUrl && (
          <img
            src={data.avatarUrl}
            alt=""
            className="w-10 h-10 rounded-full object-cover bg-grey-100 flex-shrink-0"
            referrerPolicy="no-referrer"
          />
        )}
        <div className="min-w-0 flex-1">
          {data.displayName && (
            <p className="text-ui-sm font-medium truncate">
              {data.displayName}
            </p>
          )}
          {data.handle && (
            <p className="text-mono-xs text-grey-400 truncate">
              @{data.handle}
            </p>
          )}
        </div>
      </div>

      {data.bio && (
        <p className="text-ui-xs text-grey-600 mt-2 line-clamp-2">{data.bio}</p>
      )}

      {(data.followerCount != null ||
        data.followingCount != null ||
        data.postCount != null) && (
        <div className="flex items-center gap-3 mt-2.5">
          {data.followerCount != null && (
            <span className="text-mono-xs text-grey-600">
              <span className="font-medium text-black">
                {formatCount(data.followerCount)}
              </span>{" "}
              followers
            </span>
          )}
          {data.followingCount != null && (
            <span className="text-mono-xs text-grey-600">
              <span className="font-medium text-black">
                {formatCount(data.followingCount)}
              </span>{" "}
              following
            </span>
          )}
          {data.postCount != null && (
            <span className="text-mono-xs text-grey-600">
              <span className="font-medium text-black">
                {formatCount(data.postCount)}
              </span>{" "}
              posts
            </span>
          )}
        </div>
      )}

      {data.partial && (
        <p className="label-ui text-grey-300 mt-2">SOME DATA UNAVAILABLE</p>
      )}

      {data.followTarget && (
        <FollowButton target={data.followTarget} onClose={onClose} />
      )}
    </div>
  );
}

function FollowButton({
  target,
  onClose,
}: {
  target: NonNullable<AuthorCardData["followTarget"]>;
  onClose: () => void;
}) {
  const [following, setFollowing] = useState(target.isFollowing);
  const [busy, setBusy] = useState(false);

  const handleClick = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (busy) return;
      setBusy(true);
      const prev = following;
      setFollowing(!prev);

      try {
        if (target.type === "user") {
          if (prev) {
            await followsApi.unfollow(target.id);
          } else {
            await followsApi.follow(target.id);
          }
        } else {
          if (prev) {
            await feedsApi.remove(target.id);
          } else {
            // For source follows from the modal, we don't have enough info
            // to call subscribe (needs protocol/sourceUri). The user should
            // use the subscriptions page. Show "subscribed" state only.
            setFollowing(prev);
          }
        }
      } catch {
        setFollowing(prev);
      } finally {
        setBusy(false);
      }
    },
    [target, following, busy],
  );

  return (
    <button
      onClick={handleClick}
      disabled={busy}
      className={`mt-3 w-full py-1.5 text-ui-xs font-medium transition-colors ${
        following
          ? "bg-grey-100 text-grey-600 hover:bg-grey-200"
          : "bg-black text-white hover:bg-grey-800"
      }`}
    >
      {following ? "FOLLOWING" : "FOLLOW"}
    </button>
  );
}

export function useAuthorHover(type: "native" | "external", id: string | null) {
  const [open, setOpen] = useState(false);
  const bylineRef = useRef<HTMLElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modalEnteredRef = useRef(false);

  const supportsHover =
    typeof window !== "undefined" &&
    window.matchMedia("(hover: hover)").matches;

  const onMouseEnter = useCallback(() => {
    if (!supportsHover || !id) return;
    timerRef.current = setTimeout(() => {
      setOpen(true);
    }, 300);
  }, [supportsHover, id]);

  const onMouseLeave = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setTimeout(() => {
      if (!modalEnteredRef.current) {
        setOpen(false);
      }
    }, 100);
  }, []);

  const onModalClose = useCallback(() => {
    modalEnteredRef.current = false;
    setOpen(false);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return {
    bylineRef,
    open,
    onMouseEnter,
    onMouseLeave,
    onModalClose,
    type,
    id,
  };
}

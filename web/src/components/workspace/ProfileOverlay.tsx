"use client";

// =============================================================================
// ProfileOverlay — the single profile environment, opened over whatever surface
// the user is on. Driven by the useProfile store; mounted once globally in
// LayoutShell so any byline / profile link sitewide (ProfileLink) opens it in
// place. Renders, by target kind:
//   - native   → NativeProfilePanel (writer header + WriterActivity, by username)
//   - external → AuthorProfileView  (tier-A/B constructed profile, by author id)
// backed by a real URL (the store pushes /<username> or /author/<id>), so Back /
// Esc / scrim all close and restore the prior URL. Direct visits render the same
// profiles full-page ([username], author/[authorId]).
// =============================================================================

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useProfile } from "../../stores/profileOverlay";
import { Glasshouse } from "./Glasshouse";
import { NativeProfilePanel } from "../profile/NativeProfilePanel";
import { AuthorProfileView } from "../../app/author/[authorId]/AuthorProfileView";

export function ProfileOverlay() {
  const { isOpen, target, close, dismiss, _handlePop, frameColor } = useProfile();

  // Glasshouse owns the chrome, Escape, and scroll-lock. We keep two URL-sync
  // concerns: (1) browser Back pops our pushed entry → _handlePop finalises
  // close on popstate; (2) a link *inside* the overlay (an article opening at
  // /article·/reader) router-navigates away — pathname leaves our target, so we
  // dismiss without fighting that navigation's own history entry.
  useEffect(() => {
    if (!isOpen) return;
    window.addEventListener("popstate", _handlePop);
    return () => window.removeEventListener("popstate", _handlePop);
  }, [isOpen, _handlePop]);

  const pathname = usePathname();
  // Only dismiss on navigation *after* the pushed URL has settled to our target,
  // so the initial open (pathname still on the prior surface for a tick) doesn't
  // self-dismiss.
  const settledRef = useRef(false);
  useEffect(() => {
    if (!isOpen || !target) {
      settledRef.current = false;
      return;
    }
    const targetPath =
      target.kind === "native"
        ? `/${target.username}`
        : `/author/${target.authorId}`;
    const current = decodeURIComponent(pathname ?? "");
    if (current === targetPath) {
      settledRef.current = true;
    } else if (settledRef.current) {
      dismiss();
    }
  }, [pathname, isOpen, target, dismiss]);

  if (!isOpen || !target) return null;

  return (
    <Glasshouse
      onClose={close}
      onSupersede={dismiss}
      maxWidth={860}
      ariaLabel="Profile"
      persistKey="profile"
      frameColor={frameColor}
    >
      <div className="overflow-y-auto max-h-[var(--gh-h)] px-6 sm:px-10 py-12">
        {target.kind === "native" ? (
          <NativeProfilePanel username={target.username} />
        ) : (
          <AuthorProfileView authorId={target.authorId} inOverlay />
        )}
      </div>
    </Glasshouse>
  );
}

"use client";

// =============================================================================
// ProfileLink — the sitewide profile affordance.
//
// Renders a real <Link> to the profile's canonical URL (so SSR, cmd/middle-click
// "open in new tab", and right-click "copy link" all work), but intercepts a
// plain left-click to open the URL-synced profile overlay (useProfile) in place
// instead of navigating away. The overlay pushes the same URL into history, so
// Back closes it and a refresh resolves to the full page.
//
// The target kind is derived from the href alone — /author/:id → external,
// /:username (or /@:username) → native — so this is a drop-in for any existing
// `<Link href={profilePath}>`.
// =============================================================================

import Link from "next/link";
import type { ComponentProps, MouseEvent } from "react";
import { useProfile } from "../../stores/profileOverlay";

/** Classify a profile href into an overlay target, or null if it isn't one. */
export function profileTargetFromHref(
  href: string,
):
  | { kind: "native"; username: string }
  | { kind: "external"; authorId: string }
  | null {
  const ext = href.match(/^\/author\/([^/?#]+)/);
  if (ext) return { kind: "external", authorId: decodeURIComponent(ext[1]) };
  // Root-level /:username or /@:username (the native profile route).
  const native = href.match(/^\/@?([^/?#]+)/);
  if (native && native[1]) return { kind: "native", username: native[1] };
  return null;
}

/** Open the profile overlay for a profile href. Returns true if it handled it. */
export function openProfileHref(href: string): boolean {
  const target = profileTargetFromHref(href);
  if (!target) return false;
  if (target.kind === "external") useProfile.getState().openExternal(target.authorId);
  else useProfile.getState().openNative(target.username);
  return true;
}

/** True for clicks that should keep the browser's default link behaviour
 *  (new tab / new window / non-primary button). */
export function isModifiedClick(e: MouseEvent): boolean {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
}

type ProfileLinkProps = Omit<ComponentProps<typeof Link>, "href"> & {
  href: string;
};

export function ProfileLink({ href, onClick, ...rest }: ProfileLinkProps) {
  return (
    <Link
      href={href}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || isModifiedClick(e)) return;
        if (openProfileHref(href)) e.preventDefault();
      }}
      {...rest}
    />
  );
}

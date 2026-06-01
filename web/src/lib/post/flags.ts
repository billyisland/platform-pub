"use client";

import { useSyncExternalStore } from "react";

// =============================================================================
// PostCard dev flag — UNIVERSAL-POST-ADR Phase 2.
//
// A runtime-switchable localStorage flag (NOT an env var — those need a rebuild
// and can't be flipped per-tab during review). Gates whether the workspace feed
// renders the new PostCard or the legacy VesselCard. Deliberately kept OUT of the
// per-user workspace layout store: this is a global dev toggle, not layout state.
//
// Toggle from the console:  localStorage.setItem('allhaus.devflags.postcard','1')
// or via the /dev/postcard harness button.
// =============================================================================

const KEY = "allhaus.devflags.postcard";
const EVENT = "allhaus:postcard-flag-change";

export function readPostCardFlag(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setPostCardFlag(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, on ? "1" : "0");
    // Notify same-tab subscribers (the native 'storage' event only fires cross-tab).
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* ignore */
  }
}

function subscribe(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", cb);
  window.addEventListener(EVENT, cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener(EVENT, cb);
  };
}

export function usePostCardFlag(): boolean {
  return useSyncExternalStore(subscribe, readPostCardFlag, () => false);
}

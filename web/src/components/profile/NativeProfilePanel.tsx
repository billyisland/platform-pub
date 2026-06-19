"use client";

// =============================================================================
// NativeProfilePanel — the native writer profile (/:username) rendered
// client-side for the profile overlay (ProfileOverlay). The /[username] route is
// a server component that fetches the writer and renders the header as HTML; the
// overlay can't use that, so this fetches the same WriterProfile client-side and
// renders the equivalent header + the WriterActivity island. Separation is
// whitespace, not a rule, per the sitewide no-thin-line rule.
// =============================================================================

import { useEffect, useState } from "react";
import { Avatar } from "../ui/Avatar";
import { WriterActivity } from "./WriterActivity";
import { getWriter, type WriterProfile } from "../../lib/api/writers";
import { ApiError } from "../../lib/api/client";

export function NativeProfilePanel({ username }: { username: string }) {
  const [writer, setWriter] = useState<WriterProfile | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setWriter(null);
    setNotFound(false);
    setError(false);
    getWriter(username)
      .then((w) => {
        if (!cancelled) setWriter(w);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) setNotFound(true);
        else setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [username]);

  if (notFound) {
    return (
      <div className="py-16 text-center">
        <p className="font-sans text-ui-sm text-grey-600">
          @{username} isn&apos;t here.
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-16 text-center">
        <p className="font-sans text-ui-sm text-grey-600">
          Couldn&apos;t load this profile.
        </p>
      </div>
    );
  }

  if (!writer) {
    return (
      <div className="py-12 space-y-4 animate-pulse">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-full bg-grey-100" />
          <div className="flex-1 space-y-2">
            <div className="h-7 bg-grey-100 rounded w-1/2" />
            <div className="h-4 bg-grey-100 rounded w-1/4" />
          </div>
        </div>
        <div className="h-4 bg-grey-100 rounded w-3/4" />
      </div>
    );
  }

  return (
    <div>
      {/* Static profile header — mirrors app/[username]/page.tsx */}
      <div className="mb-12">
        <div className="flex items-center gap-4 mb-4">
          <Avatar
            src={writer.avatar}
            name={writer.displayName ?? username}
            size={56}
            lazy={false}
            enlargeable
          />
          <div className="flex-1">
            <h1
              className="font-serif text-3xl sm:text-4xl font-light text-black"
              style={{ letterSpacing: "-0.02em" }}
            >
              {writer.displayName ?? username}
            </h1>
            <p className="text-ui-xs text-grey-600 mt-0.5">@{username}</p>
          </div>
        </div>

        {writer.bio && (
          <p
            className="font-serif text-sm text-grey-600 leading-relaxed max-w-lg"
            style={{ lineHeight: "1.7" }}
          >
            {writer.bio}
          </p>
        )}
        <p className="mt-4 text-ui-xs text-grey-600">
          {writer.articleCount} article{writer.articleCount !== 1 ? "s" : ""}
          {" · "}
          {writer.followerCount} follower{writer.followerCount !== 1 ? "s" : ""}
          {" · "}
          {writer.followingCount} following
          {" · "}
          <a
            href={`/rss/${username}`}
            className="label-ui text-grey-600 hover:text-black"
          >
            RSS
          </a>
        </p>
      </div>

      <WriterActivity username={username} writer={writer} inOverlay />
    </div>
  );
}

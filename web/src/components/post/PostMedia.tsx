"use client";

import React from "react";
import { extractNoteMedia } from "../../lib/media";
import type { Post, MediaItem } from "../../lib/post/types";
import type { VesselPalette } from "../workspace/tokens";

// =============================================================================
// PostMedia — level-aware media, governed by the §4 matrix media mode.
//
//   "full-width"        (focal)              — hero at natural dimensions + extras
//   "sized"             (feed/parent/reply)  — cropped 16:9 hero + "+N" overflow pill
//   "single-thumbnail"  (quoted)             — one small thumbnail, nothing else
//   "none"              (condensed)          — render nothing
//
// Adapted from VesselCard's MediaBlock. Note media lives inline in the text, so
// for native notes we extract image URLs here (matching VesselCard). Video uses
// a poster + play glyph (autoplay-on-focal is a documented Phase-3 follow-up).
//
// Separation rule: link previews use a background fill + padding, no edge lines.
// =============================================================================

type MediaMode = "full-width" | "sized" | "single-thumbnail" | "none";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function mediaForPost(post: Post): MediaItem[] {
  if (post.body.media && post.body.media.length > 0) return post.body.media;
  // Native notes carry images inline in the text.
  if (post.type === "note" && post.body.text) {
    return extractNoteMedia(post.body.text) as MediaItem[];
  }
  return [];
}

export function PostMedia({
  post,
  mode,
  palette,
  density,
}: {
  post: Post;
  mode: MediaMode;
  palette: VesselPalette;
  density: string;
}) {
  if (mode === "none" || density === "compact") return null;
  const items = mediaForPost(post);
  if (items.length === 0) return null;

  const hero =
    items.find((m) => m.type === "image") ?? items.find((m) => m.type === "video");
  const linkItems = items.filter((m) => m.type === "link" && m.url);

  // Quoted: a single small thumbnail, nothing else.
  if (mode === "single-thumbnail") {
    const thumb = hero?.type === "image" ? hero.url : hero?.thumbnail;
    if (!thumb) return null;
    return (
      <img
        src={thumb}
        alt={hero?.alt ?? ""}
        loading="lazy"
        referrerPolicy="no-referrer"
        style={{
          width: 64,
          height: 64,
          objectFit: "cover",
          display: "block",
          marginTop: 6,
          background: palette.interior,
        }}
      />
    );
  }

  if (!hero && linkItems.length === 0) return null;

  const expanded = mode === "full-width";
  const visualCount = items.filter(
    (m) => m.type === "image" || m.type === "video",
  ).length;
  const overflowCount = hero && !expanded ? visualCount - 1 : 0;
  const playable = hero?.type === "video";

  const heroContainerStyle: React.CSSProperties = {
    position: "relative",
    marginTop: 10,
    marginBottom: 6,
    background: palette.interior,
    overflow: "hidden",
    cursor: playable ? "pointer" : undefined,
    ...(expanded ? {} : { aspectRatio: "16 / 9" }),
  };
  const heroImgStyle: React.CSSProperties = expanded
    ? { width: "100%", height: "auto", maxWidth: "100%", display: "block" }
    : { width: "100%", height: "100%", objectFit: "cover", display: "block" };

  const extraVisuals = expanded
    ? items.filter((m) => (m.type === "image" || m.type === "video") && m !== hero)
    : [];

  return (
    <>
      {hero && (
        <div
          onClick={(e) => {
            if (!playable || !hero.url) return;
            e.stopPropagation();
            window.open(hero.url, "_blank", "noopener,noreferrer");
          }}
          style={heroContainerStyle}
        >
          {hero.type === "image" && (
            <img
              src={hero.url}
              alt={hero.alt ?? ""}
              loading="lazy"
              referrerPolicy="no-referrer"
              style={heroImgStyle}
            />
          )}
          {hero.type === "video" && hero.thumbnail && (
            <img
              src={hero.thumbnail}
              alt={hero.alt ?? ""}
              loading="lazy"
              referrerPolicy="no-referrer"
              style={heroImgStyle}
            />
          )}
          {hero.type === "video" && <PlayGlyph hasPoster={!!hero.thumbnail} />}
          {overflowCount > 0 && (
            <span
              aria-hidden="true"
              className="font-mono"
              style={{
                position: "absolute",
                right: 8,
                bottom: 8,
                padding: "2px 8px",
                background: "rgba(0,0,0,0.72)",
                color: "#FFFFFF",
                fontSize: 11,
                letterSpacing: "0.04em",
              }}
            >
              +{overflowCount}
            </span>
          )}
        </div>
      )}
      {extraVisuals.map((m, i) => {
        const src = m.type === "image" ? m.url : m.thumbnail;
        if (!src) return null;
        return (
          <div
            key={`extra-${i}`}
            style={{
              position: "relative",
              marginBottom: 6,
              background: palette.interior,
              overflow: "hidden",
            }}
          >
            <img
              src={src}
              alt={m.alt ?? ""}
              loading="lazy"
              referrerPolicy="no-referrer"
              style={{ width: "100%", height: "auto", maxWidth: "100%", display: "block" }}
            />
          </div>
        );
      })}
      {linkItems.map((link, i) => (
        <LinkPreview key={i} item={link} palette={palette} />
      ))}
    </>
  );
}

function PlayGlyph({ hasPoster }: { hasPoster: boolean }) {
  return (
    <div
      role="img"
      aria-label="Play video"
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: hasPoster ? "rgba(0,0,0,0.18)" : "rgba(0,0,0,0.06)",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 44,
          height: 44,
          borderRadius: "50%",
          background: "rgba(255,255,255,0.92)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M5 3.5v9l7-4.5z" fill="#1A1A18" />
        </svg>
      </span>
    </div>
  );
}

// Link preview — background fill + padding, no edge line (separation rule).
function LinkPreview({ item, palette }: { item: MediaItem; palette: VesselPalette }) {
  return (
    <a
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="no-underline"
      style={{
        display: "flex",
        gap: 12,
        marginTop: 10,
        marginBottom: 6,
        padding: 10,
        background: palette.interior,
      }}
    >
      {item.thumbnail && (
        <img
          src={item.thumbnail}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          style={{
            width: 64,
            height: 64,
            objectFit: "cover",
            background: palette.cardBg,
            flexShrink: 0,
          }}
        />
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        {item.title && (
          <p className="text-ui-sm font-semibold truncate" style={{ color: palette.cardTitle }}>
            {item.title}
          </p>
        )}
        {item.description && (
          <p
            className="text-ui-xs line-clamp-2"
            style={{ color: palette.cardStandfirst, marginTop: 2 }}
          >
            {item.description}
          </p>
        )}
        <p className="text-mono-xs truncate" style={{ color: palette.cardMeta, marginTop: 2 }}>
          {hostOf(item.url)}
        </p>
      </div>
    </a>
  );
}

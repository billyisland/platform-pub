"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useReader } from "../../stores/reader";
import { externalItems } from "../../lib/api/external-items";

interface ExtractResult {
  title: string;
  content: string;
  siteName: string;
  excerpt: string;
  byline: string;
  length: number;
}

export function ReaderPane() {
  const {
    isOpen,
    url,
    title: initialTitle,
    siteName: initialSiteName,
    close,
  } = useReader();
  const [article, setArticle] = useState<ExtractResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!isOpen || !url) {
      setArticle(null);
      setError(false);
      return;
    }

    setLoading(true);
    setError(false);
    externalItems
      .extract(url)
      .then((result) => {
        setArticle(result);
      })
      .catch(() => {
        setError(true);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [isOpen, url]);

  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    },
    [close],
  );

  useEffect(() => {
    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
      return () => document.removeEventListener("keydown", handleEscape);
    }
  }, [isOpen, handleEscape]);

  if (!isOpen || !url) return null;

  const displayTitle = article?.title || initialTitle || "";
  const displaySite = article?.siteName || initialSiteName || "";

  return (
    <>
      {/* Scrim */}
      <div
        className="fixed inset-0 z-40 bg-black/40"
        onClick={close}
        style={{ top: 60 }}
      />

      {/* Pane */}
      <div
        className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto"
        style={{ top: 60 }}
      >
        <div
          className="relative w-full bg-white my-8 mx-4 shadow-lg"
          style={{
            maxWidth: 640,
            borderTop: "6px solid #111111",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-start justify-between px-8 pt-6 pb-4 border-b border-grey-200">
            <div className="min-w-0">
              {displaySite && (
                <p className="label-ui text-grey-400 mb-1">{displaySite}</p>
              )}
              {displayTitle && (
                <h2 className="font-serif text-xl leading-snug text-black">
                  {displayTitle}
                </h2>
              )}
              {article?.byline && (
                <p className="text-ui-xs text-grey-500 mt-1">
                  {article.byline}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={close}
              className="flex-shrink-0 ml-4 text-grey-400 hover:text-black text-lg leading-none"
              style={{ background: "none", border: "none", cursor: "pointer" }}
            >
              ✕
            </button>
          </div>

          {/* Body */}
          <div className="px-8 py-6">
            {loading && (
              <div className="space-y-3 animate-pulse">
                <div className="h-4 bg-grey-100 rounded w-full" />
                <div className="h-4 bg-grey-100 rounded w-5/6" />
                <div className="h-4 bg-grey-100 rounded w-4/5" />
                <div className="h-4 bg-grey-100 rounded w-full" />
                <div className="h-4 bg-grey-100 rounded w-3/4" />
              </div>
            )}

            {error && (
              <div className="text-center py-8">
                <p className="text-ui-xs text-grey-500 mb-4">
                  Could not extract this page.
                </p>
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-text"
                >
                  OPEN IN NEW TAB →
                </a>
              </div>
            )}

            {article && !loading && (
              <div
                className="font-serif text-[16px] leading-[1.7] text-black [&_p]:mb-4 [&_p:last-child]:mb-0 [&_h1]:text-xl [&_h1]:font-bold [&_h1]:mb-3 [&_h1]:mt-6 [&_h2]:text-lg [&_h2]:font-bold [&_h2]:mb-3 [&_h2]:mt-5 [&_h3]:text-base [&_h3]:font-bold [&_h3]:mb-2 [&_h3]:mt-4 [&_blockquote]:border-l-2 [&_blockquote]:border-grey-300 [&_blockquote]:pl-4 [&_blockquote]:text-grey-600 [&_blockquote]:my-4 [&_a]:text-black [&_a]:underline [&_img]:max-w-full [&_img]:h-auto [&_img]:my-4 [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:mb-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:mb-4 [&_li]:mb-1 [&_pre]:bg-grey-50 [&_pre]:p-4 [&_pre]:overflow-x-auto [&_pre]:text-sm [&_pre]:my-4 [&_code]:font-mono [&_code]:text-sm"
                dangerouslySetInnerHTML={{ __html: article.content }}
              />
            )}
          </div>

          {/* Footer */}
          {article && !loading && (
            <div className="px-8 py-4 border-t border-grey-200">
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-text"
              >
                OPEN IN NEW TAB →
              </a>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

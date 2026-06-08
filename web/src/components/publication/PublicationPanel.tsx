"use client";

// =============================================================================
// PublicationPanel — the publication homepage rendered inside the surface
// overlay (useSurfaceOverlay). A client-fetched masthead + recent-articles list;
// article rows open the reader overlay in place (useReader) rather than
// navigating to /pub/:slug/:article and escaping the workspace. The full-page
// /pub/[slug] route still renders its own server-side homepage on direct visits.
// =============================================================================

import { useCallback, useEffect, useState } from "react";
import { publications as pubApi } from "../../lib/api";
import { useReader } from "../../stores/reader";
import { formatDateFromISO } from "../../lib/format";
import { PubFollowButton } from "./PubFollowButton";

interface PubPublic {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  isFollowing: boolean;
}

export function PublicationPanel({ slug }: { slug: string }) {
  const [pub, setPub] = useState<PubPublic | null>(null);
  const [articles, setArticles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const openArticle = useReader((s) => s.openNative);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    Promise.all([
      pubApi.getPublic(slug),
      pubApi.getPublicArticles(slug, { limit: 20 }),
    ])
      .then(([p, a]) => {
        if (cancelled) return;
        setPub(p as PubPublic);
        setArticles(a.articles ?? []);
      })
      .catch(() => {
        if (!cancelled) setNotFound(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const handleOpen = useCallback(
    (dTag: string) => () => {
      if (dTag) openArticle(dTag);
    },
    [openArticle],
  );

  if (loading) {
    return (
      <div className="mx-auto max-w-feed px-4 sm:px-6 py-12">
        <div className="label-ui text-grey-600 py-12 text-center">LOADING…</div>
      </div>
    );
  }

  if (notFound || !pub) {
    return (
      <div className="mx-auto max-w-feed px-4 sm:px-6 py-12">
        <h1 className="font-sans text-2xl font-medium text-black">
          Publication not found
        </h1>
        <p className="font-sans text-ui-sm text-grey-600 mt-2">
          This publication isn&apos;t available.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-feed px-4 sm:px-6 py-12">
      {/* Masthead */}
      <div className="text-center mb-10">
        <h1 className="font-serif text-2xl font-light tracking-tight text-black">
          {pub.name}
        </h1>
        {pub.tagline && (
          <p className="font-sans text-ui-sm text-grey-600 mt-2">
            {pub.tagline}
          </p>
        )}
        <div className="mt-4 flex items-center justify-center gap-4">
          <PubFollowButton
            publicationId={pub.id}
            initialFollowing={pub.isFollowing ?? false}
          />
          <a
            href={`/api/v1/pub/${pub.slug}/rss`}
            className="label-ui text-grey-600 hover:text-black"
          >
            RSS
          </a>
        </div>
      </div>

      {articles.length === 0 ? (
        <div className="label-ui text-grey-600 py-12 text-center">
          NO ARTICLES YET
        </div>
      ) : (
        <div className="space-y-0">
          {articles.map((a: any) => {
            const isPaid = a.access_mode === "paywalled";
            const barColor = isPaid ? "#B5242A" : "#111111";
            return (
              <button
                key={a.nostr_event_id ?? a.nostr_d_tag}
                type="button"
                onClick={handleOpen(a.nostr_d_tag)}
                className="group block w-full text-left mt-9"
                style={{
                  borderLeft: `6px solid ${barColor}`,
                  paddingLeft: "28px",
                }}
              >
                <div className="flex items-center gap-2 mb-3">
                  <span className="label-ui text-grey-600">
                    {a.author_display_name ?? a.author_username}
                  </span>
                  {a.published_at && (
                    <>
                      <span className="font-mono text-mono-xs text-grey-600">
                        &middot;
                      </span>
                      <span className="font-mono text-mono-xs tracking-[0.02em] text-grey-600">
                        {formatDateFromISO(a.published_at)}
                      </span>
                    </>
                  )}
                </div>
                <h2 className="font-serif text-[28px] font-medium italic text-black leading-[1.18] tracking-[-0.02em] mb-2 group-hover:text-crimson-dark transition-colors">
                  {a.title}
                </h2>
                {a.summary && (
                  <p
                    className="font-serif text-[15.5px] text-grey-600 leading-[1.65]"
                    style={{ maxWidth: "540px" }}
                  >
                    {a.summary}
                  </p>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

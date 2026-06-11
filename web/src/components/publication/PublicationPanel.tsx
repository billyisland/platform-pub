"use client";

// =============================================================================
// PublicationPanel — the publication surface rendered inside the surface overlay
// (useSurfaceOverlay). One body for all four publication views (home · about ·
// masthead · archive), switched by the `view` prop; an in-overlay nav swaps
// between them by re-opening the store on the matching view (which replaceStates
// the real /pub/<slug>[/<view>] URL, so Back still closes the whole overlay and
// direct visits resolve the same surfaces full-page). Article rows open the
// reader overlay (useReader) in place rather than navigating to
// /pub/:slug/:article and escaping the workspace. The full-page /pub/[slug]/**
// routes still render their own server-side surfaces on direct visits.
// =============================================================================

import { useCallback, useEffect, useState } from "react";
import { publications as pubApi } from "../../lib/api";
import { useReader } from "../../stores/reader";
import { useSurfaceOverlay, type PubView } from "../../stores/surfaceOverlay";
import { formatDateFromISO } from "../../lib/format";
import { renderMarkdown } from "../../lib/markdown";
import { ProfileLink } from "../ui/ProfileLink";
import { PubFollowButton } from "./PubFollowButton";

interface PubPublic {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  about: string | null;
  isFollowing: boolean;
}

const NAV: { view: PubView; label: string }[] = [
  { view: "home", label: "Home" },
  { view: "about", label: "About" },
  { view: "masthead", label: "Masthead" },
  { view: "archive", label: "Archive" },
];

export function PublicationPanel({
  slug,
  view = "home",
}: {
  slug: string;
  view?: PubView;
}) {
  const [pub, setPub] = useState<PubPublic | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const openArticle = useReader((s) => s.openNative);
  const openPublication = useSurfaceOverlay((s) => s.openPublication);

  // The masthead header (name/tagline/follow/RSS) is shared by every view, so
  // we always load the publication record; per-view bodies load their own data.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    pubApi
      .getPublic(slug)
      .then((p) => {
        if (!cancelled) setPub(p as PubPublic);
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
      {/* Masthead — shared across views */}
      <div className="text-center mb-8">
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

      {/* In-overlay sub-nav — swaps views in place, no full-page escape */}
      <nav className="flex items-center justify-center gap-5 mb-10">
        {NAV.map((n) => (
          <button
            key={n.view}
            type="button"
            onClick={() => openPublication(pub.slug, n.view)}
            aria-current={view === n.view ? "page" : undefined}
            className={`label-ui transition-colors ${
              view === n.view
                ? "text-black"
                : "text-grey-600 hover:text-black"
            }`}
          >
            {n.label}
          </button>
        ))}
      </nav>

      {view === "home" && (
        <ArticleList slug={pub.slug} limit={20} onOpen={handleOpen} variant="rich" />
      )}
      {view === "archive" && (
        <ArticleList slug={pub.slug} limit={100} onOpen={handleOpen} variant="list" />
      )}
      {view === "masthead" && <MastheadView slug={pub.slug} />}
      {view === "about" && <AboutView name={pub.name} about={pub.about} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Article list — shared by home (rich serif cards) and archive (dense list).
// Both open the reader overlay; neither links out to /pub/:slug/:article.
// ---------------------------------------------------------------------------
function ArticleList({
  slug,
  limit,
  variant,
  onOpen,
}: {
  slug: string;
  limit: number;
  variant: "rich" | "list";
  onOpen: (dTag: string) => () => void;
}) {
  const [articles, setArticles] = useState<any[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setArticles(null);
    pubApi
      .getPublicArticles(slug, { limit })
      .then((a) => {
        if (!cancelled) setArticles(a.articles ?? []);
      })
      .catch(() => {
        if (!cancelled) setArticles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, limit]);

  if (articles === null) {
    return (
      <div className="label-ui text-grey-600 py-12 text-center">LOADING…</div>
    );
  }

  if (articles.length === 0) {
    return (
      <div className="label-ui text-grey-600 py-12 text-center">
        NO ARTICLES YET
      </div>
    );
  }

  if (variant === "list") {
    return (
      <div className="space-y-7">
        {articles.map((a: any) => (
          <button
            key={a.nostr_event_id ?? a.nostr_d_tag}
            type="button"
            onClick={onOpen(a.nostr_d_tag)}
            className="group block w-full text-left"
          >
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="font-serif text-base text-black group-hover:text-crimson-dark transition-colors">
                {a.title}
              </h2>
              {a.published_at && (
                <span className="font-mono text-mono-xs text-grey-600 shrink-0">
                  {formatDateFromISO(a.published_at)}
                </span>
              )}
            </div>
            <p className="label-ui text-grey-600 mt-1">
              {a.author_display_name ?? a.author_username}
            </p>
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-0">
      {articles.map((a: any) => {
        const isPaid = a.access_mode === "paywalled";
        const barColor = isPaid ? "var(--ah-crimson)" : "var(--ah-ink)";
        return (
          <button
            key={a.nostr_event_id ?? a.nostr_d_tag}
            type="button"
            onClick={onOpen(a.nostr_d_tag)}
            className="group block w-full text-left mt-9 first:mt-0"
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
  );
}

// ---------------------------------------------------------------------------
// Masthead — the team behind the publication. Names open the profile overlay
// (ProfileLink), which supersedes this surface per the one-Glasshouse rule.
// ---------------------------------------------------------------------------
function MastheadView({ slug }: { slug: string }) {
  const [members, setMembers] = useState<any[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMembers(null);
    pubApi
      .getMasthead(slug)
      .then((d) => {
        if (!cancelled) setMembers(d.members ?? []);
      })
      .catch(() => {
        if (!cancelled) setMembers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (members === null) {
    return (
      <div className="label-ui text-grey-600 py-12 text-center">LOADING…</div>
    );
  }

  if (members.length === 0) {
    return (
      <div className="label-ui text-grey-600 py-12 text-center">
        NO MASTHEAD YET
      </div>
    );
  }

  return (
    <div className="max-w-article mx-auto space-y-6">
      {members.map((m: any) => (
        <div key={m.account_id} className="flex items-start gap-4">
          {m.avatar_blossom_url ? (
            <img
              src={m.avatar_blossom_url}
              alt=""
              className="w-12 h-12 rounded-full object-cover shrink-0"
            />
          ) : (
            <div className="w-12 h-12 rounded-full bg-grey-200 shrink-0" />
          )}
          <div>
            <ProfileLink
              href={`/@${m.username}`}
              className="font-sans font-medium text-black hover:opacity-70"
            >
              {m.display_name || m.username}
            </ProfileLink>
            <p className="label-ui text-grey-600 mt-0.5">
              {m.title || m.role}
              {m.contributor_type !== "staff" && ` · ${m.contributor_type}`}
            </p>
            {m.bio && (
              <p className="font-sans text-ui-sm text-grey-600 mt-1">{m.bio}</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// About — the publication's about markdown, rendered client-side via the same
// sanitised pipeline the full-page route uses server-side.
// ---------------------------------------------------------------------------
function AboutView({ name, about }: { name: string; about: string | null }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!about) {
      setHtml("");
      return;
    }
    setHtml(null);
    renderMarkdown(about)
      .then((h) => {
        if (!cancelled) setHtml(h);
      })
      .catch(() => {
        if (!cancelled) setHtml("");
      });
    return () => {
      cancelled = true;
    };
  }, [about]);

  return (
    <div className="max-w-article mx-auto">
      <h2 className="font-sans text-xl font-medium text-black mb-6">
        About {name}
      </h2>
      {html === null ? (
        <div className="label-ui text-grey-600 py-8 text-center">LOADING…</div>
      ) : html ? (
        <div
          className="prose prose-sm"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <p className="font-sans text-ui-sm text-grey-600">No about page yet.</p>
      )}
    </div>
  );
}

// =============================================================================
// Curated publication catalog — discovery fallback branch 3
// (UNIVERSAL-FEED-ADR §V.5.8)
//
// A tiny seed table mapping common publication names → canonical RSS feed URL.
// It covers the head of the distribution cheaply: instant, zero network I/O,
// very high precision, low recall *by design* — one precise branch among
// several, not the whole answer. A user who types "Guardian" expecting The
// Guardian's feed gets a pickable candidate without any external search.
//
// A catalog hit is a *nomination*, not a subscription: selecting one re-enters
// the exact resolver via its feedUrl (§V.5.2 step 3), which fetches and
// validates the feed before minting the external_source. So a slightly-stale
// URL is non-fatal — it simply won't resolve when picked.
// =============================================================================

export interface CatalogEntry {
  title: string;
  feedUrl: string;
  description?: string;
  // Lowercase names the user might type. Matched by substring in both
  // directions (alias ⊆ query or query ⊆ alias), so partials and supersets
  // both hit ("guard" → Guardian; "guardian newspaper" → Guardian).
  aliases: string[];
}

// Deliberately small and well-known. Feed URLs are the publishers' canonical
// public feeds. Keep entries stable and uncontroversial; this is the head of
// the distribution, not an exhaustive directory.
export const PUBLICATION_CATALOG: CatalogEntry[] = [
  {
    title: "The Guardian",
    feedUrl: "https://www.theguardian.com/international/rss",
    description: "Latest news, sport and comment from the Guardian",
    aliases: ["guardian", "the guardian"],
  },
  {
    title: "BBC News",
    feedUrl: "https://feeds.bbci.co.uk/news/rss.xml",
    description: "BBC News — top stories",
    aliases: ["bbc", "bbc news"],
  },
  {
    title: "The New York Times",
    feedUrl: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml",
    description: "Top stories from The New York Times",
    aliases: ["nyt", "new york times", "the new york times", "nytimes"],
  },
  {
    title: "NPR News",
    feedUrl: "https://feeds.npr.org/1001/rss.xml",
    description: "News from NPR",
    aliases: ["npr", "npr news", "national public radio"],
  },
  {
    title: "Al Jazeera",
    feedUrl: "https://www.aljazeera.com/xml/rss/all.xml",
    description: "Al Jazeera English — all news",
    aliases: ["al jazeera", "aljazeera"],
  },
  {
    title: "The Atlantic",
    feedUrl: "https://www.theatlantic.com/feed/all/",
    description: "The Atlantic — all articles",
    aliases: ["atlantic", "the atlantic"],
  },
  {
    title: "The Verge",
    feedUrl: "https://www.theverge.com/rss/index.xml",
    description: "The Verge — technology, science, art, and culture",
    aliases: ["verge", "the verge"],
  },
  {
    title: "Ars Technica",
    feedUrl: "https://feeds.arstechnica.com/arstechnica/index",
    description: "Ars Technica — technology news and analysis",
    aliases: ["ars technica", "arstechnica", "ars"],
  },
  {
    title: "Wired",
    feedUrl: "https://www.wired.com/feed/rss",
    description: "Wired — the latest in technology, science and culture",
    aliases: ["wired"],
  },
  {
    title: "TechCrunch",
    feedUrl: "https://techcrunch.com/feed/",
    description: "TechCrunch — startup and technology news",
    aliases: ["techcrunch", "tech crunch"],
  },
  {
    title: "Hacker News",
    feedUrl: "https://hnrss.org/frontpage",
    description: "Hacker News front page",
    aliases: ["hacker news", "hackernews", "hn", "ycombinator"],
  },
];

export interface CatalogMatch {
  title: string;
  feedUrl: string;
  description?: string;
}

// Match the query against the catalog by case-insensitive substring in both
// directions. Capped at `limit`. Requires ≥2 chars so a single keystroke can't
// match the broad short aliases ("hn", "ars").
export function searchCatalog(query: string, limit = 5): CatalogMatch[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  const out: CatalogMatch[] = [];
  for (const entry of PUBLICATION_CATALOG) {
    const hit = entry.aliases.some((a) => a.includes(q) || q.includes(a));
    if (!hit) continue;
    out.push({
      title: entry.title,
      feedUrl: entry.feedUrl,
      description: entry.description,
    });
    if (out.length >= limit) break;
  }
  return out;
}

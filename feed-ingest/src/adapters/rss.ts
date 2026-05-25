import Parser from "rss-parser";
import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
import { sanitizeContent, stripHtml } from "../lib/sanitize.js";
import logger from "@platform-pub/shared/lib/logger.js";

// =============================================================================
// RSS / Atom ingestion adapter
//
// Fetches an RSS or Atom feed, parses items, and returns normalised rows
// ready for INSERT INTO external_items.
// =============================================================================

type RssItemExtras = {
  mediaContent: unknown;
  mediaThumbnail: unknown;
  "content:encoded"?: string;
  author?: string;
};

const parser = new Parser<unknown, RssItemExtras>({
  timeout: 10_000,
  maxRedirects: 3,
  customFields: {
    item: [
      ["media:content", "mediaContent", { keepArray: true }],
      ["media:thumbnail", "mediaThumbnail"],
      "content:encoded",
      "author",
    ],
  },
});

interface RssFetchOptions {
  feedUrl: string;
  etag?: string | null;
  lastModified?: string | null;
}

interface RssFetchResult {
  items: NormalisedItem[];
  etag?: string;
  lastModified?: string;
  feedTitle?: string;
  feedDescription?: string;
  notModified: boolean;
}

interface NormalisedItem {
  sourceItemUri: string;
  authorName: string | null;
  authorHandle: string | null;
  authorUri: string | null;
  contentText: string | null;
  contentHtml: string | null;
  summary: string | null;
  title: string | null;
  language: string | null;
  media: MediaAttachment[];
  publishedAt: Date;
}

interface MediaAttachment {
  type: "image" | "video" | "audio" | "link";
  url: string;
  thumbnail?: string;
  alt?: string;
  width?: number;
  height?: number;
  mime_type?: string;
  title?: string;
  description?: string;
}

export async function fetchRssFeed(
  options: RssFetchOptions,
): Promise<RssFetchResult> {
  const headers: Record<string, string> = {
    Accept:
      "application/feed+json, application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.1",
  };
  if (options.etag) headers["If-None-Match"] = options.etag;
  if (options.lastModified) headers["If-Modified-Since"] = options.lastModified;

  const response = await safeFetch(options.feedUrl, { headers });

  if (response.status === 304) {
    return { items: [], notModified: true };
  }

  if (!response.ok) {
    throw new Error(`Feed returned HTTP ${response.status}`);
  }

  // JSON Feed detection: content-type or shape-sniff
  const ct = response.headers.get("content-type") ?? "";
  if (ct.includes("application/feed+json") || ct.includes("application/json")) {
    try {
      return parseJsonFeed(response.text, response);
    } catch {
      // Fall through to rss-parser — might be JSON-shaped but not a JSON Feed
    }
  } else if (!ct || ct.includes("text/plain")) {
    // Some feeds serve as text/plain — try JSON parse as fallback
    try {
      const probe = JSON.parse(response.text);
      if (
        typeof probe === "object" &&
        probe !== null &&
        typeof probe.version === "string" &&
        probe.version.startsWith("https://jsonfeed.org/version/")
      ) {
        return parseJsonFeed(response.text, response);
      }
    } catch {
      // Not JSON — fall through to rss-parser
    }
  }

  const feed = await parser.parseString(response.text);

  const items: NormalisedItem[] = [];
  for (const entry of feed.items ?? []) {
    const guid = entry.guid ?? entry.link;
    if (!guid) continue;

    const rawHtml =
      entry["content:encoded"] ?? entry.content ?? entry.summary ?? "";
    const contentHtml = rawHtml ? sanitizeContent(rawHtml) : null;
    const contentText = rawHtml ? stripHtml(rawHtml) : null;
    const summaryText = entry.summary ? stripHtml(entry.summary) : null;

    const media = extractMedia(entry);

    let publishedAt: Date;
    try {
      publishedAt = entry.pubDate
        ? new Date(entry.pubDate)
        : entry.isoDate
          ? new Date(entry.isoDate)
          : new Date();
    } catch {
      publishedAt = new Date();
    }
    // Reject dates in the far future (likely parsing errors)
    if (publishedAt.getTime() > Date.now() + 86_400_000) {
      publishedAt = new Date();
    }

    items.push({
      sourceItemUri: guid,
      authorName: entry.creator ?? entry.author ?? null,
      authorHandle: null,
      authorUri: null,
      contentText,
      contentHtml,
      summary: summaryText,
      title: entry.title ?? null,
      language: null,
      media,
      publishedAt,
    });
  }

  return {
    items,
    etag: response.headers.get("etag") ?? undefined,
    lastModified: response.headers.get("last-modified") ?? undefined,
    feedTitle: feed.title ?? undefined,
    feedDescription: feed.description ?? undefined,
    notModified: false,
  };
}

function extractMedia(entry: any): MediaAttachment[] {
  const media: MediaAttachment[] = [];

  // <enclosure> elements
  if (entry.enclosure) {
    const enc = entry.enclosure;
    if (enc.url && /^https?:\/\//i.test(enc.url)) {
      media.push({
        type: inferMediaType(enc.type ?? ""),
        url: enc.url,
        mime_type: enc.type ?? undefined,
      });
    }
  }

  // <media:content> elements
  if (Array.isArray(entry.mediaContent)) {
    for (const mc of entry.mediaContent) {
      const attrs = mc.$ ?? mc;
      if (attrs.url && /^https?:\/\//i.test(attrs.url)) {
        media.push({
          type: inferMediaType(attrs.medium ?? attrs.type ?? ""),
          url: attrs.url,
          width: attrs.width ? parseInt(attrs.width, 10) : undefined,
          height: attrs.height ? parseInt(attrs.height, 10) : undefined,
          mime_type: attrs.type ?? undefined,
        });
      }
    }
  }

  // <media:thumbnail>
  if (entry.mediaThumbnail) {
    const thumb = entry.mediaThumbnail.$ ?? entry.mediaThumbnail;
    if (thumb.url && /^https?:\/\//i.test(thumb.url) && media.length > 0) {
      media[0].thumbnail = thumb.url;
    } else if (thumb.url && /^https?:\/\//i.test(thumb.url)) {
      media.push({ type: "image", url: thumb.url });
    }
  }

  return media;
}

function inferMediaType(hint: string): "image" | "video" | "audio" | "link" {
  const h = hint.toLowerCase();
  if (h.includes("image") || h === "image") return "image";
  if (h.includes("video") || h === "video") return "video";
  if (h.includes("audio") || h === "audio") return "audio";
  return "link";
}

// =============================================================================
// JSON Feed (https://jsonfeed.org/version/1.1) parser
// =============================================================================

interface JsonFeedItem {
  id?: string;
  url?: string;
  title?: string;
  content_html?: string;
  content_text?: string;
  summary?: string;
  date_published?: string;
  date_modified?: string;
  authors?: Array<{ name?: string; url?: string }>;
  author?: { name?: string; url?: string };
  language?: string;
  image?: string;
  banner_image?: string;
  attachments?: Array<{
    url?: string;
    mime_type?: string;
    title?: string;
    size_in_bytes?: number;
    duration_in_seconds?: number;
  }>;
}

interface JsonFeed {
  version: string;
  title?: string;
  description?: string;
  language?: string;
  items?: JsonFeedItem[];
}

function parseJsonFeed(
  text: string,
  response: { headers: Headers },
): RssFetchResult {
  const feed: JsonFeed = JSON.parse(text);

  if (
    typeof feed.version !== "string" ||
    !feed.version.startsWith("https://jsonfeed.org/version/")
  ) {
    throw new Error("Not a JSON Feed");
  }

  const items: NormalisedItem[] = [];
  for (const entry of feed.items ?? []) {
    const id = entry.id ?? entry.url;
    if (!id) continue;

    const rawHtml = entry.content_html ?? "";
    const rawText = entry.content_text ?? "";
    const contentHtml = rawHtml ? sanitizeContent(rawHtml) : null;
    const contentText = rawText || (rawHtml ? stripHtml(rawHtml) : null);
    const summaryText = entry.summary ? stripHtml(entry.summary) : null;

    // JSON Feed 1.1 uses authors[]; 1.0 uses author
    const authorObj = entry.authors?.[0] ?? entry.author;

    const media: MediaAttachment[] = [];

    if (entry.image && /^https?:\/\//i.test(entry.image)) {
      media.push({ type: "image", url: entry.image });
    }
    if (entry.banner_image && /^https?:\/\//i.test(entry.banner_image)) {
      media.push({ type: "image", url: entry.banner_image });
    }

    for (const att of entry.attachments ?? []) {
      if (!att.url || !/^https?:\/\//i.test(att.url)) continue;
      media.push({
        type: inferMediaType(att.mime_type ?? ""),
        url: att.url,
        mime_type: att.mime_type ?? undefined,
        title: att.title ?? undefined,
      });
    }

    let publishedAt: Date;
    try {
      publishedAt = entry.date_published
        ? new Date(entry.date_published)
        : new Date();
    } catch {
      publishedAt = new Date();
    }
    if (publishedAt.getTime() > Date.now() + 86_400_000) {
      publishedAt = new Date();
    }

    items.push({
      sourceItemUri: id,
      authorName: authorObj?.name ?? null,
      authorHandle: null,
      authorUri: authorObj?.url ?? null,
      contentText,
      contentHtml,
      summary: summaryText,
      title: entry.title ?? null,
      language: entry.language ?? feed.language ?? null,
      media,
      publishedAt,
    });
  }

  return {
    items,
    etag: response.headers.get("etag") ?? undefined,
    lastModified: response.headers.get("last-modified") ?? undefined,
    feedTitle: feed.title ?? undefined,
    feedDescription: feed.description ?? undefined,
    notModified: false,
  };
}

/**
 * Generate the discovery-catalog tail (RESOLVER-DISCOVERY-ADR §7.1).
 *
 * Pulls publication candidates from Wikidata (CC0 — entities holding P1019
 * "web feed URL", restricted to news/media/blog/podcast classes, ranked by
 * sitelink count as a prominence proxy) and, optionally, from local OPML
 * files the operator has licence-vetted (--opml, repeatable). Every candidate
 * feed is probed live at generation time — fetch + real rss-parser confirm,
 * the same bar as the runtime resolveUrl cascade (resolver.ts tryRssFetch) —
 * so dead feeds never enter the catalog. Probing goes through the hardened
 * safeFetch (SSRF invariant; an OPML line pointing at a private address is
 * rejected, not fetched).
 *
 * Output: gateway/src/lib/discovery-catalog.generated.ts — marked generated,
 * never hand-edited, committed like schema.sql. The runtime merges it under
 * the hand-curated head at load (discovery-catalog.ts mergeCatalogs): head
 * entries keep priority, and a generated entry whose feed host collides with
 * a head entry is dropped there. Within the generated set this script dedupes
 * by feed host (best-ranked candidate per host wins) EXCEPT for multi-tenant
 * feed hosting platforms (megaphone/simplecast/libsyn/…), where the host is
 * shared by unrelated publications and dedup is by full feed URL instead.
 *
 * Alias hygiene (§7.1): lowercase, diacritic-folded (NFKD, marks stripped),
 * ≥3 chars, deduped, capped per entry — matching searchCatalog's folded
 * substring-both-directions matching.
 *
 * Usage (from the repo root; network access required):
 *   npx tsx scripts/gen-discovery-catalog.ts                  # default: 500 entries
 *   npx tsx scripts/gen-discovery-catalog.ts --target 400
 *   npx tsx scripts/gen-discovery-catalog.ts --opml vetted-feeds.opml
 *
 * Re-run occasionally (feeds rot); commit the resulting diff. The runtime is
 * unaffected by staleness in between — a dead catalog URL is non-fatal by
 * design (nomination re-enters the exact resolver, which validates on pick).
 */

import { writeFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Parser from "rss-parser";
import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
import {
  MULTI_TENANT_FEED_HOSTS,
  PUBLICATION_CATALOG,
  foldDiacritics,
  feedHost,
  type CatalogEntry,
} from "../gateway/src/lib/discovery-catalog.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = path.join(
  REPO_ROOT,
  "gateway/src/lib/discovery-catalog.generated.ts",
);

const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";
const USER_AGENT =
  "allhaus-catalog-gen/1.0 (https://all.haus; discovery catalog generation)";

// News/media/blog/podcast classes (P31/P279*), each queried separately so no
// single query approaches the WDQS 60s ceiling. Q1002697 (periodical) covers
// newspapers and magazines via the subclass tree.
const WIKIDATA_CLASSES = [
  { qid: "Q1002697", name: "periodical", limit: 900 },
  { qid: "Q17232649", name: "news website", limit: 400 },
  { qid: "Q30849", name: "blog", limit: 250 },
  { qid: "Q192283", name: "news agency", limit: 50 },
  { qid: "Q24634210", name: "podcast", limit: 900 },
];

// Alias languages worth folding into the searchable set. English plus the
// major Latin-script languages whose folded forms are typeable on an ASCII
// keyboard; non-Latin aliases would never match the folded substring search.
const ALIAS_LANGS = ["en", "de", "fr", "es", "it", "pt", "nl", "sv", "da"];

// Multi-tenant feed-host exemption (dedupe by full URL, not host) now lives
// in discovery-catalog.ts — shared with mergeCatalogs' load-time head check.

const MAX_ALIASES_PER_ENTRY = 8;
const PROBE_TIMEOUT_MS = 8000;
const PROBE_MAX_BYTES = 4 * 1024 * 1024;

interface Candidate {
  title: string;
  description?: string;
  aliases: string[];
  feeds: string[]; // candidate URLs, probed in order until one is live
  sitelinks: number; // prominence proxy; OPML entries carry 0
  origin: string; // provenance for the summary line
}

// ---------------------------------------------------------------------------
// Wikidata
// ---------------------------------------------------------------------------

interface SparqlBinding {
  [key: string]: { value: string } | undefined;
}

async function sparql(query: string): Promise<SparqlBinding[]> {
  const url = `${WIKIDATA_SPARQL}?query=${encodeURIComponent(query)}&format=json`;
  const res = await safeFetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/sparql-results+json" },
    timeout: 65_000,
    maxBytes: 32 * 1024 * 1024,
  });
  if (!res.ok) throw new Error(`WDQS ${res.status}`);
  const parsed = JSON.parse(res.text) as {
    results: { bindings: SparqlBinding[] };
  };
  return parsed.results.bindings;
}

function classQuery(qid: string, limit: number): string {
  // U+001F (unit separator) can't appear in a label, so GROUP_CONCAT is safe.
  return `
SELECT ?item ?feed ?sitelinks ?label ?description
       (GROUP_CONCAT(DISTINCT ?alias; separator="\\u001F") AS ?aliases)
WHERE {
  ?item wdt:P1019 ?feed ;
        wikibase:sitelinks ?sitelinks ;
        wdt:P31/wdt:P279* wd:${qid} .
  FILTER(?sitelinks >= 1)
  OPTIONAL { ?item rdfs:label ?label . FILTER(LANG(?label) = "en") }
  OPTIONAL { ?item schema:description ?description . FILTER(LANG(?description) = "en") }
  OPTIONAL { ?item skos:altLabel ?alias . FILTER(LANG(?alias) IN (${ALIAS_LANGS.map((l) => `"${l}"`).join(", ")})) }
}
GROUP BY ?item ?feed ?sitelinks ?label ?description
ORDER BY DESC(?sitelinks)
LIMIT ${limit}`;
}

async function fetchWikidataCandidates(): Promise<Candidate[]> {
  // qid → candidate; an item reachable through several classes merges (max
  // sitelinks kept), and an item with several P1019 values collects them all.
  const byItem = new Map<string, Candidate & { qid: string }>();
  for (const cls of WIKIDATA_CLASSES) {
    process.stderr.write(`  wikidata: ${cls.name} (${cls.qid})…`);
    let rows: SparqlBinding[];
    try {
      rows = await sparql(classQuery(cls.qid, cls.limit));
    } catch (err) {
      process.stderr.write(` FAILED (${String(err)}) — skipping class\n`);
      continue;
    }
    let added = 0;
    for (const row of rows) {
      const qid = row.item?.value.split("/").pop();
      const feed = row.feed?.value;
      const title = row.label?.value?.trim();
      if (!qid || !feed || !title) continue;
      const sitelinks = Number(row.sitelinks?.value ?? 0);
      const aliases = (row.aliases?.value ?? "")
        .split("\u001F")
        .map((a) => a.trim())
        .filter(Boolean);
      const existing = byItem.get(qid);
      if (existing) {
        if (!existing.feeds.includes(feed)) existing.feeds.push(feed);
        existing.sitelinks = Math.max(existing.sitelinks, sitelinks);
        for (const a of aliases)
          if (!existing.aliases.includes(a)) existing.aliases.push(a);
      } else {
        byItem.set(qid, {
          qid,
          title,
          description: row.description?.value?.trim() || undefined,
          aliases,
          feeds: [feed],
          sitelinks,
          origin: "wikidata",
        });
        added++;
      }
    }
    process.stderr.write(` ${rows.length} rows, ${added} new items\n`);
  }
  return [...byItem.values()];
}

// ---------------------------------------------------------------------------
// OPML (operator-vetted local files)
// ---------------------------------------------------------------------------

function parseOpmlCandidates(filePath: string): Candidate[] {
  const xml = readFileSync(filePath, "utf8");
  const out: Candidate[] = [];
  const outlineRegex = /<outline\b[^>]*\bxmlUrl\s*=\s*"([^"]+)"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = outlineRegex.exec(xml)) !== null) {
    const tag = m[0];
    const feedUrl = decodeXmlEntities(m[1]);
    const title =
      /\btitle\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ??
      /\btext\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
    if (!title) continue;
    out.push({
      title: decodeXmlEntities(title).trim(),
      aliases: [],
      feeds: [feedUrl],
      sitelinks: 0,
      origin: `opml:${path.basename(filePath)}`,
    });
  }
  return out;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));
}

// ---------------------------------------------------------------------------
// Normalisation (§7.1 alias hygiene)
// ---------------------------------------------------------------------------

function normalizeAlias(raw: string): string | null {
  const folded = foldDiacritics(raw.trim().toLowerCase()).replace(/\s+/g, " ");
  if (folded.length < 3 || folded.length > 64) return null;
  return folded;
}

function toEntry(c: Candidate, description?: string): CatalogEntry | null {
  const aliases: string[] = [];
  const titleAlias = normalizeAlias(c.title);
  if (titleAlias) aliases.push(titleAlias);
  // A leading article hides the partial-match head case ("guardian" vs "the
  // guardian") — index the bare form too, mirroring the curated head's style.
  // ≥5 chars: a short bare form is too generic ("il post" → "post" would
  // false-match every query containing the word).
  const bare = titleAlias?.replace(/^(the|le|la|el|die|der|das|il) /, "");
  if (bare && bare !== titleAlias && bare.length >= 5 && !aliases.includes(bare))
    aliases.push(bare);
  for (const raw of c.aliases) {
    if (aliases.length >= MAX_ALIASES_PER_ENTRY) break;
    const a = normalizeAlias(raw);
    if (a && !aliases.includes(a)) aliases.push(a);
  }
  if (aliases.length === 0) return null;
  const desc = (c.description ?? description)?.trim();
  return {
    title: c.title,
    feedUrl: c.feeds[0],
    ...(desc ? { description: desc.length > 200 ? `${desc.slice(0, 197)}…` : desc } : {}),
    aliases,
  };
}

// ---------------------------------------------------------------------------
// Probe — the same bar as the runtime cascade (resolver.ts tryRssFetch)
// ---------------------------------------------------------------------------

const rssParser = new Parser({ timeout: 5000 });

async function probeFeed(
  url: string,
): Promise<{ title?: string; description?: string } | null> {
  try {
    const res = await safeFetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html",
      },
      timeout: PROBE_TIMEOUT_MS,
      maxBytes: PROBE_MAX_BYTES,
    });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    const isXml =
      contentType.includes("xml") ||
      contentType.includes("rss") ||
      contentType.includes("atom");
    const head = res.text.trimStart();
    if (
      !isXml &&
      !head.startsWith("<?xml") &&
      !head.startsWith("<rss") &&
      !head.startsWith("<feed")
    ) {
      return null;
    }
    const feed = await rssParser.parseString(res.text);
    return {
      title: feed.title ?? undefined,
      description: feed.description ?? undefined,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      target: { type: "string", default: "500" },
      concurrency: { type: "string", default: "12" },
      opml: { type: "string", multiple: true, default: [] },
      out: { type: "string", default: DEFAULT_OUT },
    },
  });
  const target = Number(values.target);
  const concurrency = Number(values.concurrency);

  process.stderr.write("Collecting candidates…\n");
  const candidates = [...(await fetchWikidataCandidates())];
  for (const opmlPath of values.opml ?? []) {
    const parsed = parseOpmlCandidates(opmlPath);
    process.stderr.write(`  opml: ${opmlPath} — ${parsed.length} outlines\n`);
    candidates.push(...parsed);
  }

  // Rank by prominence, then dedupe by feed host in rank order (best-ranked
  // candidate per host wins; multi-tenant hosts dedupe by full URL). Hosts
  // already covered by the curated head are dropped here too — mergeCatalogs
  // would drop them at load anyway, but skipping them saves their probes.
  candidates.sort((a, b) => b.sitelinks - a.sitelinks);
  const seenKeys = new Set(
    PUBLICATION_CATALOG.map((e) => feedHost(e.feedUrl)).filter(Boolean) as string[],
  );
  const ranked: Candidate[] = [];
  for (const c of candidates) {
    const feeds = c.feeds.filter((f) => /^https?:\/\//i.test(f));
    if (feeds.length === 0) continue;
    const host = feedHost(feeds[0]);
    if (!host) continue;
    const key = MULTI_TENANT_FEED_HOSTS.has(host) ? feeds[0].toLowerCase() : host;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    ranked.push({ ...c, feeds });
  }
  process.stderr.write(
    `Probing ${ranked.length} candidates (target ${target}, concurrency ${concurrency})…\n`,
  );

  // Worker pool over the ranked list with early stop: once `target` entries
  // are live, remaining (worse-ranked) candidates are skipped. In-flight
  // overshoot is trimmed after the rank-order sort below.
  const accepted: { rank: number; entry: CatalogEntry; origin: string }[] = [];
  let cursor = 0;
  let probed = 0;
  let dead = 0;
  async function worker(): Promise<void> {
    while (accepted.length < target) {
      const i = cursor++;
      if (i >= ranked.length) return;
      const cand = ranked[i];
      let live: { title?: string; description?: string } | null = null;
      let liveUrl: string | null = null;
      for (const feedUrl of cand.feeds) {
        probed++;
        live = await probeFeed(feedUrl);
        if (live) {
          liveUrl = feedUrl;
          break;
        }
      }
      if (!live || !liveUrl) {
        dead++;
        continue;
      }
      const entry = toEntry({ ...cand, feeds: [liveUrl] }, live.description);
      if (!entry) continue;
      accepted.push({ rank: i, entry, origin: cand.origin });
      if (accepted.length % 50 === 0) {
        process.stderr.write(`  ${accepted.length}/${target} live (${dead} dead so far)\n`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  accepted.sort((a, b) => a.rank - b.rank);
  const finalEntries = accepted.slice(0, target);
  const originCounts = new Map<string, number>();
  for (const { origin } of finalEntries) {
    originCounts.set(origin, (originCounts.get(origin) ?? 0) + 1);
  }
  const originSummary = [...originCounts.entries()]
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");

  const header = `// =============================================================================
// GENERATED FILE — DO NOT HAND-EDIT.
// Produced by scripts/gen-discovery-catalog.ts (RESOLVER-DISCOVERY-ADR §7.1)
// on ${new Date().toISOString().slice(0, 10)}. ${finalEntries.length} entries (${originSummary}),
// prominence-ordered (Wikidata sitelink count), every feed probed live at
// generation time. Wikidata content is CC0.
// Regenerate: npx tsx scripts/gen-discovery-catalog.ts
// =============================================================================
import type { CatalogEntry } from "./discovery-catalog.js";

export const GENERATED_PUBLICATION_CATALOG: CatalogEntry[] = `;

  writeFileSync(
    values.out!,
    `${header}${JSON.stringify(finalEntries.map((a) => a.entry), null, 2)};\n`,
  );
  process.stderr.write(
    `\nWrote ${finalEntries.length} entries to ${values.out} (${probed} probed, ${dead} dead/unparseable).\n`,
  );
  if (finalEntries.length < 300) {
    process.stderr.write(
      "WARNING: below the 300-entry acceptance floor (RESOLVER-DISCOVERY-ADR §9 Phase 4).\n",
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`gen-discovery-catalog failed: ${String(err)}\n`);
  process.exit(1);
});

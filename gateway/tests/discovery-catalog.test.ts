import { describe, it, expect } from "vitest";
import {
  searchCatalog,
  PUBLICATION_CATALOG,
} from "../src/lib/discovery-catalog.js";

// Curated publication catalog — discovery fallback branch 3
// (UNIVERSAL-FEED-ADR §V.5.8). Pure, instant, no I/O.
describe("searchCatalog (discovery fallback branch 3)", () => {
  it("matches a bare name to its canonical feed (the head case)", () => {
    const out = searchCatalog("Guardian");
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("The Guardian");
    expect(out[0].feedUrl).toBe("https://www.theguardian.com/international/rss");
  });

  it("is case-insensitive and trims", () => {
    expect(searchCatalog("  bbc  ")[0]?.title).toBe("BBC News");
    expect(searchCatalog("BBC")[0]?.title).toBe("BBC News");
  });

  it("matches a partial of an alias (alias ⊇ query)", () => {
    // "guard" ⊆ "guardian"
    expect(searchCatalog("guard")[0]?.title).toBe("The Guardian");
  });

  it("matches a superset of an alias (query ⊇ alias)", () => {
    // "guardian" ⊆ "the guardian newspaper"
    expect(searchCatalog("the guardian newspaper")[0]?.title).toBe(
      "The Guardian",
    );
  });

  it("resolves common aliases to the same entry", () => {
    for (const q of ["nyt", "nytimes", "new york times"]) {
      expect(searchCatalog(q)[0]?.title).toBe("The New York Times");
    }
  });

  it("requires at least 2 characters (no single-keystroke fan-out)", () => {
    expect(searchCatalog("h")).toEqual([]);
    expect(searchCatalog("")).toEqual([]);
  });

  it("caps results at the requested limit", () => {
    // "news" appears in several descriptions/aliases; cap still holds.
    const out = searchCatalog("news", 2);
    expect(out.length).toBeLessThanOrEqual(2);
  });

  it("returns [] for a name not in the catalog", () => {
    expect(searchCatalog("zzz-not-a-publication")).toEqual([]);
  });

  it("every catalog entry has an https/http feed URL and aliases", () => {
    for (const entry of PUBLICATION_CATALOG) {
      expect(entry.feedUrl).toMatch(/^https?:\/\//);
      expect(entry.aliases.length).toBeGreaterThan(0);
      // Aliases must be lowercase so case-insensitive matching is symmetric.
      for (const a of entry.aliases) expect(a).toBe(a.toLowerCase());
    }
  });
});

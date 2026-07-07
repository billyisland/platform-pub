import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// =============================================================================
// EXTERNAL-AUTHOR-HISTORY-ADR §3.1/§3.7 — the profile-view hydration trigger
// gates: operator kill switch, protocol support, and the per-author 10-minute
// TTL guard (a hot profile hydrates once, not per viewer). Network + DB are
// mocked; the integration surface is covered in author-posts-hydration.test.ts.
// =============================================================================

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: vi.fn(async () => ({
      rows: [{ id: "shadow-src-1", relay_urls: [] }],
      rowCount: 1,
    })),
  },
  withTransaction: vi.fn(),
}));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../src/lib/nostr-relay.js", () => ({
  fetchNostrEvents: vi.fn(async () => []),
  fetchNostrWriteRelays: vi.fn(async () => []),
  NOSTR_FALLBACK_RELAYS: ["wss://fallback.example"],
}));

const {
  authorTimelineHydrationEnabled,
  willHydrateAuthorTimeline,
  hydrateAuthorTimeline,
  resetAuthorTimelineGuard,
} = await import("../src/lib/author-timeline-hydration.js");

const AUTHOR = "11111111-0000-4000-8000-000000000001";
const PUBKEY = "a".repeat(64);

describe("author timeline hydration gates", () => {
  beforeEach(() => {
    resetAuthorTimelineGuard();
    delete process.env.AUTHOR_TIMELINE_HYDRATION_ENABLED;
  });
  afterEach(() => {
    delete process.env.AUTHOR_TIMELINE_HYDRATION_ENABLED;
  });

  it("kill switch defaults ON; '0' and 'false' disable", () => {
    expect(authorTimelineHydrationEnabled()).toBe(true);
    process.env.AUTHOR_TIMELINE_HYDRATION_ENABLED = "1";
    expect(authorTimelineHydrationEnabled()).toBe(true);
    process.env.AUTHOR_TIMELINE_HYDRATION_ENABLED = "0";
    expect(authorTimelineHydrationEnabled()).toBe(false);
    process.env.AUTHOR_TIMELINE_HYDRATION_ENABLED = "false";
    expect(authorTimelineHydrationEnabled()).toBe(false);
  });

  it("kill switch off ⇒ willHydrate false", () => {
    process.env.AUTHOR_TIMELINE_HYDRATION_ENABLED = "0";
    expect(willHydrateAuthorTimeline(AUTHOR, "nostr_external")).toBe(false);
  });

  it("only supported protocols hydrate (nostr first; rss/email never)", () => {
    expect(willHydrateAuthorTimeline(AUTHOR, "nostr_external")).toBe(true);
    expect(willHydrateAuthorTimeline(AUTHOR, "rss")).toBe(false);
    expect(willHydrateAuthorTimeline(AUTHOR, "email")).toBe(false);
  });

  it("TTL guard: a hydrate stamps the author; a second view within the window doesn't re-kick", async () => {
    expect(willHydrateAuthorTimeline(AUTHOR, "nostr_external")).toBe(true);
    await hydrateAuthorTimeline({
      authorId: AUTHOR,
      protocol: "nostr_external",
      followUri: PUBKEY,
    });
    expect(willHydrateAuthorTimeline(AUTHOR, "nostr_external")).toBe(false);
    // …and the guard is per-author, not global.
    expect(
      willHydrateAuthorTimeline(
        "22222222-0000-4000-8000-000000000002",
        "nostr_external",
      ),
    ).toBe(true);
    resetAuthorTimelineGuard();
    expect(willHydrateAuthorTimeline(AUTHOR, "nostr_external")).toBe(true);
  });

  it("kill switch off ⇒ hydrate is a no-op and never stamps the guard", async () => {
    process.env.AUTHOR_TIMELINE_HYDRATION_ENABLED = "0";
    await hydrateAuthorTimeline({
      authorId: AUTHOR,
      protocol: "nostr_external",
      followUri: PUBKEY,
    });
    delete process.env.AUTHOR_TIMELINE_HYDRATION_ENABLED;
    expect(willHydrateAuthorTimeline(AUTHOR, "nostr_external")).toBe(true);
  });
});

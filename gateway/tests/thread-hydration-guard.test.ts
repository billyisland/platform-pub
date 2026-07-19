import { describe, it, expect, vi, beforeEach } from "vitest";

// =============================================================================
// THREAD-HYDRATION-LATENCY-ADR D1 — the server half of the deadlock fix. The
// `hydrating` flag must be derived from an in-flight registry, not from the
// re-trigger throttle guard (which flips false the instant it is set, so a
// client's mid-flight refetch reads `hydrating: false` and caches an empty
// thread — the observed 60 s stall). Network + DB are mocked; this exercises the
// registry mechanics (in-flight truth, concurrent-caller dedupe, settle cleanup,
// guard-clear-on-failure) in isolation.
//
// Sibling: author-timeline-guard.test.ts (the profile-view hydration twin).
// =============================================================================

// pool.query answers the single `SELECT relay_urls` in hydrateNostrThread.
vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: vi.fn(async () => ({ rows: [{ relay_urls: [] }], rowCount: 1 })),
  },
  withTransaction: vi.fn(async (fn: (c: unknown) => unknown) =>
    fn({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }),
  ),
}));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// The relay layer is the only thing that fails/succeeds; tests drive it.
const fetchNostrEvents = vi.fn(async () => [] as unknown[]);
vi.mock("../src/lib/nostr-relay.js", () => ({
  fetchNostrEvents,
  NOSTR_FALLBACK_RELAYS: ["wss://fallback.example"],
}));

const {
  hydrateExternalThreadContext,
  willHydrateThread,
  isThreadHydrating,
  getInFlightHydration,
  awaitHydrationWithinBudget,
  resetThreadHydrationGuards,
} = await import("../src/lib/external-hydration.js");

const VALID_ID = "f".repeat(64); // decodeNostrEventId accepts raw 64-hex

function item(id: string, extra?: Record<string, unknown>) {
  return {
    id,
    source_id: "src-1",
    protocol: "nostr_external",
    source_item_uri: VALID_ID,
    interaction_data: { id: VALID_ID },
    ...extra,
  };
}

describe("thread hydration in-flight registry (D1)", () => {
  beforeEach(() => {
    resetThreadHydrationGuards();
    fetchNostrEvents.mockReset();
    fetchNostrEvents.mockResolvedValue([]);
  });

  it("isThreadHydrating is true while the job runs, false once it settles", async () => {
    const job = hydrateExternalThreadContext(item("A"));
    // Registered synchronously, before the async body yields.
    expect(isThreadHydrating("A")).toBe(true);
    await job;
    // finally() removed the entry — `hydrating` can never stick true.
    expect(isThreadHydrating("A")).toBe(false);
  });

  it("concurrent callers in the throttle window share one job (dedupe)", () => {
    const a = hydrateExternalThreadContext(item("B"));
    const b = hydrateExternalThreadContext(item("B"));
    expect(b).toBe(a); // same promise, not a second hydrate
  });

  it("a settled success still throttles re-triggers but reports not-hydrating", async () => {
    await hydrateExternalThreadContext(item("C"));
    // Guard still set → no re-trigger …
    expect(willHydrateThread("C", "nostr_external")).toBe(false);
    // … but the job is done, so the flag is honest.
    expect(isThreadHydrating("C")).toBe(false);
    // A throttled caller gets a resolved no-op, never a second run.
    const noop = hydrateExternalThreadContext(item("C"));
    expect(getInFlightHydration("C")).toBeUndefined();
    await expect(noop).resolves.toBeUndefined();
  });

  it("guard-on-failure: a failed hydrate is immediately re-triggerable", async () => {
    fetchNostrEvents.mockRejectedValue(new Error("relay boom"));
    await hydrateExternalThreadContext(item("D"));
    // The catch cleared the guard, so willHydrateThread is true again at once —
    // no 60 s freeze — and nothing is left in flight.
    expect(willHydrateThread("D", "nostr_external")).toBe(true);
    expect(isThreadHydrating("D")).toBe(false);
  });

  it("non-hydratable protocols are a resolved no-op, never in flight", async () => {
    const job = hydrateExternalThreadContext(item("E", { protocol: "rss" }));
    expect(isThreadHydrating("E")).toBe(false);
    await expect(job).resolves.toBeUndefined();
  });
});

// =============================================================================
// D5 — short synchronous await on first expand. /thread races the in-flight
// hydration against a budget: settled-in-time ⇒ return the complete thread with
// hydrating:false (no client poll); budget-exceeded ⇒ hydrating:true + D2 poll.
// The helper is the pure race; the route derives `hydrating = !settled`.
// =============================================================================
describe("awaitHydrationWithinBudget (D5)", () => {
  it("resolves true when the job settles within budget", async () => {
    let done!: () => void;
    const job = new Promise<void>((r) => {
      done = r;
    });
    const raced = awaitHydrationWithinBudget(job, 2_000);
    done();
    await expect(raced).resolves.toBe(true);
  });

  it("resolves false when the budget elapses before the job settles", async () => {
    vi.useFakeTimers();
    try {
      const job = new Promise<void>(() => {}); // never settles
      const raced = awaitHydrationWithinBudget(job, 2_000);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(raced).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves true immediately when there is no job to wait for", async () => {
    await expect(awaitHydrationWithinBudget(undefined, 2_000)).resolves.toBe(
      true,
    );
  });
});

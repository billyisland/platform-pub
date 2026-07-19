import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// =============================================================================
// THREAD-HYDRATION-LATENCY-ADR D3 — fetchNostrEvents early-resolve modes. The
// point of the slice is to stop paying a hung relay's full timeout on every
// thread-hydration phase. This exercises the three modes directly against a
// scriptable fake `ws`:
//   - first-event: resolve on the first EVENT from any relay (content-addressed)
//   - k-of-n: resolve at k EOSEs OR a soft deadline (broad reply nets)
//   - exhaustive (default): wait every relay to EOSE-or-timeout (unchanged; the
//     replaceable-by-author callers rely on it for newest-wins correctness)
//
// Fake timers make "resolved early vs waited for the hung relay" a deterministic
// assertion rather than a wall-clock race. A mutation that drops an early-resolve
// path makes its test hang past the point we advance to (→ red).
// =============================================================================

// Per-relay script, keyed by URL. `eoseAfterMs: null` (or absent) = a hung relay
// that connects but never signals end-of-stored-events.
interface RelayScript {
  events?: Array<{ id: string; pubkey: string; created_at: number }>;
  eventDelayMs?: number;
  eoseAfterMs?: number | null;
}
const SCRIPTS: Record<string, RelayScript> = {};

class MockWebSocket extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  url: string;
  constructor(url: string) {
    super();
    this.url = url;
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.emit("open");
    }, 0);
  }
  send(raw: string) {
    const msg = JSON.parse(raw);
    if (msg[0] !== "REQ") return; // ignore CLOSE frames
    const subId = msg[1];
    const script = SCRIPTS[this.url];
    if (!script) return;
    for (const ev of script.events ?? []) {
      setTimeout(
        () =>
          this.emit(
            "message",
            Buffer.from(JSON.stringify(["EVENT", subId, ev])),
          ),
        script.eventDelayMs ?? 1,
      );
    }
    if (script.eoseAfterMs != null) {
      setTimeout(
        () => this.emit("message", Buffer.from(JSON.stringify(["EOSE", subId]))),
        script.eoseAfterMs,
      );
    }
  }
  close() {
    this.readyState = MockWebSocket.CLOSED;
    setTimeout(() => this.emit("close"), 0);
  }
}

vi.mock("ws", () => ({ WebSocket: MockWebSocket }));
vi.mock("@platform-pub/shared/lib/http-client.js", () => ({
  pinnedWebSocketOptions: vi.fn(async () => ({})),
}));

const { fetchNostrEvents } = await import("../src/lib/nostr-relay.js");

const ev = (id: string) => ({ id, pubkey: "a".repeat(64), created_at: 1 });

// Kick off a fetch and expose a resolved-flag so a fake-timer advance can assert
// whether it has settled at that instant.
function track<T>(p: Promise<T>) {
  const state = { resolved: false, value: undefined as T | undefined };
  const done = p.then((v) => {
    state.resolved = true;
    state.value = v;
    return v;
  });
  return { state, done };
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const k of Object.keys(SCRIPTS)) delete SCRIPTS[k];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("fetchNostrEvents — D3 early-resolve modes", () => {
  it("first-event: resolves on the first hit without waiting a hung relay's timeout", async () => {
    SCRIPTS["wss://fast"] = { events: [ev("x")], eventDelayMs: 5, eoseAfterMs: 10 };
    SCRIPTS["wss://hung"] = {}; // connects, never EOSEs

    const { state, done } = track(
      fetchNostrEvents(["wss://fast", "wss://hung"], [{ ids: ["x"] }], 5_000, {
        mode: "first-event",
      }),
    );

    await vi.advanceTimersByTimeAsync(20); // fast emits at 5ms; hung would time out at 5000ms
    expect(state.resolved).toBe(true);
    const res = await done;
    expect(res.map((e) => e.id)).toEqual(["x"]);
  });

  it("k-of-n: resolves once k relays EOSE, dropping the hung straggler", async () => {
    SCRIPTS["wss://a"] = { events: [ev("a")], eoseAfterMs: 5 };
    SCRIPTS["wss://b"] = { events: [ev("b")], eoseAfterMs: 8 };
    SCRIPTS["wss://c"] = {}; // hung

    const { state, done } = track(
      fetchNostrEvents(
        ["wss://a", "wss://b", "wss://c"],
        [{ kinds: [1], "#e": ["root"] }],
        5_000,
        { mode: "k-of-n", k: 2, softDeadlineMs: 2_500 },
      ),
    );

    await vi.advanceTimersByTimeAsync(10); // a + b EOSE by 8ms → k=2 reached
    expect(state.resolved).toBe(true);
    const res = await done;
    expect(res.map((e) => e.id).sort()).toEqual(["a", "b"]);
  });

  it("k-of-n: falls back to the soft deadline when fewer than k relays EOSE", async () => {
    SCRIPTS["wss://a"] = { events: [ev("a")], eoseAfterMs: 5 };
    SCRIPTS["wss://b"] = { events: [ev("b")] }; // hung: emits then never EOSEs

    const { state, done } = track(
      fetchNostrEvents(["wss://a", "wss://b"], [{ kinds: [1] }], 5_000, {
        mode: "k-of-n",
        k: 2,
        softDeadlineMs: 2_500,
      }),
    );

    await vi.advanceTimersByTimeAsync(20); // only 1 EOSE; k=2 unmet, deadline not hit
    expect(state.resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(2_500); // soft deadline fires
    expect(state.resolved).toBe(true);
    const res = await done;
    expect(res.map((e) => e.id).sort()).toEqual(["a", "b"]);
  });

  it("exhaustive (default): waits for the hung relay's hard timeout — newest-wins callers rely on this", async () => {
    SCRIPTS["wss://a"] = { events: [ev("a")], eoseAfterMs: 5 };
    SCRIPTS["wss://b"] = { events: [ev("b")] }; // hung

    const { state, done } = track(
      fetchNostrEvents(["wss://a", "wss://b"], [{ kinds: [0] }], 200), // no mode ⇒ exhaustive
    );

    await vi.advanceTimersByTimeAsync(50); // a is done, b still connected
    expect(state.resolved).toBe(false); // exhaustive keeps waiting for b

    await vi.advanceTimersByTimeAsync(200); // b hits its 200ms timeout
    expect(state.resolved).toBe(true);
    const res = await done;
    expect(res.map((e) => e.id).sort()).toEqual(["a", "b"]);
  });
});

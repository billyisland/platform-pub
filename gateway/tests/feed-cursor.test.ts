import { describe, it, expect } from "vitest";
import { parseCursor } from "../src/lib/feed-sql.js";
import {
  encodeFeedCursor,
  decodeFeedCursor,
} from "../src/routes/feeds/items.js";

// =============================================================================
// M13 — keyset cursor epoch precision.
//
// Every time-based keyset cursor on the feed read paths compares its epoch via
// `to_timestamp()` against a full-precision `published_at`/`created_at` that the
// ORDER BY also sorts at full precision. So the epoch must survive the
// encode→wire→decode round trip WITHOUT losing its fraction. If it is truncated
// to the whole second, the cursor lands EARLIER than the row it was minted from,
// and the tuple filter `(published_at, id) < (to_timestamp(ts), id)` then
// excludes every remaining row inside that second — they compare `>` the
// truncated cursor. The client never sees them.
//
// This is not hypothetical. M13 fixed the SQL to emit a fractional epoch and the
// encoders to put it on the wire, but the DECODERS still used `parseInt`, which
// stops at the '.'. So the round trip stayed whole-second and the bug stayed
// live — the fix was inert, and "typecheck clean" could not see it. Measured on
// the running stack against `GET /tags/:name/posts`, 5 rows inside one second,
// limit 2:
//   before — cursor `1784282400`   → page 1: 2 rows, page 2: EMPTY. 3 rows lost.
//   after  — cursor `1784282400.4` → pages of 2, 2, 1. All 5, no duplicates.
//
// These tests are the guard for that. The invariant is exact and cheap to state:
// decode(encode(x)) === x, in the epoch, always. Anything less silently eats
// content at page boundaries.
// =============================================================================

const UUID = "84bdd8e5-a46a-4747-ae0e-0204125d863d";
// A real value, straight off the wire in the drive above: EXTRACT(EPOCH FROM
// '2026-07-17 10:00:00.500123+00') — the fraction is the whole point.
const FRACTIONAL = 1784282400.500123;

describe("parseCursor — epoch precision (M13)", () => {
  it("round-trips a fractional epoch on a 2-part cursor (author/tag/source logs)", () => {
    // The exact shape author.ts / tags.ts / sources.ts mint:
    //   `${Number(row.published_at_secs)}:${row.fi_id}`
    const wire = `${FRACTIONAL}:${UUID}`;
    const parsed = parseCursor(wire);
    expect(parsed).toBeDefined();
    expect(parsed!.ts).toBe(FRACTIONAL); // parseInt would give 1784282400
    expect(parsed!.id).toBe(UUID);
  });

  it("round-trips a fractional epoch on a 3-part (score) cursor", () => {
    const parsed = parseCursor(`12.5:${FRACTIONAL}:${UUID}`);
    expect(parsed!.score).toBe(12.5);
    expect(parsed!.ts).toBe(FRACTIONAL);
    expect(parsed!.id).toBe(UUID);
  });

  it("round-trips a fractional epoch on a legacy bare cursor", () => {
    const parsed = parseCursor(String(FRACTIONAL));
    expect(parsed!.ts).toBe(FRACTIONAL);
    expect(parsed!.id).toBe("ffffffff-ffff-ffff-ffff-ffffffffffff");
  });

  it("still accepts a whole-second epoch unchanged", () => {
    // Cursors already in flight when the fix deploys are whole-second; they must
    // keep working (one slightly-early page, then correct), not decode to junk.
    expect(parseCursor(`1784282400:${UUID}`)!.ts).toBe(1784282400);
  });

  it("keeps precision fine enough to separate rows 1ms apart", () => {
    // The property that actually matters: two rows inside the same second must
    // mint DIFFERENT cursors. Truncation collapses them onto one value, which is
    // precisely how the rows in between get skipped.
    const a = parseCursor(`1784282400.001:${UUID}`)!.ts;
    const b = parseCursor(`1784282400.002:${UUID}`)!.ts;
    expect(a).not.toBe(b);
  });

  describe("malformed input → undefined (restart from page 1)", () => {
    it("rejects a non-numeric epoch", () => {
      expect(parseCursor(`abc:${UUID}`)).toBeUndefined();
    });
    it("rejects a trailing-garbage epoch rather than salvaging it", () => {
      // parseInt("123abc") === 123 would silently page from a made-up position.
      expect(parseCursor(`1784282400abc:${UUID}`)).toBeUndefined();
    });
    it("rejects an empty epoch (Number('') === 0 would mean 1970)", () => {
      expect(parseCursor(`:${UUID}`)).toBeUndefined();
    });
    it("rejects a non-finite epoch", () => {
      expect(parseCursor(`Infinity:${UUID}`)).toBeUndefined();
      expect(parseCursor(`NaN:${UUID}`)).toBeUndefined();
    });
    it("rejects a bad uuid", () => {
      expect(parseCursor(`${FRACTIONAL}:not-a-uuid`)).toBeUndefined();
    });
    it("rejects undefined/empty", () => {
      expect(parseCursor(undefined)).toBeUndefined();
      expect(parseCursor("")).toBeUndefined();
    });
  });
});

describe("explore feed cursor codec — epoch precision (M13)", () => {
  it("encode → decode is lossless in the epoch", () => {
    const c = {
      kind: "explore" as const,
      score: 42.75,
      ts: FRACTIONAL,
      id: UUID,
    };
    const wire = encodeFeedCursor(c);
    expect(wire).toContain(String(FRACTIONAL)); // fraction reaches the wire
    expect(decodeFeedCursor(wire)).toEqual(c); // …and survives the trip back
  });

  it("the scored cursor still round-trips", () => {
    const c = { kind: "scored" as const, score: 1.5, id: UUID };
    expect(decodeFeedCursor(encodeFeedCursor(c))).toEqual(c);
  });

  it("the scored cursor round-trips a fractional asOf (§0i.2 pinned-age keyset)", () => {
    // asOf is what pins the D6 blend's age term across pages; losing its
    // fraction shifts every page-2 score and un-pins the keyset.
    const c = { kind: "scored" as const, score: 1.5, id: UUID, asOf: FRACTIONAL };
    const wire = encodeFeedCursor(c);
    expect(wire).toContain(String(FRACTIONAL));
    expect(decodeFeedCursor(wire)).toEqual(c);
  });

  it("a 3-part scored cursor (pre-asOf, in-flight at deploy) still decodes", () => {
    expect(decodeFeedCursor(`scored:1.5:${UUID}`)).toEqual({
      kind: "scored",
      score: 1.5,
      id: UUID,
    });
  });

  it("rejects an empty or non-finite scored asOf", () => {
    expect(decodeFeedCursor(`scored:1.5:${UUID}:`)).toBeUndefined();
    expect(decodeFeedCursor(`scored:1.5:${UUID}:Infinity`)).toBeUndefined();
    expect(decodeFeedCursor(`scored:1.5:${UUID}:abc`)).toBeUndefined();
  });

  it("a foreign/untagged shape decodes to undefined (clean restart)", () => {
    expect(decodeFeedCursor(`${FRACTIONAL}:${UUID}`)).toBeUndefined();
    expect(decodeFeedCursor("garbage")).toBeUndefined();
  });

  it("rejects an empty or non-finite explore epoch", () => {
    expect(decodeFeedCursor(`explore:1.5::${UUID}`)).toBeUndefined();
    expect(decodeFeedCursor(`explore:1.5:Infinity:${UUID}`)).toBeUndefined();
  });
});

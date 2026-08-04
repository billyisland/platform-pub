import { describe, it, expect, vi, beforeEach } from "vitest";

// =============================================================================
// convertProvisionalReads: the unlock flip is a SEPARATE claim from the read
// conversion, and must not be skipped when there is nothing left to convert
// (CONSOLIDATED-TODO §1.6).
//
// The bug: a zero-rows early return sat between the claim statement and the
// `article_unlocks` flip, so a reader whose provisional reads had already been
// converted, reversed or charged back kept `is_provisional = TRUE` rows for
// ever. Inert today; the moment the promised provisional-unlock GC ships, those
// rows are reaped and the reader loses articles they paid for.
//
// WHAT THE MOCK IS ENTITLED TO ANSWER (CLAUDE.md's mocked-pool.query rule).
// The claim statement returning zero rows is exactly what Postgres returns for
// a reader with nothing left to convert — the mock is not choosing a convenient
// fixture, it is supplying the one case under test. And the assertion is over
// which STATEMENTS the method issues, which is a structural fact the mock can
// genuinely observe. What a mock cannot prove here — that the claim statement
// really does return zero rows in that situation — is a generated-column and
// predicate question, and belongs to free-allowance-gift-integration.test.ts,
// which drives the real SQL against real Postgres.
// =============================================================================

let txCalls: Array<{ sql: string; params: unknown[] }> = [];
let convertReturns: Array<{
  id: string;
  chargeable_pence: number;
  writer_id: string;
}> = [];

const withTransactionImpl = vi.fn(
  async (cb: (client: unknown) => Promise<unknown>) => {
    const client = {
      query: (sql: string, params: unknown[] = []) => {
        txCalls.push({ sql, params });
        // Answer from the SQL, not from call order.
        if (/INSERT INTO reading_tabs/.test(sql)) {
          return Promise.resolve({ rows: [{ id: "tab-1" }], rowCount: 1 });
        }
        if (/UPDATE read_events/.test(sql) && /provisional/.test(sql)) {
          return Promise.resolve({
            rows: convertReturns,
            rowCount: convertReturns.length,
          });
        }
        if (/UPDATE article_unlocks/.test(sql)) {
          return Promise.resolve({ rows: [], rowCount: 2 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    };
    return cb(client);
  },
);

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: vi.fn() },
  withTransaction: (cb: never) => withTransactionImpl(cb),
}));

const applyLedgerDelta = vi.fn(async () => ({
  ledgerId: "led-1",
  balancePence: 0,
  tabId: "tab-1",
}));
vi.mock("@platform-pub/shared/lib/ledger.js", () => ({
  applyLedgerDelta: (...a: unknown[]) => applyLedgerDelta(...(a as [])),
}));

vi.mock("@platform-pub/shared/lib/relay-outbox.js", () => ({
  enqueueRelayPublish: vi.fn(async () => undefined),
}));

vi.mock("../src/lib/nostr.js", () => ({
  signReceiptEvent: vi.fn(() => ({ id: "evt" })),
  createPortableReceipt: vi.fn(() => "token"),
}));

vi.mock("../src/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { accrualService } from "../src/services/accrual.js";

const unlockFlip = () =>
  txCalls.find((c) => /UPDATE article_unlocks/.test(c.sql));

describe("convertProvisionalReads — the unlock flip is unconditional", () => {
  beforeEach(() => {
    txCalls = [];
    convertReturns = [];
    applyLedgerDelta.mockClear();
  });

  it("still makes provisional unlocks permanent when no reads convert", async () => {
    const converted = await accrualService.convertProvisionalReads("reader-1");

    expect(converted).toBe(0);
    // The pre-fix code returned here, before the flip was ever issued.
    const flip = unlockFlip();
    expect(flip).toBeDefined();
    expect(flip!.params[0]).toBe("reader-1");
    expect(flip!.sql).toMatch(/is_provisional\s*=\s*FALSE/);
    expect(flip!.sql).toMatch(/is_provisional\s*=\s*TRUE/); // scoped, not blanket
    // Nothing to charge, so no money moved: the flip is not a back door to one.
    expect(applyLedgerDelta).not.toHaveBeenCalled();
  });

  it("still converts and charges when there ARE reads (no regression)", async () => {
    convertReturns = [
      { id: "read-1", chargeable_pence: 40, writer_id: "writer-1" },
      { id: "read-2", chargeable_pence: 0, writer_id: "writer-1" },
    ];

    const converted = await accrualService.convertProvisionalReads("reader-1");

    expect(converted).toBe(2);
    // The fully-gifted read (0p) posts no ledger pair; the chargeable one does.
    expect(applyLedgerDelta).toHaveBeenCalledOnce();
    expect(applyLedgerDelta.mock.calls[0][1]).toMatchObject({
      accountId: "reader-1",
      counterpartyId: "writer-1",
      deltaPence: 40,
      refId: "read-1",
    });
    expect(unlockFlip()).toBeDefined();
  });

  it("issues the flip AFTER the claim, so a claimed read's unlock is included", async () => {
    convertReturns = [
      { id: "read-1", chargeable_pence: 10, writer_id: "writer-1" },
    ];
    await accrualService.convertProvisionalReads("reader-1");

    const claimIdx = txCalls.findIndex((c) => /UPDATE read_events/.test(c.sql));
    const flipIdx = txCalls.findIndex((c) =>
      /UPDATE article_unlocks/.test(c.sql),
    );
    expect(claimIdx).toBeGreaterThanOrEqual(0);
    expect(flipIdx).toBeGreaterThan(claimIdx);
  });
});

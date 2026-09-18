// Reliability regressions for requestDetailsRepo:
//
//  1. A batch whose final DB write fails must be REQUEUED, not silently
//     dropped. Previously the drained batch was gone from writeBuffer and the
//     transaction had already failed → permanent data loss.
//  2. The pending buffer is bounded; on overflow the OLDEST records are
//     dropped so the buffer cannot grow without limit.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const fake = vi.hoisted(() => ({
  rows: [],
  failCount: 0,
  maxFails: 0,
  txCalls: 0,
}));

vi.mock("@/lib/db/driver.js", () => ({
  getAdapter: async () => ({
    driver: "fake",
    transaction(fn) {
      fake.txCalls++;
      if (fake.failCount < fake.maxFails) {
        fake.failCount++;
        throw new Error("SQLITE_BUSY: database is locked");
      }
      return fn();
    },
    run(sql, params) {
      if (/INSERT INTO requestDetails/i.test(sql)) fake.rows.push(params[0]);
      return { changes: 1, lastInsertRowid: fake.rows.length };
    },
    get(sql) {
      if (/COUNT\(\*\)/i.test(sql)) return { c: fake.rows.length };
      return null;
    },
    all() { return []; },
    exec() {},
    close() {},
  }),
  getAdapterSync: () => null,
}));

// Deterministic observability config: enabled, and a batch threshold high enough
// that saveRequestDetail() never auto-flushes — the test drives flushes itself.
vi.mock("@/lib/db/repos/settingsRepo.js", () => ({
  getSettings: async () => ({
    enableObservability: true,
    observabilityBatchSize: 9999,
    observabilityMaxRecords: 200,
    observabilityFlushIntervalMs: 999999,
    observabilityMaxJsonSize: 5,
  }),
}));

const detail = (id) => ({ id, provider: "p", model: "m", status: "success", timestamp: new Date().toISOString() });

let repo;

beforeEach(async () => {
  fake.rows.length = 0;
  fake.failCount = 0;
  fake.maxFails = 0;
  fake.txCalls = 0;
  delete process.env.OBSERVABILITY_MAX_BUFFER_RECORDS;
  vi.resetModules();
  repo = await import("@/lib/db/repos/requestDetailsRepo.js");
});

afterEach(() => {
  delete process.env.OBSERVABILITY_MAX_BUFFER_RECORDS;
});

describe("requestDetailsRepo — failed batch is requeued, not dropped", () => {
  it("requeues after exhausting BUSY retries, then persists on the next flush", async () => {
    await repo.saveRequestDetail(detail("keep-1"));

    // Fail every attempt of the first flush (BUSY_RETRIES=4 → 5 attempts).
    fake.maxFails = 5;
    await repo.__test__.flushToDatabase();

    expect(fake.rows).toEqual([]);            // nothing persisted yet
    expect(fake.failCount).toBe(5);           // all retries were consumed

    // Adapter recovers: the requeued batch must still be there to write.
    fake.maxFails = 0;
    fake.failCount = 0;
    await repo.__test__.flushToDatabase();

    expect(fake.rows).toEqual(["keep-1"]);    // data survived the final failure
  });

  it("does not lose the batch even when several records were drained together", async () => {
    await repo.saveRequestDetail(detail("a"));
    await repo.saveRequestDetail(detail("b"));
    await repo.saveRequestDetail(detail("c"));

    fake.maxFails = 5;
    await repo.__test__.flushToDatabase();
    expect(fake.rows).toEqual([]);

    fake.maxFails = 0;
    fake.failCount = 0;
    await repo.__test__.flushToDatabase();

    expect(fake.rows.sort()).toEqual(["a", "b", "c"]);
  });
});

describe("requestDetailsRepo — bounded pending buffer", () => {
  it("keeps only the newest records when the buffer overflows", async () => {
    process.env.OBSERVABILITY_MAX_BUFFER_RECORDS = "3";

    for (const id of ["d1", "d2", "d3", "d4", "d5"]) {
      await repo.saveRequestDetail(detail(id));
    }

    await repo.__test__.flushToDatabase();

    // Oldest dropped, newest three retained.
    expect(fake.rows).toEqual(["d3", "d4", "d5"]);
  });

  it("never exceeds the configured cap", async () => {
    process.env.OBSERVABILITY_MAX_BUFFER_RECORDS = "2";
    for (const id of ["x1", "x2", "x3", "x4"]) {
      await repo.saveRequestDetail(detail(id));
    }
    await repo.__test__.flushToDatabase();
    expect(fake.rows).toEqual(["x3", "x4"]);
  });
});

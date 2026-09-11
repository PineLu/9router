import { describe, it, expect, beforeEach } from "vitest";

import {
  handleComboChat,
  resetComboRotation,
  isComboModelCooling,
  recordComboFailure,
  recordComboSuccess,
} from "../../open-sse/services/combo.js";

const MIN = 60 * 1000;

function failRes(status, message, retryAfter = null) {
  return {
    ok: false,
    status,
    statusText: message,
    clone() {
      return { json: async () => ({ error: { message }, retryAfter }) };
    },
  };
}

const okRes = () => ({ ok: true, status: 200 });
const quietLog = () => {
  const infos = [];
  return {
    infos,
    info: (...args) => infos.push(args.join(" ")),
    warn: () => {},
  };
};

describe("combo health fallback (failure memory)", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it("cools a 404 model for 2 minutes after a single failure", () => {
    const now = Date.now();
    const cooldown = recordComboFailure("c1", "p/bad", 404, "model not found");
    expect(cooldown).toBe(2 * MIN);
    expect(isComboModelCooling("c1", "p/bad", now)).toBe(true);
    expect(isComboModelCooling("c1", "p/bad", now + 2 * MIN + 1000)).toBe(false);
  });

  it("escalates to 15 minutes after 3 consecutive 404s", () => {
    const now = Date.now();
    recordComboFailure("c2", "p/bad", 404, "model not found", null, now);
    recordComboFailure("c2", "p/bad", 404, "model not found", null, now);
    const third = recordComboFailure("c2", "p/bad", 404, "model not found", null, now);
    expect(third).toBe(15 * MIN);
    expect(isComboModelCooling("c2", "p/bad", now + 3 * MIN)).toBe(true);
    expect(isComboModelCooling("c2", "p/bad", now + 15 * MIN + 1000)).toBe(false);
  });

  it("clears failure memory on success (half-open recovery)", () => {
    recordComboFailure("c3", "p/flaky", 404, "model not found");
    expect(isComboModelCooling("c3", "p/flaky")).toBe(true);
    recordComboSuccess("c3", "p/flaky");
    expect(isComboModelCooling("c3", "p/flaky")).toBe(false);
  });

  it("honors upstream 429 retry window capped at 30 minutes", () => {
    const now = Date.now();
    const cooldown = recordComboFailure("c4", "p/slow", 429, "Rate limited. Try again in 31m", null, now);
    expect(cooldown).toBe(30 * MIN);
    expect(isComboModelCooling("c4", "p/slow", now + 29 * MIN)).toBe(true);
    expect(isComboModelCooling("c4", "p/slow", now + 30 * MIN + 1000)).toBe(false);
  });

  it("leaves no cooling record for transient 502/503/504", () => {
    for (const status of [502, 503, 504]) {
      expect(recordComboFailure("c5", "p/wobbly", status, "bad gateway")).toBe(0);
    }
    expect(isComboModelCooling("c5", "p/wobbly")).toBe(false);
  });

  it("skips cooling models, hard-tries when all are cooling", async () => {
    const log = quietLog();
    const calls = [];
    const handleSingleModel = async (_body, model) => {
      calls.push(model);
      if (model === "p/bad") return failRes(404, "model not found");
      return okRes();
    };
    const opts = (extra = {}) => ({
      body: {},
      models: ["p/bad", "p/good"],
      handleSingleModel,
      log,
      comboName: "c6",
      ...extra,
    });

    // Request 1: bad fails (404 recorded), good succeeds.
    const r1 = await handleComboChat(opts());
    expect(r1.ok).toBe(true);
    expect(calls).toEqual(["p/bad", "p/good"]);

    // Request 2: bad is cooling → skipped outright.
    const r2 = await handleComboChat(opts());
    expect(r2.ok).toBe(true);
    expect(calls).toEqual(["p/bad", "p/good", "p/good"]);
    expect(log.infos.some((m) => m.includes("skipping cooling models"))).toBe(true);

    // All cooling → hard try instead of instant 503.
    recordComboFailure("c6", "p/good", 404, "model not found");
    const r3 = await handleComboChat(opts());
    expect(r3.ok).toBe(true);
    expect(calls.length).toBeGreaterThan(3);
  });
});

import { describe, expect, it } from "vitest";
import {
  normalizeComboStrategy,
  resolveComboStrategy,
  setComboStrategyOverride,
} from "../../src/shared/utils/comboStrategy.js";

describe("combo strategy resolution", () => {
  it("inherits legacy global strategy when no per-combo override exists", () => {
    expect(resolveComboStrategy({ comboStrategy: "round-robin", comboStrategies: {} }, "main"))
      .toBe("round-robin");
  });

  it("lets an explicit fallback override a legacy global round-robin", () => {
    expect(resolveComboStrategy({
      comboStrategy: "round-robin",
      comboStrategies: { main: { fallbackStrategy: "fallback" } },
    }, "main")).toBe("fallback");
  });

  it("persists explicit fallback when global strategy is round-robin", () => {
    expect(setComboStrategyOverride({}, "main", "fallback", "round-robin"))
      .toEqual({ main: { fallbackStrategy: "fallback" } });
  });

  it("prunes only a redundant strategy while preserving other combo options", () => {
    expect(setComboStrategyOverride({
      main: { fallbackStrategy: "fallback", autoSwitch: false, judgeModel: "p/judge" },
    }, "main", "round-robin", "round-robin")).toEqual({
      main: { autoSwitch: false, judgeModel: "p/judge" },
    });
  });

  it("removes an empty redundant override when global is already fallback", () => {
    expect(setComboStrategyOverride({ main: { fallbackStrategy: "round-robin" } }, "main", "fallback", "fallback"))
      .toEqual({});
  });

  it("normalizes unknown values safely", () => {
    expect(normalizeComboStrategy("wat", "fallback")).toBe("fallback");
    expect(resolveComboStrategy({ comboStrategy: "wat" }, "main")).toBe("fallback");
  });
});

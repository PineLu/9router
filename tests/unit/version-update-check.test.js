import { describe, expect, it } from "vitest";
import { getVersionUpdateInfo, isCliDistribution } from "@/lib/version/updateCheck.js";

describe("version update channel", () => {
  it("does not compare a source deployment with the npm CLI package", () => {
    expect(isCliDistribution(undefined)).toBe(false);
    expect(getVersionUpdateInfo({
      currentVersion: "0.5.116",
      latestVersion: "0.5.119",
      distribution: undefined,
    })).toEqual({
      currentVersion: "0.5.116",
      latestVersion: null,
      hasUpdate: false,
    });
  });

  it("checks npm updates for a packaged CLI distribution", () => {
    expect(isCliDistribution("cli")).toBe(true);
    expect(getVersionUpdateInfo({
      currentVersion: "0.5.116",
      latestVersion: "0.5.119",
      distribution: "cli",
    })).toEqual({
      currentVersion: "0.5.116",
      latestVersion: "0.5.119",
      hasUpdate: true,
    });
  });

  it("does not report an update when the CLI package is current", () => {
    expect(getVersionUpdateInfo({
      currentVersion: "0.5.119",
      latestVersion: "0.5.119",
      distribution: "cli",
    }).hasUpdate).toBe(false);
  });

  it("fails closed when the npm latest version is unavailable", () => {
    expect(getVersionUpdateInfo({
      currentVersion: "0.5.119",
      latestVersion: null,
      distribution: "cli",
    })).toEqual({
      currentVersion: "0.5.119",
      latestVersion: null,
      hasUpdate: false,
    });
  });
});

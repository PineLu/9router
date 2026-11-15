import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { getTailscaleBin, getTailscaledBin } from "@/lib/tunnel/tailscale/tailscale.js";

describe("Tailscale host binary resolver", () => {
  it.skipIf(process.platform !== "darwin" || process.arch !== "arm64" || !fs.existsSync("/opt/homebrew/bin/tailscaled"))(
    "resolves the Apple Silicon Homebrew CLI and daemon pair",
    () => {
      expect(getTailscaleBin()).toBe("/opt/homebrew/bin/tailscale");
      expect(getTailscaledBin()).toBe("/opt/homebrew/bin/tailscaled");
    },
  );
});

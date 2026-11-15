import { describe, expect, it } from "vitest";
import { findExecutable, getBinaryCandidates } from "@/lib/tunnel/tailscale/binaryPaths.js";

describe("Tailscale binary discovery", () => {
  it("prefers Homebrew paths on Apple Silicon", () => {
    const candidates = getBinaryCandidates({
      binaryName: "tailscale",
      platform: "darwin",
      arch: "arm64",
      dataBinDir: "/data/bin",
    });

    expect(candidates.slice(0, 3)).toEqual([
      "/data/bin/tailscale",
      "/opt/homebrew/bin/tailscale",
      "/usr/local/bin/tailscale",
    ]);
  });

  it("prefers the Intel Homebrew prefix on Intel Macs", () => {
    const candidates = getBinaryCandidates({
      binaryName: "tailscaled",
      platform: "darwin",
      arch: "x64",
    });

    expect(candidates.slice(0, 2)).toEqual([
      "/usr/local/bin/tailscaled",
      "/opt/homebrew/bin/tailscaled",
    ]);
  });

  it("pairs tailscaled with the selected CLI installation first", () => {
    const candidates = getBinaryCandidates({
      binaryName: "tailscaled",
      platform: "darwin",
      arch: "arm64",
      cliBin: "/opt/homebrew/bin/tailscale",
      dataBinDir: "/data/bin",
    });

    expect(candidates.slice(0, 3)).toEqual([
      "/opt/homebrew/bin/tailscaled",
      "/data/bin/tailscaled",
      "/usr/local/bin/tailscaled",
    ]);
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it("includes standard Linux system directories and PATH entries", () => {
    const candidates = getBinaryCandidates({
      binaryName: "tailscaled",
      platform: "linux",
      arch: "x64",
      pathValue: "/custom/bin:/usr/bin",
    });

    expect(candidates).toContain("/usr/local/sbin/tailscaled");
    expect(candidates).toContain("/usr/sbin/tailscaled");
    expect(candidates).toContain("/custom/bin/tailscaled");
  });

  it("returns the first executable candidate and skips missing or non-executable files", () => {
    const executable = new Set(["/opt/homebrew/bin/tailscaled"]);
    const fileSystem = {
      constants: { X_OK: 1 },
      accessSync(candidate, mode) {
        expect(mode).toBe(1);
        if (!executable.has(candidate)) throw new Error("not executable");
      },
    };

    expect(findExecutable([
      "/usr/local/bin/tailscaled",
      "/opt/homebrew/bin/tailscaled",
      "/usr/bin/tailscaled",
    ], fileSystem)).toBe("/opt/homebrew/bin/tailscaled");
    expect(findExecutable(["/missing/tailscaled"], fileSystem)).toBeNull();
  });
});

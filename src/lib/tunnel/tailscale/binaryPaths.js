import path from "path";

const MAC_BIN_DIRS = {
  arm64: ["/opt/homebrew/bin", "/usr/local/bin"],
  x64: ["/usr/local/bin", "/opt/homebrew/bin"],
};

const UNIX_BIN_DIRS = [
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/bin",
  "/sbin",
  "/snap/bin",
];

export function getBinaryCandidates({
  binaryName,
  platform = process.platform,
  arch = process.arch,
  dataBinDir,
  cliBin,
  pathValue = "",
}) {
  const candidates = [];
  const add = (candidate) => {
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  };
  const addDir = (directory) => add(path.join(directory, binaryName));

  // Keep a CLI and daemon from the same installation together when possible.
  if (binaryName === "tailscaled" && cliBin) add(path.join(path.dirname(cliBin), binaryName));
  if (dataBinDir) addDir(dataBinDir);

  if (platform === "win32") {
    if (binaryName === "tailscale.exe") add("C:\\Program Files\\Tailscale\\tailscale.exe");
    return candidates;
  }

  const systemDirs = platform === "darwin"
    ? (MAC_BIN_DIRS[arch] || MAC_BIN_DIRS.x64)
    : UNIX_BIN_DIRS;
  for (const directory of systemDirs) addDir(directory);
  for (const directory of pathValue.split(path.delimiter)) addDir(directory);

  return candidates;
}

export function findExecutable(candidates, fileSystem) {
  for (const candidate of candidates) {
    try {
      fileSystem.accessSync(candidate, fileSystem.constants.X_OK);
      return candidate;
    } catch {
      // Keep looking; candidates may be absent or not executable.
    }
  }
  return null;
}

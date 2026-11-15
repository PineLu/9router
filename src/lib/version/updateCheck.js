export function isCliDistribution(distribution) {
  return distribution === "cli";
}

export function getVersionUpdateInfo({ currentVersion, latestVersion, distribution }) {
  const shouldCheck = isCliDistribution(distribution);
  const hasUpdate = shouldCheck && latestVersion
    ? compareVersions(latestVersion, currentVersion) > 0
    : false;

  return {
    currentVersion,
    latestVersion: shouldCheck ? latestVersion : null,
    hasUpdate,
  };
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

const path = require("path");

function readVersionFrom(filePath) {
  try {
    const pkg = require(filePath);
    if (typeof pkg?.version === "string" && pkg.version.length > 0) return pkg.version;
  } catch {}
  return null;
}

function getAppVersion() {
  const rootVersion = readVersionFrom(path.resolve(__dirname, "../package.json"));
  if (rootVersion) return rootVersion;
  const srcVersion = readVersionFrom(path.resolve(__dirname, "./package.json"));
  if (srcVersion) return srcVersion;
  return "unknown";
}

const appVersion = getAppVersion();

module.exports = { appVersion, getAppVersion };
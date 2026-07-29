import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const rootPkgPath = path.join(projectRoot, "package.json");
const srcPkgPath = path.join(projectRoot, "src", "package.json");

main().catch((error) => {
  console.error(`[version] ${error.message}`);
  process.exit(1);
});

async function main() {
  const mode = process.argv[2];
  const value = process.argv[3];

  if (!mode || !["set", "patch", "minor", "major"].includes(mode)) {
    throw new Error("usage: node scripts/version.mjs <set|patch|minor|major> [x.y.z]");
  }

  const rootPkg = await readJson(rootPkgPath);
  const srcPkg = await readJson(srcPkgPath);
  const current = rootPkg.version || srcPkg.version;

  if (!isValidSemver(current)) {
    throw new Error(`current version is invalid: ${current ?? "(empty)"}`);
  }

  let nextVersion;
  if (mode === "set") {
    if (!value || !isValidSemver(value)) {
      throw new Error("set mode requires valid semver like 8.0.0");
    }
    nextVersion = value;
  } else {
    nextVersion = bump(current, mode);
  }

  rootPkg.version = nextVersion;
  srcPkg.version = nextVersion;

  await writeJson(rootPkgPath, rootPkg);
  await writeJson(srcPkgPath, srcPkg);

  console.log(`[version] ${current} -> ${nextVersion}`);
  console.log("[version] updated: package.json, src/package.json");
}

function isValidSemver(input) {
  return typeof input === "string" && /^\d+\.\d+\.\d+$/.test(input);
}

function bump(version, mode) {
  const [major, minor, patch] = version.split(".").map(Number);
  if (mode === "patch") return `${major}.${minor}.${patch + 1}`;
  if (mode === "minor") return `${major}.${minor + 1}.0`;
  return `${major + 1}.0.0`;
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function writeJson(filePath, data) {
  const text = JSON.stringify(data, null, 2) + "\n";
  await fs.writeFile(filePath, text, "utf8");
}
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const updateTempBase = process.env.UPDATE_TMPDIR || process.env.TMPDIR || path.join(projectRoot, '.update-tmp');

const repoSlug = process.env.GITHUB_REPOSITORY || 'mesamaru/schedule-manage-bot';
const apiBase = `https://api.github.com/repos/${repoSlug}`;
const preserveTargetEntries = new Set(['.env', '.git', 'data', 'logs', 'node_modules']);
const skipSourceEntries = new Set(['.git', 'data', 'logs', 'node_modules']);

main().catch((error) => {
  console.error(`[update] ${error.message}`);
  process.exit(1);
});

async function main() {
  console.log(`[update] Checking ${repoSlug}...`);

  const repoInfo = await fetchJson(apiBase);
  const defaultBranch = repoInfo.default_branch || 'main';

  let release;
  try {
    release = await fetchJson(`${apiBase}/releases/latest`);
  } catch (error) {
    if (error.statusCode !== 404) throw error;
  }

  const archiveUrl = release?.tarball_url || `${apiBase}/tarball/${defaultBranch}`;
  const sourceLabel = release?.tag_name || defaultBranch;
  const releaseName = release?.name || release?.tag_name || `${defaultBranch} snapshot`;

  if (release) {
    console.log(`[update] Downloading latest release: ${releaseName}`);
  } else {
    console.log(`[update] Latest release not found. Falling back to ${defaultBranch}.`);
  }

  await fs.mkdir(updateTempBase, { recursive: true });

  let tempRoot;
  try {
    tempRoot = await fs.mkdtemp(path.join(updateTempBase, 'schedule-manage-bot-update-'));
    const archivePath = path.join(tempRoot, 'release.tar.gz');
    const extractRoot = path.join(tempRoot, 'extract');

    await fs.mkdir(extractRoot, { recursive: true });
    await downloadToFile(archiveUrl, archivePath);
    run('tar', ['-xzf', archivePath, '-C', extractRoot], 'archive extraction failed');

    const extractedRoot = await getSingleExtractedRoot(extractRoot);
    await syncProject(extractedRoot, projectRoot);

    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    run(npmCommand, ['install', '--omit=dev'], 'npm install failed', { shell: process.platform === 'win32' });

    console.log(`[update] Update completed from ${sourceLabel}.`);
  } finally {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function syncProject(sourceRoot, targetRoot) {
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (skipSourceEntries.has(entry.name)) continue;

    const sourcePath = path.join(sourceRoot, entry.name);
    const targetPath = path.join(targetRoot, entry.name);

    if (preserveTargetEntries.has(entry.name)) {
      console.log(`[update] Preserved local ${entry.name}`);
      continue;
    }

    await fs.rm(targetPath, { recursive: true, force: true });

    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, targetPath);
    } else if (entry.isSymbolicLink()) {
      const linkTarget = await fs.readlink(sourcePath);
      await fs.symlink(linkTarget, targetPath);
    } else {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(sourcePath, targetPath);
    }
  }
}

async function copyDirectory(sourceDir, targetDir) {
  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, targetPath);
    } else if (entry.isSymbolicLink()) {
      const linkTarget = await fs.readlink(sourcePath);
      await fs.symlink(linkTarget, targetPath);
    } else {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(sourcePath, targetPath);
    }
  }
}

async function getSingleExtractedRoot(extractRoot) {
  const entries = await fs.readdir(extractRoot, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory());
  if (dirs.length !== 1) {
    throw new Error('unexpected archive layout');
  }
  return path.join(extractRoot, dirs[0].name);
}

async function fetchJson(url) {
  const response = await request(url, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'schedule-manage-bot-updater'
    }
  });

  const body = await readBody(response);
  if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
    const error = new Error(`GitHub API request failed: ${response.statusCode}`);
    error.statusCode = response.statusCode;
    error.body = body;
    throw error;
  }

  return JSON.parse(body);
}

async function downloadToFile(url, outputPath) {
  const response = await request(url, {
    headers: {
      'User-Agent': 'schedule-manage-bot-updater'
    }
  });

  if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
    throw new Error(`archive download failed: ${response.statusCode}`);
  }

  await pipeline(response, createWriteStream(outputPath));
}

function request(url, options, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, options, (response) => {
      const statusCode = response.statusCode || 0;
      const location = response.headers.location;
      if (statusCode >= 300 && statusCode < 400 && location) {
        response.resume();
        if (redirectCount >= 5) {
          reject(new Error('too many redirects'));
          return;
        }
        resolve(request(location, options, redirectCount + 1));
        return;
      }
      resolve(response);
    });

    req.on('error', reject);
  });
}

function readBody(response) {
  return new Promise((resolve, reject) => {
    let data = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => {
      data += chunk;
    });
    response.on('end', () => resolve(data));
    response.on('error', reject);
  });
}

function run(command, args, failureMessage, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: options.shell || false,
  });

  if (result.error) {
    throw new Error(`${failureMessage}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`${failureMessage} (exit ${result.status ?? 'unknown'})`);
  }
}
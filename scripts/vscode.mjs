// Downloads the desktop VS Code that `engines.vscode` in package.json names as the minimum, and
// checks it against the SHA-256 of the update service. Linux only.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const UPDATE_SERVICE = 'https://update.code.visualstudio.com';

/**
 * The exact version behind a caret range: `^1.146.0` is `1.146.0`.
 * @param {string} range `engines.vscode`
 */
export function minimumVersion(range) {
  const match = /^\^(\d+\.\d+\.\d+)$/.exec(range);
  if (!match?.[1]) throw new Error(`engines.vscode is ${JSON.stringify(range)}, expected ^X.Y.Z`);
  return match[1];
}

/**
 * @param {string} platform `process.platform`
 * @param {string} arch `process.arch`
 */
export function updatePlatform(platform, arch) {
  if (platform !== 'linux' || (arch !== 'x64' && arch !== 'arm64')) {
    throw new Error(
      `no VS Code download for ${platform}-${arch}, only for linux-x64 and linux-arm64`,
    );
  }
  return `${platform}-${arch}`;
}

/**
 * Reads the answer of the update service.
 * @param {unknown} answer
 * @param {string} version the version that was asked for
 * @returns {{ url: string, sha256: string }}
 */
export function parseUpdate(answer, version) {
  const { url, sha256hash, productVersion } = /** @type {Record<string, unknown>} */ (answer ?? {});
  if (productVersion !== version) {
    throw new Error(
      `asked for VS Code ${version}, the update service has ${String(productVersion)}`,
    );
  }
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    throw new Error(`the update service has no https download: ${String(url)}`);
  }
  if (typeof sha256hash !== 'string' || !/^[0-9a-f]{64}$/.test(sha256hash)) {
    throw new Error(`the update service has no SHA-256 for ${url}`);
  }
  return { url, sha256: sha256hash };
}

/** @param {string} url */
async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok || !response.body)
    throw new Error(`GET ${url}: HTTP ${String(response.status)}`);
  return response;
}

/** @param {string} file */
async function sha256(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/**
 * Returns the directory of VS Code; downloads and unpacks it if it is not there yet. An archive in
 * the cache is used only if it has the right SHA-256.
 * @param {string} version
 * @param {string} cacheDir
 */
export async function ensureVscode(version, cacheDir) {
  const platform = updatePlatform(process.platform, process.arch);
  const dir = join(cacheDir, `vscode-${version}-${platform}`);
  if (existsSync(dir)) return dir;

  await mkdir(cacheDir, { recursive: true });
  const archive = `${dir}.tar.gz`;
  const answer = await get(`${UPDATE_SERVICE}/api/versions/${version}/${platform}/stable`);
  const update = parseUpdate(await answer.json(), version);
  if (!existsSync(archive) || (await sha256(archive)) !== update.sha256) {
    console.log(`Downloading ${update.url}`);
    const { body } = await get(update.url);
    const part = `${archive}.part`;
    await pipeline(Readable.fromWeb(/** @type {any} */ (body)), createWriteStream(part));
    const actual = await sha256(part);
    if (actual !== update.sha256) {
      await rm(part);
      throw new Error(`${update.url}: SHA-256 is ${actual}, expected ${update.sha256}`);
    }
    await rename(part, archive);
  }
  console.log(`${basename(archive)} has the SHA-256 of the update service`);

  // Renamed at the end, so a directory of this name is always complete.
  const temporary = await mkdtemp(`${dir}-`);
  const tar = spawnSync('tar', ['-xzf', archive, '--strip-components=1', '-C', temporary], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (tar.error || tar.status !== 0) {
    await rm(temporary, { recursive: true });
    throw new Error(`tar failed (${tar.error?.message ?? `exit ${String(tar.status)}`})`);
  }
  await rename(temporary, dir);
  return dir;
}

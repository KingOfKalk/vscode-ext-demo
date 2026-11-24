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

/**
 * The message of an error and of its causes, one per line. `fetch` hides the reason (ECONNREFUSED,
 * a certificate, a timeout) in `cause`; its own message is only "fetch failed".
 * @param {unknown} error
 */
export function describeFailure(error) {
  const lines = [];
  /** @type {unknown} */
  let current = error;
  for (let depth = 0; depth < 5 && current !== undefined; depth++) {
    if (!(current instanceof Error)) {
      lines.push(depth === 0 ? String(current) : `caused by: ${String(current)}`);
      break;
    }
    if (depth === 0) {
      lines.push(current.message);
    } else {
      const code = /** @type {{ code?: unknown }} */ (current).code;
      const detail = [typeof code === 'string' ? code : '', current.message]
        .filter((part) => part !== '')
        .join(': ');
      lines.push(`caused by: ${detail}`);
    }
    current = current.cause;
  }
  return lines.join('\n');
}

const RETRIES = 2;

/**
 * GET. A network error or a 5xx answer is tried again twice, after a pause that doubles; any other
 * answer is final. The error names the URL and keeps the network error as its `cause`.
 * @param {string} url
 * @param {number} retryDelayMs the pause before the first retry
 */
async function get(url, retryDelayMs) {
  for (let attempt = 0; ; attempt++) {
    /** @type {Error} */
    let failure;
    let retry;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
      if (response.ok && response.body) return response;
      await response.body?.cancel();
      failure = new Error(`GET ${url}: HTTP ${String(response.status)}`);
      retry = response.status >= 500;
    } catch (error) {
      failure = new Error(`GET ${url} failed`, {
        cause: error,
      });
      retry = true;
    }
    if (!retry || attempt >= RETRIES) throw failure;
    const pause = retryDelayMs * 2 ** attempt;
    console.warn(
      `${describeFailure(failure).replaceAll('\n', '; ')}; trying again in ${String(pause)} ms`,
    );
    await new Promise((resolve) => setTimeout(resolve, pause));
  }
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
 * @param {{ platform?: string, arch?: string, retryDelayMs?: number }} [target] defaults: this
 *   machine, a pause of 1 s before the first retry; the tests inject their own
 */
export async function ensureVscode(version, cacheDir, target = {}) {
  const { platform: os = process.platform, arch = process.arch, retryDelayMs = 1000 } = target;
  const platform = updatePlatform(os, arch);
  const dir = join(cacheDir, `vscode-${version}-${platform}`);
  if (existsSync(dir)) return dir;

  await mkdir(cacheDir, { recursive: true });
  const archive = `${dir}.tar.gz`;
  const answer = await get(
    `${UPDATE_SERVICE}/api/versions/${version}/${platform}/stable`,
    retryDelayMs,
  );
  const update = parseUpdate(await answer.json(), version);
  if (!existsSync(archive) || (await sha256(archive)) !== update.sha256) {
    console.log(`Downloading ${update.url}`);
    const { body } = await get(update.url, retryDelayMs);
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

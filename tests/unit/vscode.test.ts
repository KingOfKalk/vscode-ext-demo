import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureVscode,
  minimumVersion,
  parseUpdate,
  updatePlatform,
} from '../../scripts/vscode.mjs';

const VERSION = '1.146.0';
const URL = 'https://example.com/code.tar.gz';
const PLATFORM = updatePlatform('linux', process.arch);

describe('minimumVersion', () => {
  it('takes the version of a caret range', () => {
    expect(minimumVersion('^1.146.0')).toBe('1.146.0');
  });

  it.each(['1.146.0', '>=1.146.0', '^1.146', '*', '^1.146.0-insider', '^1.146.0 || ^2.0.0'])(
    'refuses %s',
    (range) => {
      expect(() => minimumVersion(range)).toThrow('expected ^X.Y.Z');
    },
  );

  it('reads the version in package.json', () => {
    const manifest = JSON.parse(
      readFileSync(new globalThis.URL('../../package.json', import.meta.url), 'utf8'),
    ) as { engines: { vscode: string } };
    expect(minimumVersion(manifest.engines.vscode)).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('updatePlatform', () => {
  it.each([
    ['x64', 'linux-x64'],
    ['arm64', 'linux-arm64'],
  ])('knows %s', (arch, expected) => {
    expect(updatePlatform('linux', arch)).toBe(expected);
  });

  it.each([
    ['linux', 'arm'],
    ['darwin', 'arm64'],
    ['win32', 'x64'],
  ])('refuses %s-%s', (platform, arch) => {
    expect(() => updatePlatform(platform, arch)).toThrow(`${platform}-${arch}`);
  });
});

describe('parseUpdate', () => {
  const answer = { url: URL, sha256hash: 'a'.repeat(64), productVersion: VERSION };

  it('returns the download and its SHA-256', () => {
    expect(parseUpdate(answer, VERSION)).toEqual({ url: URL, sha256: 'a'.repeat(64) });
  });

  it.each([
    ['another version', { ...answer, productVersion: '1.147.0' }],
    ['a download without https', { ...answer, url: 'http://example.com/code.tar.gz' }],
    ['no download', { ...answer, url: undefined }],
    ['no SHA-256', { ...answer, sha256hash: undefined }],
    ['a short SHA-256', { ...answer, sha256hash: 'abc' }],
    ['nothing', null],
  ])('refuses %s', (_name, bad) => {
    expect(() => parseUpdate(bad, VERSION)).toThrow();
  });
});

describe('ensureVscode', () => {
  let dir: string;
  let cache: string;
  let archive: Buffer;
  let fetched: string[];
  const name = `vscode-${VERSION}-${PLATFORM}`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vscode-test-'));
    cache = join(dir, 'cache');
    mkdirSync(join(dir, 'VSCode-linux'));
    writeFileSync(join(dir, 'VSCode-linux', 'code'), 'binary');
    const tar = spawnSync('tar', ['-czf', join(dir, 'code.tar.gz'), '-C', dir, 'VSCode-linux']);
    expect(tar.status).toBe(0);
    archive = readFileSync(join(dir, 'code.tar.gz'));
    fetched = [];
    vi.spyOn(console, 'log').mockReturnValue(undefined);
    serve(createHash('sha256').update(archive).digest('hex'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true });
  });

  function serve(sha256hash: string) {
    vi.stubGlobal('fetch', (url: string) => {
      fetched.push(url);
      return Promise.resolve(
        url === URL
          ? new Response(new Uint8Array(archive))
          : Response.json({ url: URL, sha256hash, productVersion: VERSION }),
      );
    });
  }

  it('downloads, checks and unpacks', async () => {
    expect(await ensureVscode(VERSION, cache)).toBe(join(cache, name));
    expect(readFileSync(join(cache, name, 'code'), 'utf8')).toBe('binary');
    expect(readdirSync(cache).sort()).toEqual([name, `${name}.tar.gz`]);
    expect(fetched).toEqual([
      `https://update.code.visualstudio.com/api/versions/${VERSION}/${PLATFORM}/stable`,
      URL,
    ]);
  });

  it('uses the unpacked directory without the network', async () => {
    mkdirSync(join(cache, name), { recursive: true });
    expect(await ensureVscode(VERSION, cache)).toBe(join(cache, name));
    expect(fetched).toEqual([]);
  });

  it('unpacks a cached archive with the right SHA-256 without a download', async () => {
    mkdirSync(cache);
    writeFileSync(join(cache, `${name}.tar.gz`), archive);
    await ensureVscode(VERSION, cache);
    expect(fetched).not.toContain(URL);
    expect(readFileSync(join(cache, name, 'code'), 'utf8')).toBe('binary');
  });

  it('downloads again if the cached archive has another SHA-256', async () => {
    mkdirSync(cache);
    writeFileSync(join(cache, `${name}.tar.gz`), 'changed');
    await ensureVscode(VERSION, cache);
    expect(fetched).toContain(URL);
    expect(readFileSync(join(cache, `${name}.tar.gz`))).toEqual(archive);
  });

  it('refuses a download with another SHA-256 and keeps nothing of it', async () => {
    serve('0'.repeat(64));
    await expect(ensureVscode(VERSION, cache)).rejects.toThrow('SHA-256');
    expect(readdirSync(cache)).toEqual([]);
  });

  it('fails on an HTTP error', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('no', { status: 404 })));
    await expect(ensureVscode(VERSION, cache)).rejects.toThrow('HTTP 404');
  });
});

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  describeFailure,
  ensureVscode,
  minimumVersion,
  parseUpdate,
  updatePlatform,
} from '../../scripts/vscode.mjs';

const VERSION = '1.146.0';
const URL = 'https://example.com/code.tar.gz';
const PLATFORM = 'linux-x64';
// The platform is injected: the tests must run off Linux, too, and never wait for a real retry delay.
const TARGET = { platform: 'linux', arch: 'x64', retryDelayMs: 0 };

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
    vi.spyOn(console, 'warn').mockReturnValue(undefined);
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
    expect(await ensureVscode(VERSION, cache, TARGET)).toBe(join(cache, name));
    expect(readFileSync(join(cache, name, 'code'), 'utf8')).toBe('binary');
    expect(readdirSync(cache).sort()).toEqual([name, `${name}.tar.gz`]);
    expect(fetched).toEqual([
      `https://update.code.visualstudio.com/api/versions/${VERSION}/${PLATFORM}/stable`,
      URL,
    ]);
  });

  it('uses the unpacked directory without the network', async () => {
    mkdirSync(join(cache, name), { recursive: true });
    expect(await ensureVscode(VERSION, cache, TARGET)).toBe(join(cache, name));
    expect(fetched).toEqual([]);
  });

  it('unpacks a cached archive with the right SHA-256 without a download', async () => {
    mkdirSync(cache);
    writeFileSync(join(cache, `${name}.tar.gz`), archive);
    await ensureVscode(VERSION, cache, TARGET);
    expect(fetched).not.toContain(URL);
    expect(readFileSync(join(cache, name, 'code'), 'utf8')).toBe('binary');
  });

  it('downloads again if the cached archive has another SHA-256', async () => {
    mkdirSync(cache);
    writeFileSync(join(cache, `${name}.tar.gz`), 'changed');
    await ensureVscode(VERSION, cache, TARGET);
    expect(fetched).toContain(URL);
    expect(readFileSync(join(cache, `${name}.tar.gz`))).toEqual(archive);
  });

  it('refuses a download with another SHA-256 and keeps nothing of it', async () => {
    serve('0'.repeat(64));
    await expect(ensureVscode(VERSION, cache, TARGET)).rejects.toThrow('SHA-256');
    expect(readdirSync(cache)).toEqual([]);
  });

  it('fails on an HTTP error', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('no', { status: 404 })));
    await expect(ensureVscode(VERSION, cache, TARGET)).rejects.toThrow('HTTP 404');
  });

  it('does not retry an HTTP error below 500', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response('no', { status: 404 })));
    vi.stubGlobal('fetch', fetch);
    await expect(ensureVscode(VERSION, cache, TARGET)).rejects.toThrow('HTTP 404');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a platform without a download', async () => {
    await expect(
      ensureVscode(VERSION, cache, { platform: 'darwin', arch: 'arm64' }),
    ).rejects.toThrow('darwin-arm64');
    expect(fetched).toEqual([]);
  });

  describe('with a flaky network', () => {
    const refused = () =>
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
          code: 'ECONNREFUSED',
        }),
      });

    /** The first calls fail the way `failures` says, then the normal answers follow. */
    function flaky(failures: (() => Promise<Response>)[]) {
      const normal = globalThis.fetch;
      const fetch = vi.fn((url: string) => {
        const failure = failures.shift();
        return failure ? failure() : normal(url);
      });
      vi.stubGlobal('fetch', fetch);
      return fetch;
    }

    it('tries a network error again, twice at most', async () => {
      const fetch = flaky([() => Promise.reject(refused()), () => Promise.reject(refused())]);
      expect(await ensureVscode(VERSION, cache, TARGET)).toBe(join(cache, name));
      expect(fetch).toHaveBeenCalledTimes(4);
    });

    it('tries a 5xx answer again', async () => {
      const fetch = flaky([() => Promise.resolve(new Response('busy', { status: 503 }))]);
      await ensureVscode(VERSION, cache, TARGET);
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('gives up after the third failure and names the URL and the cause', async () => {
      const fetch = flaky([
        () => Promise.reject(refused()),
        () => Promise.reject(refused()),
        () => Promise.reject(refused()),
      ]);
      const error = await ensureVscode(VERSION, cache, TARGET).catch((caught: unknown) => caught);
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        `GET https://update.code.visualstudio.com/api/versions/${VERSION}/${PLATFORM}/stable failed`,
      );
      expect(describeFailure(error)).toContain('ECONNREFUSED');
      expect(describeFailure(error)).toContain('connect ECONNREFUSED 127.0.0.1:443');
    });

    it('gives up after the third 5xx answer', async () => {
      const fetch = vi.fn(() => Promise.resolve(new Response('busy', { status: 502 })));
      vi.stubGlobal('fetch', fetch);
      await expect(ensureVscode(VERSION, cache, TARGET)).rejects.toThrow('HTTP 502');
      expect(fetch).toHaveBeenCalledTimes(3);
    });
  });
});

describe('describeFailure', () => {
  it('gives the message of a plain error', () => {
    expect(describeFailure(new Error('broken'))).toBe('broken');
  });

  it('follows the causes and shows their codes', () => {
    const inner = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    const outer = new Error('GET https://x.example: fetch failed', { cause: inner });
    expect(describeFailure(outer)).toBe(
      'GET https://x.example: fetch failed\ncaused by: ECONNREFUSED: refused',
    );
  });

  it('copes with a cause without message and with values that are no errors', () => {
    const aggregate = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' });
    expect(describeFailure(new Error('a', { cause: aggregate }))).toBe(
      'a\ncaused by: ECONNREFUSED',
    );
    expect(describeFailure('text')).toBe('text');
    expect(describeFailure(new Error('a', { cause: 'why' }))).toBe('a\ncaused by: why');
  });
});

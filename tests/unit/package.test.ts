import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPOSITORY = fileURLToPath(new URL('../..', import.meta.url));
const MANIFEST = 'node_modules/@vscode/vsce/package.json';

/** A step that writes down how it was started. */
const STEP = `const { appendFileSync } = process.getBuiltinModule('node:fs');
const call = { node: process.execPath, file: process.argv[1], args: process.argv.slice(2), cwd: process.cwd() };
appendFileSync(process.env.CALLS, JSON.stringify(call) + '\\n');
`;

describe('package.mjs', () => {
  let root: string;

  function write(name: string, text: string) {
    const file = join(root, name);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
    return file;
  }

  /** As in `npm run package`: node_modules/.bin is first on PATH. */
  function run() {
    const calls = join(root, 'calls');
    const path = [join(root, 'node_modules/.bin'), process.env.PATH].join(delimiter);
    const { status, stderr } = spawnSync(process.execPath, [join(root, 'scripts/package.mjs')], {
      cwd: tmpdir(),
      encoding: 'utf8',
      env: { ...process.env, PATH: path, CALLS: calls },
    });
    const lines = existsSync(calls) ? readFileSync(calls, 'utf8').trimEnd().split('\n') : [];
    return { status, stderr, calls: lines.map((line) => JSON.parse(line) as unknown) };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'package-'));
    mkdirSync(join(root, 'scripts'));
    copyFileSync(join(REPOSITORY, 'scripts/package.mjs'), join(root, 'scripts/package.mjs'));
    write('esbuild.mjs', STEP);
    write(MANIFEST, JSON.stringify({ bin: { other: 'other.js', vsce: 'bin/vsce.js' } }));
    write('node_modules/@vscode/vsce/bin/vsce.js', STEP);
    for (const name of ['node', 'vsce', 'sh', 'bash', 'npm', 'npx']) {
      chmodSync(
        write(`node_modules/.bin/${name}`, '#!/bin/sh\necho \'"planted"\' >> "$CALLS"\n'),
        0o755,
      );
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true });
  });

  it('starts esbuild.mjs and vsce by their path with its own Node, nothing from PATH', () => {
    const { status, stderr, calls } = run();
    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(calls).toEqual([
      { node: process.execPath, file: join(root, 'esbuild.mjs'), args: [], cwd: root },
      {
        node: process.execPath,
        file: join(root, 'node_modules/@vscode/vsce/bin/vsce.js'),
        args: ['package', '--no-dependencies'],
        cwd: root,
      },
    ]);
  });

  it('stops after a failed build', () => {
    write('esbuild.mjs', `${STEP}process.exit(3);`);
    const { status, stderr, calls } = run();
    expect(status).toBe(1);
    expect(stderr).toBe('esbuild.mjs failed (exit 3)\n');
    expect(calls).toHaveLength(1);
  });

  it('fails when vsce fails', () => {
    write('node_modules/@vscode/vsce/bin/vsce.js', 'process.exit(2);');
    const { status, stderr } = run();
    expect(status).toBe(1);
    expect(stderr).toBe('vsce failed (exit 2)\n');
  });

  it.each([{}, { bin: 'vsce' }, { bin: { other: 'other.js' } }])(
    'starts nothing when vsce has no command of that name: %j',
    (manifest) => {
      write(MANIFEST, JSON.stringify(manifest));
      const { status, stderr, calls } = run();
      expect(status).toBe(1);
      expect(stderr).toContain('@vscode/vsce has no command vsce');
      expect(calls).toEqual([]);
    },
  );

  it('starts nothing when vsce is not installed', () => {
    rmSync(join(root, 'node_modules/@vscode'), { recursive: true });
    const { status, calls } = run();
    expect(status).toBe(1);
    expect(calls).toEqual([]);
  });

  it('finds the command of the installed vsce', () => {
    const manifest = JSON.parse(readFileSync(join(REPOSITORY, MANIFEST), 'utf8')) as {
      bin: { vsce: string };
    };
    expect(existsSync(join(REPOSITORY, 'node_modules/@vscode/vsce', manifest.bin.vsce))).toBe(true);
  });
});

describe('release workflow', () => {
  const workflow = readFileSync(join(REPOSITORY, '.github/workflows/release-please.yml'), 'utf8');

  // `npm run` and `npx` put the commands of all installed packages first on PATH.
  it('builds and tests the .vsix without npm run', () => {
    const job = /\n {2}package:\n(.+?)\n {2}publish:\n/s.exec(workflow)?.[1] ?? '';
    const code = job.replaceAll(/^ *#.*$/gm, '');
    expect(code).toContain('node scripts/package.mjs');
    expect(code).toContain('node scripts/check-vsix.mjs');
    expect(code).toContain('node tests/smoke/run.mjs');
    expect(code).not.toMatch(/\b(npm|npx|node_modules)\b/);
  });
});

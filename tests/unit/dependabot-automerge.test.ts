import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decide, escapeCommand } from '../../scripts/dependabot-automerge.mjs';

const MINOR = 'version-update:semver-minor';
const PATCH = 'version-update:semver-patch';
const MAJOR = 'version-update:semver-major';

function dependency(dependencyName: string, updateType = MINOR, packageEcosystem = 'npm_and_yarn') {
  return { dependencyName, updateType, packageEcosystem };
}

describe('decide', () => {
  it.each([MINOR, PATCH])('merges a single allowed dependency (%s)', (type) => {
    expect(decide([dependency('eslint', type)])).toEqual({ automerge: true, reasons: [] });
  });

  it('merges a minor GitHub Actions update', () => {
    const update = dependency('actions/checkout', MINOR, 'github_actions');
    expect(decide([update]).automerge).toBe(true);
  });

  it.each(['esbuild', 'typescript', 'playwright-core'])('leaves %s open', (name) => {
    const { automerge, reasons } = decide([dependency(name, PATCH)]);
    expect(automerge).toBe(false);
    expect(reasons).toEqual([`${name} is always reviewed by hand`]);
  });

  it.each(['typescript-eslint', '@types/typescript', 'esbuild-plugin', 'playwright', 'x/esbuild'])(
    'matches names exactly: %s is merged',
    (name) => {
      expect(decide([dependency(name)]).automerge).toBe(true);
    },
  );

  it('merges a group of allowed dependencies', () => {
    const group = [dependency('eslint'), dependency('typescript-eslint', PATCH)];
    expect(decide(group)).toEqual({ automerge: true, reasons: [] });
  });

  it.each([0, 1, 2])('leaves a group open with one excluded name at position %i', (position) => {
    const group = [dependency('eslint'), dependency('vitest', PATCH)];
    group.splice(position, 0, dependency('esbuild', PATCH));
    const { automerge, reasons } = decide(group);
    expect(automerge).toBe(false);
    expect(reasons).toEqual(['esbuild is always reviewed by hand']);
  });

  it('leaves devcontainers open', () => {
    const name = 'ghcr.io/devcontainers/features/github-cli';
    const { automerge, reasons } = decide([dependency(name, PATCH, 'devcontainers')]);
    expect(automerge).toBe(false);
    expect(reasons).toEqual([`${name}: ecosystem devcontainers is not auto-merged`]);
  });

  it('leaves an ecosystem it does not know open', () => {
    expect(decide([dependency('x', PATCH, 'docker')]).automerge).toBe(false);
  });

  it('leaves a major update open', () => {
    const { automerge, reasons } = decide([dependency('eslint', MAJOR)]);
    expect(automerge).toBe(false);
    expect(reasons).toEqual([`eslint: ${MAJOR} is not a minor or patch update`]);
  });

  it('leaves a group open when one update is major or of unknown type', () => {
    expect(decide([dependency('eslint'), dependency('vitest', MAJOR)]).automerge).toBe(false);
    expect(decide([dependency('eslint'), dependency('vitest', '')]).reasons).toEqual([
      'vitest: unknown update type is not a minor or patch update',
    ]);
  });

  it('names every reason', () => {
    const { reasons } = decide([dependency('typescript', MAJOR), dependency('eslint', MAJOR)]);
    expect(reasons).toHaveLength(3);
  });

  it.each([[[]], [null], [{}], ['x'], [[null]], [[{}]], [[{ dependencyName: 'eslint' }]]])(
    'rejects metadata it cannot read: %j',
    (metadata) => {
      expect(() => decide(metadata)).toThrow();
    },
  );
});

describe('escapeCommand', () => {
  it('keeps text on one line, so it cannot start another workflow command', () => {
    expect(escapeCommand('a%\r\n::error::b')).toBe('a%25%0D%0A::error::b');
  });
});

describe('command line', () => {
  const script = fileURLToPath(new URL('../../scripts/dependabot-automerge.mjs', import.meta.url));

  function run(metadata: string) {
    const dir = mkdtempSync(join(tmpdir(), 'automerge-'));
    const output = join(dir, 'output');
    try {
      const { status, stdout } = spawnSync(process.execPath, [script], {
        encoding: 'utf8',
        env: { UPDATED_DEPENDENCIES: metadata, GITHUB_OUTPUT: output },
      });
      let written = '';
      try {
        written = readFileSync(output, 'utf8');
      } catch {
        // Nothing written.
      }
      return { status, stdout, written };
    } finally {
      rmSync(dir, { recursive: true });
    }
  }

  it('writes the decision and logs why a PR is not auto-merged', () => {
    const result = run(JSON.stringify([dependency('eslint'), dependency('typescript', PATCH)]));
    expect(result.status).toBe(0);
    expect(result.written).toBe('automerge=false\n');
    expect(result.stdout).toBe(
      '::notice::Not auto-merged: typescript is always reviewed by hand\n',
    );
  });

  it('writes the decision to merge', () => {
    const result = run(JSON.stringify([dependency('eslint')]));
    expect(result.status).toBe(0);
    expect(result.written).toBe('automerge=true\n');
    expect(result.stdout).toBe('::notice::Auto-merge after the required checks: eslint\n');
  });

  it.each(['', 'not json', '[]'])('fails on metadata %j and decides nothing', (metadata) => {
    const result = run(metadata);
    expect(result.status).toBe(1);
    expect(result.written).toBe('');
  });
});

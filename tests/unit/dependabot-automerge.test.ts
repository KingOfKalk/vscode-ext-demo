import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  commitReasons,
  decide,
  dependencyReasons,
  escapeCommand,
  MANUAL_DEPENDENCIES,
} from '../../scripts/dependabot-automerge.mjs';

const MINOR = 'version-update:semver-minor';
const PATCH = 'version-update:semver-patch';
const MAJOR = 'version-update:semver-major';

function dependency(dependencyName: string, updateType = MINOR, packageEcosystem = 'npm_and_yarn') {
  return { dependencyName, updateType, packageEcosystem };
}

const HEAD = 'a'.repeat(40);

/** As in the GitHub API: Dependabot commits are committed and signed by GitHub (web-flow). */
function commit(sha = HEAD, author = 'dependabot[bot]', verified = true, committer = 'web-flow') {
  return {
    sha,
    author: { login: author },
    committer: { login: committer },
    commit: { verification: { verified } },
  };
}

describe('dependencyReasons', () => {
  it.each([MINOR, PATCH])('merges a single allowed dependency (%s)', (type) => {
    expect(dependencyReasons([dependency('eslint', type)])).toEqual([]);
  });

  it('merges a minor GitHub Actions update', () => {
    const update = dependency('actions/checkout', MINOR, 'github_actions');
    expect(dependencyReasons([update])).toEqual([]);
  });

  it.each(['esbuild', 'typescript', '@vscode/vsce', 'playwright-core'])(
    'leaves the package %s open',
    (name) => {
      const reasons = dependencyReasons([dependency(name, PATCH)]);
      expect(reasons).toEqual([`${name} is always reviewed by hand`]);
    },
  );

  it.each([
    'actions/create-github-app-token',
    'actions/download-artifact',
    'dependabot/fetch-metadata',
    'googleapis/release-please-action',
  ])('leaves the action %s open', (name) => {
    expect(dependencyReasons([dependency(name, PATCH, 'github_actions')])).toEqual([
      `${name} is always reviewed by hand`,
    ]);
  });

  it.each(['actions/upload-artifact', 'actions/setup-node', 'other/download-artifact'])(
    'merges the action %s',
    (name) => {
      expect(dependencyReasons([dependency(name, PATCH, 'github_actions')])).toEqual([]);
    },
  );

  it('has the excluded names outside the Dependabot groups too', () => {
    const config = readFileSync(new URL('../../.github/dependabot.yml', import.meta.url), 'utf8');
    const excluded = [...config.matchAll(/exclude-patterns:\n((?: +- .+\n)+)/g)].flatMap((block) =>
      [...(block[1] ?? '').matchAll(/- '?([^'\n]+)'?\n/g)].map((line) => line[1]),
    );
    expect(excluded.sort()).toEqual([...MANUAL_DEPENDENCIES].sort());
  });

  it.each([
    'typescript-eslint',
    '@types/typescript',
    'esbuild-plugin',
    'playwright',
    'x/esbuild',
    'vsce',
  ])('matches names exactly: %s is merged', (name) => {
    expect(dependencyReasons([dependency(name)])).toEqual([]);
  });

  it('merges a group of allowed dependencies', () => {
    const group = [dependency('eslint'), dependency('typescript-eslint', PATCH)];
    expect(dependencyReasons(group)).toEqual([]);
  });

  it.each([0, 1, 2])('leaves a group open with one excluded name at position %i', (position) => {
    const group = [dependency('eslint'), dependency('vitest', PATCH)];
    group.splice(position, 0, dependency('esbuild', PATCH));
    const reasons = dependencyReasons(group);
    expect(reasons).toEqual(['esbuild is always reviewed by hand']);
  });

  it('leaves devcontainers open', () => {
    const name = 'ghcr.io/devcontainers/features/github-cli';
    const reasons = dependencyReasons([dependency(name, PATCH, 'devcontainers')]);
    expect(reasons).toEqual([`${name}: ecosystem devcontainers is not auto-merged`]);
  });

  it('leaves an ecosystem it does not know open', () => {
    expect(dependencyReasons([dependency('x', PATCH, 'docker')])).toHaveLength(1);
  });

  it('leaves a major update open', () => {
    const reasons = dependencyReasons([dependency('eslint', MAJOR)]);
    expect(reasons).toEqual([`eslint: ${MAJOR} is not a minor or patch update`]);
  });

  it('leaves a group open when one update is major or of unknown type', () => {
    expect(dependencyReasons([dependency('eslint'), dependency('vitest', MAJOR)])).toHaveLength(1);
    expect(dependencyReasons([dependency('eslint'), dependency('vitest', '')])).toEqual([
      'vitest: unknown update type is not a minor or patch update',
    ]);
  });

  it('names every reason', () => {
    const reasons = dependencyReasons([
      dependency('typescript', MAJOR),
      dependency('eslint', MAJOR),
    ]);
    expect(reasons).toHaveLength(3);
  });

  it.each([[[]], [null], [{}], ['x'], [[null]], [[{}]], [[{ dependencyName: 'eslint' }]]])(
    'rejects metadata it cannot read: %j',
    (metadata) => {
      expect(() => dependencyReasons(metadata)).toThrow();
    },
  );
});

describe('commitReasons', () => {
  const OTHER = 'b'.repeat(40);

  it('accepts a single verified Dependabot commit', () => {
    expect(commitReasons([[commit()]], HEAD)).toEqual([]);
  });

  it('accepts several verified Dependabot commits on several pages', () => {
    expect(commitReasons([[commit(OTHER)], [commit()]], HEAD)).toEqual([]);
  });

  it('rejects a second commit by a human, also a verified one', () => {
    expect(commitReasons([[commit(OTHER), commit(HEAD, 'someone')]], HEAD)).toEqual([
      'commit aaaaaaa is by someone, not by Dependabot',
    ]);
  });

  it('rejects a commit by a human on a later page', () => {
    const pages = [[commit(OTHER)], [commit('c'.repeat(40), 'someone'), commit()]];
    expect(commitReasons(pages, HEAD)).toEqual(['commit ccccccc is by someone, not by Dependabot']);
  });

  it('rejects an unverified commit', () => {
    expect(commitReasons([[commit(HEAD, 'dependabot[bot]', false)]], HEAD)).toEqual([
      'commit aaaaaaa has no verified signature',
    ]);
  });

  // The author is free text in git; the signature belongs to the committer.
  it('rejects a commit that names Dependabot as author but is signed by someone else', () => {
    expect(commitReasons([[commit(HEAD, 'dependabot[bot]', true, 'someone')]], HEAD)).toEqual([
      'commit aaaaaaa is committed by someone, not by GitHub',
    ]);
  });

  it('rejects a commit without a known author, committer or verification', () => {
    const unknown = { sha: HEAD, author: null, committer: null, commit: {} };
    expect(commitReasons([[unknown]], HEAD)).toHaveLength(3);
  });

  it('rejects a list without the head commit, for example one cut off by the API', () => {
    expect(commitReasons([[commit(OTHER)]], HEAD)).toEqual([
      'commit aaaaaaa, the head of the pull request, is not in the commit list',
    ]);
  });

  it.each([[null], [{}], [[]], [[[]]], [[commit()]], [[[null]]], [[[{}]]]])(
    'rejects the list %j',
    (pages) => {
      expect(() => commitReasons(pages, HEAD)).toThrow();
    },
  );

  it('rejects an empty head', () => {
    expect(() => commitReasons([[commit()]], '')).toThrow();
  });
});

describe('decide', () => {
  it('merges allowed dependencies in Dependabot commits', () => {
    expect(decide([dependency('eslint')], [[commit()]], HEAD)).toEqual({
      automerge: true,
      reasons: [],
    });
  });

  it('gives the reasons of the dependencies and of the commits', () => {
    const { automerge, reasons } = decide(
      [dependency('esbuild')],
      [[commit(HEAD, 'someone')]],
      HEAD,
    );
    expect(automerge).toBe(false);
    expect(reasons).toHaveLength(2);
  });

  it('leaves allowed dependencies with a foreign commit open', () => {
    const pages = [[commit('b'.repeat(40)), commit(HEAD, 'someone')]];
    expect(decide([dependency('eslint')], pages, HEAD).automerge).toBe(false);
  });
});

describe('escapeCommand', () => {
  it('keeps text on one line, so it cannot start another workflow command', () => {
    expect(escapeCommand('a%\r\n::error::b')).toBe('a%25%0D%0A::error::b');
  });
});

describe('command line', () => {
  const script = fileURLToPath(new URL('../../scripts/dependabot-automerge.mjs', import.meta.url));

  function run(metadata: string, commits = JSON.stringify([[commit()]])) {
    const dir = mkdtempSync(join(tmpdir(), 'automerge-'));
    const output = join(dir, 'output');
    const commitsFile = join(dir, 'commits.json');
    try {
      writeFileSync(commitsFile, commits);
      const { status, stdout } = spawnSync(process.execPath, [script], {
        encoding: 'utf8',
        env: {
          UPDATED_DEPENDENCIES: metadata,
          COMMITS_FILE: commitsFile,
          HEAD_SHA: HEAD,
          GITHUB_OUTPUT: output,
        },
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

  it('does not merge with a foreign commit', () => {
    const commits = JSON.stringify([[commit('b'.repeat(40))], [commit(HEAD, 'x\n::error::y')]]);
    const result = run(JSON.stringify([dependency('eslint')]), commits);
    expect(result.status).toBe(0);
    expect(result.written).toBe('automerge=false\n');
    expect(result.stdout).toBe(
      '::notice::Not auto-merged: commit aaaaaaa is by x%0A::error::y, not by Dependabot\n',
    );
  });

  it.each(['', 'not json', '[]', '[[]]'])('fails on commits %j and decides nothing', (commits) => {
    const result = run(JSON.stringify([dependency('eslint')]), commits);
    expect(result.status).toBe(1);
    expect(result.written).toBe('');
  });

  it.each(['', 'not json', '[]'])('fails on metadata %j and decides nothing', (metadata) => {
    const result = run(metadata);
    expect(result.status).toBe(1);
    expect(result.written).toBe('');
  });
});

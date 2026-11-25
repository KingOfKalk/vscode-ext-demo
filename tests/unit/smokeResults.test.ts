import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderTestSummary } from '../../scripts/ci-summary.mjs';
import {
  hostProblems,
  LOGS,
  problems,
  readLog,
  toReport,
  type CheckResult,
} from '../smoke/results.mjs';

const at = (time: string, text: string) => `2026-11-24 22:15:${time} ${text}`;

describe('readLog', () => {
  let profile: string;

  beforeEach(() => {
    profile = mkdtempSync(join(tmpdir(), 'smoke-'));
  });

  afterEach(() => {
    rmSync(profile, { recursive: true });
  });

  it('is empty without a log', () => {
    expect(readLog(profile, LOGS.host)).toBe('');
  });

  it('finds the log of the run', () => {
    const dir = join(profile, 'logs/20261124T221540/window1/exthost');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'exthost.log'), 'text\n');
    expect(readLog(profile, LOGS.host)).toBe('text\n');
    expect(readLog(profile, LOGS.demo)).toBe('');
  });
});

describe('problems', () => {
  it('is empty without errors and warnings', () => {
    const log = [
      at('43.382', '[info] Extension activated, count 0'),
      at('43.400', '[info] Settings changed: {"message":"[error] no"}'),
      '',
    ].join('\n');
    expect(problems(log)).toEqual([]);
  });

  it('returns errors and warnings with the lines that belong to them', () => {
    const error = `${at('44.000', '[error] Error: boom')}\n\tat a.js:1:1`;
    const warning = at('45.000', '[warning] Ignoring unknown webview message: 1');
    const log = [at('43.000', '[info] a'), error, at('44.500', '[info] b'), warning, ''].join('\n');
    expect(problems(log)).toEqual([error, warning]);
  });
});

describe('hostProblems', () => {
  const end = at('50.735', '[info] Extension host terminating: received terminate message');
  const ours = `${at('44.000', '[error] Error: boom')}\n\tat /tmp/vsx-a/extensions/kingofkalk.vscode-ext-demo-0.0.0/dist/extension.js:1:1`;
  const oursWarning = at('44.000', '[warning] [kingofkalk.vscode-ext-demo] Accessing a resource');
  const unknown = at('44.000', '[error] Error: boom');
  const builtIn = `${at('44.000', '[error] Error: x')}\n\tat /c/resources/app/extensions/git/dist/main.js:1:1`;
  const builtInWarning = at('44.000', '[warning] [vscode.git] Accessing a resource');

  it.each([
    ['an error with a file of the extension', ours],
    ['a warning about the extension', oursWarning],
    ['an error from an unknown place', unknown],
    ['an error through a built-in extension', `${builtIn}\n\tat ${ours}`],
  ])('reports %s', (_name, entry) => {
    expect(hostProblems([at('43.000', '[info] a'), entry, end].join('\n'))).toEqual([entry]);
  });

  it.each([
    ['an error of a built-in extension', builtIn],
    ['a warning of a built-in extension', builtInWarning],
    [
      'the warning about the suite',
      [
        at(
          '44.000',
          "[warning] Could not identify extension for 'vscode' require call from file:///tmp/vsx-a/driver/suite.js. These are the extension path mappings: ",
        ),
        '\tfile:///tmp/vsx-a/extensions/kingofkalk.vscode-ext-demo-0.0.0 -> kingofkalk.vscode-ext-demo',
      ].join('\n'),
    ],
  ])('ignores %s', (_name, entry) => {
    expect(hostProblems([entry, end].join('\n'))).toEqual([]);
  });

  it('while VS Code ends, reports only what names the extension', () => {
    expect(hostProblems([end, unknown].join('\n'))).toEqual([]);
    expect(hostProblems([end, ours].join('\n'))).toEqual([ours]);
  });
});

describe('toReport', () => {
  const results: CheckResult[] = [
    { name: 'a works', status: 'passed' },
    { name: 'b works', status: 'failed', error: 'AssertionError: nope' },
    { name: 'c works', status: 'running' },
    { name: 'd works', status: 'pending' },
  ];

  it('is a report that ci-summary.mjs renders', () => {
    const out = renderTestSummary(toReport(results, '', 1000, 3500), '/repo', 'failure', 'Smoke');
    expect(out).toContain('## Smoke\n');
    expect(out).toContain('| Passed | 1 |');
    expect(out).toContain('| Failed | 2 |');
    expect(out).toContain('| Skipped | 1 |');
    expect(out).toContain('| Total | 4 |');
    expect(out).toContain('Duration: 2.50 s');
    expect(out).toContain('#### tests/smoke/suite.ts › b works\n\n```text\nAssertionError: nope');
    expect(out).toContain('#### tests/smoke/suite.ts › c works\n\n```text\ndid not finish');
    expect(out).not.toContain('a works');
  });

  it('has a problem outside the checks', () => {
    const report = toReport([{ name: 'a works', status: 'passed' }], 'VS Code ended', 0, 1);
    const out = renderTestSummary(report, '/repo', 'failure');
    expect(out).toContain('#### tests/smoke/suite.ts\n\n```text\nVS Code ended\n```');
  });

  it('has no failures if all is well', () => {
    const report = toReport([{ name: 'a works', status: 'passed' }], '', 0, 1);
    expect(report.testResults[0]?.status).toBe('passed');
    expect(renderTestSummary(report, '/repo', 'success')).not.toContain('Failed tests');
  });
});

import { describe, expect, it } from 'vitest';
import type { Report } from '../smoke/helper';
import { checkStart } from '../smoke/restart.mjs';

const MESSAGE = 'Hello';
const window = (count: number) => [{ message: MESSAGE, count: String(count), styled: true }];
const at = (text: string) => `2026-11-26 08:51:00.955 ${text}`;
const demoLog = `${at('[info] Extension activated, count 3')}\n`;
const hostLog = `${at('[info] Extension host terminating: received terminate message')}\n`;
const start = (report: Report | undefined, more: Partial<Parameters<typeof checkStart>[1]> = {}) =>
  ({ ending: 'exit 0', report, demoLog, hostLog, ...more }) as const;

describe('checkStart', () => {
  it.each<[Parameters<typeof checkStart>[0], Report]>([
    ['count', { count: 3, windows: window(3), tabs: 1 }],
    ['restore', { count: 3, windows: window(3), tabs: 1 }],
    ['hidden', { count: 3, restoredHidden: true, windows: window(3), tabs: 1 }],
    ['other', { count: 0, windows: [], tabs: 0 }],
  ])('passes %s when it shows what it must', (name, report) => {
    expect(checkStart(name, start(report), MESSAGE)).toEqual([]);
  });

  it('reports what differs', () => {
    const report = { count: 0, windows: window(0), tabs: 1 };
    expect(checkStart('restore', start(report), MESSAGE)).toEqual([
      'count: expected 3, got 0',
      `windows: expected ${JSON.stringify(window(3))}, got ${JSON.stringify(window(0))}`,
    ]);
  });

  it('reports a window that VS Code restored behind a tab, but that was not there', () => {
    const report = { count: 3, windows: window(3), tabs: 1 };
    expect(checkStart('hidden', start(report), MESSAGE)).toEqual([
      'restoredHidden: expected true, got undefined',
    ]);
  });

  it('reports a window that the extension replaced instead of adopting it', () => {
    const replaced = at('[info] Replacing a window that lost its extension host');
    const report = { count: 3, windows: window(3), tabs: 1 };
    expect(
      checkStart('restore', start(report, { demoLog: `${demoLog}${replaced}\n` }), MESSAGE),
    ).toEqual([`Not adopted: ${replaced}`]);
  });

  it('reports how VS Code ended, a missing report and missing logs', () => {
    expect(
      checkStart('count', start(undefined, { ending: 'SIGKILL', demoLog: '', hostLog: '' }), ''),
    ).toEqual([
      'VS Code ended with SIGKILL.',
      'The helper wrote no report.',
      'There is no Demo log.',
      'There is no extension host log.',
    ]);
  });

  it('reports an error of the helper and problems in the logs', () => {
    const warning = at('[warning] Could not post to the window: gone');
    const report = { error: 'Error: boom', count: 0, windows: [], tabs: 0 };
    expect(checkStart('other', start(report, { demoLog: `${warning}\n` }), MESSAGE)).toEqual([
      'Error: boom',
      `Demo log: ${warning}`,
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  describeArguments,
  describeLogEntry,
  formatConsoleEntries,
  formatConsoleEntry,
  type ConsoleEntry,
} from '../../../scripts/live/webviewConsole.ts';

const T = new Date(2026, 10, 25, 7, 35, 14, 851).getTime();

describe('describeArguments', () => {
  it('joins values, descriptions and types', () => {
    expect(
      describeArguments([
        { type: 'string', value: 'boom' },
        { type: 'number', value: 3 },
        { type: 'object', description: 'Error: x\n    at f (a.js:1:1)' },
        { type: 'undefined' },
      ]),
    ).toBe('boom 3 Error: x\n    at f (a.js:1:1) undefined');
  });

  it('shows false and 0 and an empty text', () => {
    expect(
      describeArguments([
        { type: 'boolean', value: false },
        { type: 'number', value: 0 },
        { type: 'string', value: '' },
      ]),
    ).toBe('false 0 ');
  });

  it('has nothing for no arguments', () => {
    expect(describeArguments([])).toBe('');
  });
});

describe('formatConsoleEntry', () => {
  it('prints the time, the kind and the text', () => {
    const entry: ConsoleEntry = { time: T, kind: 'console.error', text: 'boom' };
    expect(formatConsoleEntry(entry)).toBe('2026-11-25 07:35:14.851 [console.error] boom');
  });

  it('keeps the indentation of a stack and indents the other lines of a message', () => {
    const entry: ConsoleEntry = {
      time: T,
      kind: 'exception',
      text: 'Error: x\n    at f (a.js:1:1)\nsecond line',
    };
    expect(formatConsoleEntry(entry).split('\n')).toEqual([
      '2026-11-25 07:35:14.851 [exception] Error: x',
      '    at f (a.js:1:1)',
      '    second line',
    ]);
  });

  it('cuts a very long line', () => {
    const text = 'x'.repeat(1000);
    const line = formatConsoleEntry({ time: T, kind: 'console.error', text });
    expect(line).toBe(
      `2026-11-25 07:35:14.851 [console.error] ${'x'.repeat(300)}... (700 more characters)`,
    );
  });

  it('cuts a very long stack', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const lines = formatConsoleEntry({ time: T, kind: 'exception', text }).split('\n');
    expect(lines).toHaveLength(8);
    expect(lines.at(-1)).toBe('    ... 23 more lines');
  });
});

describe('formatConsoleEntries', () => {
  it('says none if there is none', () => {
    expect(formatConsoleEntries([])).toBe('== Webview console errors: none');
  });

  it('lists them in time order, at most the last `limit`', () => {
    const entries: ConsoleEntry[] = [
      { time: T + 2, kind: 'console.error', text: 'second' },
      { time: T, kind: 'console.error', text: 'first' },
      { time: T + 3, kind: 'exception', text: 'third' },
    ];
    const text = formatConsoleEntries(entries, 2);
    expect(text.split('\n')).toEqual([
      '== Webview console errors (last 2 of 3)',
      '2026-11-25 07:35:14.853 [console.error] second',
      '2026-11-25 07:35:14.854 [exception] third',
    ]);
  });
});

describe('describeLogEntry', () => {
  const entry = {
    source: 'security',
    level: 'error',
    text: 'Loading the stylesheet',
    timestamp: T,
  };

  it('takes an error of the browser, such as a stylesheet that the CSP blocks', () => {
    expect(describeLogEntry({ ...entry, url: 'https://x.test/a.css' })).toEqual({
      time: T,
      kind: 'log.security',
      text: 'Loading the stylesheet (https://x.test/a.css)',
    });
  });

  it('does not repeat an address that the text has', () => {
    const found = describeLogEntry({
      ...entry,
      text: 'Refused https://x.test/a.css',
      url: 'https://x.test/a.css',
    });
    expect(found?.text).toBe('Refused https://x.test/a.css');
  });

  it('leaves out what is not an error, and what the console and exceptions tell already', () => {
    expect(describeLogEntry({ ...entry, level: 'warning' })).toBeUndefined();
    expect(describeLogEntry({ ...entry, level: 'info' })).toBeUndefined();
    expect(describeLogEntry({ ...entry, source: 'javascript' })).toBeUndefined();
    expect(describeLogEntry({ ...entry, source: 'console-api' })).toBeUndefined();
  });
});

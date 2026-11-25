import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatSection,
  isActivated,
  isNewActivation,
  lastLines,
  listRuns,
  readActivations,
  runLogs,
  selectRun,
} from '../../../scripts/live/logs.ts';

const ID = 'kingofkalk.vscode-ext-demo';
const ACTIVATED = '2026-11-25 06:37:43.100 [info] Extension activated, count 0\n';

describe('selectRun', () => {
  const host = (run: string) => `${run}/window1/exthost/exthost.log`;

  it('ignores the runs from before', () => {
    expect(selectRun(['1'], [host('1')])).toBeUndefined();
    expect(selectRun(['1'], [host('1'), host('2')])).toBe('2');
  });

  it('ignores a run without a window: the command line logs, too', () => {
    expect(selectRun([], ['2/cli.log', host('3')])).toBe('3');
    expect(selectRun([], [host('2'), '3/cli.log'])).toBe('2');
    expect(selectRun([], ['2/cli.log'])).toBeUndefined();
  });

  it('takes the latest of several', () => {
    expect(selectRun([], [host('20261125T063742'), host('20261125T063741')])).toBe(
      '20261125T063742',
    );
  });
});

describe('isActivated', () => {
  let logs: string;

  beforeEach(() => {
    logs = mkdtempSync(join(tmpdir(), 'logs-'));
  });

  afterEach(() => {
    rmSync(logs, { recursive: true });
  });

  function write(file: string, text: string): void {
    mkdirSync(dirname(join(logs, file)), { recursive: true });
    writeFileSync(join(logs, file), text);
  }

  const demo = (run: string) => `${run}/window1/exthost/${ID}/Demo.log`;

  it('needs a run', () => {
    expect(listRuns(join(logs, 'missing'))).toEqual([]);
    expect(isActivated(join(logs, 'missing'), [], ID)).toBe(false);
    expect(isActivated(logs, [], ID)).toBe(false);
  });

  it('does not take the line of an old run for the new one', () => {
    write(demo('1'), ACTIVATED);
    const before = listRuns(logs);
    expect(isActivated(logs, before, ID)).toBe(false);
    write('2/window1/exthost/exthost.log', '');
    expect(isActivated(logs, before, ID)).toBe(false);
    write(demo('2'), '');
    expect(isActivated(logs, before, ID)).toBe(false);
    write(demo('2'), ACTIVATED);
    expect(isActivated(logs, before, ID)).toBe(true);
  });

  it('finds the window next to a run of the command line', () => {
    const before = listRuns(logs);
    write('2/cli.log', '');
    write(demo('3'), ACTIVATED);
    write('4/cli.log', '');
    expect(isActivated(logs, before, ID)).toBe(true);
  });

  it('takes the run of the window if the command line logged in the same second', () => {
    write('2/cli.log', '');
    const before = listRuns(logs);
    write(demo('2'), ACTIVATED);
    expect(isActivated(logs, before, ID)).toBe(true);
  });

  it('names the logs of the run', () => {
    write('1/window1/exthost/exthost.log', '');
    expect(runLogs(logs, [], ID)).toEqual({
      demo: join(logs, demo('1')),
      host: join(logs, '1/window1/exthost/exthost.log'),
    });
    expect(runLogs(logs, ['1'], ID)).toBeUndefined();
  });
});

describe('lastLines', () => {
  it('takes the last lines and drops a final newline', () => {
    expect(lastLines('a\nb\nc\n', 2)).toEqual(['b', 'c']);
    expect(lastLines('a\nb', 5)).toEqual(['a', 'b']);
  });

  it('has no lines for an empty text', () => {
    expect(lastLines('', 5)).toEqual([]);
    expect(lastLines('\n\n', 5)).toEqual([]);
  });

  it('keeps blank lines in the middle', () => {
    expect(lastLines('a\n\nb\n', 3)).toEqual(['a', '', 'b']);
  });

  it('takes the number as it is, 0 gives nothing', () => {
    expect(lastLines('a\nb', 0)).toEqual([]);
  });
});

describe('formatSection', () => {
  it('prints a title and the lines', () => {
    expect(formatSection('Demo log', 'x/Demo.log', 'a\nb\nc\n', 2)).toBe(
      '== Demo log (x/Demo.log, last 2 of 3 lines)\nb\nc',
    );
  });

  it('says how many lines there are if all are shown', () => {
    expect(formatSection('Demo log', 'x', 'a\nb\n', 40)).toBe('== Demo log (x, 2 lines)\na\nb');
    expect(formatSection('Demo log', 'x', 'a\n', 40)).toBe('== Demo log (x, 1 line)\na');
  });

  it('says what is missing and which file it would be', () => {
    expect(formatSection('Demo log', 'x/Demo.log', undefined, 40)).toBe(
      '== Demo log: missing (x/Demo.log)',
    );
  });

  it('says that an empty log is empty', () => {
    expect(formatSection('Demo log', 'x', '', 40)).toBe('== Demo log: empty (x)');
  });
});

describe('activations', () => {
  const demo = (run: string) => `${run}/window1/exthost/${ID}/Demo.log`;
  let logs: string;

  beforeEach(() => {
    logs = mkdtempSync(join(tmpdir(), 'logs-'));
  });

  afterEach(() => {
    rmSync(logs, { recursive: true });
  });

  function write(file: string, text: string): void {
    mkdirSync(dirname(join(logs, file)), { recursive: true });
    writeFileSync(join(logs, file), text);
  }

  it('counts the activations of the newest run', () => {
    expect(readActivations(join(logs, 'missing'), ID)).toEqual({ run: undefined, count: 0 });
    write(demo('1'), ACTIVATED + ACTIVATED);
    write(demo('2'), ACTIVATED);
    expect(readActivations(logs, ID)).toEqual({
      run: '2',
      count: 1,
      last: '2026-11-25 06:37:43.100 [info] Extension activated, count 0',
    });
  });

  it('has a run without the Demo log', () => {
    write('1/window1/exthost/exthost.log', '');
    expect(readActivations(logs, ID)).toEqual({ run: '1', count: 0 });
  });

  const was = { run: '1', count: 1 };

  it('sees a second activation in the same run: a reload keeps the run', () => {
    expect(isNewActivation(was, { run: '1', count: 1 })).toBe(false);
    expect(isNewActivation(was, { run: '1', count: 2 })).toBe(true);
  });

  it('sees an activation in a newer run', () => {
    expect(isNewActivation(was, { run: '2', count: 0 })).toBe(false);
    expect(isNewActivation(was, { run: '2', count: 1 })).toBe(true);
  });

  it('sees one if the log was made new and has fewer lines than before', () => {
    expect(isNewActivation({ run: '1', count: 3 }, { run: '1', count: 1 })).toBe(true);
    expect(isNewActivation({ run: '1', count: 3 }, { run: '1', count: 0 })).toBe(false);
  });

  it('takes the first activation after a start without one', () => {
    expect(isNewActivation({ run: undefined, count: 0 }, { run: '1', count: 1 })).toBe(true);
  });
});

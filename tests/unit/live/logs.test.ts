import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isActivated, listRuns, runLogs, selectRun } from '../../../scripts/live/logs.ts';

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

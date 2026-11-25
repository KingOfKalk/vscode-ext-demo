import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  completeLines,
  decideActivation,
  HOST_RESTART_GRACE_MS,
  noActivationKind,
  formatSection,
  hasActivationFailed,
  hasHostTerminated,
  isActivated,
  isNewActivation,
  lastErrorBlock,
  lastLines,
  linesAfter,
  listRuns,
  parseSettingsLine,
  readActivations,
  runLogs,
  selectRun,
  settingsLines,
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
      renderer: join(logs, '1/window1/renderer.log'),
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

describe('the log lines that count', () => {
  it('counts only the line of the extension, not a message that has the words', () => {
    const logs = mkdtempSync(join(tmpdir(), 'logs-'));
    try {
      const file = join(logs, `1/window1/exthost/${ID}/Demo.log`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        '2026-11-25 07:00:00.000 [info] Webview message: Extension activated, count 7\n' +
          '2026-11-25 07:00:01.000 [error] Problem: [info] Extension activated, count 8\n',
      );
      expect(readActivations(logs, ID)).toEqual({ run: '1', count: 0 });
      expect(isActivated(logs, [], ID)).toBe(false);
      writeFileSync(file, `${ACTIVATED}`);
      expect(readActivations(logs, ID).count).toBe(1);
    } finally {
      rmSync(logs, { recursive: true });
    }
  });

  it('reads the settings from the line of a change, and only from that', () => {
    const line = '2026-11-25 07:40:52.283 [info] Settings changed: {"message":"Hi","step":5}';
    expect(parseSettingsLine(line)).toEqual({ message: 'Hi', step: 5 });
    expect(
      parseSettingsLine(
        '2026-11-25 07:40:52.283 [info] Webview message: Settings changed: {"a":1}',
      ),
    ).toBeUndefined();
    expect(
      parseSettingsLine('2026-11-25 07:40:52.283 [info] Settings changed: not json'),
    ).toBeUndefined();
    expect(
      parseSettingsLine('2026-11-25 07:40:52.283 [info] Settings changed: [1]'),
    ).toBeUndefined();
  });

  it('finds the lines of the changes', () => {
    const text = [
      '2026-11-25 07:40:51.000 [info] Extension activated, count 0',
      '2026-11-25 07:40:52.000 [info] Settings changed: {"step":1}',
      '2026-11-25 07:40:53.000 [info] Webview message: Settings changed: {"step":2}',
      '2026-11-25 07:40:54.000 [info] Settings changed: {"step":3}',
    ].join('\n');
    expect(settingsLines(text)).toEqual([
      '2026-11-25 07:40:52.000 [info] Settings changed: {"step":1}',
      '2026-11-25 07:40:54.000 [info] Settings changed: {"step":3}',
    ]);
  });
});

describe('lastErrorBlock', () => {
  const T = '2026-11-25 08:04:59.477';
  const log = [
    `${T} [info] one`,
    `${T} [error] Activating extension x failed due to an error:`,
    `${T} [error] Error: test hook`,
    '\tat activate (a.js:1:1)',
    '\tat b (b.js:2:2)',
    `${T} [info] after`,
  ].join('\n');

  it('takes the error lines in a row and the stack under them, not what comes after', () => {
    expect(lastErrorBlock(log, 10)?.split('\n')).toEqual([
      `${T} [error] Activating extension x failed due to an error:`,
      `${T} [error] Error: test hook`,
      '\tat activate (a.js:1:1)',
      '\tat b (b.js:2:2)',
    ]);
  });

  it('cuts a long stack', () => {
    expect(lastErrorBlock(log, 3)?.split('\n').at(-1)).toBe('... 1 more lines');
  });

  it('takes the last of several errors', () => {
    const text = `${T} [error] first\n${T} [info] x\n${T} [error] second`;
    expect(lastErrorBlock(text, 5)).toBe(`${T} [error] second`);
  });

  it('is undefined without an error; a word in a message is no error line', () => {
    expect(lastErrorBlock(`${T} [info] [error] not one`, 5)).toBeUndefined();
    expect(lastErrorBlock('', 5)).toBeUndefined();
  });
});

describe('hasActivationFailed', () => {
  const T = '2026-11-25 11:29:19.679';
  const failed = `${T} [error] Activating extension ${ID} failed due to an error:`;

  it('finds the line of the extension host', () => {
    expect(hasActivationFailed(`${T} [info] one\n${failed}\n${T} [error] Error: x\n`, ID)).toBe(
      true,
    );
  });

  it('is false for a log without it', () => {
    expect(hasActivationFailed('', ID)).toBe(false);
    expect(hasActivationFailed(`${T} [info] Extension activated, count 0\n`, ID)).toBe(false);
  });

  it('takes only an error line that starts at the beginning of a line', () => {
    expect(hasActivationFailed(`${T} [info] Activating extension ${ID} failed`, ID)).toBe(false);
    expect(
      hasActivationFailed(`${T} [info] saw: [error] Activating extension ${ID} failed`, ID),
    ).toBe(false);
    expect(hasActivationFailed(`  ${failed}`, ID)).toBe(false);
  });

  it('takes only the extension asked for', () => {
    expect(hasActivationFailed(failed.replace(ID, 'someone.else'), ID)).toBe(false);
    expect(hasActivationFailed(failed.replace(ID, `${ID}-more`), ID)).toBe(false);
  });

  it('takes the ID in quotes', () => {
    expect(hasActivationFailed(failed.replace(ID, `'${ID}'`), ID)).toBe(true);
  });
});

describe('hasHostTerminated', () => {
  const T = '2026-11-25 11:30:24.754';

  it('finds the line of a window that lost its extension host', () => {
    expect(
      hasHostTerminated(
        `${T} [error] Extension host (LocalProcess pid: 2734) terminated unexpectedly. The following extensions were running: a, b`,
      ),
    ).toBe(true);
  });

  it('is false for a log without it, and for a line that only quotes it', () => {
    expect(hasHostTerminated('')).toBe(false);
    expect(hasHostTerminated(`${T} [info] Started local extension host with pid 2827.`)).toBe(
      false,
    );
    expect(
      hasHostTerminated(
        `${T} [info] x: [error] Extension host (LocalProcess pid: 1) terminated unexpectedly.`,
      ),
    ).toBe(false);
  });
});

describe('completeLines and linesAfter', () => {
  it('counts the lines that end with a newline', () => {
    expect(completeLines('')).toBe(0);
    expect(completeLines('a\nb\n')).toBe(2);
    expect(completeLines('a\nb')).toBe(1);
  });

  it('keeps what a log got after its first lines, also the very next line', () => {
    expect(linesAfter('a\nb\nc\n', completeLines('a\nb\n'))).toBe('c\n');
  });

  it('is empty if nothing was added, and all if the log was new', () => {
    expect(linesAfter('a\nb\n', completeLines('a\nb\n'))).toBe('');
    expect(linesAfter('a\nb\n', 0)).toBe('a\nb\n');
  });
});

describe('decideActivation', () => {
  const none = {
    activated: false,
    failed: false,
    vscodeEnded: false,
    hostEndedForMs: undefined as number | undefined,
  };

  it('waits while no event came', () => {
    expect(decideActivation(none)).toBeUndefined();
  });

  it('ends on the activation', () => {
    expect(decideActivation({ ...none, activated: true })).toBe('activated');
  });

  it('ends at once on a failed activation', () => {
    expect(decideActivation({ ...none, failed: true })).toBe('failed');
  });

  it('ends at once if VS Code ended', () => {
    expect(decideActivation({ ...none, vscodeEnded: true })).toBe('ended');
  });

  it('gives an extension host that ended time to come back: VS Code restarts it by itself', () => {
    expect(decideActivation({ ...none, hostEndedForMs: 0 })).toBeUndefined();
    expect(
      decideActivation({ ...none, hostEndedForMs: HOST_RESTART_GRACE_MS - 1 }),
    ).toBeUndefined();
  });

  it('ends when the extension host did not come back in time', () => {
    expect(decideActivation({ ...none, hostEndedForMs: HOST_RESTART_GRACE_MS })).toBe('ended');
    expect(decideActivation({ ...none, hostEndedForMs: 60_000 })).toBe('ended');
  });

  it('takes an activation within the time of grace', () => {
    expect(decideActivation({ ...none, hostEndedForMs: 100, activated: true })).toBe('activated');
  });

  it('takes a failure within the time of grace: the restarted host has a reason', () => {
    expect(decideActivation({ ...none, hostEndedForMs: 100, failed: true })).toBe('failed');
  });

  it('does not give VS Code that ended any time', () => {
    expect(decideActivation({ ...none, hostEndedForMs: 0, vscodeEnded: true })).toBe('ended');
  });

  it('prefers the failure, which has a reason, to an end that follows it', () => {
    expect(decideActivation({ ...none, failed: true, vscodeEnded: true })).toBe('failed');
    expect(decideActivation({ ...none, failed: true, hostEndedForMs: 99_999 })).toBe('failed');
  });

  it('prefers the activation: the extension runs, whatever came before', () => {
    expect(
      decideActivation({
        activated: true,
        failed: true,
        vscodeEnded: true,
        hostEndedForMs: 99_999,
      }),
    ).toBe('activated');
  });
});

describe('noActivationKind', () => {
  const none = {
    activated: false,
    failed: false,
    vscodeEnded: false,
    hostEndedForMs: undefined as number | undefined,
  };

  it('names the event of the same priority as decideActivation', () => {
    expect(
      noActivationKind({ ...none, failed: true, vscodeEnded: true, hostEndedForMs: 9e9 }),
    ).toBe('failed');
    expect(noActivationKind({ ...none, vscodeEnded: true, hostEndedForMs: 9e9 })).toBe('vscode');
    expect(noActivationKind({ ...none, hostEndedForMs: 9e9 })).toBe('host');
  });

  it('is undefined while the wait goes on, and if the extension activated', () => {
    expect(noActivationKind(none)).toBeUndefined();
    expect(noActivationKind({ ...none, hostEndedForMs: 10 })).toBeUndefined();
    expect(noActivationKind({ ...none, activated: true, failed: true })).toBeUndefined();
  });
});

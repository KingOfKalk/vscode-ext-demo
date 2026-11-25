import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  describeNoActivation,
  markLog,
  readActivationState,
} from '../../../scripts/live/activation.ts';

const ID = 'kingofkalk.vscode-ext-demo';
const T = '2026-11-25 11:29:19.679';
const FAILED = `${T} [error] Activating extension ${ID} failed due to an error:\n${T} [error] Error: boom\n`;
const TERMINATED = `${T} [error] Extension host (LocalProcess pid: 2734) terminated unexpectedly. x\n`;
const ACTIVATED = `${T} [info] Extension activated, count 0\n`;

describe('describeNoActivation', () => {
  const demo = {
    where: 'logs/1/Demo.log',
    end: '2026-11-25 07:40:52.283 [info] Extension activated, count 3',
  };
  const host = { where: 'logs/1/exthost.log', end: 'a\nb', error: 'Error: test hook\n\tat f' };

  it('names both logs and prints their ends, the host log first: that is where activate() fails', () => {
    expect(describeNoActivation({ kind: 'timeout', seconds: 45 }, demo, host).split('\n')).toEqual([
      'the extension did not activate within 45 s, and nothing failed or ended',
      'the last error in the extension host log (logs/1/exthost.log):',
      '  Error: test hook',
      '  \tat f',
      'the end of the extension host log (logs/1/exthost.log):',
      '  a',
      '  b',
      'the end of the Demo log (logs/1/Demo.log):',
      '  2026-11-25 07:40:52.283 [info] Extension activated, count 3',
    ]);
  });

  it('says what happened first', () => {
    const first = (kind: 'failed' | 'vscode' | 'host') =>
      describeNoActivation({ kind }, demo, host).split('\n')[0];
    expect(first('failed')).toBe('the extension did not activate: its activation failed');
    expect(first('vscode')).toBe('VS Code ended before the extension activated');
    expect(first('host')).toBe('the extension host ended before the extension activated');
  });

  it('leaves out the error line if the host log has none', () => {
    const text = describeNoActivation({ kind: 'host' }, demo, { where: 'h', end: 'x' });
    expect(text).not.toContain('last error');
  });
});

describe('readActivationState', () => {
  let logs: string;

  beforeEach(() => {
    logs = mkdtempSync(join(tmpdir(), 'activation-'));
  });

  afterEach(() => {
    rmSync(logs, { recursive: true });
  });

  const run = (name: string) => join(logs, name, 'window1');
  const host = (name: string) => join(run(name), 'exthost', 'exthost.log');
  const renderer = (name: string) => join(run(name), 'renderer.log');

  function write(file: string, text: string): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }

  const source = (over: Partial<Parameters<typeof readActivationState>[0]> = {}) => ({
    logs,
    before: [] as string[],
    id: ID,
    vscodeRuns: () => true,
    isActivated: () => false,
    ...over,
  });

  it('has no event without a run', () => {
    expect(readActivationState(source()).state).toEqual({
      activated: false,
      failed: false,
      vscodeEnded: false,
      hostEnded: false,
    });
  });

  it('sees the failure and the lost host in the logs of the run', () => {
    write(host('1'), FAILED);
    write(renderer('1'), TERMINATED);
    const { state } = readActivationState(source());
    expect(state).toMatchObject({ failed: true, hostEnded: true });
  });

  it('does not take a failure of an old run for the new one', () => {
    write(host('1'), FAILED);
    write(renderer('1'), TERMINATED);
    const before = ['1'];
    expect(readActivationState(source({ before })).state).toMatchObject({
      failed: false,
      hostEnded: false,
    });
    write(host('2'), '');
    expect(readActivationState(source({ before })).state).toMatchObject({ failed: false });
  });

  it('does not take a failure of the same run from before the reload for the new one', () => {
    write(host('1'), FAILED);
    write(renderer('1'), TERMINATED);
    const marks = {
      host: markLog(host('1')),
      renderer: markLog(renderer('1')),
    };
    expect(readActivationState(source({ marks })).state).toMatchObject({
      failed: false,
      hostEnded: false,
    });
    write(host('1'), FAILED + FAILED);
    write(renderer('1'), TERMINATED + TERMINATED);
    expect(readActivationState(source({ marks })).state).toMatchObject({
      failed: true,
      hostEnded: true,
    });
  });

  it('takes a whole log if the reload started a new run', () => {
    write(host('1'), FAILED);
    const marks = { host: markLog(host('1')), renderer: markLog(renderer('1')) };
    write(host('2'), FAILED);
    expect(readActivationState(source({ marks })).state.failed).toBe(true);
  });

  it('asks the caller whether VS Code runs and whether the extension activated', () => {
    const { state } = readActivationState(
      source({ vscodeRuns: () => false, isActivated: () => true }),
    );
    expect(state).toMatchObject({ vscodeEnded: true, activated: true });
  });

  it('is not fooled by the activation line in a log of the host', () => {
    write(host('1'), ACTIVATED);
    expect(readActivationState(source()).state.failed).toBe(false);
  });
});

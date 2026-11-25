// What `start` and `reload` wait for: the first event of an activation. It is the extension that
// activates, `activate()` that fails, or VS Code or its extension host that ends. The time limit of
// the caller is only for a hang, where no event comes.
import { relative } from 'node:path';
import {
  hasActivationFailed,
  completeLines,
  hasHostTerminated,
  lastErrorBlock,
  linesAfter,
  readLog,
  runLogs,
  tail,
  type ActivationState,
  type RunLogs,
} from './logs.ts';

/** How far a log was when the command that causes the activation was given. */
export interface LogMark {
  file: string | undefined;
  lines: number;
}

/** The logs of a run that was there before keep their lines; a reload keeps the run. */
export interface LogMarks {
  host: LogMark;
  renderer: LogMark;
}

/** Where the log is now, to tell later what is new in it. */
export function markLog(file: string | undefined): LogMark {
  const text = file === undefined ? undefined : readLog(file);
  return { file, lines: text === undefined ? 0 : completeLines(text) };
}

/** What `file` got since `mark`; all of it if it is another file, such as the log of a new run. */
function newText(file: string, mark: LogMark | undefined): string {
  const text = readLog(file) ?? '';
  return mark?.file === file ? linesAfter(text, mark.lines) : text;
}

export interface ActivationSource {
  logs: string;
  /** The runs that are not this one, see `selectRun`. */
  before: readonly string[];
  id: string;
  vscodeRuns: () => boolean;
  isActivated: () => boolean;
  /** Without marks, the whole log of the run counts: its run is new. */
  marks?: LogMarks | undefined;
}

/** The events in the logs of the current run, and what to say about them. */
export function readActivationState(source: ActivationSource): {
  state: ActivationState;
  found: RunLogs | undefined;
  /** The extension host log of the current run, the part that counts. */
  hostText: string;
} {
  const found = runLogs(source.logs, source.before, source.id);
  const hostText = found === undefined ? '' : newText(found.host, source.marks?.host);
  const rendererText = found === undefined ? '' : newText(found.renderer, source.marks?.renderer);
  return {
    found,
    hostText,
    state: {
      activated: source.isActivated(),
      failed: hasActivationFailed(hostText, source.id),
      vscodeEnded: !source.vscodeRuns(),
      hostEnded: hasHostTerminated(rendererText),
    },
  };
}

/** What the wait for an activation ended on, if it was not an activation. */
export type NoActivation =
  { kind: 'failed' } | { kind: 'vscode' } | { kind: 'host' } | { kind: 'timeout'; seconds: number };

function headline(why: NoActivation): string {
  switch (why.kind) {
    case 'failed':
      return 'the extension did not activate: its activation failed';
    case 'vscode':
      return 'VS Code ended before the extension activated';
    case 'host':
      return 'the extension host ended before the extension activated';
    case 'timeout':
      return `the extension did not activate within ${why.seconds} s, and nothing failed or ended`;
  }
}

/**
 * The failure of a wait that the extension did not follow with an activation. The reason is in the
 * log of the extension host (an exception of `activate()` is there, not in the Demo log, which the
 * extension has not written yet), so both logs are named and their ends printed.
 */
export function describeNoActivation(
  why: NoActivation,
  demo: { where: string; end: string },
  host: { where: string; end: string; error?: string },
): string {
  const indent = (text: string) => text.split('\n').map((line) => `  ${line}`);
  const first = headline(why);
  return [
    first,
    ...(host.error === undefined
      ? []
      : [`the last error in the extension host log (${host.where}):`, ...indent(host.error)]),
    `the end of the extension host log (${host.where}):`,
    ...indent(host.end),
    `the end of the Demo log (${demo.where}):`,
    ...indent(demo.end),
  ].join('\n');
}

/** `describeNoActivation` with the logs of the current run. `base` shortens their paths. */
export function explainNoActivation(
  why: NoActivation,
  source: ActivationSource,
  base: string,
): string {
  const { found, hostText } = readActivationState(source);
  const shown = (file: string | undefined, end: number) => ({
    where: file === undefined ? '(no log yet)' : relative(base, file),
    end: file === undefined ? '(missing)' : tail(file, end),
  });
  const error = lastErrorBlock(hostText, 8);
  return describeNoActivation(why, shown(found?.demo, 3), {
    ...shown(found?.host, 5),
    ...(error === undefined ? {} : { error }),
  });
}

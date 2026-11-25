// The logs of VS Code. Every run gets a directory below logs/ of the profile, named after its time;
// a kept profile has those of earlier runs, and the command line of VS Code may make one, too.
import { globSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/** The line the extension logs when it activates; anchored, so a message that says so does not count. */
const LOG_LINE = String.raw`^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} \[info\] `;
const ACTIVATED = new RegExp(`${LOG_LINE}Extension activated, count \\d+`, 'm');
/** The line of a change of the settings, with what the extension now has as JSON. */
const SETTINGS_CHANGED = new RegExp(`${LOG_LINE}Settings changed: (.*)$`, 'm');

export interface RunLogs {
  /** The `Demo` output channel. Missing until the extension makes it. */
  demo: string;
  /** The extension host. */
  host: string;
  /** The window: it says if its extension host ended. */
  renderer: string;
}

/**
 * The runs that had a window. Not those of the command line: the names are times in seconds, so the
 * window that starts next may get the same one.
 */
export function listRuns(logs: string): string[] {
  return globSync('*/window1', { cwd: logs }).map((dir) => dirname(dir));
}

/**
 * The latest run with a window that was not there before.
 * @param files paths below logs/
 */
export function selectRun(before: readonly string[], files: readonly string[]): string | undefined {
  return files
    .filter((file) => /^[^/]+\/window1\//.test(file))
    .map((file) => file.slice(0, file.indexOf('/')))
    .filter((run) => !before.includes(run))
    .sort()
    .at(-1);
}

/** The logs of the run that `selectRun` finds. */
export function runLogs(
  logs: string,
  before: readonly string[],
  extensionId: string,
): RunLogs | undefined {
  const run = selectRun(before, globSync('*/window1/**/*.log', { cwd: logs }));
  if (run === undefined) return undefined;
  const window = join(logs, run, 'window1');
  const dir = join(window, 'exthost');
  return {
    demo: join(dir, extensionId, 'Demo.log'),
    host: join(dir, 'exthost.log'),
    renderer: join(window, 'renderer.log'),
  };
}

/** Whether the extension has activated in the new run. */
export function isActivated(logs: string, before: readonly string[], extensionId: string): boolean {
  const found = runLogs(logs, before, extensionId);
  return found !== undefined && ACTIVATED.test(readText(found.demo));
}

/** What a failed activation and a lost extension host log; anchored like the lines above. */
const ERROR_LOG_LINE = String.raw`^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} \[error\] `;
const HOST_TERMINATED = new RegExp(
  `${ERROR_LOG_LINE}Extension host \\(.*\\) terminated unexpectedly`,
  'm',
);

/**
 * Whether the extension host log (the part that counts) says that `activate()` of the extension
 * failed: `Activating extension <id> failed due to an error:`, with the exception below it.
 */
export function hasActivationFailed(hostLog: string, extensionId: string): boolean {
  const id = extensionId.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp(`${ERROR_LOG_LINE}Activating extension '?${id}'? failed`, 'm').test(hostLog);
}

/**
 * Whether the log of the window (the part that counts) says that its extension host ended
 * unexpectedly, which VS Code answers with a restart that the activation may not survive.
 */
export function hasHostTerminated(rendererLog: string): boolean {
  return HOST_TERMINATED.test(rendererLog);
}

/**
 * VS Code restarts an extension host that ended unexpectedly, and the extension may activate again;
 * this long a command waits for that before it calls the end a failure.
 */
export const HOST_RESTART_GRACE_MS = 5000;

/** What the logs and the processes say about the activation that a command waits for. */
export interface ActivationEvents {
  /** The extension logged its activation line. */
  activated: boolean;
  /** The extension host logged that `activate()` failed. */
  failed: boolean;
  vscodeEnded: boolean;
  /** The window logged that its extension host ended. */
  hostEnded: boolean;
}

export interface ActivationState {
  activated: boolean;
  failed: boolean;
  vscodeEnded: boolean;
  /** How long ago the window logged that its extension host ended; undefined if it did not. */
  hostEndedForMs: number | undefined;
}

/**
 * The first event that ends the wait for an activation, or undefined while none has come. A failure
 * goes before an end: it has the reason. An activation goes first: the extension runs. VS Code that
 * ended ends the wait at once; an extension host that ended only after `HOST_RESTART_GRACE_MS`,
 * because VS Code restarts it by itself.
 */
export function decideActivation(
  state: ActivationState,
): 'activated' | 'failed' | 'ended' | undefined {
  if (state.activated) return 'activated';
  if (state.failed) return 'failed';
  if (state.vscodeEnded) return 'ended';
  return state.hostEndedForMs !== undefined && state.hostEndedForMs >= HOST_RESTART_GRACE_MS
    ? 'ended'
    : undefined;
}

/** What a wait that did not see an activation ended on: the same order as `decideActivation`. */
export function noActivationKind(state: ActivationState): 'failed' | 'vscode' | 'host' | undefined {
  const decision = decideActivation(state);
  if (decision === undefined || decision === 'activated') return undefined;
  if (decision === 'failed') return 'failed';
  return state.vscodeEnded ? 'vscode' : 'host';
}

/** The number of complete lines of a text: those that end with a newline. */
export function completeLines(text: string): number {
  return text.split('\n').length - 1;
}

/**
 * The text after its first `count` complete lines. A log that ended with a newline when `count`
 * was taken has the first new line right after them.
 */
export function linesAfter(text: string, count: number): string {
  return text.split('\n').slice(count).join('\n');
}

/** The text of a file, or '' if it does not exist. */
function readText(file: string): string {
  return readLog(file) ?? '';
}

/** The last lines of a file, or a note that it does not exist. */
export function tail(file: string, lines = 10): string {
  const text = lastLines(readText(file), lines).join('\n');
  return text === '' ? `(${file} is empty or missing)` : text;
}

/** The lines of a text without the final newline; none for an empty one. */
function linesOf(text: string): string[] {
  const trimmed = text.trimEnd();
  return trimmed === '' ? [] : trimmed.split('\n');
}

/** The last `count` lines of a text. */
export function lastLines(text: string, count: number): string[] {
  return count <= 0 ? [] : linesOf(text).slice(-count);
}

/**
 * A part of the report of `logs`: a title with where the text is from, and its last lines.
 * @param text undefined if the file is not there
 */
export function formatSection(
  title: string,
  where: string,
  text: string | undefined,
  count: number,
): string {
  if (text === undefined) return `== ${title}: missing (${where})`;
  const all = linesOf(text);
  if (all.length === 0) return `== ${title}: empty (${where})`;
  const shown = lastLines(text, count);
  const size =
    shown.length < all.length
      ? `last ${shown.length} of ${all.length} lines`
      : `${all.length} ${all.length === 1 ? 'line' : 'lines'}`;
  return [`== ${title} (${where}, ${size})`, ...shown].join('\n');
}

/** The text of a log, or undefined if it is not there. */
export function readLog(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** How often the extension has activated in the newest run, and the last of those log lines. */
export interface Activations {
  /** undefined if no run has a window yet. */
  run: string | undefined;
  count: number;
  last?: string;
}

/**
 * A reload of the window keeps the run directory and its Demo log, and the extension adds a line
 * when it activates again; so the lines are counted, not the runs.
 */
export function readActivations(logs: string, extensionId: string): Activations {
  const found = runLogs(logs, [], extensionId);
  if (!found) return { run: undefined, count: 0 };
  const run = relative(logs, found.host).split(sep)[0];
  const lines = (readLog(found.demo) ?? '').split('\n').filter((line) => ACTIVATED.test(line));
  const last = lines.at(-1);
  return last === undefined ? { run, count: 0 } : { run, count: lines.length, last };
}

/**
 * Whether the extension has activated since `before`: in a newer run, or once more in the same one.
 * Fewer lines than before in the same run mean the log was made new, which only an activation does.
 */
export function isNewActivation(before: Activations, now: Activations): boolean {
  if (now.count === 0) return false;
  return now.run !== before.run || now.count !== before.count;
}

/**
 * What the extension has after a settings change, from the last of those lines of the Demo log
 * (`line` is such a line), or undefined if it is not one.
 */
export function parseSettingsLine(line: string): Record<string, unknown> | undefined {
  const json = SETTINGS_CHANGED.exec(line)?.[1];
  if (json === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The lines of a Demo log that say the settings changed. */
export function settingsLines(demoLog: string): string[] {
  return demoLog.split('\n').filter((line) => SETTINGS_CHANGED.test(line));
}

/** A line of a log starts with its time; the lines of a stack do not. */
const TIMED = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} /;
const ERROR_LINE = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} \[error\] /;

/**
 * The last error of a log: its `[error]` lines and the lines of the stack under them (the first
 * `maxLines`), or undefined if there is none. An error is often several `[error]` lines in a row.
 */
export function lastErrorBlock(text: string, maxLines: number): string | undefined {
  const lines = linesOf(text);
  const last = lines.findLastIndex((line) => ERROR_LINE.test(line));
  if (last < 0) return undefined;
  let start = last;
  while (start > 0 && ERROR_LINE.test(lines[start - 1] ?? '')) start--;
  let end = last + 1;
  while (end < lines.length && !TIMED.test(lines[end] ?? '')) end++;
  const block = lines.slice(start, end);
  const shown = block.slice(0, maxLines);
  if (block.length > shown.length) shown.push(`... ${block.length - shown.length} more lines`);
  return shown.join('\n');
}

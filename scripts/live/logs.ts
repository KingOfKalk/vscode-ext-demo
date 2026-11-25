// The logs of VS Code. Every run gets a directory below logs/ of the profile, named after its time;
// a kept profile has those of earlier runs, and the command line of VS Code may make one, too.
import { globSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

const ACTIVATED = 'Extension activated';

export interface RunLogs {
  /** The `Demo` output channel. Missing until the extension makes it. */
  demo: string;
  /** The extension host. */
  host: string;
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
  const dir = join(logs, run, 'window1', 'exthost');
  return { demo: join(dir, extensionId, 'Demo.log'), host: join(dir, 'exthost.log') };
}

/** Whether the extension has activated in the new run. */
export function isActivated(logs: string, before: readonly string[], extensionId: string): boolean {
  const found = runLogs(logs, before, extensionId);
  return found !== undefined && readText(found.demo).includes(ACTIVATED);
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
  const lines = (readLog(found.demo) ?? '').split('\n').filter((line) => line.includes(ACTIVATED));
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

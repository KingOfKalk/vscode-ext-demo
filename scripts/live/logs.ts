// The logs of VS Code. Every run gets a directory below logs/ of the profile, named after its time;
// a kept profile has those of earlier runs, and the command line of VS Code may make one, too.
import { globSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
  return found !== undefined && readText(found.demo).includes('Extension activated');
}

/** The text of a file, or '' if it does not exist. */
function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

/** The last lines of a file, or a note that it does not exist. */
export function tail(file: string, lines = 10): string {
  const text = readText(file).trimEnd();
  return text === '' ? `(${file} is empty or missing)` : text.split('\n').slice(-lines).join('\n');
}

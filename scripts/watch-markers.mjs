// What `npm run watch` prints for the background task in `.vscode/tasks.json`: esbuild itself prints
// nothing that tells when a rebuild begins or ends.
import { formatMessages } from 'esbuild';

/** The task's `beginsPattern` and `endsPattern` match these lines. */
export const STARTED = '[watch] build started';
export const FINISHED = '[watch] build finished';

/**
 * esbuild rebuilds each bundle on its own: one start and one end per bundle. The task needs one
 * start when a rebuild begins, and one end when every bundle that began has ended, because it
 * starts the debugger at the first end.
 * @param {(line: string) => void} log
 */
export function createTracker(log = console.log) {
  /** @type {Set<string>} */
  const running = new Set();
  return {
    /** @param {string} name */
    started(name) {
      if (running.size === 0) log(STARTED);
      running.add(name);
    },
    /** @param {string} name */
    ended(name) {
      if (running.delete(name) && running.size === 0) log(FINISHED);
    },
  };
}

/**
 * Plain text, in the form that the problem matcher of the task reads: a line with the severity and
 * the message, then the place.
 * @param {import('esbuild').Message[]} errors
 * @param {import('esbuild').Message[]} warnings
 * @returns {Promise<string[]>}
 */
export async function describeMessages(errors, warnings) {
  const options = { color: false, terminalWidth: 100 };
  return [
    ...(await formatMessages(errors, { ...options, kind: 'error' })),
    ...(await formatMessages(warnings, { ...options, kind: 'warning' })),
  ];
}

/**
 * An esbuild plugin that reports the bundle to the tracker, and its messages before its end: the
 * task ignores everything after the end marker.
 * @param {string} name
 * @param {ReturnType<typeof createTracker>} tracker
 * @param {(text: string) => void} log
 * @returns {import('esbuild').Plugin}
 */
export function watchPlugin(name, tracker, log = console.log) {
  return {
    name: 'watch-markers',
    setup(build) {
      build.onStart(() => {
        tracker.started(name);
      });
      build.onEnd(async ({ errors, warnings }) => {
        for (const text of await describeMessages(errors, warnings)) log(text.trimEnd());
        tracker.ended(name);
      });
    },
  };
}

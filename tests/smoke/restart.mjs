// The restart stage of the smoke tests: what each start must show. In test mode VS Code keeps its
// storage in memory, so nothing survives a restart there. run.mjs therefore starts VS Code without
// test mode, once per phase on one profile, with helper.ts next to the .vsix.
import { hostProblems, problems } from './results.mjs';

/** @typedef {import('./helper').Report} Report */

/** The count the first phase counts to. */
export const COUNT = 3;

/** In this order. Folder `a` three times, then folder `b`, which has its own count. */
export const PHASES = /** @type {const} */ ([
  { name: 'count', folder: 'a', title: 'counts to 3 and quits' },
  { name: 'restore', folder: 'a', title: 'restores the window with the count after a restart' },
  {
    name: 'hidden',
    folder: 'a',
    title: 'restores a window that was behind a tab once it is shown',
  },
  { name: 'other', folder: 'b', title: 'starts at 0 in another folder' },
]);

/**
 * Lines of the Demo log (src/windowController.ts) that tell the window was not adopted. Only they
 * tell it: a window that the extension replaced after 2 s shows the same.
 */
const NOT_ADOPTED = /Replacing a window that lost its extension host|closing the restored one/;

/**
 * What went wrong in one start; nothing if it showed what it must.
 * @param {(typeof PHASES)[number]['name']} name
 * @param {{ ending: string, report: Report | undefined, demoLog: string, hostLog: string }} start
 *   ending: how VS Code ended; the logs of this start
 * @param {string} message the default greeting
 * @returns {string[]}
 */
export function checkStart(name, { ending, report, demoLog, hostLog }, message) {
  const window = { message, count: String(COUNT), styled: true };
  /** @type {Report} */
  const expected = {
    count: { count: COUNT, windows: [window], tabs: 1 },
    restore: { count: COUNT, windows: [window], tabs: 1 },
    hidden: { count: COUNT, restoredHidden: true, windows: [window], tabs: 1 },
    other: { count: 0, windows: [], tabs: 0 },
  }[name];
  const failures = [];
  if (ending !== 'exit 0') failures.push(`VS Code ended with ${ending}.`);
  if (report === undefined) failures.push('The helper wrote no report.');
  if (report?.error !== undefined) failures.push(report.error);
  for (const [key, value] of Object.entries(expected)) {
    const shown = report?.[/** @type {keyof Report} */ (key)];
    if (report !== undefined && JSON.stringify(shown) !== JSON.stringify(value)) {
      failures.push(`${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(shown)}`);
    }
  }
  if (demoLog === '') failures.push('There is no Demo log.');
  if (hostLog === '') failures.push('There is no extension host log.');
  return [
    ...failures,
    ...demoLog
      .split('\n')
      .filter((line) => NOT_ADOPTED.test(line))
      .map((line) => `Not adopted: ${line}`),
    ...problems(demoLog).map((entry) => `Demo log: ${entry}`),
    ...hostProblems(hostLog).map((entry) => `Extension host log: ${entry}`),
  ];
}

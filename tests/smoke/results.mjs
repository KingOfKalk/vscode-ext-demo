// What the smoke suite (in the extension host), the restart stage and the runner (outside) share.
import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @typedef {{ name: string, status: 'pending' | 'running' | 'passed' | 'failed', error?: string }} CheckResult
 */

/** Below `logs/` of the profile; VS Code starts a new directory per run. */
export const LOGS = {
  demo: '*/window1/exthost/kingofkalk.vscode-ext-demo/Demo.log',
  host: '*/window1/exthost/exthost.log',
  renderer: '*/window1/renderer.log',
};

/**
 * The text of a log, or '' if it does not exist (yet).
 * @param {string} profile
 * @param {string} pattern one of `LOGS`
 */
export function readLog(profile, pattern) {
  const cwd = join(profile, 'logs');
  return globSync(pattern, { cwd })
    .map((file) => readFileSync(join(cwd, file), 'utf8'))
    .join('');
}

/**
 * The errors and warnings in a log, each with the lines that belong to it.
 * @param {string} text
 */
export function problems(text) {
  return text
    .split(/\n(?=\d{4}-\d\d-\d\d \S+ \[)/)
    .map((entry) => entry.trimEnd())
    .filter((entry) => /^\S+ \S+ \[(error|warning)\] /.test(entry));
}

/**
 * The problems of the extension in the log of the extension host: errors and warnings that name
 * it, and errors that name no extension (for example a rejected call into VS Code). What built-in
 * extensions log is not ours, and VS Code names all extensions in a warning about the suite. While
 * it ends, VS Code logs errors of its own.
 * @param {string} text
 */
export function hostProblems(text) {
  const end = text.search(/^.*Extension host terminating/m);
  const [running, ending] = end < 0 ? [text, ''] : [text.slice(0, end), text.slice(end)];
  const ours = (/** @type {string} */ entry) => entry.includes('kingofkalk.vscode-ext-demo');
  const suite = (/** @type {string} */ entry) =>
    /Could not identify extension for 'vscode' require call from \S+\/suite\.js\./.test(entry);
  return [
    ...problems(running).filter(
      (entry) =>
        (ours(entry) && !suite(entry)) ||
        (/^\S+ \S+ \[error\] /.test(entry) &&
          !/\[vscode\.|\/resources\/app\/extensions\//.test(entry)),
    ),
    ...problems(ending).filter(ours),
  ];
}

/**
 * @typedef {{ file: string, results: readonly CheckResult[], message: string }} Stage
 *   message: what went wrong outside the checks, or ''
 */

/**
 * The results in the shape of the Vitest JSON report, for scripts/ci-summary.mjs: one file per
 * stage of the smoke tests.
 * @param {readonly Stage[]} stages
 * @param {number} startTime
 * @param {number} endTime
 */
export function toReport(stages, startTime, endTime) {
  const all = stages.flatMap(({ results }) => results);
  const count = (
    /** @type {readonly CheckResult[]} */ results,
    /** @type {CheckResult['status'][]} */ ...statuses
  ) => results.filter(({ status }) => statuses.includes(status)).length;
  return {
    numTotalTests: all.length,
    numPassedTests: count(all, 'passed'),
    numFailedTests: count(all, 'failed', 'running'),
    numPendingTests: count(all, 'pending'),
    numTodoTests: 0,
    startTime,
    testResults: stages.map(({ file, results, message }) => ({
      name: file,
      status: count(results, 'failed', 'running') > 0 || message !== '' ? 'failed' : 'passed',
      startTime,
      endTime,
      message,
      assertionResults: results.map(({ name, status, error }) => ({
        fullName: name,
        status: status === 'running' ? 'failed' : status,
        failureMessages: status === 'running' ? ['did not finish'] : error ? [error] : [],
      })),
    })),
  };
}

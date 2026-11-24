// Writes Markdown for the GitHub job summaries of the CI jobs. Prints to stdout; the workflow
// appends it to $GITHUB_STEP_SUMMARY. All formatting is in pure, exported functions.
//
// Everything that comes from tools (lint output, test failures, archive entries) is untrusted
// text: it goes into a code fence that its content cannot close, or is escaped.
//
// Usage:
//   node scripts/ci-summary.mjs steps --title <title> [--step <name>=<outcome>=<logfile>]...
//   node scripts/ci-summary.mjs build --title <title> [--step ...]... [--vsix <file>] [--artifact-url <url>]
//   node scripts/ci-summary.mjs test --report <vitest.json> --outcome <outcome> [--root <dir>]
// Exit 1 on bad usage or when a required input cannot be read, so a broken summary is not silent.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LOG_LIMITS = { maxLines: 80, maxChars: 8000 };
const TEST_LIMITS = { maxLines: 30, maxChars: 3000 };
const MAX_LISTED_FAILURES = 20;

/**
 * @typedef {{ name: string, outcome: string, log: string }} StepResult
 * @typedef {{ fullName: string, status: string, failureMessages?: string[] }} AssertionResult
 * @typedef {{
 *   name: string, status: string, startTime: number, endTime: number,
 *   message?: string, assertionResults: AssertionResult[],
 * }} FileResult
 * @typedef {{
 *   numTotalTests: number, numPassedTests: number, numFailedTests: number,
 *   numPendingTests: number, numTodoTests: number, startTime: number, testResults: FileResult[],
 * }} VitestReport
 * @typedef {{ name: string, size: number }} ZipEntry
 */

/** @param {string} text */
export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex -- matching the ESC character is the point
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/**
 * Trims trailing whitespace and cuts to a number of lines and characters.
 * @param {string} text
 * @param {{ maxLines: number, maxChars: number }} limits
 */
export function truncate(text, { maxLines, maxChars }) {
  let out = text.trimEnd();
  const lines = out.split('\n');
  if (lines.length > maxLines) {
    out = `${lines.slice(0, maxLines).join('\n')}\n... ${String(lines.length - maxLines)} more lines not shown`;
  }
  if (out.length > maxChars) {
    out = `${out.slice(0, maxChars)}\n... truncated (${String(out.length - maxChars)} more characters)`;
  }
  return out;
}

/**
 * Wraps text in a code fence that is longer than any backtick run inside the text.
 * @param {string} text
 */
export function fence(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const marker = '`'.repeat(Math.max(3, longest + 1));
  return `${marker}text\n${text}\n${marker}`;
}

/**
 * Escapes text for one line of Markdown, also valid inside a table cell.
 * @param {string} text
 */
export function escapeCell(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[|`*_[\]~]/g, (char) => `\\${char}`)
    .replace(/\s*\r?\n\s*/g, ' ');
}

/**
 * Inline code span that survives backticks in the text.
 * @param {string} text
 */
function code(text) {
  const single = text.replace(/\s*\r?\n\s*/g, ' ');
  const longest = Math.max(0, ...(single.match(/`+/g) ?? []).map((run) => run.length));
  const marker = '`'.repeat(longest + 1);
  const pad = single.startsWith('`') || single.endsWith('`') ? ' ' : '';
  return `${marker}${pad}${single}${pad}${marker}`;
}

/** @param {number} bytes */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** @param {number} ms */
export function formatDuration(ms) {
  return ms < 1000 ? `${String(Math.round(ms))} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Result table for steps, plus the output of the steps that failed.
 * @param {string} title
 * @param {readonly StepResult[]} steps
 */
export function renderStepsSummary(title, steps) {
  let out = `## ${escapeCell(title)}\n\n| Step | Result |\n| --- | --- |\n`;
  for (const step of steps) {
    out += `| ${escapeCell(step.name)} | ${escapeCell(step.outcome)} |\n`;
  }
  for (const step of steps.filter((s) => s.outcome === 'failure')) {
    const log = truncate(stripAnsi(step.log), LOG_LIMITS);
    out += `\n### ${escapeCell(step.name)} failed\n\n${log === '' ? '_The step printed no output._' : fence(log)}\n`;
  }
  return out;
}

/**
 * Test failure text without colour codes, library stack frames and the checkout path.
 * @param {string} message
 * @param {string} prefix checkout directory with a trailing slash
 */
function cleanFailure(message, prefix) {
  return stripAnsi(message)
    .split('\n')
    .filter((line) => !/^\s+at .*(node_modules|node:internal|<anonymous>)/.test(line))
    .join('\n')
    .replaceAll(`file://${prefix}`, '')
    .replaceAll(prefix, '');
}

/**
 * @param {string} outcome of the test step
 * @param {string} note
 */
function testHeading(outcome, note) {
  return `## Unit tests\n\nResult: ${escapeCell(outcome)}${note}\n`;
}

/**
 * Result of the step, test counts, duration and the failed tests, from the Vitest JSON report.
 * @param {VitestReport} report
 * @param {string} root directory to cut from the front of file paths
 * @param {string} outcome of the test step; the report counts only failures inside test files
 */
export function renderTestSummary(report, root, outcome) {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  /** @type {{ title: string, message: string }[]} */
  const failures = [];
  for (const file of report.testResults) {
    const path = file.name.startsWith(prefix) ? file.name.slice(prefix.length) : file.name;
    const failed = file.assertionResults.filter((test) => test.status === 'failed');
    for (const test of failed) {
      failures.push({
        title: `${escapeCell(path)} › ${escapeCell(test.fullName)}`,
        message: (test.failureMessages ?? []).join('\n\n'),
      });
    }
    // An error of the file itself: it could not be loaded, or a hook around its tests failed.
    if (file.message || (failed.length === 0 && file.status === 'failed')) {
      failures.push({ title: escapeCell(path), message: file.message ?? '' });
    }
  }

  const skipped = report.numPendingTests + report.numTodoTests;
  const end = Math.max(report.startTime, ...report.testResults.map((file) => file.endTime));
  // For example an unhandled error: Vitest exits 1, but its report has no trace of it.
  const outside = outcome === 'failure' && failures.length === 0;
  let out = testHeading(outcome, outside ? ' (failed outside a test, see the log)' : '');
  out += '\n| Result | Count |\n| --- | --- |\n';
  out += `| Passed | ${String(report.numPassedTests)} |\n`;
  out += `| Failed | ${String(report.numFailedTests)} |\n`;
  out += `| Skipped | ${String(skipped)} |\n`;
  out += `| Total | ${String(report.numTotalTests)} |\n`;
  out += `\nDuration: ${formatDuration(end - report.startTime)}\n`;

  if (failures.length > 0) {
    out += '\n### Failed tests\n';
    for (const failure of failures.slice(0, MAX_LISTED_FAILURES)) {
      const message = truncate(cleanFailure(failure.message, prefix), TEST_LIMITS);
      out += `\n#### ${failure.title}\n\n${message === '' ? '_No message._' : fence(message)}\n`;
    }
    if (failures.length > MAX_LISTED_FAILURES) {
      out += `\n${String(failures.length - MAX_LISTED_FAILURES)} more failed tests not shown.\n`;
    }
  }
  return out;
}

/**
 * Parses `unzip -Zl` output into files with their uncompressed size. Directories, the
 * archive header and the totals line are skipped.
 * @param {string} text
 * @returns {ZipEntry[]}
 */
export function parseZipListing(text) {
  const pattern = /^[-dlrwxsStT?]{10}\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d+\s+\S+\s+\S+\s+\S+\s+(.+)$/;
  /** @type {ZipEntry[]} */
  const entries = [];
  for (const line of text.split('\n')) {
    const match = pattern.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    if (match[2].endsWith('/')) continue;
    entries.push({ name: match[2], size: Number(match[1]) });
  }
  return entries;
}

/**
 * @param {{ fileName: string, size: number, entries: readonly ZipEntry[], artifactUrl: string }} vsix
 */
export function renderVsixSection({ fileName, size, entries, artifactUrl }) {
  let out = `### Package\n\n- File: ${code(fileName)} (${formatBytes(size)})\n`;
  if (/^https:\/\/\S+$/.test(artifactUrl) && !artifactUrl.includes(')')) {
    out += `- [Download the artifact](${artifactUrl})\n`;
  }
  if (entries.length > 0) {
    out += '\n| File | Size unpacked |\n| --- | --- |\n';
    for (const entry of entries) {
      out += `| ${code(entry.name)} | ${formatBytes(entry.size)} |\n`;
    }
  }
  return out;
}

/**
 * @param {string[]} argv
 * @returns {{ options: Map<string, string>, steps: string[] }}
 */
function parseArgs(argv) {
  /** @type {Map<string, string>} */
  const options = new Map();
  /** @type {string[]} */
  const steps = [];
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === undefined || !flag.startsWith('--') || value === undefined) {
      throw new Error(`bad arguments near ${JSON.stringify(flag)}`);
    }
    if (flag === '--step') steps.push(value);
    else options.set(flag.slice(2), value);
  }
  return { options, steps };
}

/**
 * @param {string} spec `<name>=<outcome>=<logfile>`
 * @returns {StepResult}
 */
function readStep(spec) {
  const [name, outcome, ...rest] = spec.split('=');
  if (!name || !outcome) throw new Error(`bad --step ${JSON.stringify(spec)}`);
  const logFile = rest.join('=');
  let log = '';
  if (logFile !== '') {
    try {
      log = readFileSync(logFile, 'utf8');
    } catch {
      // A skipped step has no log.
    }
  }
  return { name, outcome, log };
}

/**
 * @param {string[]} argv
 * @returns {number} exit code
 */
function main(argv) {
  const [command, ...rest] = argv;
  const { options, steps } = parseArgs(rest);

  if (command === 'steps' || command === 'build') {
    process.stdout.write(renderStepsSummary(options.get('title') ?? 'CI', steps.map(readStep)));
    const vsixPath = options.get('vsix');
    if (command !== 'build' || vsixPath === undefined) return 0;
    try {
      const listing = spawnSync('unzip', ['-Zl', vsixPath], { encoding: 'utf8' });
      if (listing.error) throw listing.error;
      if (listing.status !== 0) throw new Error(`unzip exited with ${String(listing.status)}`);
      process.stdout.write(
        `\n${renderVsixSection({
          fileName: vsixPath.split('/').pop() ?? vsixPath,
          size: statSync(vsixPath).size,
          entries: parseZipListing(listing.stdout),
          artifactUrl: options.get('artifact-url') ?? '',
        })}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`\n_Could not read the .vsix: ${escapeCell(message)}_\n`);
      console.error(`cannot read ${vsixPath}: ${message}`);
      return 1;
    }
    return 0;
  }

  if (command === 'test') {
    const reportPath = options.get('report');
    if (reportPath === undefined) throw new Error('missing --report');
    const outcome = options.get('outcome');
    if (!outcome) throw new Error('missing --outcome');
    try {
      const report = /** @type {VitestReport} */ (JSON.parse(readFileSync(reportPath, 'utf8')));
      process.stdout.write(
        renderTestSummary(report, options.get('root') ?? process.cwd(), outcome),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(
        `${testHeading(outcome, '')}\n_No test report: ${escapeCell(message)}_\n`,
      );
      console.error(`cannot read the test report ${reportPath}: ${message}`);
      return 1;
    }
    return 0;
  }

  throw new Error('usage: ci-summary.mjs steps|build|test [options]');
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

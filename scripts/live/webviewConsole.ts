// The errors of the Demo window that VS Code does not log: the console, uncaught exceptions of its
// script, and what the browser itself reports (a stylesheet that the CSP blocks is no console call,
// it is an entry of the Log domain). Chromium keeps these for the page, and asking for them through
// the debug port replays them, also those from before this connection. They are gone when the window
// is hidden and shown again, or reloaded (its page is new then).
import type { Page } from 'playwright-core';
import { waitFor } from './processes.ts';

export interface ConsoleEntry {
  /** Milliseconds since 1970. */
  time: number;
  /** `console.error`, `exception` (an error that nobody caught) or `log.<source>` (the browser's). */
  kind: string;
  text: string;
}

/** The part of a value of the console that is printed. */
interface RemoteValue {
  type: string;
  value?: unknown;
  description?: string;
}

/** The arguments of `console.error(...)` as one text, separated by spaces like a console does. */
export function describeArguments(args: readonly RemoteValue[]): string {
  return args
    .map(({ type, value, description }) => {
      if (value !== undefined) return typeof value === 'string' ? value : JSON.stringify(value);
      return description ?? type;
    })
    .join(' ');
}

/** The part of an entry of the Log domain that is printed. */
interface LogEntry {
  source: string;
  level: string;
  text: string;
  timestamp: number;
  url?: string;
}

/** Sources that the console and the exceptions of the Runtime domain tell already. */
const TOLD_BY_RUNTIME = new Set(['javascript', 'console-api']);

/** An error of the browser (CSP, a file that did not load), or undefined if it is not one to show. */
export function describeLogEntry(entry: LogEntry): ConsoleEntry | undefined {
  if (entry.level !== 'error' || TOLD_BY_RUNTIME.has(entry.source)) return undefined;
  const where = entry.url && !entry.text.includes(entry.url) ? ` (${entry.url})` : '';
  return { time: entry.timestamp, kind: `log.${entry.source}`, text: `${entry.text}${where}` };
}

/** How many lines of one message are printed, and how long a line: a stack is noise. */
const MAX_LINES = 7;
const MAX_LINE_LENGTH = 300;
const DEFAULT_LIMIT = 20;

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** The time of the log files: local time, to the millisecond. */
function formatTime(time: number): string {
  const d = new Date(time);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

function cutLine(line: string): string {
  return line.length > MAX_LINE_LENGTH
    ? `${line.slice(0, MAX_LINE_LENGTH)}... (${line.length - MAX_LINE_LENGTH} more characters)`
    : line;
}

/**
 * One entry: the time and the kind, then the text. The lines after the first are indented (a stack
 * already is), so that an entry is one block; very long lines and long stacks are cut.
 */
export function formatConsoleEntry({ time, kind, text }: ConsoleEntry): string {
  const lines = text.split('\n');
  const shown = lines
    .slice(0, MAX_LINES)
    .map((line, i) => (i === 0 || /^\s/.test(line) ? line : `    ${line}`))
    .map(cutLine);
  if (lines.length > MAX_LINES) shown.push(`    ... ${lines.length - MAX_LINES} more lines`);
  return `${formatTime(time)} [${kind}] ${shown.join('\n')}`;
}

/** The report of `logs`: the last `limit` entries in the order they happened. */
export function formatConsoleEntries(
  entries: readonly ConsoleEntry[],
  limit = DEFAULT_LIMIT,
): string {
  if (entries.length === 0) return '== Webview console errors: none';
  const sorted = entries.toSorted((a, b) => a.time - b.time);
  const shown = sorted.slice(-limit);
  const size =
    shown.length < sorted.length ? `last ${shown.length} of ${sorted.length}` : `${sorted.length}`;
  return [`== Webview console errors (${size})`, ...shown.map(formatConsoleEntry)].join('\n');
}

/**
 * The outer frames of the Demo window: the frames of the window of VS Code that are webviews of
 * this extension and not inside another frame. Each is a page of its own for the debug port; the
 * frame with the script is inside and is covered by its session. Does not wait for the script: a
 * script that failed at load is what is looked for.
 */
export function outerWebviewFrames(page: Page, extensionId: string) {
  return page
    .frames()
    .filter(
      (frame) =>
        frame.parentFrame() === page.mainFrame() &&
        URL.parse(frame.url())?.searchParams.get('extensionId') === extensionId,
    );
}

/**
 * The errors of the Demo window since it was shown, or undefined if no Demo window is shown.
 * Nothing waits for the window's script to have run.
 */
export async function readConsoleErrors(
  page: Page,
  extensionId: string,
): Promise<ConsoleEntry[] | undefined> {
  // A moment for the frames of a page that was just connected.
  const frames = await waitFor(
    'a Demo window',
    () => {
      const found = outerWebviewFrames(page, extensionId);
      return found.length > 0 ? found : undefined;
    },
    { timeoutMs: 1500 },
  ).catch(() => []);
  if (frames.length === 0) return undefined;
  const entries: ConsoleEntry[] = [];
  for (const frame of frames) {
    const session = await page.context().newCDPSession(frame);
    session.on('Runtime.consoleAPICalled', (event) => {
      if (event.type === 'error' || event.type === 'assert') {
        entries.push({
          time: event.timestamp,
          kind: `console.${event.type}`,
          text: describeArguments(event.args),
        });
      }
    });
    session.on('Runtime.exceptionThrown', ({ timestamp, exceptionDetails }) => {
      entries.push({
        time: timestamp,
        kind: 'exception',
        text: exceptionDetails.exception?.description ?? exceptionDetails.text,
      });
    });
    session.on('Log.entryAdded', ({ entry }) => {
      const found = describeLogEntry(entry);
      if (found) entries.push(found);
    });
    try {
      // What was kept so far arrives before the answers.
      await session.send('Runtime.enable');
      await session.send('Log.enable');
    } finally {
      await session.detach().catch(() => undefined);
    }
  }
  return entries;
}

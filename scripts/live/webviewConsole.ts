// The errors in the console of the Demo window. VS Code does not log them; Chromium keeps the
// messages of a page, and asking for them through the debug port replays them, also those from before
// this connection. They are gone when the window is hidden and shown again (its page is new then).
import type { Frame } from 'playwright-core';

export interface ConsoleEntry {
  /** Milliseconds since 1970. */
  time: number;
  /** `console.error`, or `exception` for an error that nobody caught. */
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

/** How many lines of one message are printed: a stack of many frames is noise. */
const MAX_LINES = 7;
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

export function formatConsoleEntry({ time, kind, text }: ConsoleEntry): string {
  const lines = text.split('\n');
  const shown = lines.slice(0, MAX_LINES);
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
 * The webview of VS Code is a page of its own (an out-of-process frame) with an inner frame that is
 * part of its session: ask the closest frame that has one.
 */
async function openSession(webview: Frame) {
  const page = webview.page();
  let frame: Frame | null = webview;
  while (frame && frame !== page.mainFrame()) {
    try {
      return await page.context().newCDPSession(frame);
    } catch (error) {
      if (!/separate CDP session/.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
      frame = frame.parentFrame();
    }
  }
  throw new Error('the Demo window has no debug session of its own');
}

/** The errors in the console of the Demo window since it was shown. */
export async function readConsoleErrors(webview: Frame): Promise<ConsoleEntry[]> {
  const session = await openSession(webview);
  const entries: ConsoleEntry[] = [];
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
  try {
    // The messages kept so far arrive before the answer.
    await session.send('Runtime.enable');
  } finally {
    await session.detach().catch(() => undefined);
  }
  return entries;
}

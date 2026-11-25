// `logs`: the Demo log, the log of the extension host and the console errors of the Demo window.
// Each part says if it is missing; a missing log is not a failure of the command.
import { relative } from 'node:path';
import { userError } from './errors.ts';
import { formatSection, readLog, runLogs } from './logs.ts';
import { assertOwnSession, PROFILE, readSession, sessionState, VSCODE_LOGS } from './session.ts';
import { connect, extensionId } from './vscode.ts';
import { formatConsoleEntries, readConsoleErrors } from './webviewConsole.ts';

const CONSOLE_TITLE = '== Webview console errors';

/** The errors in the console of the Demo window, or why they cannot be read. */
async function consoleSection(running: boolean): Promise<string> {
  if (!running) return `${CONSOLE_TITLE}: not available (VS Code does not run)`;
  try {
    const open = await connect();
    try {
      const webview = await open.webview();
      if (!webview) {
        return `${CONSOLE_TITLE}: not available (no Demo window is shown; a hidden one has no console)`;
      }
      return formatConsoleEntries(await readConsoleErrors(webview));
    } finally {
      await open.close().catch(() => undefined);
    }
  } catch (error) {
    return `${CONSOLE_TITLE}: not available (${userError(error).message.split('\n')[0] ?? ''})`;
  }
}

/**
 * Returns the text to print. The logs of a session that has ended are shown, too (the profile keeps
 * them): that is when they are needed. Fails if the session belongs to another checkout.
 */
export async function showLogs(lines: number): Promise<string> {
  const session = readSession();
  const state = session ? sessionState(session) : 'gone';
  if (session && state !== 'gone') assertOwnSession(session);

  const found = runLogs(VSCODE_LOGS, [], extensionId());
  const where = (file: string): string => relative(PROFILE, file);
  const parts = [
    found
      ? formatSection('Demo log', where(found.demo), readLog(found.demo), lines)
      : '== Demo log: missing (VS Code has not made a log directory with a window yet)',
    found
      ? formatSection('Extension host log', where(found.host), readLog(found.host), lines)
      : '== Extension host log: missing (VS Code has not made a log directory with a window yet)',
    await consoleSection(state === 'running'),
  ];
  return parts.join('\n\n');
}

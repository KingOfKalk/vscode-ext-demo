// Errors of the live commands. Playwright's errors carry a call log of many lines; a command prints
// one line why, so they are cut here, and nothing of Playwright reaches the user.

/**
 * A failure that is worded for the user and whole as it is, however many lines it has (a list of
 * candidates, say). It has no `cause`: the text says it all, and `describeFailure` would print it twice.
 */
export class ActionError extends Error {
  override name = 'ActionError';
}

/** The first line of an error, and the last line of Playwright's log (what it was waiting for). */
export function oneLine(error: unknown): string {
  const lines = (error instanceof Error ? error.message : String(error)).split('\n');
  const first = lines[0]?.trim() ?? '';
  const last = lines
    .slice(1)
    .map((text) => text.trim())
    .filter((text) => text.startsWith('-'))
    .at(-1);
  return last && last !== first ? `${first} (${last.replace(/^-\s*/, '')})` : first;
}

/** An `ActionError` stays as it is; anything else becomes one line. */
export function userError(error: unknown, what?: string): ActionError {
  if (error instanceof ActionError) return error;
  return new ActionError(what ? `${what}: ${oneLine(error)}` : oneLine(error));
}

/** Runs `attempt`; if it fails with something of Playwright's, the error says `what` in one line. */
export async function guard<T>(what: string, attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    throw userError(error, what);
  }
}

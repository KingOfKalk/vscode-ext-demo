/** Called with what failed (for example `increment the counter`) and why. */
export type ReportError = (what: string, error: unknown) => void;

/**
 * Runs a counter action and reports a failure instead of rejecting, so a caller that does not
 * await it never causes an unhandled rejection. The action starts at once: the count changes
 * before the first `await`.
 */
export async function guarded(
  what: string,
  action: () => Promise<void>,
  report: ReportError,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    report(what, error);
  }
}

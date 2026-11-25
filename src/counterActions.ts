/** Called with what went wrong (for example `incrementing the counter`) and why. */
export type ReportError = (what: string, error: unknown) => void;

/**
 * Runs a counter action and reports a failure instead of rejecting, so a caller that does not
 * await it never causes an unhandled rejection. The action starts at once: the count changes
 * before the first `await`. A report that throws (for example into a closed log) is dropped.
 */
export async function guarded(
  what: string,
  action: () => Promise<void>,
  report: ReportError,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    try {
      report(what, error);
    } catch {
      // Nowhere left to report to.
    }
  }
}

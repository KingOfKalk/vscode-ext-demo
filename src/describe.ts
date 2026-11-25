/** One line for the log: the message of an error, with all errors of an `AggregateError`. */
export function describeError(error: unknown): string {
  if (error instanceof AggregateError) {
    return `${error.message}: ${error.errors.map(describeError).join('; ')}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** A value as short JSON for the log. Never throws. */
export function describeValue(value: unknown, maxLength = 200): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

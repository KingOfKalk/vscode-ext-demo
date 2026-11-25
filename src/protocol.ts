export type ToExtension =
  { type: 'ready' } | { type: 'increment' } | { type: 'decrement' } | { type: 'reset' };
export type ToWebview = { type: 'state'; count: number; message: string };

const TO_EXTENSION_TYPES: ReadonlySet<unknown> = new Set([
  'ready',
  'increment',
  'decrement',
  'reset',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns the message from the webview, or `undefined` if it is not a known one. */
export function parseToExtension(value: unknown): ToExtension | undefined {
  if (!isRecord(value) || !TO_EXTENSION_TYPES.has(value.type)) {
    return undefined;
  }
  return { type: value.type } as ToExtension;
}

/** Returns the message from the extension, or `undefined` if it is malformed. */
export function parseToWebview(value: unknown): ToWebview | undefined {
  if (!isRecord(value) || value.type !== 'state') {
    return undefined;
  }
  const { count, message } = value;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    return undefined;
  }
  if (typeof message !== 'string') {
    return undefined;
  }
  return { type: 'state', count, message };
}

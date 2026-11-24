import { guarded, type ReportError } from './counterActions';
import { describeValue } from './describe';
import { parseToExtension, type ToWebview } from './protocol';

export interface MessageLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface MessageDeps {
  store: { readonly count: number; increment(): Promise<void>; reset(): Promise<void> };
  /** The current `message` setting. */
  message: () => string;
  post(message: ToWebview): void;
  log: MessageLog;
  onError: ReportError;
}

export function buildState(count: number, message: string): ToWebview {
  return { type: 'state', count, message };
}

/**
 * Handles one message from the window. `ready` is answered with the state at once; `increment`
 * and `reset` go to the store, whose listeners send the new state. Unknown messages are logged
 * and ignored. Never rejects.
 */
export async function handleWebviewMessage(raw: unknown, deps: MessageDeps): Promise<void> {
  const message = parseToExtension(raw);
  if (!message) {
    deps.log.warn(`Ignoring unknown webview message: ${describeValue(raw)}`);
    return;
  }
  deps.log.info(`Webview message: ${message.type}`);
  switch (message.type) {
    case 'ready':
      deps.post(buildState(deps.store.count, deps.message()));
      return;
    case 'increment':
      await guarded('incrementing the counter', () => deps.store.increment(), deps.onError);
      return;
    case 'reset':
      await guarded('resetting the counter', () => deps.store.reset(), deps.onError);
      return;
  }
}

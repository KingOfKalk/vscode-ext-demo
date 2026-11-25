import { describe, expect, it, vi } from 'vitest';
import type { ToWebview } from '../../src/protocol';
import { buildState, handleWebviewMessage, type MessageDeps } from '../../src/windowMessages';

function setup(overrides: Partial<MessageDeps['store']> = {}) {
  const posted: ToWebview[] = [];
  const store = {
    count: 7,
    increment: vi.fn(() => Promise.resolve()),
    reset: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
  const info = vi.fn();
  const warn = vi.fn();
  const onError = vi.fn();
  const deps: MessageDeps = {
    store,
    message: () => 'Hi',
    post: (message) => posted.push(message),
    log: { info, warn },
    onError,
  };
  return { deps, store, posted, info, warn, onError };
}

describe('buildState', () => {
  it('builds the state message', () => {
    expect(buildState(3, 'Hi')).toEqual({ type: 'state', count: 3, message: 'Hi' });
  });
});

describe('handleWebviewMessage', () => {
  it('answers ready with the current state at once', async () => {
    const { deps, posted } = setup();
    const done = handleWebviewMessage({ type: 'ready' }, deps);
    expect(posted).toEqual([{ type: 'state', count: 7, message: 'Hi' }]);
    await done;
  });

  it('increments and resets through the store', async () => {
    const { deps, store } = setup();
    await handleWebviewMessage({ type: 'increment' }, deps);
    await handleWebviewMessage({ type: 'reset' }, deps);
    expect(store.increment).toHaveBeenCalledTimes(1);
    expect(store.reset).toHaveBeenCalledTimes(1);
  });

  it('does not post state itself after an increment (the store listener does)', async () => {
    const { deps, posted } = setup();
    await handleWebviewMessage({ type: 'increment' }, deps);
    expect(posted).toEqual([]);
  });

  it('logs every known message', async () => {
    const { deps, info } = setup();
    await handleWebviewMessage({ type: 'increment' }, deps);
    expect(info).toHaveBeenCalledWith('Webview message: increment');
  });

  it.each([undefined, null, 'increment', 5, [], {}, { type: 'explode' }, { type: 7 }])(
    'ignores and logs the unknown message %j',
    async (raw) => {
      const { deps, store, posted, warn, onError } = setup();
      await handleWebviewMessage(raw, deps);
      expect(store.increment).not.toHaveBeenCalled();
      expect(store.reset).not.toHaveBeenCalled();
      expect(posted).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/^Ignoring unknown webview message: /);
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it('reports a rejected increment and resolves', async () => {
    const error = new Error('save failed');
    const { deps, onError } = setup({ increment: () => Promise.reject(error) });
    await expect(handleWebviewMessage({ type: 'increment' }, deps)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledExactlyOnceWith('incrementing the counter', error);
  });

  it('reports a rejected reset and resolves', async () => {
    const error = new Error('save failed');
    const { deps, onError } = setup({ reset: () => Promise.reject(error) });
    await expect(handleWebviewMessage({ type: 'reset' }, deps)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledExactlyOnceWith('resetting the counter', error);
  });
});

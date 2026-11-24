import { describe, expect, it, vi } from 'vitest';
import { CounterStore } from '../../src/counterStore';
import type { ToWebview } from '../../src/protocol';
import type { Settings } from '../../src/settings';
import { WindowController, type PanelHandle, type WindowHost } from '../../src/windowController';

/** A panel like VS Code's: listeners are called, and a disposed one rejects posts. */
class FakePanel implements PanelHandle {
  posted: ToWebview[] = [];
  postCalls = 0;
  reveals = 0;
  disposed = false;
  private messageListeners: ((raw: unknown) => void)[] = [];
  private disposeListeners: (() => void)[] = [];

  constructor(private readonly calls: string[]) {}

  reveal(): void {
    this.reveals += 1;
  }

  dispose(): void {
    this.disposed = true;
    for (const listener of this.disposeListeners) {
      listener();
    }
  }

  post(message: ToWebview): PromiseLike<boolean> {
    this.postCalls += 1;
    if (this.disposed) {
      throw new Error('Webview is disposed');
    }
    this.posted.push(message);
    return Promise.resolve(true);
  }

  // The listeners are never removed, so only the controller's own guard stops a late message.
  onMessage(listener: (raw: unknown) => void): { dispose(): void } {
    this.calls.push('onMessage');
    this.messageListeners.push(listener);
    return { dispose: () => undefined };
  }

  onDispose(listener: () => void): { dispose(): void } {
    this.calls.push('onDispose');
    this.disposeListeners.push(listener);
    return { dispose: () => undefined };
  }

  setHtml(): void {
    this.calls.push('setHtml');
  }

  /** The window sends a message. */
  send(raw: unknown): void {
    for (const listener of this.messageListeners) {
      listener(raw);
    }
  }
}

function setup(initial: Partial<Settings> = {}) {
  const calls: string[] = [];
  const panels: FakePanel[] = [];
  const created: ('tab' | 'beside')[] = [];
  const settings: Settings = {
    message: 'Hi',
    step: 1,
    showStatusBar: true,
    openLocation: 'tab',
    ...initial,
  };
  const host = {
    closeStale: vi.fn((): Promise<void> => Promise.resolve()),
    create(location: 'tab' | 'beside'): FakePanel {
      calls.push('create');
      created.push(location);
      const panel = new FakePanel(calls);
      panels.push(panel);
      return panel;
    },
    closeStaleTabs(): Promise<void> {
      calls.push('closeStaleTabs');
      return host.closeStale();
    },
  } satisfies WindowHost & { closeStale: () => Promise<void> };
  const storage = new Map<string, unknown>();
  const store = new CounterStore(
    {
      get: (key) => storage.get(key),
      update: (key, value) => Promise.resolve(void storage.set(key, value)),
    },
    () => settings.step,
  );
  const info = vi.fn();
  const warn = vi.fn();
  const onError = vi.fn();
  const controller = new WindowController({
    host,
    store,
    log: { info, warn },
    getSettings: () => settings,
    onError,
  });
  return { controller, host, panels, created, calls, settings, store, info, warn, onError };
}

describe('WindowController.open', () => {
  it('closes stale tabs, then creates one window and wires it', async () => {
    const { controller, calls, panels } = setup();
    await controller.open();
    expect(panels).toHaveLength(1);
    expect(calls.indexOf('closeStaleTabs')).toBeLessThan(calls.indexOf('create'));
  });

  it('registers the message handler before the html is set', async () => {
    const { controller, calls } = setup();
    await controller.open();
    expect(calls.indexOf('onMessage')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('onMessage')).toBeLessThan(calls.indexOf('setHtml'));
    expect(calls.at(-1)).toBe('setHtml');
  });

  it('answers ready with the state at once', async () => {
    const { controller, panels } = setup();
    await controller.open();
    panels[0]?.send({ type: 'ready' });
    expect(panels[0]?.posted).toEqual([{ type: 'state', count: 0, message: 'Hi' }]);
  });

  it('opens a second time by revealing, even if openLocation changed', async () => {
    const { controller, panels, created, settings } = setup();
    await controller.open();
    settings.openLocation = 'beside';
    await controller.open();
    expect(created).toEqual(['tab']);
    expect(panels).toHaveLength(1);
    expect(panels[0]?.reveals).toBe(1);
  });

  it('uses the location of the settings when it creates the window', async () => {
    const { controller, panels, created, settings } = setup({ openLocation: 'beside' });
    await controller.open();
    expect(created).toEqual(['beside']);
    panels[0]?.dispose();
    settings.openLocation = 'tab';
    await controller.open();
    expect(created).toEqual(['beside', 'tab']);
  });

  it('creates exactly one window for two quick calls', async () => {
    let finishClosing: () => void = () => undefined;
    const { controller, host, panels } = setup();
    host.closeStale.mockReturnValue(new Promise<void>((resolve) => (finishClosing = resolve)));
    const first = controller.open();
    const second = controller.open();
    expect(panels).toHaveLength(0);
    finishClosing();
    await Promise.all([first, second]);
    expect(panels).toHaveLength(1);
    expect(host.closeStale).toHaveBeenCalledTimes(1);
  });

  it('logs a failure to close stale tabs and still opens one window', async () => {
    const { controller, host, panels, warn } = setup();
    host.closeStale.mockRejectedValue(new Error('no way'));
    await controller.open();
    await controller.open();
    expect(panels).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no way'));
  });

  it('reuses a window that was restored while the stale tabs were closing', async () => {
    let finishClosing: () => void = () => undefined;
    const { controller, host, panels, calls } = setup();
    host.closeStale.mockReturnValue(new Promise<void>((resolve) => (finishClosing = resolve)));
    const opening = controller.open();
    const restored = new FakePanel(calls);
    controller.restore(restored);
    finishClosing();
    await opening;
    expect(panels).toHaveLength(0);
    expect(restored.reveals).toBe(1);
    expect(restored.disposed).toBe(false);
  });

  it('opens again after the window was closed', async () => {
    const { controller, panels } = setup();
    await controller.open();
    panels[0]?.dispose();
    await controller.open();
    expect(panels).toHaveLength(2);
  });

  it('reports a failure to create the window and resolves', async () => {
    const { controller, host, onError } = setup();
    const error = new Error('boom');
    vi.spyOn(host, 'create').mockImplementation(() => {
      throw error;
    });
    await expect(controller.open()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledExactlyOnceWith('opening the window', error);
  });

  it('does not create a window after dispose', async () => {
    let finishClosing: () => void = () => undefined;
    const { controller, host, panels } = setup();
    host.closeStale.mockReturnValue(new Promise<void>((resolve) => (finishClosing = resolve)));
    const opening = controller.open();
    controller.dispose();
    finishClosing();
    await opening;
    expect(panels).toHaveLength(0);
  });
});

describe('the open window', () => {
  it('shows every change of the store', async () => {
    const { controller, panels, store } = setup();
    await controller.open();
    await store.increment();
    await store.reset();
    expect(panels[0]?.posted.map((m) => m.count)).toEqual([1, 0]);
  });

  it('is sent the state again by refresh, with the current message', async () => {
    const { controller, panels, settings } = setup();
    await controller.open();
    settings.message = 'New';
    controller.refresh();
    expect(panels[0]?.posted).toEqual([{ type: 'state', count: 0, message: 'New' }]);
  });

  it('gets nothing after it was closed: not from the store, not from a late message', async () => {
    const { controller, panels, store, warn } = setup();
    await controller.open();
    panels[0]?.dispose();
    await store.increment();
    panels[0]?.send({ type: 'ready' });
    controller.refresh();
    expect(panels[0]?.postCalls).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('stops listening to the store when the controller is disposed, and keeps the panel', async () => {
    const { controller, panels, store } = setup();
    await controller.open();
    controller.dispose();
    await store.increment();
    expect(panels[0]?.posted).toEqual([]);
    expect(panels[0]?.disposed).toBe(false);
  });

  it('logs a failed post instead of throwing', async () => {
    const { controller, panels, warn } = setup();
    await controller.open();
    const panel = panels[0];
    expect(panel).toBeDefined();
    vi.spyOn(panel as FakePanel, 'post').mockReturnValue(Promise.reject(new Error('gone')));
    panel?.send({ type: 'ready' });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('gone')));
  });

  it('increments through a message and reports a failed save', async () => {
    const { controller, panels, store, onError } = setup();
    await controller.open();
    vi.spyOn(store, 'increment').mockRejectedValue(new Error('disk'));
    panels[0]?.send({ type: 'increment' });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0]?.[0]).toBe('incrementing the counter');
  });
});

describe('WindowController.restore', () => {
  it('wires a restored panel like a new one when none is open', () => {
    const { controller, calls } = setup();
    const restored = new FakePanel(calls);
    controller.restore(restored);
    expect(calls.indexOf('onMessage')).toBeLessThan(calls.indexOf('setHtml'));
    restored.send({ type: 'ready' });
    expect(restored.posted).toEqual([{ type: 'state', count: 0, message: 'Hi' }]);
  });

  it('closes a restored panel when a window is already open, and reveals the open one', async () => {
    const { controller, panels, calls } = setup();
    await controller.open();
    const restored = new FakePanel(calls);
    controller.restore(restored);
    expect(restored.disposed).toBe(true);
    expect(panels[0]?.reveals).toBe(1);
    expect(panels[0]?.disposed).toBe(false);
  });

  it('counts a restored panel as the one window', async () => {
    const { controller, panels, calls } = setup();
    const restored = new FakePanel(calls);
    controller.restore(restored);
    await controller.open();
    expect(panels).toHaveLength(0);
    expect(restored.reveals).toBe(1);
  });
});

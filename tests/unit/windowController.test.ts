import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CounterStore } from '../../src/counterStore';
import type { ToWebview } from '../../src/protocol';
import type { Settings } from '../../src/settings';
import {
  REPLACE_AFTER_MS,
  WindowController,
  isWindowType,
  type PanelHandle,
  type VisibleTab,
  type WindowHost,
  type WindowPlace,
} from '../../src/windowController';

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
  const created: WindowPlace[] = [];
  const settings: Settings = {
    message: 'Hi',
    step: 1,
    showStatusBar: true,
    openLocation: 'tab',
    ...initial,
  };
  const host = {
    closeStale: vi.fn((): Promise<void> => Promise.resolve()),
    visible: undefined as VisibleTab | undefined,
    visibleTab(): VisibleTab | undefined {
      return host.visible;
    },
    create(place: WindowPlace): FakePanel {
      calls.push('create');
      created.push(place);
      const panel = new FakePanel(calls);
      panels.push(panel);
      return panel;
    },
    closeStaleTabs(): Promise<void> {
      calls.push('closeStaleTabs');
      return host.closeStale();
    },
  } satisfies WindowHost & { closeStale: () => Promise<void>; visible: VisibleTab | undefined };
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

describe('WindowController.watch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A controller whose host shows a Demo tab that nobody handed over, like after a restart. */
  function setupDead(tab: Partial<VisibleTab> = {}) {
    const all = setup();
    const { host, calls } = all;
    const close = vi.fn((): Promise<void> => {
      calls.push('closeDead');
      host.visible = undefined;
      return Promise.resolve();
    });
    const dead: VisibleTab = { column: 1, close, ...tab };
    host.visible = dead;
    return { ...all, dead, close };
  }

  const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const IN_BOTH_HALVES = [REPLACE_AFTER_MS / 4, REPLACE_AFTER_MS - 1];

  it('replaces a window that is visible on activation and not handed over', async () => {
    const { controller, panels, created, close } = setupDead();
    controller.watch();
    await wait(REPLACE_AFTER_MS - 1);
    expect(panels).toHaveLength(0);
    await wait(1);
    expect(created).toEqual([{ column: 1 }]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('wires the new window like any other', async () => {
    const { controller, panels } = setupDead();
    controller.watch();
    await wait(REPLACE_AFTER_MS);
    panels[0]?.send({ type: 'ready' });
    expect(panels[0]?.posted).toEqual([{ type: 'state', count: 0, message: 'Hi' }]);
  });

  it('opens the new window before it closes the dead one, so that the group stays', async () => {
    const { controller, calls } = setupDead();
    controller.watch();
    await wait(REPLACE_AFTER_MS);
    expect(calls.indexOf('create')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('create')).toBeLessThan(calls.indexOf('closeDead'));
  });

  it('stays in the group of the dead window', async () => {
    const { controller, created } = setupDead({ column: 2 });
    controller.watch();
    await wait(REPLACE_AFTER_MS);
    expect(created).toEqual([{ column: 2 }]);
  });

  it('leaves a hidden window alone until it is shown', async () => {
    const { controller, host, panels, dead, close } = setupDead();
    host.visible = undefined;
    controller.watch();
    await wait(10 * REPLACE_AFTER_MS);
    expect(panels).toHaveLength(0);
    expect(close).not.toHaveBeenCalled();

    host.visible = dead;
    controller.watch();
    await wait(REPLACE_AFTER_MS);
    expect(panels).toHaveLength(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each(IN_BOTH_HALVES)(
    'gives a window that is hidden and shown again after %i ms the whole time',
    async (ms) => {
      const { controller, host, panels, dead } = setupDead();
      controller.watch();
      await wait(ms);
      host.visible = undefined;
      controller.watch();
      host.visible = dead;
      controller.watch();
      await wait(REPLACE_AFTER_MS - 1);
      expect(panels).toHaveLength(0);
      await wait(1);
      expect(panels).toHaveLength(1);
    },
  );

  it('does not wait longer because tabs keep changing', async () => {
    const { controller, panels } = setupDead();
    for (let passed = 0; passed < REPLACE_AFTER_MS; passed += REPLACE_AFTER_MS / 4) {
      controller.watch();
      await wait(REPLACE_AFTER_MS / 4);
    }
    expect(panels).toHaveLength(1);
  });

  it('does nothing if the tab is gone or hidden when the time is up', async () => {
    const { controller, host, panels, close } = setupDead();
    controller.watch();
    host.visible = undefined;
    await wait(REPLACE_AFTER_MS);
    expect(panels).toHaveLength(0);
    expect(close).not.toHaveBeenCalled();
  });

  it('uses the group where the tab is when the time is up', async () => {
    const { controller, host, created, dead } = setupDead();
    controller.watch();
    host.visible = { ...dead, column: 3 };
    await wait(REPLACE_AFTER_MS);
    expect(created).toEqual([{ column: 3 }]);
  });

  it('does nothing if VS Code restored the window before, as after a window reload', async () => {
    const { controller, panels, calls, close } = setupDead();
    controller.restore(new FakePanel(calls));
    controller.watch();
    await wait(REPLACE_AFTER_MS);
    expect(panels).toHaveLength(0);
    expect(close).not.toHaveBeenCalled();
  });

  it.each(IN_BOTH_HALVES)('does nothing if VS Code restores the window after %i ms', async (ms) => {
    const { controller, panels, calls, close } = setupDead();
    controller.watch();
    await wait(ms);
    const restored = new FakePanel(calls);
    controller.restore(restored);
    await wait(10 * REPLACE_AFTER_MS);
    expect(panels).toHaveLength(0);
    expect(close).not.toHaveBeenCalled();
    expect(restored.disposed).toBe(false);
  });

  it('does nothing if the extension host was blocked and VS Code restores the window after it', async () => {
    const { controller, panels, calls, close } = setupDead();
    controller.watch();
    // After a block, a timer that is due runs before the messages that came in the meantime.
    vi.advanceTimersToNextTimer();
    const restored = new FakePanel(calls);
    controller.restore(restored);
    await wait(10 * REPLACE_AFTER_MS);
    expect(panels).toHaveLength(0);
    expect(close).not.toHaveBeenCalled();
    expect(restored.disposed).toBe(false);
  });

  it('keeps one window if VS Code restores the old one after all, while it is closed', async () => {
    let finishClosing: () => void = () => undefined;
    const { controller, panels, calls } = setupDead({
      close: () => new Promise<void>((resolve) => (finishClosing = resolve)),
    });
    controller.watch();
    await wait(REPLACE_AFTER_MS);
    const restored = new FakePanel(calls);
    controller.restore(restored);
    finishClosing();
    await wait(10 * REPLACE_AFTER_MS);
    expect(panels).toHaveLength(1);
    expect(panels[0]?.disposed).toBe(false);
    expect(restored.disposed).toBe(true);
    // Nobody asked for the window, so it does not come to the front.
    expect(panels[0]?.reveals).toBe(0);
  });

  it('reveals the new window again for a restored one once the dead one is closed', async () => {
    const { controller, panels, calls } = setupDead();
    controller.watch();
    await wait(REPLACE_AFTER_MS);
    const restored = new FakePanel(calls);
    controller.restore(restored);
    expect(restored.disposed).toBe(true);
    expect(panels[0]?.reveals).toBe(1);
  });

  it('opens one window if the user opens it while it waits', async () => {
    const { controller, host, panels, close } = setupDead();
    let finishClosing: () => void = () => undefined;
    host.closeStale.mockReturnValue(new Promise<void>((resolve) => (finishClosing = resolve)));
    controller.watch();
    await wait(REPLACE_AFTER_MS - 1);
    const opening = controller.open();
    // Still preparing the window when the time is up: the old tab is there, the panel is not.
    await wait(10 * REPLACE_AFTER_MS);
    expect(panels).toHaveLength(0);
    finishClosing();
    await opening;
    controller.watch();
    await wait(10 * REPLACE_AFTER_MS);
    expect(panels).toHaveLength(1);
    expect(close).not.toHaveBeenCalled();
  });

  it('reveals the new window if the user opens it while the dead one is closed', async () => {
    const { controller, host, panels } = setupDead({ close: () => new Promise(() => undefined) });
    controller.watch();
    await wait(REPLACE_AFTER_MS);
    await controller.open();
    expect(panels).toHaveLength(1);
    expect(panels[0]?.reveals).toBe(1);
    expect(host.closeStale).not.toHaveBeenCalled();
  });

  it.each(IN_BOTH_HALVES)(
    'does nothing after dispose, %i ms into the wait, nor for a later change of tabs',
    async (ms) => {
      const { controller, panels, close } = setupDead();
      controller.watch();
      await wait(ms);
      controller.dispose();
      expect(vi.getTimerCount()).toBe(0);
      controller.watch();
      expect(vi.getTimerCount()).toBe(0);
      await wait(10 * REPLACE_AFTER_MS);
      expect(panels).toHaveLength(0);
      expect(close).not.toHaveBeenCalled();
    },
  );

  it('leaves no timer behind once the window is replaced', async () => {
    const { controller } = setupDead();
    controller.watch();
    await wait(REPLACE_AFTER_MS);
    controller.watch();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('logs a failure to close the dead window and keeps the one new window', async () => {
    const { controller, panels, warn, onError } = setupDead({
      close: () => Promise.reject(new Error('no way')),
    });
    controller.watch();
    await wait(REPLACE_AFTER_MS);
    expect(warn).toHaveBeenCalledExactlyOnceWith('Could not close the dead window: no way');
    expect(onError).not.toHaveBeenCalled();
    controller.watch();
    await wait(10 * REPLACE_AFTER_MS);
    expect(panels).toHaveLength(1);
    expect(panels[0]?.disposed).toBe(false);
  });

  it('logs a failure to look at the tabs when the time is up', async () => {
    const { controller, host, panels, warn } = setupDead();
    controller.watch();
    vi.spyOn(host, 'visibleTab').mockImplementationOnce(() => {
      throw new Error('no tabs');
    });
    await wait(REPLACE_AFTER_MS);
    expect(warn).toHaveBeenCalledExactlyOnceWith('Could not look at the tabs: no tabs');
    expect(panels).toHaveLength(0);
  });

  it('logs a failure to look at the tabs when they change and tries again later', async () => {
    const { controller, host, panels, warn } = setupDead();
    vi.spyOn(host, 'visibleTab').mockImplementationOnce(() => {
      throw new Error('no tabs');
    });
    expect(() => {
      controller.watch();
    }).not.toThrow();
    expect(warn).toHaveBeenCalledExactlyOnceWith('Could not look at the tabs: no tabs');
    controller.watch();
    await wait(REPLACE_AFTER_MS);
    expect(panels).toHaveLength(1);
  });

  it('closes the dead window also if the new one has no page', async () => {
    const { controller, panels, close, warn } = setupDead();
    const setHtml = vi.spyOn(FakePanel.prototype, 'setHtml').mockImplementation(() => {
      throw new Error('no page');
    });
    controller.watch();
    await wait(REPLACE_AFTER_MS);
    setHtml.mockRestore();
    expect(warn).toHaveBeenCalledExactlyOnceWith('Could not open a new window: no page');
    expect(close).toHaveBeenCalledTimes(1);
    controller.watch();
    await wait(REPLACE_AFTER_MS);
    expect(panels).toHaveLength(1);
  });

  it('logs a failure to create the window, keeps the dead one and tries again later', async () => {
    const { controller, host, panels, close, warn, onError } = setupDead();
    vi.spyOn(host, 'create').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    controller.watch();
    await wait(REPLACE_AFTER_MS);
    expect(warn).toHaveBeenCalledExactlyOnceWith('Could not open a new window: boom');
    expect(onError).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    controller.watch();
    await wait(REPLACE_AFTER_MS);
    expect(panels).toHaveLength(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('isWindowType', () => {
  it.each(['vscodeExtDemo.window', 'mainThreadWebview-vscodeExtDemo.window'])(
    'knows %s as the Demo window',
    (type) => {
      expect(isWindowType(type)).toBe(true);
    },
  );

  it.each([
    'mainThreadWebview-other.vscodeExtDemo.window',
    'mainThreadWebview-myvscodeExtDemo.window',
    'mainThreadWebview-vscodeExtDemo.window2',
    '',
  ])('does not take %j for it', (type) => {
    expect(isWindowType(type)).toBe(false);
  });
});

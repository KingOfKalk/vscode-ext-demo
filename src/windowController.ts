import type { ReportError } from './counterActions';
import { describeError } from './describe';
import type { ToWebview } from './protocol';
import type { Settings } from './settings';
import {
  buildState,
  handleWebviewMessage,
  type MessageDeps,
  type MessageLog,
} from './windowMessages';

/** The part of a VS Code webview panel that the window needs. */
export interface PanelHandle {
  reveal(): void;
  dispose(): void;
  post(message: ToWebview): PromiseLike<boolean>;
  onMessage(listener: (raw: unknown) => void): { dispose(): void };
  onDispose(listener: () => void): { dispose(): void };
  /** Sets the page of the window. Its script posts `ready` once it runs. */
  setHtml(): void;
}

/** Where a new window opens: as the setting says, or in the group of another tab. */
export type WindowPlace = Settings['openLocation'] | { column: number; preserveFocus: boolean };

/** A window tab that is the active tab of its editor group. */
export interface VisibleTab {
  /** The editor group it is in. */
  readonly column: number;
  close(): Promise<void>;
}

/** What the window needs from VS Code. */
export interface WindowHost {
  create(place: WindowPlace): PanelHandle;
  visibleTab(): VisibleTab | undefined;
  /** Closes window tabs that VS Code restored but did not hand over yet. */
  closeStaleTabs(): Promise<void>;
}

/**
 * How long a visible window may go without being handed over. VS Code restores a window at once;
 * one that waits this long belongs to an extension host that is gone.
 */
export const REPLACE_AFTER_MS = 2000;

export interface WindowControllerDeps {
  host: WindowHost;
  store: MessageDeps['store'] & { onDidChange(listener: () => void): { dispose(): void } };
  log: MessageLog;
  getSettings: () => Settings;
  onError: ReportError;
}

/**
 * The Demo window: at most one panel. It only displays the store. A new panel and a panel
 * restored after a reload get the same wiring. Does not know about VS Code.
 */
export class WindowController {
  private panel: PanelHandle | undefined;
  private send: (() => void) | undefined;
  private release: (() => void) | undefined;
  /** Set while a new window is being prepared, so quick calls share one window. */
  private opening: Promise<void> | undefined;
  /** Set while a visible window that was not handed over is given time for it. */
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly deps: WindowControllerDeps) {}

  /**
   * Shows the window, or reveals it if it is open. Failures while opening the window (closing old
   * tabs, creating the panel) are logged or go to `onError`; they do not reject. `reveal()` of an
   * open window is not guarded: if it throws, this call throws (or rejects, when the window opened
   * while an earlier call was still preparing it).
   */
  open(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      return Promise.resolve();
    }
    this.opening ??= this.openNew().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  /** Takes over a panel that VS Code restored. Only one window may exist. */
  restore(panel: PanelHandle): void {
    if (this.panel) {
      this.deps.log.info('Window already open; closing the restored one');
      panel.dispose();
      this.panel.reveal();
      return;
    }
    this.attach(panel);
  }

  /** Sends the state again, for example after the `message` setting changed. */
  refresh(): void {
    this.send?.();
  }

  /**
   * Looks for a dead window; call it on activation and when tabs change. After a restart of the
   * extension host, VS Code still shows the old window, but never hands it over. A window that
   * stays visible without being handed over is replaced. A hidden one is left alone until it is
   * shown: VS Code may be about to restore it.
   */
  watch(): void {
    if (this.findDead()) {
      this.watchdog ??= setTimeout(() => {
        this.watchdog = undefined;
        void this.replaceDead();
      }, REPLACE_AFTER_MS);
    } else {
      this.stopWatchdog();
    }
  }

  /**
   * Stops listening to the store and watching the tabs. The panel itself stays: closing it on
   * shutdown would keep it from coming back after a reload.
   */
  dispose(): void {
    this.disposed = true;
    this.stopWatchdog();
    this.release?.();
  }

  private async openNew(): Promise<void> {
    const { host, log, getSettings, onError } = this.deps;
    // VS Code hands a restored panel over only when it first becomes visible; until then it is
    // an old tab that we do not know. Close such tabs so that only one window exists.
    try {
      await host.closeStaleTabs();
    } catch (error) {
      log.warn(`Could not close old window tabs: ${describeError(error)}`);
    }
    if (this.disposed) {
      return;
    }
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    try {
      this.attach(host.create(getSettings().openLocation));
    } catch (error) {
      onError('opening the window', error);
    }
  }

  /** The visible window that belongs to nobody. */
  private findDead(): VisibleTab | undefined {
    if (this.panel || this.opening || this.disposed) {
      return undefined;
    }
    return this.deps.host.visibleTab();
  }

  /** Never rejects. */
  private async replaceDead(): Promise<void> {
    const { host, log } = this.deps;
    try {
      const dead = this.findDead();
      if (!dead) {
        return;
      }
      log.info('Replacing a window that lost its extension host');
      // The new one first: a group whose only tab is closed goes away. From here on the new one
      // is the window, also if VS Code hands the old one over after all.
      // Never with the focus: nobody asked for a window, and the user may be typing elsewhere.
      this.attach(host.create({ column: dead.column, preserveFocus: true }));
      await dead.close();
    } catch (error) {
      log.warn(`Could not replace the window: ${describeError(error)}`);
    }
  }

  private stopWatchdog(): void {
    clearTimeout(this.watchdog);
    this.watchdog = undefined;
  }

  private attach(panel: PanelHandle): void {
    const { store, log, getSettings, onError } = this.deps;
    let closed = false;

    const post = (message: ToWebview): void => {
      if (closed) {
        return;
      }
      try {
        Promise.resolve(panel.post(message)).catch((error: unknown) => {
          log.warn(`Could not post to the window: ${describeError(error)}`);
        });
      } catch (error) {
        log.warn(`Could not post to the window: ${describeError(error)}`);
      }
    };
    const send = (): void => {
      post(buildState(store.count, getSettings().message));
    };

    // The handler is in place before the page exists, so its `ready` is never missed.
    const subscriptions: { dispose(): void }[] = [
      panel.onMessage((raw) => {
        void handleWebviewMessage(raw, {
          store,
          message: () => getSettings().message,
          post,
          log,
          onError,
        });
      }),
      store.onDidChange(send),
    ];
    const release = (): void => {
      closed = true;
      for (const subscription of subscriptions.splice(0)) {
        subscription.dispose();
      }
    };
    subscriptions.push(
      panel.onDispose(() => {
        release();
        if (this.panel === panel) {
          this.panel = undefined;
          this.send = undefined;
          this.release = undefined;
        }
      }),
    );

    this.panel = panel;
    this.send = send;
    this.release = release;
    panel.setHtml();
  }
}

// One pause at a breakpoint. The process of the inspector is never left paused by it: not after a
// failure, and not after an interrupt. If this process is killed, V8 continues when its last debugger
// is gone. VS Code leaves one in an extension host that did not answer for 3 s, so a pause is short.
import type { Debugger } from 'node:inspector';
import { setTimeout as sleep } from 'node:timers/promises';
import { ActionError, userError } from './errors.ts';
import { InspectorError, type Inspector } from './inspector.ts';
import type { GeneratedPosition } from './sourceMap.ts';

const CLEANUP_TIMEOUT_MS = 5000;
const ASYNC_STACK_DEPTH = 8;

export type Pause = Debugger.PausedEventDataType;

export interface PauseRequest {
  /** The place in TypeScript, for the errors. */
  what: string;
  /** Of the script. */
  url: string;
  position: GeneratedPosition;
  /** Started when the breakpoint is set; what makes the line run. Returns what it did. */
  trigger?: (() => Promise<string>) | undefined;
  hitTimeoutMs: number;
  /** For `look`. */
  lookTimeoutMs: number;
  triggerTimeoutMs: number;
  signal: AbortSignal;
  /** V8 says where the breakpoint is: the next place at which it can stop. */
  onSet?: (location: Debugger.Location) => void;
}

/** The breakpoint was not hit in time. */
export class NoHitError extends ActionError {
  override name = 'NoHitError';
}

/** Rejects after the time, until it is stopped. */
function timeLimit(
  timeoutMs: number,
  error: () => Error,
): { over: Promise<never>; stop: () => void } {
  const timer = new AbortController();
  const over = sleep(timeoutMs, undefined, { signal: timer.signal }).then(() => {
    throw error();
  });
  over.catch(() => undefined);
  return {
    over,
    stop: () => {
      timer.abort();
    },
  };
}

/** The process paused somewhere else. */
export class OtherPauseError extends ActionError {
  override name = 'OtherPauseError';
  readonly pause: Pause;

  constructor(message: string, pause: Pause) {
    super(message);
    this.pause = pause;
  }
}

/** Like `Promise.race` with a promise that the signal rejects. */
export async function unlessAborted<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let stop: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    stop = () => {
      reject(signal.reason as Error);
    };
    signal.addEventListener('abort', stop);
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (stop) signal.removeEventListener('abort', stop);
  }
}

async function runWithin(timeoutMs: number, run: () => Promise<string>): Promise<string> {
  const limit = timeLimit(
    timeoutMs,
    () => new ActionError(`it did not end within ${timeoutMs / 1000} s`),
  );
  try {
    return await Promise.race([run(), limit.over]);
  } catch (error) {
    throw new ActionError(`--do failed: ${userError(error).message}`);
  } finally {
    limit.stop();
  }
}

/**
 * Sets a breakpoint, starts the trigger, waits for the hit, lets `look` see it, and continues.
 * @returns what `look` returned, and the trigger, which may still be at work
 */
export async function pauseAt<T>(
  inspector: Inspector,
  request: PauseRequest,
  look: (pause: Pause) => Promise<T>,
): Promise<{ seen: T; trigger: Promise<string> | undefined }> {
  const signal = AbortSignal.any([request.signal, inspector.closed]);
  let pause: Pause | undefined;
  let onHit: (event: Pause) => void = () => undefined;
  const hit = new Promise<Pause>((resolve) => {
    onHit = resolve;
  });
  const stopListening = [
    inspector.on('Debugger.paused', (event) => {
      pause = event;
      onHit(event);
    }),
    inspector.on('Debugger.resumed', () => {
      pause = undefined;
    }),
  ];
  let setting: Promise<Debugger.SetBreakpointByUrlReturnType> | undefined;
  let pausedBefore = false;
  let trigger: Promise<string> | undefined;
  let triggered = '--do is still at work';
  const start = (): Promise<never> | undefined => {
    if (!request.trigger) return undefined;
    trigger = runWithin(request.triggerTimeoutMs, request.trigger);
    // Only a failure ends the wait.
    return trigger.then((text) => {
      triggered = `--do: ${text}`;
      return new Promise<never>(() => undefined);
    });
  };

  const run = async (): Promise<T> => {
    await inspector.send('Debugger.enable');
    await inspector.send('Debugger.setAsyncCallStackDepth', { maxDepth: ASYNC_STACK_DEPTH });
    // V8 tells about a pause that is there already.
    if (pause) {
      pausedBefore = true;
      throw new ActionError(
        'the extension host is already paused, by another debugger: continue there first. If there is none (one was killed), start VS Code again: npm run live -- stop, then start --keep',
      );
    }
    setting = inspector.send('Debugger.setBreakpointByUrl', {
      url: request.url,
      lineNumber: request.position.line,
      columnNumber: request.position.column,
    });
    const { breakpointId, locations } = await setting;
    signal.throwIfAborted();
    const [location] = locations;
    if (!location)
      throw new ActionError(`the running code has no place to stop at ${request.what}`);
    request.onSet?.(location);

    const failing = start();
    const tooLate = timeLimit(
      request.hitTimeoutMs,
      () =>
        new NoHitError(
          `${request.what}: no hit within ${request.hitTimeoutMs / 1000} s${request.trigger ? ` (${triggered})` : ''}`,
        ),
    );
    const found = await Promise.race([hit, tooLate.over, ...(failing ? [failing] : [])]).finally(
      tooLate.stop,
    );
    if (!(found.hitBreakpoints ?? []).includes(breakpointId)) {
      throw new OtherPauseError(
        `the extension host paused, but not at the breakpoint at ${request.what} (${found.reason}): a debugger statement, or a breakpoint of another debugger; it continues`,
        found,
      );
    }
    const tooLong = timeLimit(
      request.lookTimeoutMs,
      () =>
        new ActionError(
          `looking at the pause took longer than ${request.lookTimeoutMs / 1000} s; the extension host continues`,
        ),
    );
    return Promise.race([lookAt(found), tooLong.over]).finally(tooLong.stop);
  };

  const lookAt = async (found: Pause): Promise<T> => {
    try {
      return await look(found);
    } catch (error) {
      if (pause || inspector.closed.aborted) throw error;
      throw new ActionError('another debugger continued the extension host during the pause');
    }
  };

  /**
   * In this order nothing can pause in between: the answer to the first comes after a last hit.
   * Also a pause that is not at the breakpoint: it came after this debugger, perhaps because of it.
   */
  const release = async (): Promise<void> => {
    const set = await setting?.catch(() => undefined);
    if (set) {
      const { breakpointId } = set;
      await inspector.send('Debugger.removeBreakpoint', { breakpointId }, CLEANUP_TIMEOUT_MS);
    }
    if (pause && !pausedBefore) {
      const resumed = inspector.next('Debugger.resumed', AbortSignal.timeout(CLEANUP_TIMEOUT_MS));
      resumed.catch(() => undefined);
      await inspector
        .send('Debugger.resume', undefined, CLEANUP_TIMEOUT_MS)
        .catch((error: unknown) => {
          // Another debugger was faster.
          if (!(error instanceof InspectorError && pause === undefined)) throw error;
        });
      if (pause as Pause | undefined) await resumed;
    }
    await inspector.send('Debugger.disable', undefined, CLEANUP_TIMEOUT_MS);
  };

  try {
    const seen = await unlessAborted(signal, run());
    await release();
    return { seen, trigger };
  } catch (error) {
    // A failing trigger was told, or comes too late to matter.
    trigger?.catch(() => undefined);
    try {
      await release();
    } catch (releaseError) {
      // The end of the connection is the last chance: V8 drops the breakpoint then.
      const ended = inspector.closed.aborted;
      inspector.close();
      if (!ended) {
        throw new ActionError(
          `${userError(error).message}\nAnd the extension host may still be paused (${userError(releaseError).message}). If it is: npm run live -- stop, then start --keep`,
        );
      }
    }
    throw error;
  } finally {
    for (const stop of stopListening) stop();
  }
}

/** Throws if the process does not run its event loop. */
export async function assertContinues(inspector: Inspector): Promise<void> {
  await inspector.send(
    'Runtime.evaluate',
    {
      expression: 'new Promise((resolve) => setTimeout(resolve, 0))',
      awaitPromise: true,
      disableBreaks: true,
    },
    CLEANUP_TIMEOUT_MS,
  );
}

// One pause at a breakpoint. The process of the inspector is never left paused by it: not after a
// failure, and not after an interrupt. If this process is killed, V8 continues when its last debugger
// is gone. VS Code leaves one in an extension host that did not answer for 3 s, so a pause is short.
import type { Debugger } from 'node:inspector';
import { setTimeout as sleep } from 'node:timers/promises';
import { ActionError, userError } from './errors.ts';
import { InspectorError, type Inspector } from './inspector.ts';
import type { GeneratedPosition } from './sourceMap.ts';

const CLEANUP_MS = 5000;
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
  /**
   * How long the process may take to continue and to say so. Twice as long if the ID of the
   * breakpoint is still on its way: it is waited for first.
   */
  cleanupMs?: number;
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
 * @returns what `look` returned, and the trigger, which may still be at work; the process continues then
 */
export async function pauseAt<T>(
  inspector: Inspector,
  request: PauseRequest,
  look: (pause: Pause) => Promise<T>,
): Promise<{ seen: T; trigger: Promise<string> | undefined }> {
  const signal = AbortSignal.any([request.signal, inspector.closed]);
  signal.throwIfAborted();
  const cleanupMs = request.cleanupMs ?? CLEANUP_MS;
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
  let breakpointId: string | undefined;
  let setting: Promise<Debugger.SetBreakpointByUrlReturnType> | undefined;
  /** The process was not paused when this debugger came, so every pause is to be continued. */
  let checked = false;
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
      throw new ActionError(
        'the extension host is already paused, by another debugger: continue there first. If there is none (one was killed), start VS Code again: npm run live -- stop, then start --keep',
      );
    }
    checked = true;
    setting = inspector.send('Debugger.setBreakpointByUrl', {
      url: request.url,
      lineNumber: request.position.line,
      columnNumber: request.position.column,
    });
    const set = await setting;
    breakpointId = set.breakpointId;
    signal.throwIfAborted();
    const [location] = set.locations;
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
        `the extension host paused, but not at the breakpoint at ${request.what} (${found.reason}): a debugger statement, or a breakpoint of another debugger`,
        found,
      );
    }
    const tooLong = timeLimit(
      request.lookTimeoutMs,
      () =>
        new ActionError(`looking at the pause took longer than ${request.lookTimeoutMs / 1000} s`),
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
   * Waits for the ID of a breakpoint that is on its way, then sends everything at once, and only then
   * waits: a process that is blocked takes it when it can, in this order, also if nobody waits for it
   * any more. It also continues a pause that is not at the breakpoint: it came after this debugger,
   * perhaps because of it.
   */
  const release = async (): Promise<void> => {
    // Refused if nothing is paused, or if the debugger is not enabled yet.
    const unlessRefused = (error: unknown) => {
      if (!(error instanceof InspectorError)) throw error;
    };
    if (breakpointId === undefined && setting) {
      // Interrupted before the breakpoint had an answer. It is removed before the process continues:
      // V8 keeps it active while another debugger is attached, and a hit after the continue would
      // leave the process paused.
      const limit = timeLimit(cleanupMs, () => new Error('no answer'));
      try {
        breakpointId = (await Promise.race([setting, limit.over])).breakpointId;
      } catch {
        // Not set, or no answer yet: the process takes what follows after it.
      } finally {
        limit.stop();
      }
    }
    const answers: Promise<unknown>[] = [];
    const inactive = { active: false };
    if (checked) {
      // For a breakpoint whose ID did not come: works only if no other debugger is attached.
      answers.push(
        inspector.send('Debugger.setBreakpointsActive', inactive, cleanupMs).catch(unlessRefused),
      );
    }
    if (breakpointId !== undefined) {
      answers.push(inspector.send('Debugger.removeBreakpoint', { breakpointId }, cleanupMs));
    }
    if (checked) {
      answers.push(inspector.send('Debugger.resume', undefined, cleanupMs).catch(unlessRefused));
    }
    answers.push(inspector.send('Debugger.disable', undefined, cleanupMs));
    // Answered by the event loop, so it runs again.
    if (checked) answers.push(turnEventLoop(inspector, cleanupMs));
    await Promise.all(answers);
  };

  const outcome = await unlessAborted(signal, run()).then(
    (seen) => ({ seen }),
    (error: unknown) => ({ error }),
  );
  const wasPaused = checked && pause !== undefined;
  let note = wasPaused ? 'The extension host continues.' : undefined;
  let released = true;
  try {
    await release();
  } catch (error) {
    released = false;
    note = inspector.closed.aborted
      ? undefined
      : `It is not known whether the extension host continues (${userError(error).message}). It was told to, and does when nothing blocks it any more. If the window stays frozen: npm run live -- stop, then start --keep`;
    inspector.close();
  }
  for (const stop of stopListening) stop();

  if ('seen' in outcome && released) return { seen: outcome.seen, trigger };
  // A failing trigger was told, or comes too late to matter.
  trigger?.catch(() => undefined);
  if ('seen' in outcome) throw new ActionError(note ?? userError(inspector.closed.reason).message);
  const { error } = outcome;
  if (note !== undefined && error instanceof Error) error.message += `\n${note}`;
  throw error;
}

/** Waits until the process ran its event loop, which it does not if it is paused or busy. */
export async function turnEventLoop(inspector: Inspector, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  const { result } = await inspector.send(
    'Runtime.evaluate',
    {
      expression: 'new Promise((resolve) => setTimeout(resolve, 0))',
      disableBreaks: true,
      silent: true,
    },
    timeoutMs,
  );
  // Not `awaitPromise` of the first command: V8 may lose that promise, but not one that it handed out.
  const promiseObjectId = result.objectId ?? '';
  await inspector.send('Runtime.awaitPromise', { promiseObjectId }, Math.max(1, end - Date.now()));
}

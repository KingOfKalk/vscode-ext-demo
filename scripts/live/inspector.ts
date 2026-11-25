// A client of the Node inspector: the Chrome DevTools protocol over a WebSocket.
import { EventEmitter, once } from 'node:events';
import type { Debugger, Runtime } from 'node:inspector';
import { ActionError } from './errors.ts';

const CONNECT_TIMEOUT_MS = 5000;
const ANSWER_TIMEOUT_MS = 10_000;

/** Parameters that Node's own types do not have, because the protocol calls them experimental. */
interface Timeout {
  /** Ends the JavaScript after this time. */
  timeout?: number;
}

/** The commands that are used here: what they take and return. */
export interface Commands {
  'NodeRuntime.notifyWhenWaitingForDisconnect': [{ enabled: boolean }, unknown];
  'Debugger.enable': [undefined, unknown];
  'Debugger.disable': [undefined, unknown];
  'Debugger.pause': [undefined, unknown];
  'Debugger.resume': [undefined, unknown];
  'Debugger.setAsyncCallStackDepth': [Debugger.SetAsyncCallStackDepthParameterType, unknown];
  'Debugger.getScriptSource': [
    Debugger.GetScriptSourceParameterType,
    Debugger.GetScriptSourceReturnType,
  ];
  'Debugger.setBreakpointByUrl': [
    Debugger.SetBreakpointByUrlParameterType,
    Debugger.SetBreakpointByUrlReturnType,
  ];
  'Debugger.removeBreakpoint': [Debugger.RemoveBreakpointParameterType, unknown];
  'Debugger.evaluateOnCallFrame': [
    Debugger.EvaluateOnCallFrameParameterType & Timeout,
    Debugger.EvaluateOnCallFrameReturnType,
  ];
  'Runtime.evaluate': [
    Runtime.EvaluateParameterType & Timeout & { disableBreaks?: boolean },
    Runtime.EvaluateReturnType,
  ];
  'Runtime.callFunctionOn': [Runtime.CallFunctionOnParameterType, Runtime.CallFunctionOnReturnType];
  'Runtime.getProperties': [Runtime.GetPropertiesParameterType, Runtime.GetPropertiesReturnType];
}

export interface Events {
  'Debugger.scriptParsed': Debugger.ScriptParsedEventDataType;
  'Debugger.paused': Debugger.PausedEventDataType;
  'Debugger.resumed': unknown;
}

type Name = keyof Commands;
type Parameters<N extends Name> = Commands[N][0];
type Result<N extends Name> = Commands[N][1];

/** The inspector answered with an error. */
export class InspectorError extends ActionError {
  override name = 'InspectorError';
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** The inspector did not answer in time. */
export class NoAnswerError extends ActionError {
  override name = 'NoAnswerError';
}

interface Waiting {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

interface Message {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
  method?: string;
  params?: unknown;
}

/** The address of the only process that this port is of. */
export async function inspectorUrl(port: number): Promise<string> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
    const [target] = (await response.json()) as { webSocketDebuggerUrl?: string }[];
    if (target?.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
  } catch {
    // Nothing listens, or something that is no inspector.
  }
  throw new ActionError(
    `the extension host has no debugger at 127.0.0.1:${port}; it may be starting again, or it crashed (see: npm run live -- logs); if it stays so: npm run live -- reload`,
  );
}

export class Inspector {
  readonly #socket: WebSocket;
  readonly #waiting = new Map<number, Waiting>();
  readonly #events = new EventEmitter();
  readonly #closed = new AbortController();
  #lastId = 0;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener('message', ({ data }) => {
      this.#receive(JSON.parse(String(data)) as Message);
    });
    socket.addEventListener('close', () => {
      const error = new ActionError('the extension host closed the connection (did it end?)');
      this.#closed.abort(error);
      for (const { reject } of this.#waiting.values()) reject(error);
      this.#waiting.clear();
    });
  }

  static async connect(url: string): Promise<Inspector> {
    const socket = new WebSocket(url);
    const inspector = new Inspector(socket);
    await new Promise<void>((resolve, reject) => {
      const fail = () => {
        clearTimeout(timer);
        reject(new ActionError('cannot connect to the debugger of the extension host'));
        socket.close();
      };
      const timer = setTimeout(fail, CONNECT_TIMEOUT_MS);
      socket.addEventListener('error', fail);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    // A process that ends waits for its debuggers to leave.
    inspector.#events.once('NodeRuntime.waitingForDisconnect', () => {
      inspector.close();
    });
    await inspector.send('NodeRuntime.notifyWhenWaitingForDisconnect', { enabled: true });
    return inspector;
  }

  /** Aborted when the connection ends, from either side. */
  get closed(): AbortSignal {
    return this.#closed.signal;
  }

  close(): void {
    this.#socket.close();
  }

  send<N extends Name>(
    method: N,
    ...[params, timeoutMs = ANSWER_TIMEOUT_MS]: Parameters<N> extends undefined
      ? [params?: undefined, timeoutMs?: number]
      : [params: Parameters<N>, timeoutMs?: number]
  ): Promise<Result<N>> {
    if (this.closed.aborted) return Promise.reject(this.closed.reason as Error);
    const id = ++this.#lastId;
    return new Promise<Result<N>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id);
        reject(
          new NoAnswerError(
            `the extension host gave no answer within ${timeoutMs / 1000} s (${method}); is it busy, or paused by another debugger?`,
          ),
        );
      }, timeoutMs);
      this.#waiting.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Returns a function that stops listening. */
  on<E extends keyof Events>(event: E, listener: (data: Events[E]) => void): () => void {
    this.#events.on(event, listener);
    return () => {
      this.#events.off(event, listener);
    };
  }

  /** The next event of this kind. Rejects with the reason of the signal. */
  async next<E extends keyof Events>(event: E, signal: AbortSignal): Promise<Events[E]> {
    const both = AbortSignal.any([signal, this.closed]);
    both.throwIfAborted();
    try {
      const [data] = (await once(this.#events, event, { signal: both })) as [Events[E]];
      return data;
    } catch (error) {
      both.throwIfAborted();
      throw error;
    }
  }

  #receive({ id, result, error, method, params }: Message): void {
    if (id === undefined) {
      if (method !== undefined) this.#events.emit(method, params);
      return;
    }
    const waiting = this.#waiting.get(id);
    this.#waiting.delete(id);
    if (error) waiting?.reject(new InspectorError(error.code, error.message));
    else waiting?.resolve(result);
  }
}

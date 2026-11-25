// `eval` and `break`: the debugger of the extension host, in terms of the TypeScript files.
import { existsSync, readFileSync } from 'node:fs';
import type { Debugger, Runtime } from 'node:inspector';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LiveCommand, Trigger } from './args.ts';
import { ActionError } from './errors.ts';
import { evaluateExpression, evaluateInFrame, type FrameEvaluation } from './evaluate.ts';
import { Inspector, inspectorUrl } from './inspector.ts';
import { INSPECT_PORT } from './novnc.ts';
import { NoHitError, OtherPauseError, pauseAt, unlessAborted, type Pause } from './pause.ts';
import { ROOT } from './session.ts';
import { set } from './set.ts';
import {
  formatPosition,
  mapStackText,
  toGenerated,
  toSource,
  type GeneratedPosition,
  type SourcePosition,
} from './sourceMap.ts';
import { countFrames, cutLines, foldStack, formatRemote, MAX_TEXT, shorten } from './values.ts';
import { installedDir, ownRunningSession } from './vscode.ts';
import { onWindow } from './window.ts';

const HIT_TIMEOUT_MS = 15_000;
/** Its own: the hit may come long before the trigger has ended, or after it. */
const TRIGGER_TIMEOUT_MS = 20_000;
// VS Code takes an extension host for hung if it does not answer for 3 s, and attaches a profiler. If
// the host is paused then, the profiler never leaves, and V8 does not continue by itself any more when
// its debugger is killed. The limits of a pause keep JavaScript below that. They cannot end native code:
// an expression like `execSync('sleep 8')` blocks the host until it returns, and then it continues.
// `eval` does not pause; what blocks the host after an `await` is ended when the result is late.
// Expressions can read what the extension host can: `process.env` prints the environment of the session,
// where `sessionEnv` leaves out only what is named like a credential.
const EVAL_TIMEOUT_MS = 2000;
const EVAL_ANSWER_MS = 10_000;
/** In a pause: for all expressions together, and for everything. */
const FRAME_EVALS_MS = 1500;
const LOOK_TIMEOUT_MS = 2000;
const MAX_LOCALS = 30;
const MAX_LINES = 200;

const BUNDLE = 'dist/extension.js';
const BUNDLE_MAP = `${BUNDLE}.map`;
const RELOAD = 'run: npm run live -- reload';

// What is printed.

export interface RawFrame {
  functionName: string;
  scriptId: string;
  lineNumber: number;
  columnNumber: number;
}

export interface RawStack {
  frames: RawFrame[];
  /** What the next part was waiting for, like `await`. */
  description?: string | undefined;
  parent?: RawStack | undefined;
}

/** Where a frame is, or undefined if it is not of the extension. */
export type Locate = (frame: RawFrame) => string | undefined;

function nameOf({ functionName }: { functionName: string }): string {
  return functionName || '(anonymous)';
}

/** The frames of the extension; those between them are only counted. */
function describeFrames(frames: readonly RawFrame[], locate: Locate): string[] {
  const lines: string[] = [];
  let others = 0;
  const count = () => {
    if (others > 0) lines.push(countFrames(others));
    others = 0;
  };
  for (const frame of frames) {
    const where = locate(frame);
    if (where === undefined) {
      others++;
      continue;
    }
    count();
    lines.push(`${nameOf(frame)} (${where})`);
  }
  count();
  return lines;
}

/** The stack, and the stacks before each `await` as far back as the extension is in them. */
export function describeStack(stack: RawStack, locate: Locate): string[] {
  const own = (part: RawStack | undefined): boolean =>
    part !== undefined &&
    (part.frames.some((frame) => locate(frame) !== undefined) || own(part.parent));
  const lines = describeFrames(stack.frames, locate);
  for (let part = stack.parent; part && own(part); part = part.parent) {
    lines.push(`-- ${part.description || 'async'} --`, ...describeFrames(part.frames, locate));
  }
  return lines;
}

export interface Report {
  where: string;
  reason: string;
  stack: string[];
  /** Name of the top frame. */
  frame: string;
  locals: { name: string; text: string }[];
  /** How many are not shown. */
  moreLocals: number;
  values: ({ name: string } & FrameEvaluation)[];
}

const VERBS = { value: ' =', threw: ' threw', ended: ':' };

export function formatReport({
  where,
  reason,
  stack,
  frame,
  locals,
  moreLocals,
  values,
}: Report): string {
  const indent = (text: string) => text.replaceAll('\n', '\n  ');
  return [
    `Paused at ${where} (${reason})`,
    'Stack:',
    ...stack.map((line) => `  ${line}`),
    locals.length > 0 ? `Locals of ${frame}:` : `Locals of ${frame}: none`,
    ...locals.map(({ name, text }) => `  ${name} = ${text}`),
    ...(moreLocals > 0 ? [`  … ${moreLocals} more local${moreLocals === 1 ? '' : 's'}`] : []),
    ...(values.length > 0 ? ['Evaluated:'] : []),
    ...values.map(({ name, text, outcome }) => `  ${name}${VERBS[outcome]} ${indent(text)}`),
  ].join('\n');
}

/**
 * Where V8 put the breakpoint: the next place in the bundle at which it can stop. Throws if that is
 * none of the file any more.
 */
export function describePlace(
  file: string,
  line: number,
  source: SourcePosition | undefined,
  generated: GeneratedPosition,
): string {
  const inBundle = formatGenerated(generated);
  if (source?.file !== file || source.line < line) {
    const next = source ? formatPosition(source) : inBundle;
    throw new ActionError(
      `there is no place to stop at ${file}:${line} or after it in its file (the next one is ${next})`,
    );
  }
  const shifted = source.line === line ? '' : `, the next place to stop after line ${line}`;
  return `${formatPosition(source)} (${inBundle}${shifted})`;
}

export function describeNoHit(message: string, hasTrigger: boolean): string {
  const trigger = hasTrigger
    ? 'what --do did does not lead there'
    : 'nothing made it run; pass a trigger with --do';
  return [
    `${message}. The breakpoint is removed. Possible causes:`,
    `  the line did not run: ${trigger}`,
    '  the code runs somewhere else: another line or file, or only once, when the extension activates',
    '  it is a callback that is on the same line as the call it is passed to: break stops at the call, never in it',
    `  the window is not connected to the extension host any more, or runs a stale build; ${RELOAD}`,
  ].join('\n');
}

function formatGenerated({ line, column }: GeneratedPosition): string {
  return `${BUNDLE}:${line + 1}:${column + 1}`;
}

// The files.

interface Bundle {
  /** The installed file, which VS Code runs. */
  file: string;
  text: string;
  map: { sources: string[]; sourcesContent?: (string | null)[] };
}

function readBuilt(file: string): string {
  if (!existsSync(join(ROOT, file))) throw new ActionError(`there is no ${file}; ${RELOAD}`);
  return readFileSync(join(ROOT, file), 'utf8');
}

/** The bundle in dist/ with its map. Throws if it is not the installed one: then the map is wrong. */
function readBundle(): Bundle {
  const file = join(installedDir(), BUNDLE);
  const text = readBuilt(BUNDLE);
  if (readFileSync(file, 'utf8') !== text) {
    throw new ActionError(
      `the installed ${BUNDLE} is not the one in this checkout (built since?), so lines cannot be mapped; ${RELOAD}`,
    );
  }
  return { file, text, map: JSON.parse(readBuilt(BUNDLE_MAP)) as Bundle['map'] };
}

/** A file that changed since the build has its code on other lines. */
function assertUnchanged({ map }: Bundle, file: string): void {
  const source = join(ROOT, file);
  const index = map.sources.findIndex((name) => resolve(ROOT, 'dist', name) === source);
  const built = map.sourcesContent?.[index];
  if (existsSync(source) && readFileSync(source, 'utf8') === built) return;
  throw new ActionError(`${file} changed since the build, so its lines may be wrong; ${RELOAD}`);
}

// The commands.

/** Finds the script of the extension, and checks that the extension host runs this build. */
async function loadedScript(inspector: Inspector, url: string, { text }: Bundle): Promise<string> {
  let scriptId: string | undefined;
  const stop = inspector.on('Debugger.scriptParsed', (script) => {
    if (script.url === url) scriptId = script.scriptId;
  });
  try {
    // The scripts that are loaded come before the answer.
    await inspector.send('Debugger.enable');
    if (scriptId === undefined) {
      throw new ActionError(
        `the extension host has not loaded ${BUNDLE}: the extension is not active, or failed to start (see: npm run live -- logs)`,
      );
    }
    const { scriptSource } = await inspector.send('Debugger.getScriptSource', { scriptId });
    if (scriptSource !== text) {
      throw new ActionError(`the extension host still runs an older ${BUNDLE}; ${RELOAD}`);
    }
    return scriptId;
  } finally {
    stop();
    await inspector.send('Debugger.disable').catch(() => undefined);
  }
}

/** Aborted by a signal that asks this process to end; it does not end by itself then. */
function interruption(): AbortSignal {
  const abort = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      abort.abort(new ActionError(`interrupted by ${signal}`));
    });
  }
  return abort.signal;
}

async function withInspector<T>(use: (inspector: Inspector) => Promise<T>): Promise<T> {
  const inspector = await Inspector.connect(await inspectorUrl(INSPECT_PORT));
  try {
    return await use(inspector);
  } finally {
    inspector.close();
  }
}

/** Returns the text to print. Throws if the expression does, with what it threw. */
export async function evaluate(expression: string): Promise<string> {
  ownRunningSession();
  const requireFrom = join(installedDir(), BUNDLE);
  const signal = interruption();
  const { ok, text } = await withInspector((inspector) =>
    evaluateExpression(inspector, expression, {
      timeoutMs: EVAL_TIMEOUT_MS,
      answerMs: EVAL_ANSWER_MS,
      requireFrom,
      signal,
    }),
  );
  const shown = cutLines(foldStack(inTypeScript(text)), MAX_LINES, MAX_TEXT);
  if (!ok) throw new ActionError(`the expression threw ${shown}`);
  return shown;
}

/** With the places in TypeScript, if the build is the installed one; else with those in the bundle. */
function inTypeScript(text: string): string {
  if (!text.includes(`${BUNDLE}:`)) return text;
  try {
    const { map, file } = readBundle();
    return mapStackText(text, map, file);
  } catch (error) {
    return `${text}\n(places in ${BUNDLE}: ${error instanceof Error ? error.message : String(error)})`;
  }
}

/** Looks at a pause. Must be quick: the extension host waits. */
async function inspectPause(
  inspector: Inspector,
  pause: Pause,
  { bundle, locate, expressions, signal }: LookOptions,
): Promise<Report> {
  const [top] = pause.callFrames;
  if (!top) throw new ActionError('the extension host paused without a stack');
  const show = async (remote: Runtime.RemoteObject): Promise<string> =>
    shorten(await formatRemote(inspector, remote, { depth: 0, width: Infinity }), 160);

  const locals: Report['locals'] = [];
  if (top.this.type !== 'undefined') locals.push({ name: 'this', text: await show(top.this) });
  const variables = await readLocals(inspector, top);
  for (const { name, value } of variables.slice(0, MAX_LOCALS)) {
    signal.throwIfAborted();
    locals.push({ name, text: value ? await show(value) : '(no value yet)' });
  }

  const values: Report['values'] = [];
  const end = Date.now() + FRAME_EVALS_MS;
  for (const expression of expressions) {
    signal.throwIfAborted();
    const left = end - Date.now();
    const { outcome, text } =
      left > 0
        ? await evaluateInFrame(inspector, top.callFrameId, expression, left)
        : {
            outcome: 'ended' as const,
            text: `not evaluated, all --eval have ${FRAME_EVALS_MS / 1000} s`,
          };
    const mapped = foldStack(mapStackText(text, bundle.map, bundle.file));
    values.push({ name: expression, outcome, text: cutLines(mapped, MAX_LINES) });
  }

  const stack = describeStack(
    {
      frames: pause.callFrames.map(({ functionName, location }) => ({
        ...at(location),
        functionName,
      })),
      parent: pause.asyncStackTrace && rawStack(pause.asyncStackTrace),
    },
    locate,
  );
  return {
    where: locate({ ...at(top.location), functionName: '' }) ?? 'code that is not of the extension',
    reason: 'breakpoint',
    stack,
    frame: nameOf(top),
    locals,
    moreLocals: Math.max(0, variables.length - MAX_LOCALS),
    values,
  };
}

interface LookOptions {
  bundle: Bundle;
  locate: Locate;
  expressions: readonly string[];
  signal: AbortSignal;
}

function at({ scriptId, lineNumber, columnNumber = 0 }: Debugger.Location) {
  return { scriptId, lineNumber, columnNumber };
}

function rawStack({ callFrames, description, parent }: Runtime.StackTrace): RawStack {
  return { frames: callFrames, description, parent: parent && rawStack(parent) };
}

/** The variables of the function that the frame is in, inner blocks first. */
async function readLocals(
  inspector: Inspector,
  { scopeChain }: Debugger.CallFrame,
): Promise<Runtime.PropertyDescriptor[]> {
  const found = new Map<string, Runtime.PropertyDescriptor>();
  for (const { type, object } of scopeChain) {
    if (!['local', 'block', 'catch'].includes(type)) break;
    if (object.objectId === undefined) continue;
    const { result } = await inspector.send('Runtime.getProperties', {
      objectId: object.objectId,
      ownProperties: true,
    });
    // An inner variable hides an outer one of the same name.
    for (const local of result) if (!found.has(local.name)) found.set(local.name, local);
  }
  return [...found.values()];
}

async function runTrigger(trigger: Trigger): Promise<string> {
  return trigger.name === 'set' ? set(trigger.setting, trigger.value) : onWindow(trigger);
}

/**
 * Pauses the extension host once at a line of TypeScript and prints what is there. It continues
 * also on every failure, and when this process is interrupted.
 */
export async function breakAt(command: Extract<LiveCommand, { name: 'break' }>): Promise<void> {
  ownRunningSession();
  const { line, expressions, trigger } = command;
  const file = relative(ROOT, resolve(ROOT, command.file));
  const bundle = readBundle();
  const position = toGenerated(bundle.map, file, line);
  assertUnchanged(bundle, file);

  const signal = interruption();

  await withInspector(async (inspector) => {
    const url = pathToFileURL(bundle.file).href;
    const scriptId = await loadedScript(inspector, url, bundle);
    const locate: Locate = (frame) => {
      if (frame.scriptId !== scriptId) return undefined;
      const { lineNumber, columnNumber } = frame;
      const source = toSource(bundle.map, lineNumber, columnNumber);
      return source
        ? formatPosition(source)
        : formatGenerated({ line: lineNumber, column: columnNumber });
    };
    const look = { bundle, locate, expressions, signal };
    const { seen, trigger: triggered } = await pauseAt(
      inspector,
      {
        what: `${file}:${line}`,
        url,
        position,
        trigger: trigger && (() => runTrigger(trigger)),
        hitTimeoutMs: HIT_TIMEOUT_MS,
        lookTimeoutMs: LOOK_TIMEOUT_MS,
        triggerTimeoutMs: TRIGGER_TIMEOUT_MS,
        signal,
        onSet: (location) => {
          const { lineNumber, columnNumber } = at(location);
          const source = toSource(bundle.map, lineNumber, columnNumber);
          const where = describePlace(file, line, source, {
            line: lineNumber,
            column: columnNumber,
          });
          console.log(`Breakpoint at ${where}, waiting up to ${HIT_TIMEOUT_MS / 1000} s`);
        },
      },
      (pause) => inspectPause(inspector, pause, look),
    ).catch((error: unknown) => {
      if (error instanceof OtherPauseError) {
        const [top] = error.pause.callFrames;
        const where = top && locate({ ...at(top.location), functionName: '' });
        throw new ActionError(`${error.message}${where ? `\nIt paused at ${where}` : ''}`);
      }
      if (!(error instanceof NoHitError)) throw error;
      throw new ActionError(describeNoHit(error.message, trigger !== undefined));
    });
    console.log(formatReport(seen));
    console.log('Continued.');
    if (triggered) console.log(`--do: ${await unlessAborted(signal, triggered)}`);
    const failed = seen.values.filter(({ outcome }) => outcome !== 'value').length;
    if (failed > 0) throw new ActionError(`${failed} of ${seen.values.length} --eval failed`);
  });
}

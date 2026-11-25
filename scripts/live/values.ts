// Values of the extension host as text.
import { inspect } from 'node:util';
import type { Runtime } from 'node:inspector';
import type { Inspector } from './inspector.ts';

export interface InspectOptions {
  /** Levels of objects in objects. */
  depth: number;
  /** Characters in a line before it breaks. Infinity (null in JSON): one line. */
  width: number | null;
}

/** Characters of the text of one value. */
export const MAX_TEXT = 20_000;

/**
 * Runs in the extension host, with the value as `this`. It shows getters without asking them, and
 * runs no `toJSON`, custom inspection or proxy trap. It does run what Node itself asks to name a value:
 * `Symbol.toStringTag`, and the `stack` of an error. The text is cut there, so a huge value stays there.
 */
export const INSPECT = `function (options) {
  'use strict';
  return process.getBuiltinModule('node:util').inspect(this, {
    depth: options.depth,
    breakLength: options.width ?? Infinity,
    compact: options.width === null || options.width === Infinity ? true : 3,
    customInspect: false,
    showProxy: true,
    maxStringLength: 1000,
  }).slice(0, ${MAX_TEXT + 1});
}`;

type Primitive = Pick<
  Runtime.RemoteObject,
  'type' | 'subtype' | 'value' | 'unserializableValue' | 'description'
>;

/** A value that came as it is; undefined for one that stayed in the extension host. */
export function formatPrimitive(remote: Primitive): string | undefined {
  if (remote.unserializableValue !== undefined) return remote.unserializableValue;
  if (remote.type === 'undefined') return 'undefined';
  return 'value' in remote ? inspect(remote.value) : undefined;
}

/** Asks the extension host for the text of a value. */
export async function formatRemote(
  inspector: Inspector,
  remote: Runtime.RemoteObject,
  options: InspectOptions,
): Promise<string> {
  const primitive = formatPrimitive(remote);
  if (primitive !== undefined) return primitive;
  if (remote.objectId === undefined) return remote.description ?? remote.type;
  const { result, exceptionDetails } = await inspector.send('Runtime.callFunctionOn', {
    objectId: remote.objectId,
    functionDeclaration: INSPECT,
    arguments: [{ value: options }],
    returnByValue: true,
    silent: true,
  });
  if (exceptionDetails || typeof result.value !== 'string') {
    return remote.description ?? remote.type;
  }
  // An error without a stack comes in brackets.
  const text = cutText(result.value);
  return remote.subtype === 'error' ? text.replace(/^\[(.*)\]$/s, '$1') : text;
}

/** At most `MAX_TEXT` characters. */
export function cutText(text: string): string {
  if (text.length <= MAX_TEXT) return text;
  return `${text.slice(0, MAX_TEXT)}\n… cut after ${MAX_TEXT} characters`;
}

/** "… 3 frames of VS Code or Node" */
export function countFrames(count: number): string {
  return `… ${count} frame${count === 1 ? '' : 's'} of VS Code or Node`;
}

/** Counts the frames in the stack of an error that are not of the extension. */
export function foldStack(text: string): string {
  const lines: string[] = [];
  let others = 0;
  for (const line of text.split('\n')) {
    const other = /^\s+at .*(?:extensionHostProcess\.js|node:[\w/.-]+):\d+:\d+\)?(.*)$/.exec(line);
    if (!other) {
      others = 0;
      lines.push(line.replace(/^\tat /, '    at '));
      continue;
    }
    if (others > 0) lines.pop();
    others++;
    lines.push(`    ${countFrames(others)}${other[1] ?? ''}`);
  }
  return lines.join('\n');
}

/** One line of at most `max` characters. */
export function shorten(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ');
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** At most `max` lines of at most `width` characters. */
export function cutLines(text: string, max: number, width = 2000): string {
  const lines = text
    .split('\n')
    .map((line) => (line.length > width ? `${line.slice(0, width - 1)}…` : line));
  const more = lines.length - max;
  if (more <= 0) return lines.join('\n');
  return [...lines.slice(0, max), `… ${more} more line${more === 1 ? '' : 's'}`].join('\n');
}

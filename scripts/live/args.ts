// The command line of the live session: text in, a command out. Runs nothing.
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';

export type LiveCommand =
  | { name: 'start'; keep: boolean }
  | { name: 'stop' }
  | { name: 'status' }
  | { name: 'reload' }
  | { name: 'screenshot'; file: string | undefined }
  | { name: 'snapshot' }
  | { name: 'click'; target: string }
  | { name: 'type'; text: string }
  | { name: 'key'; combo: string }
  | { name: 'command'; title: string }
  | { name: 'set'; setting: string; value: unknown }
  | { name: 'logs' }
  | {
      name: 'break';
      file: string;
      line: number;
      trigger: LiveCommand | undefined;
      expressions: string[];
    }
  | { name: 'eval'; expression: string };

type Name = LiveCommand['name'];

/** Each command with its arguments, as the usage shows it. */
const USAGES: Record<Name, string> = {
  start: 'start [--keep]',
  stop: 'stop',
  status: 'status',
  reload: 'reload',
  screenshot: 'screenshot [name]',
  snapshot: 'snapshot',
  click: 'click <target>',
  type: 'type <text>',
  key: 'key <combo>',
  command: 'command <title>',
  set: 'set <setting> <json>',
  logs: 'logs',
  break: 'break <file:line> [--do <live command>] [--eval <expr>…]',
  eval: 'eval <expr>',
};

export const USAGE = ['Usage: npm run live -- <command>', ...Object.values(USAGES)].join('\n  ');

/** The command line is wrong. */
export class UsageError extends Error {
  override name = 'UsageError';
}

/** Commands that restart VS Code or use the debugger themselves cannot run while `break` waits. */
const NOT_A_TRIGGER: readonly Name[] = ['start', 'stop', 'reload', 'break', 'eval'];

function isName(text: string): text is Name {
  return Object.hasOwn(USAGES, text);
}

function wrong(name: Name): UsageError {
  return new UsageError(`expected: ${USAGES[name]} (if an argument has spaces, quote it)`);
}

/** The only argument of a command. Taken as it is, also with dashes in front. */
function single(name: Name, args: readonly string[]): string {
  const [value, ...more] = args;
  if (!value || more.length > 0) throw wrong(name);
  return value;
}

function none(name: Name, args: readonly string[]): void {
  if (args.length > 0) throw new UsageError(`${name} takes no arguments`);
}

function parseOptions<T extends ParseArgsOptionsConfig>(
  args: string[],
  options: T,
  allowPositionals: boolean,
) {
  try {
    return parseArgs({ args, options, allowPositionals, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

/** The file name goes into .vscode-live/, so it is never a path. */
function parseScreenshot(args: readonly string[]): LiveCommand {
  if (args.length === 0) return { name: 'screenshot', file: undefined };
  const file = single('screenshot', args);
  if (!/^\w[\w-]*$/.test(file)) {
    throw new UsageError(`"${file}" is not a name: use letters, digits, _ and -`);
  }
  return { name: 'screenshot', file };
}

function parseSet(args: readonly string[]): LiveCommand {
  const [setting, json, ...more] = args;
  if (!setting || json === undefined || more.length > 0) throw wrong('set');
  try {
    return { name: 'set', setting, value: JSON.parse(json) as unknown };
  } catch {
    throw new UsageError(`${json} is not JSON; a text needs quotes of its own: '"text"'`);
  }
}

function parseTrigger(text: string): LiveCommand {
  const trigger = parseLiveArgs(splitWords(text));
  if (NOT_A_TRIGGER.includes(trigger.name)) {
    throw new UsageError(`--do cannot run ${trigger.name}`);
  }
  return trigger;
}

function parseBreak(args: string[]): LiveCommand {
  const { values, positionals } = parseOptions(
    args,
    { do: { type: 'string' }, eval: { type: 'string', multiple: true } },
    true,
  );
  const [location, ...more] = positionals;
  const match = /^(.+):([1-9]\d*)$/.exec(location ?? '');
  if (!match?.[1] || more.length > 0) throw wrong('break');
  return {
    name: 'break',
    file: match[1],
    line: Number(match[2]),
    trigger: values.do === undefined ? undefined : parseTrigger(values.do),
    expressions: values.eval ?? [],
  };
}

/**
 * Splits the text after `--do` like a shell: quotes keep spaces, and a backslash keeps the next
 * character in double quotes. Throws `UsageError` if a quote does not end.
 */
export function splitWords(text: string): string[] {
  const words: string[] = [];
  let rest = text.trimStart();
  while (rest !== '') {
    const match = /^(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s"']\S*))(?:\s+|$)/.exec(rest);
    if (!match) throw new UsageError(`a quote does not end in: ${text}`);
    words.push(match[1]?.replace(/\\(.)/g, '$1') ?? match[2] ?? match[3] ?? '');
    rest = rest.slice(match[0].length);
  }
  return words;
}

/** Throws `UsageError` if the command does not exist or its arguments are wrong. */
export function parseLiveArgs(argv: string[]): LiveCommand {
  const [name, ...args] = argv;
  if (name === undefined) throw new UsageError('no command');
  if (!isName(name)) throw new UsageError(`unknown command "${name}"`);
  switch (name) {
    case 'start': {
      const { values } = parseOptions(args, { keep: { type: 'boolean' } }, false);
      return { name, keep: values.keep ?? false };
    }
    case 'stop':
    case 'status':
    case 'reload':
    case 'snapshot':
    case 'logs':
      none(name, args);
      return { name };
    case 'screenshot':
      return parseScreenshot(args);
    case 'click':
      return { name, target: single(name, args) };
    case 'type':
      return { name, text: single(name, args) };
    case 'key':
      return { name, combo: single(name, args) };
    case 'command':
      return { name, title: single(name, args) };
    case 'set':
      return parseSet(args);
    case 'break':
      return parseBreak(args);
    case 'eval':
      return { name, expression: single(name, args) };
  }
}

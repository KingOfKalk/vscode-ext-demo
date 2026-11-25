// The commands that act on the window of the running session, in one table: which they are, and what
// each does. `cli.ts` takes the list from here, so a command cannot be missing from one and not the other.
import { click, key, runCommand, type } from './interact.ts';
import { userError } from './errors.ts';
import type { LiveCommand } from './args.ts';
import { screenshot } from './screenshot.ts';
import { snapshot } from './snapshot.ts';
import { connect, type Connection } from './vscode.ts';

type Of<N extends LiveCommand['name']> = Extract<LiveCommand, { name: N }>;

/** What each of these does with the window; it returns the text to print. */
const ACTIONS = {
  screenshot: (c: Connection, command: Of<'screenshot'>) => screenshot(c, command.file),
  snapshot: (c: Connection) => snapshot(c),
  click: (c: Connection, command: Of<'click'>) => click(c, command.target),
  type: (c: Connection, command: Of<'type'>) => type(c, command.text),
  key: (c: Connection, command: Of<'key'>) => key(c, command.combo),
  command: (c: Connection, command: Of<'command'>) => runCommand(c, command.title),
} satisfies { [N in LiveCommand['name']]?: (c: Connection, command: Of<N>) => Promise<string> };

export type WindowCommand = Of<keyof typeof ACTIONS>;

export function isWindowCommand(command: LiveCommand): command is WindowCommand {
  return Object.hasOwn(ACTIONS, command.name);
}

/**
 * Connects to the session, does the command and disconnects. Fails with one `ActionError`: what
 * Playwright says is cut to a line.
 * @param connection only for tests
 */
export async function onWindow(
  command: WindowCommand,
  connection: () => Promise<Connection> = connect,
): Promise<string> {
  // One cast: the table is checked per command above, here the name picks the entry.
  const action = ACTIONS[command.name] as (c: Connection, command: LiveCommand) => Promise<string>;
  if (typeof action !== 'function') throw new Error(`${command.name} is not a window command`);
  let open: Connection;
  try {
    open = await connection();
  } catch (error) {
    throw userError(error);
  }
  try {
    return await action(open, command);
  } catch (error) {
    throw userError(error);
  } finally {
    await open.close().catch(() => undefined);
  }
}

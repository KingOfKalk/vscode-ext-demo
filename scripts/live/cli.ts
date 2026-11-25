// The live session: a real VS Code with the built extension, for agents to look at and use, and for
// the owner to watch. Runs with the type stripping of Node, without a build.
// Usage: npm run live -- <command>
import { describeFailure } from '../vscode.mjs';
import { parseLiveArgs, USAGE, UsageError, type LiveCommand } from './args.ts';
import { click, key, runCommand, type } from './interact.ts';
import { screenshot } from './screenshot.ts';
import { status, stop } from './session.ts';
import { snapshot } from './snapshot.ts';
import { start } from './start.ts';
import { connect, type Connection } from './vscode.ts';

/** Commands that act on the window of the running session; they print one result. */
async function act(command: LiveCommand, connection: Connection): Promise<string | undefined> {
  switch (command.name) {
    case 'screenshot':
      return screenshot(connection, command.file);
    case 'snapshot':
      return snapshot(connection);
    case 'click':
      return click(connection, command.target);
    case 'type':
      return type(connection, command.text);
    case 'key':
      return key(connection, command.combo);
    case 'command':
      return runCommand(connection, command.title);
    default:
      return undefined;
  }
}

const WINDOW_COMMANDS: readonly LiveCommand['name'][] = [
  'screenshot',
  'snapshot',
  'click',
  'type',
  'key',
  'command',
];

async function onWindow(command: LiveCommand): Promise<void> {
  const connection = await connect();
  try {
    console.log(await act(command, connection));
  } finally {
    await connection.close().catch(() => undefined);
  }
}

async function execute(command: LiveCommand): Promise<void> {
  switch (command.name) {
    case 'start':
      await start(command.keep);
      return;
    case 'stop':
      await stop();
      return;
    case 'status':
      status();
      return;
    default:
      if (WINDOW_COMMANDS.includes(command.name)) {
        await onWindow(command);
        return;
      }
      throw new Error(`${command.name} is not implemented yet`);
  }
}

try {
  await execute(parseLiveArgs(process.argv.slice(2)));
  process.exit(0);
} catch (error) {
  console.error(describeFailure(error));
  if (error instanceof UsageError) console.error(`\n${USAGE}`);
  process.exit(1);
}

// The live session: a real VS Code with the built extension, for agents to look at and use, and for
// the owner to watch. Runs with the type stripping of Node, without a build.
// Usage: npm run live -- <command>
import { describeFailure } from '../vscode.mjs';
import { parseLiveArgs, USAGE, UsageError, type LiveCommand } from './args.ts';
import { breakAt, evaluate } from './debug.ts';
import { reload } from './reload.ts';
import { set } from './set.ts';
import { status, stop } from './session.ts';
import { showLogs } from './showLogs.ts';
import { start } from './start.ts';
import { onWindow } from './window.ts';

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
    case 'reload':
      console.log(await reload());
      return;
    case 'set':
      console.log(await set(command.setting, command.value));
      return;
    case 'logs':
      console.log(await showLogs(command.lines));
      return;
    case 'eval':
      console.log(await evaluate(command.expression));
      return;
    case 'break':
      await breakAt(command);
      return;
    default:
      console.log(await onWindow(command));
      return;
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

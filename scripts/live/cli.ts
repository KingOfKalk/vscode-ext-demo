// The live session: a real VS Code with the built extension, for agents to look at and use, and for
// the owner to watch. Runs with the type stripping of Node, without a build.
// Usage: npm run live -- <command>
import { describeFailure } from '../vscode.mjs';
import { parseLiveArgs, USAGE, UsageError, type LiveCommand } from './args.ts';
import { status, stop } from './session.ts';
import { start } from './start.ts';

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

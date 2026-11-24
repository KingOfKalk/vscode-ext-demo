// Build, then vsce. Any failing step stops the script with a non-zero exit code.
// Run through `npm run package`; npm puts the local binaries on PATH.
import { spawnSync } from 'node:child_process';

/**
 * @param {string} command
 * @param {string[]} args
 */
function run(command, args) {
  console.log(`> ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (result.error) {
    console.error(`cannot run ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`${command} failed (${result.signal ?? `exit ${String(result.status)}`})`);
    process.exit(1);
  }
}

run('node', ['esbuild.mjs']);
// --no-dependencies: everything is bundled. stdin is closed so vsce can never wait for an answer.
run('vsce', ['package', '--no-dependencies']);

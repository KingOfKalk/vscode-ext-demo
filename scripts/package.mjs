// Build, then vsce. Any failing step stops the script with a non-zero exit code.
// Usage: npm run package; the release job runs `node scripts/package.mjs`.
// Both steps run with the Node of this script and by their path, not by a name on PATH: `npm run`
// puts node_modules/.bin first there, and any installed package can have a command called `node`.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

/**
 * The file behind the command `vsce`.
 * @returns {string}
 */
function vscePath() {
  const directory = join(ROOT, 'node_modules/@vscode/vsce');
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const file = manifest.bin?.vsce;
  if (typeof file !== 'string') throw new Error('@vscode/vsce has no command vsce');
  return join(directory, file);
}

/**
 * @param {string} name for the log
 * @param {string} file
 * @param {string[]} args
 */
function run(name, file, args = []) {
  console.log(`> ${[name, ...args].join(' ')}`);
  const result = spawnSync(process.execPath, [file, ...args], {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.error) {
    console.error(`cannot run ${name}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`${name} failed (${result.signal ?? `exit ${String(result.status)}`})`);
    process.exit(1);
  }
}

const vsce = vscePath();
run('esbuild.mjs', join(ROOT, 'esbuild.mjs'));
// --no-dependencies: everything is bundled. stdin is closed so vsce can never wait for an answer.
run('vsce', vsce, ['package', '--no-dependencies']);

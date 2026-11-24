// Smoke tests: installs the .vsix into an empty profile of the VS Code version in `engines.vscode`,
// starts it under Xvfb and runs suite.ts in its extension host.
// Usage: npm run test:smoke [-- [--report <file>] [<file.vsix>]]
// Without a .vsix it builds and packages one. `--report` writes a JSON report for ci-summary.mjs.
import { build } from 'esbuild';
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { describeFailure, ensureVscode, minimumVersion } from '../../scripts/vscode.mjs';
import { hostProblems, LOGS, problems, readLog, toReport } from './results.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const CACHE = process.env.VSCODE_TEST_CACHE ?? join(ROOT, '.vscode-test');
const TIMEOUT_MS = 5 * 60_000;

/** For a clean profile: no updates, no telemetry, nothing that opens on its own. */
const SETTINGS = {
  'chat.disableAIFeatures': true,
  'extensions.autoCheckUpdates': false,
  'extensions.autoUpdate': 'off',
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'workbench.startupEditor': 'none',
};

/** Variables that would let a surrounding VS Code, desktop or user setup change how ours starts. */
const DROPPED =
  /^(VSCODE|ELECTRON|WAYLAND|XDG_SESSION)_|^(NODE_OPTIONS|XDG_CONFIG_HOME|XDG_CACHE_HOME|XDG_DATA_HOME)$/;

/**
 * The environment for VS Code: HOME is in the run directory, so nothing of the real home (config,
 * caches, credentials) is read or written.
 * @param {string} home
 * @returns {NodeJS.ProcessEnv}
 */
function cleanEnv(home) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !DROPPED.test(name))),
    HOME: home,
  };
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 */
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.signal ?? `exit ${String(result.status)}`})`,
    );
  }
}

/** @type {Set<import('node:child_process').ChildProcess>} */
const children = new Set();

/**
 * Starts a process in its own group; the group ends with this script at the latest.
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {'pipe' | 'ignore'} [fd3]
 */
function start(command, args, env, fd3 = 'ignore') {
  const child = spawn(command, args, {
    detached: true,
    env,
    stdio: ['ignore', 'pipe', 'pipe', fd3],
  });
  children.add(child);
  return child;
}

function killAll() {
  for (const { pid } of children) {
    try {
      if (pid !== undefined) process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/**
 * Ends VS Code and Xvfb with everything in their process groups, then removes the run directory.
 * A rest that cannot be removed is a warning: the tests have passed.
 * @param {string} dir
 */
function cleanUp(dir) {
  killAll();
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    console.warn(`Warning: could not remove ${dir}: ${describeFailure(error)}`);
  }
}

/**
 * Starts Xvfb on a free display.
 * @returns {Promise<string>} the display
 */
function startXvfb() {
  const xvfb = start(
    'Xvfb',
    ['-displayfd', '3', '-screen', '0', '1280x800x24', '-nolisten', 'tcp'],
    process.env,
    'pipe',
  );
  return new Promise((resolve, reject) => {
    let errors = '';
    xvfb.stderr?.on('data', (data) => (errors += String(data)));
    xvfb.stdio[3]?.once('data', (data) => resolve(`:${String(data).trim()}`));
    xvfb.once('error', (error) =>
      reject(new Error(`cannot start Xvfb (${error.message}); run scripts/install-system-deps.sh`)),
    );
    xvfb.once('exit', (code) => reject(new Error(`Xvfb ended (exit ${String(code)}): ${errors}`)));
  });
}

/**
 * Runs VS Code until it ends.
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{ ending: string, output: string }>} ending: 'exit 0' if all is well
 */
function runVscode(command, args, env) {
  const vscode = start(command, args, env);
  let output = '';
  const collect = (/** @type {Buffer} */ data) => (output += String(data));
  vscode.stdout?.on('data', collect);
  vscode.stderr?.on('data', collect);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      killAll();
      resolve({ ending: `a timeout after ${TIMEOUT_MS / 1000} s`, output });
    }, TIMEOUT_MS);
    vscode.once('error', reject);
    vscode.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ ending: signal ?? `exit ${String(code)}`, output });
    });
  });
}

/** @param {string} text */
function tail(text, lines = 40) {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}

/**
 * The results of the suite; none if it did not start.
 * @param {string} file
 * @returns {import('./results.mjs').CheckResult[]}
 */
function readResults(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { report: { type: 'string' } },
  });
  if (positionals.length > 1) throw new Error('expected at most one .vsix');
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  if (positionals.length === 0) run('npm', ['run', 'package']);
  const vsix = resolve(positionals[0] ?? join(ROOT, `${manifest.name}-${manifest.version}.vsix`));
  if (!existsSync(vsix)) throw new Error(`${vsix} does not exist`);
  const version = minimumVersion(manifest.engines.vscode);
  const display = await startXvfb();
  const vscode = await ensureVscode(version, CACHE);

  // Not os.tmpdir(): VS Code does not start with a profile under a long path.
  const dir = mkdtempSync('/tmp/vsx-');
  const profile = join(dir, 'profile');
  const extensions = join(dir, 'extensions');
  const workspace = join(dir, 'workspace');
  const home = join(dir, 'home');
  const driver = join(dir, 'driver');
  const suite = join(driver, 'suite.js');
  mkdirSync(join(profile, 'User'), { recursive: true });
  mkdirSync(home);
  mkdirSync(extensions);
  mkdirSync(workspace);
  writeFileSync(join(profile, 'User', 'settings.json'), JSON.stringify(SETTINGS));
  writeFileSync(join(workspace, 'note.txt'), 'A file to open next to the Demo window.\n');
  cpSync(join(ROOT, 'tests/smoke/driver'), driver, { recursive: true });
  await build({
    entryPoints: [join(ROOT, 'tests/smoke/suite.ts')],
    outfile: suite,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['vscode'],
    logLevel: 'warning',
  });

  const executable = join(vscode, 'code');
  const flags = [
    `--user-data-dir=${profile}`,
    `--extensions-dir=${extensions}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--password-store=basic',
  ];
  // The command line of VS Code. Not bin/code: it may ask, or call the one of another VS Code.
  const cli = join(vscode, 'resources/app/out/cli.js');
  run(executable, [cli, ...flags, '--install-extension', vsix], {
    ...cleanEnv(home),
    ELECTRON_RUN_AS_NODE: '1',
  });

  console.log(`Running the smoke tests in VS Code ${version}, in ${dir}`);
  const startTime = Date.now();
  const { ending, output } = await runVscode(
    executable,
    [
      ...flags,
      '--disable-telemetry',
      '--disable-updates',
      '--disable-workspace-trust',
      '--skip-release-notes',
      '--skip-welcome',
      `--extensionDevelopmentPath=${driver}`,
      `--extensionTestsPath=${suite}`,
      workspace,
    ],
    { ...cleanEnv(home), DISPLAY: display },
  );

  const results = readResults(join(dir, 'results.json'));
  const demoLog = readLog(profile, LOGS.demo);
  const hostLog = readLog(profile, LOGS.host);
  const failed = results.filter(({ status }) => status !== 'passed');
  const outside = [
    ...(results.length === 0 ? ['The suite did not start.'] : []),
    ...(ending !== 'exit 0' && results.every(({ status }) => status !== 'failed')
      ? [`VS Code ended with ${ending}.`]
      : []),
    ...(demoLog === '' ? ['There is no Demo log.'] : []),
    ...(hostLog === '' ? ['There is no extension host log.'] : []),
    ...problems(demoLog).map((entry) => `Demo log: ${entry}`),
    ...hostProblems(hostLog).map((entry) => `Extension host log: ${entry}`),
  ];

  if (values.report !== undefined) {
    const report = toReport(results, outside.join('\n'), startTime, Date.now());
    writeFileSync(values.report, JSON.stringify(report));
  }
  for (const { name, status, error } of results) {
    console.log(`${status.padEnd(7)} ${name}`);
    if (error !== undefined) console.log(error.replace(/^/gm, '        '));
  }
  for (const line of outside) console.error(line);

  if (failed.length > 0 || outside.length > 0) {
    for (const [name, text] of [
      ['Demo log', demoLog],
      ['Extension host log', hostLog],
      ['Window log', readLog(profile, LOGS.renderer)],
      ['Output of VS Code', output],
    ]) {
      console.error(`\n--- End of: ${name} ---\n${tail(text)}`);
    }
    console.error(`\nThe smoke tests failed. All files: ${dir}`);
    return 1;
  }
  cleanUp(dir);
  console.log('The smoke tests passed.');
  return 0;
}

process.on('exit', killAll);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(1));
try {
  process.exit(await main());
} catch (error) {
  console.error(describeFailure(error));
  process.exit(1);
}

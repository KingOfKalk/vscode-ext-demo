// Smoke tests: installs the .vsix into an empty profile of the VS Code version in `engines.vscode`
// and starts it under Xvfb, in two stages:
//   1. suite.ts runs in the extension host (test mode).
//   2. Restart: VS Code starts normally, once per phase of restart.mjs, on a profile of its own;
//      helper.ts counts, quits and looks at what VS Code restored.
// Usage: npm run test:smoke [-- [--report <file>] [<file.vsix>]]
// Without a .vsix it builds and packages one. `--report` writes a JSON report for ci-summary.mjs.
import { build } from 'esbuild';
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
import {
  cleanEnv,
  installVsix,
  killGroup,
  QUIET_FLAGS,
  QUIET_SETTINGS,
  run,
  spawnGroup,
  startXvfb,
  vscodeFlags,
} from '../../scripts/vscode-run.mjs';
import { checkStart, COUNT, PHASES } from './restart.mjs';
import { hostProblems, LOGS, problems, readLog, toReport } from './results.mjs';

/** @typedef {import('./results.mjs').CheckResult} CheckResult */

const ROOT = resolve(import.meta.dirname, '../..');
const CACHE = process.env.VSCODE_TEST_CACHE ?? join(ROOT, '.vscode-test');
const TIMEOUT_MS = 5 * 60_000;
const START_TIMEOUT_MS = 90_000;

/** @type {Set<import('node:child_process').ChildProcess>} */
const children = new Set();

function killAll() {
  for (const { pid } of children) killGroup(pid);
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
 * Runs VS Code until it ends, then ends the rest of its process group.
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {number} [timeoutMs]
 * @returns {Promise<{ ending: string, output: string }>} ending: 'exit 0' if all is well
 */
function runVscode(command, args, env, timeoutMs = TIMEOUT_MS) {
  const vscode = spawnGroup(command, args, env);
  children.add(vscode);
  let output = '';
  const collect = (/** @type {Buffer} */ data) => (output += String(data));
  vscode.stdout?.on('data', collect);
  vscode.stderr?.on('data', collect);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      killGroup(vscode.pid);
      resolve({ ending: `a timeout after ${timeoutMs / 1000} s`, output });
    }, timeoutMs);
    vscode.once('error', reject);
    vscode.once('exit', (code, signal) => {
      clearTimeout(timer);
      // Its zygote and utility processes must not outlive it: the next start uses the profile.
      killGroup(vscode.pid);
      children.delete(vscode);
      resolve({ ending: signal ?? `exit ${String(code)}`, output });
    });
  });
}

/** @param {string} text */
function tail(text, lines = 40) {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}

/**
 * Parses a JSON file; undefined if it does not exist.
 * @param {string} file
 */
function readJson(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
}

/**
 * An empty profile with the quiet settings.
 * @param {string} profile
 * @param {Record<string, unknown>} [settings] more settings
 */
function makeProfile(profile, settings = {}) {
  mkdirSync(join(profile, 'User'), { recursive: true });
  const all = { ...QUIET_SETTINGS, ...settings };
  writeFileSync(join(profile, 'User', 'settings.json'), JSON.stringify(all));
}

/**
 * Bundles a file of tests/smoke for the extension host, into a copy of the extension it runs in.
 * @param {string} source the file
 * @param {string} extension the directory with its package.json
 * @param {string} to where the extension goes
 * @param {string} outfile the name of the bundle
 */
async function bundle(source, extension, to, outfile) {
  mkdirSync(to);
  cpSync(join(ROOT, 'tests/smoke', extension, 'package.json'), join(to, 'package.json'));
  await build({
    entryPoints: [join(ROOT, 'tests/smoke', source)],
    outfile: join(to, outfile),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['vscode'],
    logLevel: 'warning',
  });
}

/**
 * @typedef {{ executable: string, extensions: string, env: NodeJS.ProcessEnv }} Setup
 *   what both stages use: VS Code, the installed .vsix, the environment with the display
 */

/**
 * Stage 1: suite.ts in test mode, in one start.
 * @param {string} dir
 * @param {Setup} setup
 */
async function suiteStage(dir, { executable, extensions, env }) {
  const profile = join(dir, 'profile');
  const workspace = join(dir, 'workspace');
  const driver = join(dir, 'driver');
  makeProfile(profile);
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'note.txt'), 'A file to open next to the Demo window.\n');
  await bundle('suite.ts', 'driver', driver, 'suite.js');

  const { ending, output } = await runVscode(
    executable,
    [
      ...vscodeFlags(profile, extensions),
      ...QUIET_FLAGS,
      // A free port of this machine, for screen.ts.
      '--remote-debugging-port=0',
      `--extensionDevelopmentPath=${driver}`,
      `--extensionTestsPath=${join(driver, 'suite.js')}`,
      workspace,
    ],
    env,
  );

  /** @type {CheckResult[]} none if the suite did not start */
  const results = readJson(join(dir, 'results.json')) ?? [];
  const demoLog = readLog(profile, LOGS.demo);
  const hostLog = readLog(profile, LOGS.host);
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
  /** @type {[string, string][]} */
  const logs = [
    ['Demo log of the suite', demoLog],
    ['Extension host log of the suite', hostLog],
    ['Window log of the suite', readLog(profile, LOGS.renderer)],
    ['Output of VS Code in the suite', output],
  ];
  return { results, outside, logs };
}

/**
 * Stage 2: one normal start per phase, on one profile. Only there VS Code saves its storage.
 * @param {string} dir
 * @param {Setup} setup
 * @param {string} message the default greeting
 */
async function restartStage(dir, { executable, extensions, env }, message) {
  const profile = join(dir, 'profile');
  const helper = join(dir, 'helper');
  // With "always", VS Code would ask before the helper quits it.
  makeProfile(profile, { 'window.confirmBeforeClose': 'never' });
  for (const folder of ['a', 'b']) mkdirSync(join(dir, folder));
  await bundle('helper.ts', 'helper', helper, 'helper.js');

  /** @type {CheckResult[]} */
  const results = [];
  /** @type {[string, string][]} */
  const logs = [];
  for (const { name, folder, title } of PHASES) {
    writeFileSync(join(helper, 'phase.json'), JSON.stringify({ name, profile, count: COUNT }));
    // screen.ts must not find the port of the last start.
    rmSync(join(profile, 'DevToolsActivePort'), { force: true });
    // The logs of this start only, laid out as in a profile for readLog.
    const logsOf = join(dir, `logs-${name}`);
    const { ending, output } = await runVscode(
      executable,
      [
        ...vscodeFlags(profile, extensions),
        ...QUIET_FLAGS,
        `--logsPath=${join(logsOf, 'logs', 'start')}`,
        '--remote-debugging-port=0',
        `--extensionDevelopmentPath=${helper}`,
        join(dir, folder),
      ],
      env,
      START_TIMEOUT_MS,
    );
    const demoLog = readLog(logsOf, LOGS.demo);
    const hostLog = readLog(logsOf, LOGS.host);
    const report = readJson(join(dir, `${name}.json`));
    const failures = checkStart(name, { ending, report, demoLog, hostLog }, message);
    if (failures.length === 0) {
      results.push({ name: title, status: 'passed' });
      continue;
    }
    results.push({ name: title, status: 'failed', error: failures.join('\n') });
    logs.push(
      [`Demo log of ${name}`, demoLog],
      [`Extension host log of ${name}`, hostLog],
      [`Output of VS Code in ${name}`, output],
    );
  }
  return { results, logs };
}

/** @param {readonly CheckResult[]} results */
function print(results) {
  for (const { name, status, error } of results) {
    console.log(`${status.padEnd(7)} ${name}`);
    if (error !== undefined) console.log(error.replace(/^/gm, '        '));
  }
}

/** @param {readonly CheckResult[]} results */
const failed = (results) => results.some(({ status }) => status !== 'passed');

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { report: { type: 'string' } },
  });
  if (positionals.length > 1) throw new Error('expected at most one .vsix');
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  if (positionals.length === 0) run(process.execPath, [join(ROOT, 'scripts/package.mjs')]);
  const vsix = resolve(positionals[0] ?? join(ROOT, `${manifest.name}-${manifest.version}.vsix`));
  if (!existsSync(vsix)) throw new Error(`${vsix} does not exist`);
  const version = minimumVersion(manifest.engines.vscode);
  const display = await startXvfb({ onSpawn: (child) => children.add(child) });
  const vscode = await ensureVscode(version, CACHE);

  // Not os.tmpdir(): VS Code does not start with a profile under a long path.
  const dir = mkdtempSync('/tmp/vsx-');
  const extensions = join(dir, 'extensions');
  const home = join(dir, 'home');
  mkdirSync(home);
  mkdirSync(extensions);
  // Both stages use this installation.
  installVsix(vscode, vscodeFlags(join(dir, 'profile'), extensions), vsix, cleanEnv(home));
  /** @type {Setup} */
  const setup = {
    executable: join(vscode, 'code'),
    extensions,
    env: { ...cleanEnv(home), DISPLAY: display },
  };

  console.log(`Running the smoke tests in VS Code ${version}, in ${dir}`);
  const startTime = Date.now();
  const suite = await suiteStage(dir, setup);
  print(suite.results);
  for (const line of suite.outside) console.error(line);
  console.log('Restart stage: normal starts of VS Code on one profile');
  const message = manifest.contributes.configuration.properties['vscodeExtDemo.message'].default;
  /** @type {{ results: CheckResult[], logs: [string, string][] }} */
  let restart;
  try {
    restart = await restartStage(join(dir, 'restart'), setup, message);
  } catch (error) {
    // The results of the suite still go into the report.
    const failure = describeFailure(error);
    restart = {
      results: [{ name: 'the restart stage', status: 'failed', error: failure }],
      logs: [],
    };
  }
  print(restart.results);

  if (values.report !== undefined) {
    const stages = [
      { file: 'tests/smoke/suite.ts', results: suite.results, message: suite.outside.join('\n') },
      { file: 'tests/smoke/restart.mjs', results: restart.results, message: '' },
    ];
    writeFileSync(values.report, JSON.stringify(toReport(stages, startTime, Date.now())));
  }

  const suiteFailed = failed(suite.results) || suite.outside.length > 0;
  for (const [name, text] of [...(suiteFailed ? suite.logs : []), ...restart.logs]) {
    console.error(`\n--- End of: ${name} ---\n${tail(text)}`);
  }
  if (suiteFailed || failed(restart.results)) {
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

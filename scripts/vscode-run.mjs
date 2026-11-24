// What the smoke tests and the live session share: a clean environment for VS Code, its command
// line, processes in their own groups, and Xvfb. Linux only.
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';

/** For a clean profile: no updates, no telemetry, nothing that opens on its own. */
export const QUIET_SETTINGS = {
  'chat.disableAIFeatures': true,
  'extensions.autoCheckUpdates': false,
  'extensions.autoUpdate': 'off',
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'workbench.startupEditor': 'none',
};

/** The same on the command line. An untrusted workspace would stop the extension. */
export const QUIET_FLAGS = [
  '--disable-telemetry',
  '--disable-updates',
  '--disable-workspace-trust',
  '--skip-release-notes',
  '--skip-welcome',
];

/** Variables that would let a surrounding VS Code, desktop or user setup change how ours starts. */
const DROPPED =
  /^(VSCODE|ELECTRON|WAYLAND|XDG_SESSION)_|^(NODE_OPTIONS|XDG_CONFIG_HOME|XDG_CACHE_HOME|XDG_DATA_HOME)$/;

/**
 * The environment for VS Code with its own HOME, so nothing of the real home (config, caches,
 * credentials) is read or written.
 * @param {string} home
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
export function cleanEnv(home, env = process.env) {
  return {
    ...Object.fromEntries(Object.entries(env).filter(([name]) => !DROPPED.test(name))),
    HOME: home,
  };
}

/**
 * The flags VS Code needs in a container, with its own profile and extensions. Both paths must be
 * short: VS Code does not start with a profile under a long one.
 * @param {string} profile
 * @param {string} extensions
 */
export function vscodeFlags(profile, extensions) {
  return [
    `--user-data-dir=${profile}`,
    `--extensions-dir=${extensions}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--password-store=basic',
  ];
}

/**
 * Runs a command to its end; throws if it fails or takes too long.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number }} [options]
 */
export function run(command, args, { cwd, env = process.env, timeoutMs } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const line = `${command} ${args.join(' ')}`;
  if (result.error) {
    const { code } = /** @type {NodeJS.ErrnoException} */ (result.error);
    if (code === 'ETIMEDOUT') {
      throw new Error(`${line} did not finish within ${String((timeoutMs ?? 0) / 1000)} s`);
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${line} failed (${result.signal ?? `exit ${String(result.status)}`})`);
  }
}

/**
 * Installs a .vsix with the command line of VS Code. Not bin/code: it may ask, or call the one of
 * another VS Code.
 * @param {string} vscode the directory of VS Code
 * @param {string[]} flags see `vscodeFlags`
 * @param {string} vsix
 * @param {NodeJS.ProcessEnv} env
 * @param {{ force?: boolean, timeoutMs?: number }} [options] force: also over the same version
 */
export function installVsix(vscode, flags, vsix, env, { force = false, timeoutMs = 120_000 } = {}) {
  const cli = join(vscode, 'resources/app/out/cli.js');
  run(
    join(vscode, 'code'),
    [cli, ...flags, '--install-extension', vsix, ...(force ? ['--force'] : [])],
    { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, timeoutMs },
  );
}

/**
 * Starts a process in its own group, which `killGroup` ends with everything the process started.
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {{ output?: 'pipe' | number, fd3?: 'pipe' | 'ignore' }} [options] output: a file
 *   descriptor for stdout and stderr
 */
export function spawnGroup(command, args, env, { output = 'pipe', fd3 = 'ignore' } = {}) {
  return spawn(command, args, {
    detached: true,
    env,
    stdio: ['ignore', output, output, fd3],
  });
}

/**
 * Sends a signal to a process group. A group that is gone is not an error.
 * @param {number | undefined} pid the first process of the group
 * @param {NodeJS.Signals} [signal]
 */
export function killGroup(pid, signal = 'SIGKILL') {
  try {
    if (pid !== undefined) process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

/**
 * Starts Xvfb on a free display and waits until it is ready. Xvfb picks the display itself, so a
 * lock that an unclean stop left behind (/tmp/.X99-lock) is in nobody's way. Nothing is ended here
 * if this fails; the caller knows the process from `onSpawn`.
 * @param {{
 *   onSpawn: (child: import('node:child_process').ChildProcess) => void,
 *   env?: NodeJS.ProcessEnv,
 *   output?: 'pipe' | number,
 *   screen?: string,
 *   timeoutMs?: number,
 * }} options output: a file descriptor for stdout and stderr
 * @returns {Promise<string>} the display
 */
export function startXvfb({
  onSpawn,
  env = process.env,
  output = 'pipe',
  screen = '1280x800x24',
  timeoutMs = 30_000,
}) {
  const xvfb = spawnGroup(
    'Xvfb',
    ['-displayfd', '3', '-screen', '0', screen, '-nolisten', 'tcp'],
    env,
    { output, fd3: 'pipe' },
  );
  onSpawn(xvfb);
  return new Promise((resolve, reject) => {
    let errors = '';
    let display = '';
    const timer = setTimeout(() => {
      reject(new Error(`Xvfb was not ready within ${String(timeoutMs / 1000)} s ${errors}`.trim()));
    }, timeoutMs);
    const fail = (/** @type {string} */ message) => {
      clearTimeout(timer);
      reject(new Error(message));
    };
    xvfb.stderr?.on('data', (data) => (errors += String(data)));
    xvfb.stdio[3]?.on('data', (data) => {
      // The number may come in pieces; the line is complete with its end.
      display += String(data);
      if (!display.includes('\n')) return;
      clearTimeout(timer);
      resolve(`:${display.trim()}`);
    });
    xvfb.once('error', (error) => {
      fail(`cannot start Xvfb (${error.message}); run scripts/install-system-deps.sh`);
    });
    xvfb.once('exit', (code, signal) => {
      fail(`Xvfb ended (${signal ?? `exit ${String(code)}`}): ${errors}`);
    });
  });
}

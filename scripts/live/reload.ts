// `reload`: builds the extension, puts the new files into the running session and reloads its window.
// The profile stays, so does the count; the extension host starts again with the new code.
import { createHash } from 'node:crypto';
import { globSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { sessionEnv } from './environment.ts';
import { ActionError, guard, userError } from './errors.ts';
import { assertNoOverlay, runCommand } from './interact.ts';
import {
  isNewActivation,
  lastErrorBlock,
  readActivations,
  readLog,
  runLogs,
  tail,
} from './logs.ts';
import { waitFor } from './processes.ts';
import { PROFILE, ROOT, VSCODE_LOGS } from './session.ts';
import {
  attach,
  connect,
  downloadVscode,
  extensionId,
  installUnchecked,
  installedDir,
  ownRunningSession,
  packageVsix,
} from './vscode.ts';

const RELOAD_COMMAND = 'Developer: Reload Window';
const ACTIVATION_TIMEOUT_MS = 45_000;

export function hashOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** One file of the extension: its hash in the session before, in the build, and in the session now. */
export interface FileState {
  file: string;
  /** undefined if the session did not have it. */
  before: string | undefined;
  built: string;
  after: string;
}

export interface Reinstall {
  changed: string[];
  same: string[];
}

/**
 * What the reinstall did to each file. Throws if a file of the session is not the one that was built,
 * which means the reinstall did not replace it: reloading would run the old code and call it new.
 */
export function describeReinstall(states: readonly FileState[]): Reinstall {
  const wrong = states.filter(({ built, after }) => built !== after);
  if (wrong.length > 0) {
    throw new ActionError(
      `the reinstall did not replace the files: ` +
        wrong.map(({ file }) => `${file}: not the one that was built`).join('; '),
    );
  }
  return {
    changed: states.filter(({ before, after }) => before !== after).map(({ file }) => file),
    same: states.filter(({ before, after }) => before === after).map(({ file }) => file),
  };
}

/**
 * The files of the extension that are copied as they are, as paths below its directory. Not
 * package.json: the installer adds to it, so only its version is compared.
 */
function extensionFiles(): string[] {
  const media = globSync('media/**/*', { cwd: ROOT }).filter((file) =>
    statSync(join(ROOT, file)).isFile(),
  );
  return ['dist/extension.js', 'dist/webview.js', ...media.toSorted()];
}

function hashFile(file: string): string | undefined {
  try {
    return hashOf(readFileSync(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function versionIn(dir: string): string {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    version: string;
  };
  return manifest.version;
}

/** The text of a failure after the new files were installed: the window may still run the old ones. */
function notRunning(error: unknown): ActionError {
  const text = userError(error).message;
  return new ActionError(`the new files are installed but not running: ${text}`);
}

/**
 * The failure of a reload that the extension did not follow with an activation. The reason is in
 * the log of the extension host (an exception of `activate()` is there, not in the Demo log, which
 * the extension has not written yet), so both logs are named and their ends printed.
 */
export function describeNoActivation(
  seconds: number,
  demo: { where: string; end: string },
  host: { where: string; end: string; error?: string },
): string {
  const indent = (text: string) => text.split('\n').map((line) => `  ${line}`);
  return [
    `the extension did not activate again within ${seconds} s`,
    ...(host.error === undefined
      ? []
      : [`the last error in the extension host log (${host.where}):`, ...indent(host.error)]),
    `the end of the extension host log (${host.where}):`,
    ...indent(host.end),
    `the end of the Demo log (${demo.where}):`,
    ...indent(demo.end),
  ].join('\n');
}

/** Builds, reinstalls over the same version, reloads the window and waits for the new activation. */
export async function reload(): Promise<string> {
  ownRunningSession();
  const id = extensionId();
  // The window first: a build and an install are no use if the window cannot take the command.
  const open = await guard('cannot reach the window', async () => {
    const connection = await connect();
    try {
      await assertNoOverlay(connection.page);
    } catch (error) {
      await connection.close().catch(() => undefined);
      throw error;
    }
    return connection;
  });
  try {
    const files = extensionFiles();
    const vsix = packageVsix();
    const oldDir = installedDir();
    const before = new Map(files.map((file) => [file, hashFile(join(oldDir, file))]));
    const oldVersion = versionIn(oldDir);

    installUnchecked(await downloadVscode(), vsix, sessionEnv());
    const dir = installedDir();
    // The one check that the install did what it should: every file is the built one.
    const { changed, same } = describeReinstall(
      files.map((file) => ({
        file,
        before: before.get(file),
        built: hashOf(readFileSync(join(ROOT, file))),
        after: hashFile(join(dir, file)) ?? 'missing',
      })),
    );
    const version = versionIn(dir);
    if (version !== versionIn(ROOT)) {
      throw new ActionError(
        `the installed version is ${version}, not the built ${versionIn(ROOT)}`,
      );
    }

    try {
      const was = readActivations(VSCODE_LOGS, id);
      // The host log of a run keeps the hosts before the reload: only what is new can be the reason.
      const hostBefore = runLogs(VSCODE_LOGS, [], id)?.host;
      const hostLinesBefore = hostBefore ? (readLog(hostBefore) ?? '').split('\n').length : 0;
      await guard('cannot reload the window', () => runCommand(open, RELOAD_COMMAND));
      const now = await waitFor(
        () => 'the extension activates again',
        () => {
          const logs = readActivations(VSCODE_LOGS, id);
          return isNewActivation(was, logs) ? logs : undefined;
        },
        { timeoutMs: ACTIVATION_TIMEOUT_MS },
      ).catch(() => {
        const found = runLogs(VSCODE_LOGS, [], id);
        const shown = (file: string | undefined, end: number) => ({
          where: file === undefined ? '(no log yet)' : relative(PROFILE, file),
          end: file === undefined ? '(missing)' : tail(file, end),
        });
        const host = found?.host;
        const hostText = host === undefined ? '' : (readLog(host) ?? '');
        const fresh =
          host === hostBefore ? hostText.split('\n').slice(hostLinesBefore).join('\n') : hostText;
        const error = lastErrorBlock(fresh, 8);
        throw new ActionError(
          describeNoActivation(ACTIVATION_TIMEOUT_MS / 1000, shown(found?.demo, 3), {
            ...shown(host, 5),
            ...(error === undefined ? {} : { error }),
          }),
        );
      });
      const ready = await guard('the window did not come back', () => attach(30_000));
      await ready.close().catch(() => undefined);

      return [
        `Reloaded ${id}, ` +
          (version === oldVersion
            ? `version ${version} as before`
            : `version ${oldVersion} -> ${version}`) +
          '.',
        changed.length > 0
          ? `Replaced: ${changed.join(', ')}`
          : 'No file changed: the build is identical to what was installed.',
        ...(same.length > 0 && changed.length > 0 ? [`Same: ${same.join(', ')}`] : []),
        `Activated again: ${now.last ?? ''}`,
      ].join('\n');
    } catch (error) {
      throw notRunning(error);
    }
  } finally {
    await open.close().catch(() => undefined);
  }
}

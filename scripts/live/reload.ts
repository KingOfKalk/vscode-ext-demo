// `reload`: builds the extension, puts the new files into the running session and reloads its window.
// The profile stays, so does the count; the extension host starts again with the new code.
import { createHash } from 'node:crypto';
import { globSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sessionEnv } from './environment.ts';
import { ActionError, guard } from './errors.ts';
import { runCommand } from './interact.ts';
import { isNewActivation, readActivations, tail } from './logs.ts';
import { waitFor } from './processes.ts';
import { ROOT, VSCODE_LOGS } from './session.ts';
import {
  attach,
  connect,
  downloadVscode,
  extensionId,
  install,
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

/** Builds, reinstalls over the same version, reloads the window and waits for the new activation. */
export async function reload(): Promise<string> {
  ownRunningSession();
  const id = extensionId();
  const files = extensionFiles();
  const vsix = packageVsix();
  const oldDir = installedDir();
  const before = new Map(files.map((file) => [file, hashFile(join(oldDir, file))]));
  const oldVersion = versionIn(oldDir);

  install(await downloadVscode(), vsix, sessionEnv());
  const dir = installedDir();
  const states = files.map((file) => ({
    file,
    before: before.get(file),
    built: hashOf(readFileSync(join(ROOT, file))),
    after: hashFile(join(dir, file)) ?? 'missing',
  }));
  const { changed, same } = describeReinstall(states);
  const version = versionIn(dir);
  if (version !== versionIn(ROOT)) {
    throw new ActionError(`the installed version is ${version}, not the built ${versionIn(ROOT)}`);
  }

  const was = readActivations(VSCODE_LOGS, id);
  await guard('cannot reload the window', async () => {
    const open = await connect();
    try {
      await runCommand(open, RELOAD_COMMAND);
    } finally {
      await open.close().catch(() => undefined);
    }
  });
  const now = await waitFor(
    () => {
      const logs = readActivations(VSCODE_LOGS, id);
      return `the extension activates again; the end of the Demo log:\n${tail(join(VSCODE_LOGS, logs.run ?? '', 'window1/exthost', id, 'Demo.log'))}`;
    },
    () => {
      const logs = readActivations(VSCODE_LOGS, id);
      return isNewActivation(was, logs) ? logs : undefined;
    },
    { timeoutMs: ACTIVATION_TIMEOUT_MS },
  ).catch((error: unknown) => {
    // Whole: its text has the end of the log.
    throw new ActionError(error instanceof Error ? error.message : String(error));
  });
  const ready = await guard('the window did not come back after the reload', () => attach(30_000));
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
}

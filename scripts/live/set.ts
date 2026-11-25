// `set <setting> <json>`: changes one user setting of the profile of the session. VS Code watches
// the file and applies the change by itself, no reload.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ActionError } from './errors.ts';
import { readLog, runLogs } from './logs.ts';
import { waitFor } from './processes.ts';
import { PROFILE, VSCODE_LOGS } from './session.ts';
import { describeChange, mergeSetting, readSetting, validateSettingKey } from './settings.ts';
import { extensionId, ownRunningSession } from './vscode.ts';

const SETTINGS_FILE = join(PROFILE, 'User', 'settings.json');
/** The settings of the extension: its log line says the change arrived. */
const OWN_PREFIX = 'vscodeExtDemo.';
const CHANGED = 'Settings changed';
const APPLY_TIMEOUT_MS = 5000;

/** The Settings-changed lines of the Demo log of the newest run. */
function changedLines(id: string): string[] {
  const found = runLogs(VSCODE_LOGS, [], id);
  const text = found ? (readLog(found.demo) ?? '') : '';
  return text.split('\n').filter((line) => line.includes(CHANGED));
}

/** Writes next to the file and renames, so VS Code never reads half a file. */
function writeWhole(file: string, text: string): void {
  const part = `${file}.${process.pid}.tmp`;
  writeFileSync(part, text);
  renameSync(part, file);
}

/** Returns the line to print. */
export async function set(key: string, value: unknown): Promise<string> {
  validateSettingKey(key);
  ownRunningSession();
  let json = '';
  try {
    json = readFileSync(SETTINGS_FILE, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const old = readSetting(json, key);
  const summary = describeChange(key, old, value);
  if (old.found && JSON.stringify(old.value) === JSON.stringify(value)) return summary;

  const id = extensionId();
  const seen = changedLines(id).length;
  writeWhole(SETTINGS_FILE, mergeSetting(json, key, value));
  if (!key.startsWith(OWN_PREFIX)) {
    return `${summary}\nWritten to settings.json; VS Code applies it by itself. Not checked: only the extension's own settings are.`;
  }
  const line = await waitFor(
    `the Demo log does not say "${CHANGED}"`,
    () => changedLines(id).slice(seen).at(-1),
    { timeoutMs: APPLY_TIMEOUT_MS },
  ).catch(() => {
    throw new ActionError(
      `${summary}\nWritten to settings.json, but the extension did not log "${CHANGED}" within ${APPLY_TIMEOUT_MS / 1000} s; see: npm run live -- logs`,
    );
  });
  return `${summary}\nApplied without a reload: ${line}`;
}

// `screenshot`: a PNG of the whole window in .vscode-live/ (gitignored). Nothing leaves that folder.
import { mkdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { guard } from './errors.ts';
import { LIVE_DIR } from './session.ts';
import type { Connection } from './vscode.ts';

/** A name that is one plain file name: letters, digits, `_` and `-`, not starting with `-`. */
const PLAIN_NAME = /^\w[\w-]*$/;

/** `2026-11-25T06-37-40-683Z`: the time, without characters that are awkward in a file name. */
export function timestampName(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * The path of the PNG: `<dir>/<name>.png`, or the time if there is no name. Throws if the name is
 * not a plain name (no path separators, no dots, no `..`) or the path would leave `dir`.
 */
export function screenshotPath(name: string | undefined, now: Date, dir = LIVE_DIR): string {
  const base = name ?? timestampName(now);
  if (!PLAIN_NAME.test(base)) {
    throw new Error(`"${base}" is not a name for a screenshot: use letters, digits, _ and -`);
  }
  const path = resolve(dir, `${base}.png`);
  if (relative(dir, path) !== `${base}.png`) throw new Error(`"${base}" leaves ${dir}`);
  return join(dir, `${base}.png`);
}

/** Saves the picture and returns its path. */
export async function screenshot(
  { page }: Connection,
  name: string | undefined,
  now = new Date(),
): Promise<string> {
  const path = screenshotPath(name, now);
  mkdirSync(LIVE_DIR, { recursive: true, mode: 0o700 });
  await guard('cannot take the screenshot', () => page.screenshot({ path, timeout: 10_000 }));
  return path;
}

// Compares the file list of a .vsix against the exact expected contents.
// Usage: node scripts/check-vsix.mjs <file.vsix>
// Exits 1 on any missing or unexpected file, or on any failure to read the archive.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Entries as vsce writes them into the archive. */
export const REQUIRED_FILES = [
  'extension/package.json',
  'extension/dist/extension.js',
  'extension/dist/webview.js',
  'extension/media/icon.svg',
  'extension/media/window.css',
  'extension/readme.md',
  'extension/LICENSE.txt',
  'extension.vsixmanifest',
  '[Content_Types].xml',
];

/** Allowed, but never in the .vsix today: `files` in package.json does not list the changelog. */
export const OPTIONAL_FILES = ['extension/changelog.md'];

/**
 * Compares an archive listing with the expected one.
 * Directory entries (trailing slash) are ignored; duplicates collapse.
 * @param {readonly string[]} actual
 * @param {readonly string[]} required
 * @param {readonly string[]} optional
 * @returns {{ missing: string[], unexpected: string[] }} both sorted
 */
export function compareListing(actual, required, optional) {
  const present = new Set(actual.filter((name) => !name.endsWith('/')));
  const allowed = new Set([...required, ...optional]);
  return {
    missing: required.filter((name) => !present.has(name)).sort(),
    unexpected: [...present].filter((name) => !allowed.has(name)).sort(),
  };
}

/**
 * @param {string} vsixPath
 * @returns {string[]}
 */
function listArchive(vsixPath) {
  const result = spawnSync('unzip', ['-Z1', vsixPath], { encoding: 'utf8' });
  if (result.error) {
    throw new Error(`cannot run unzip: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`unzip failed (exit ${String(result.status)}): ${result.stderr.trim()}`);
  }
  return result.stdout.split('\n').filter((line) => line !== '');
}

function main() {
  const vsixPath = process.argv[2];
  if (!vsixPath) {
    console.error('usage: node scripts/check-vsix.mjs <file.vsix>');
    return 1;
  }
  const { missing, unexpected } = compareListing(
    listArchive(vsixPath),
    REQUIRED_FILES,
    OPTIONAL_FILES,
  );
  for (const name of missing) console.error(`missing: ${name}`);
  for (const name of unexpected) console.error(`unexpected: ${name}`);
  if (missing.length > 0 || unexpected.length > 0) {
    console.error(`${vsixPath}: contents differ from the expected list`);
    return 1;
  }
  console.log(`${vsixPath}: contents match the expected list`);
  return 0;
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

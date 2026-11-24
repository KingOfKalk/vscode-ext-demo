// Decides whether a Dependabot pull request may be auto-merged. Used by
// .github/workflows/dependabot-automerge.yml.
//
// Env:
//   UPDATED_DEPENDENCIES  output `updated-dependencies-json` of dependabot/fetch-metadata
//   COMMITS_FILE          commits of the pull request, as an array of pages of the GitHub API
//   HEAD_SHA              head commit of the pull request the decision is for
//   GITHUB_OUTPUT         gets `automerge`
// Prints the decision and its reasons as a notice. Exits 1 on input it cannot read.
// Only Node built-ins: the workflow installs nothing.
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Exact names. Keep .github/dependabot.yml (`exclude-patterns`) in step; a test compares them. */
export const MANUAL_DEPENDENCIES = [
  // Produce the shipped code.
  'esbuild',
  'typescript',
  // Drives the live session, which CI does not run.
  'playwright-core',
  // Not run by CI, and they get the App key or run next to a write token.
  'actions/create-github-app-token',
  'actions/download-artifact',
  'dependabot/fetch-metadata',
  'googleapis/release-please-action',
];

/**
 * As in the branch name `dependabot/<ecosystem>/…`. Everything else stays open, also
 * `devcontainers`: CI does not build the dev container.
 */
export const AUTOMERGE_ECOSYSTEMS = ['npm_and_yarn', 'github_actions'];

const AUTOMERGE_UPDATE_TYPES = ['version-update:semver-minor', 'version-update:semver-patch'];

const DEPENDABOT = 'dependabot[bot]';
/** Commits made by GitHub, signed with its key: `web-flow`. */
const COMMITTERS = ['web-flow', DEPENDABOT];

/**
 * Why the dependencies may not be auto-merged. One of them keeps the whole pull request open.
 * @param {unknown} metadata
 * @returns {string[]}
 */
export function dependencyReasons(metadata) {
  if (!Array.isArray(metadata) || metadata.length === 0) {
    throw new Error('no updated dependencies in the metadata');
  }
  /** @type {string[]} */
  const reasons = [];
  for (const dependency of metadata) {
    const { dependencyName: name, packageEcosystem, updateType } = dependency ?? {};
    if (typeof name !== 'string' || typeof packageEcosystem !== 'string') {
      throw new Error(`cannot read the metadata entry ${JSON.stringify(dependency)}`);
    }
    if (MANUAL_DEPENDENCIES.includes(name)) {
      reasons.push(`${name} is always reviewed by hand`);
    }
    if (!AUTOMERGE_ECOSYSTEMS.includes(packageEcosystem)) {
      reasons.push(`${name}: ecosystem ${packageEcosystem} is not auto-merged`);
    }
    if (!AUTOMERGE_UPDATE_TYPES.includes(updateType)) {
      reasons.push(
        `${name}: ${updateType || 'unknown update type'} is not a minor or patch update`,
      );
    }
  }
  return reasons;
}

/**
 * Why the commits may not be auto-merged: all of them must come from Dependabot. The author of a
 * commit is free text, so the signature must belong to GitHub, too.
 * @param {unknown} pages
 * @param {string} headSha
 * @returns {string[]}
 */
export function commitReasons(pages, headSha) {
  if (!headSha) throw new Error('no head commit');
  if (!Array.isArray(pages) || !pages.every(Array.isArray) || pages.flat().length === 0) {
    throw new Error('no commits in the commit list');
  }
  const commits = pages.flat();
  /** @type {string[]} */
  const reasons = [];
  for (const commit of commits) {
    if (typeof commit?.sha !== 'string') throw new Error('cannot read the commit list');
    const name = `commit ${commit.sha.slice(0, 7)}`;
    const author = commit.author?.login;
    const committer = commit.committer?.login;
    if (author !== DEPENDABOT) {
      reasons.push(`${name} is by ${author ?? 'an unknown author'}, not by Dependabot`);
    }
    if (!COMMITTERS.includes(committer)) {
      reasons.push(`${name} is committed by ${committer ?? 'an unknown user'}, not by GitHub`);
    }
    if (commit.commit?.verification?.verified !== true) {
      reasons.push(`${name} has no verified signature`);
    }
  }
  // The API lists at most 250 commits, and the branch may have moved since the event.
  if (!commits.some((commit) => commit.sha === headSha)) {
    const head = headSha.slice(0, 7);
    reasons.push(`commit ${head}, the head of the pull request, is not in the commit list`);
  }
  return reasons;
}

/**
 * @param {unknown} metadata
 * @param {unknown} commitPages
 * @param {string} headSha
 * @returns {{ automerge: boolean, reasons: string[] }}
 */
export function decide(metadata, commitPages, headSha) {
  const reasons = [...dependencyReasons(metadata), ...commitReasons(commitPages, headSha)];
  return { automerge: reasons.length === 0, reasons };
}

/**
 * Escapes text for a workflow command.
 * @param {string} text
 */
export function escapeCommand(text) {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function main() {
  const {
    UPDATED_DEPENDENCIES: json,
    COMMITS_FILE: commitsFile,
    HEAD_SHA: headSha,
    GITHUB_OUTPUT: output,
  } = process.env;
  if (!json || !commitsFile || !headSha || !output) {
    throw new Error('UPDATED_DEPENDENCIES, COMMITS_FILE, HEAD_SHA and GITHUB_OUTPUT must be set');
  }
  const metadata = JSON.parse(json);
  const commitPages = JSON.parse(readFileSync(commitsFile, 'utf8'));
  const { automerge, reasons } = decide(metadata, commitPages, headSha);
  const names = metadata.map((/** @type {{ dependencyName: string }} */ d) => d.dependencyName);
  const line = automerge
    ? `Auto-merge after the required checks: ${names.join(', ')}`
    : `Not auto-merged: ${reasons.join('; ')}`;
  console.log(`::notice::${escapeCommand(line)}`);
  appendFileSync(output, `automerge=${String(automerge)}\n`);
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

// Decides whether a Dependabot pull request may be auto-merged. Used by
// .github/workflows/dependabot-automerge.yml, with the JSON from dependabot/fetch-metadata.
//
// Env: UPDATED_DEPENDENCIES (output `updated-dependencies-json`), GITHUB_OUTPUT (gets `automerge`).
// Prints the decision and its reasons as a notice. Exits 1 on metadata it cannot read.
// Only Node built-ins: the workflow installs nothing.
import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Exact names. esbuild and typescript produce the shipped code; playwright-core drives the live
 * session, which CI does not run.
 */
export const MANUAL_DEPENDENCIES = ['esbuild', 'typescript', 'playwright-core'];

/**
 * As in the branch name `dependabot/<ecosystem>/…`. Everything else stays open, also
 * `devcontainers`: CI does not build the dev container.
 */
export const AUTOMERGE_ECOSYSTEMS = ['npm_and_yarn', 'github_actions'];

const AUTOMERGE_UPDATE_TYPES = ['version-update:semver-minor', 'version-update:semver-patch'];

/**
 * One dependency that may not be auto-merged keeps the whole pull request open.
 * @param {unknown} metadata
 * @returns {{ automerge: boolean, reasons: string[] }}
 */
export function decide(metadata) {
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
  const { UPDATED_DEPENDENCIES: json, GITHUB_OUTPUT: output } = process.env;
  if (!json || !output) throw new Error('UPDATED_DEPENDENCIES and GITHUB_OUTPUT must be set');
  const metadata = JSON.parse(json);
  const { automerge, reasons } = decide(metadata);
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

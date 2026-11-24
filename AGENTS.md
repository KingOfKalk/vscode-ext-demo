# AGENTS.md

Guidance for any coding agent working in this repository. [CONTRIBUTING.md](CONTRIBUTING.md) has the workflow.

## Rules

- Keep changes minimal and focused. Follow the code that is already there.
- Never commit secrets, or generated files (`dist/`, `*.vsix`, `node_modules/`, `.vscode-live/`).
- No AI attribution in commits, pull requests, issues, code or docs. No `Co-Authored-By`.
- Commits and PR titles are Conventional Commits; the type drives the release version.
- Never commit or push to `main`. Work on a branch, open a draft PR, push only to `origin`.
- Never edit `CHANGELOG.md` or `.release-please-manifest.json`; the release PR owns them. Never tag or bump `version` by hand.
- Never push to a Dependabot branch and never enable auto-merge. Merging is the owner's job.
- This repo is public: no tokens, local paths, personal data, gists, forks or visibility changes.
- No publishing to any marketplace: no publish script, token or step.
- Dependencies: look up the latest stable version at its source, never take it from memory; pin it exactly; actions by full commit SHA with a `# vX.Y.Z` comment. Name the versions in the PR.
- Workflows: `permissions: {}` at the top and the minimum per job, `persist-credentials: false` on checkout, no `pull_request_target`, runners pinned to `ubuntu-26.04`.
- Shell scripts fail loudly (`set -euo pipefail`); a script that hides a failure is a bug.

## Definition of done

1. `npm run check` passes.
2. `npm run test:smoke` passes.
3. Anything visible or interactive: tried in a live VS Code session (added in part 3, [#4](https://github.com/KingOfKalk/vscode-ext-demo/issues/4)). The PR says in text what was tried and seen.
4. Draft PR, CI green (`lint`, `test`, `build`, `smoke`), then mark it ready. The owner merges.

Green unit tests do not prove that the extension starts; the smoke tests do.

## Commands

Node 26 and npm. The dev container has both. The smoke tests need Linux with `scripts/install-system-deps.sh` (Debian 13, Ubuntu 26.04; the dev container runs it) and keep the VS Code download in `.vscode-test/`, or in the directory `VSCODE_TEST_CACHE`.

| Command                           | Does                                                              |
| --------------------------------- | ----------------------------------------------------------------- |
| `npm ci`                          | install exactly what `package-lock.json` says                     |
| `npm run check`                   | format check, lint, typecheck, unit tests, build; run before push |
| `npm run build` / `watch`         | bundle `dist/extension.js` and `dist/webview.js`                  |
| `npm run format`                  | rewrite files with Prettier                                       |
| `npm test`                        | unit tests (Vitest)                                               |
| `npm run test:smoke [-- <vsix>]`  | packages (or takes the `.vsix`) and tests it in a real VS Code under Xvfb |
| `npm run package`                 | build and write `vscode-ext-demo-<version>.vsix`                  |
| `npm run check:vsix -- <file>`    | compare the `.vsix` contents with the expected file list          |

After changing `.github/` (needs Docker): `docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:1.7.12`

## Code map

- `src/extension.ts`: extension host entry, `activate()`; wires store, window, status bar, sidebar and commands, returns `{ getCount }`. Bundled to `dist/extension.js` (CommonJS, `vscode` external).
- `src/demoWindow.ts`, `statusBar.ts`, `actionsView.ts`: thin VS Code adapters (panel and tabs of the window, status bar item, sidebar tree). They only map VS Code objects to the pure modules; the rules live in those and are unit tested.
- `src/counterStore.ts`: the only truth for the count (no `vscode` import). `windowController.ts`: the window's life cycle (one window, restore, close stale tabs) over the `PanelHandle` and `WindowHost` interfaces. `settings.ts`, `protocol.ts`, `windowHtml.ts`, `windowMessages.ts`, `counterActions.ts`, `labels.ts`, `nonce.ts`, `describe.ts`: pure helpers. `ids.ts`: every ID shared with `package.json`; no other file in `src/` spells one out.
- `src/webview/main.ts`: code that runs in the webview. Bundled to `dist/webview.js` (IIFE).
- `media/`: files the webview and the extension load (icon, CSS).
- `esbuild.mjs`: the bundles; unminified, with linked source maps. Maps stay out of the `.vsix`.
- `scripts/`: `package.mjs`, `check-vsix.mjs`, `vscode.mjs` (downloads VS Code), `install-system-deps.sh` (packages VS Code and Xvfb need), `ci-summary.mjs` (CI job summaries), `dependabot-automerge.mjs` (auto-merge decision).
- `tests/unit/`: Vitest tests. They must not import `vscode`. `manifest.test.ts` checks `package.json` (commands, settings, views) against `src/ids.ts`.
- `tests/smoke/`: `run.mjs` installs the `.vsix` into an empty profile of the VS Code version in `engines.vscode` and runs `suite.ts` in its extension host; an error or warning of the extension in a log fails, too. `driver/` is the empty extension VS Code needs as test host. VS Code storage is in memory there: restoring the window and saving the count are for the live session.
- `package.json` `files`: the only files in the `.vsix`: `dist/extension.js`, `dist/webview.js`, `media/`, `LICENSE`. `vsce` adds the README; other docs stay out.
- `.github/`: workflows (`ci.yml`, `release-please.yml`, `dependabot-automerge.yml`), the `setup` action, `dependabot.yml`.
- `.devcontainer/`: dev container, with the lock file for its features.

`engines.vscode` (`^1.146.0`) and `@types/vscode` (`1.146.0`) move together, by hand. Dependabot ignores `@types/vscode`.

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

## Issues and the spec

- Work starts from an issue: open one, or claim the one you were given (set `status/in-progress`). The status labels and transitions are in [CONTRIBUTING.md](CONTRIBUTING.md#issue-lifecycle).
- Comment on every status transition.
- The spec (the extension's requirements) is issue [#1](https://github.com/KingOfKalk/vscode-ext-demo/issues/1), not a file in the repo.

## Definition of done

1. `npm run check` passes.
2. `npm run test:smoke` passes.
3. Anything visible or interactive: tried in a live VS Code session (see Live session). The PR says in text what was tried and seen.
4. Draft PR, CI green (`lint`, `test`, `build`, `smoke`), then `gh pr ready` and set `status/review`. The owner merges. If the task says to open only a draft, leave it a draft and say so.

Green unit tests do not prove that the extension starts; the smoke tests do.

## Add a command

Take `decrement` (commit 4ee9313) as the model. A command touches:

1. `src/ids.ts`: the ID in `COMMANDS`.
2. `package.json`: the entry in `contributes.commands` (`title`, `category: "Demo"`); `tests/unit/manifest.test.ts` lists the palette commands in order.
3. `src/extension.ts`: `registerCommand(COMMANDS.<id>, …)` wrapped in `guarded`.
4. The action itself, if it changes the count: a method in `src/counterStore.ts` and a unit test.
5. A button in the window: the message type in `src/protocol.ts` (type and `TO_EXTENSION_TYPES`), a `case` in `src/windowMessages.ts` and its `store` interface, the `<button>` in `src/windowHtml.ts`, the click handler in `src/webview/main.ts`, styles in `media/window.css`. The button ID is the action name (`decrement`).
6. `README.md`: the Commands table.
7. Tests: unit (`tests/unit/`: `protocol`, `windowHtml`, `windowMessages`, `manifest`, `counterStore`), webview (`tests/webview/main.test.ts`), smoke (a check in `tests/smoke/suite.ts`).

## Live session

For anything visible or interactive: a real VS Code in a virtual display, driven by `npm run live -- <command>` (plain text, exit 1 on failure). One session per machine or container, and a checkout cannot use the session of another: `stop` when done. The VS Code download is the one of the smoke tests. Outside the dev container run `scripts/install-system-deps.sh --live` once.

- `start [--keep]`: build, install into a fresh profile, start, print the noVNC URL; `--keep` keeps profile and count. `stop`, `status`.
- `reload`: after every code change. Rebuilds, reinstalls, reloads the window, keeps the profile.
- `snapshot`: the UI as text, with the names `click` takes. Look first. `screenshot [name]` writes a PNG to `.vscode-live/`; read it only if the text does not tell.
- `click <target>`, `type <text>`, `key <combo>`, `command <title>`: act like a user, e.g. `command "Demo: Open Window"`, `key Control+Shift+P` (Playwright key names; `Ctrl` fails). A target is an accessible name, `role=<role>:<name>` or `css=<selector>`; an error lists what exists.
- `set <setting> <json>`: change a setting, e.g. `set vscodeExtDemo.step 5`.
- `logs [--lines N]`: `Demo` channel, extension host log, webview console errors. Run it after anything surprising.
- `eval <expr>`: evaluate in the extension host without pausing it.
- `break <file:line> [--do <live command>] [--eval <expr>…]`: stop at a TypeScript line while `--do` runs, print stack, locals and the expressions, continue.
- Loop: edit, `reload`, `snapshot`, act, `snapshot`, `logs`. The PR says in text what was tried and seen; never upload screenshots.
- Output has local paths: shorten them before pasting into a PR or issue of this public repo. `eval process.env` prints the session environment: never paste it.
- `break` and `eval` can freeze the window (native code, a timer loop, a killed command). Way out: `npm run live -- stop`, then `start --keep`.

## Commands

Node 26 and npm. The dev container has both. The smoke tests need Linux with `scripts/install-system-deps.sh` (Debian 13, Ubuntu 26.04; the dev container runs it) and keep the VS Code download in `.vscode-test/`, or in the directory `VSCODE_TEST_CACHE`.

| Command                           | Does                                                              |
| --------------------------------- | ----------------------------------------------------------------- |
| `npm ci`                          | install exactly what `package-lock.json` says; CI adds `--ignore-scripts` |
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
- `src/counterStore.ts`: the only truth for the count (no `vscode` import). `windowController.ts`: the window's life cycle (one window, restore, close stale tabs, replace a dead window) over the `PanelHandle` and `WindowHost` interfaces. `settings.ts`, `protocol.ts`, `windowHtml.ts`, `windowMessages.ts`, `counterActions.ts`, `labels.ts`, `nonce.ts`, `describe.ts`: pure helpers. `ids.ts`: every ID shared with `package.json`; no other file in `src/` spells one out.
- `src/webview/main.ts`: code that runs in the webview. Bundled to `dist/webview.js` (IIFE). `src/webview/tsconfig.json` adds the DOM types for it, which the extension host code does not get. `npm run typecheck` therefore runs five configs: the root one (`src` and `tests` without the folders below), `src/webview`, `tests/webview`, `scripts/live` and `tests/unit/live`.
- `media/`: files the webview and the extension load (icon, CSS).
- `esbuild.mjs`: the bundles; unminified, with linked source maps. Maps stay out of the `.vsix`. `watch` prints one `[watch] build started` and one `[watch] build finished` per rebuild, whether it rebuilds one bundle or both (`scripts/watch-markers.mjs`); the background task of F5 waits for them.
- `scripts/`: `package.mjs`, `check-vsix.mjs`, `vscode.mjs` (downloads VS Code), `vscode-run.mjs` (what smoke and live share: flags, quiet settings, install, process groups, Xvfb; the clean environment of smoke is `cleanEnv` here, the one of live is `scripts/live/environment.ts`), `install-system-deps.sh` (packages VS Code and Xvfb need; `--live` adds those of the live session), `ci-summary.mjs` (CI job summaries), `dependabot-automerge.mjs` (auto-merge decision).
- `scripts/live/`: the live session, `npm run live -- <command>`. Node runs the TypeScript directly (type stripping): only erasable syntax, imports with `.ts`. One session per machine or container: its state, logs and profile are in `/tmp/vscode-ext-demo-live`; `.vscode-live/` has screenshots only. `start`, `reload` and `set` depend on the wording of two log lines in `src/extension.ts` (`Extension activated, count <n>`, `Settings changed: <json>`; read by `scripts/live/logs.ts`). `start` and `reload` end on the first event, not on a time limit: the activation line, `Activating extension <id> failed` (extension host log), VS Code ended, or `Extension host … terminated unexpectedly` (window log) that is not followed by an activation within 5 s, as VS Code restarts the host by itself (`scripts/live/activation.ts`); the 45 s and 30 s limits are only for a hang.
- `tests/unit/`: Vitest tests. They must not import `vscode`. `manifest.test.ts` checks `package.json` (commands, settings, views) against `src/ids.ts`.
- `tests/webview/`: Vitest tests of `src/webview/main.ts` in jsdom, with their own `tsconfig.json` (extends the webview one).
- `tests/smoke/`: `run.mjs` installs the `.vsix` into an empty profile of the VS Code version in `engines.vscode` and runs `suite.ts` in its extension host; an error or warning of the extension in a log fails, too. `driver/` is the empty extension VS Code needs as test host. VS Code storage is in memory there: restoring the window and saving the count are for the live session.
- `package.json` `files`: the only files in the `.vsix`: `dist/extension.js`, `dist/webview.js`, `media/`, `LICENSE`. `vsce` adds the README; other docs stay out.
- `.github/`: workflows (`ci.yml`, `release-please.yml`, `dependabot-automerge.yml`), the `setup` action, `dependabot.yml`.
- `.devcontainer/`: dev container, with the lock file for its features.
- `.vscode/`: F5 ("Run Extension": watch build, source maps, Extension Development Host on `.vscode-live/sandbox`) and recommended extensions. The owner uses it; agents use the live session.

`engines.vscode` (`^1.146.0`) and `@types/vscode` (`1.146.0`) move together, by hand. Dependabot ignores `@types/vscode`.

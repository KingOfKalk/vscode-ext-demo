# Contributing

Development here is mostly agent-driven, with the owner reviewing before merge. A few conventions keep `main` releasable. Agent rules are in [AGENTS.md](AGENTS.md).

## Workflow

1. Open an issue first, so scope is discussed before code is written.
2. Never commit to `main`. The `main` ruleset requires a pull request and the checks below.
3. Work in a git worktree on a new branch from the latest `origin/main`; the main checkout stays on `main`:
   `git worktree add --no-track <path> -b <type>/<issue-number>-<slug> origin/main`
   After the merge, remove the worktree and delete the local branch.
4. Push early and open a draft PR (`gh pr create --draft`). Mark it ready (`gh pr ready`) when the work is done and CI is green. End the PR body with `Closes #<issue>`.
5. The owner merges. PRs are squash-merged; the PR title becomes the commit subject and the PR body is dropped. Mark a breaking change in the title (`feat!: ...`); a `BREAKING CHANGE:` footer in the body has no effect.

Branch names: `<type>/<issue-number>-<slug>`, `<type>` being the Conventional Commit type, `<slug>` short and kebab-case.

## Issue lifecycle

The `status/*` labels show where an issue stands. An open issue without one is a new idea; a closed one without one is done. At most one status label at a time; swap them, do not stack them.

| State       | Label                | Meaning                                                           |
| ----------- | -------------------- | ----------------------------------------------------------------- |
| Idea        | none                 | just created                                                      |
| Refining    | `status/refining`    | being discussed; notes and open questions as comments             |
| Ready       | `status/ready`       | plan agreed and in the issue body; waits for "work on it"         |
| In progress | `status/in-progress` | someone works on it; draft PR, progress as comments               |
| Blocked     | `status/blocked`     | waits for the owner; the question is in the latest comment        |
| Review      | `status/review`      | PR ready, CI green; waits for the owner                           |
| Done        | none                 | merged; worktree and branch removed                               |
| Won't do    | `status/wont-do`     | the owner decided against it; reason in a comment, then closed    |

- Comment on every transition, for example `**Status: In progress** (Ready -> In progress)` and what happened. A new session can then resume from GitHub alone.
- `status/wont-do` is set only on the owner's instruction, with a reason.
- Large work is a parent issue with one sub-issue and one PR each.

Type labels (`feat`, `fix`, `perf`, `docs`, `style`, `refactor`, `test`, `build`, `ci`, `chore`, plus `breaking`) match the PR title; put them on the PR too. `bug` and `idea` mark the kind of an issue.

## Commits

[Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/), scope = area (`fix(devcontainer): ...`, `docs: ...`). The type sets the next version and the changelog section ([`release-please-config.json`](release-please-config.json)):

| Type        | Version bump | Changelog section        |
| ----------- | ------------ | ------------------------ |
| `feat`      | minor        | Features                 |
| `fix`       | patch        | Bug Fixes                |
| `perf`      | patch        | Performance Improvements |
| `revert`    | patch        | Reverts                  |
| `refactor`  | patch        | Code Refactoring         |
| `docs`      | patch        | Documentation            |
| `style`     | patch        | Styles                   |
| `test`      | patch        | Tests                    |
| `build`     | patch        | Build System             |
| `ci`        | patch        | Continuous Integration   |
| `chore`     | patch        | Chores                   |

A `!` after the type marks a breaking change: major, or minor while the version is `0.x`.

## Checks

CI ([`ci.yml`](.github/workflows/ci.yml)) runs on every pull request and push to `main`. The jobs run in sequence and each writes a job summary:

- `lint`: `format:check`, `lint`, `typecheck`
- `test`: unit tests
- `build`: `npm run package`, `npm run check:vsix`, the `.vsix` as an artifact for 14 days

All three are required. Run `npm run check` locally first. CI does not build the dev container; after changing `.devcontainer/`, rebuild it to verify.

## Releases

[release-please](https://github.com/googleapis/release-please-action) ([`release-please.yml`](.github/workflows/release-please.yml)) keeps a release PR (`chore(main): release X.Y.Z`) up to date on every push to `main`: the version bump and `CHANGELOG.md`. The first release is `0.1.0`.

- Merging the release PR (squash, title unchanged) tags `vX.Y.Z` and creates the GitHub release.
- The workflow then checks that `package.json` matches the tag, runs `npm run check`, packages and checks the `.vsix`, and attaches `vscode-ext-demo-X.Y.Z.vsix` to the release. A rerun of the workflow adds a missing file.
- Nothing is published to a marketplace. Users install the `.vsix` by hand.
- Do not tag, bump versions or edit `CHANGELOG.md` by hand.
- The workflows use a GitHub App (secrets `RELEASE_APP_CLIENT_ID`, `RELEASE_APP_PRIVATE_KEY`), so that release PRs and auto-merges start the other workflows.

## Dependencies

[Dependabot](.github/dependabot.yml) checks npm, GitHub Actions and the dev container weekly (7-day cooldown), with `chore(deps)` titles.

- Minor and patch updates of npm and GitHub Actions are auto-merged after the required checks, but only if every commit in the PR is a verified Dependabot commit ([`dependabot-automerge.mjs`](scripts/dependabot-automerge.mjs)). The decision shows as a notice in the run.
- Left for the owner's review: major updates, dev container updates, and `esbuild`, `typescript`, `playwright-core`, `actions/create-github-app-token`, `actions/download-artifact`, `dependabot/fetch-metadata` and `googleapis/release-please-action`. They wait for the owner; do not merge or update them on your own.
- To bring a Dependabot PR up to date with `main`, comment `@dependabot rebase`. Do not use "Update branch": it adds a commit that is not Dependabot's, and auto-merge stops.
- `@types/vscode` is ignored by Dependabot; it and `engines.vscode` are raised together by hand.
- Dependabot does not update the base image in `devcontainer.json`; bump it by hand.

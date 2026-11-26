# VS Code Extension Demo

A small VS Code extension (`kingofkalk.vscode-ext-demo`) built to find out how well AI agents develop VS Code extensions: change code, run a real VS Code, look at the result, fix it. The extension is small on purpose; the workflow is the subject.

It is not published to the VS Code Marketplace or Open VSX, and never will be. Install it from a `.vsix`.

## Show the agent loop

1. Open the repository in the dev container and give an agent a task, e.g. an issue. It reads [AGENTS.md](AGENTS.md).
2. The agent changes the code and runs `npm run check` (format, lint, types, unit tests, build).
3. It runs `npm run test:smoke`: the packaged `.vsix` in a real VS Code, which reads what a user sees (window, sidebar, status bar) and then restarts VS Code to check that the window and the count come back. Nothing is clicked.
4. For anything visible it starts the live session (`npm run live -- start`) and clicks through a real VS Code. Open the `noVNC:` URL it prints to watch.
5. It opens a pull request. CI runs `lint`, `test`, `build` and `smoke`; a person reviews and merges.

What agents did with it so far, each on its own, without help:

| Trial | Agent | Task | Result |
| ----- | ----- | ---- | ------ |
| [#6](https://github.com/KingOfKalk/vscode-ext-demo/issues/6) | Claude Code | add a command and a window button | done in 7 min |
| [#18](https://github.com/KingOfKalk/vscode-ext-demo/issues/18) | Claude Code, 3 runs | find and fix a bug from a user report, blind | 3 of 3 fixed, in 7, 7 and 10 min |
| [#35](https://github.com/KingOfKalk/vscode-ext-demo/issues/35) | Mistral Vibe | add a command and a window button | done in 7 min |

## Install

1. Download `vscode-ext-demo-<version>.vsix` from the [latest release](https://github.com/KingOfKalk/vscode-ext-demo/releases/latest). If there is no release yet, build it yourself (see below).
2. Run `code --install-extension vscode-ext-demo-<version>.vsix`, or use "Extensions: Install from VSIX..." in VS Code.

Requires VS Code 1.146.0 or newer. Updates are manual: install the next `.vsix` over it.

## Commands

The extension activates after startup and writes to the `Demo` output channel. Commands (category `Demo`):

| Command           | Does                                                      |
| ----------------- | --------------------------------------------------------- |
| Open Window       | opens the Demo window (an editor tab), or reveals it      |
| Say Hello         | shows the `message` setting as a notification             |
| Increment Counter | adds `step` to the counter                                |
| Decrement Counter | subtracts `step` from the counter, never below 0          |
| Reset Counter     | sets the counter to 0                                     |
| Show Log          | opens the `Demo` output channel                           |

The count is kept per workspace. The Demo window, the status bar item (`Demo: <count>`, click opens the window) and the Demo view in the activity bar (gear: this extension's settings) all show it.

Settings:

| Setting                      | Default                  | Meaning                                              |
| ---------------------------- | ------------------------ | ---------------------------------------------------- |
| `vscodeExtDemo.message`      | `Hello from kingofkalk!` | greeting for Say Hello and the window                |
| `vscodeExtDemo.step`         | `1`                      | whole number from 1 to 100 added per increment, subtracted per decrement |
| `vscodeExtDemo.showStatusBar` | `true`                  | show the counter in the status bar                   |
| `vscodeExtDemo.openLocation` | `tab`                    | `tab` or `beside`; used the next time the window opens |

In an untrusted folder (Restricted Mode) the extension works, but ignores the `message` set by that folder's `.vscode/settings.json`; your own `message` applies.

## Build it yourself

Needs Node 26. The dev container (`.devcontainer/`) has it.

```sh
npm ci
npm run check       # format, lint, types, unit tests, build
npm run package     # writes vscode-ext-demo-<version>.vsix
npm run test:smoke  # tests the .vsix in a real VS Code, see AGENTS.md
```

Working on the code, as a person or an agent: see [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## Live session and F5

- Watch the extension run in a browser: `npm run live -- start` in the dev container, then open the `noVNC:` URL it prints (port 6080, which the dev container forwards; the URL carries a token). `npm run live -- stop` ends it. Agents drive the same window, see [AGENTS.md](AGENTS.md). `LIVE_NOVNC_PORT` changes the port. If the session runs in a container whose port is published to the localhost of its host (a container inside the dev container), set `LIVE_NOVNC_HOST=0.0.0.0` there (any IP address). noVNC is then open to the network of that container; the token is its only protection.
- Debug it yourself: press F5 ("Run Extension"). It starts the watch build and an Extension Development Host that opens the empty folder `.vscode-live/sandbox`; breakpoints in the TypeScript work through the source maps.

If the Extension Development Host window closes at once after F5, press F5 again. The likely cause is a known race in VS Code's JavaScript debugger ([js-debug #2462](https://github.com/microsoft/vscode-js-debug/issues/2462)). Setting `"debug.javascript.enableNetworkView": false` is reported to avoid it.

## License

[MIT](LICENSE)

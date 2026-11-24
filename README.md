# VS Code Extension Demo

A small VS Code extension (`kingofkalk.vscode-ext-demo`) built to find out how well AI agents develop VS Code extensions: change code, run a real VS Code, look at the result, fix it. The extension is small on purpose; the workflow is the subject.

It is not published to the VS Code Marketplace or Open VSX, and never will be. Install it from a `.vsix`.

## Install

1. Download `vscode-ext-demo-<version>.vsix` from the [latest release](https://github.com/KingOfKalk/vscode-ext-demo/releases/latest). If there is no release yet, build it yourself (see below).
2. Run `code --install-extension vscode-ext-demo-<version>.vsix`, or use "Extensions: Install from VSIX..." in VS Code.

Requires VS Code 1.146.0 or newer. Updates are manual: install the next `.vsix` over it.

## Commands

The extension activates after startup and writes to the `Demo` output channel. Its commands (category `Demo`), settings, sidebar, window and status bar come with [#3](https://github.com/KingOfKalk/vscode-ext-demo/issues/3).

## Build it yourself

Needs Node 26. The dev container (`.devcontainer/`) has it.

```sh
npm ci
npm run check    # format, lint, types, unit tests, build
npm run package  # writes vscode-ext-demo-<version>.vsix
```

Working on the code, as a person or an agent: see [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

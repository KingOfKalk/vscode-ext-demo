/** Every ID the extension shares with `package.json`. Nothing else in `src/` spells them out. */
export const EXTENSION_ID = 'kingofkalk.vscode-ext-demo';
export const CONFIG_SECTION = 'vscodeExtDemo';
export const VIEW_ID = 'vscodeExtDemo.actions';
export const VIEW_TYPE = 'vscodeExtDemo.window';
export const STATUS_BAR_ID = 'vscodeExtDemo.status';

export const COMMANDS = {
  openWindow: 'vscodeExtDemo.openWindow',
  sayHello: 'vscodeExtDemo.sayHello',
  increment: 'vscodeExtDemo.increment',
  reset: 'vscodeExtDemo.reset',
  showLog: 'vscodeExtDemo.showLog',
  /** Internal: the gear of the sidebar. Not in the command palette. */
  openSettings: 'vscodeExtDemo.openSettings',
} as const;

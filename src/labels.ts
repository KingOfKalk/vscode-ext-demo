import { COMMANDS } from './ids';

export const STATUS_BAR_TOOLTIP = 'Open the Demo window';

export function statusBarText(count: number): string {
  return `$(dashboard) Demo: ${count}`;
}

/** One row of the sidebar. `icon` is a codicon name; a row without `command` does nothing. */
export interface ActionRow {
  id: string;
  label: string;
  icon: string;
  command?: string;
}

export function actionRows(count: number): ActionRow[] {
  return [
    { id: 'openWindow', label: 'Open window', icon: 'window', command: COMMANDS.openWindow },
    { id: 'sayHello', label: 'Say hello', icon: 'comment', command: COMMANDS.sayHello },
    { id: 'showLog', label: 'Show log', icon: 'output', command: COMMANDS.showLog },
    { id: 'counter', label: `Counter: ${count}`, icon: 'symbol-numeric' },
  ];
}

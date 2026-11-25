// What VS Code shows. The extension API cannot read it, so this asks VS Code over its remote
// debugging port, which run.mjs opens. It only reads: the smoke tests never click.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_ID, STATUS_BAR_ID } from '../../src/ids';

/** A page of the Demo window. A text is '' if it is not visible, or until the script runs. */
export interface Page {
  message: string;
  count: string;
  /** Whether `media/window.css` was loaded. */
  styled: boolean;
}

export interface Screen {
  /** The item of the extension, if it is visible. */
  statusBar: string[];
  /** The rows of the visible view. */
  sidebar: string[];
  notifications: string[];
  /** The pages of the extension; a hidden one only if VS Code keeps it. */
  windows: Page[];
}

interface Target {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

const WORKBENCH = `(() => {
  const texts = (selector) =>
    [...document.querySelectorAll(selector)]
      .filter((element) => element.checkVisibility({ visibilityProperty: true }))
      .map((element) => element.textContent.trim());
  return {
    statusBar: texts('[id="${EXTENSION_ID}.${STATUS_BAR_ID}"]'),
    sidebar: texts('[id="workbench.parts.sidebar"] [role="treeitem"]'),
    notifications: texts('.notifications-toasts .notification-list-item-message'),
  };
})()`;

// The page is in a frame of its own inside the frame that VS Code makes for a webview.
const WINDOW = `(() => {
  const page = document.getElementById('active-frame')?.contentDocument;
  const text = (id) => {
    const element = page?.getElementById(id);
    return element?.checkVisibility({ visibilityProperty: true }) ? element.textContent : '';
  };
  const sheet = page?.querySelector('link[rel="stylesheet"]')?.sheet;
  // A missing or blocked file leaves an empty sheet.
  const styled = sheet != null && sheet.cssRules.length > 0;
  return { message: text('message'), count: text('count'), styled };
})()`;

interface Answer {
  result?: {
    result?: { value?: unknown };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  };
}

/** Evaluates in a target. Rejects if it throws or the connection ends before the answer. */
async function evaluate(target: Target, expression: string): Promise<unknown> {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  try {
    const answer = await new Promise<string>((resolve, reject) => {
      socket.onopen = () => {
        const params = { expression, returnByValue: true };
        socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params }));
      };
      socket.onmessage = ({ data }) => {
        resolve(String(data));
      };
      socket.onerror = socket.onclose = () => {
        reject(new Error('the connection to VS Code was lost'));
      };
    });
    const { result } = JSON.parse(answer) as Answer;
    const thrown = result?.exceptionDetails;
    if (thrown) throw new Error(thrown.exception?.description ?? thrown.text);
    return result?.result?.value;
  } finally {
    socket.close();
  }
}

/** Rejects while VS Code or a page comes or goes. */
export async function readScreen(profile: string): Promise<Screen> {
  const [port] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n');
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = (await response.json()) as Target[];
  const workbench = targets.find(({ type, url }) => type === 'page' && url.includes('/workbench/'));
  if (!workbench) throw new Error('there is no VS Code window');
  const pages = targets.filter(
    ({ type, url }) => type === 'iframe' && url.includes(`extensionId=${EXTENSION_ID}&`),
  );
  const [shown, ...windows] = await Promise.all([
    evaluate(workbench, WORKBENCH),
    ...pages.map((page) => evaluate(page, WINDOW)),
  ]);
  return { ...(shown as Omit<Screen, 'windows'>), windows: windows as Page[] };
}

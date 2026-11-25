// What `click` and the others point at, in text: parsing it and telling the user which things match.
// Pure; the part that looks at the window is `resolveTarget` in interact.ts.
import type { AriaNode } from './aria.ts';

/** `workbench` is the window of VS Code, `webview` the Demo window inside it. */
export type Scope = 'workbench' | 'webview';

export type Target =
  { kind: 'css'; selector: string } | { kind: 'name'; name: string; role: string | undefined };

export interface Candidate {
  scope: Scope;
  role: string;
  name: string;
}

/** The ways to write a target, for error messages and the usage. */
export const TARGET_SYNTAX =
  'a name ("Click me"), a role and a name (role=tab:Demo), or a selector (css=#count)';

/**
 * `css=<selector>` is a selector, `role=<role>:<name>` an accessible name with its role (the way to
 * tell apart things that share a name), anything else an accessible name. Names are matched exactly.
 * Throws if the text is empty or malformed.
 */
export function parseTarget(text: string): Target {
  if (text.startsWith('css=')) {
    const selector = text.slice('css='.length).trim();
    if (selector === '') throw new Error('css= needs a selector, like css=#count');
    return { kind: 'css', selector };
  }
  if (text.startsWith('role=')) {
    const match = /^role=([a-z]+):(.*)$/s.exec(text);
    const name = match?.[2]?.trim();
    if (!match?.[1] || !name) throw new Error('role= needs a role and a name, like role=tab:Demo');
    return { kind: 'name', role: match[1], name };
  }
  const name = text.trim();
  if (name === '') throw new Error(`the target is empty; use ${TARGET_SYNTAX}`);
  return { kind: 'name', name, role: undefined };
}

/** The elements of both scopes that have exactly this name (and role, if given). */
export function findNamed(
  scopes: readonly { scope: Scope; nodes: readonly AriaNode[] }[],
  name: string,
  role?: string,
): Candidate[] {
  return scopes.flatMap(({ scope, nodes }) =>
    nodes
      .filter((node) => node.name === name && (role === undefined || node.role === role))
      .map(({ role: nodeRole }) => ({ scope, role: nodeRole, name })),
  );
}

/** How a candidate is written in an error message: what to give as the target to pick it. */
export function formatCandidate({ scope, role, name }: Candidate): string {
  return `role=${role}:${name} (${scope})`;
}

const MAX_LISTED = 12;

function listed(candidates: readonly string[], more: string): string {
  const shown = candidates.slice(0, MAX_LISTED).map((line) => `  ${line}`);
  if (candidates.length > MAX_LISTED)
    shown.push(`  … ${candidates.length - MAX_LISTED} more${more}`);
  return shown.join('\n');
}

/** Error text for a name that more than one element has. */
export function describeSeveral(target: string, found: readonly Candidate[]): string {
  return `${found.length} elements match "${target}"; narrow it with one of:\n${listed(found.map(formatCandidate), '')}`;
}

/** Roles of things a person clicks or types into; the others are in the way in a list of choices. */
const POINTABLE = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

/**
 * Error text for a name nothing has: the elements whose name contains it or the other way round
 * (ignoring case), or, if there are none, some that can be clicked, those of the Demo window first.
 */
export function describeNone(
  target: string,
  scopes: readonly { scope: Scope; nodes: readonly AriaNode[] }[],
  role?: string,
): string {
  const all: Candidate[] = [];
  const seen = new Set<string>();
  const webviewFirst = [...scopes].sort(
    (a, b) => Number(b.scope === 'webview') - Number(a.scope === 'webview'),
  );
  for (const { scope, nodes } of webviewFirst) {
    for (const node of nodes) {
      const candidate = { scope, role: node.role, name: node.name };
      const key = formatCandidate(candidate);
      if (node.name !== '' && POINTABLE.has(node.role) && !seen.has(key)) {
        seen.add(key);
        all.push(candidate);
      }
    }
  }
  const wanted = target.toLowerCase();
  const similar = all.filter(({ name }) => {
    const lower = name.toLowerCase();
    return lower.includes(wanted) || wanted.includes(lower);
  });
  const what = `nothing${role ? ` with the role ${role}` : ''} is named "${target}"`;
  if (all.length === 0) return `${what}; nothing in the window can be clicked`;
  if (similar.length > 0) {
    return `${what} exactly; similar:\n${listed(similar.map(formatCandidate), '')}`;
  }
  return `${what}; some of what there is:\n${listed(all.map(formatCandidate), '; see: npm run live -- snapshot')}`;
}

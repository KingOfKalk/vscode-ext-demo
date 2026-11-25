// The accessibility tree of a part of the window as Playwright prints it (`locator.ariaSnapshot()`),
// read back into nodes. Pure: text in, data out. This is the one place that decides what a thing is
// called, so `snapshot` shows the names that `click` accepts.

/** One element of the tree that has a role. */
export interface AriaNode {
  role: string;
  /** Empty if the element has none. */
  name: string;
  /** The states in brackets after the name: `selected`, `checked`, `level=2`. */
  states: string[];
  /** The text after the colon: what the element shows besides its name. */
  text: string;
  /** How deep it is, 0 for the top. */
  depth: number;
}

/** Roles of text and properties, not of things a person can point at. */
const NOT_ELEMENTS = new Set(['text', 'generic', 'none', 'presentation']);

/** Reads the key at the start of a line: either YAML single-quoted or plain, up to the colon. */
function readKey(line: string): { key: string; rest: string } | undefined {
  if (line.startsWith("'")) {
    let key = '';
    for (let i = 1; i < line.length; i++) {
      if (line[i] !== "'") {
        key += line[i];
      } else if (line[i + 1] === "'") {
        key += "'";
        i++;
      } else {
        return { key, rest: line.slice(i + 1) };
      }
    }
    return undefined;
  }
  const colon = /:(?:\s|$)/.exec(line);
  return colon
    ? { key: line.slice(0, colon.index), rest: line.slice(colon.index) }
    : { key: line, rest: '' };
}

/** A YAML scalar as Playwright writes it: plain, 'single' or "double" quoted. */
function unquote(text: string): string {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text) as string;
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replaceAll("''", "'");
  }
  return text;
}

/**
 * Parses the output of `ariaSnapshot()`. Lines that are no elements (text, properties like `/url`)
 * are dropped. The contents of an `iframe` are skipped: a frame is looked at on its own.
 */
export function parseAriaSnapshot(snapshot: string): AriaNode[] {
  const nodes: AriaNode[] = [];
  let skipBelow: number | undefined;
  for (const raw of snapshot.split('\n')) {
    const match = /^(\s*)- (.*)$/.exec(raw);
    if (!match) continue;
    const depth = (match[1] ?? '').length / 2;
    if (skipBelow !== undefined) {
      if (depth > skipBelow) continue;
      skipBelow = undefined;
    }
    const read = readKey(match[2] ?? '');
    if (!read) continue;
    const head = /^(\w[\w-]*)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*)\s*$/.exec(read.key);
    if (!head?.[1] || NOT_ELEMENTS.has(head[1])) continue;
    const role = head[1];
    if (role === 'iframe') skipBelow = depth;
    nodes.push({
      role,
      name: (head[2] ?? '').replace(/\\(.)/g, '$1'),
      states: [...(head[3] ?? '').matchAll(/\[([^\]]*)\]/g)].map((m) => m[1] ?? ''),
      text: unquote(read.rest.replace(/^:\s*/, '').trim())
        .replace(/[\uE000-\uF8FF]/g, '')
        .trim(),
      depth,
    });
  }
  return nodes;
}

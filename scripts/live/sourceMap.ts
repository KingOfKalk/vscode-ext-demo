// Between TypeScript and the bundle, with the source map decoder of Node. Pure: the map is an argument.
import { SourceMap, type SourceMapPayload, type SourceMapping } from 'node:module';
import { posix } from 'node:path';
import { ActionError } from './errors.ts';

/** A place in the bundle. Counts from 0, like the inspector. */
export interface GeneratedPosition {
  line: number;
  column: number;
}

/** A place in a TypeScript file. Counts from 1, like an editor. */
export interface SourcePosition {
  file: string;
  line: number;
  column: number;
}

/** A source of the map (`../src/a.ts`, from dist/) as the path in the repository. */
function repositoryPath(source: string): string {
  return posix.normalize(source).replace(/^(\.\.?\/)+/, '');
}

function open(map: object): SourceMap {
  return new SourceMap(map as SourceMapPayload);
}

/** The mapping at this place of the bundle, or the last one before it on the same line. */
function mappingAt(map: SourceMap, line: number, column: number): SourceMapping | undefined {
  const entry = map.findEntry(line, column);
  return 'generatedLine' in entry && entry.generatedLine === line ? entry : undefined;
}

/** All mappings, in the order of the bundle. Node has no list of them, so it is asked line by line. */
function allMappings(map: SourceMap): SourceMapping[] {
  const lines = map.payload.mappings.split(';').length;
  return Array.from({ length: lines }, (_, line) => {
    const found: SourceMapping[] = [];
    let entry = mappingAt(map, line, Infinity);
    while (entry) {
      found.push(entry);
      entry = mappingAt(map, line, entry.generatedColumn - 1);
    }
    return found.reverse();
  }).flat();
}

/**
 * Where the bundle has the code of a line of a TypeScript file: the first place, if there are more.
 * @param file path in the repository, like `src/counterStore.ts`
 * @param line counts from 1
 * @throws ActionError if the file is not in the bundle or the line has no code
 */
export function toGenerated(map: object, file: string, line: number): GeneratedPosition {
  const path = posix.normalize(file);
  const sourceMap = open(map);
  const sources = [...new Set(sourceMap.payload.sources.map(repositoryPath))].toSorted();
  if (!sources.includes(path)) {
    throw new ActionError(
      path.startsWith('src/webview/')
        ? `${path} runs in the Demo window, not in the extension host, so break cannot stop there`
        : `${path} is not in the bundle of the extension host, which has: ${sources.join(', ')}`,
    );
  }
  const mappings = allMappings(sourceMap).filter(
    // A place that maps to no source has no `originalSource`, whatever the type says.
    ({ originalSource }) => originalSource && repositoryPath(originalSource) === path,
  );
  const first = mappings.find(({ originalLine }) => originalLine === line - 1);
  if (first) return { line: first.generatedLine, column: first.generatedColumn };

  const lines = mappings.map(({ originalLine }) => originalLine + 1);
  const before = Math.max(...lines.filter((other) => other < line));
  const after = Math.min(...lines.filter((other) => other > line));
  const near = [before, after].filter(Number.isFinite).join(', ');
  throw new ActionError(
    `${path}:${line} has no code (a comment, an empty line or only types?); the lines next to it that have code: ${near}`,
  );
}

/**
 * The place in TypeScript of a place in the bundle; undefined for code that esbuild added.
 * @param line counts from 0, so does `column`
 */
export function toSource(map: object, line: number, column: number): SourcePosition | undefined {
  const entry = mappingAt(open(map), line, column);
  if (!entry?.originalSource) return undefined;
  return {
    file: repositoryPath(entry.originalSource),
    line: entry.originalLine + 1,
    column: entry.originalColumn + 1,
  };
}

export function formatPosition({ file, line, column }: SourcePosition): string {
  return `${file}:${line}:${column}`;
}

/** Replaces the places of the bundle in a text, like the stack of an error, by those in TypeScript. */
export function mapStackText(text: string, map: object, bundle: string): string {
  const escaped = bundle.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  const pattern = new RegExp(`(?:file://)?${escaped}:(\\d+):(\\d+)`, 'g');
  return text.replace(pattern, (place, line: string, column: string) => {
    const source = toSource(map, Number(line) - 1, Number(column) - 1);
    return source ? formatPosition(source) : place;
  });
}

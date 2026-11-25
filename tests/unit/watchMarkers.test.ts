// The background task of F5 starts the debugger when it sees the end marker, so the markers of
// `npm run watch` and the regular expressions in `.vscode/tasks.json` have to agree.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createTracker,
  describeMessages,
  FINISHED,
  STARTED,
  watchPlugin,
} from '../../scripts/watch-markers.mjs';

interface PatternLine {
  regexp: string;
  severity?: number;
  message?: number;
  file?: number;
  line?: number;
  column?: number;
}

interface Matcher {
  pattern: PatternLine[];
  background: { activeOnStart: boolean; beginsPattern: string; endsPattern: string };
  fileLocation: string[];
}

interface Task {
  label: string;
  isBackground?: boolean;
  dependsOn?: string[];
  problemMatcher: Matcher | never[];
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(new URL(`../../.vscode/${file}`, import.meta.url), 'utf8')) as T;
}

const tasks = readJson<{ tasks: Task[] }>('tasks.json').tasks;
const watchTask = tasks.find((task) => task.label === 'watch');
const matcher = watchTask?.problemMatcher as Matcher;

function collect() {
  const lines: string[] = [];
  return { lines, tracker: createTracker((line) => lines.push(line)) };
}

describe('createTracker', () => {
  it('prints one start and one end for the two bundles of a build', () => {
    const { lines, tracker } = collect();
    tracker.started('a');
    tracker.started('b');
    tracker.ended('b');
    expect(lines).toEqual([STARTED]);
    tracker.ended('a');
    expect(lines).toEqual([STARTED, FINISHED]);
  });

  it('prints a pair for a rebuild of one bundle', () => {
    const { lines, tracker } = collect();
    tracker.started('a');
    tracker.ended('a');
    tracker.started('b');
    tracker.ended('b');
    expect(lines).toEqual([STARTED, FINISHED, STARTED, FINISHED]);
  });

  it('does not end twice, or end what did not start', () => {
    const { lines, tracker } = collect();
    tracker.ended('a');
    tracker.started('a');
    tracker.started('a');
    tracker.ended('a');
    tracker.ended('a');
    expect(lines).toEqual([STARTED, FINISHED]);
  });
});

describe('watchPlugin', () => {
  it('prints the messages of a failed build before its end', async () => {
    const lines: string[] = [];
    const tracker = createTracker((line) => lines.push(line));
    const plugin = watchPlugin('a', tracker, (text) => lines.push(text));
    await build({
      stdin: { contents: 'const = ;', sourcefile: 'src/broken.ts', loader: 'ts' },
      write: false,
      logLevel: 'silent',
      plugins: [plugin],
    }).catch(() => undefined);
    expect(lines[0]).toBe(STARTED);
    expect(lines[1]).toContain('[ERROR] Expected identifier');
    expect(lines.at(-1)).toBe(FINISHED);
  });
});

describe('the background task in .vscode/tasks.json', () => {
  it('is a background task that the debug configuration waits for', () => {
    expect(watchTask?.isBackground).toBe(true);
    const launch = readJson<{ configurations: { preLaunchTask: string }[] }>('launch.json');
    const waited = new Set<string>();
    const visit = (label: string): void => {
      waited.add(label);
      tasks.find((task) => task.label === label)?.dependsOn?.forEach(visit);
    };
    for (const configuration of launch.configurations) visit(configuration.preLaunchTask);
    expect(waited).toContain('watch');
    for (const label of waited) expect(tasks.map((task) => task.label)).toContain(label);
  });

  it('starts at the start marker and ends at the end marker, and at nothing else', () => {
    const begins = new RegExp(matcher.background.beginsPattern);
    const ends = new RegExp(matcher.background.endsPattern);
    expect(STARTED).toMatch(begins);
    expect(FINISHED).toMatch(ends);
    expect(FINISHED).not.toMatch(begins);
    expect(STARTED).not.toMatch(ends);
    expect(matcher.background.activeOnStart).toBe(true);
  });

  it('reads the place of an error that esbuild prints', async () => {
    const failure = await build({
      stdin: { contents: 'const ok = 1;\nconst = ;', sourcefile: 'src/broken.ts', loader: 'ts' },
      write: false,
      logLevel: 'silent',
    }).catch((error: { errors: Parameters<typeof describeMessages>[0] }) => error);
    const lines = (await describeMessages('errors' in failure ? failure.errors : [], []))
      .join('\n')
      .split('\n');

    // The way VS Code does it: the patterns take consecutive lines.
    const patterns = matcher.pattern.map((pattern) => ({
      ...pattern,
      regexp: new RegExp(pattern.regexp),
    }));
    const found: RegExpExecArray[] = [];
    for (let start = 0; start + patterns.length <= lines.length && found.length === 0; start++) {
      const matches = patterns.map((pattern, index) =>
        pattern.regexp.exec(lines[start + index] ?? ''),
      );
      if (matches.every((match) => match !== null)) found.push(...matches);
    }
    expect(found).toHaveLength(3);
    const [first, , third] = found as [RegExpExecArray, RegExpExecArray, RegExpExecArray];
    expect(first[matcher.pattern[0]?.severity ?? 0]).toBe('ERROR');
    expect(first[matcher.pattern[0]?.message ?? 0]).toBe('Expected identifier but found "="');
    expect(third[matcher.pattern[2]?.file ?? 0]).toBe('src/broken.ts');
    expect(third[matcher.pattern[2]?.line ?? 0]).toBe('2');
    expect(third[matcher.pattern[2]?.column ?? 0]).toBe('6');
  });
});

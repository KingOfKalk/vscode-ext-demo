import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  escapeCell,
  fence,
  formatBytes,
  formatDuration,
  parseZipListing,
  renderStepsSummary,
  renderTestSummary,
  renderVsixSection,
  stripAnsi,
  truncate,
} from '../../scripts/ci-summary.mjs';

describe('stripAnsi', () => {
  it('removes colour codes', () => {
    expect(stripAnsi('\u001b[31merror\u001b[39m ok')).toBe('error ok');
  });
});

describe('truncate', () => {
  it('keeps short text as it is', () => {
    expect(truncate('a\nb\n', { maxLines: 5, maxChars: 100 })).toBe('a\nb');
  });

  it('cuts by lines and says how many were dropped', () => {
    const out = truncate('1\n2\n3\n4\n5', { maxLines: 2, maxChars: 100 });
    expect(out).toBe('1\n2\n... 3 more lines not shown');
  });

  it('cuts by characters', () => {
    const out = truncate('x'.repeat(50), { maxLines: 10, maxChars: 10 });
    expect(out.startsWith('x'.repeat(10))).toBe(true);
    expect(out).toContain('truncated');
    expect(out.length).toBeLessThan(80);
  });
});

describe('fence', () => {
  it('wraps text in a code fence', () => {
    expect(fence('hi')).toBe('```text\nhi\n```');
  });

  it('uses a longer fence than any backtick run in the text', () => {
    const out = fence('a ``` b\n````\nc');
    expect(out.startsWith('`````text\n')).toBe(true);
    expect(out.endsWith('\n`````')).toBe(true);
  });

  it('cannot be closed early by the content', () => {
    const out = fence('```\n# injected heading');
    const lines = out.split('\n');
    expect(lines[0]).toBe('````text');
    expect(lines.at(-1)).toBe('````');
  });
});

describe('escapeCell', () => {
  it('escapes table pipes, HTML and newlines', () => {
    expect(escapeCell('a|b <i>\nc')).toBe('a\\|b &lt;i&gt; c');
  });
});

describe('formatBytes', () => {
  it('formats bytes, KiB and MiB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MiB');
  });
});

describe('formatDuration', () => {
  it('formats milliseconds and seconds', () => {
    expect(formatDuration(42)).toBe('42 ms');
    expect(formatDuration(1234)).toBe('1.23 s');
  });
});

describe('renderStepsSummary', () => {
  it('renders a table and no output for passing steps', () => {
    const out = renderStepsSummary('Lint', [
      { name: 'Format', outcome: 'success', log: 'all fine' },
      { name: 'Lint', outcome: 'success', log: '' },
    ]);
    expect(out).toContain('## Lint');
    expect(out).toContain('| Format | success |');
    expect(out).toContain('| Lint | success |');
    expect(out).not.toContain('all fine');
    expect(out).not.toContain('```');
  });

  it('shows the output of failed steps in a fence', () => {
    const out = renderStepsSummary('Lint', [
      { name: 'Format', outcome: 'success', log: '' },
      { name: 'Lint', outcome: 'failure', log: '/src/a.ts\n  3:1  error  no-undef\n' },
    ]);
    expect(out).toContain('| Lint | failure |');
    expect(out).toContain('### Lint failed');
    expect(out).toContain('```text\n/src/a.ts\n  3:1  error  no-undef\n```');
  });

  it('marks skipped and cancelled steps without output', () => {
    const out = renderStepsSummary('Build', [
      { name: 'Package', outcome: 'failure', log: 'boom' },
      { name: 'Upload', outcome: 'skipped', log: '' },
    ]);
    expect(out).toContain('| Upload | skipped |');
    expect(out).not.toContain('### Upload');
  });

  it('keeps hostile output inside the fence', () => {
    const out = renderStepsSummary('Lint', [
      { name: 'Lint', outcome: 'failure', log: '```\n# heading\n<script>x</script>' },
    ]);
    expect(out).toContain('````text\n```\n# heading');
  });

  it('strips colour codes from the output', () => {
    const out = renderStepsSummary('Lint', [
      { name: 'Lint', outcome: 'failure', log: '\u001b[31mred\u001b[39m' },
    ]);
    expect(out).toContain('\nred\n');
    expect(out).not.toContain('\u001b');
  });

  it('tells when a failed step printed nothing', () => {
    const out = renderStepsSummary('Lint', [{ name: 'Lint', outcome: 'failure', log: '' }]);
    expect(out).toContain('no output');
  });

  it('escapes the step name in the table', () => {
    const out = renderStepsSummary('X', [{ name: 'a|b', outcome: 'success', log: '' }]);
    expect(out).toContain('| a\\|b | success |');
  });
});

const passingReport = {
  numTotalTests: 4,
  numPassedTests: 3,
  numFailedTests: 0,
  numPendingTests: 1,
  numTodoTests: 0,
  startTime: 1000,
  testResults: [
    {
      name: '/repo/tests/a.test.ts',
      status: 'passed',
      startTime: 1010,
      endTime: 1100,
      assertionResults: [],
    },
    {
      name: '/repo/tests/b.test.ts',
      status: 'passed',
      startTime: 1020,
      endTime: 1250,
      assertionResults: [],
    },
  ],
};

describe('renderTestSummary', () => {
  it('shows counts and duration for a passing run', () => {
    const out = renderTestSummary(passingReport, '/repo', 'success');
    expect(out).toContain('## Unit tests');
    expect(out).toContain('| Passed | 3 |');
    expect(out).toContain('| Failed | 0 |');
    expect(out).toContain('| Skipped | 1 |');
    expect(out).toContain('| Total | 4 |');
    expect(out).toContain('250 ms');
    expect(out).not.toContain('Failed tests');
  });

  it('counts todo tests as skipped', () => {
    const out = renderTestSummary({ ...passingReport, numTodoTests: 2 }, '/repo', 'success');
    expect(out).toContain('| Skipped | 3 |');
  });

  it('lists failed tests with their messages', () => {
    const report = {
      ...passingReport,
      numFailedTests: 1,
      numPassedTests: 2,
      testResults: [
        {
          name: '/repo/tests/a.test.ts',
          status: 'failed',
          startTime: 1010,
          endTime: 1100,
          assertionResults: [
            { fullName: 'a works', status: 'passed', failureMessages: [] },
            {
              fullName: 'a | breaks',
              status: 'failed',
              failureMessages: ['AssertionError: expected 1 to be 2\n    at tests/a.test.ts:7:3'],
            },
          ],
        },
      ],
    };
    const out = renderTestSummary(report, '/repo', 'failure');
    expect(out).toContain('| Failed | 1 |');
    expect(out).toContain('### Failed tests');
    expect(out).toContain('tests/a.test.ts');
    expect(out).toContain('a \\| breaks');
    expect(out).toContain('```text\nAssertionError: expected 1 to be 2');
    expect(out).not.toContain('a works');
  });

  it('reports a file that failed to load', () => {
    const report = {
      ...passingReport,
      testResults: [
        {
          name: '/repo/tests/c.test.ts',
          status: 'failed',
          startTime: 1010,
          endTime: 1100,
          message: 'Error: Cannot find module x',
          assertionResults: [],
        },
      ],
    };
    const out = renderTestSummary(report, '/repo', 'failure');
    expect(out).toContain('tests/c.test.ts');
    expect(out).toContain('Cannot find module x');
  });

  it('keeps hostile test output inside the fence', () => {
    const report = {
      ...passingReport,
      numFailedTests: 1,
      testResults: [
        {
          name: '/repo/tests/a.test.ts',
          status: 'failed',
          startTime: 1010,
          endTime: 1100,
          assertionResults: [
            { fullName: 't', status: 'failed', failureMessages: ['```\n# injected'] },
          ],
        },
      ],
    };
    expect(renderTestSummary(report, '/repo', 'failure')).toContain('````text\n```\n# injected');
  });

  it('drops library stack frames and shortens paths', () => {
    const report = {
      ...passingReport,
      numFailedTests: 1,
      testResults: [
        {
          name: '/repo/tests/a.test.ts',
          status: 'failed',
          startTime: 1010,
          endTime: 1100,
          assertionResults: [
            {
              fullName: 't',
              status: 'failed',
              failureMessages: [
                [
                  'AssertionError: nope',
                  '    at /repo/tests/a.test.ts:4:17',
                  '    at file:///repo/node_modules/vitest/dist/run.js:1:1',
                  '    at new Promise (<anonymous>)',
                  '    at node:internal/process/task_queues:1:1',
                ].join('\n'),
              ],
            },
          ],
        },
      ],
    };
    const out = renderTestSummary(report, '/repo', 'failure');
    expect(out).toContain('AssertionError: nope\n    at tests/a.test.ts:4:17\n```');
    expect(out).not.toContain('node_modules');
    expect(out).not.toContain('/repo/');
  });

  it('truncates very long failure messages', () => {
    const report = {
      ...passingReport,
      numFailedTests: 1,
      testResults: [
        {
          name: '/repo/tests/a.test.ts',
          status: 'failed',
          startTime: 1010,
          endTime: 1100,
          assertionResults: [
            { fullName: 't', status: 'failed', failureMessages: ['x\n'.repeat(500)] },
          ],
        },
      ],
    };
    const out = renderTestSummary(report, '/repo', 'failure');
    expect(out).toContain('more lines not shown');
    expect(out.length).toBeLessThan(5000);
  });

  it('shows the result of the step', () => {
    const passed = renderTestSummary(passingReport, '/repo', 'success');
    expect(passed).toContain('Result: success\n');
    expect(passed).not.toContain('failed outside a test');
    expect(renderTestSummary(passingReport, '/repo', 'a|b')).toContain('Result: a\\|b\n');
  });

  it('says so when the step failed without a failed test', () => {
    const out = renderTestSummary(passingReport, '/repo', 'failure');
    expect(out).toContain('| Failed | 0 |');
    expect(out).toContain('Result: failure (failed outside a test, see the log)\n');
    expect(out).not.toContain('### Failed tests');
  });

  it('lists the error of a file next to its failed tests', () => {
    const report = {
      ...passingReport,
      numFailedTests: 1,
      testResults: [
        {
          name: '/repo/tests/a.test.ts',
          status: 'failed',
          startTime: 1010,
          endTime: 1100,
          message: 'afterAll broke',
          assertionResults: [
            { fullName: 't', status: 'failed', failureMessages: ['AssertionError: nope'] },
          ],
        },
      ],
    };
    const out = renderTestSummary(report, '/repo', 'failure');
    expect(out).toContain('#### tests/a.test.ts › t\n\n```text\nAssertionError: nope\n```');
    expect(out).toContain('#### tests/a.test.ts\n\n```text\nafterAll broke\n```');
    expect(out).toContain('Result: failure\n');
    expect(out).not.toContain('failed outside a test');
  });

  it('does not list a failed file twice', () => {
    const file = {
      name: '/repo/tests/a.test.ts',
      status: 'failed',
      startTime: 1010,
      endTime: 1100,
      assertionResults: [{ fullName: 't', status: 'failed', failureMessages: ['nope'] }],
    };
    for (const message of [undefined, '']) {
      const report = { ...passingReport, testResults: [{ ...file, message }] };
      const out = renderTestSummary(report, '/repo', 'failure');
      expect(out.match(/^#### /gm)).toHaveLength(1);
    }
  });
});

const listing = [
  'Archive:  t.vsix',
  'Zip file size: 444 bytes, number of entries: 4',
  '-rw-r--r--  2.0 fat      100 b-       60 defN 26-Nov-24 20:48 extension/package.json',
  'drwxr-xr-x  2.0 fat        0 b-        0 stor 26-Nov-24 20:48 extension/media/',
  '-rw-r--r--  2.0 fat     2048 bl      900 defN 26-Nov-24 20:48 extension/dist/extension.js',
  '-rw-r--r--  2.0 fat       30 b-       30 stor 26-Nov-24 20:48 [Content_Types].xml',
  '4 files, 2178 bytes uncompressed, 990 bytes compressed:  54.5%',
].join('\n');

describe('parseZipListing', () => {
  it('returns files with sizes, skips headers, footers and directories', () => {
    expect(parseZipListing(listing)).toEqual([
      { name: 'extension/package.json', size: 100 },
      { name: 'extension/dist/extension.js', size: 2048 },
      { name: '[Content_Types].xml', size: 30 },
    ]);
  });
});

describe('renderVsixSection', () => {
  it('shows name, size, file list and artifact link', () => {
    const out = renderVsixSection({
      fileName: 'demo-0.1.0.vsix',
      size: 2048,
      entries: parseZipListing(listing),
      artifactUrl: 'https://github.com/o/r/actions/runs/1/artifacts/2',
    });
    expect(out).toContain('`demo-0.1.0.vsix`');
    expect(out).toContain('2.0 KiB');
    expect(out).toContain('| `extension/dist/extension.js` | 2.0 KiB |');
    expect(out).toContain(
      '[Download the artifact](https://github.com/o/r/actions/runs/1/artifacts/2)',
    );
  });

  it('omits the link when there is no artifact URL', () => {
    const out = renderVsixSection({ fileName: 'a.vsix', size: 1, entries: [], artifactUrl: '' });
    expect(out).not.toContain('Download');
  });

  it('refuses a non-https artifact URL', () => {
    const out = renderVsixSection({
      fileName: 'a.vsix',
      size: 1,
      entries: [],
      artifactUrl: 'javascript:alert(1)',
    });
    expect(out).not.toContain('javascript');
  });
});

describe('command line', () => {
  const script = fileURLToPath(new URL('../../scripts/ci-summary.mjs', import.meta.url));

  function run(...args: string[]) {
    return spawnSync(process.execPath, [script, 'test', ...args], { encoding: 'utf8' });
  }

  it('prints the result also without a test report', () => {
    const result = run('--report', '/nonexistent/vitest.json', '--outcome', 'failure');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Result: failure\n');
    expect(result.stdout).toContain('No test report');
  });

  it.each([[[]], [['--outcome', '']]])('refuses a missing outcome: %j', (args) => {
    const result = run('--report', '/nonexistent/vitest.json', ...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing --outcome');
  });
});

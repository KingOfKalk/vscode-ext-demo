import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Manifest {
  name: string;
  publisher: string;
  private: boolean;
  license: string;
  engines: { vscode: string; node: string };
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
  files: string[];
}

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as Manifest;

describe('package.json manifest', () => {
  it('has the extension ID kingofkalk.vscode-ext-demo', () => {
    expect(`${pkg.publisher}.${pkg.name}`).toBe('kingofkalk.vscode-ext-demo');
  });

  it('is private and MIT licensed', () => {
    expect(pkg.private).toBe(true);
    expect(pkg.license).toBe('MIT');
  });

  it('pins engines.vscode to @types/vscode', () => {
    expect(pkg.engines.vscode).toBe(`^${pkg.devDependencies['@types/vscode']}`);
  });

  it('has no publish script', () => {
    expect(Object.keys(pkg.scripts).filter((s) => s.includes('publish'))).toEqual([]);
  });

  it('packages only the license, the bundles and media', () => {
    expect(pkg.files).toEqual(['LICENSE', 'dist/extension.js', 'dist/webview.js', 'media/']);
  });
});

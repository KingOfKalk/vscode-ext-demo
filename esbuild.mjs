import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions[]} */
const targets = [
  {
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    // VS Code 1.146.0, the minimum in `engines.vscode`, runs extensions on Node 24.22.1.
    target: 'node24',
    external: ['vscode'],
  },
  {
    entryPoints: ['src/webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2023',
  },
];

const common = { bundle: true, minify: false, sourcemap: 'linked', logLevel: 'info' };

if (watch) {
  const contexts = await Promise.all(targets.map((t) => context({ ...common, ...t })));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(targets.map((t) => build({ ...common, ...t })));
}

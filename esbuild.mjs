import { build, context } from 'esbuild';
import { createTracker, watchPlugin } from './scripts/watch-markers.mjs';

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

const common = { bundle: true, minify: false, sourcemap: 'linked' };

if (watch) {
  // The two bundles rebuild on their own; scripts/watch-markers.mjs makes one start and one end of it.
  const tracker = createTracker();
  const contexts = await Promise.all(
    targets.map((t) =>
      context({
        ...common,
        ...t,
        logLevel: 'silent',
        plugins: [watchPlugin(String(t.outfile), tracker)],
      }),
    ),
  );
  // The first build covers both, also if one of them is done before the other starts.
  for (const t of targets) tracker.started(String(t.outfile));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(targets.map((t) => build({ ...common, ...t, logLevel: 'info' })));
}

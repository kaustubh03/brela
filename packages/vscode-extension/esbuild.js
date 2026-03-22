const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  sourcemap: true,
  target: 'node20',
}).then(() => {
  console.log('✓ Bundle complete');
}).catch((e) => {
  console.error('✗ Bundle failed:', e);
  process.exit(1);
});

import { build } from 'esbuild';
import { copyFileSync as cp, mkdirSync } from 'node:fs';
await build({ entryPoints: ['entry.js'], bundle: true, minify: true, format: 'esm', target: 'es2022', outfile: '../lib.js', legalComments: 'eof' });
mkdirSync('../mathjax/ui', { recursive: true });
cp('node_modules/@automerge/automerge/dist/automerge.wasm', '../automerge.wasm');
cp('node_modules/mathjax/es5/tex-svg-full.js', '../mathjax/tex-svg-full.js');
cp('node_modules/mathjax/es5/ui/safe.js', '../mathjax/ui/safe.js');

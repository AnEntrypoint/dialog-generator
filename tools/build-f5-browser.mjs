// Build the f5-core browser bundle for the gh-pages demo.
//
//   node tools/build-f5-browser.mjs
//
// onnxruntime-web and onnxruntime-common are resolved to their jsDelivr ESM at
// runtime (kept external as URL imports) so the bundle stays small and the demo
// worker needs no import map. node: builtins (used only on the dead Node path of
// the vendored transformers.js hub loader) are stubbed empty.
import esbuild from 'esbuild'

const ORT_WEB = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.webgpu.bundle.min.mjs'

const ortFromCdn = {
  name: 'ort-from-cdn',
  setup(b) {
    b.onResolve({ filter: /^onnxruntime-(web|common)$/ }, () => ({ path: ORT_WEB, external: true }))
    b.onResolve({ filter: /^node:/ }, () => ({ path: 'stub', namespace: 'stubns' }))
    b.onLoad({ filter: /.*/, namespace: 'stubns' }, () => ({
      contents: 'export default {}; export const promises = {};', loader: 'js',
    }))
  },
}

const r = await esbuild.build({
  entryPoints: ['f5-core/browser-entry.js'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: 'gh-pages-src/demo/f5-core.bundle.js',
  plugins: [ortFromCdn],
  logLevel: 'info',
  legalComments: 'none',
})
console.log('f5-core browser bundle built, errors:', r.errors.length)

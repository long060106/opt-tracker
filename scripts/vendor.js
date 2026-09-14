/*
 * Copies the document reader's browser libraries from node_modules into vendor/.
 *
 *   npm install && npm run vendor
 *
 * After changing any of these versions, bump VENDOR_CACHE in sw.js so installed copies of
 * the app fetch the new files instead of keeping the cached ones.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const modules = path.join(root, 'node_modules');

const COPIES = [
  ['tesseract.js/dist/tesseract.min.js', 'tesseract/tesseract.min.js'],
  ['tesseract.js/dist/tesseract.min.js.LICENSE.txt', 'tesseract/tesseract.min.js.LICENSE.txt'],
  ['tesseract.js/dist/worker.min.js', 'tesseract/worker.min.js'],
  ['tesseract.js/dist/worker.min.js.LICENSE.txt', 'tesseract/worker.min.js.LICENSE.txt'],
  ['tesseract.js/LICENSE.md', 'tesseract/LICENSE.md'],
  // LSTM-only engine builds; the worker picks one to match the device's WebAssembly features.
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract/core/tesseract-core-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract/core/tesseract-core-simd-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', 'tesseract/core/tesseract-core-relaxedsimd-lstm.wasm.js'],
  ['tesseract.js-core/LICENSE', 'tesseract/core/LICENSE'],
  ['@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'tesseract/lang/eng.traineddata.gz'],
  // The legacy build carries polyfills, so older phone browsers can open PDFs too.
  ['pdfjs-dist/legacy/build/pdf.min.mjs', 'pdfjs/pdf.min.mjs'],
  ['pdfjs-dist/legacy/build/pdf.worker.min.mjs', 'pdfjs/pdf.worker.min.mjs'],
  ['pdfjs-dist/LICENSE', 'pdfjs/LICENSE'],
  ['pdfjs-dist/wasm/jbig2.wasm', 'pdfjs/wasm/jbig2.wasm'],
  ['pdfjs-dist/wasm/openjpeg.wasm', 'pdfjs/wasm/openjpeg.wasm'],
  ['pdfjs-dist/wasm/qcms_bg.wasm', 'pdfjs/wasm/qcms_bg.wasm'],
  ['pdfjs-dist/wasm/LICENSE_JBIG2', 'pdfjs/wasm/LICENSE_JBIG2'],
  ['pdfjs-dist/wasm/LICENSE_OPENJPEG', 'pdfjs/wasm/LICENSE_OPENJPEG'],
  ['pdfjs-dist/wasm/LICENSE_QCMS', 'pdfjs/wasm/LICENSE_QCMS'],
  ['pdfjs-dist/wasm/LICENSE_PDFJS_JBIG2', 'pdfjs/wasm/LICENSE_PDFJS_JBIG2'],
  ['pdfjs-dist/wasm/LICENSE_PDFJS_OPENJPEG', 'pdfjs/wasm/LICENSE_PDFJS_OPENJPEG'],
  ['pdfjs-dist/wasm/LICENSE_PDFJS_QCMS', 'pdfjs/wasm/LICENSE_PDFJS_QCMS']
];

for (const [from, to] of COPIES) {
  const source = path.join(modules, from);
  const target = path.join(root, 'vendor', to);
  if (!fs.existsSync(source)) throw new Error('Missing ' + source + ' (run npm install first)');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  console.log('vendor/' + to);
}

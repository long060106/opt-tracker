/*
 * End-to-end accuracy check of the document reader.
 *
 *   npm run fixtures            # generate the synthetic documents (needs Python + Pillow)
 *   npm run test:scan           # grade every fixture
 *   node tests/scan-e2e.js some.png other.jpg    # just print what it reads from any images
 *
 * Runs the exact scan-core.js pipeline the browser uses, with Tesseract.js in Node.
 * Exits non-zero if any date comes back wrong without being flagged for review.
 * PDFs are graded in the browser harness (tests/scan-harness.html), which can render them.
 */
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');
const { createWorker } = require('tesseract.js');
const scan = require('../scan-core.js');

const TODAY = '2026-09-14';

function decode(file) {
  const buf = fs.readFileSync(file);
  if (/\.png$/i.test(file)) {
    const png = PNG.sync.read(buf);
    return { data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length), width: png.width, height: png.height };
  }
  const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048 });
  return { data: new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length), width: img.width, height: img.height };
}

function encodePng(img) {
  const png = new PNG({ width: img.width, height: img.height, colorType: 0, inputColorType: 6 });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
  return PNG.sync.write(png, { colorType: 0, inputColorType: 6 });
}

async function makeEngine() {
  const langPath = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
  const worker = await createWorker('eng', 1, { langPath, cacheMethod: 'none' });
  return {
    worker,
    async recognize(img, opts) {
      const params = { tessedit_pageseg_mode: String(opts.psm || 3), user_defined_dpi: '300' };
      if (opts.thresholding === 'sauvola') params.thresholding_method = '2';
      if (opts.rotateAuto) params.rotateAuto = true;
      if (opts.rectangle) params.rectangle = opts.rectangle;
      const { data } = await worker.recognize(encodePng(img), params, { blocks: true });
      return { words: scan.wordsFromBlocks(data.blocks), rotateRadians: data.rotateRadians };
    }
  };
}

function summarize(result) {
  const f = result.fields[0];
  return {
    doc: result.doc,
    ds: result.ds,
    caseType: result.caseType,
    field: f && { field: f.field, value: f.value, options: f.options, status: f.status, raw: f.raw, second: f.secondRead, conf: f.confidence, issues: f.issues },
    notices: result.notices.map((n) => n.level + ': ' + n.text.slice(0, 70))
  };
}

const grade = require('./scan-grade.js');

async function main() {
  const args = process.argv.slice(2);
  const engine = await makeEngine();
  const options = { today: TODAY };
  try {
    if (args.length) {
      for (const file of args) {
        const t0 = Date.now();
        const result = await scan.readImage(decode(file), engine, options);
        console.log(path.basename(file), `${Date.now() - t0}ms`, JSON.stringify(summarize(result), null, 1));
      }
      return;
    }

    const dir = path.join(__dirname, 'fixtures', 'out');
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) throw new Error('No fixtures. Run `npm run fixtures` first.');
    const only = process.env.ONLY || '';
    const entries = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      .filter((e) => !/\.pdf$/.test(e.file) && e.file.includes(only));
    const tally = {};
    const failures = [];
    for (const entry of entries) {
      const t0 = Date.now();
      const result = await scan.readImage(decode(path.join(dir, entry.file)), engine, options);
      const verdict = grade(entry.expect, result);
      tally[verdict] = (tally[verdict] || 0) + 1;
      const f = result.fields[0];
      console.log(`${verdict.padEnd(16)} ${entry.file.padEnd(40)} ${String(Date.now() - t0).padStart(6)}ms  ` +
        (f ? `${f.value || '(' + f.options.join('|') + ')'} ${f.status} raw="${f.raw}" 2nd="${f.secondRead}" [${f.issues.join(',')}]` :
          `doc=${result.doc} ds=${result.ds} case=${result.caseType}`));
      if (/WRONG|wrong/.test(verdict)) failures.push({ file: entry.file, summary: summarize(result) });
    }
    console.log('\n' + JSON.stringify(tally));
    if (failures.length) {
      console.log(JSON.stringify(failures, null, 1));
      process.exitCode = 1;
    }
  } finally {
    await engine.worker.terminate();
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });

/*
 * Unit tests for the document reader's pure logic (scan-core.js). No OCR engine needed:
 * the "OCR output" here is hand-built word boxes laid out like the real documents.
 *   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert');
const scan = require('../scan-core.js');

const TODAY = { today: '2026-09-14' };

// Lays a line of text out as word boxes: each character 0.55h wide, spaces 0.3h.
function phrase(x, y, h, text, conf = 95) {
  const out = [];
  let cx = x;
  for (const t of text.split(' ')) {
    if (!t) continue;
    const w = t.length * h * 0.55;
    out.push({ text: t, conf, x0: cx, x1: cx + w, y0: y, y1: y + h });
    cx += w + h * 0.3;
  }
  return out;
}

function i94Page(until, extra = []) {
  return [
    ...phrase(300, 100, 30, 'U.S. Customs and Border Protection'),
    ...phrase(300, 200, 30, 'Most Recent I-94'),
    ...phrase(300, 300, 30, 'Admission (I-94) Record Number : 123456789A1'),
    ...phrase(300, 360, 30, 'Most Recent Date of Entry: 2026 August 20'),
    ...phrase(300, 420, 30, 'Class of Admission : F1'),
    ...phrase(300, 480, 30, 'Admit Until Date : ' + until),
    ...phrase(300, 540, 30, 'Details provided on the I-94 Information form:'),
    ...phrase(300, 660, 30, 'Birth Date :'), ...phrase(700, 660, 30, '1999 November 02'),
    ...extra
  ];
}

// I-797C table: small labels on top of each box, values underneath.
function i797Page({ received = 'March 12, 2026', caseType = 'I-765, Application for Employment Authorization', conf = 95 } = {}) {
  return [
    ...phrase(40, 20, 28, 'Department of Homeland Security'),
    ...phrase(1000, 20, 36, 'Form I-797C, Notice of Action'),
    ...phrase(30, 200, 14, 'NOTICE TYPE'), ...phrase(1080, 200, 14, 'NOTICE DATE'),
    ...phrase(34, 226, 24, 'Receipt'), ...phrase(1084, 226, 24, 'March 20, 2026'),
    ...phrase(30, 256, 14, 'CASE TYPE'), ...phrase(1080, 256, 14, 'USCIS ALIEN NUMBER'),
    ...phrase(34, 282, 24, caseType), ...phrase(1084, 282, 24, 'A 212-345-678'),
    ...phrase(30, 312, 14, 'RECEIPT NUMBER'), ...phrase(512, 312, 14, 'RECEIVED DATE'), ...phrase(1080, 312, 14, 'PAGE'),
    ...phrase(34, 338, 24, 'IOE0931234567'), ...(received ? phrase(516, 338, 24, received, conf) : []), ...phrase(1084, 338, 24, '1 of 1'),
    ...phrase(30, 368, 14, 'PRIORITY DATE'), ...phrase(512, 368, 14, 'ELIGIBILITY CLASSIFICATION'), ...phrase(1080, 368, 14, 'DATE OF BIRTH'),
    ...phrase(516, 394, 24, '(c)(3)(B)'), ...phrase(1084, 394, 24, 'May 3, 1999')
  ];
}

test('parseDate reads every date format the two documents use', () => {
  assert.strictEqual(scan.parseDate('09/15/2028').iso, '2028-09-15');
  assert.strictEqual(scan.parseDate('2028 September 15').iso, '2028-09-15');
  assert.strictEqual(scan.parseDate('March 12, 2026').iso, '2026-03-12');
  assert.strictEqual(scan.parseDate('15 Sept 2028').iso, '2028-09-15');
  assert.strictEqual(scan.parseDate('09 / 15 / 2028').iso, '2028-09-15');
});

test('parseDate rejects things that are not real dates', () => {
  assert.strictEqual(scan.parseDate('1 of 1'), null);
  assert.strictEqual(scan.parseDate('D/S'), null);
  assert.strictEqual(scan.parseDate('02/30/2026'), null);
  assert.strictEqual(scan.parseDate('IOE0931234567'), null);
});

test('parseDate repairs OCR digit confusions but says so', () => {
  const r = scan.parseDate('O9/l5/2O28');
  assert.strictEqual(r.iso, '2028-09-15');
  assert.strictEqual(r.fixed, true);
});

test('an unclear month is never guessed', () => {
  const clear = scan.parseDate('Mav 21, 2024');
  assert.strictEqual(clear.iso, '2024-05-21');
  assert.strictEqual(clear.fuzzy, true);

  const unclear = scan.parseDate('Man 17, 2024');
  assert.strictEqual(unclear.iso, null);
  assert.deepStrictEqual(unclear.options, ['2024-01-17', '2024-03-17', '2024-05-17']);
});

test('I-94: reads the Admit Until Date in both CBP formats', () => {
  const numeric = scan.extract(i94Page('09/15/2028'), TODAY);
  assert.strictEqual(numeric.doc, 'i94');
  assert.strictEqual(numeric.fields[0].field, 'i94Expiration');
  assert.strictEqual(numeric.fields[0].value, '2028-09-15');

  const words = scan.extract(i94Page('2029 January 31'), TODAY);
  assert.strictEqual(words.fields[0].value, '2029-01-31');
});

test('I-94: D/S yields no date', () => {
  const r = scan.extract(i94Page('D/S'), TODAY);
  assert.strictEqual(r.doc, 'i94');
  assert.strictEqual(r.ds, true);
  assert.strictEqual(r.fields.length, 0);
});

test('I-94: an unreadable admit-until value never borrows the birth or entry date', () => {
  const r = scan.extract(i94Page(''), TODAY);
  assert.strictEqual(r.fields[0].value, null);
  assert.deepStrictEqual(r.fields[0].options, []);
  assert.ok(r.fields[0].issues.includes('unreadable'));
});

test('I-94: a date before the entry date is flagged', () => {
  const r = scan.extract(i94Page('08/01/2026'), TODAY);
  assert.ok(r.fields[0].issues.includes('before-entry'));
});

test('I-797C: reads the Received Date, not the notice date or date of birth', () => {
  const r = scan.extract(i797Page(), TODAY);
  assert.strictEqual(r.doc, 'i797');
  assert.strictEqual(r.caseType, 'I-765');
  assert.strictEqual(r.fields[0].field, 'filedDate');
  assert.strictEqual(r.fields[0].value, '2026-03-12');
});

test('I-797C: a blank Received Date box stays blank', () => {
  const r = scan.extract(i797Page({ received: '' }), TODAY);
  assert.strictEqual(r.fields[0].value, null);
  assert.deepStrictEqual(r.fields[0].options, []);
});

test('I-797C: receipts for other forms are refused', () => {
  const r = scan.extract(i797Page({ caseType: 'I-539, Application To Extend/Change Nonimmigrant Status' }), TODAY);
  assert.strictEqual(r.caseType, 'I-539');
  assert.strictEqual(r.fields.length, 0);
  assert.ok(r.notices.some((n) => n.level === 'bad'));
});

test('I-797C: numeric dates and OCR noise', () => {
  assert.strictEqual(scan.extract(i797Page({ received: '01/09/2026' }), TODAY).fields[0].value, '2026-01-09');
  const noisy = scan.extract(i797Page({ received: 'Mav 12, 2O26', conf: 60 }), TODAY).fields[0];
  assert.strictEqual(noisy.value, '2026-05-12');
  for (const issue of ['fuzzy-month', 'fixed-characters', 'low-confidence']) assert.ok(noisy.issues.includes(issue), issue);
});

test('other paperwork with look-alike labels is not mistaken for an I-797C', () => {
  const words = [
    ...phrase(100, 100, 40, 'ACME STORAGE CO.'),
    ...phrase(100, 200, 30, 'Invoice Number: 2026-0412'),
    ...phrase(100, 260, 30, 'Notice Date: March 20, 2026'),
    ...phrase(100, 320, 30, 'Received Date: 03/04/2026')
  ];
  const r = scan.extract(words, TODAY);
  assert.strictEqual(r.doc, null);
  assert.strictEqual(r.fields.length, 0);
});

test('reconcile: matching reads are verified, disagreeing reads force a choice', () => {
  const agree = scan.extract(i797Page(), TODAY).fields[0];
  scan.reconcile(agree, phrase(0, 0, 24, 'March 12, 2026'));
  assert.strictEqual(agree.verified, true);
  assert.strictEqual(agree.status, 'ok');

  const disagree = scan.extract(i797Page(), TODAY).fields[0];
  scan.reconcile(disagree, phrase(0, 0, 24, 'March 13, 2026'));
  assert.strictEqual(disagree.value, null);
  assert.deepStrictEqual(disagree.options, ['2026-03-12', '2026-03-13']);
  assert.strictEqual(disagree.status, 'check');

  const failed = scan.extract(i797Page(), TODAY).fields[0];
  scan.reconcile(failed, []);
  assert.strictEqual(failed.value, '2026-03-12');
  assert.strictEqual(failed.status, 'check');
});

test('a receipt that cannot be confirmed as an I-765 never gets its date prefilled', () => {
  const field = scan.extract(i797Page({ caseType: '' }), TODAY).fields[0];
  assert.ok(field.issues.includes('case-type-unknown'));
  scan.reconcile(field, phrase(0, 0, 24, 'March 12, 2026'));
  assert.strictEqual(field.value, null);
  assert.deepStrictEqual(field.options, ['2026-03-12']);
  assert.strictEqual(field.status, 'check');
});

test('reconcile: a clear second read settles an ambiguous month but still asks for a check', () => {
  const field = scan.extract(i797Page({ received: 'Man 12, 2026' }), TODAY).fields[0];
  assert.strictEqual(field.value, null);
  scan.reconcile(field, phrase(0, 0, 24, 'March 12, 2026'));
  assert.strictEqual(field.value, '2026-03-12');
  assert.strictEqual(field.status, 'check');
});

test('classifyCase', () => {
  assert.strictEqual(scan.classifyCase('I-765, Application for Employment Authorization'), 'I-765');
  assert.strictEqual(scan.classifyCase('I765 - APPLICATION FOR EMPLOYMENT AUTHORIZATION'), 'I-765');
  assert.strictEqual(scan.classifyCase('1-140, Immigrant Petition for Alien Worker'), 'I-140');
  assert.strictEqual(scan.classifyCase('[-539, Application To Extend/Change Nonimmigrant Status'), 'I-539');
  assert.strictEqual(scan.classifyCase('A 212-345-678'), null);
});

test('PDF text items map into rendered-page pixels and extract normally', () => {
  const viewport = [2, 0, 0, -2, 0, 1584]; // scale 2, y flipped, US Letter
  const items = [
    { str: 'Most Recent I-94', transform: [12, 0, 0, 12, 100, 740], width: 90 },
    { str: 'Class of Admission : F1', transform: [10, 0, 0, 10, 100, 720], width: 110 },
    { str: 'Admit Until Date : 09/15/2028', transform: [10, 0, 0, 10, 100, 700], width: 150 }
  ];
  const words = scan.wordsFromPdfItems(items, viewport);
  const admit = words.find((w) => w.text === 'Admit');
  assert.strictEqual(admit.x0, 200);
  assert.strictEqual(Math.round(admit.y0), 167);
  assert.strictEqual(scan.extract(words, TODAY).fields[0].value, '2028-09-15');
});

function solid(width, height) {
  const img = { data: new Uint8ClampedArray(width * height * 4), width, height };
  for (let i = 0; i < width * height; i++) {
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = i;
    img.data[i * 4 + 3] = 255;
  }
  return img;
}

test('rotateQuarter turns pixels exactly and round-trips', () => {
  const img = solid(3, 2); // values 0..5, row-major
  const cw = scan.rotateQuarter(img, 1);
  assert.strictEqual(cw.width, 2);
  assert.strictEqual(cw.height, 3);
  assert.strictEqual(cw.data[0], 3); // bottom-left pixel moves to the top-left
  const back = scan.rotateQuarter(cw, 3);
  assert.deepStrictEqual(Array.from(back.data), Array.from(img.data));
});

test('despeckle is an exact 3x3 median', () => {
  const w = 7, h = 5;
  const img = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  let seed = 7;
  for (let i = 0; i < w * h; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = seed % 256;
    img.data[i * 4 + 3] = 255;
  }
  const out = scan.despeckle(img);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const vals = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy)), xx = Math.min(w - 1, Math.max(0, x + dx));
          vals.push(img.data[(yy * w + xx) * 4]);
        }
      }
      vals.sort((a, b) => a - b);
      assert.strictEqual(out.data[(y * w + x) * 4], vals[4], `pixel ${x},${y}`);
    }
  }
});

function turnSideways(words) {
  return words.map((w) => ({ ...w, x1: w.x0 + (w.y1 - w.y0), y1: w.y0 + (w.x1 - w.x0) }));
}

test('orientationOf spots text read off a page lying on its side', () => {
  const page = i94Page('09/15/2028');
  assert.strictEqual(scan.orientationOf(page), 'upright');
  assert.strictEqual(scan.orientationOf(turnSideways(page)), 'sideways');
});

test('readImage turns a sideways page upright, then verifies the date with a second read', async () => {
  const w = 200, h = 300;
  const img = { data: new Uint8ClampedArray(w * h * 4).fill(255), width: w, height: h };
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) {
      const o = (y * w + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = 0;
    }
  }
  const page = i94Page('09/15/2028');
  const seen = [];
  // A fake OCR engine: a dark marker in the photo's top-left corner tells it how the page is turned.
  const engine = {
    async recognize(im, opts) {
      if (opts.rectangle) return { words: phrase(0, 0, 30, '09/15/2028') };
      const dark = (x, y) => im.data[(y * im.width + x) * 4] < 128;
      const corner = dark(2, 2) ? 'tl' : dark(im.width - 3, 2) ? 'tr' : dark(2, im.height - 3) ? 'bl' : 'br';
      seen.push(corner);
      if (corner === 'bl') return { words: page, rotateRadians: 0 };
      if (corner === 'tl') return { words: turnSideways(page), rotateRadians: 0 };
      return { words: phrase(0, 0, 30, 'xq zzv qqk', 20), rotateRadians: 0 };
    }
  };
  const result = await scan.readImage(img, engine, TODAY);
  assert.deepStrictEqual(seen, ['tl', 'bl']);
  assert.strictEqual(result.doc, 'i94');
  assert.strictEqual(result.fields[0].value, '2028-09-15');
  assert.strictEqual(result.fields[0].status, 'ok');
});

test('prepareImage enlarges small screenshots and shrinks huge photos', () => {
  const small = scan.prepareImage(solid(786, 1024));
  assert.deepStrictEqual([small.width, small.height], [2358, 3072]);
  const huge = scan.prepareImage(solid(4032, 3024));
  assert.deepStrictEqual([huge.width, huge.height], [2600, 1950]);
  const fine = scan.prepareImage(solid(2000, 2600));
  assert.deepStrictEqual([fine.width, fine.height], [2000, 2600]);
});

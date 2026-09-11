/*
 * Node test harness for the date rules in app.js.
 *   node --test tests/
 * No dependencies, no build step — app.js exports its pure functions when it is
 * required from Node and stays a plain browser script otherwise.
 */
const test = require('node:test');
const assert = require('node:assert');
const rules = require('../app.js');

test('addDays crosses month and year boundaries', () => {
  assert.strictEqual(rules.addDays('2026-05-15', -90), '2026-02-14');
  assert.strictEqual(rules.addDays('2026-05-15', 60), '2026-07-14');
  assert.strictEqual(rules.addDays('2026-12-31', 1), '2027-01-01');
});

test('addMonths clamps to the end of a shorter month', () => {
  assert.strictEqual(rules.addMonths('2026-08-31', 6), '2027-02-28');
  assert.strictEqual(rules.addMonths('2027-08-31', 6), '2028-02-29'); // leap year
  assert.strictEqual(rules.addMonths('2026-09-01', 12), '2027-09-01');
});

test('inclusiveDays counts both endpoints', () => {
  assert.strictEqual(rules.inclusiveDays('2026-01-01', '2026-01-01'), 1);
  assert.strictEqual(rules.inclusiveDays('2026-01-01', '2026-12-31'), 365);
});

function byId(items, id) {
  const found = items.find((i) => i.id === id);
  assert.ok(found, 'expected an item with id ' + id);
  return found;
}

test('OPT: 90-days-before / 60-days-after filing window', () => {
  const r = rules.computeOpt({ programEnd: '2026-05-15' });
  assert.strictEqual(byId(r.items, 'opt-window-open').date, '2026-02-14');
  assert.strictEqual(byId(r.items, 'opt-window-close').date, '2026-07-14');
});

test('OPT: 12 months duration and 30-day grace period', () => {
  const r = rules.computeOpt({ programEnd: '2026-05-15', optStart: '2026-09-01' });
  assert.strictEqual(r.computedEnd, '2027-08-31');
  assert.strictEqual(byId(r.items, 'opt-grace').date, '2027-09-30');
  assert.strictEqual(byId(r.items, 'opt-unemployment').date, '2026-11-30');
});

test('OPT: explicit EAD end date wins over the 12-month default', () => {
  const r = rules.computeOpt({ optStart: '2026-09-01', optEnd: '2027-07-15' });
  assert.strictEqual(r.computedEnd, '2027-07-15');
  assert.strictEqual(byId(r.items, 'opt-grace').date, '2027-08-14');
});

test('OPT: DSO recommendation adds a 30-day receipt deadline', () => {
  const r = rules.computeOpt({ programEnd: '2026-05-15', dsoRecommendation: '2026-03-01' });
  assert.strictEqual(byId(r.items, 'opt-dso-30').date, '2026-03-31');
});

test('OPT: I-94 expiring before the filing deadline raises the I-539 flag', () => {
  const r = rules.computeOpt({ programEnd: '2026-05-15', i94Expiration: '2026-06-01' });
  assert.ok(r.flags.some((f) => /I-539/.test(f.title) && f.level === 'bad'));
});

test('OPT: an I-94 that outlasts the filing deadline raises no I-539 flag', () => {
  const r = rules.computeOpt({ programEnd: '2026-05-15', i94Expiration: '2028-06-01' });
  assert.ok(!r.flags.some((f) => /I-539/.test(f.title)));
});

test('STEM: 90-day filing window, 24 months, 60-day grace', () => {
  const r = rules.computeStem({ currentOptEnd: '2027-08-31', stemStart: '2027-09-01' });
  assert.strictEqual(byId(r.items, 'stem-window-open').date, '2027-06-02');
  assert.strictEqual(byId(r.items, 'stem-deadline').date, '2027-08-31');
  assert.strictEqual(byId(r.items, 'stem-end').date, '2029-08-31');
  assert.strictEqual(byId(r.items, 'stem-grace').date, '2029-10-30');
});

test('STEM: start defaults to the day after OPT ends, with 6-month reports', () => {
  const r = rules.computeStem({ currentOptEnd: '2027-08-31' });
  assert.strictEqual(byId(r.items, 'stem-start').date, '2027-09-01');
  assert.strictEqual(byId(r.items, 'stem-report-6').date, '2028-03-01');
  assert.strictEqual(byId(r.items, 'stem-report-12').date, '2028-09-01');
});

test('STEM: a pending timely filing gets 180 days past the OPT end date', () => {
  const r = rules.computeStem({ currentOptEnd: '2027-08-31', filedDate: '2027-06-10' });
  assert.strictEqual(byId(r.items, 'stem-180').date, '2028-02-27');
});

test('CPT: full-time days accumulate toward the 365-day cap', () => {
  const r = rules.computeCpt([
    { id: 'a', employer: 'Acme', start: '2025-06-01', end: '2025-08-31', type: 'full' },
    { id: 'b', employer: 'Globex', start: '2026-01-01', end: '2026-05-31', type: 'full' }
  ]);
  assert.strictEqual(r.fullDays, 92 + 151);
  assert.ok(!r.flags.some((f) => f.level === 'bad'));
});

test('CPT: 365 days of full-time CPT flags loss of OPT eligibility', () => {
  const r = rules.computeCpt([
    { id: 'a', employer: 'Acme', start: '2025-01-01', end: '2025-12-31', type: 'full' }
  ]);
  assert.strictEqual(r.fullDays, 365);
  assert.ok(r.flags.some((f) => f.level === 'bad' && /OPT eligibility/.test(f.title)));
});

test('CPT: part-time days never count toward the cap', () => {
  const r = rules.computeCpt([
    { id: 'a', employer: 'Acme', start: '2025-01-01', end: '2025-12-31', type: 'part' }
  ]);
  assert.strictEqual(r.fullDays, 0);
  assert.strictEqual(r.partDays, 365);
});

test('ICS output carries one VEVENT per deadline with both alarms', () => {
  const ics = rules.buildIcs([
    { id: 'opt-window-close', date: '2026-07-14', label: 'OPT: last day to file', note: 'Receipt deadline.' }
  ], 'F-1 deadlines');
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /DTSTART;VALUE=DATE:20260714/);
  assert.match(ics, /DTEND;VALUE=DATE:20260715/);
  assert.match(ics, /TRIGGER;RELATED=START:-P14D/);
  assert.match(ics, /TRIGGER;RELATED=START:PT9H/);
  assert.strictEqual((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.ok(ics.split('\r\n').every((line) => Buffer.byteLength(line) <= 75), 'lines stay folded under 75 octets');
});

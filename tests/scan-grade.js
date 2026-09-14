/*
 * Shared grading for the document-reader accuracy harnesses (Node and browser).
 *
 *   pass             right date, read twice and matched
 *   pass-check       right date, flagged for a careful look
 *   choice           ambiguous; the right date is one of the offered choices
 *   missed / missed-doc / false-doc   nothing prefilled; the user types it in (safe)
 *   wrong-flagged    a wrong date was prefilled but flagged "check carefully" (bad)
 *   WRONG-CONFIDENT  a wrong date was prefilled as if it were reliable (unacceptable)
 */
(function (root, factory) {
  var grade = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = grade;
  else root.gradeScan = grade;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  return function grade(expect, result) {
    var field = result.fields[0];
    var prefilled = !!(field && field.value);
    if (expect.doc === null) {
      if (prefilled) return 'WRONG-CONFIDENT';
      return result.doc === null ? 'pass' : 'false-doc';
    }
    if (result.doc !== expect.doc) return prefilled ? 'WRONG-CONFIDENT' : 'missed-doc';
    if (expect.ds) {
      if (prefilled) return 'WRONG-CONFIDENT';
      return result.ds ? 'pass' : 'missed';
    }
    if (expect.caseType && expect.caseType !== 'I-765') {
      if (prefilled) return 'WRONG-CONFIDENT';
      return result.caseType === expect.caseType ? 'pass' : 'missed';
    }
    var want = expect.i94Expiration || expect.filedDate;
    if (!field) return 'missed';
    if (field.value === want) return field.status === 'ok' ? 'pass' : 'pass-check';
    if (field.value) return field.status === 'ok' ? 'WRONG-CONFIDENT' : 'wrong-flagged';
    if (field.options.indexOf(want) >= 0) return 'choice';
    return 'missed';
  };
}));

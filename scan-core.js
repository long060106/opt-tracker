/*
 * Document reader core: finds the I-94 "Admit Until Date" and the I-797C "Received Date".
 *
 * Pure logic with no DOM and no network access. The OCR engine is injected, so this same
 * code runs in the browser (Tesseract.js in a Web Worker) and in the Node test harness.
 * Images are plain { data: RGBA Uint8ClampedArray, width, height } objects.
 *
 * Accuracy rules this file enforces:
 *   - a date is only taken from the value next to (or under) its own printed label,
 *     never "the first date on the page";
 *   - every date is read twice, independently, and disagreements are surfaced;
 *   - anything uncertain (ambiguous month, repaired characters, low confidence) is
 *     flagged so the UI can make the user confirm it against the document.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OPTScan = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
    'september', 'october', 'november', 'december'];

  // Glyph pairs Tesseract often swaps; such a substitution costs half an edit.
  var CONFUSABLE = {};
  ['il', 'l1', 'i1', '|l', '|i', '|1', 'o0', 's5', 'b8', 'z2', 'vy', 'uv', 'ce'].forEach(function (pair) {
    CONFUSABLE[pair] = true;
    CONFUSABLE[pair.charAt(1) + pair.charAt(0)] = true;
  });

  // Every printed label on each document. Labels we do not read are still listed: they
  // mark where one value ends and the next box begins.
  var SPECS = {
    i94: {
      name: 'I-94 admission record',
      labels: {
        admitUntil: ['admit', 'until', 'date'],
        entry: ['date', 'of', 'entry'],
        classOfAdmission: ['class', 'of', 'admission'],
        recordNumber: ['record', 'number'],
        birth: ['birth', 'date'],
        surname: ['last', 'surname'],
        givenName: ['first', 'given', 'name'],
        documentNumber: ['document', 'number'],
        passportNumber: ['passport', 'number'],
        citizenship: ['country', 'of', 'citizenship'],
        issuance: ['country', 'of', 'issuance'],
        details: ['details', 'provided']
      }
    },
    i797: {
      name: 'I-797C receipt notice',
      labels: {
        receivedDate: ['received', 'date'],
        noticeDate: ['notice', 'date'],
        noticeType: ['notice', 'type'],
        caseType: ['case', 'type'],
        receiptNumber: ['receipt', 'number'],
        priorityDate: ['priority', 'date'],
        page: ['page'],
        alienNumber: ['alien', 'number'],
        classification: ['classification'],
        eligibility: ['eligibility'],
        preference: ['preference'],
        birth: ['date', 'of', 'birth'],
        applicant: ['applicant'],
        beneficiary: ['beneficiary']
      }
    }
  };

  /* ============================== fuzzy text ============================== */

  function simplify(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9|]/g, '');
  }

  function canon(text) {
    return text.replace(/rn/g, 'm').replace(/vv/g, 'w');
  }

  function distance(a, b) {
    a = canon(a);
    b = canon(b);
    var prev = [], cur, i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      for (j = 1; j <= b.length; j++) {
        var ca = a.charAt(i - 1), cb = b.charAt(j - 1);
        var sub = ca === cb ? 0 : (CONFUSABLE[ca + cb] ? 0.5 : 1);
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + sub);
      }
      prev = cur;
    }
    return prev[b.length];
  }

  function allowance(length) {
    if (length <= 2) return 0.5;
    if (length <= 4) return 1;
    if (length <= 8) return 1.5;
    return 2;
  }

  /* ============================== geometry ============================== */

  function union(items) {
    return items.reduce(function (box, w) {
      return {
        x0: Math.min(box.x0, w.x0), y0: Math.min(box.y0, w.y0),
        x1: Math.max(box.x1, w.x1), y1: Math.max(box.y1, w.y1)
      };
    }, { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
  }

  function heightOf(box) { return Math.max(1, box.y1 - box.y0); }

  function sameRow(a, b) {
    var overlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    return overlap >= 0.5 * Math.min(heightOf(a), heightOf(b));
  }

  function byX(a, b) { return a.x0 - b.x0; }

  function clamp(value, lo, hi) { return Math.max(lo, Math.min(hi, value)); }

  // Split "Date:D/S"-style tokens at colons, sharing the box out by character count.
  function prepareWords(words) {
    var out = [];
    words.forEach(function (w) {
      var text = String(w.text || '').trim();
      if (!text) return;
      var parts = text.split(':');
      if (parts.length === 1) {
        out.push({ text: text, conf: w.conf, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 });
        return;
      }
      var width = w.x1 - w.x0, offset = 0;
      parts.forEach(function (part, i) {
        var start = offset;
        offset += part.length + (i < parts.length - 1 ? 1 : 0);
        var trimmed = part.trim();
        if (!trimmed) return;
        out.push({
          text: trimmed, conf: w.conf, y0: w.y0, y1: w.y1,
          x0: w.x0 + width * start / text.length,
          x1: w.x0 + width * (start + part.length) / text.length
        });
      });
    });
    return out;
  }

  function rightNeighbor(word, words) {
    var h = heightOf(word), best = null;
    words.forEach(function (c) {
      if (c === word || c.x0 <= word.x0 || !sameRow(word, c)) return;
      var gap = c.x0 - word.x1;
      if (gap < -0.3 * h || gap > 1.8 * h) return;
      if (!best || c.x0 < best.x0) best = c;
    });
    return best;
  }

  /* ============================== labels ============================== */

  function matchLabel(words, tokens) {
    var hits = [];
    words.forEach(function (start) {
      var chain = extend(start, 0, []);
      if (chain) hits.push({ words: chain, box: union(chain) });
    });
    return hits.sort(function (a, b) { return (a.box.y0 - b.box.y0) || (a.box.x0 - b.box.x0); });

    function extend(word, t, acc) {
      var text = simplify(word.text);
      if (!text) return null;
      var steps = [];
      if (distance(text, tokens[t]) <= allowance(tokens[t].length)) steps.push(1);
      if (t + 1 < tokens.length) {
        var joined = tokens[t] + tokens[t + 1];
        if (distance(text, joined) <= allowance(joined.length)) steps.push(2);
      }
      for (var i = 0; i < steps.length; i++) {
        var next = t + steps[i], chain = acc.concat([word]);
        if (next === tokens.length) return chain;
        var neighbor = rightNeighbor(word, words);
        if (neighbor) {
          var rest = extend(neighbor, next, chain);
          if (rest) return rest;
        }
      }
      return null;
    }
  }

  /* ============================== values ============================== */

  function takeRun(row, h, stop, max) {
    var run = [];
    for (var i = 0; i < row.length && run.length < max; i++) {
      var w = row[i];
      if (stop.has(w) || /^[|\[\]]+$/.test(w.text)) break;
      if (run.length && w.x0 - run[run.length - 1].x1 > 2.5 * h) break;
      run.push(w);
    }
    return run;
  }

  function valueRight(hit, words, stop, max) {
    var box = hit.box, h = heightOf(box);
    var row = words.filter(function (w) {
      return hit.words.indexOf(w) < 0 && sameRow(w, box) &&
        w.x0 >= box.x1 - 0.2 * h && w.x0 - box.x1 <= 14 * h;
    }).sort(byX);
    return takeRun(row, h, stop, max || 6);
  }

  function valueBelow(hit, words, stop, max) {
    var box = hit.box, h = heightOf(box);
    var column = words.filter(function (w) {
      return hit.words.indexOf(w) < 0 && w.y0 >= box.y1 - 0.25 * h && w.y0 - box.y1 <= 4 * h &&
        w.x0 >= box.x0 - 3 * h && w.x0 <= box.x0 + Math.max(4 * h, 0.6 * (box.x1 - box.x0));
    });
    if (!column.length) return [];
    column.sort(function (a, b) { return (a.y0 - b.y0) || (a.x0 - b.x0); });
    var top = column.filter(function (w) { return sameRow(w, column[0]); }).sort(byX)[0];
    if (stop.has(top)) return [];
    var row = words.filter(function (w) {
      return hit.words.indexOf(w) < 0 && sameRow(w, top) && w.x0 >= top.x0;
    }).sort(byX);
    return takeRun(row, heightOf(top), stop, max || 6);
  }

  function runText(run) {
    return run.map(function (w) { return w.text; }).join(' ');
  }

  function readValue(hit, words, stop, prefer) {
    var runs = prefer === 'below'
      ? [valueBelow(hit, words, stop), valueRight(hit, words, stop)]
      : [valueRight(hit, words, stop), valueBelow(hit, words, stop)];
    for (var i = 0; i < runs.length; i++) {
      if (!runs[i].length) continue;
      var parsed = parseDate(runs[i]);
      if (parsed) return { run: runs[i], parsed: parsed };
    }
    return { run: runs[0].length ? runs[0] : runs[1], parsed: null };
  }

  /* ============================== dates ============================== */

  var DIGIT_FIX = { o: '0', O: '0', Q: '0', D: '0', l: '1', I: '1', i: '1', '|': '1', '!': '1',
    S: '5', s: '5', B: '8', Z: '2', z: '2', b: '6', g: '9', q: '9' };

  // Repairs only tokens that are already mostly digits, so real words never become numbers.
  function fixDigits(token) {
    var digits = (token.match(/\d/g) || []).length;
    var letters = (token.match(/[A-Za-z|!]/g) || []).length;
    if (!digits || letters > digits) return { text: token, fixed: false };
    var out = token.replace(/[oOQDlIi|!SsBZzbgq]/g, function (c) { return DIGIT_FIX[c]; });
    return { text: out, fixed: out !== token };
  }

  function stripEdges(text) {
    return text.replace(/^[^A-Za-z0-9|]+|[^A-Za-z0-9|]+$/g, '');
  }

  function isoDate(year, month, day) {
    if (!(year >= 1900 && year <= 2099 && month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
    var d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
    return year + '-' + (month < 10 ? '0' : '') + month + '-' + (day < 10 ? '0' : '') + day;
  }

  function monthOf(token) {
    var w = token.toLowerCase().replace(/[^a-z|]/g, '');
    if (w.length < 3) return null;
    var scores = MONTHS.map(function (name, index) {
      var d = distance(w, name);
      if (w.length <= 4) d = Math.min(d, distance(w, name.slice(0, 3)));
      if (index === 8) d = Math.min(d, distance(w, 'sept'));
      return { month: index + 1, d: d };
    }).sort(function (a, b) { return a.d - b.d; });
    var limit = allowance(w.length);
    if (scores[0].d > limit) return null;
    var close = scores.filter(function (s) { return s.d <= limit && s.d - scores[0].d < 0.5; });
    return {
      candidates: close.map(function (s) { return s.month; }),
      fuzzy: scores[0].d > 0
    };
  }

  function yearOf(token) {
    var f = fixDigits(stripEdges(token));
    return /^(19|20)\d\d$/.test(f.text) ? { value: Number(f.text), fixed: f.fixed } : null;
  }

  function dayOf(token) {
    var f = fixDigits(stripEdges(token));
    if (!/^\d{1,2}$/.test(f.text)) return null;
    var v = Number(f.text);
    return v >= 1 && v <= 31 ? { value: v, fixed: f.fixed } : null;
  }

  function normalizeTokens(input) {
    var list = Array.isArray(input) ? input : [input];
    var out = [];
    list.forEach(function (item) {
      var isString = typeof item === 'string';
      var word = isString ? null : item;
      String(isString ? item : item.text || '').split(/\s+/).forEach(function (piece) {
        piece.split(/,(?=\S)/).forEach(function (p) {
          if (p) out.push({ text: p, word: word });
        });
      });
    });
    return out;
  }

  function dateResult(options, tokens, fixed, fuzzy) {
    var unique = options.filter(function (v, i) { return v && options.indexOf(v) === i; });
    if (!unique.length) return null;
    var words = [];
    tokens.forEach(function (t) { if (t.word && words.indexOf(t.word) < 0) words.push(t.word); });
    return {
      iso: unique.length === 1 ? unique[0] : null,
      options: unique.length > 1 ? unique : [],
      raw: tokens.map(function (t) { return t.text; }).join(' '),
      words: words,
      fixed: !!fixed,
      fuzzy: !!fuzzy
    };
  }

  function numericAt(tokens, s) {
    for (var n = 1; n <= 5 && s + n <= tokens.length; n++) {
      var slice = tokens.slice(s, s + n);
      var joined = stripEdges(slice.map(function (t) { return t.text; }).join(''));
      var f = fixDigits(joined);
      var m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/.exec(f.text);
      if (m) return dateResult([isoDate(Number(m[3]), Number(m[1]), Number(m[2]))], slice, f.fixed, false);
    }
    return null;
  }

  function wordsAt(tokens, s) {
    if (s + 3 > tokens.length) return null;
    var slice = tokens.slice(s, s + 3);
    var a = slice[0].text, b = slice[1].text, c = slice[2].text;
    var patterns = [[yearOf(a), monthOf(b), dayOf(c)], [yearOf(c), monthOf(a), dayOf(b)], [yearOf(c), monthOf(b), dayOf(a)]];
    for (var i = 0; i < patterns.length; i++) {
      var year = patterns[i][0], month = patterns[i][1], day = patterns[i][2];
      if (!year || !month || !day) continue;
      var options = month.candidates.map(function (m) { return isoDate(year.value, m, day.value); });
      var result = dateResult(options, slice, year.fixed || day.fixed, month.fuzzy);
      if (result) return result;
    }
    return null;
  }

  // Accepts MM/DD/YYYY, "YYYY Month DD" (CBP I-94 site), "Month DD, YYYY" (USCIS notices)
  // and "DD Month YYYY". Input is a string, an array of strings, or OCR word objects.
  function parseDate(input) {
    var tokens = normalizeTokens(input);
    for (var s = 0; s < tokens.length; s++) {
      var hit = numericAt(tokens, s) || wordsAt(tokens, s);
      if (hit) return hit;
    }
    return null;
  }

  function isDS(run) {
    if (!run.length) return false;
    var t = run.slice(0, 3).map(function (w) { return w.text; }).join('').toLowerCase();
    return /^(d[\/|l1i\\]?s|[o0][\/|\\]s)\.?$/.test(t);
  }

  function classifyCase(text) {
    var t = String(text || '').toLowerCase();
    if (!t) return null;
    if (/employment\s*authori[sz]ation/.test(t) || /(^|[^0-9])765([^0-9]|$)/.test(t)) return 'I-765';
    var m = /(?:^|[^a-z0-9])[il1|[!]\s?-?\s?(\d{3})(?![0-9])/.exec(t);
    return m && m[1] !== '797' ? 'I-' + m[1] : null;
  }

  /* ============================== extraction ============================== */

  function todayIso() {
    var d = new Date();
    return isoDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }

  function makeField(field, label, hit, value, direction) {
    var parsed = value.parsed;
    var used = parsed && parsed.words.length ? parsed.words : value.run;
    var h = heightOf(hit.box);
    var confs = used.map(function (w) { return w.conf; })
      .filter(function (c) { return typeof c === 'number' && isFinite(c); });
    var out = {
      field: field,
      label: label,
      value: parsed ? parsed.iso : null,
      options: parsed ? parsed.options.slice() : [],
      raw: runText(value.run),
      labelBox: hit.box,
      valueBox: used.length ? union(used) : null,
      searchBox: direction === 'right'
        ? { x0: hit.box.x1, y0: hit.box.y0 - 0.4 * h, x1: hit.box.x1 + 14 * h, y1: hit.box.y1 + 0.4 * h }
        : { x0: hit.box.x0 - h, y0: hit.box.y1, x1: hit.box.x0 + 18 * h, y1: hit.box.y1 + 3 * h },
      confidence: confs.length ? Math.round(Math.min.apply(null, confs)) : null,
      issues: [],
      verified: false,
      secondRead: null,
      status: 'check'
    };
    if (!parsed) out.issues.push('unreadable');
    else {
      if (parsed.fixed) out.issues.push('fixed-characters');
      if (parsed.fuzzy) out.issues.push('fuzzy-month');
      if (parsed.options.length) out.issues.push('ambiguous');
    }
    if (out.confidence !== null && out.confidence < 75) out.issues.push('low-confidence');
    return out;
  }

  function extractI94(result, found, words, stop, today) {
    var hit = found.admitUntil[0];
    if (!hit) {
      result.notices.push({ level: 'warn', text: 'This looks like an I-94, but the "Admit Until Date" line could not be read. Please type the date in yourself.' });
      return result;
    }
    if (isDS(valueRight(hit, words, stop))) {
      result.ds = true;
      result.notices.push({ level: 'info', text: 'This I-94 says "D/S" (duration of status) instead of a fixed date, so there is no expiration date to fill in. If you have entered the U.S. since the new rule took effect, get your most recent I-94 at i94.cbp.dhs.gov.' });
      return result;
    }
    var field = makeField('i94Expiration', 'I-94 expiration ("Admit Until Date")', hit,
      readValue(hit, words, stop, 'right'), 'right');
    var entryHit = found.entry[0];
    if (field.value && entryHit) {
      var entry = readValue(entryHit, words, stop, 'right').parsed;
      if (entry && entry.iso && entry.iso >= field.value) field.issues.push('before-entry');
    }
    if (field.value && field.value < today) field.issues.push('in-past');
    result.fields.push(field);
    return result;
  }

  function extractI797(result, found, words, stop, text, today) {
    var caseHit = found.caseType[0];
    var caseText = '';
    if (caseHit) caseText = runText(valueBelow(caseHit, words, stop, 10)) || runText(valueRight(caseHit, words, stop, 10));
    var caseType = classifyCase(caseText) ||
      (/(^|[^a-z0-9])[il1|[!]\s?-?\s?765([^0-9]|$)|employment\s+authori[sz]ation/.test(text) ? 'I-765' : null);
    result.caseType = caseType;
    if (caseType && caseType !== 'I-765') {
      result.notices.push({ level: 'bad', text: 'This receipt notice is for Form ' + caseType + ', not Form I-765 (the OPT / STEM-OPT work permit application), so its date was not used.' });
      return result;
    }
    var hit = found.receivedDate[0];
    if (!hit) {
      result.notices.push({ level: 'warn', text: 'This looks like an I-797C, but the "Received Date" box could not be read. Please type the date in yourself.' });
      return result;
    }
    var field = makeField('filedDate', 'I-765 received date', hit, readValue(hit, words, stop, 'below'), 'below');
    if (!caseType) field.issues.push('case-type-unknown');
    var noticeHit = found.noticeDate[0];
    if (field.value && noticeHit) {
      var notice = readValue(noticeHit, words, stop, 'below').parsed;
      if (notice && notice.iso && notice.iso < field.value) field.issues.push('after-notice');
    }
    if (field.value && field.value > today) field.issues.push('future');
    result.fields.push(field);
    return result;
  }

  function extract(rawWords, options) {
    options = options || {};
    var today = options.today || todayIso();
    var words = prepareWords(rawWords || []);
    var text = words.map(function (w) { return w.text; }).join(' ').toLowerCase();
    var found = {};
    Object.keys(SPECS).forEach(function (doc) {
      found[doc] = {};
      Object.keys(SPECS[doc].labels).forEach(function (key) {
        found[doc][key] = matchLabel(words, SPECS[doc].labels[key]);
      });
    });
    function has(doc, key) { return found[doc][key].length > 0; }

    var i94Score = (has('i94', 'admitUntil') ? 3 : 0) + (has('i94', 'classOfAdmission') ? 1 : 0) +
      (has('i94', 'entry') ? 1 : 0) + (/(^|[^0-9a-z])[il1|[!]\s?-\s?94([^0-9]|$)/.test(text) ? 1 : 0) +
      (/border\s+protection/.test(text) ? 1 : 0);
    var i797Score = (/notice\s+of\s+action/.test(text) ? 2 : 0) + (/[il1|[!]\s?-?\s?797/.test(text) ? 2 : 0) +
      (has('i797', 'receivedDate') ? 1 : 0) + (has('i797', 'receiptNumber') ? 1 : 0) +
      (has('i797', 'caseType') ? 1 : 0) + (has('i797', 'noticeDate') ? 1 : 0);

    var doc = null;
    if (i94Score >= 3 && i94Score >= i797Score) doc = 'i94';
    else if (i797Score >= 4) doc = 'i797';

    var result = {
      doc: doc, docName: doc ? SPECS[doc].name : null, fields: [], notices: [],
      ds: false, caseType: null, scores: { i94: i94Score, i797: i797Score }
    };
    if (!doc) return result;

    var stop = new Set();
    Object.keys(found[doc]).forEach(function (key) {
      found[doc][key].forEach(function (hit) { hit.words.forEach(function (w) { stop.add(w); }); });
    });
    return doc === 'i94'
      ? extractI94(result, found.i94, words, stop, today)
      : extractI797(result, found.i797, words, stop, text, today);
  }

  // Folds an independent second read of the same spot into a field.
  function reconcile(field, secondWords) {
    secondWords = secondWords || [];
    var second = parseDate(secondWords);
    var secondIso = second && second.iso;
    field.secondRead = second ? (second.iso || second.options.join(' or ')) : runText(secondWords);

    if (field.value && secondIso) {
      if (field.value === secondIso) field.verified = true;
      else {
        field.options = [field.value, secondIso];
        field.value = null;
        field.issues.push('reads-disagree');
      }
    } else if (!field.value && secondIso) {
      if (field.options.length && field.options.indexOf(secondIso) >= 0) {
        field.value = secondIso;
        field.options = [];
        field.issues.push('resolved-by-second-read');
      } else if (field.options.length) {
        field.options.push(secondIso);
        field.issues.push('reads-disagree');
      } else {
        field.value = secondIso;
        field.issues.push('second-read-only');
      }
    } else if (field.value && !secondIso) {
      if (second && second.options.indexOf(field.value) >= 0) field.verified = true;
      else field.issues.push('second-read-failed');
    }

    // A receipt that cannot be confirmed as an I-765 is never prefilled; the user has to pick its date.
    if (field.value && field.issues.indexOf('case-type-unknown') >= 0) {
      if (field.options.indexOf(field.value) < 0) field.options.unshift(field.value);
      field.value = null;
    }

    var confs = secondWords.map(function (w) { return w.conf; })
      .filter(function (c) { return typeof c === 'number' && isFinite(c); });
    var secondConf = confs.length ? Math.min.apply(null, confs) : 0;
    field.status = field.value && field.verified && Math.max(field.confidence || 0, secondConf) >= 75 ? 'ok' : 'check';
    return field;
  }

  /* ============================== images ============================== */

  function makeImage(width, height) {
    return { data: new Uint8ClampedArray(width * height * 4), width: width, height: height };
  }

  function luminance(img) {
    var n = img.width * img.height, out = new Uint8ClampedArray(n), d = img.data;
    for (var i = 0, j = 0; i < n; i++, j += 4) {
      var v = (d[j] * 299 + d[j + 1] * 587 + d[j + 2] * 114) / 1000;
      var a = d[j + 3];
      out[i] = (v * a + 255 * (255 - a)) / 255; // transparent pixels become white paper
    }
    return out;
  }

  function fromLuminance(lum, width, height) {
    var img = makeImage(width, height), d = img.data;
    for (var i = 0, j = 0; i < lum.length; i++, j += 4) {
      d[j] = d[j + 1] = d[j + 2] = lum[i];
      d[j + 3] = 255;
    }
    return img;
  }

  function cubic(t) {
    var t2 = t * t, t3 = t2 * t;
    return [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2];
  }

  // One-dimensional resample: box filter when shrinking, Catmull-Rom when enlarging.
  function resample(src, sw, sh, size, horizontal) {
    var sn = horizontal ? sw : sh, other = horizontal ? sh : sw;
    var ow = horizontal ? size : sw;
    var out = new Uint8ClampedArray(horizontal ? size * sh : sw * size);
    var ratio = sn / size, taps = [], i, k;
    for (i = 0; i < size; i++) {
      var idx = [], wts = [];
      if (ratio > 1) {
        var start = i * ratio, end = (i + 1) * ratio;
        for (k = Math.floor(start); k < Math.ceil(end) && k < sn; k++) {
          var cover = Math.min(end, k + 1) - Math.max(start, k);
          if (cover > 0) { idx.push(k); wts.push(cover / ratio); }
        }
      } else {
        var f = (i + 0.5) * ratio - 0.5, base = Math.floor(f), w = cubic(f - base);
        for (k = -1; k <= 2; k++) { idx.push(clamp(base + k, 0, sn - 1)); wts.push(w[k + 1]); }
      }
      taps.push({ idx: idx, wts: wts });
    }
    for (var o = 0; o < other; o++) {
      for (i = 0; i < size; i++) {
        var tap = taps[i], sum = 0;
        for (k = 0; k < tap.idx.length; k++) {
          sum += src[horizontal ? o * sw + tap.idx[k] : tap.idx[k] * sw + o] * tap.wts[k];
        }
        out[horizontal ? o * size + i : i * ow + o] = sum;
      }
    }
    return out;
  }

  function resize(img, width, height) {
    var lum = luminance(img);
    var wide = resample(lum, img.width, img.height, width, true);
    return fromLuminance(resample(wide, width, img.height, height, false), width, height);
  }

  function toGray(img) {
    return fromLuminance(luminance(img), img.width, img.height);
  }

  // Grayscale, then scale so a letter-size page is roughly 2400px wide (about 280 dpi):
  // small screenshots get enlarged, 12-megapixel phone photos get reduced.
  function prepareImage(img) {
    var effective = Math.max(img.width, img.height * 0.773);
    var scale = 1;
    if (effective < 1800) scale = Math.min(3, 2400 / effective);
    else if (effective > 3400) scale = 2600 / effective;
    if (scale === 1) return toGray(img);
    return resize(img, Math.round(img.width * scale), Math.round(img.height * scale));
  }

  function rotateQuarter(img, turns) {
    turns = ((turns % 4) + 4) % 4;
    if (!turns) return img;
    var w = img.width, h = img.height;
    var ow = turns % 2 ? h : w, oh = turns % 2 ? w : h;
    var out = makeImage(ow, oh), s = img.data, d = out.data;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var nx, ny;
        if (turns === 1) { nx = h - 1 - y; ny = x; }
        else if (turns === 2) { nx = w - 1 - x; ny = h - 1 - y; }
        else { nx = y; ny = w - 1 - x; }
        var si = (y * w + x) * 4, di = (ny * ow + nx) * 4;
        d[di] = s[si]; d[di + 1] = s[si + 1]; d[di + 2] = s[si + 2]; d[di + 3] = s[si + 3];
      }
    }
    return out;
  }

  // Rotates a grayscale image about its centre, keeping its size; uncovered corners are white.
  function rotateImage(img, radians) {
    var w = img.width, h = img.height, cx = (w - 1) / 2, cy = (h - 1) / 2;
    var cos = Math.cos(radians), sin = Math.sin(radians);
    var s = img.data, out = makeImage(w, h), d = out.data, row = w * 4;
    for (var y = 0; y < h; y++) {
      var dy = y - cy;
      for (var x = 0; x < w; x++) {
        var dx = x - cx;
        var sx = cx + cos * dx + sin * dy, sy = cy - sin * dx + cos * dy;
        var x0 = Math.floor(sx), y0 = Math.floor(sy), v = 255;
        if (x0 >= 0 && y0 >= 0 && x0 < w - 1 && y0 < h - 1) {
          var fx = sx - x0, fy = sy - y0, i = (y0 * w + x0) * 4;
          var top = s[i] + (s[i + 4] - s[i]) * fx;
          var bottom = s[i + row] + (s[i + row + 4] - s[i + row]) * fx;
          v = top + (bottom - top) * fy;
        }
        var o = (y * w + x) * 4;
        d[o] = d[o + 1] = d[o + 2] = v;
        d[o + 3] = 255;
      }
    }
    return out;
  }

  function cropImage(img, box) {
    var x0 = clamp(Math.floor(box.x0), 0, img.width - 1), y0 = clamp(Math.floor(box.y0), 0, img.height - 1);
    var x1 = clamp(Math.ceil(box.x1), x0 + 1, img.width), y1 = clamp(Math.ceil(box.y1), y0 + 1, img.height);
    var out = makeImage(x1 - x0, y1 - y0);
    for (var y = y0; y < y1; y++) {
      var from = (y * img.width + x0) * 4;
      out.data.set(img.data.subarray(from, from + (x1 - x0) * 4), (y - y0) * out.width * 4);
    }
    return out;
  }

  /* ============================== OCR adapters ============================== */

  function wordsFromBlocks(blocks) {
    var out = [];
    (blocks || []).forEach(function (b) {
      (b.paragraphs || []).forEach(function (p) {
        (p.lines || []).forEach(function (l) {
          (l.words || []).forEach(function (w) {
            out.push({ text: w.text, conf: w.confidence, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 });
          });
        });
      });
    });
    return out;
  }

  // pdf.js text items -> word boxes in the pixel space of a page rendered with `viewport`.
  function wordsFromPdfItems(items, viewportTransform) {
    var v = viewportTransform, out = [];
    var scale = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
    (items || []).forEach(function (item) {
      if (!item.str || !item.str.trim()) return;
      var t = item.transform;
      var m = [
        v[0] * t[0] + v[2] * t[1], v[1] * t[0] + v[3] * t[1],
        v[0] * t[2] + v[2] * t[3], v[1] * t[2] + v[3] * t[3],
        v[0] * t[4] + v[2] * t[5] + v[4], v[1] * t[4] + v[3] * t[5] + v[5]
      ];
      if (Math.abs(m[1]) > Math.abs(m[0]) * 0.1) return; // skip rotated/vertical text
      var fontHeight = Math.sqrt(m[2] * m[2] + m[3] * m[3]);
      var width = item.width * scale, len = item.str.length, re = /\S+/g, match;
      while ((match = re.exec(item.str))) {
        out.push({
          text: match[0], conf: 99,
          x0: m[4] + width * match.index / len,
          x1: m[4] + width * (match.index + match[0].length) / len,
          y0: m[5] - fontHeight * 0.85,
          y1: m[5] + fontHeight * 0.2
        });
      }
    });
    return out;
  }

  /* ============================== pipeline ============================== */

  // Direction in which rotateImage must turn a page to undo the skew Tesseract reports.
  var DESKEW_SIGN = 1;

  function countGoodWords(words) {
    return words.filter(function (w) { return w.conf >= 80 && /[a-z]{3,}/i.test(w.text); }).length;
  }

  function verifyRect(field, img) {
    var box = field.valueBox;
    if (box) {
      var h = heightOf(box);
      box = { x0: box.x0 - 1.5 * h, y0: box.y0 - 0.35 * h, x1: Math.max(box.x1, box.x0 + 9 * h) + 1.5 * h, y1: box.y1 + 0.35 * h };
    } else {
      box = field.searchBox;
    }
    var x0 = clamp(Math.floor(box.x0), 0, img.width - 1), y0 = clamp(Math.floor(box.y0), 0, img.height - 1);
    var x1 = clamp(Math.ceil(box.x1), x0 + 1, img.width), y1 = clamp(Math.ceil(box.y1), y0 + 1, img.height);
    return { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
  }

  async function finish(attempt, engine, progress) {
    var result = attempt.result;
    for (var i = 0; i < result.fields.length; i++) {
      progress({ step: 'verify' });
      var field = result.fields[i];
      var second = await engine.recognize(attempt.img, {
        psm: 7, rectangle: verifyRect(field, attempt.img), thresholding: 'sauvola'
      });
      reconcile(field, second.words);
    }
    result.image = attempt.img;
    return result;
  }

  async function readOrientation(img, engine, options) {
    var pass = await engine.recognize(img, { psm: 3, rotateAuto: true });
    if (Math.abs(pass.rotateRadians || 0) >= 0.005) {
      img = rotateImage(img, DESKEW_SIGN * pass.rotateRadians);
      pass = await engine.recognize(img, { psm: 3 });
    }
    return { img: img, words: pass.words, shape: orientationOf(pass.words), result: extract(pass.words, options) };
  }

  // Median of every 3x3 neighbourhood (Devillard's 19-swap network): removes scanner and
  // fax speckle while keeping letter strokes intact.
  var MEDIAN_PAIRS = [1, 2, 4, 5, 7, 8, 0, 1, 3, 4, 6, 7, 1, 2, 4, 5, 7, 8, 0, 3, 5, 8, 4, 7, 3, 6, 1, 4, 2, 5, 4, 7, 4, 2, 6, 4, 4, 2];

  function despeckle(img) {
    var w = img.width, h = img.height, s = img.data, out = makeImage(w, h), d = out.data;
    var p = new Int32Array(9);
    for (var y = 0; y < h; y++) {
      var ya = (y > 0 ? y - 1 : 0) * w, yb = y * w, yc = (y < h - 1 ? y + 1 : h - 1) * w;
      for (var x = 0; x < w; x++) {
        var xa = x > 0 ? x - 1 : 0, xc = x < w - 1 ? x + 1 : w - 1;
        p[0] = s[(ya + xa) * 4]; p[1] = s[(ya + x) * 4]; p[2] = s[(ya + xc) * 4];
        p[3] = s[(yb + xa) * 4]; p[4] = s[(yb + x) * 4]; p[5] = s[(yb + xc) * 4];
        p[6] = s[(yc + xa) * 4]; p[7] = s[(yc + x) * 4]; p[8] = s[(yc + xc) * 4];
        for (var k = 0; k < MEDIAN_PAIRS.length; k += 2) {
          var a = MEDIAN_PAIRS[k], b = MEDIAN_PAIRS[k + 1];
          if (p[a] > p[b]) { var t = p[a]; p[a] = p[b]; p[b] = t; }
        }
        var o = (yb + x) * 4;
        d[o] = d[o + 1] = d[o + 2] = p[4];
        d[o + 3] = 255;
      }
    }
    return out;
  }

  // Tesseract happily reads a page lying on its side, but then words come back as tall boxes
  // and label/value geometry no longer means anything. Such a read is never trusted.
  function orientationOf(words) {
    var sample = words.filter(function (w) {
      return w.conf >= 60 && String(w.text).replace(/[^a-z0-9]/gi, '').length >= 4;
    });
    if (sample.length < 8) return 'unknown';
    var tall = sample.filter(function (w) { return (w.y1 - w.y0) > (w.x1 - w.x0); }).length;
    return tall > sample.length / 2 ? 'sideways' : 'upright';
  }

  // 3 = has an answer (a date, D/S, or a refusal); 2 = choices; 1 = document but no date; 0 = nothing.
  function completeness(result) {
    if (!result.doc) return 0;
    if (result.ds || (result.caseType && result.caseType !== 'I-765')) return 3;
    var f = result.fields[0];
    if (f && f.value) return 3;
    if (f && f.options.length) return 2;
    return 1;
  }

  function isComplete(attempt) {
    return attempt.shape !== 'sideways' && completeness(attempt.result) === 3;
  }

  function better(a, b) {
    if ((a.shape === 'sideways') !== (b.shape === 'sideways')) return b.shape === 'sideways';
    var ca = completeness(a.result), cb = completeness(b.result);
    if (ca !== cb) return ca > cb;
    return countGoodWords(a.words) > countGoodWords(b.words);
  }

  // engine.recognize(image, { psm, rotateAuto, rectangle, thresholding })
  //   -> Promise<{ words: [{ text, conf, x0, y0, x1, y1 }], rotateRadians }>
  async function readImage(image, engine, options) {
    options = options || {};
    var progress = options.onProgress || function () {};
    progress({ step: 'prepare' });
    var base = prepareImage(image);
    progress({ step: 'read' });
    var best = await readOrientation(base, engine, options);

    var turns = [];
    if (best.shape === 'sideways') turns = [3, 1];
    else if (!isComplete(best) && countGoodWords(best.words) < 15) turns = [2, 3, 1];
    for (var i = 0; i < turns.length && !isComplete(best); i++) {
      progress({ step: 'rotate' });
      var turned = await readOrientation(rotateQuarter(base, turns[i]), engine, options);
      if (better(turned, best)) best = turned;
    }

    if (!isComplete(best) && (best.result.doc || countGoodWords(best.words) < 15)) {
      progress({ step: 'clean' });
      var cleaned = await readOrientation(despeckle(best.img), engine, options);
      if (better(cleaned, best)) best = cleaned;
    }
    return finish(best, engine, progress);
  }

  // page: { words: text-layer words in rendered-pixel space (may be empty), image: rendered page }
  async function readPdfPage(page, engine, options) {
    options = options || {};
    var progress = options.onProgress || function () {};
    if (page.words && page.words.length) {
      var result = extract(page.words, options);
      if (completeness(result) === 3) {
        progress({ step: 'text' });
        result.source = 'pdf-text';
        return finish({ img: toGray(page.image), result: result }, engine, progress);
      }
    }
    var scanned = await readImage(page.image, engine, options);
    scanned.source = 'ocr';
    return scanned;
  }

  return {
    SPECS: SPECS,
    distance: distance,
    parseDate: parseDate,
    classifyCase: classifyCase,
    extract: extract,
    reconcile: reconcile,
    prepareImage: prepareImage,
    resize: resize,
    toGray: toGray,
    rotateQuarter: rotateQuarter,
    rotateImage: rotateImage,
    despeckle: despeckle,
    cropImage: cropImage,
    orientationOf: orientationOf,
    wordsFromBlocks: wordsFromBlocks,
    wordsFromPdfItems: wordsFromPdfItems,
    verifyRect: verifyRect,
    readImage: readImage,
    readPdfPage: readPdfPage
  };
}));

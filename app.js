/*
 * OPT Tracker — F-1 OPT / STEM-OPT / CPT deadline calculator.
 *
 * Everything in this file runs in the user's browser. There is no backend,
 * no database, and no network call except:
 *   - loading this site's own static files, and
 *   - the OPTIONAL Google Drive backup, which goes browser -> Google directly
 *     using the user's own OAuth login and the narrow drive.file scope.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'opt-tracker/v1';
  var SOON_DAYS = 14;               // "within 14 days" threshold
  var OPT_MONTHS = 12;              // standard post-completion OPT duration
  var OPT_GRACE_DAYS = 30;          // grace period after OPT ends
  var STEM_MONTHS = 24;             // STEM-OPT extension duration
  var STEM_GRACE_DAYS = 60;         // grace period after STEM-OPT ends
  var FILE_WINDOW_BEFORE = 90;      // may apply up to 90 days before
  var FILE_WINDOW_AFTER = 60;       // ...and up to 60 days after program end
  var STEM_FILE_WINDOW_BEFORE = 90; // STEM: up to 90 days before OPT expires
  var DSO_REC_WINDOW = 30;          // I-765 must reach USCIS within 30 days of the SEVIS recommendation
  var PENDING_STEM_DAYS = 180;      // automatic extension while a timely STEM filing is pending
  var OPT_UNEMPLOYMENT = 90;
  var STEM_UNEMPLOYMENT = 150;
  var CPT_FULLTIME_CAP = 365;       // 365+ days of full-time CPT => ineligible for OPT

  /* ============================ date helpers ============================ */

  function todayISO() {
    var d = new Date();
    return iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function iso(y, m, d) { return y + '-' + pad(m) + '-' + pad(d); }

  // Parse "YYYY-MM-DD" into a UTC-noon Date (noon avoids every DST edge case).
  function parse(value) {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    var p = value.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2], 12, 0, 0));
    if (isNaN(d.getTime()) || d.getUTCMonth() !== p[1] - 1) return null;
    return d;
  }

  function format(value) {
    var d = parse(value);
    if (!d) return '';
    return d.toLocaleDateString(undefined, {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC'
    });
  }

  function addDays(value, n) {
    var d = parse(value);
    if (!d) return null;
    d.setUTCDate(d.getUTCDate() + n);
    return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }

  // Calendar-month arithmetic, clamped to the end of a shorter month
  // (e.g. Aug 31 + 6 months = Feb 28/29).
  function addMonths(value, n) {
    var d = parse(value);
    if (!d) return null;
    var day = d.getUTCDate();
    var target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1, 12, 0, 0));
    var lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12, 0, 0)).getUTCDate();
    target.setUTCDate(Math.min(day, lastDay));
    return iso(target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate());
  }

  function daysBetween(a, b) {
    var da = parse(a), db = parse(b);
    if (!da || !db) return null;
    return Math.round((db - da) / 86400000);
  }

  function inclusiveDays(start, end) {
    var n = daysBetween(start, end);
    return n === null ? null : n + 1;
  }

  function isBefore(a, b) {
    var n = daysBetween(a, b);
    return n !== null && n > 0;
  }

  /* ============================== state ================================= */

  function emptyState() {
    return {
      version: 1,
      opt: { i94Expiration: '', programEnd: '', dsoRecommendation: '', filedDate: '', optStart: '', optEnd: '', unemploymentUsed: '' },
      stem: { i94Expiration: '', currentOptEnd: '', i983Signed: '', filedDate: '', stemStart: '', stemEnd: '', unemploymentUsed: '' },
      cpt: { rows: [] },
      settings: { clientId: '', driveFileId: '', icsSequence: 0, activeTab: 'opt' },
      updatedAt: ''
    };
  }

  var state = emptyState();

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      state = mergeState(parsed);
    } catch (err) {
      console.warn('Could not read saved data; starting fresh.', err);
    }
  }

  function mergeState(incoming) {
    var base = emptyState();
    if (!incoming || typeof incoming !== 'object') return base;
    ['opt', 'stem'].forEach(function (key) {
      if (incoming[key] && typeof incoming[key] === 'object') {
        Object.keys(base[key]).forEach(function (f) {
          if (typeof incoming[key][f] === 'string' || typeof incoming[key][f] === 'number') {
            base[key][f] = String(incoming[key][f]);
          }
        });
      }
    });
    if (incoming.cpt && Array.isArray(incoming.cpt.rows)) {
      base.cpt.rows = incoming.cpt.rows.map(function (r) {
        return {
          id: String(r && r.id || newId()),
          employer: String(r && r.employer || ''),
          start: String(r && r.start || ''),
          end: String(r && r.end || ''),
          type: r && r.type === 'part' ? 'part' : 'full'
        };
      });
    }
    if (incoming.settings && typeof incoming.settings === 'object') {
      base.settings.clientId = String(incoming.settings.clientId || '');
      base.settings.driveFileId = String(incoming.settings.driveFileId || '');
      base.settings.icsSequence = Number(incoming.settings.icsSequence) || 0;
      base.settings.activeTab = String(incoming.settings.activeTab || 'opt');
    }
    return base;
  }

  function saveState() {
    state.updatedAt = new Date().toISOString();
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      toast('Could not save locally — is storage full or blocked?');
      console.warn(err);
    }
  }

  function newId() {
    return 'c' + Math.random().toString(36).slice(2, 9);
  }

  /* ============================ rules engine ============================ */
  // Each rule set returns { items: [...deadlines], flags: [...], extra: {} }.
  // An item is { id, label, date, note }.

  function computeOpt(d) {
    var items = [], flags = [];
    var today = todayISO();

    if (d.i94Expiration) {
      items.push({
        id: 'opt-i94',
        label: 'I-94 expires (authorized stay ends)',
        date: d.i94Expiration,
        note: 'Fixed admission date under the Duration of Status final rule. Re-check at i94.cbp.dhs.gov after any travel or extension.'
      });
    }

    var earliestFile = null, latestFile = null;
    if (d.programEnd) {
      earliestFile = addDays(d.programEnd, -FILE_WINDOW_BEFORE);
      latestFile = addDays(d.programEnd, FILE_WINDOW_AFTER);
      items.push({
        id: 'opt-window-open',
        label: 'OPT application window opens',
        date: earliestFile,
        note: 'Earliest USCIS can receive your I-765: 90 days before your program end date.'
      });
      items.push({
        id: 'opt-program-end',
        label: 'Program end date (I-20)',
        date: d.programEnd,
        note: 'A 60-day grace period follows program completion if you do not have OPT pending or approved.'
      });
      items.push({
        id: 'opt-window-close',
        label: 'Last day for USCIS to receive your I-765',
        date: latestFile,
        note: '60 days after your program end date. This is a receipt deadline, not a postmark deadline — mail early.'
      });
      items.push({
        id: 'opt-grace-noopt',
        label: 'Grace period ends if you never file OPT',
        date: addDays(d.programEnd, 60),
        note: '60-day grace period after program completion to depart, transfer, or change status.'
      });
    }

    var dsoDeadline = null;
    if (d.dsoRecommendation) {
      dsoDeadline = addDays(d.dsoRecommendation, DSO_REC_WINDOW);
      items.push({
        id: 'opt-dso-30',
        label: 'I-765 must reach USCIS (30 days after DSO recommendation)',
        date: dsoDeadline,
        note: 'If USCIS receives the application more than 30 days after your DSO entered the recommendation in SEVIS, it will be denied.'
      });
    }

    // The binding filing deadline is whichever comes first.
    var bindingDeadline = latestFile;
    if (dsoDeadline && (!bindingDeadline || isBefore(dsoDeadline, bindingDeadline))) bindingDeadline = dsoDeadline;

    if (d.filedDate) {
      items.push({
        id: 'opt-filed',
        label: 'I-765 filed / receipt date',
        date: d.filedDate,
        note: 'Track the case at egov.uscis.gov. Report a change of address to USCIS and your DSO within 10 days.'
      });
    }

    var optEnd = d.optEnd;
    if (!optEnd && d.optStart) {
      optEnd = addDays(addMonths(d.optStart, OPT_MONTHS), -1);
    }

    if (d.optStart) {
      items.push({
        id: 'opt-start',
        label: 'OPT start date (EAD valid from)',
        date: d.optStart,
        note: 'Do not work a single day before this date. The 90-day unemployment clock starts here.'
      });
      items.push({
        id: 'opt-unemployment',
        label: '90 unemployment days used up (if unemployed the whole time)',
        date: addDays(d.optStart, OPT_UNEMPLOYMENT),
        note: 'Worst case only. Aggregate 90 days across the whole OPT period; report every employer to your DSO.'
      });
    }

    if (optEnd) {
      items.push({
        id: 'opt-end',
        label: 'OPT ends (EAD valid to)',
        date: optEnd,
        note: d.optEnd ? 'From your EAD card.' : 'Auto-calculated as 12 months from your start date. Use the date printed on your EAD once you have it.'
      });
      items.push({
        id: 'opt-grace',
        label: 'Grace period ends after OPT',
        date: addDays(optEnd, OPT_GRACE_DAYS),
        note: '30 days after post-completion OPT ends to depart, transfer your SEVIS record, or change status.'
      });
      if (d.programEnd || d.optStart) {
        items.push({
          id: 'opt-stem-window',
          label: 'STEM-OPT filing window opens (if you qualify)',
          date: addDays(optEnd, -STEM_FILE_WINDOW_BEFORE),
          note: 'A 24-month STEM extension can be filed up to 90 days before your OPT expires, and must be filed before it expires.'
        });
      }
    }

    /* ---- flags ---- */
    if (d.i94Expiration && bindingDeadline && isBefore(d.i94Expiration, bindingDeadline)) {
      flags.push({
        level: 'bad',
        title: 'Possible Form I-539 issue',
        body: 'Your I-94 expires ' + format(d.i94Expiration) + ', before your OPT filing deadline of ' +
          format(bindingDeadline) + '. You must be in valid status when USCIS receives the I-765, so you may need to ' +
          'extend your stay (Form I-539) or adjust your timeline first. Raise this with your DSO now.'
      });
    }
    if (d.i94Expiration && optEnd && isBefore(d.i94Expiration, optEnd)) {
      flags.push({
        level: 'warn',
        title: 'I-94 expires before your OPT does',
        body: 'Your authorized stay ends ' + format(d.i94Expiration) + ' but your OPT runs to ' + format(optEnd) +
          '. An EAD does not extend your admission period — ask your DSO how to align the two.'
      });
    }
    if (d.programEnd && earliestFile && isBefore(today, earliestFile)) {
      flags.push({
        level: 'info',
        title: 'Filing window not open yet',
        body: 'You can file starting ' + format(earliestFile) + ' — ' + Math.abs(daysBetween(today, earliestFile)) + ' days from today.'
      });
    }
    if (bindingDeadline && isBefore(bindingDeadline, today)) {
      flags.push({
        level: 'bad',
        title: 'Filing deadline has passed',
        body: 'The latest date in your filing window was ' + format(bindingDeadline) + '. Contact your DSO immediately.'
      });
    }
    var used = Number(d.unemploymentUsed);
    if (used > 0) {
      var left = OPT_UNEMPLOYMENT - used;
      flags.push({
        level: left <= 30 ? 'bad' : (left <= 60 ? 'warn' : 'info'),
        title: 'Unemployment: ' + used + ' of ' + OPT_UNEMPLOYMENT + ' days used',
        body: left > 0 ? left + ' days remaining before you fall out of status.' :
          'You have exceeded the 90-day limit on paper — talk to your DSO immediately.'
      });
    }

    return { items: items, flags: flags, computedEnd: optEnd };
  }

  function computeStem(d) {
    var items = [], flags = [];
    var today = todayISO();

    if (d.i94Expiration) {
      items.push({
        id: 'stem-i94',
        label: 'I-94 expires (authorized stay ends)',
        date: d.i94Expiration,
        note: 'Fixed admission date under the Duration of Status final rule. Verify at i94.cbp.dhs.gov.'
      });
    }

    if (d.currentOptEnd) {
      items.push({
        id: 'stem-window-open',
        label: 'STEM-OPT filing window opens',
        date: addDays(d.currentOptEnd, -STEM_FILE_WINDOW_BEFORE),
        note: 'Up to 90 days before your current OPT expires. Your DSO must recommend the extension in SEVIS first.'
      });
      items.push({
        id: 'stem-deadline',
        label: 'Last day to file the 24-month STEM extension',
        date: d.currentOptEnd,
        note: 'USCIS must receive the I-765 BEFORE your current OPT expires. Missing this ends your extension option entirely.'
      });
      items.push({
        id: 'stem-current-opt-end',
        label: 'Current OPT ends',
        date: d.currentOptEnd,
        note: 'If a STEM filing is pending on this date, you may keep working for up to 180 days while it is adjudicated.'
      });
    }

    if (d.i983Signed) {
      items.push({
        id: 'stem-i983',
        label: 'Form I-983 training plan signed',
        date: d.i983Signed,
        note: 'Keep a copy. Your employer must be enrolled in E-Verify and report material changes.'
      });
    }

    if (d.filedDate) {
      items.push({
        id: 'stem-filed',
        label: 'STEM I-765 filed / receipt date',
        date: d.filedDate,
        note: 'Track the case at egov.uscis.gov.'
      });
      if (d.currentOptEnd) {
        items.push({
          id: 'stem-180',
          label: 'Automatic 180-day work authorization ends',
          date: addDays(d.currentOptEnd, PENDING_STEM_DAYS),
          note: 'A timely-filed STEM extension keeps you working up to 180 days past your OPT end date while pending. Stop work if it is still pending after this date.'
        });
      }
    }

    var stemStart = d.stemStart || (d.currentOptEnd ? addDays(d.currentOptEnd, 1) : '');
    var stemEnd = d.stemEnd || (stemStart ? addDays(addMonths(stemStart, STEM_MONTHS), -1) : '');

    if (stemStart) {
      items.push({
        id: 'stem-start',
        label: 'STEM-OPT starts',
        date: stemStart,
        note: d.stemStart ? 'From your EAD card.' : 'Assumed to be the day after your current OPT ends.'
      });
      // Validation reports every 6 months; self-evaluations at 12 months and at the end.
      [6, 12, 18].forEach(function (m) {
        items.push({
          id: 'stem-report-' + m,
          label: m + '-month validation report due to your DSO',
          date: addMonths(stemStart, m),
          note: m === 12
            ? 'Also submit the 12-month self-evaluation section of your I-983, signed by you and your employer. Reports are due within 10 days of each 6-month period.'
            : 'Confirm your employment and personal details with your DSO within 10 days of this date.'
        });
      });
    }

    if (stemEnd) {
      items.push({
        id: 'stem-final-eval',
        label: 'Final I-983 self-evaluation due',
        date: stemEnd,
        note: 'The concluding self-evaluation must reach your DSO within 10 days of the end of your STEM-OPT period.'
      });
      items.push({
        id: 'stem-end',
        label: 'STEM-OPT ends',
        date: stemEnd,
        note: d.stemEnd ? 'From your EAD card.' : 'Auto-calculated as 24 months from your STEM start date.'
      });
      items.push({
        id: 'stem-grace',
        label: 'Grace period ends after STEM-OPT',
        date: addDays(stemEnd, STEM_GRACE_DAYS),
        note: '60 days after STEM-OPT ends to depart, transfer your SEVIS record, or change status.'
      });
    }

    /* ---- flags ---- */
    if (d.i94Expiration && d.currentOptEnd && isBefore(d.i94Expiration, d.currentOptEnd)) {
      flags.push({
        level: 'bad',
        title: 'Possible Form I-539 issue',
        body: 'Your I-94 expires ' + format(d.i94Expiration) + ', before the STEM filing deadline of ' +
          format(d.currentOptEnd) + '. You must be in valid F-1 status when USCIS receives the application — ask your ' +
          'DSO whether you need Form I-539 or a different plan.'
      });
    }
    if (d.i94Expiration && stemEnd && isBefore(d.i94Expiration, stemEnd)) {
      flags.push({
        level: 'warn',
        title: 'I-94 expires before your STEM-OPT would end',
        body: 'Authorized stay ends ' + format(d.i94Expiration) + '; STEM-OPT would run to ' + format(stemEnd) + '.'
      });
    }
    if (d.currentOptEnd && isBefore(d.currentOptEnd, today) && !d.filedDate) {
      flags.push({
        level: 'bad',
        title: 'Your OPT end date has passed with no filing recorded',
        body: 'A STEM extension cannot be filed after your OPT expires. Contact your DSO.'
      });
    }
    if (!d.i983Signed && d.currentOptEnd) {
      flags.push({
        level: 'info',
        title: 'Form I-983 required before filing',
        body: 'Your employer must be enrolled in E-Verify and must sign the I-983 training plan; your DSO then recommends the extension in SEVIS.'
      });
    }
    var used = Number(d.unemploymentUsed);
    if (used > 0) {
      var left = STEM_UNEMPLOYMENT - used;
      flags.push({
        level: left <= 30 ? 'bad' : (left <= 60 ? 'warn' : 'info'),
        title: 'Unemployment: ' + used + ' of ' + STEM_UNEMPLOYMENT + ' days used',
        body: left > 0 ? left + ' aggregate days remaining across OPT and STEM-OPT.' :
          'You have exceeded the 150-day aggregate limit on paper — talk to your DSO immediately.'
      });
    }

    return { items: items, flags: flags };
  }

  function computeCpt(rows) {
    var items = [], flags = [];
    var today = todayISO();
    var fullDays = 0, partDays = 0, invalid = 0;

    rows.forEach(function (row, index) {
      var name = row.employer ? row.employer : 'CPT #' + (index + 1);
      if (row.start && row.end) {
        var days = inclusiveDays(row.start, row.end);
        if (days === null || days <= 0) {
          invalid++;
        } else if (row.type === 'full') {
          fullDays += days;
        } else {
          partDays += days;
        }
      }
      if (row.start) {
        items.push({
          id: 'cpt-start-' + row.id,
          label: name + ' — CPT starts',
          date: row.start,
          note: 'Your I-20 must show this CPT authorization BEFORE this date. Working one day early is unauthorized employment.'
        });
        var authBy = addDays(row.start, -7);
        if (authBy && isBefore(today, row.start)) {
          items.push({
            id: 'cpt-auth-' + row.id,
            label: name + ' — confirm CPT is on your I-20',
            date: authBy,
            note: 'Check in with your DSO a week ahead so the authorized I-20 is in hand before day one.'
          });
        }
      }
      if (row.end) {
        items.push({
          id: 'cpt-end-' + row.id,
          label: name + ' — CPT ends',
          date: row.end,
          note: 'Employment authorization stops on this date. A new period needs a new I-20 authorization.'
        });
      }
    });

    if (invalid) {
      flags.push({
        level: 'warn',
        title: invalid + ' authorization' + (invalid > 1 ? 's have' : ' has') + ' an end date before the start date',
        body: 'Those rows are not counted in the totals below.'
      });
    }

    if (fullDays >= CPT_FULLTIME_CAP) {
      flags.push({
        level: 'bad',
        title: 'OPT eligibility likely lost at this degree level',
        body: fullDays + ' days of full-time CPT is at or beyond the 365-day cap. Twelve months or more of full-time CPT ' +
          'eliminates OPT eligibility at that degree level. Confirm the exact count with your DSO before making plans.'
      });
    } else if (fullDays >= 300) {
      flags.push({
        level: 'warn',
        title: 'Approaching the 365-day full-time CPT cap',
        body: (CPT_FULLTIME_CAP - fullDays) + ' days of full-time CPT remain before you would lose OPT eligibility.'
      });
    }

    if (partDays > 0) {
      flags.push({
        level: 'info',
        title: partDays + ' days of part-time CPT recorded',
        body: 'Part-time CPT (20 hours per week or less) does not count toward the 365-day cap, but it must still be ' +
          'authorized on your I-20 and you must remain a full-time student.'
      });
    }

    return { items: items, flags: flags, fullDays: fullDays, partDays: partDays };
  }

  function computeAll() {
    return {
      opt: computeOpt(state.opt),
      stem: computeStem(state.stem),
      cpt: computeCpt(state.cpt.rows)
    };
  }

  /* ============================== render =============================== */

  function statusOf(dateStr) {
    var diff = daysBetween(todayISO(), dateStr);
    if (diff === null) return { key: 'upcoming', label: '', diff: null };
    if (diff < 0) return { key: 'passed', label: 'Passed ' + Math.abs(diff) + 'd ago', diff: diff };
    if (diff === 0) return { key: 'soon', label: 'Today', diff: 0 };
    if (diff <= SOON_DAYS) return { key: 'soon', label: 'In ' + diff + ' day' + (diff === 1 ? '' : 's'), diff: diff };
    return { key: 'upcoming', label: 'In ' + diff + ' days', diff: diff };
  }

  function sortItems(items) {
    return items.filter(function (i) { return !!i.date; })
      .sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
  }

  function renderPanel(key, result) {
    var root = document.getElementById('results-' + key);
    var list = root.querySelector('[data-timeline]');
    var flagBox = root.querySelector('[data-flags]');
    var empty = root.querySelector('[data-empty]');
    var items = sortItems(result.items);

    list.textContent = '';
    flagBox.textContent = '';
    empty.hidden = items.length > 0;

    result.flags.forEach(function (flag) {
      var div = document.createElement('div');
      div.className = 'flag flag-' + flag.level;
      var strong = document.createElement('strong');
      strong.textContent = flag.title;
      div.appendChild(strong);
      div.appendChild(document.createTextNode(flag.body));
      flagBox.appendChild(div);
    });

    items.forEach(function (item) {
      var status = statusOf(item.date);
      var li = document.createElement('li');

      var main = document.createElement('div');
      main.className = 'tl-main';

      var label = document.createElement('div');
      label.className = 'tl-label';
      label.textContent = item.label;

      var date = document.createElement('div');
      date.className = 'tl-date';
      date.textContent = format(item.date);

      main.appendChild(label);
      main.appendChild(date);

      if (item.note) {
        var note = document.createElement('div');
        note.className = 'tl-note';
        note.textContent = item.note;
        main.appendChild(note);
      }

      var pill = document.createElement('span');
      pill.className = 'pill pill-' + status.key;
      pill.textContent = status.label;

      li.appendChild(main);
      li.appendChild(pill);
      list.appendChild(li);
    });
  }

  function renderCptMeter(result) {
    var box = document.getElementById('cptMeter');
    var fill = document.getElementById('cptMeterFill');
    var label = document.getElementById('cptDaysLabel');
    var note = document.getElementById('cptMeterNote');
    box.hidden = state.cpt.rows.length === 0;
    var pct = Math.min(100, Math.round((result.fullDays / CPT_FULLTIME_CAP) * 100));
    fill.style.width = pct + '%';
    fill.className = 'meter-fill' + (result.fullDays >= CPT_FULLTIME_CAP ? ' is-bad' : (result.fullDays >= 300 ? ' is-warn' : ''));
    label.textContent = result.fullDays + ' / ' + CPT_FULLTIME_CAP + ' days';
    note.textContent = result.fullDays >= CPT_FULLTIME_CAP
      ? 'At or over the cap — OPT eligibility at this degree level is likely gone.'
      : (CPT_FULLTIME_CAP - result.fullDays) + ' days of full-time CPT remain before the cap.';
  }

  function render() {
    var all = computeAll();
    renderPanel('opt', all.opt);
    renderPanel('stem', all.stem);
    renderPanel('cpt', all.cpt);
    renderCptMeter(all.cpt);
    return all;
  }

  /* ============================ forms / tabs =========================== */

  function bindForm(key) {
    var form = document.getElementById('form-' + key);
    if (!form) return;
    Object.keys(state[key]).forEach(function (field) {
      var input = form.elements[field];
      if (input) input.value = state[key][field];
    });
    form.addEventListener('input', function (event) {
      var name = event.target.name;
      if (!name || !(name in state[key])) return;
      state[key][name] = event.target.value;
      saveState();
      render();
    });
  }

  function bindTabs() {
    var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
    function activate(name) {
      tabs.forEach(function (tab) {
        var on = tab.dataset.panel === name;
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
        document.getElementById('panel-' + tab.dataset.panel).hidden = !on;
      });
      state.settings.activeTab = name;
      saveState();
    }
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () { activate(tab.dataset.panel); });
      tab.addEventListener('keydown', function (event) {
        var i = tabs.indexOf(tab);
        if (event.key === 'ArrowRight') { tabs[(i + 1) % tabs.length].focus(); tabs[(i + 1) % tabs.length].click(); }
        if (event.key === 'ArrowLeft') { tabs[(i - 1 + tabs.length) % tabs.length].focus(); tabs[(i - 1 + tabs.length) % tabs.length].click(); }
      });
    });
    activate(state.settings.activeTab || 'opt');
  }

  /* ---------------------------- CPT rows ------------------------------ */

  function renderCptRows() {
    var list = document.getElementById('cptList');
    list.textContent = '';
    state.cpt.rows.forEach(function (row) {
      list.appendChild(cptRowNode(row));
    });
  }

  function cptRowNode(row) {
    var wrap = document.createElement('div');
    wrap.className = 'cpt-row';
    wrap.dataset.id = row.id;

    wrap.appendChild(labelled('Employer / course', inputEl('text', 'employer', row.employer, 'e.g. Acme Inc.')));
    wrap.appendChild(labelled('Start date', inputEl('date', 'start', row.start)));
    wrap.appendChild(labelled('End date', inputEl('date', 'end', row.end)));

    var select = document.createElement('select');
    select.dataset.field = 'type';
    [['full', 'Full-time (>20 hrs)'], ['part', 'Part-time (<=20 hrs)']].forEach(function (opt) {
      var o = document.createElement('option');
      o.value = opt[0];
      o.textContent = opt[1];
      if (row.type === opt[0]) o.selected = true;
      select.appendChild(o);
    });
    wrap.appendChild(labelled('Hours', select));

    var remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'cpt-remove';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', 'Remove this CPT authorization');
    remove.addEventListener('click', function () {
      state.cpt.rows = state.cpt.rows.filter(function (r) { return r.id !== row.id; });
      saveState();
      renderCptRows();
      render();
    });
    wrap.appendChild(remove);

    wrap.addEventListener('input', function (event) {
      var field = event.target.dataset.field;
      if (!field) return;
      row[field] = event.target.value;
      saveState();
      render();
    });
    wrap.addEventListener('change', function (event) {
      var field = event.target.dataset.field;
      if (field === 'type') {
        row.type = event.target.value;
        saveState();
        render();
      }
    });

    return wrap;
  }

  function labelled(text, control) {
    var label = document.createElement('label');
    label.appendChild(document.createTextNode(text));
    label.appendChild(control);
    return label;
  }

  function inputEl(type, field, value, placeholder) {
    var input = document.createElement('input');
    input.type = type;
    input.dataset.field = field;
    input.value = value || '';
    if (placeholder) input.placeholder = placeholder;
    return input;
  }

  /* ========================== ICS generation =========================== */

  function icsEscape(text) {
    return String(text)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r?\n/g, '\\n');
  }

  var encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

  // RFC 5545 says lines are folded at 75 octets; fold on a byte count, not chars.
  function fold(line) {
    var out = '', count = 0, chars = Array.from(line);
    for (var i = 0; i < chars.length; i++) {
      var size = encoder ? encoder.encode(chars[i]).length : 1;
      if (count + size > 73) {
        out += '\r\n ';
        count = 1;
      }
      out += chars[i];
      count += size;
    }
    return out;
  }

  function icsStamp(date) {
    return date.getUTCFullYear() + pad(date.getUTCMonth() + 1) + pad(date.getUTCDate()) + 'T' +
      pad(date.getUTCHours()) + pad(date.getUTCMinutes()) + pad(date.getUTCSeconds()) + 'Z';
  }

  function icsDate(value) { return value.replace(/-/g, ''); }

  function buildIcs(events, calendarName) {
    state.settings.icsSequence = (Number(state.settings.icsSequence) || 0) + 1;
    saveState();

    var stamp = icsStamp(new Date());
    var lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//OPT Tracker//Offline F-1 deadline tracker//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:' + icsEscape(calendarName),
      'X-WR-TIMEZONE:UTC'
    ];

    events.forEach(function (event) {
      var description = (event.note || '') +
        '\n\nGenerated by OPT Tracker, which runs entirely in your browser. Not legal advice — confirm every date with your DSO.';
      lines.push(
        'BEGIN:VEVENT',
        'UID:' + event.id + '@opt-tracker.local',
        'DTSTAMP:' + stamp,
        'SEQUENCE:' + state.settings.icsSequence,
        'DTSTART;VALUE=DATE:' + icsDate(event.date),
        'DTEND;VALUE=DATE:' + icsDate(addDays(event.date, 1)),
        'SUMMARY:' + icsEscape(event.label),
        'DESCRIPTION:' + icsEscape(description),
        'CATEGORIES:' + icsEscape(event.category || 'F-1 deadline'),
        'TRANSP:TRANSPARENT',
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        'TRIGGER;RELATED=START:-P14D',
        'DESCRIPTION:' + icsEscape('In 14 days: ' + event.label),
        'END:VALARM',
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        'TRIGGER;RELATED=START:PT9H',
        'DESCRIPTION:' + icsEscape('Today: ' + event.label),
        'END:VALARM',
        'END:VEVENT'
      );
    });

    lines.push('END:VCALENDAR');
    return lines.map(fold).join('\r\n') + '\r\n';
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  var CATEGORY = { opt: 'OPT', stem: 'STEM-OPT', cpt: 'CPT' };

  function exportIcs(keys, filename, calendarName) {
    var all = computeAll();
    var events = [];
    keys.forEach(function (key) {
      sortItems(all[key].items).forEach(function (item) {
        events.push({
          id: item.id,
          date: item.date,
          label: CATEGORY[key] + ': ' + item.label,
          note: item.note,
          category: CATEGORY[key]
        });
      });
    });
    if (!events.length) {
      toast('Nothing to export yet — enter some dates first.');
      return;
    }
    download(filename, buildIcs(events, calendarName), 'text/calendar;charset=utf-8');
    toast(events.length + ' reminders exported. Import the file into your calendar app.');
  }

  /* ======================== local backup / restore ====================== */

  function exportJson() {
    download('opt-tracker-backup.json', JSON.stringify(state, null, 2), 'application/json');
    toast('Backup downloaded.');
  }

  function importJsonFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        applyRestored(JSON.parse(String(reader.result)));
        toast('Backup restored.');
      } catch (err) {
        toast('That file could not be read as an OPT Tracker backup.');
        console.warn(err);
      }
    };
    reader.readAsText(file);
  }

  function applyRestored(data) {
    var clientId = state.settings.clientId;
    var driveFileId = state.settings.driveFileId;
    state = mergeState(data);
    // Never let a restored file silently change this device's Drive settings.
    state.settings.clientId = clientId || state.settings.clientId;
    state.settings.driveFileId = driveFileId || state.settings.driveFileId;
    saveState();
    refreshFormsFromState();
    render();
  }

  function refreshFormsFromState() {
    ['opt', 'stem'].forEach(function (key) {
      var form = document.getElementById('form-' + key);
      Object.keys(state[key]).forEach(function (field) {
        var input = form.elements[field];
        if (input) input.value = state[key][field];
      });
    });
    renderCptRows();
    document.getElementById('clientId').value = state.settings.clientId;
  }

  /* ====================== optional Google Drive ========================= */
  /* Browser -> Google directly. Nothing passes through any server we run.  */

  var DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
  var BACKUP_NAME = 'opt-tracker-backup.json';
  var accessToken = null;   // kept in memory only, never persisted
  var tokenClient = null;

  function driveStatus(text) {
    document.getElementById('driveStatus').textContent = text || '';
  }

  function loadGis() {
    return new Promise(function (resolve, reject) {
      if (window.google && window.google.accounts && window.google.accounts.oauth2) return resolve();
      var script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.onload = function () { resolve(); };
      script.onerror = function () { reject(new Error('Could not load Google Identity Services (are you offline?)')); };
      document.head.appendChild(script);
    });
  }

  function currentClientId() {
    return (state.settings.clientId || (window.OPT_TRACKER_CONFIG && window.OPT_TRACKER_CONFIG.googleClientId) || '').trim();
  }

  function getToken() {
    var clientId = currentClientId();
    if (!clientId) {
      return Promise.reject(new Error('Add a Google OAuth Client ID first — see the README.'));
    }
    if (accessToken) return Promise.resolve(accessToken);
    return loadGis().then(function () {
      return new Promise(function (resolve, reject) {
        tokenClient = window.google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: DRIVE_SCOPE,
          callback: function (response) {
            if (response && response.access_token) {
              accessToken = response.access_token;
              resolve(accessToken);
            } else {
              reject(new Error('Sign-in was cancelled or denied.'));
            }
          },
          error_callback: function (err) {
            reject(new Error((err && err.message) || 'Google sign-in failed.'));
          }
        });
        tokenClient.requestAccessToken({ prompt: '' });
      });
    });
  }

  function driveFetch(url, options) {
    options = options || {};
    options.headers = Object.assign({ Authorization: 'Bearer ' + accessToken }, options.headers || {});
    return fetch(url, options).then(function (response) {
      if (response.status === 401) {
        accessToken = null;
        throw new Error('Google session expired — try again to sign in.');
      }
      if (!response.ok) {
        return response.text().then(function (body) {
          throw new Error('Google Drive error ' + response.status + ': ' + body.slice(0, 200));
        });
      }
      return response;
    });
  }

  function multipartBody(metadata, content, boundary) {
    return '--' + boundary + '\r\n' +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) + '\r\n' +
      '--' + boundary + '\r\n' +
      'Content-Type: application/json\r\n\r\n' +
      content + '\r\n' +
      '--' + boundary + '--';
  }

  function driveBackup() {
    var button = document.getElementById('driveBackup');
    button.disabled = true;
    driveStatus('Signing in with Google…');
    getToken()
      .then(function () {
        driveStatus('Uploading backup…');
        var boundary = 'optTracker' + Date.now();
        var metadata = { name: BACKUP_NAME, mimeType: 'application/json' };
        var existing = state.settings.driveFileId;
        var url = 'https://www.googleapis.com/upload/drive/v3/files' +
          (existing ? '/' + encodeURIComponent(existing) : '') + '?uploadType=multipart&fields=id,name,modifiedTime';
        return driveFetch(url, {
          method: existing ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
          body: multipartBody(metadata, JSON.stringify(state, null, 2), boundary)
        });
      })
      .then(function (response) { return response.json(); })
      .then(function (file) {
        state.settings.driveFileId = file.id;
        saveState();
        driveStatus('Saved to your Drive as ' + file.name + ' at ' + new Date().toLocaleString() + '.');
        toast('Backup saved to your Google Drive.');
      })
      .catch(function (err) {
        // If the stored file was deleted in Drive, forget it so the next run creates a fresh one.
        if (/404/.test(err.message)) state.settings.driveFileId = '';
        driveStatus(err.message);
      })
      .then(function () { button.disabled = false; });
  }

  function driveRestore() {
    if (!confirm('Restoring replaces the data currently in this browser. Continue?')) return;
    var button = document.getElementById('driveRestore');
    button.disabled = true;
    driveStatus('Signing in with Google…');
    getToken()
      .then(function () {
        driveStatus('Looking for your backup…');
        var query = encodeURIComponent("name='" + BACKUP_NAME + "' and trashed=false");
        return driveFetch('https://www.googleapis.com/drive/v3/files?q=' + query +
          '&orderBy=modifiedTime desc&pageSize=1&fields=files(id,name,modifiedTime)');
      })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        if (!data.files || !data.files.length) throw new Error('No backup found in your Drive yet.');
        var file = data.files[0];
        state.settings.driveFileId = file.id;
        return driveFetch('https://www.googleapis.com/drive/v3/files/' + file.id + '?alt=media')
          .then(function (response) { return response.json(); })
          .then(function (payload) {
            applyRestored(payload);
            driveStatus('Restored the backup last modified ' + new Date(file.modifiedTime).toLocaleString() + '.');
            toast('Restored from Google Drive.');
          });
      })
      .catch(function (err) { driveStatus(err.message); })
      .then(function () { button.disabled = false; });
  }

  function driveSignOut() {
    if (accessToken && window.google && window.google.accounts && window.google.accounts.oauth2) {
      window.google.accounts.oauth2.revoke(accessToken, function () {});
    }
    accessToken = null;
    driveStatus('Signed out of Google on this device.');
  }

  /* ============================== misc UI ============================== */

  var toastTimer = null;
  function toast(message) {
    if (typeof document === 'undefined') return;
    var el = document.getElementById('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 4200);
  }

  function bindActions() {
    document.querySelectorAll('[data-ics]').forEach(function (button) {
      button.addEventListener('click', function () {
        var key = button.dataset.ics;
        exportIcs([key], 'opt-tracker-' + key + '.ics', CATEGORY[key] + ' deadlines');
      });
    });

    document.querySelectorAll('[data-clear]').forEach(function (button) {
      button.addEventListener('click', function () {
        var key = button.dataset.clear;
        if (!confirm('Clear everything on the ' + CATEGORY[key] + ' tab?')) return;
        if (key === 'cpt') {
          state.cpt.rows = [];
          renderCptRows();
        } else {
          var fresh = emptyState()[key];
          Object.keys(fresh).forEach(function (f) { state[key][f] = fresh[f]; });
          refreshFormsFromState();
        }
        saveState();
        render();
        toast(CATEGORY[key] + ' tab cleared.');
      });
    });

    document.getElementById('addCpt').addEventListener('click', function () {
      state.cpt.rows.push({ id: newId(), employer: '', start: '', end: '', type: 'full' });
      saveState();
      renderCptRows();
      render();
    });

    document.getElementById('exportAllIcs').addEventListener('click', function () {
      exportIcs(['opt', 'stem', 'cpt'], 'opt-tracker-all-deadlines.ics', 'F-1 deadlines');
    });
    document.getElementById('exportJson').addEventListener('click', exportJson);
    document.getElementById('importJsonBtn').addEventListener('click', function () {
      document.getElementById('importJson').click();
    });
    document.getElementById('importJson').addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      if (file) importJsonFile(file);
      event.target.value = '';
    });

    document.getElementById('wipeAll').addEventListener('click', function () {
      if (!confirm('Erase all OPT Tracker data stored in this browser? This cannot be undone.')) return;
      localStorage.removeItem(STORAGE_KEY);
      state = emptyState();
      refreshFormsFromState();
      render();
      toast('All local data erased.');
    });

    var clientIdInput = document.getElementById('clientId');
    clientIdInput.value = state.settings.clientId;
    clientIdInput.addEventListener('input', function () {
      state.settings.clientId = clientIdInput.value.trim();
      accessToken = null;
      saveState();
    });
    document.getElementById('driveBackup').addEventListener('click', driveBackup);
    document.getElementById('driveRestore').addEventListener('click', driveRestore);
    document.getElementById('driveSignOut').addEventListener('click', driveSignOut);
  }

  function bindInstallPrompt() {
    var deferred = null;
    var button = document.getElementById('installBtn');
    window.addEventListener('beforeinstallprompt', function (event) {
      event.preventDefault();
      deferred = event;
      button.hidden = false;
    });
    button.addEventListener('click', function () {
      if (!deferred) return;
      deferred.prompt();
      deferred = null;
      button.hidden = true;
    });
    window.addEventListener('appinstalled', function () { button.hidden = true; });
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
      document.getElementById('swStatus').textContent = 'Offline mode unavailable in this browser';
      return;
    }
    navigator.serviceWorker.register('sw.js').then(function () {
      document.getElementById('swStatus').textContent = 'Offline-ready — works with no connection';
    }).catch(function (err) {
      document.getElementById('swStatus').textContent = 'Offline mode unavailable';
      console.warn(err);
    });
  }

  /* ================================ init =============================== */

  function init() {
    loadState();
    bindForm('opt');
    bindForm('stem');
    renderCptRows();
    bindTabs();
    bindActions();
    bindInstallPrompt();
    render();
    if (!state.settings.clientId && window.OPT_TRACKER_CONFIG && window.OPT_TRACKER_CONFIG.googleClientId) {
      driveStatus('Using the Client ID bundled with this deployment.');
    }
    registerServiceWorker();
    // Recompute "days from today" labels if the tab is left open past midnight.
    setInterval(render, 60 * 60 * 1000);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  // Exposed only for the Node test harness in tests/rules.test.js; unused in the browser.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      addDays: addDays, addMonths: addMonths, inclusiveDays: inclusiveDays,
      computeOpt: computeOpt, computeStem: computeStem, computeCpt: computeCpt,
      buildIcs: buildIcs, statusOf: statusOf, sortItems: sortItems
    };
  }
})();

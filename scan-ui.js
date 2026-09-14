/*
 * "Fill from a document": reads an I-94 printout or I-797C receipt notice on this device
 * and makes the user confirm each date before anything goes into the form.
 *
 * Privacy: the OCR engine (Tesseract.js) and the PDF reader (pdf.js) are served from this
 * site's own vendor/ folder and run inside the browser. The chosen file is only read
 * locally, and its pixels are dropped when the dialog closes. No request leaves this origin.
 */
(function () {
  'use strict';

  if (typeof window === 'undefined' || !window.OPTScan) return;
  var Scan = window.OPTScan;

  var SCRIPT_URL = (document.currentScript && document.currentScript.src) || document.baseURI;
  var VENDOR = new URL('vendor/', SCRIPT_URL).href;
  var MAX_EDGE = 4096;
  var MAX_PIXELS = 16000000;   // iOS Safari refuses canvases above ~16.7 MP
  var PDF_MAX_PAGES = 3;
  var PDF_MAX_PIXELS = 12000000;

  var TAB_NAME = { opt: 'OPT', stem: 'STEM-OPT' };
  var TARGET_LABEL = { i94Expiration: 'I-94 expiration date', filedDate: 'I-765 filed / receipt date' };

  var ISSUE_TEXT = {
    'fixed-characters': 'Some characters looked like letters and were read as numbers.',
    'fuzzy-month': 'The month name was partly unclear.',
    'ambiguous': 'The month could be read more than one way.',
    'low-confidence': 'The text was hard to read.',
    'unreadable': 'The date next to the label could not be read.',
    'reads-disagree': 'Two separate readings gave different dates.',
    'resolved-by-second-read': 'The first reading was unclear; a second reading picked this date.',
    'second-read-only': 'Only the second reading found a date.',
    'second-read-failed': 'A second reading could not confirm this date.',
    'before-entry': 'This is not after your most recent date of entry, which is unusual.',
    'in-past': 'This date has already passed. Make sure this is your most recent I-94.',
    'after-notice': 'This is later than the notice date on the same receipt, which is unusual.',
    'future': 'This date is in the future, which is unusual for a received date.',
    'case-type-unknown': 'The case type could not be read. Make sure this receipt is for your I-765.'
  };

  var ERROR_TEXT = {
    load: 'The document reader could not be loaded. If you are offline, connect to the internet once so it can be saved on this device, then try again.',
    image: 'This image could not be opened. Try a JPEG or PNG, for example a screenshot of the document.',
    password: 'This PDF is password-protected. Save or print an unprotected copy and try that instead.',
    pdf: 'This PDF could not be opened. Try a photo or screenshot of the page instead.'
  };

  function fail(code, cause) {
    var err = new Error(code);
    err.code = code;
    err.cause = cause;
    return err;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* ============================== engines ============================== */

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (window.Tesseract) return resolve();
      var script = document.createElement('script');
      script.src = src;
      script.onload = function () { resolve(); };
      script.onerror = function () { script.remove(); reject(fail('load')); };
      document.head.appendChild(script);
    });
  }

  function toCanvas(img) {
    var canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    canvas.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
    return canvas;
  }

  function toPngBlob(img) {
    return new Promise(function (resolve, reject) {
      var canvas = toCanvas(img);
      canvas.toBlob(function (blob) {
        canvas.width = canvas.height = 0;
        if (blob) resolve(blob);
        else reject(new Error('Could not encode the image.'));
      }, 'image/png');
    });
  }

  function createEngine(onProgress) {
    onProgress = onProgress || function () {};
    return loadScript(VENDOR + 'tesseract/tesseract.min.js')
      .then(function () {
        return window.Tesseract.createWorker('eng', 1, {
          workerPath: VENDOR + 'tesseract/worker.min.js',
          corePath: VENDOR + 'tesseract/core',
          langPath: VENDOR + 'tesseract/lang',
          workerBlobURL: false,
          cacheMethod: 'none',
          logger: function (m) {
            if (m && typeof m.progress === 'number' && /load|initiali/i.test(m.status || '')) {
              onProgress({ step: 'load', progress: m.progress });
            }
          }
        });
      })
      .catch(function (err) { throw err && err.code ? err : fail('load', err); })
      .then(function (worker) {
        var encoded = new WeakMap();
        return {
          terminate: function () { return worker.terminate(); },
          recognize: function (img, opts) {
            var png = encoded.get(img);
            if (!png) {
              png = toPngBlob(img);
              encoded.set(img, png);
            }
            return png.then(function (blob) {
              var params = { tessedit_pageseg_mode: String(opts.psm || 3), user_defined_dpi: '300' };
              if (opts.thresholding === 'sauvola') params.thresholding_method = '2';
              if (opts.rotateAuto) params.rotateAuto = true;
              if (opts.rectangle) params.rectangle = opts.rectangle;
              return worker.recognize(blob, params, { blocks: true });
            }).then(function (res) {
              return { words: Scan.wordsFromBlocks(res.data.blocks), rotateRadians: res.data.rotateRadians };
            });
          }
        };
      });
  }

  /* ============================== files ============================== */

  function decodeImage(file) {
    function draw(source, width, height) {
      var scale = Math.min(1, MAX_EDGE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)));
      var w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
      var canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(source, 0, 0, w, h);
      var pixels = ctx.getImageData(0, 0, w, h);
      canvas.width = canvas.height = 0;
      return { data: pixels.data, width: w, height: h };
    }

    function viaElement() {
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () {
          try { resolve(draw(img, img.naturalWidth, img.naturalHeight)); }
          catch (err) { reject(fail('image', err)); }
          finally { URL.revokeObjectURL(url); }
        };
        img.onerror = function () {
          URL.revokeObjectURL(url);
          reject(fail('image'));
        };
        img.src = url;
      });
    }

    if (!window.createImageBitmap) return viaElement();
    var bitmap;
    try {
      bitmap = createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (err) {
      return viaElement();
    }
    return bitmap.then(function (bmp) {
      try { return draw(bmp, bmp.width, bmp.height); }
      finally { if (bmp.close) bmp.close(); }
    }, viaElement);
  }

  var pdfjsLoading = null;

  function loadPdfjs() {
    if (!pdfjsLoading) {
      pdfjsLoading = import(VENDOR + 'pdfjs/pdf.min.mjs').then(function (pdfjs) {
        pdfjs.GlobalWorkerOptions.workerSrc = VENDOR + 'pdfjs/pdf.worker.min.mjs';
        return pdfjs;
      }, function (err) {
        pdfjsLoading = null;
        throw fail('load', err);
      });
    }
    return pdfjsLoading;
  }

  async function renderPdfPage(doc, number) {
    var page = await doc.getPage(number);
    try {
      var unit = page.getViewport({ scale: 1 });
      var scale = clamp(2400 / Math.max(unit.width, unit.height * 0.773), 1, 4);
      scale = Math.min(scale, Math.sqrt(PDF_MAX_PIXELS / (unit.width * unit.height)));
      var viewport = page.getViewport({ scale: scale });
      var canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      // "print" rendering does not wait for animation frames, which browsers pause while the
      // page is in the background (for example if the user switches apps mid-scan).
      await page.render({ canvasContext: ctx, viewport: viewport, intent: 'print', background: 'rgb(255,255,255)' }).promise;
      var pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      canvas.width = canvas.height = 0;
      var text = await page.getTextContent();
      return {
        image: { data: pixels.data, width: pixels.width, height: pixels.height },
        words: Scan.wordsFromPdfItems(text.items, viewport.transform)
      };
    } finally {
      page.cleanup();
    }
  }

  function isPdf(file) {
    return file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
  }

  async function scanFile(file, engine, options) {
    options = options || {};
    var progress = options.onProgress || function () {};
    if (!isPdf(file)) {
      progress({ step: 'open' });
      return Scan.readImage(await decodeImage(file), engine, options);
    }

    var pdfjs = await loadPdfjs();
    var task = pdfjs.getDocument({
      data: new Uint8Array(await file.arrayBuffer()),
      wasmUrl: VENDOR + 'pdfjs/wasm/',
      isEvalSupported: false,
      enableXfa: false,
      useSystemFonts: true
    });
    try {
      var doc;
      try {
        doc = await task.promise;
      } catch (err) {
        throw fail(err && err.name === 'PasswordException' ? 'password' : 'pdf', err);
      }
      var first = null;
      var pages = Math.min(doc.numPages, PDF_MAX_PAGES);
      for (var n = 1; n <= pages; n++) {
        progress({ step: 'pdf', page: n, pages: pages });
        var result = await Scan.readPdfPage(await renderPdfPage(doc, n), engine, options);
        if (result.doc) return result;
        if (!first) first = result;
        else result.image = null;
      }
      return first;
    } finally {
      task.destroy().catch(function () {});
    }
  }

  window.OPTScanBrowser = { createEngine: createEngine, decodeImage: decodeImage, scanFile: scanFile };

  /* ============================== dialog ============================== */

  var dialog, els, session = null;

  var STEPS = {
    open: ['Opening the file…', 0.32],
    prepare: ['Preparing the image…', 0.36],
    read: ['Reading the page… this can take a few seconds.', 0.45],
    rotate: ['The page may be sideways. Trying another orientation…', 0.6],
    clean: ['Cleaning up the image and reading it again…', 0.7],
    text: ['Reading the PDF text…', 0.5],
    verify: ['Double-checking the date with a second reading…', 0.85]
  };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function formatDate(iso) {
    return new Date(iso + 'T12:00:00Z').toLocaleDateString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'
    });
  }

  function showProgress(text, fraction) {
    els.progress.hidden = false;
    els.result.hidden = true;
    els.actions.hidden = true;
    els.title.textContent = 'Reading your document';
    els.step.textContent = text;
    els.bar.style.width = Math.round(clamp(fraction, 0, 1) * 100) + '%';
  }

  function stepProgress(p) {
    if (p.step === 'pdf') {
      showProgress('Opening page ' + p.page + ' of the PDF…', 0.34);
      return;
    }
    var step = STEPS[p.step];
    if (step) showProgress(step[0], step[1]);
  }

  function openDialog() {
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function releaseEngine(s) {
    if (s.engine) {
      var engine = s.engine;
      s.engine = null;
      engine.terminate().catch(function () {});
    }
  }

  function closeDialog() {
    var s = session;
    session = null;
    if (s) {
      s.cancelled = true;
      releaseEngine(s);
      if (s.result) s.result.image = null;
      s.result = null;
      s.entries = [];
    }
    if (els) els.result.textContent = '';
    if (dialog) {
      if (typeof dialog.close === 'function' && dialog.open) dialog.close();
      else dialog.removeAttribute('open');
    }
  }

  function start(tab, file) {
    closeDialog();
    var s = { tab: tab, engine: null, cancelled: false, result: null, entries: [] };
    session = s;
    showProgress('Starting…', 0.02);
    openDialog();

    createEngine(function (p) {
      if (session === s) showProgress('Loading the document reader…', 0.05 + 0.25 * (p.progress || 0));
    }).then(function (engine) {
      if (s.cancelled) {
        engine.terminate().catch(function () {});
        return null;
      }
      s.engine = engine;
      return scanFile(file, engine, {
        onProgress: function (p) { if (session === s) stepProgress(p); }
      });
    }).then(function (result) {
      if (!result || s.cancelled) return;
      s.result = result;
      releaseEngine(s);
      renderResult(s);
    }).catch(function (err) {
      if (s.cancelled) return;
      releaseEngine(s);
      renderError(err);
    });
  }

  function tips() {
    var list = el('ul', 'scan-tips');
    ['Lay the page flat in even light, with no glare or shadows.',
      'Fill the frame with the page and hold the phone straight above it.',
      'For the I-94, a PDF or screenshot from i94.cbp.dhs.gov works best.',
      'You can always type the dates in yourself.'].forEach(function (t) {
      list.appendChild(el('li', null, t));
    });
    return list;
  }

  function finishLayout(hasFields) {
    els.progress.hidden = true;
    els.result.hidden = false;
    els.actions.hidden = false;
    els.apply.hidden = !hasFields;
    els.cancel.textContent = hasFields ? 'Cancel' : 'Close';
    updateApply();
  }

  function renderError(err) {
    els.result.textContent = '';
    els.title.textContent = 'Could not read this file';
    var text = (err && ERROR_TEXT[err.code]) ||
      'Something went wrong while reading the document' + (err && err.message ? ': ' + err.message : '.');
    els.result.appendChild(el('div', 'flag flag-bad', text));
    finishLayout(false);
  }

  function renderResult(s) {
    var result = s.result;
    var box = els.result;
    box.textContent = '';
    els.title.textContent = result.doc ? 'Found your ' + result.docName : 'No dates found';

    if (!result.doc) {
      box.appendChild(el('p', null, 'This does not look like an I-94 printout or an I-797C receipt notice, or its text could not be read clearly.'));
      box.appendChild(tips());
    }
    result.notices.forEach(function (n) {
      box.appendChild(el('div', 'flag flag-' + (n.level === 'bad' ? 'bad' : n.level === 'warn' ? 'warn' : 'info'), n.text));
    });
    result.fields.forEach(function (f) { box.appendChild(fieldCard(s, f)); });
    if (result.fields.length) {
      box.appendChild(el('p', 'hint', 'Nothing is filled in until you tick "This matches my document" and press the button. The document itself is never saved.'));
    }
    finishLayout(result.fields.length > 0);
  }

  function cropCanvas(image, f) {
    if (!image || !f.labelBox) return null;
    var boxes = [f.labelBox, f.valueBox || f.searchBox];
    var u = boxes.reduce(function (a, b) {
      return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
    });
    var h = Math.max(10, f.labelBox.y1 - f.labelBox.y0);
    var canvas = toCanvas(Scan.cropImage(image, { x0: u.x0 - h, y0: u.y0 - 0.6 * h, x1: u.x1 + 2 * h, y1: u.y1 + 0.6 * h }));
    canvas.className = 'scan-crop';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'The part of your document this date was read from');
    return canvas;
  }

  function fieldCard(s, f) {
    var form = document.getElementById('form-' + s.tab);
    var current = form && form.elements[f.field] ? form.elements[f.field].value : '';
    var card = el('div', 'scan-field ' + (f.status === 'ok' ? 'is-ok' : 'is-check'));
    card.appendChild(el('h3', null, f.label));

    var crop = cropCanvas(s.result.image, f);
    if (crop) {
      card.appendChild(el('p', 'scan-caption', 'What the reader saw on your document:'));
      card.appendChild(crop);
    }

    card.appendChild(el('p', 'scan-verdict', f.status === 'ok'
      ? '✓ Read twice, and both readings match.'
      : '⚠ Check this one carefully against your document.'));
    var issues = f.issues.filter(function (i, idx) { return ISSUE_TEXT[i] && f.issues.indexOf(i) === idx; });
    if (issues.length) {
      var list = el('ul', 'scan-issues');
      issues.forEach(function (i) { list.appendChild(el('li', null, ISSUE_TEXT[i])); });
      card.appendChild(list);
    }

    var dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.value = f.value || '';

    if (f.options.length) {
      var group = el('fieldset', 'scan-options');
      group.appendChild(el('legend', null, 'Which date is printed on your document?'));
      var name = 'scan-opt-' + f.field;
      f.options.concat(['']).forEach(function (iso) {
        var label = el('label');
        var radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = name;
        radio.value = iso;
        radio.addEventListener('change', function () {
          dateInput.value = iso;
          updateApply();
        });
        label.appendChild(radio);
        label.appendChild(document.createTextNode(iso ? formatDate(iso) : 'None of these. I will type it in.'));
        group.appendChild(label);
      });
      card.appendChild(group);
    } else if (!f.value) {
      card.appendChild(el('p', 'scan-caption', 'You can type the date from your document here instead.'));
    }

    var field = el('label', 'field');
    field.appendChild(el('span', null, 'Date to fill in'));
    field.appendChild(dateInput);
    field.appendChild(el('small', null, 'Goes into: ' + TAB_NAME[s.tab] + ' tab, "' + TARGET_LABEL[f.field] + '".'));
    if (current) {
      field.appendChild(el('small', null, 'This replaces the date entered there now (' + formatDate(current) + ').'));
    }
    card.appendChild(field);

    var confirmLabel = el('label', 'scan-confirm');
    var confirmBox = document.createElement('input');
    confirmBox.type = 'checkbox';
    confirmLabel.appendChild(confirmBox);
    confirmLabel.appendChild(document.createTextNode('This matches my document'));
    card.appendChild(confirmLabel);

    confirmBox.addEventListener('change', updateApply);
    dateInput.addEventListener('input', updateApply);
    s.entries.push({ field: f.field, dateInput: dateInput, confirm: confirmBox });
    return card;
  }

  function validIso(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value);
  }

  function updateApply() {
    var s = session;
    var ready = !!s && s.entries.some(function (e) { return e.confirm.checked && validIso(e.dateInput.value); });
    els.apply.disabled = !ready;
  }

  function applySelected() {
    var s = session;
    if (!s) return;
    var form = document.getElementById('form-' + s.tab);
    var filled = [];
    s.entries.forEach(function (e) {
      if (!e.confirm.checked || !validIso(e.dateInput.value)) return;
      var input = form.elements[e.field];
      input.value = e.dateInput.value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      var wrap = input.closest('.field');
      if (wrap) {
        wrap.classList.remove('scan-filled');
        void wrap.offsetWidth;
        wrap.classList.add('scan-filled');
      }
      filled.push(TARGET_LABEL[e.field]);
    });
    closeDialog();
    var status = document.querySelector('[data-scan-status="' + s.tab + '"]');
    if (status) status.textContent = filled.length ? 'Filled in: ' + filled.join(', ') + '. Your deadlines are updated.' : '';
  }

  function bind() {
    dialog = document.getElementById('scanDialog');
    if (!dialog) return;
    els = {
      title: document.getElementById('scanTitle'),
      progress: document.getElementById('scanProgress'),
      step: document.getElementById('scanStep'),
      bar: document.getElementById('scanBar'),
      result: document.getElementById('scanResult'),
      actions: document.getElementById('scanActions'),
      apply: document.getElementById('scanApply'),
      cancel: document.getElementById('scanCancel')
    };
    document.querySelectorAll('[data-scan-pick]').forEach(function (button) {
      var tab = button.getAttribute('data-scan-pick');
      var input = document.querySelector('[data-scan-input="' + tab + '"]');
      button.addEventListener('click', function () { input.click(); });
      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        input.value = '';
        if (file) start(tab, file);
      });
    });
    dialog.querySelectorAll('[data-scan-close]').forEach(function (b) { b.addEventListener('click', closeDialog); });
    dialog.addEventListener('cancel', function (event) {
      event.preventDefault();
      closeDialog();
    });
    els.apply.addEventListener('click', applySelected);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
}());

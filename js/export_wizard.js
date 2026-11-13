/* export_wizard.js — SHARED "Cosmic Cargo" export wizard engine, reused by
   every tab's download button (Job Odyssey first, Career next). Lives in
   the persistent shell (html/shell.html) alongside the modal markup it
   drives, so it's available regardless of which tab is currently loaded
   into #app — same reasoning as career_voyager_ui.js's global Add
   Application modal (see that file's header comment for the full
   rationale). Runs once, unconditionally, at script load — NOT tied to
   window.__solarisInit, since this has nothing tab-specific to guard on.

   A tab registers itself by calling window.expOpen(cfg) with:
     title            - shown in the modal header
     columns          - [{key, label}, ...] in the locked, confirmed order
     filename         - base filename (no extension) for the download
     getCurrentRows() - returns a Promise<rows> for whatever is on screen
                        right now (filters + search + sort), ALL matching
                        rows, ignoring pagination
     renderNewFilters(containerEl) - renders the "New" filter+sort UI for
                        this source into containerEl
     getNewRows()     - reads whatever renderNewFilters() built and
                        returns a Promise<rows> for that fresh selection
     skipChoice       - optional; true skips straight to renderNewFilters()
                        for sources with no meaningful "Current" filter set
   Rows are plain objects keyed by each column's `key`. */
(function () {
  'use strict';

  var API = '/solaris/api';
  var EXP = null;

  function $(id) { return document.getElementById(id); }

  function expOpen(cfg) {
    EXP = cfg;
    EXP.mode = cfg.skipChoice ? 'new' : null;
    EXP.selectedColumns = cfg.columns.map(function (c) { return c.key; });
    $('exp-source-label').textContent = cfg.title;
    $('exp-overlay-bg').style.display = 'block';
    $('exp-modal').classList.add('exp-open');
    // Reset first — this modal is reused across every tab, so a previous
    // open's accentColor would otherwise linger as a stale inline style
    // override once a tab that doesn't set one opens it next.
    $('exp-modal').style.removeProperty('--exp-accent');
    if (cfg.accentColor) $('exp-modal').style.setProperty('--exp-accent', cfg.accentColor);
    if (cfg.skipChoice) {
      var body = $('exp-filters-body');
      body.innerHTML = '';
      cfg.renderNewFilters(body);
      expShowStep('filters');
    } else {
      expShowStep('choice');
    }
  }

  function expClose() {
    $('exp-modal').classList.remove('exp-open');
    $('exp-overlay-bg').style.display = 'none';
  }

  function expShowStep(name) {
    ['choice', 'filters', 'columns', 'filetype', 'loading'].forEach(function (s) {
      $('exp-step-' + s).style.display = (s === name) ? 'block' : 'none';
    });
  }

  function expChooseCurrent() {
    EXP.mode = 'current';
    expShowStep('columns');
    expRenderColumns();
  }

  function expChooseNew() {
    EXP.mode = 'new';
    var body = $('exp-filters-body');
    body.innerHTML = '';
    EXP.renderNewFilters(body);
    expShowStep('filters');
  }

  function expBackToChoice() {
    if (EXP.skipChoice) { expClose(); return; }
    expShowStep('choice');
  }

  function expGoToColumns() {
    expShowStep('columns');
    expRenderColumns();
  }

  function expBackFromColumns() {
    expShowStep(EXP.mode === 'current' ? 'choice' : 'filters');
  }

  function expGoToFileType() {
    if (!EXP.selectedColumns.length) { alert('Pick at least one column to export.'); return; }
    expShowStep('filetype');
  }

  function expBackFromFileType() { expShowStep('columns'); }

  function expRenderColumns() {
    var body = $('exp-columns-body');
    body.innerHTML = EXP.columns.map(function (c) {
      var checked = EXP.selectedColumns.indexOf(c.key) !== -1 ? 'checked' : '';
      return '<label class="exp-col-item"><input type="checkbox" value="' + c.key + '" ' + checked + '> ' + c.label + '</label>';
    }).join('');
    body.querySelectorAll('input[type=checkbox]').forEach(function (b) {
      b.addEventListener('change', expOnColToggle);
    });
    $('exp-col-all-cb').checked = (EXP.selectedColumns.length === EXP.columns.length);
  }

  function expOnColToggle() {
    var boxes = Array.prototype.slice.call(document.querySelectorAll('#exp-columns-body input[type=checkbox]'));
    EXP.selectedColumns = boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
    $('exp-col-all-cb').checked = (EXP.selectedColumns.length === EXP.columns.length);
  }

  function expToggleAllColumns(cb) {
    var boxes = document.querySelectorAll('#exp-columns-body input[type=checkbox]');
    boxes.forEach(function (b) { b.checked = cb.checked; });
    EXP.selectedColumns = cb.checked ? EXP.columns.map(function (c) { return c.key; }) : [];
  }

  // ── One continuous progress bar ─────────────────────────────────────
  //  0-50%   "Preparing your file" — gathering the rows, then the server
  //          building the file. The server reports no progress while it
  //          builds, so this half is an ESTIMATE: it eases toward ~47% over
  //          a few seconds, then glides to exactly 50% the moment the file
  //          is ready.
  //  50-100% "Wrap and share" — the file coming back from the server (REAL
  //          bytes received / Content-Length), then the hand-off to the
  //          browser, which saves the file once this stage ends.
  // Each half is held on screen for a minimum time, so an export that is
  // genuinely instant (Career's tables are tiny) still visibly passes
  // through both stages instead of flashing by.
  var EXP_PREPARE_ESTIMATE_CAP = 0.47;
  var EXP_MIN_PREPARE_MS = 700, EXP_MIN_WRAP_MS = 600;
  var expShown = 0, expAnim = null, expRaf = null;

  function expFrame(now) {
    expRaf = null;
    var a = expAnim;
    if (!a) return;
    var k = Math.max(0, Math.min(1, (now - a.start) / a.dur));
    expShown = a.from + (a.to - a.from) * (1 - Math.pow(1 - k, 3)); // ease-out
    $('exp-progress').value = Math.round(expShown * 1000);
    if (k < 1) expRaf = requestAnimationFrame(expFrame); else expAnim = null;
  }
  function expGlide(to, ms) {
    expAnim = { from: expShown, to: to, start: performance.now(), dur: Math.max(1, ms) };
    if (!expRaf) expRaf = requestAnimationFrame(expFrame);
  }
  function expStopProgress() {
    expAnim = null;
    if (expRaf) { cancelAnimationFrame(expRaf); expRaf = null; }
  }
  function expSleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function expResetProgress() {
    expStopProgress();
    expShown = 0;
    var bar = $('exp-progress'); bar.max = 1000; bar.value = 0;
    $('exp-loading-text').textContent = 'Preparing your file\u2026';
    $('exp-progress-pct').textContent = '';
  }

  function expFormatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // Second half of the bar: reads the response as a stream and moves the
  // bar with the bytes that really arrive. Falls back to a plain
  // response.blob() (bar waits at 50%, then completes) when Content-Length
  // is missing or the browser lacks streaming support, so a download still
  // finishes either way.
  function expReadWithProgress(r) {
    var total = parseInt(r.headers.get('Content-Length') || '0', 10);
    if (!total || !r.body || !r.body.getReader) return r.blob();
    var reader = r.body.getReader(), chunks = [], received = 0;
    function pump() {
      return reader.read().then(function (res) {
        if (res.done) return new Blob(chunks, { type: r.headers.get('Content-Type') || undefined });
        chunks.push(res.value);
        received += res.value.length;
        expGlide(0.5 + 0.5 * (received / total), 160);
        $('exp-progress-pct').textContent = expFormatBytes(received) + ' / ' + expFormatBytes(total);
        return pump();
      });
    }
    return pump();
  }

  function expDownload(fmt) {
    if (!EXP.selectedColumns.length) { alert('Pick at least one column to export.'); return; }
    expShowStep('loading');
    expResetProgress();
    var prepStart = Date.now(), wrapStart = 0;
    expGlide(EXP_PREPARE_ESTIMATE_CAP, 9000); // slow estimated creep while the real work runs
    var rowsPromise = (EXP.mode === 'current') ? EXP.getCurrentRows() : EXP.getNewRows();
    var colsMeta = EXP.selectedColumns.map(function (key) {
      var col = EXP.columns.filter(function (c) { return c.key === key; })[0];
      return { key: key, label: col ? col.label : key };
    });
    var filename = EXP.filename;
    rowsPromise.then(function (rows) {
      return fetch(API + '/export-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: rows, columns: colsMeta, filename: filename, format: fmt })
      });
    }).then(function (r) {
      if (!r.ok) {
        // Surface what the server actually said (a missing openpyxl, a cell
        // it couldn't write...) instead of a generic message.
        return r.json().catch(function () { return {}; }).then(function (j) {
          throw new Error((j && j.error) || ('server returned ' + r.status));
        });
      }
      // The file is built. Finish the first half at exactly 50%, taking at
      // least EXP_MIN_PREPARE_MS in total so it can be seen even if instant.
      var remain = Math.max(EXP_MIN_PREPARE_MS - (Date.now() - prepStart), 250);
      expGlide(0.5, remain);
      return expSleep(remain).then(function () {
        wrapStart = Date.now();
        $('exp-loading-text').textContent = 'Wrap and share\u2026';
        return expReadWithProgress(r);
      });
    }).then(function (blob) {
      var remain = Math.max(EXP_MIN_WRAP_MS - (Date.now() - wrapStart), 350);
      expGlide(1, remain);
      return expSleep(remain).then(function () { return blob; });
    }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = filename + '.' + fmt;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      expStopProgress();
      expClose();
    }).catch(function (err) {
      expStopProgress();
      alert('Export failed \u2014 ' + ((err && err.message) ? err.message : 'please try again.'));
      expShowStep('filetype');
    });
  }

  function bindExportWizard() {
    if (!$('exp-modal')) return; // shell markup missing — nothing to bind
    $('exp-overlay-bg').addEventListener('click', expClose);
    $('exp-modal').addEventListener('click', function (e) { if (e.target === $('exp-modal')) expClose(); });
    var modalCard = $('exp-modal').querySelector('.exp-modal');
    if (modalCard) modalCard.addEventListener('click', function (e) { e.stopPropagation(); });
    document.querySelectorAll('#exp-modal .exp-modal-x').forEach(function (b) { b.addEventListener('click', expClose); });

    $('exp-choice-current').addEventListener('click', expChooseCurrent);
    $('exp-choice-new').addEventListener('click', expChooseNew);
    $('exp-filters-back').addEventListener('click', expBackToChoice);
    $('exp-filters-next').addEventListener('click', expGoToColumns);
    $('exp-col-all-cb').addEventListener('change', function () { expToggleAllColumns(this); });
    $('exp-columns-back').addEventListener('click', expBackFromColumns);
    $('exp-columns-next').addEventListener('click', expGoToFileType);
    $('exp-filetype-back').addEventListener('click', expBackFromFileType);
    $('exp-download-csv').addEventListener('click', function () { expDownload('csv'); });
    $('exp-download-xlsx').addEventListener('click', function () { expDownload('xlsx'); });
  }

  window.expOpen = expOpen;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindExportWizard);
  } else {
    bindExportWizard();
  }
})();

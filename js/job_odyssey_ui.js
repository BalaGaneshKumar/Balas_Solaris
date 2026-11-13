/* job_odyssey_ui.js — Job Odyssey tab page: BEHAVIOR ONLY.
   All markup for this page lives in the single html/fragments/job_odyssey.html
   file (jo_header()/jo_log()/jo_content() macros), rendered server-side
   by tab.html's Jinja conditionals when current_key == 'job-odyssey'.

   Data comes from py/jobodyssey_api.py -> py/jobodyssey_store.py
   (SQLite, jobodyssey.db). That store owns ALL the real logic —
   auto-blacklist by title keyword, duplicate detection, ignore-on-
   conflict dedup, the descriptor-enrichment queue. NONE of that is
   reimplemented here: this file only ever (a) asks the API for
   whatever rows/labels the store already computed, and (b) sends a
   new status when an action button is clicked. If the store's
   duplicate/blacklist logic changes later, nothing here needs to
   change — the labels just render whatever comes back.

     - ONE combined load on init + every filter/sort/search change:
       GET /jobodyssey-load?status=&portal=&location=&search=&sort=&validation=&link_type=
       -> { jobs, stats, filterOptions }
     - ONE write path: POST /jobodyssey-status  { job_id, status }
       This is what Eligible/Hold/Ineligible/Applied call. Nothing
       else in the store (insert_jobs, update_description, the
       descriptor-queue helpers) is exposed to this dashboard.

   The activity log is in-memory only (joLogEntries), same convention
   as Career Voyager's cvLogEntries / Profile Nexus's addLogEntry() —
   never sent to the server, resets on a full page reload but survives
   SPA tab-to-tab navigation within the same session (this file's
   closure stays alive across router.js swaps — only the DOM gets
   replaced).

   Registered on window.__solarisInit like every other planet/tab file
   (see tab.js, career_voyager_ui.js, profile_nexus_ui.js) so router.js
   re-runs it after each SPA fragment swap. Self-guards on
   .tab-body[data-current-planet="job-odyssey"] so it's a no-op on the
   other 3 tab pages. */
(function () {
  'use strict';

  var API = '/solaris/api';
  var PAGE_SIZE = 20;

  var joJobs = [];         // full filtered/sorted result set from the last load
  var joStats = {};
  var joFilterOptions = { portals: [], locations: [] };
  var joSelectedId = null;
  var joPage = 1;
  var joLogOpen = false;
  var joLogEntries = [];   // in-memory only — see file header
  var joUndoTimer = null;
  var joLastStatusChange = null; // { jobId, prevStatus, title, company } for undo

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function initJobOdysseyUi() {
    var root = document.querySelector('.tab-body[data-current-planet="job-odyssey"]');
    if (!root) return; // not this page — no-op, same guard pattern as career_voyager_ui.js

    var headerBar = root.querySelector('.tab-header-bar');
    var logBtn = root.querySelector('.log-btn');
    var content = root.querySelector('.tab-content');
    if (!headerBar || !logBtn || !content) return;

    var $ = function (id) { return content.querySelector('#' + id) || headerBar.querySelector('#' + id) || root.querySelector('#' + id); };

    // Bind every listener FIRST — same rationale as career_voyager_ui.js:
    // buttons must work even if the initial load below fails.
    bindDropdowns(content, logBtn, function () { joLoad($, content); });
    bindToolbar($, content, logBtn);
    bindLogButton(logBtn, content);
    bindDetailActions($, content, logBtn);
    bindUndo($, content, logBtn);
    joRenderLogBadge(logBtn);

    try { joLoad($, content); } catch (e) { console.error('Job Odyssey: failed to load data', e); }
  }

  // ── Custom dropdowns (Status/Portals/Location/Validation/Type/Sort).
  // Native <select> can't have its open options list restyled by CSS —
  // the browser renders that natively — so these are plain divs driven
  // here instead, which is what lets the colored dots / dark panel /
  // gold highlight actually render as designed. ──
  function jo_dd_value(content, filterName) {
    var dd = content.querySelector('#jo-dd-' + filterName);
    return dd ? dd.dataset.value || '' : '';
  }
  function jo_dd_close_all(content) {
    content.querySelectorAll('.jo-dd.jo-dd-open').forEach(function (dd) { dd.classList.remove('jo-dd-open'); });
  }
  function bindDropdowns(content, logBtn, onChange) {
    content.querySelectorAll('.jo-dd').forEach(function (dd) {
      var trigger = dd.querySelector('.jo-dd-trigger');
      var isStatus = dd.id === 'jo-dd-status';
      if (trigger) {
        trigger.addEventListener('click', function (e) {
          e.stopPropagation();
          var wasOpen = dd.classList.contains('jo-dd-open');
          jo_dd_close_all(content);
          if (!wasOpen) dd.classList.add('jo-dd-open');
        });
      }
      if (isStatus) {
        // Match Any / Match None toggle — doesn't close the panel, just
        // flips data-op and re-triggers a load with the same selection.
        // stopPropagation() is required here: without it the click bubbles
        // to the document-level listener below and closes the panel after
        // every single toggle, forcing a reopen for each pick.
        dd.addEventListener('click', function (e) {
          e.stopPropagation();
          var opBtn = e.target.closest('.jo-pg-item[data-op]');
          if (opBtn) {
            dd.dataset.op = opBtn.dataset.op;
            dd.querySelectorAll('#jo-status-op-bar .jo-pg-item').forEach(function (b) {
              b.classList.toggle('jo-pg-active', b === opBtn);
            });
            joLogPush(logBtn, content, 'Status filter mode set to ' + (opBtn.dataset.op === 'not' ? 'Match None' : 'Match Any'));
            onChange();
            return;
          }
          var opt = e.target.closest('.jo-dd-opt');
          if (!opt) return;
          jo_dd_status_toggle(dd, opt);
          var label = dd.querySelector('.jo-dd-val');
          joLogPush(logBtn, content, 'Status filter set to ' + (label ? label.textContent : ''));
          onChange();
        });
      } else {
        dd.addEventListener('click', function (e) {
          var opt = e.target.closest('.jo-dd-opt');
          if (!opt) return;
          jo_dd_select(dd, opt);
          dd.classList.remove('jo-dd-open');
          onChange();
        });
      }
    });
    document.addEventListener('click', function () { jo_dd_close_all(content); });
  }
  function jo_dd_select(dd, opt) {
    dd.dataset.value = opt.dataset.value || '';
    var valSpan = dd.querySelector('.jo-dd-val');
    var label = opt.textContent.trim();
    if (valSpan) valSpan.textContent = label;
    dd.querySelectorAll('.jo-dd-opt').forEach(function (o) { o.classList.toggle('jo-dd-selected', o === opt); });
  }
  // Status dropdown only: clicking "All" clears every selection;
  // clicking a status toggles it on/off, multiple can stay selected
  // (checkbox behavior) instead of single-select.
  function jo_dd_status_toggle(dd, opt) {
    var allOpt = dd.querySelector('.jo-dd-opt[data-all="1"]');
    var items = dd.querySelectorAll('.jo-dd-opt:not([data-all="1"])');
    if (opt.dataset.all === '1') {
      // Toggle-all: if anything is currently checked (partial or full),
      // clicking All clears back to the true "no filter" default. If
      // nothing is checked, clicking All checks every individual box —
      // NOT the same as clearing, so Match None can correctly exclude
      // every status (empty result) instead of always meaning "no filter".
      var anySelected = Array.prototype.some.call(items, function (o) { return o.classList.contains('jo-dd-selected'); });
      items.forEach(function (o) { o.classList.toggle('jo-dd-selected', !anySelected); });
    } else {
      opt.classList.toggle('jo-dd-selected');
    }
    var selected = Array.prototype.filter.call(items, function (o) { return o.classList.contains('jo-dd-selected'); });
    if (allOpt) allOpt.classList.toggle('jo-dd-selected', selected.length === 0);
    dd.dataset.value = selected.map(function (o) { return o.dataset.value; }).join(',');
    var valSpan = dd.querySelector('.jo-dd-val');
    if (valSpan) {
      if (!selected.length) valSpan.textContent = 'All';
      else if (selected.length === items.length) valSpan.textContent = 'All (' + items.length + ')';
      else if (selected.length === 1) valSpan.textContent = selected[0].textContent.trim();
      else valSpan.textContent = selected.length + ' selected';
    }
  }
  // Rebuild a dropdown's option list from a plain array of strings
  // (used for Portals/Location, which come from the API, not a fixed
  // enum) — preserves the current selection if it's still valid.
  function jo_dd_populate(content, filterName, values, defaultLabel) {
    var dd = content.querySelector('#jo-dd-' + filterName);
    if (!dd) return;
    var panel = dd.querySelector('.jo-dd-panel');
    var current = dd.dataset.value || '';
    var stillValid = current === '' || values.indexOf(current) !== -1;
    var html = '<div class="jo-dd-opt' + (stillValid && current === '' ? ' jo-dd-selected' : '') + '" data-value="">' + esc(defaultLabel) + '</div>';
    values.forEach(function (v) {
      html += '<div class="jo-dd-opt' + (stillValid && current === v ? ' jo-dd-selected' : '') + '" data-value="' + esc(v) + '">' + esc(v) + '</div>';
    });
    panel.innerHTML = html;
    if (!stillValid) {
      dd.dataset.value = '';
      var valSpan = dd.querySelector('.jo-dd-val');
      if (valSpan) valSpan.textContent = defaultLabel;
    }
  }

  // ── Load (combined: jobs + stats + filterOptions in one call) ──
  function joBuildQuery($, content) {
    var params = new URLSearchParams();
    var statusDd = content.querySelector('#jo-dd-status');
    var status = jo_dd_value(content, 'status'); if (status) params.set('status', status);
    if (statusDd && statusDd.dataset.op && statusDd.dataset.op !== 'or') params.set('statusOp', statusDd.dataset.op);
    var portal = jo_dd_value(content, 'portal'); if (portal) params.set('portal', portal);
    var location = jo_dd_value(content, 'location'); if (location) params.set('location', location);
    var search = $('jo-f-search').value.trim(); if (search) params.set('search', search);
    var sort = jo_dd_value(content, 'sort'); if (sort) params.set('sort', sort);
    var validation = jo_dd_value(content, 'validation'); if (validation) params.set('validation', validation);
    var linkType = jo_dd_value(content, 'type'); if (linkType) params.set('link_type', linkType);
    return params.toString();
  }

  function joLoad($, content) {
    var reloadBtn = content.querySelector('#jo-btn-reload');
    if (reloadBtn) reloadBtn.classList.add('jo-spinning');

    var qs = joBuildQuery($, content);
    fetch(API + '/jobodyssey-load' + (qs ? '?' + qs : ''))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        joJobs = (d && d.jobs) || [];
        joStats = (d && d.stats) || {};
        joFilterOptions = (d && d.filterOptions) || { portals: [], locations: [] };
        joPage = 1;
        jo_dd_populate(content, 'portal', joFilterOptions.portals || [], 'All');
        jo_dd_populate(content, 'location', joFilterOptions.locations || [], 'All');
        joRenderStats(content);
        joRenderList($, content);
      })
      .catch(function () {
        joJobs = []; joStats = {};
        joRenderStats(content);
        joRenderList($, content);
      })
      .finally(function () {
        if (reloadBtn) reloadBtn.classList.remove('jo-spinning');
      });
  }

  function bindToolbar($, content, logBtn) {
    var search = $('jo-f-search');
    if (search) {
      var t = null;
      search.addEventListener('input', function () {
        clearTimeout(t);
        t = setTimeout(function () { joLoad($, content); }, 350);
      });
    }
    var reloadBtn = $('jo-btn-reload');
    if (reloadBtn) reloadBtn.addEventListener('click', function () {
      joLoad($, content);
      joLogPush(logBtn, content, 'Cosmic Reload triggered');
    });
    var exportBtn = $('jo-btn-export');
    if (exportBtn) exportBtn.addEventListener('click', function () {
      joOpenExport($, content);
      joLogPush(logBtn, content, 'Cosmic Cargo export wizard opened');
    });
  }

  // ── Export ("Cosmic Cargo") — adapter for the shared export_wizard.js engine ──
  var JO_EXPORT_COLUMNS = [
    { key: 'title', label: 'Title' },
    { key: 'company', label: 'Company' },
    { key: 'location', label: 'Location' },
    { key: 'status', label: 'Status' },
    { key: 'portal', label: 'Portal' },
    { key: 'link', label: 'Link' },
    { key: 'posted_date', label: 'Posted Date' },
    { key: 'keyword', label: 'Keyword' },
    { key: 'search_location', label: 'Search Location' },
    { key: 'validation', label: 'Validation' },
    { key: 'is_duplicate', label: 'Duplicate' },
    { key: 'link_type', label: 'Link Type' }
  ];

  function joOpenExport($, content) {
    window.expOpen({
      title: 'Job Odyssey',
      accentColor: '#e8b923', // this tab's own gold (matches .jo-dd-trigger, .jo-search-wrap, etc.)
      columns: JO_EXPORT_COLUMNS,
      filename: 'job_odyssey_export',
      getCurrentRows: function () { return joExpGetCurrentRows($, content); },
      renderNewFilters: function (container) { joExpRenderFilters(container); },
      getNewRows: joExpGetNewRows
    });
  }

  function joExpFetchRows(qs) {
    return fetch(API + '/jobodyssey-load' + (qs ? '?' + qs : ''))
      .then(function (r) { return r.json(); })
      .then(function (d) { return (d && d.jobs) || []; });
  }

  // "Current" reuses the exact querystring already on screen — no
  // separate export endpoint needed since /jobodyssey-load already
  // returns every matching row unpaginated (destination paginates
  // client-side; see job_odyssey_ui.js's own pagination for why).
  function joExpGetCurrentRows($, content) {
    return joExpFetchRows(joBuildQuery($, content));
  }

  function joExpRenderFilters(container) {
    var portalOpts = ['<div class="jo-dd-opt jo-dd-selected" data-value="">All</div>'].concat(
      joFilterOptions.portals.map(function (p) { return '<div class="jo-dd-opt" data-value="' + esc(p) + '">' + esc(p) + '</div>'; })
    ).join('');
    var locOpts = ['<div class="jo-dd-opt jo-dd-selected" data-value="">All</div>'].concat(
      joFilterOptions.locations.map(function (l) { return '<div class="jo-dd-opt" data-value="' + esc(l) + '">' + esc(l) + '</div>'; })
    ).join('');
    var validationOpts =
      '<div class="jo-dd-opt jo-dd-selected" data-value="">All</div>' +
      '<div class="jo-dd-opt" data-value="valid">Valid</div>' +
      '<div class="jo-dd-opt" data-value="defect">Defect</div>';
    var typeOpts =
      '<div class="jo-dd-opt jo-dd-selected" data-value="">All</div>' +
      '<div class="jo-dd-opt" data-value="internal">Internal</div>' +
      '<div class="jo-dd-opt" data-value="external">External</div>' +
      '<div class="jo-dd-opt" data-value="others">Others</div>';
    var sortOpts =
      '<div class="jo-dd-opt jo-dd-selected" data-value="date_desc">Newest first</div>' +
      '<div class="jo-dd-opt" data-value="date_asc">Oldest first</div>' +
      '<div class="jo-dd-opt" data-value="title_asc">Title A&#8594;Z</div>' +
      '<div class="jo-dd-opt" data-value="title_desc">Title Z&#8594;A</div>' +
      '<div class="jo-dd-opt" data-value="company_asc">Company A&#8594;Z</div>' +
      '<div class="jo-dd-opt" data-value="company_desc">Company Z&#8594;A</div>';

    function ddField(id, label, initialText, optsHtml) {
      return '<div class="exp-filter-group"><label class="exp-filter-label">' + label + '</label>' +
        '<div class="jo-dd" id="' + id + '" data-value="">' +
          '<button type="button" class="jo-dd-trigger">' + esc(initialText) + '<span class="jo-dd-chev">&#9662;</span></button>' +
          '<div class="jo-dd-panel">' + optsHtml + '</div>' +
        '</div></div>';
    }

    container.innerHTML =
      '<div class="exp-filter-group">' +
        '<label class="exp-filter-label">Status</label>' +
        '<div class="exp-status-checks">' +
          ['scraped', 'eligible', 'hold', 'ineligible', 'blacklist', 'applied'].map(function (s) {
            return '<label><input type="checkbox" class="exp-jo-status" value="' + s + '"> ' + joLabel(s) + '</label>';
          }).join('') +
        '</div>' +
        '<div class="exp-status-op">' +
          '<label><input type="radio" name="exp-jo-status-op" value="or" checked> Any of these</label>' +
          '<label><input type="radio" name="exp-jo-status-op" value="not"> None of these</label>' +
        '</div>' +
      '</div>' +
      ddField('exp-jo-portal', 'Portal', 'All', portalOpts) +
      ddField('exp-jo-location', 'Location', 'All', locOpts) +
      ddField('exp-jo-validation', 'Validation', 'All', validationOpts) +
      ddField('exp-jo-linktype', 'Type', 'All', typeOpts) +
      ddField('exp-jo-sort', 'Sort', 'Newest first', sortOpts);

    container.querySelectorAll('.jo-dd').forEach(function (dd) { joExpBindDropdown(dd); });
  }

  // Standalone single-select .jo-dd binder for dropdowns rendered inside
  // the export wizard panel (lives in the shell, outside Job Odyssey's
  // own #jo-toolbar, so the toolbar's own bindDropdowns()/jo_dd_close_all
  // — both scoped to Job Odyssey's tab content — can't reach these).
  // Rebuilt fresh via innerHTML every time the panel opens, so there's no
  // duplicate-binding concern the way there was for the persistent
  // Add Application modal.
  function joExpBindDropdown(dd) {
    var trigger = dd.querySelector('.jo-dd-trigger');
    var panel = dd.querySelector('.jo-dd-panel');
    if (trigger) {
      trigger.addEventListener('click', function (e) {
        e.stopPropagation();
        var wasOpen = dd.classList.contains('jo-dd-open');
        document.querySelectorAll('#exp-filters-body .jo-dd.jo-dd-open').forEach(function (o) { o.classList.remove('jo-dd-open'); });
        if (!wasOpen) {
          // Same fix as Career's cvExpBindDropdown — the wizard modal's
          // overflow-y:auto clips any position:absolute descendant that
          // extends past its own box. Fixed positioning, computed from
          // the trigger's actual screen coordinates, escapes that.
          // Additionally flips the panel upward when there isn't much
          // room below — without this, a dropdown near the bottom of a
          // long filter list (e.g. Sort, the last of five here) opens
          // into a tiny sliver of remaining space, forcing the cursor to
          // stay precisely inside that small area just to scroll it.
          if (panel) {
            var r = trigger.getBoundingClientRect();
            var spaceBelow = window.innerHeight - r.bottom - 20;
            var spaceAbove = r.top - 20;
            panel.style.position = 'fixed';
            panel.style.left = r.left + 'px';
            panel.style.width = r.width + 'px';
            if (spaceBelow < 160 && spaceAbove > spaceBelow) {
              panel.style.top = 'auto';
              panel.style.bottom = (window.innerHeight - r.top + 6) + 'px';
              panel.style.maxHeight = Math.max(120, spaceAbove) + 'px';
            } else {
              panel.style.bottom = 'auto';
              panel.style.top = (r.bottom + 6) + 'px';
              panel.style.maxHeight = Math.max(120, spaceBelow) + 'px';
            }
          }
          dd.classList.add('jo-dd-open');
        }
      });
    }
    dd.addEventListener('click', function (e) {
      e.stopPropagation();
      var opt = e.target.closest('.jo-dd-opt');
      if (!opt) return;
      dd.dataset.value = opt.dataset.value || '';
      var label = opt.textContent.trim();
      if (trigger) trigger.innerHTML = esc(label) + '<span class="jo-dd-chev">&#9662;</span>';
      dd.querySelectorAll('.jo-dd-opt').forEach(function (o) { o.classList.toggle('jo-dd-selected', o === opt); });
      dd.classList.remove('jo-dd-open');
    });
  }

  function joExpGetNewRows() {
    var statusVals = Array.prototype.slice.call(document.querySelectorAll('.exp-jo-status:checked')).map(function (c) { return c.value; });
    var opEl = document.querySelector('input[name="exp-jo-status-op"]:checked');
    var statusOp = opEl ? opEl.value : 'or';
    var params = new URLSearchParams();
    if (statusVals.length) params.set('status', statusVals.join(','));
    if (statusOp !== 'or') params.set('statusOp', statusOp);
    var portal = document.getElementById('exp-jo-portal').dataset.value;
    if (portal) params.set('portal', portal);
    var location = document.getElementById('exp-jo-location').dataset.value;
    if (location) params.set('location', location);
    var validation = document.getElementById('exp-jo-validation').dataset.value;
    if (validation) params.set('validation', validation);
    var linkType = document.getElementById('exp-jo-linktype').dataset.value;
    if (linkType) params.set('link_type', linkType);
    params.set('sort', document.getElementById('exp-jo-sort').dataset.value || 'date_desc');
    return joExpFetchRows(params.toString());
  }

  // ── Stats ──
  function joRenderStats(content) {
    var map = { total: 'jo-stat-total', scraped: 'jo-stat-scraped', applied: 'jo-stat-applied', ineligible: 'jo-stat-ineligible', blacklist: 'jo-stat-blacklist', eligible: 'jo-stat-eligible', hold: 'jo-stat-hold' };
    Object.keys(map).forEach(function (key) {
      var el = content.querySelector('#' + map[key]);
      if (el) el.textContent = joStats[key] || 0;
    });
  }

  // ── List + pagination ──
  function joBadgeHtml(job) {
    var html = '';
    if (job.portal) html += '<span class="jo-tag jo-src">' + esc(job.portal) + '</span>';
    if (job.validation === 'defect') html += '<span class="jo-tag jo-defect">Defect</span>';
    else html += '<span class="jo-tag jo-valid">Valid</span>';
    html += '<span class="jo-tag jo-status-' + esc(job.status || 'scraped') + '">' + esc(joLabel(job.status || 'scraped')) + '</span>';
    var lt = job.link_type;
    if (lt === 'internal') html += '<span class="jo-tag jo-internal">Internal</span>';
    else if (lt === 'external') html += '<span class="jo-tag jo-external">External</span>';
    else html += '<span class="jo-tag jo-others">Others</span>';
    if (job.is_duplicate) html += '<span class="jo-tag jo-duplicate">Duplicate</span>';
    return html;
  }
  function joLabel(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function joRenderList($, content) {
    var scroll = content.querySelector('#jo-list-scroll');
    var empty = content.querySelector('#jo-list-empty');
    var tpl = content.querySelector('#jo-card-template');
    if (!scroll || !tpl) return;

    scroll.innerHTML = '';
    if (!joJobs.length) {
      if (empty) empty.style.display = 'block';
      joRenderPagination($, content);
      joRenderDetail($, content, null);
      return;
    }
    if (empty) empty.style.display = 'none';

    var totalPages = Math.max(1, Math.ceil(joJobs.length / PAGE_SIZE));
    if (joPage > totalPages) joPage = totalPages;
    var start = (joPage - 1) * PAGE_SIZE;
    var pageJobs = joJobs.slice(start, start + PAGE_SIZE);

    pageJobs.forEach(function (job) {
      var node = tpl.content.cloneNode(true);
      var card = node.querySelector('.jo-card');
      card.dataset.jobId = job.id;
      card.querySelector('.jo-card-title').textContent = job.title || '(untitled)';
      card.querySelector('.jo-card-sub').textContent = (job.company || '') + (job.location ? ' · ' + job.location : '');
      card.querySelector('.jo-card-tags').innerHTML = joBadgeHtml(job);
      if (String(job.id) === String(joSelectedId)) card.classList.add('jo-selected');
      card.addEventListener('click', function () { joSelect($, content, job.id); });
      scroll.appendChild(node);
    });

    // Auto-select first visible job if nothing selected (or previous
    // selection isn't on this page/filter set anymore).
    var stillVisible = pageJobs.some(function (j) { return String(j.id) === String(joSelectedId); });
    if (!stillVisible) {
      joSelectedId = pageJobs.length ? pageJobs[0].id : null;
      scroll.querySelectorAll('.jo-card').forEach(function (c) { c.classList.toggle('jo-selected', c.dataset.jobId === String(joSelectedId)); });
    }
    joRenderDetail($, content, joSelectedId);
    joRenderPagination($, content);
  }

  function joRenderPagination($, content) {
    var box = content.querySelector('#jo-pagination');
    if (!box) return;
    var total = joJobs.length;
    var totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    var start = total ? (joPage - 1) * PAGE_SIZE + 1 : 0;
    var end = Math.min(joPage * PAGE_SIZE, total);

    var pages = [];
    pages.push(1);
    for (var p = joPage - 2; p <= joPage + 2; p++) if (p > 1 && p < totalPages) pages.push(p);
    if (totalPages > 1) pages.push(totalPages);
    pages = pages.filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; });

    var html = '<div class="jo-pg-bar">';
    html += '<div class="jo-pg-arrow" data-pg="' + Math.max(1, joPage - 1) + '">&#8249;</div>';
    var prev = null;
    pages.forEach(function (p) {
      if (prev !== null && p - prev > 1) html += '<div class="jo-pg-dots">&middot;&middot;&middot;</div>';
      html += '<div class="jo-pg-item' + (p === joPage ? ' jo-pg-active' : '') + '" data-pg="' + p + '">' + p + '</div>';
      prev = p;
    });
    html += '<div class="jo-pg-arrow" data-pg="' + Math.min(totalPages, joPage + 1) + '">&#8250;</div>';
    html += '</div>';
    html += '<span class="jo-pg-count">' + start + '&ndash;' + end + ' of ' + total + ' jobs</span>';
    box.innerHTML = html;

    box.querySelectorAll('[data-pg]').forEach(function (el) {
      el.addEventListener('click', function () {
        var p = parseInt(el.dataset.pg, 10);
        if (p && p !== joPage) { joPage = p; joRenderList($, content); }
      });
    });
  }

  // ── Selection + detail pane ──
  function joSelect($, content, jobId) {
    joSelectedId = jobId;
    content.querySelectorAll('.jo-card').forEach(function (c) { c.classList.toggle('jo-selected', c.dataset.jobId === String(jobId)); });
    joRenderDetail($, content, jobId);
  }

  function joRenderDetail($, content, jobId) {
    var empty = content.querySelector('#jo-detail-empty');
    var body = content.querySelector('#jo-detail-body');
    var job = joJobs.find(function (j) { return String(j.id) === String(jobId); });
    if (!job) {
      if (empty) empty.style.display = 'block';
      if (body) body.style.display = 'none';
      return;
    }
    if (empty) empty.style.display = 'none';
    if (body) body.style.display = 'block';

    content.querySelector('#jo-d-title').textContent = job.title || '(untitled)';
    content.querySelector('#jo-d-company').textContent = job.company || '';
    content.querySelector('#jo-d-location').textContent = job.location ? '\uD83D\uDCCD ' + job.location : '';
    content.querySelector('#jo-d-id').textContent = 'ID: ' + job.id;
    content.querySelector('#jo-d-tags').innerHTML = joBadgeHtml(job);

    var viewLink = content.querySelector('#jo-d-view');
    if (viewLink) viewLink.href = job.link || '#';

    content.querySelectorAll('.jo-act[data-status]').forEach(function (btn) {
      btn.classList.toggle('jo-act-current', btn.dataset.status === job.status);
    });

    joFetchAndRenderDescription(content, jobId);
  }

  // description isn't included in the list payload anymore (see
  // jobodyssey_store.py's load_jobs() — it can run to ~3,600 chars/job
  // and that endpoint returns every matching row unpaginated), so it's
  // fetched separately here for just the one job currently selected.
  // Guards against a slow response landing after the user has already
  // clicked a different card — same reasoning as source's
  // joFetchAndRenderDetail() checking joSelectedId === id before using
  // the response.
  function joFetchAndRenderDescription(content, jobId) {
    var descEl = content.querySelector('#jo-d-desc');
    if (!descEl) return;
    descEl.textContent = 'Loading description\u2026';
    fetch(API + '/jobodyssey-job-detail?id=' + encodeURIComponent(jobId))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (String(joSelectedId) !== String(jobId)) return; // stale — user moved on
        descEl.textContent = (d.ok && d.job && d.job.description) ? d.job.description : 'No description available.';
      })
      .catch(function () {
        if (String(joSelectedId) !== String(jobId)) return;
        descEl.textContent = 'No description available.';
      });
  }

  // ── Status change (the ONE write path) + undo ──
  function bindDetailActions($, content, logBtn) {
    content.addEventListener('click', function (e) {
      var btn = e.target.closest('.jo-act[data-status]');
      if (!btn) return;
      var card = content.querySelector('.jo-card.jo-selected');
      var jobId = joSelectedId;
      var job = joJobs.find(function (j) { return String(j.id) === String(jobId); });
      if (!job) return;
      var newStatus = btn.dataset.status;
      var prevStatus = job.status;
      if (newStatus === prevStatus) return;

      fetch(API + '/jobodyssey-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: job.id, status: newStatus })
      })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (!res || !res.ok) return;
          job.status = newStatus;
          // re-render just this job's badges/buttons + its list card, no full reload
          joRenderDetail($, content, jobId);
          var listCard = content.querySelector('.jo-card[data-job-id="' + jobId + '"] .jo-card-tags');
          if (listCard) listCard.innerHTML = joBadgeHtml(job);
          joRenderStats(content); // counts shift between status buckets

          joLastStatusChange = { jobId: job.id, prevStatus: prevStatus, title: job.title, company: job.company };
          joShowUndo($, content, job, prevStatus, newStatus);
          joLogPush(logBtn, content, (job.company || 'Job') + ' — ' + (job.title || '') + ' moved to ' + joLabel(newStatus));

          // Applied — same as source's joMarkApplied: hand off to Career
          // Voyager's Add Application modal, pre-filled. Source could just
          // call crOpenAppModalPrefill() directly (every tab's DOM was
          // already on the page, modal was just a fixed-position overlay
          // on top). This app's router only keeps one tab's fragment in
          // #app at a time, but the modal itself now lives in the
          // persistent shell (html/shell.html, see career_voyager_ui.js),
          // so it's reachable the exact same direct way — no tab switch,
          // no navigation, this page's own list/filters/undo bar are
          // never touched.
          if (newStatus === 'applied' && window.cvOpenAppModalPrefill) {
            window.cvOpenAppModalPrefill({
              company: job.company || '',
              role: job.title || '',
              location: job.location || '',
              date: new Date().toISOString().slice(0, 10)
            });
          }
        })
        .catch(function () { /* network error — leave state untouched */ });
    });
  }

  function joShowUndo($, content, job, prevStatus, newStatus) {
    var bar = content.querySelector('#jo-undo-bar');
    var text = content.querySelector('#jo-undo-text');
    if (!bar || !text) return;
    text.innerHTML = esc(job.company || 'Job') + ' &mdash; ' + esc(job.title || '') + ' moved to <strong>' + esc(joLabel(newStatus)) + '</strong>';
    bar.style.display = 'flex';
    clearTimeout(joUndoTimer);
    joUndoTimer = setTimeout(function () { bar.style.display = 'none'; }, 6000);
  }

  function bindUndo($, content, logBtn) {
    var btn = content.querySelector('#jo-undo-btn');
    var bar = content.querySelector('#jo-undo-bar');
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (!joLastStatusChange) return;
      var change = joLastStatusChange;
      fetch(API + '/jobodyssey-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: change.jobId, status: change.prevStatus })
      })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (!res || !res.ok) return;
          var job = joJobs.find(function (j) { return String(j.id) === String(change.jobId); });
          if (job) job.status = change.prevStatus;
          joRenderDetail($, content, change.jobId);
          var listCard = content.querySelector('.jo-card[data-job-id="' + change.jobId + '"] .jo-card-tags');
          if (listCard && job) listCard.innerHTML = joBadgeHtml(job);
          joRenderStats(content);
          joLogPush(logBtn, content, (change.company || 'Job') + ' — ' + (change.title || '') + ' undone back to ' + joLabel(change.prevStatus));
          joLastStatusChange = null;
          if (bar) bar.style.display = 'none';
          clearTimeout(joUndoTimer);
        });
    });
  }

  // ── In-memory activity log (see file header — never sent to server) ──
  var joLogVisible = 15; // pagination window — grows via "Load more", see joRenderLogList
  function joLogPush(logBtn, content, message) {
    joLogEntries.unshift({ ts: new Date().toLocaleTimeString(), message: message });
    if (joLogEntries.length > 300) joLogEntries.pop();
    joRenderLogBadge(logBtn);
    if (joLogOpen) joRenderLogList(content);
  }
  function joRenderLogBadge(logBtn) {
    var badge = logBtn.querySelector('#jo-log-count');
    if (!badge) return;
    badge.textContent = joLogEntries.length;
    badge.setAttribute('data-empty', joLogEntries.length ? '0' : '1');
  }
  function joRenderLogList(content) {
    var list = content.querySelector('#jo-log-list');
    var countHeader = content.querySelector('#jo-log-list-count');
    if (countHeader) countHeader.textContent = joLogEntries.length;
    if (!list) return;
    if (!joLogEntries.length) {
      list.innerHTML = '<div class="jo-log-entry">No activity yet this session.</div>';
      return;
    }
    var visible = joLogEntries.slice(0, joLogVisible);
    var html = visible.map(function (e) {
      return '<div class="jo-log-entry"><span class="jo-log-time">' + esc(e.ts) + '</span>' + esc(e.message) + '</div>';
    }).join('');
    if (joLogEntries.length > joLogVisible) {
      html += '<button type="button" class="jo-log-more" id="jo-log-more">Load more (' + (joLogEntries.length - joLogVisible) + ' remaining)</button>';
    }
    list.innerHTML = html;
    var moreBtn = list.querySelector('#jo-log-more');
    if (moreBtn) moreBtn.addEventListener('click', function () { joLogVisible += 15; joRenderLogList(content); });
  }
  // Saves the in-memory activity log as a text file (oldest entry first).
  function downloadLogFile(filenamePrefix, headerText, lines) {
    var d = new Date();
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    var stamp = d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
    var text = ['# ' + headerText + ' — exported ' + d.toLocaleString(), '# ' + lines.length + ' entries, oldest first'].concat(lines).join('\n') + '\n';
    var url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    var a = document.createElement('a');
    a.href = url; a.download = filenamePrefix + '-' + stamp + '.txt';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function bindLogButton(logBtn, content) {
    var dlBtn = content.querySelector('#jo-log-download');
    if (dlBtn) dlBtn.addEventListener('click', function () {
      downloadLogFile('job-odyssey-activity-log', 'Job Odyssey activity log (this session only)',
        joLogEntries.slice().reverse().map(function (e) { return e.ts + ' | ' + e.message; }));
    });
    logBtn.addEventListener('click', function () {
      joLogOpen = !joLogOpen;
      logBtn.classList.toggle('jo-open', joLogOpen);
      var panel = content.querySelector('#jo-log-panel');
      if (panel) panel.style.display = joLogOpen ? 'block' : 'none';
      // joLogPush re-renders the list for us when joLogOpen is true, so
      // this one line both records the open/close AND (on open) shows
      // it immediately — no separate render call needed.
      joLogPush(logBtn, content, joLogOpen ? 'Opened activity log' : 'Closed activity log');
    });
  }

  window.__solarisInit = window.__solarisInit || {};
  window.__solarisInit.jobOdysseyUi = initJobOdysseyUi;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initJobOdysseyUi);
  } else {
    initJobOdysseyUi();
  }
})();

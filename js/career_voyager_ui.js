/* career_voyager_ui.js — Career Voyager tab page: BEHAVIOR ONLY.
   All markup for this page lives in the single html/fragments/career_voyager.html
   file (cv_header()/cv_log()/cv_content() macros), rendered server-side
   by tab.html's Jinja conditionals when current_key == 'career-voyager'.

   Applications and Job Sites are persisted through SQLite (py/career_api.py
   -> db/career.db), using the SAME mechanism as the desktop dashboard's
   career_tracker.py + dashboard_server.py, per an explicit request to
   match that exactly:
     - ONE combined load on init:  GET  /career-load -> {apps, sites}
     - ONE combined save on every add/edit/delete: POST /career-save
       with the FULL apps[] + sites[] arrays; the server deletes and
       re-inserts each table wholesale every time.
   This means there are NO per-row REST calls (no PUT/DELETE by id) and
   NO stable row ids used client-side at all — array POSITION is the
   only identity, exactly like the desktop dashboard's crApps/crSites
   arrays. Editing/deleting targets an app/site by its index in cvApps/
   cvSites, not a database id (ids get reassigned by AUTOINCREMENT on
   every full-table save, so they're not stable across saves anyway).

   The activity log is the one exception: it is intentionally kept in
   an in-memory array only (cvLogEntries) and is never sent to the
   server or written to disk, so it resets on a full page reload but
   survives SPA tab-to-tab navigation within the same session (this
   file's closure stays alive across router.js swaps — only the DOM
   gets replaced).

   Registered on window.__solarisInit like every other planet/tab file
   (see tab.js, nexus.js, profile_nexus_ui.js) so router.js re-runs it
   after each SPA fragment swap. Self-guards on
   .tab-body[data-current-planet="career-voyager"] so it's a no-op on
   the other 3 tab pages. */
(function () {
  'use strict';

  var API = '/solaris/api';

  var cvApps = [];
  var cvSites = [];
  var cvEditAppIdx = null;   // array index into cvApps, or null = adding new
  var cvEditSiteIdx = null;  // array index into cvSites, or null = adding new
  var cvLockedCompany = null;
  var cvAppPage = 1;
  var cvSitePage = 1;
  var PAGE_SIZE = 10;
  var cvLogOpen = false;

  // In-memory only — see file header. Persists across SPA navigations
  // within this tab (closure survives), but never touches the server
  // and is lost on a real page reload.
  var cvLogEntries = [];

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Word-boundary text wrapping for long company/role/location values in
  // the table — matches source's crWrapAtLimit exactly (breaks at the
  // last space within the limit, falls back to a hard break only when a
  // single word itself exceeds the limit).
  function cvWrapAtLimit(text, limit) {
    text = text || '';
    if (text.length <= limit) return esc(text);
    var lines = [];
    var rest = text;
    while (rest.length > limit) {
      var slice = rest.slice(0, limit);
      var lastSpace = slice.lastIndexOf(' ');
      if (lastSpace > 0) {
        lines.push(rest.slice(0, lastSpace));
        rest = rest.slice(lastSpace + 1);
      } else {
        lines.push(rest.slice(0, limit));
        rest = rest.slice(limit);
      }
    }
    if (rest) lines.push(rest);
    return lines.map(function (l) { return esc(l); }).join('<br>');
  }

  // Add Application modal now lives in html/shell.html (persistent,
  // outside #app) so it can open from any tab — $g finds its fields by
  // plain id regardless of which tab's fragment is currently loaded.
  function $g(id) { return document.getElementById(id); }

  // Only valid while Career Voyager is the tab actually on screen —
  // needed for the list re-render + activity-log-badge update after a
  // save, which touch Career-fragment-local elements (search box, sort
  // dropdown, log button) that don't exist while another tab is showing.
  // Returns null otherwise; callers must handle that case (see cvSaveApp).
  function cvActiveCareerContext() {
    var root = document.querySelector('.tab-body[data-current-planet="career-voyager"]');
    if (!root) return null;
    var headerBar = root.querySelector('.tab-header-bar');
    var logBtn = root.querySelector('.log-btn');
    var content = root.querySelector('.tab-content');
    if (!headerBar || !logBtn || !content) return null;
    var $ = function (id) { return content.querySelector('#' + id) || headerBar.querySelector('#' + id) || root.querySelector('#' + id); };
    return { $: $, content: content, logBtn: logBtn };
  }

  function initCareerVoyagerUi() {
    var root = document.querySelector('.tab-body[data-current-planet="career-voyager"]');
    if (!root) return; // not this page — no-op, same guard pattern as profile_nexus_ui.js

    // Normalize the bare /career-voyager URL to /career-voyager/apps —
    // Trajectory is already the preselected default panel (server-
    // rendered visible, tab pill already marked active), so the address
    // bar should say so too rather than sitting on an ambiguous bare
    // URL that doesn't actually tell you which of the two screens
    // you're looking at. replaceState, not pushState/navigate — this
    // is correcting the CURRENT URL to match what's already on screen,
    // not creating a new navigation entry or re-rendering anything.
    if (window.location.pathname === '/solaris/career-voyager') {
      history.replaceState(null, '', '/solaris/career-voyager/apps');
    }

    var headerBar = root.querySelector('.tab-header-bar');
    var logBtn = root.querySelector('.log-btn');
    var content = root.querySelector('.tab-content');
    if (!headerBar || !logBtn || !content) return;

    var $ = function (id) { return content.querySelector('#' + id) || headerBar.querySelector('#' + id) || root.querySelector('#' + id); };

    // Bind every listener FIRST — buttons must work even if the data
    // load below fails or throws for any reason (network, browser
    // quirk, whatever). Nothing here depends on cvApps/cvSites being
    // populated yet.
    bindTabSwitch(headerBar, content, logBtn);
    bindLogButton(logBtn, content);
    bindToolbar($, content, logBtn);
    bindModals($, content, logBtn);
    cvRenderLogBadge(logBtn);

    // One combined load — apps and sites arrive together.
    try { cvLoad($, content); } catch (e) { console.error('Career Voyager: failed to load data', e); }
  }

  // ── Load (combined) + Save (combined, full replace) ──
  var cvDataLoaded = false;   // true once /career-load has resolved at least once this session
  var cvLoadPromise = null;   // in-flight dedupe

  // Guarantees cvApps/cvSites reflect the server before a save can ever
  // happen. Critical when the Add Application modal is opened from
  // Job Odyssey's Applied button — if Career Voyager was never visited
  // this session, cvApps is still its initial empty array; saving
  // without this guard would POST that empty array and, since the
  // server does a full delete+reinsert (see file header), wipe out
  // every previously saved application. Same reasoning as source's
  // `await crEnsureLoaded()` before crOpenAppModalPrefill.
  function cvEnsureLoaded() {
    if (cvDataLoaded) return Promise.resolve();
    if (!cvLoadPromise) {
      cvLoadPromise = fetch(API + '/career-load').then(function (r) { return r.json(); }).then(function (d) {
        cvApps = (d && d.apps) || [];
        cvSites = (d && d.sites) || [];
        cvDataLoaded = true;
      }).catch(function () {
        cvLoadPromise = null; // allow a later retry instead of caching a failure forever
      });
    }
    return cvLoadPromise;
  }

  function cvLoad($, content) {
    fetch(API + '/career-load').then(function (r) { return r.json(); }).then(function (d) {
      cvApps = (d && d.apps) || [];
      cvSites = (d && d.sites) || [];
      cvDataLoaded = true;
      cvRenderApps($, content);
      cvRenderSites($, content);
    }).catch(function () {
      cvApps = []; cvSites = [];
      cvRenderApps($, content); cvRenderSites($, content);
    });
  }
  function cvSaveToServer() {
    return fetch(API + '/career-save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apps: cvApps, sites: cvSites })
    });
  }

  // ── In-memory activity log ──
  var cvLogVisible = 15; // pagination window — grows via "Load more", see cvRenderLogList
  function cvLogPush(logBtn, content, source, message) {
    cvLogEntries.push({ ts: new Date().toLocaleTimeString(), source: source, message: message });
    if (cvLogEntries.length > 300) cvLogEntries.shift();
    cvRenderLogBadge(logBtn);
    if (cvLogOpen && content) cvRenderLogList(content);
  }
  function cvRenderLogBadge(logBtn) {
    var badge = logBtn.querySelector('#cv-log-count');
    if (!badge) return;
    badge.textContent = cvLogEntries.length;
    badge.setAttribute('data-empty', cvLogEntries.length ? '0' : '1');
  }
  function cvRenderLogList(content) {
    var list = content.querySelector('#cv-log-list');
    var countHeader = content.querySelector('#cv-log-list-count');
    if (countHeader) countHeader.textContent = cvLogEntries.length;
    if (!list) return;
    if (!cvLogEntries.length) { list.innerHTML = '<div class="cv-log-empty">No activity yet this session.</div>'; return; }
    var ordered = cvLogEntries.slice().reverse();
    var visible = ordered.slice(0, cvLogVisible);
    var html = visible.map(function (l) {
      return '<div class="cv-log-entry"><span class="cv-log-ts">' + esc(l.ts) + '</span>' + esc(l.message) + '</div>';
    }).join('');
    if (ordered.length > cvLogVisible) {
      html += '<button type="button" class="cv-log-more" id="cv-log-more">Load more (' + (ordered.length - cvLogVisible) + ' remaining)</button>';
    }
    list.innerHTML = html;
    var moreBtn = list.querySelector('#cv-log-more');
    if (moreBtn) moreBtn.addEventListener('click', function () { cvLogVisible += 15; cvRenderLogList(content); });
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
    var dlBtn = content.querySelector('#cv-log-download');
    if (dlBtn) dlBtn.addEventListener('click', function () {
      downloadLogFile('career-voyager-activity-log', 'Career Voyager activity log (this session only)',
        cvLogEntries.map(function (e) { return e.ts + ' | ' + (e.source || '') + ' | ' + e.message; }));
    });
    logBtn.addEventListener('click', function () {
      cvLogOpen = !cvLogOpen;
      var panel = content.querySelector('#cv-log-panel');
      if (panel) panel.style.display = cvLogOpen ? 'block' : 'none';
      logBtn.classList.toggle('cv-open', cvLogOpen);
      // Log the open/close itself — cvLogPush re-renders the list for
      // us when cvLogOpen is true (opening), so this line alone covers
      // both "show the new entry immediately" and "record it at all".
      cvLogPush(logBtn, content, 'Log', cvLogOpen ? 'Opened activity log' : 'Closed activity log');
    });
  }

  // ── Tab switch. Delegated listener on the .cv-tabs container (same
  // pattern as Profile Nexus's #pnx-sub-nav and Scraper Abyss's
  // .sa-tabs) instead of one listener per button — resolves correctly
  // even if a click lands on the icon/orb inside a .cv-tab, not just
  // the button element itself. Also now logs the switch, and pushes a
  // URL update (/career-voyager/apps or /career-voyager/sites) so the
  // address bar reflects which panel is showing — deliberately just
  // history.pushState, not window.SolarisRouter.navigate(): the panel
  // swap itself stays the existing instant client-side toggle, no
  // server round trip, no re-render. Direct links/bookmarks/refresh to
  // either URL still land correctly since solaris.py has real routes
  // for both (see CAREER_VOYAGER_SUBTABS) that server-render with the
  // right panel already visible. ──
  var CV_SUB_URL = { apps: '/solaris/career-voyager/apps', sites: '/solaris/career-voyager/sites' };

  function bindTabSwitch(headerBar, content, logBtn) {
    var tabsContainer = headerBar.querySelector('#cv-tabs');
    if (!tabsContainer) return;
    tabsContainer.addEventListener('click', function (e) {
      var btn = e.target.closest('.cv-tab');
      if (!btn) return;
      var which = btn.getAttribute('data-cv-tab');
      var appsPanel = content.querySelector('#cv-panel-apps');
      var sitesPanel = content.querySelector('#cv-panel-sites');
      var tabApps = headerBar.querySelector('#cv-tab-apps');
      var tabSites = headerBar.querySelector('#cv-tab-sites');
      if (appsPanel) appsPanel.style.display = which === 'apps' ? 'block' : 'none';
      if (sitesPanel) sitesPanel.style.display = which === 'sites' ? 'block' : 'none';
      if (tabApps) tabApps.classList.toggle('cv-active-amber', which === 'apps');
      if (tabSites) tabSites.classList.toggle('cv-active-cyan', which === 'sites');
      var url = CV_SUB_URL[which];
      if (url && window.location.pathname !== url) {
        history.pushState(null, '', url);
      }
      cvLogPush(logBtn, content, 'Nav', 'Switched to ' + (which === 'apps' ? 'Trajectory' : 'Portals'));
    });
  }

  // ── Custom dropdowns (toolbar stage/sort filters, and the credential/
  // stage/sub-stage fields in the Add/Edit Application modal). Native
  // <select> can't have its open options list restyled by CSS — the
  // browser renders that natively, ignoring page CSS entirely — so
  // these are plain divs driven here instead (same reasoning/pattern as
  // job_odyssey_ui.js's jo_dd_* helpers). cvDdGet/cvDdSet/cvDdSetDisabled
  // mirror a native <select>'s .value/.disabled so the rest of this file
  // (prefill on edit, the same-company auto-lock feature, etc.) only
  // needed minimal changes. ──
  function cvDdGet(el) {
    return el ? (el.dataset.value || '') : '';
  }
  function cvDdSet(el, value) {
    if (!el) return;
    value = value == null ? '' : String(value);
    el.dataset.value = value;
    var matched = null;
    el.querySelectorAll('.cv-dd-opt').forEach(function (o) {
      var isMatch = (o.dataset.value || '') === value;
      o.classList.toggle('cv-dd-selected', isMatch);
      if (isMatch) matched = o;
    });
    var valSpan = el.querySelector('.cv-dd-val');
    if (valSpan) {
      var fallback = matched || el.querySelector('.cv-dd-opt');
      valSpan.textContent = fallback ? fallback.textContent.trim() : '';
    }
  }
  function cvDdSetDisabled(el, disabled) {
    if (el) el.classList.toggle('cv-dd-disabled', !!disabled);
  }
  function cvDdCloseAll(content) {
    content.querySelectorAll('.cv-dd.cv-dd-open').forEach(function (dd) { dd.classList.remove('cv-dd-open'); });
  }
  // Binds ONE dropdown with its own onChange — the modal's 5 fields each
  // need a different side effect (or none), unlike the toolbar's two,
  // which both just re-render the list.
  function bindCvDropdown(dd, content, onChange) {
    if (!dd) return;
    var trigger = dd.querySelector('.cv-dd-trigger');
    if (trigger) {
      trigger.addEventListener('click', function (e) {
        if (dd.classList.contains('cv-dd-disabled')) return;
        e.stopPropagation();
        var wasOpen = dd.classList.contains('cv-dd-open');
        cvDdCloseAll(content);
        if (!wasOpen) dd.classList.add('cv-dd-open');
      });
    }
    dd.addEventListener('click', function (e) {
      if (dd.classList.contains('cv-dd-disabled')) return;
      var opt = e.target.closest('.cv-dd-opt');
      if (!opt) return;
      cvDdSet(dd, opt.dataset.value || '');
      dd.classList.remove('cv-dd-open');
      if (onChange) onChange();
    });
  }
  function bindToolbarDropdowns(content, logBtn, onChange) {
    var stageDd = content.querySelector('#cv-dd-stage');
    if (stageDd) {
      var trigger = stageDd.querySelector('.cv-dd-trigger');
      if (trigger) {
        trigger.addEventListener('click', function (e) {
          e.stopPropagation();
          var wasOpen = stageDd.classList.contains('cv-dd-open');
          cvDdCloseAll(content);
          if (!wasOpen) stageDd.classList.add('cv-dd-open');
        });
      }
      // stopPropagation here is required — without it the click bubbles
      // to the document-level cvDdCloseAll listener below and closes the
      // panel after every single toggle, same bug Job Odyssey's status
      // filter had before it was fixed to stay open across multi-picks.
      stageDd.addEventListener('click', function (e) {
        e.stopPropagation();
        var opBtn = e.target.closest('.cv-pg-item[data-op]');
        if (opBtn) {
          stageDd.dataset.op = opBtn.dataset.op;
          stageDd.querySelectorAll('#cv-stage-op-bar .cv-pg-item').forEach(function (b) {
            b.classList.toggle('cv-pg-active', b === opBtn);
          });
          if (logBtn) cvLogPush(logBtn, content, 'Career', 'Stage filter mode set to ' + (opBtn.dataset.op === 'not' ? 'Match None' : 'Match Any'));
          onChange();
          return;
        }
        var opt = e.target.closest('.cv-dd-opt');
        if (!opt) return;
        cv_dd_stage_toggle(stageDd, opt);
        var label = stageDd.querySelector('.cv-dd-val');
        if (logBtn) cvLogPush(logBtn, content, 'Career', 'Stage filter set to ' + (label ? label.textContent : ''));
        onChange();
      });
    }
    var sortDd = content.querySelector('#cv-dd-sort');
    bindCvDropdown(sortDd, content, onChange);
    document.addEventListener('click', function () { cvDdCloseAll(content); });
  }

  // Stage dropdown only: clicking "All stages" toggles between selecting
  // every individual stage and clearing back to none — NOT a plain
  // clear. This matters for Match None: with every stage checked,
  // Match None correctly excludes everything (empty list) instead of
  // "All stages" always meaning "no filter" regardless of mode. A truly
  // empty selection (nothing checked at all) is still the real default
  // — no filter, shows everything either way. Same fix already applied
  // to Job Odyssey's status filter after the same bug showed up there.
  function cv_dd_stage_toggle(dd, opt) {
    var allOpt = dd.querySelector('.cv-dd-opt[data-all="1"]');
    var items = dd.querySelectorAll('.cv-dd-opt:not([data-all="1"])');
    if (opt.dataset.all === '1') {
      var anySelected = Array.prototype.some.call(items, function (o) { return o.classList.contains('cv-dd-selected'); });
      items.forEach(function (o) { o.classList.toggle('cv-dd-selected', !anySelected); });
    } else {
      opt.classList.toggle('cv-dd-selected');
    }
    var selected = Array.prototype.filter.call(items, function (o) { return o.classList.contains('cv-dd-selected'); });
    if (allOpt) allOpt.classList.toggle('cv-dd-selected', selected.length === 0);
    dd.dataset.value = selected.map(function (o) { return o.dataset.value; }).join(',');
    var valSpan = dd.querySelector('.cv-dd-val');
    if (valSpan) {
      if (!selected.length) valSpan.textContent = 'All stages';
      else if (selected.length === items.length) valSpan.textContent = 'All stages (' + items.length + ')';
      else if (selected.length === 1) valSpan.textContent = selected[0].textContent.trim();
      else valSpan.textContent = selected.length + ' selected';
    }
  }

  // ── Toolbar ──
  function bindToolbar($, content, logBtn) {
    var search = $('cv-app-search');
    if (search) search.addEventListener('input', function () { cvAppPage = 1; cvRenderApps($, content); });
    bindToolbarDropdowns(content, logBtn, function () { cvAppPage = 1; cvRenderApps($, content); });
    var siteSearch = $('cv-site-search');
    if (siteSearch) siteSearch.addEventListener('input', function () { cvSitePage = 1; cvRenderSites($, content); });

    var addApp = $('cv-btn-add-app');
    if (addApp) addApp.addEventListener('click', function () { cvOpenAppModal($g, null); });
    var addSite = $('cv-btn-add-site');
    if (addSite) addSite.addEventListener('click', function () { cvOpenSiteModal($, null); });

    var exportApps = $('cv-btn-export-apps');
    if (exportApps) exportApps.addEventListener('click', function () {
      cvAppOpenExport($, content);
      if (logBtn) cvLogPush(logBtn, content, 'Career', 'Applications export wizard opened');
    });
    var exportSites = $('cv-btn-export-sites');
    if (exportSites) exportSites.addEventListener('click', function () {
      cvSiteOpenExport($, content);
      if (logBtn) cvLogPush(logBtn, content, 'Career', 'Job Sites export wizard opened');
    });
  }

  // ── Export ("Cosmic Cargo") — adapters for the shared export_wizard.js engine ──
  var CV_APP_EXPORT_COLUMNS = [
    { key: 'company', label: 'Company' },
    { key: 'link', label: 'Link' },
    { key: 'credential', label: 'Credential' },
    { key: 'credtype', label: 'Credential Detail' },
    { key: 'passhint', label: 'Password Hint' },
    { key: 'role', label: 'Role' },
    { key: 'location', label: 'Location' },
    { key: 'date', label: 'Applied Date' },
    { key: 'stage', label: 'Stage' },
    { key: 'substage', label: 'Substage' },
    { key: 'notes', label: 'Notes' },
    { key: 'ghostedsub', label: 'Ghosted Detail' }
  ];
  var CV_SITE_EXPORT_COLUMNS = [
    { key: 'name', label: 'Site' },
    { key: 'url', label: 'URL' },
    { key: 'cred', label: 'Credential Hint' },
    { key: 'notes', label: 'Notes' }
  ];

  function cvAppOpenExport($, content) {
    window.expOpen({
      title: 'Applications',
      accentColor: '#4ab8ff', // this tab's own blue (matches .cv-dd-trigger, .cv-dd-open focus states)
      columns: CV_APP_EXPORT_COLUMNS,
      filename: 'career_applications_export',
      getCurrentRows: function () { return cvAppExpGetCurrentRows($, content); },
      renderNewFilters: function (container) { cvAppExpRenderFilters(container); },
      getNewRows: cvAppExpGetNewRows
    });
  }

  function cvAppSortRows(filtered, sort) {
    if (sort === 'company_asc') filtered.sort(function (a, b) { return (a.company || '').localeCompare(b.company || ''); });
    if (sort === 'company_desc') filtered.sort(function (a, b) { return (b.company || '').localeCompare(a.company || ''); });
    if (sort === 'date_asc') filtered.sort(function (a, b) { return (a.date || '') > (b.date || '') ? 1 : -1; });
    if (sort === 'date_desc') filtered.sort(function (a, b) { return (a.date || '') < (b.date || '') ? 1 : -1; });
    if (sort === 'stage') filtered.sort(function (a, b) { return (a.stage || '').localeCompare(b.stage || ''); });
  }

  // Client-side, purely in-memory — same architecture as cvRenderApps
  // itself (Career never round-trips to the server for filtering, unlike
  // Job Odyssey). Mirrors cvRenderApps' own filter exactly, but returns
  // every matching row, never capped to one visible page.
  function cvAppExpGetCurrentRows($, content) {
    var q = ($('cv-app-search') || { value: '' }).value.toLowerCase();
    var stageDd = $('cv-dd-stage');
    var stFilt = cvDdGet(stageDd);
    var stageList = stFilt ? stFilt.split(',').filter(function (s) { return s; }) : [];
    var stageOp = (stageDd && stageDd.dataset.op) || 'or';
    var sort = cvDdGet($('cv-dd-sort')) || 'default';
    var filtered = cvApps.filter(function (a) {
      var stageMatch = true;
      if (stageList.length) {
        var inList = stageList.indexOf(a.stage) !== -1;
        stageMatch = (stageOp === 'not') ? !inList : inList;
      }
      return (!q || (a.company || '').toLowerCase().indexOf(q) !== -1 || (a.role || '').toLowerCase().indexOf(q) !== -1) && stageMatch;
    });
    cvAppSortRows(filtered, sort);
    return Promise.resolve(filtered);
  }

  function cvAppExpRenderFilters(container) {
    var sortOpts =
      '<div class="cv-dd-opt cv-dd-selected" data-value="default">Sort: Default</div>' +
      '<div class="cv-dd-opt" data-value="company_asc">Company A&#8594;Z</div>' +
      '<div class="cv-dd-opt" data-value="company_desc">Company Z&#8594;A</div>' +
      '<div class="cv-dd-opt" data-value="date_asc">Date Oldest</div>' +
      '<div class="cv-dd-opt" data-value="date_desc">Date Newest</div>' +
      '<div class="cv-dd-opt" data-value="stage">Stage</div>';
    container.innerHTML =
      '<div class="exp-filter-group">' +
        '<label class="exp-filter-label">Stage</label>' +
        '<div class="exp-status-checks">' +
          ['Applied', 'In Progress', 'Interview', 'Offer', 'Rejected', 'Closed', 'Ghosted', 'Withdrawn', 'NA'].map(function (s) {
            return '<label><input type="checkbox" class="exp-cv-stage" value="' + s + '"> ' + s + '</label>';
          }).join('') +
        '</div>' +
        '<div class="exp-status-op">' +
          '<label><input type="radio" name="exp-cv-stage-op" value="or" checked> Any of these</label>' +
          '<label><input type="radio" name="exp-cv-stage-op" value="not"> None of these</label>' +
        '</div>' +
      '</div>' +
      '<div class="exp-filter-group"><label class="exp-filter-label">Sort</label>' +
        '<div class="cv-dd" id="exp-cv-sort" data-value="default">' +
          '<button type="button" class="cv-dd-trigger">Sort: Default<span class="cv-dd-chev">&#9662;</span></button>' +
          '<div class="cv-dd-panel">' + sortOpts + '</div>' +
        '</div>' +
      '</div>';
    container.querySelectorAll('.cv-dd').forEach(function (dd) { cvExpBindDropdown(dd); });
  }

  // Standalone single-select .cv-dd binder for dropdowns rendered inside
  // the export wizard panel (lives in the shell, outside Career's own
  // #cv-toolbar, so bindToolbarDropdowns()/cvDdCloseAll — both scoped to
  // Career's tab content — can't reach these). Rebuilt fresh via
  // innerHTML every time the panel opens, so there's no duplicate-
  // binding concern the way there was for the persistent Add App modal.
  // Same pattern as Job Odyssey's joExpBindDropdown.
  function cvExpBindDropdown(dd) {
    var trigger = dd.querySelector('.cv-dd-trigger');
    var panel = dd.querySelector('.cv-dd-panel');
    if (trigger) {
      trigger.addEventListener('click', function (e) {
        e.stopPropagation();
        var wasOpen = dd.classList.contains('cv-dd-open');
        document.querySelectorAll('#exp-filters-body .cv-dd.cv-dd-open').forEach(function (o) { o.classList.remove('cv-dd-open'); });
        if (!wasOpen) {
          // position:fixed + coordinates computed here, not CSS
          // position:absolute — the wizard modal has overflow-y:auto
          // (needed so the whole wizard scrolls on tall content), which
          // clips any absolutely-positioned descendant that extends
          // past the modal's own box, no matter the panel's own
          // max-height. Fixed positioning escapes that entirely.
          if (panel) {
            var r = trigger.getBoundingClientRect();
            panel.style.position = 'fixed';
            panel.style.top = (r.bottom + 6) + 'px';
            panel.style.left = r.left + 'px';
            panel.style.width = r.width + 'px';
            panel.style.maxHeight = Math.max(120, window.innerHeight - r.bottom - 20) + 'px';
          }
          dd.classList.add('cv-dd-open');
        }
      });
    }
    dd.addEventListener('click', function (e) {
      e.stopPropagation();
      var opt = e.target.closest('.cv-dd-opt');
      if (!opt) return;
      dd.dataset.value = opt.dataset.value || '';
      var label = opt.textContent.trim();
      if (trigger) trigger.innerHTML = esc(label) + '<span class="cv-dd-chev">&#9662;</span>';
      dd.querySelectorAll('.cv-dd-opt').forEach(function (o) { o.classList.toggle('cv-dd-selected', o === opt); });
      dd.classList.remove('cv-dd-open');
    });
  }

  function cvAppExpGetNewRows() {
    var stageVals = Array.prototype.slice.call(document.querySelectorAll('.exp-cv-stage:checked')).map(function (c) { return c.value; });
    var opEl = document.querySelector('input[name="exp-cv-stage-op"]:checked');
    var stageOp = opEl ? opEl.value : 'or';
    var sortDd = document.getElementById('exp-cv-sort');
    var sort = sortDd ? sortDd.dataset.value : 'default';
    var filtered = cvApps.filter(function (a) {
      if (!stageVals.length) return true;
      var inList = stageVals.indexOf(a.stage) !== -1;
      return stageOp === 'not' ? !inList : inList;
    });
    cvAppSortRows(filtered, sort);
    return Promise.resolve(filtered);
  }

  function cvSiteOpenExport($, content) {
    window.expOpen({
      title: 'Job Sites',
      accentColor: '#4ab8ff', // same tab, same accent as Applications' export
      columns: CV_SITE_EXPORT_COLUMNS,
      filename: 'career_job_sites_export',
      skipChoice: true,   // no real filters exist here — skip straight to Sort, matching source
      renderNewFilters: function (container) { cvSiteExpRenderFilters(container); },
      getNewRows: function () { return cvSiteExpGetNewRows($, content); }
    });
  }

  function cvSiteExpRenderFilters(container) {
    var sortOpts =
      '<div class="cv-dd-opt cv-dd-selected" data-value="added">As added</div>' +
      '<div class="cv-dd-opt" data-value="name_asc">Name A&#8594;Z</div>' +
      '<div class="cv-dd-opt" data-value="name_desc">Name Z&#8594;A</div>';
    container.innerHTML =
      '<div class="exp-filter-group"><label class="exp-filter-label">Sort</label>' +
        '<div class="cv-dd" id="exp-site-sort" data-value="added">' +
          '<button type="button" class="cv-dd-trigger">As added<span class="cv-dd-chev">&#9662;</span></button>' +
          '<div class="cv-dd-panel">' + sortOpts + '</div>' +
        '</div>' +
      '</div>';
    container.querySelectorAll('.cv-dd').forEach(function (dd) { cvExpBindDropdown(dd); });
  }

  function cvSiteExpGetNewRows($, content) {
    // Still respects whatever's typed in the search box, same reasoning
    // as source: it's the one real narrowing control this tab has, and
    // the Current/New split only ever mattered here for the sort choice.
    var q = ($('cv-site-search') || { value: '' }).value.toLowerCase();
    var sortDd = document.getElementById('exp-site-sort');
    var sort = sortDd ? sortDd.dataset.value : 'added';
    var rows = cvSites.filter(function (s) { return !q || (s.name || '').toLowerCase().indexOf(q) !== -1; });
    if (sort === 'name_asc') rows.sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
    if (sort === 'name_desc') rows.sort(function (a, b) { return (b.name || '').localeCompare(a.name || ''); });
    return Promise.resolve(rows);
  }

  // ── Stats ──
  function cvUpdateStats(content) {
    var el = content.querySelector('#cv-stats');
    if (!el) return;

    var c = { total: 0, applied: 0, inprogress: 0, interview: 0, offer: 0, rejected: 0, closed: 0, ghosted: 0, withdrawn: 0, na: 0 };
    cvApps.forEach(function (a) {
      c.total++;
      var s = (a.stage || '').toLowerCase().replace(/ /g, '');
      if (c.hasOwnProperty(s)) c[s]++;
    });

    var iconDoc = '<svg class="cv-stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
    var iconSend = '<svg class="cv-stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>';
    var iconClock = '<svg class="cv-stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';
    var iconMic = '<svg class="cv-stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>';
    var iconStar = '<svg class="cv-stat-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.9-6.2-3.3-6.2 3.3 1.2-6.9-5-4.9 6.9-1z"/></svg>';
    var iconX = '<svg class="cv-stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    var iconArchive = '<svg class="cv-stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><line x1="10" y1="13" x2="14" y2="13"/></svg>';
    var iconGhost = '<svg class="cv-stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 10h.01M15 10h.01M12 2a7 7 0 0 0-7 7v11l2-1.5L9 20l3-1.5L15 20l2-1.5 2 1.5V9a7 7 0 0 0-7-7z"/></svg>';
    var iconMinus = '<svg class="cv-stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>';
    var iconUndo = '<svg class="cv-stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/></svg>';

    el.innerHTML =
      cvStatCardHtml('cv-silver', iconDoc, c.total, 'Total') +
      cvStatCardHtml('cv-blue', iconSend, c.applied, 'Applied') +
      cvStatCardHtml('cv-purple', iconClock, c.inprogress, 'In Progress') +
      cvStatCardHtml('cv-orange', iconMic, c.interview, 'Interview') +
      '<div class="cv-stat cv-offer">' + iconStar + '<div class="cv-num">' + c.offer + '</div><div class="cv-lbl">Offer</div></div>' +
      cvStatCardHtml('cv-red', iconX, c.rejected, 'Rejected') +
      cvStatCardHtml('cv-gray', iconArchive, c.closed, 'Closed') +
      cvStatCardHtml('cv-gray', iconGhost, c.ghosted, 'Ghosted') +
      cvStatCardHtml('cv-gray', iconMinus, c.na, 'NA') +
      cvStatCardHtml('cv-orange', iconUndo, c.withdrawn, 'Withdrawn');
  }
  // Text on the left, icon filling the remaining space on the right —
  // every card except the centered circular Offer card (built inline
  // above, untouched).
  function cvStatCardHtml(colorClass, icon, num, label) {
    return '<div class="cv-stat ' + colorClass + '"><div class="cv-stat-text"><div class="cv-num">' + num + '</div><div class="cv-lbl">' + label + '</div></div>' + icon + '</div>';
  }

  // ── Applications render ──
  function cvStageBadge(s) {
    var cls = (s || '').toLowerCase().replace(/ /g, '').replace('/', '');
    return '<span class="cv-stage-badge ' + cls + '">' + esc(s || '—') + '</span>';
  }
  function cvCredBadge(c) { return c ? '<span class="cv-cred-badge">' + esc(c) + '</span>' : '—'; }

  // Same pill-bar pattern as Job Odyssey's joRenderPagination (arrows +
  // circular page numbers + ellipsis dots for gaps, active page filled
  // solid) — was previously a row of flat individual buttons.
  function renderPagination(container, cur, total, onPage) {
    if (!container) return;
    if (total <= 1) { container.innerHTML = ''; return; }

    var pages = [];
    pages.push(1);
    for (var p = cur - 2; p <= cur + 2; p++) if (p > 1 && p < total) pages.push(p);
    if (total > 1) pages.push(total);
    pages = pages.filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; });

    var html = '<div class="cv-pg-bar">';
    html += '<div class="cv-pg-arrow" data-pg="' + Math.max(1, cur - 1) + '">&#8249;</div>';
    var prev = null;
    pages.forEach(function (p) {
      if (prev !== null && p - prev > 1) html += '<div class="cv-pg-dots">&middot;&middot;&middot;</div>';
      html += '<div class="cv-pg-item' + (p === cur ? ' cv-pg-active' : '') + '" data-pg="' + p + '">' + p + '</div>';
      prev = p;
    });
    html += '<div class="cv-pg-arrow" data-pg="' + Math.min(total, cur + 1) + '">&#8250;</div>';
    html += '</div>';
    container.innerHTML = html;

    container.querySelectorAll('[data-pg]').forEach(function (el) {
      el.addEventListener('click', function () {
        var p = parseInt(el.dataset.pg, 10);
        if (p && p !== cur) onPage(p);
      });
    });
  }

  function cvRenderApps($, content) {
    cvUpdateStats(content);
    var q = ($('cv-app-search') || { value: '' }).value.toLowerCase();
    var stageDd = $('cv-dd-stage');
    var stFilt = cvDdGet(stageDd);
    var stageList = stFilt ? stFilt.split(',').filter(function (s) { return s; }) : [];
    var stageOp = (stageDd && stageDd.dataset.op) || 'or';
    var sort = cvDdGet($('cv-dd-sort')) || 'default';

    var filtered = cvApps.filter(function (a) {
      var stageMatch = true;
      if (stageList.length) {
        var inList = stageList.indexOf(a.stage) !== -1;
        stageMatch = (stageOp === 'not') ? !inList : inList;
      }
      return (!q || (a.company || '').toLowerCase().indexOf(q) !== -1 || (a.role || '').toLowerCase().indexOf(q) !== -1)
          && stageMatch;
    });

    if (sort === 'company_asc') filtered.sort(function (a, b) { return (a.company || '').localeCompare(b.company || ''); });
    if (sort === 'company_desc') filtered.sort(function (a, b) { return (b.company || '').localeCompare(a.company || ''); });
    if (sort === 'date_asc') filtered.sort(function (a, b) { return (a.date || '') > (b.date || '') ? 1 : -1; });
    if (sort === 'date_desc') filtered.sort(function (a, b) { return (a.date || '') < (b.date || '') ? 1 : -1; });
    if (sort === 'stage') filtered.sort(function (a, b) { return (a.stage || '').localeCompare(b.stage || ''); });

    var countEl = content.querySelector('#cv-app-count');
    if (countEl) countEl.textContent = filtered.length;

    var tbody = content.querySelector('#cv-app-tbody');
    var empty = content.querySelector('#cv-app-empty');
    var pager = content.querySelector('#cv-app-pagination');
    if (!filtered.length) {
      if (tbody) tbody.innerHTML = '';
      if (empty) empty.style.display = 'block';
      if (pager) pager.innerHTML = '';
      return;
    }
    if (empty) empty.style.display = 'none';

    var groups = [], groupMap = {};
    filtered.forEach(function (a) {
      var key = (a.company || '').toLowerCase().trim();
      if (!groupMap[key]) { groupMap[key] = []; groups.push({ key: key, company: a.company, rows: [] }); }
      groupMap[key].push(a);
    });
    groups.forEach(function (g) {
      // No stable ids anymore — tie-break by array position in cvApps,
      // same as dashboard_career.py's crApps.indexOf() pattern.
      g.rows = groupMap[g.key].slice().sort(function (a, b) {
        var da = a.date || '', db = b.date || '';
        if (da !== db) return da > db ? 1 : -1;
        return cvApps.indexOf(a) - cvApps.indexOf(b);
      });
      var head = g.rows[0];
      g.link = head.link; g.credential = head.credential; g.credtype = head.credtype; g.passhint = head.passhint;
    });

    var totalPages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));
    if (cvAppPage > totalPages) cvAppPage = totalPages;
    if (cvAppPage < 1) cvAppPage = 1;
    var pageGroups = groups.slice((cvAppPage - 1) * PAGE_SIZE, cvAppPage * PAGE_SIZE);

    var html = '';
    pageGroups.forEach(function (g, gi) {
      var roleCount = g.rows.length;
      var stripeClass = gi % 2 === 0 ? 'cv-group-even' : 'cv-group-odd';
      var companyHtml =
        '<div class="cv-company-name">' + cvWrapAtLimit(g.company, 25) + '</div>' +
        (g.link ? '<a class="cv-company-link" href="' + esc(g.link) + '" target="_blank">Open ↗</a>' : '') +
        (roleCount > 1 ? '<div class="cv-role-count">' + roleCount + ' roles</div>' : '');
      var credtypeText = g.credtype === 'With Password' && g.passhint ? 'With Password ' + esc(g.passhint) : esc(g.credtype || '');
      var credHtml = cvCredBadge(g.credential) + '<div class="cv-credtype">' + credtypeText + '</div>';

      g.rows.forEach(function (a, ri) {
        var isFirst = ri === 0;
        var realIdx = cvApps.indexOf(a);
        var rowClass = stripeClass + (isFirst ? ' cv-group-start' : '');
        html +=
          '<tr class="' + rowClass + '">' +
            (isFirst ? '<td>' + companyHtml + '</td>' : '<td></td>') +
            (isFirst ? '<td>' + credHtml + '</td>' : '<td></td>') +
            '<td>' + cvWrapAtLimit(a.role, 39) + '</td>' +
            '<td>' + (a.location ? cvWrapAtLimit(a.location, 21) : '—') + '</td>' +
            '<td>' + (a.date || '—') + '</td>' +
            '<td>' + cvStageBadge(a.stage) +
              (a.stage === 'In Progress' && a.substage ? '<div class="cv-substage">' + esc(a.substage) + '</div>' : '') +
              (a.stage === 'Ghosted' && a.ghostedsub ? '<div class="cv-substage">' + esc(a.ghostedsub) + '</div>' : '') +
            '</td>' +
            '<td><div class="cv-actions">' +
              '<button class="cv-act-btn" data-notes-app="' + realIdx + '" title="View notes">&#128221;</button>' +
              '<button class="cv-act-btn" data-edit-app="' + realIdx + '" title="Edit">&#9998;</button>' +
              '<button class="cv-act-btn cv-del" data-del-app="' + realIdx + '" title="Delete">&#128465;</button>' +
            '</div></td>' +
          '</tr>';
      });
    });
    if (tbody) tbody.innerHTML = html;

    tbody.querySelectorAll('[data-notes-app]').forEach(function (b) {
      b.addEventListener('click', function () { cvToggleNotesRow(b, cvApps[parseInt(b.getAttribute('data-notes-app'), 10)]); });
    });
    tbody.querySelectorAll('[data-edit-app]').forEach(function (b) {
      b.addEventListener('click', function () { cvOpenAppModal($g, parseInt(b.getAttribute('data-edit-app'), 10)); });
    });
    tbody.querySelectorAll('[data-del-app]').forEach(function (b) {
      b.addEventListener('click', function () { cvDeleteApp($, content, parseInt(b.getAttribute('data-del-app'), 10)); });
    });

    renderPagination(pager, cvAppPage, totalPages, function (p) { cvAppPage = p; cvRenderApps($, content); });
  }

  // Toggles a small inline row right below the clicked application row,
  // instead of a popup. Only one open at a time; clicking the same icon
  // again collapses it. Pure DOM manipulation — independent of
  // cvRenderApps' innerHTML rebuild, since it just inserts/removes a
  // sibling <tr>.
  function cvToggleNotesRow(btn, app) {
    var tr = btn.closest('tr');
    var tbody = tr.parentElement;
    var next = tr.nextElementSibling;
    if (next && next.classList.contains('cv-notes-row')) {
      next.remove();
      return;
    }
    var openRow = tbody.querySelector('.cv-notes-row');
    if (openRow) openRow.remove();

    var newRow = document.createElement('tr');
    newRow.className = 'cv-notes-row';
    var td = document.createElement('td');
    td.colSpan = 7;
    var panel = document.createElement('div');
    panel.className = 'cv-notes-panel';

    var jobidCol = document.createElement('div');
    jobidCol.className = 'cv-notes-col cv-notes-jobid';
    jobidCol.innerHTML = '<div class="cv-notes-label">Job ID</div><div class="cv-notes-value">' + esc(app.jobid || '\u2014') + '</div>';

    var notesCol = document.createElement('div');
    notesCol.className = 'cv-notes-col cv-notes-text';
    notesCol.innerHTML = '<div class="cv-notes-label">Notes</div><div class="cv-notes-value">' + (app.notes ? esc(app.notes) : 'No notes for this application.') + '</div>';

    panel.appendChild(jobidCol);
    panel.appendChild(notesCol);
    td.appendChild(panel);
    newRow.appendChild(td);
    tbody.insertBefore(newRow, tr.nextSibling);
  }

  function cvDeleteApp($, content, idx) {
    if (!confirm('Delete this application?')) return;
    var a = cvApps[idx];
    if (!a) return;
    cvApps.splice(idx, 1);
    cvSaveToServer().then(function () {
      cvRenderApps($, content);
      var logBtn = content.closest('.tab-body').querySelector('.log-btn');
      cvLogPush(logBtn, content, 'Career', 'Deleted application: ' + (a.company || '—') + ' — ' + (a.role || '—'));
    });
  }

  // ── Job sites render ──
  function cvRenderSites($, content) {
    var q = ($('cv-site-search') || { value: '' }).value.toLowerCase();
    var filtered = cvSites.filter(function (s) { return !q || (s.name || '').toLowerCase().indexOf(q) !== -1; });
    var countEl = content.querySelector('#cv-site-count');
    if (countEl) countEl.textContent = filtered.length;

    var tbody = content.querySelector('#cv-site-tbody');
    var empty = content.querySelector('#cv-site-empty');
    var pager = content.querySelector('#cv-site-pagination');
    if (!filtered.length) {
      if (tbody) tbody.innerHTML = '';
      if (empty) empty.style.display = 'block';
      if (pager) pager.innerHTML = '';
      return;
    }
    if (empty) empty.style.display = 'none';

    var totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (cvSitePage > totalPages) cvSitePage = totalPages;
    if (cvSitePage < 1) cvSitePage = 1;
    var pageItems = filtered.slice((cvSitePage - 1) * PAGE_SIZE, cvSitePage * PAGE_SIZE);

    if (tbody) tbody.innerHTML = pageItems.map(function (s) {
      var realIdx = cvSites.indexOf(s);
      return '<tr>' +
        '<td><div class="cv-company-name">' + esc(s.name) + '</div>' +
          (s.url ? '<a class="cv-company-link" href="' + esc(s.url) + '" target="_blank">Open ↗</a>' : '') + '</td>' +
        '<td>' + esc(s.cred || '—') + '</td>' +
        '<td>' + esc(s.notes || '—') + '</td>' +
        '<td><div class="cv-actions">' +
          '<button class="cv-act-btn" data-edit-site="' + realIdx + '">&#9998;</button>' +
          '<button class="cv-act-btn cv-del" data-del-site="' + realIdx + '">&#128465;</button>' +
        '</div></td></tr>';
    }).join('');

    tbody.querySelectorAll('[data-edit-site]').forEach(function (b) {
      b.addEventListener('click', function () { cvOpenSiteModal($, parseInt(b.getAttribute('data-edit-site'), 10)); });
    });
    tbody.querySelectorAll('[data-del-site]').forEach(function (b) {
      b.addEventListener('click', function () { cvDeleteSite($, content, parseInt(b.getAttribute('data-del-site'), 10)); });
    });

    renderPagination(pager, cvSitePage, totalPages, function (p) { cvSitePage = p; cvRenderSites($, content); });
  }

  function cvDeleteSite($, content, idx) {
    if (!confirm('Delete this site?')) return;
    var s = cvSites[idx];
    if (!s) return;
    cvSites.splice(idx, 1);
    cvSaveToServer().then(function () {
      cvRenderSites($, content);
      var logBtn = content.closest('.tab-body').querySelector('.log-btn');
      cvLogPush(logBtn, content, 'Career', 'Deleted site: ' + (s.name || '—'));
    });
  }

  // ── Modals ──
  // Add Application modal's own bindings live in initGlobalAppModal()
  // below (bound once, unconditionally, at file load) since that modal
  // is now in the persistent shell, not this fragment. Add Job Site
  // stays here — it's only ever opened from inside Career's own tab,
  // and its fragment (with fresh listeners) is rebuilt every visit like
  // any other tab-local element.
  function bindModals($, content, logBtn) {
    var siteOverlay = $('cv-site-modal');
    var closeSite = function () { cvCloseModal($, siteOverlay); };
    if ($('cv-site-modal-close')) $('cv-site-modal-close').addEventListener('click', closeSite);
    if ($('cv-site-modal-cancel')) $('cv-site-modal-cancel').addEventListener('click', closeSite);
    if ($('cv-site-modal-save')) $('cv-site-modal-save').addEventListener('click', function () { cvSaveSite($, content, logBtn); });
  }

  // Add Application modal + its URL-conflict popup: bound exactly once,
  // here, at script load — NOT inside initCareerVoyagerUi(), which only
  // runs while Career is the active tab and would (a) never bind these
  // listeners at all if Career is never visited this session, and (b)
  // re-bind duplicate listeners on every Career revisit once the modal
  // no longer gets destroyed/recreated per tab-swap like a normal
  // fragment element does.
  function initGlobalAppModal() {
    var appOverlay = $g('cv-app-modal');
    if (!appOverlay) return; // shell markup missing — nothing to bind

    var closeApp = function () { cvCloseModal($g, appOverlay); };
    if ($g('cv-app-modal-close')) $g('cv-app-modal-close').addEventListener('click', closeApp);
    if ($g('cv-app-modal-cancel')) $g('cv-app-modal-cancel').addEventListener('click', closeApp);
    if ($g('cv-app-modal-save')) $g('cv-app-modal-save').addEventListener('click', function () { cvSaveApp(); });

    // document, not a tab's content — the modal's own dropdowns need to
    // close each other regardless of which tab happens to be showing
    // underneath them.
    bindCvDropdown($g('cv-af-stage'), document, function () { cvCheckStageSub($g); });
    bindCvDropdown($g('cv-af-cred'), document, function () { cvCheckCredSub($g); });
    bindCvDropdown($g('cv-af-credtype'), document, function () { cvCheckCredSub($g); });
    bindCvDropdown($g('cv-af-substage'), document, null);
    bindCvDropdown($g('cv-af-ghosted-sub'), document, null);
    if ($g('cv-af-company')) $g('cv-af-company').addEventListener('blur', function () { cvCheckCompanyName($g); });
    if ($g('cv-af-link')) $g('cv-af-link').addEventListener('blur', function () { cvCheckUrl($g); });

    var ok = $g('cv-url-popup-ok');
    if (ok) ok.addEventListener('click', function () {
      $g('cv-url-popup').style.display = 'none';
      $g('cv-popup-overlay').style.display = 'none';
    });
  }

  function cvCloseModal($, overlay) {
    overlay.classList.remove('cv-open');
    var sr = $('cv-af-substage-row'); if (sr) sr.classList.remove('cv-visible');
    var gr = $('cv-af-ghosted-row'); if (gr) gr.classList.remove('cv-visible');
    var cr = $('cv-af-credtype-row'); if (cr) cr.classList.remove('cv-visible');
    cvUnlockCompanyFields($);
  }

  function cvCheckStageSub($) {
    var stage = cvDdGet($('cv-af-stage'));
    var ipRow = $('cv-af-substage-row'), ghRow = $('cv-af-ghosted-row');
    if (ipRow) ipRow.classList.toggle('cv-visible', stage === 'In Progress');
    if (ghRow) ghRow.classList.toggle('cv-visible', stage === 'Ghosted');
  }
  function cvCheckCredSub($) {
    var cred = cvDdGet($('cv-af-cred'));
    var row = $('cv-af-credtype-row'), passRow = $('cv-af-credpass-row');
    if (row) row.classList.toggle('cv-visible', cred === 'Registered');
    if (passRow) {
      var credtype = cvDdGet($('cv-af-credtype'));
      passRow.style.display = (cred === 'Registered' && credtype === 'With Password') ? 'block' : 'none';
    }
  }

  function cvFindByCompany(name) {
    var key = (name || '').toLowerCase().trim();
    return cvApps.find(function (a) { return (a.company || '').toLowerCase().trim() === key; }) || null;
  }
  function cvFindByUrl(url) {
    var u = (url || '').trim().toLowerCase();
    if (!u) return null;
    return cvApps.find(function (a) { return (a.link || '').trim().toLowerCase() === u; }) || null;
  }
  function cvLockCompanyFields($, app) {
    $('cv-af-link').value = app.link || '';
    cvDdSet($('cv-af-cred'), app.credential || '');
    cvDdSet($('cv-af-credtype'), app.credtype || '');
    $('cv-af-credpass').value = app.passhint || '';
    $('cv-af-link').disabled = true; cvDdSetDisabled($('cv-af-cred'), true);
    cvDdSetDisabled($('cv-af-credtype'), true); $('cv-af-credpass').disabled = true;
    cvLockedCompany = (app.company || '').toLowerCase().trim();
    cvCheckCredSub($);
  }
  function cvUnlockCompanyFields($) {
    ['cv-af-link', 'cv-af-credpass'].forEach(function (id) {
      var el = $(id); if (el) el.disabled = false;
    });
    cvDdSetDisabled($('cv-af-cred'), false);
    cvDdSetDisabled($('cv-af-credtype'), false);
    cvLockedCompany = null;
  }
  function cvCheckCompanyName($) {
    if (cvEditAppIdx !== null) return;
    var name = $('cv-af-company').value.trim();
    if (!name) { cvUnlockCompanyFields($); return; }
    var existing = cvFindByCompany(name);
    if (existing) cvLockCompanyFields($, existing); else cvUnlockCompanyFields($);
  }
  function cvCheckUrl($) {
    if (cvEditAppIdx !== null) return;
    var url = $('cv-af-link').value.trim();
    if (!url) return;
    var existing = cvFindByUrl(url);
    if (!existing) return;
    var typedName = $('cv-af-company').value.trim().toLowerCase();
    if (typedName === (existing.company || '').toLowerCase().trim()) return;
    $('cv-url-popup-msg').textContent = 'This URL already exists under "' + existing.company + '". Switching to that company.';
    $('cv-url-popup').style.display = 'block';
    $('cv-popup-overlay').style.display = 'block';
    $('cv-af-company').value = existing.company;
    cvLockCompanyFields($, existing);
  }

  // ── Open App Modal, pre-filled from Job Odyssey ──
  // Exposed on window (see bottom of file) so Job Odyssey's Applied
  // button can call it directly — the modal is global now (lives in
  // html/shell.html), so no tab switch is needed, and this tab's own
  // state/undo-bar is left completely untouched. cvEnsureLoaded() first
  // guarantees cvApps reflects the server even if Career was never
  // opened this session (see that function's comment for why that
  // matters) — same ordering as source's `await crEnsureLoaded()`.
  function cvOpenAppModalPrefill(data) {
    cvEnsureLoaded().then(function () {
      data = data || {};
      cvOpenAppModal($g, null); // blank modal, resets locks/edit state
      $g('cv-af-company').value = data.company || '';
      $g('cv-af-role').value = data.role || '';
      $g('cv-af-location').value = data.location || '';
      $g('cv-af-date').value = data.date || '';
      cvCheckStageSub($g);
      // reuse existing link/credential if this company already has an entry
      // (this may overwrite the link field above if a match is found — intentional)
      cvCheckCompanyName($g);
    });
  }

  function cvOpenAppModal($, idx) {
    cvEditAppIdx = idx;
    var a = idx !== null ? cvApps[idx] : {};
    a = a || {};
    $('cv-app-modal-title').textContent = idx !== null ? 'Edit application' : 'Add application';
    cvUnlockCompanyFields($); cvLockedCompany = null;

    $('cv-af-company').value = a.company || '';
    $('cv-af-link').value = a.link || '';
    cvDdSet($('cv-af-cred'), a.credential || '');
    cvDdSet($('cv-af-credtype'), a.credtype || '');
    $('cv-af-credpass').value = a.passhint || '';
    $('cv-af-role').value = a.role || '';
    $('cv-af-location').value = a.location || '';
    $('cv-af-date').value = a.date || '';
    cvDdSet($('cv-af-stage'), a.stage || '');
    cvDdSet($('cv-af-substage'), a.substage || '');
    cvDdSet($('cv-af-ghosted-sub'), a.ghostedsub || '');
    $('cv-af-jobid').value = a.jobid || '';
    $('cv-af-notes').value = a.notes || '';

    if (idx !== null) {
      // Same-company lock, tie-broken by array position (no stable ids).
      var key = (a.company || '').toLowerCase().trim();
      var sameCompany = cvApps.filter(function (x) { return (x.company || '').toLowerCase().trim() === key; });
      sameCompany.sort(function (x, y) { return cvApps.indexOf(x) - cvApps.indexOf(y); });
      if (sameCompany[0] && sameCompany[0] !== a) {
        var first = sameCompany[0];
        $('cv-af-link').value = first.link || '';
        cvDdSet($('cv-af-cred'), first.credential || '');
        cvDdSet($('cv-af-credtype'), first.credtype || '');
        $('cv-af-credpass').value = first.passhint || '';
        $('cv-af-link').disabled = true; cvDdSetDisabled($('cv-af-cred'), true);
        cvDdSetDisabled($('cv-af-credtype'), true); $('cv-af-credpass').disabled = true;
      }
    }

    cvCheckStageSub($); cvCheckCredSub($);
    $('cv-app-modal').classList.add('cv-open');
  }

  function cvSaveApp() {
    var $ = $g;
    var company = $('cv-af-company').value.trim();
    var role = $('cv-af-role').value.trim();
    if (!company || !role) { alert('Company and role are required.'); return; }

    var credtype = cvDdGet($('cv-af-credtype'));
    var credpass = credtype === 'With Password' ? $('cv-af-credpass').value.trim() : '';

    var obj = {
      company: company, link: $('cv-af-link').value.trim(), credential: cvDdGet($('cv-af-cred')),
      credtype: credtype, passhint: credpass, role: role, location: $('cv-af-location').value.trim(),
      date: $('cv-af-date').value, stage: cvDdGet($('cv-af-stage')), substage: cvDdGet($('cv-af-substage')),
      notes: $('cv-af-notes').value.trim(), ghostedsub: cvDdGet($('cv-af-ghosted-sub')),
      jobid: $('cv-af-jobid').value.trim()
    };

    // If company locked, sync link/credential fields into ALL matching
    // rows in-memory before the single save below (no more per-row PUTs).
    if (cvLockedCompany) {
      cvApps.forEach(function (a) {
        if ((a.company || '').toLowerCase().trim() === cvLockedCompany) {
          a.link = obj.link; a.credential = obj.credential; a.credtype = obj.credtype; a.passhint = obj.passhint;
        }
      });
    }

    var isEdit = cvEditAppIdx !== null;
    if (isEdit) cvApps[cvEditAppIdx] = obj; else cvApps.push(obj);

    cvSaveToServer().then(function () {
      cvCloseModal($, $('cv-app-modal'));
      var logMsg = (isEdit ? 'Updated application: ' : 'Added application: ') + obj.company + ' — ' + obj.role + ' (' + (obj.stage || 'no stage') + ')';
      // Career's own list/badge only exist in the DOM while Career is
      // the tab actually on screen (e.g. opened via Job Odyssey's
      // Applied button while looking at Job Odyssey). The save itself
      // and the in-memory cvApps update above already happened either
      // way — this just decides whether there's a visible list/badge
      // to refresh right now. The entry still lands in cvLogEntries
      // (module-level, persists across tabs) so it shows up next time
      // Career's own log panel opens, even when skipped here.
      var ctx = cvActiveCareerContext();
      if (ctx) {
        cvRenderApps(ctx.$, ctx.content);
        cvLogPush(ctx.logBtn, ctx.content, 'Career', logMsg);
      } else {
        cvLogEntries.push({ ts: new Date().toLocaleTimeString(), source: 'Career', message: logMsg });
        if (cvLogEntries.length > 300) cvLogEntries.shift();
      }
    });
  }

  function cvOpenSiteModal($, idx) {
    cvEditSiteIdx = idx;
    var s = idx !== null ? cvSites[idx] : {};
    s = s || {};
    $('cv-site-modal-title').textContent = idx !== null ? 'Edit site' : 'Add job site';
    $('cv-sf-name').value = s.name || '';
    $('cv-sf-url').value = s.url || '';
    $('cv-sf-cred').value = s.cred || '';
    $('cv-sf-notes').value = s.notes || '';
    $('cv-site-modal').classList.add('cv-open');
  }
  function cvSaveSite($, content, logBtn) {
    var name = $('cv-sf-name').value.trim();
    if (!name) { alert('Site name is required.'); return; }
    var obj = { name: name, url: $('cv-sf-url').value.trim(), cred: $('cv-sf-cred').value.trim(), notes: $('cv-sf-notes').value.trim() };
    var isEdit = cvEditSiteIdx !== null;
    if (isEdit) cvSites[cvEditSiteIdx] = obj; else cvSites.unshift(obj);

    cvSaveToServer().then(function () {
      cvCloseModal($, $('cv-site-modal'));
      cvRenderSites($, content);
      cvLogPush(logBtn, content, 'Career', (isEdit ? 'Updated site: ' : 'Added site: ') + obj.name);
    });
  }

  window.__solarisInit = window.__solarisInit || {};
  window.__solarisInit.careerVoyagerUi = initCareerVoyagerUi;

  // The Add Application modal lives in the persistent shell (see
  // html/shell.html), not this tab's fragment — it needs exactly one
  // binding pass for its whole lifetime, run unconditionally here
  // rather than from initCareerVoyagerUi (which only fires while
  // Career is the active tab, and re-fires on every revisit).
  window.cvOpenAppModalPrefill = cvOpenAppModalPrefill;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      initCareerVoyagerUi();
      initGlobalAppModal();
    });
  } else {
    initCareerVoyagerUi();
    initGlobalAppModal();
  }
})();

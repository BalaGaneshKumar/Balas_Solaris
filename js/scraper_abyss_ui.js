/* scraper_abyss_ui.js — Scraper Abyss tab page: BEHAVIOR ONLY.
   All markup for this page lives in the single
   html/fragments/scraper_abyss.html file (sa_header()/sa_log()/
   sa_content() macros), rendered server-side by tab.html's Jinja
   conditionals when current_key == 'scraper-abyss'.

   Activity Log is now server-backed (py/scraper_activity_log.py via
   py/scraper_abyss_api.py's GET/POST /scraper-activity-log) instead of
   the old in-memory-only buffer — this tab now has a real mechanism
   behind it (py/workflow_engine.py logs its own lifecycle events —
   started/completed/failed/held/etc — straight into this same feed,
   see that file's _activity()), so client-only storage would miss
   everything the engine itself reports. Client-side UI events (tab
   switch, log panel open/close) still get logged the same way they
   always did, just via a POST instead of a local push. While the
   panel is open, it polls every 5s so server-side engine events show
   up without the person needing to toggle the panel closed/open again
   — same polling convention as js/scraper_workflows_table_ui.js's
   Auto Refresh.

   Also owns a small toast-notification helper (window.
   SolarisScraperToast) that js/scraper_requests_ui.js calls right
   after a Beacon submit succeeds or fails — added because without
   any visible confirmation, a submit that failed silently (or even
   one that worked) was indistinguishable from a page that just sat
   there; the person had no way to tell whether anything happened
   short of manually digging through Hyperlane or the log panel.

   Registered on window.__solarisInit like every other planet/tab file
   (see tab.js, job_odyssey_ui.js, career_voyager_ui.js,
   profile_nexus_ui.js) so router.js re-runs it after each SPA fragment
   swap. Self-guards on .tab-body[data-current-planet="scraper-abyss"]
   so it's a no-op on the other 3 tab pages. */
(function () {
  'use strict';

  var saLogOpen = false;
  var saPollTimer = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Toast notifications — "was my request actually submitted?"
  // feedback for Beacon (js/scraper_requests_ui.js calls
  // window.SolarisScraperToast after every submit, success or
  // failure). Fixed to the viewport rather than scoped inside either
  // panel so it's visible no matter which of Beacon/Hyperlane is
  // showing, and survives the Beacon->Hyperlane switch without being
  // torn down mid-display. Built once, reused for every call. ──
  var saToastStack = null;
  function ensureToastStack() {
    if (saToastStack && document.body.contains(saToastStack)) return saToastStack;
    saToastStack = document.createElement('div');
    saToastStack.className = 'sa-toast-stack';
    document.body.appendChild(saToastStack);
    return saToastStack;
  }
  function saShowToast(message, kind) {
    var stack = ensureToastStack();
    var toast = document.createElement('div');
    toast.className = 'sa-toast sa-toast-' + (kind === 'error' ? 'error' : 'success');
    toast.innerHTML =
      '<span class="sa-toast-icon">' + (kind === 'error'
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><line x1="9" y1="9" x2="15" y2="15"></line><line x1="15" y1="9" x2="9" y2="15"></line></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M7 12.5l3 3 7-8"></path></svg>') +
      '</span><span class="sa-toast-msg"></span>' +
      '<button type="button" class="sa-toast-close" aria-label="Dismiss">&times;</button>';
    toast.querySelector('.sa-toast-msg').textContent = message; // textContent, not innerHTML — message may echo back user-entered keywords/locations
    stack.appendChild(toast);
    requestAnimationFrame(function () { toast.classList.add('sa-toast-in'); });

    var dismissTimer = setTimeout(function () { dismiss(); }, 6000);
    function dismiss() {
      clearTimeout(dismissTimer);
      toast.classList.remove('sa-toast-in');
      setTimeout(function () { toast.remove(); }, 200);
    }
    toast.querySelector('.sa-toast-close').addEventListener('click', dismiss);
  }
  window.SolarisScraperToast = saShowToast;

  function initScraperAbyssUi() {
    var root = document.querySelector('.tab-body[data-current-planet="scraper-abyss"]');
    if (!root) return; // not this page — no-op, same guard pattern as the other 3 tabs

    // Normalize the bare /scraper-abyss URL to /scraper-abyss/request —
    // Beacon is already the preselected default panel (server-rendered
    // visible, tab pill already marked active), so the address bar
    // should say so too. replaceState, not pushState/navigate — this
    // corrects the CURRENT URL to match what's already on screen, no
    // new history entry, no re-render.
    if (window.location.pathname === '/solaris/scraper-abyss') {
      history.replaceState(null, '', '/solaris/scraper-abyss/request');
    }

    var logBtn = root.querySelector('.log-btn');
    var content = root.querySelector('.tab-content');

    // Tab-switching must work even if the log button/content lookup
    // ever comes back empty — it used to be gated behind that lookup,
    // which meant a single missing element silently killed BOTH
    // buttons' click handlers (invisible on Beacon, since it's already
    // active by default and looks the same whether its listener fired
    // or not — only Hyperlane's failure to switch was visible).
    bindTabs(root, logBtn, content);

    if (logBtn && content) {
      bindLogButton(logBtn, content);
      saRefreshBadgeOnly(logBtn);
    }
  }

  // ── Beacon/Hyperlane pill row (see sa_header() in scraper_abyss.html).
  // Panel visibility swap unchanged; the switch itself now also gets
  // recorded server-side via saLogPush. ──
  // ── Beacon/Hyperlane pill row (see sa_header() in scraper_abyss.html).
  // Panel visibility swap unchanged (pure client-side, no data loss,
  // no round trip); NEW is the URL update via history.pushState so
  // the address bar reflects which sub-tab is showing (Beacon ->
  // /scraper-abyss/request, Hyperlane -> /scraper-abyss/workflow) —
  // deliberately NOT routed through window.SolarisRouter.navigate(),
  // which would re-fetch and rebuild this whole tab from the server
  // just to change what's already an instant local toggle. Direct
  // links/bookmarks/refresh to either URL still work correctly since
  // solaris.py has real routes for both (see SCRAPER_ABYSS_SUBTABS)
  // that server-render with the right panel already visible. ──
  var SA_SUB_URL = { beacon: '/solaris/scraper-abyss/request', hyperlane: '/solaris/scraper-abyss/workflow' };

  function bindTabs(root, logBtn, content) {
    var tabsContainer = root.querySelector('.sa-tabs');
    if (!tabsContainer) return;
    tabsContainer.addEventListener('click', function (e) {
      var tab = e.target.closest('.sa-tab');
      if (!tab || tab.classList.contains('sa-tab-active')) return;
      tabsContainer.querySelectorAll('.sa-tab').forEach(function (t) { t.classList.remove('sa-tab-active'); });
      tab.classList.add('sa-tab-active');

      var which = tab.dataset.saTab;
      var beaconPanel = content.querySelector('#sa-panel-beacon');
      var hyperlanePanel = content.querySelector('#sa-panel-hyperlane');
      if (beaconPanel) beaconPanel.style.display = which === 'beacon' ? 'block' : 'none';
      if (hyperlanePanel) hyperlanePanel.style.display = which === 'hyperlane' ? 'block' : 'none';

      var url = SA_SUB_URL[which];
      if (url && window.location.pathname !== url) {
        history.pushState(null, '', url);
      }

      if (logBtnRef && content) {
        var label = tab.querySelector('span:last-child');
        saLogPush(logBtnRef, content, 'Switched to ' + (label ? label.textContent.trim() : which));
      }
    });
  }
  var logBtnRef = null; // set in bindLogButton — bindTabs needs it too, and both run off the same root lookup

  // ── Server-backed activity log ───────────────────────────────────
  var saLogVisible = 15; // pagination window — grows via "Load more", see saRenderLogList

  function saLogPush(logBtn, content, message) {
    fetch('/solaris/api/scraper-activity-log', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'ScraperAbyss', message: message })
    }).then(function () { saLoadLog(logBtn, content); }).catch(function () {});
  }

  function saLoadLog(logBtn, content) {
    fetch('/solaris/api/scraper-activity-log')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var entries = (d.logs || []).slice().reverse(); // newest first, same order the old in-memory unshift() produced
        saRenderLogBadge(logBtn, entries.length);
        if (saLogOpen) saRenderLogList(content, entries);
      })
      .catch(function () {});
  }

  function saRefreshBadgeOnly(logBtn) {
    fetch('/solaris/api/scraper-activity-log')
      .then(function (r) { return r.json(); })
      .then(function (d) { saRenderLogBadge(logBtn, (d.logs || []).length); })
      .catch(function () {});
  }

  function saRenderLogBadge(logBtn, count) {
    var badge = logBtn.querySelector('#sa-log-count');
    if (!badge) return;
    badge.textContent = count;
    badge.setAttribute('data-empty', count ? '0' : '1');
  }

  function saRenderLogList(content, entries) {
    var list = content.querySelector('#sa-log-list');
    var countHeader = content.querySelector('#sa-log-list-count');
    if (countHeader) countHeader.textContent = entries.length;
    if (!list) return;
    if (!entries.length) {
      list.innerHTML = '<div class="sa-log-entry">No activity yet.</div>';
      return;
    }
    var visible = entries.slice(0, saLogVisible);
    var html = visible.map(function (e) {
      return '<div class="sa-log-entry"><span class="sa-log-time">' + esc(e.ts) + '</span>' + esc(e.message) + '</div>';
    }).join('');
    if (entries.length > saLogVisible) {
      html += '<button type="button" class="sa-log-more" id="sa-log-more">Load more (' + (entries.length - saLogVisible) + ' remaining)</button>';
    }
    list.innerHTML = html;
    var moreBtn = list.querySelector('#sa-log-more');
    if (moreBtn) moreBtn.addEventListener('click', function () { saLogVisible += 15; saLoadLog(logBtnRef, content); });
  }

  function bindLogButton(logBtn, content) {
    logBtnRef = logBtn;
    // Turning Auto Refresh back on catches the log up right away instead of
    // waiting for the next 5s tick.
    var autoToggle = document.querySelector('#wt-auto-refresh input');
    if (autoToggle) autoToggle.addEventListener('change', function () {
      if (autoToggle.checked && saLogOpen) saLoadLog(logBtn, content);
    });
    logBtn.addEventListener('click', function () {
      saLogOpen = !saLogOpen;
      logBtn.classList.toggle('sa-open', saLogOpen);
      var panel = content.querySelector('#sa-log-panel');
      if (panel) panel.style.display = saLogOpen ? 'block' : 'none';
      // saLogPush re-renders the list for us when saLogOpen is true, so
      // this one line records the open/close AND shows it immediately.
      saLogPush(logBtn, content, saLogOpen ? 'Opened activity log' : 'Closed activity log');

      clearInterval(saPollTimer);
      if (saLogOpen) {
        // Picks up server-side engine events (workflow started/
        // completed/etc, logged directly by py/workflow_engine.py)
        // while the panel is sitting open, same polling convention as
        // js/scraper_workflows_table_ui.js's Auto Refresh.
        // Follows the Hyperlane Auto Refresh toggle: with it switched off the
        // list is left untouched, so text in the log can be selected and
        // copied (every refresh rebuilds the list, which clears a selection).
        saPollTimer = setInterval(function () {
          var autoBox = document.querySelector('#wt-auto-refresh input');
          if (autoBox && !autoBox.checked) return;
          saLoadLog(logBtn, content);
        }, 5000);
      }
    });
  }

  window.__solarisInit = window.__solarisInit || {};
  window.__solarisInit.scraperAbyssUi = initScraperAbyssUi;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initScraperAbyssUi);
  } else {
    initScraperAbyssUi();
  }
})();

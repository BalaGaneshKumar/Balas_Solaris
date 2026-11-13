/* scraper_workflows_table_ui.js — Workflows (Hyperlane) table
   behavior: status legend filter toggle, Refresh, and Auto Refresh.

   Mechanism ported from the source dashboard's saLoadWorkflows() —
   Refresh and Auto Refresh do a real fetch() against /api/workflow-list
   (py/scraper_abyss_api.py -> py/workflow_store.list_workflows(),
   real file-backed data) and re-render #wt-tbody, instead of the old
   placeholder behavior (a full page reload for Refresh, and a
   checkbox with no backend at all for Auto Refresh).

   Auto Refresh polls on a plain continuous interval while checked —
   an earlier version only rescheduled itself when the LAST fetch
   already contained a non-terminal workflow, which meant a page that
   loaded with zero workflows (the normal starting state) never polled
   a second time, so a workflow submitted afterward from Beacon never
   appeared here without a manual Refresh click. Also listens for a
   'sa:workflow-submitted' event (dispatched by scraper_requests_ui.js
   right after a successful submit) to refresh immediately rather than
   wait for the next tick.

   The table still server-renders on first load (see
   sa_workflows_table() in scraper_workflows_table.html) so there's no
   flash of empty content — this file only takes over AFTER that first
   paint, same progressive-enhancement approach as every other
   fetch-driven panel in this app.

   Status legend filter (toggling which data-status rows are visible)
   is unchanged from before — still a pure client-side class toggle,
   no backend involved.

   Kept in its own file per project convention. Registered on
   window.__solarisInit like every other planet/tab file. Self-guards
   on .wt-hub so it's a no-op everywhere except the Scraper Abyss
   Workflows panel. */
(function () {
  'use strict';

  var STATUS_LABEL = {
    waiting: 'Waiting', in_progress: 'In Progress', hold: 'Hold',
    failed: 'Failed', cancelled: 'Cancelled', completed: 'Completed'
  };

  // Same icon set as scraper_workflows_table.html's status_svg() Jinja
  // macro — kept in sync by hand since one is Jinja and one is JS, but
  // both need to agree so a row looks identical whether it came from
  // the server-rendered first paint or a live refresh. 'In Progress'
  // reuses the exact spinning-ring markup/animation from Workflow
  // Detail (css/scraper_workflow_detail.css's .wfd-icon-spin, ported
  // here as .wt-icon-spin — see css/scraper_workflows_table_ui.css)
  // instead of a static icon, same reasoning as that Jinja macro.
  var STATUS_ICON_INNER = {
    Waiting: '<circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15.5 14"></polyline>',
    Hold: '<circle cx="12" cy="12" r="9"></circle><line x1="10" y1="15" x2="10" y2="9"></line><line x1="14" y1="15" x2="14" y2="9"></line>',
    Failed: '<circle cx="12" cy="12" r="9"></circle><line x1="14.5" y1="9.5" x2="9.5" y2="14.5"></line><line x1="9.5" y1="9.5" x2="14.5" y2="14.5"></line>',
    Cancelled: '<circle cx="12" cy="12" r="9"></circle><line x1="5.5" y1="5.5" x2="18.5" y2="18.5"></line>',
    Completed: '<circle cx="12" cy="12" r="9"></circle><polyline points="15.5 8.5 10.3 14 8.5 12"></polyline>'
  };
  function statusSvg(label) {
    if (label === 'In Progress') {
      return '<svg viewBox="0 0 24 24" class="wt-icon-spin" fill="none" stroke="currentColor" stroke-linecap="round"><circle class="wt-trk" cx="12" cy="12" r="9"></circle><circle class="wt-rng" cx="12" cy="12" r="9"></circle></svg>';
    }
    var inner = STATUS_ICON_INNER[label] || STATUS_ICON_INNER.Waiting;
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function initScraperWorkflowsTableUi() {
    var hub = document.querySelector('.wt-hub');
    if (!hub) return; // not this page — no-op, same guard pattern as the other tab files

    var tbody = hub.querySelector('#wt-tbody');
    var countBadge = hub.querySelector('#wt-count');
    var autoCheckbox = hub.querySelector('#wt-auto-refresh input');
    var refreshBtn = hub.querySelector('#wt-refresh-btn');

    function activeStatuses() {
      var active = new Set();
      hub.querySelectorAll('#wt-legend .wt-legend-item.wt-active').forEach(function (el) {
        active.add(el.dataset.status);
      });
      return active;
    }

    function applyFilter() {
      var active = activeStatuses();
      hub.querySelectorAll('#wt-tbody tr[data-status]').forEach(function (row) {
        row.classList.toggle('wt-row-hidden', !active.has(row.dataset.status));
      });
    }

    function rowHtml(w) {
      var label = STATUS_LABEL[w.status] || w.status;
      var slug = label.toLowerCase().replace(/\s+/g, '-');
      return '<tr data-status="' + esc(label) + '">' +
        '<td><div class="wt-legend-item wt-legend-item-mini wt-active wt-status-' + slug + '">' +
          statusSvg(label) +
          '<span>' + esc(label) + '</span>' +
        '</div></td>' +
        '<td><a href="/solaris/scraper-abyss/workflow/' + encodeURIComponent(w.workflow_id) + '" target="_blank" rel="noopener" class="wt-id-link">' + esc(w.workflow_id) + '</a></td>' +
        '<td class="wt-portal-tag">' + esc(w.portal) + '</td>' +
        '<td class="wt-type-tag">' + esc(w.type) + '</td>' +
        '<td>' + esc(w.stage) + '</td>' +
        '<td class="wt-timestamp">' + esc(w.started_at || '--') + '</td>' +
        '<td class="wt-timestamp">' + esc(w.updated_at || '--') + '</td>' +
      '</tr>';
    }

    function loadWorkflows() {
      if (refreshBtn) refreshBtn.classList.add('wt-spinning');
      fetch('/solaris/api/workflow-list')
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var rows = d.workflows || [];
          if (countBadge) countBadge.textContent = rows.length;
          tbody.innerHTML = rows.length
            ? rows.map(rowHtml).join('')
            : '<tr><td colspan="7" style="text-align:center;color:#999;padding:20px;">No workflows yet.</td></tr>';
          applyFilter();
        })
        .catch(function () { /* leave last-known table as-is on a transient fetch error */ })
        .finally(function () {
          if (refreshBtn) refreshBtn.classList.remove('wt-spinning');
        });
    }

    // Continuous polling while Auto Refresh is checked — NOT conditioned
    // on whether the last fetch happened to contain a non-terminal
    // workflow. That earlier design meant a page that loaded with zero
    // workflows (the normal starting state) never scheduled a second
    // poll at all, so a workflow submitted afterward — from Beacon,
    // possibly without ever switching to this panel — would never
    // appear here until Refresh was clicked by hand. A live table
    // needs to keep checking for BRAND NEW rows, not just track
    // existing ones to completion.
    var autoInterval = null;
    function startAutoRefresh() {
      clearInterval(autoInterval);
      if (autoCheckbox && autoCheckbox.checked) {
        autoInterval = setInterval(loadWorkflows, 5000);
      }
    }

    hub.querySelectorAll('#wt-legend .wt-legend-item').forEach(function (item) {
      item.addEventListener('click', function () {
        item.classList.toggle('wt-active');
        applyFilter();
      });
    });

    if (refreshBtn) {
      refreshBtn.addEventListener('click', loadWorkflows);
    }
    if (autoCheckbox) {
      autoCheckbox.addEventListener('change', function () {
        if (autoCheckbox.checked) loadWorkflows();
        startAutoRefresh();
      });
    }

    // Beacon dispatches this the moment a submit succeeds (see
    // js/scraper_requests_ui.js) — refresh immediately instead of
    // waiting up to 5s for the next poll tick, so a newly-created
    // workflow shows up here right away even if this panel isn't the
    // one currently visible.
    document.addEventListener('sa:workflow-submitted', loadWorkflows);

    // Take over from the server-rendered first paint immediately, so
    // rows created moments ago (e.g. right after a Beacon submit) show
    // up without waiting for the first 5s tick.
    loadWorkflows();
    startAutoRefresh();
  }

  window.__solarisInit = window.__solarisInit || {};
  window.__solarisInit.scraperWorkflowsTableUi = initScraperWorkflowsTableUi;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initScraperWorkflowsTableUi);
  } else {
    initScraperWorkflowsTableUi();
  }
})();

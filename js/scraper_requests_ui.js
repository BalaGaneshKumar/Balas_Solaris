/* scraper_requests_ui.js — Requests (Beacon) form behavior: chamber
   toggle, seeded Keywords/Location/Blacklist chambers, add/remove,
   select-all/deselect-all, reset — all unchanged from before. Chambers
   are now plain pill chips (see scraper_requests_ui.css's header
   comment) instead of the earlier icon-ring/tube design — this file's
   own logic didn't need to change beyond makeChamber() no longer
   building/needing an icon.

   NEW in this pass (ported from the source dashboard's
   saCheckSubmit()/saSubmit()): the Broadcast Query button is now
   really gated on selection state, and actually submits —
   POST /api/scraper-submit (py/scraper_abyss_api.py ->
   py/workflow_store.create_workflow()/create_descriptor_workflow(),
   started immediately via py/workflow_engine.start_workflow()).
   Previously this button did nothing at all. Success/failure now
   also surfaces a toast (window.SolarisScraperToast, defined in
   scraper_abyss_ui.js) and fires a 'sa:workflow-submitted' DOM event
   so the Hyperlane table refreshes itself immediately instead of
   waiting for its next poll tick — previously a submit gave no
   visible confirmation at all, so there was no way to tell whether it
   had actually gone through short of manually checking Hyperlane.

   Submit gating mirrors source exactly: at least one Engine AND one
   Portal selected; if Scraper is selected, at least one Keyword;
   if Scraper or Descriptor is selected, at least one Location.
   Blacklist is always optional.

   Section visibility now also mirrors source's cascading show/hide
   flow (updateSectionVisibility(), ported from saUpdateSectionVisibility()):
   nothing is pre-selected on load, and Keywords/Location/Blacklist stay
   hidden until earned — Keywords needs a Portal + Scraper, Location
   needs Descriptor on (or Scraper on with a Keyword already picked),
   Blacklist needs Location visible and Scraper on. The form also
   resets itself back to this same starting point after every submit
   attempt that reaches the server (success or a reported failure),
   matching source's saSubmit() calling saReset() unconditionally —
   a network failure that never reaches the server leaves the form
   as-is so nothing already picked gets lost.

   All markup lives in html/fragments/scraper_requests.html
   (sa_requests_form() macro); styling in css/scraper_requests_ui.css.
   This file is behavior only.

   Registered on window.__solarisInit like every other planet/tab file
   so router.js re-runs it after each SPA fragment swap. Self-guards
   on .rq-hub so it's a no-op everywhere except the Scraper Abyss
   Requests panel. */
(function () {
  'use strict';

  var seedChambers = {
    'rq-keywords-chambers': [
      'Technical Support Engineer', 'Associate Cloud Engineer', 'Junior DevOps Engineer',
      'Cloud Operations Engineer', 'Cloud Administrator', 'L1 Support Engineer',
      'L2 Support Engineer', 'Cloud Support Engineer', 'Junior Cloud Support Engineer',
      'Service Desk Engineer'
    ],
    'rq-location-chambers': ['Chennai', 'Coimbatore', 'Bangalore'],
    'rq-blacklist-chambers': ['Senior', 'Lead', 'Principal', 'Staff', 'Manager', 'Walk In']
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function makeChamber(label, removable) {
    var chamber = document.createElement('div');
    chamber.className = 'rq-chamber';

    var labelSpan = document.createElement('span');
    labelSpan.className = 'rq-step-label';
    labelSpan.textContent = label;
    chamber.appendChild(labelSpan);

    if (removable) {
      var closeSpan = document.createElement('span');
      closeSpan.className = 'rq-close';
      closeSpan.textContent = '\u00d7';
      closeSpan.addEventListener('click', function (e) {
        e.stopPropagation(); // real remove, not just a toggle — see file header
        chamber.remove();
      });
      chamber.appendChild(closeSpan);
    }

    chamber.addEventListener('click', function () { chamber.classList.toggle('rq-active'); });
    return chamber;
  }

  function initScraperRequestsUi() {
    var hub = document.querySelector('.rq-hub');
    if (!hub) return; // not this page — no-op, same guard pattern as the other tab files

    Object.keys(seedChambers).forEach(function (id) {
      var container = hub.querySelector('#' + id);
      if (!container) return;
      seedChambers[id].forEach(function (label) {
        container.appendChild(makeChamber(label, true));
      });
    });

    // Static Engine/Portal chambers (already in the markup) — plain
    // toggle, same as seeded ones, just no remove button.
    ['rq-engine-chambers', 'rq-portal-chambers'].forEach(function (id) {
      var container = hub.querySelector('#' + id);
      if (!container) return;
      container.querySelectorAll('.rq-chamber').forEach(function (chamber) {
        chamber.addEventListener('click', function () { chamber.classList.toggle('rq-active'); });
      });
    });

    hub.querySelectorAll('.rq-add-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var input = hub.querySelector('#' + btn.dataset.input);
        var container = hub.querySelector('#' + btn.dataset.add);
        var value = input.value.trim();
        if (!value) return;
        container.appendChild(makeChamber(value, true));
        input.value = '';
        input.focus();
      });
    });

    hub.querySelectorAll('.rq-input-bar input').forEach(function (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          input.closest('.rq-input-bar').querySelector('.rq-add-btn').click();
        }
      });
    });

    hub.querySelectorAll('.rq-select-all').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var target = hub.querySelector('#' + btn.dataset.target);
        var chambers = target.querySelectorAll('.rq-chamber');
        var shouldActivate = Array.prototype.some.call(chambers, function (c) { return !c.classList.contains('rq-active'); });
        chambers.forEach(function (c) { c.classList.toggle('rq-active', shouldActivate); });
      });
    });

    function resetForm() {
      hub.querySelectorAll('.rq-chamber').forEach(function (c) { c.classList.remove('rq-active'); });
      hub.querySelectorAll('.rq-input-bar input').forEach(function (i) { i.value = ''; });
      updateSectionVisibility();
      checkSubmit();
    }

    var resetBtn = hub.querySelector('.rq-reset-btn');
    if (resetBtn) resetBtn.addEventListener('click', resetForm);

    // ── Submit gating + real submit (ported from source's
    // saCheckSubmit()/saSubmit()) ──────────────────────────────────
    var broadcastBtn = hub.querySelector('.rq-broadcast-btn');

    function activeLabels(containerId) {
      var container = hub.querySelector('#' + containerId);
      if (!container) return [];
      return Array.prototype.map.call(
        container.querySelectorAll('.rq-chamber.rq-active .rq-step-label'),
        function (el) { return el.textContent; }
      );
    }

    // ── Cascading section visibility (ported from source's
    // saUpdateSectionVisibility()) ──────────────────────────────────
    // Keywords/Location/Blacklist stay hidden until earned: Keywords
    // needs a Portal + Scraper; Location needs Descriptor on, or
    // Scraper on with at least one Keyword already picked (chained);
    // Blacklist is Scraper-only, shown once Location appears.
    function updateSectionVisibility() {
      var engines = activeLabels('rq-engine-chambers');
      var portals = activeLabels('rq-portal-chambers');
      var keywords = activeLabels('rq-keywords-chambers');
      var scraperOn = engines.indexOf('Scraper') !== -1;
      var descriptorOn = engines.indexOf('Descriptor') !== -1;
      var portalPicked = portals.length > 0;

      var needsKeyword = portalPicked && scraperOn;
      var keywordCard = hub.querySelector('#rq-keywords-card');
      if (keywordCard) keywordCard.style.display = needsKeyword ? '' : 'none';

      var needsLocation = portalPicked && (descriptorOn || (scraperOn && keywords.length > 0));
      var locationCard = hub.querySelector('#rq-location-card');
      if (locationCard) locationCard.style.display = needsLocation ? '' : 'none';

      var blacklistCard = hub.querySelector('#rq-blacklist-card');
      if (blacklistCard) blacklistCard.style.display = (needsLocation && scraperOn) ? '' : 'none';
    }

    function checkSubmit() {
      if (!broadcastBtn) return;
      var engines = activeLabels('rq-engine-chambers');
      var portals = activeLabels('rq-portal-chambers');
      var keywords = activeLabels('rq-keywords-chambers');
      var locations = activeLabels('rq-location-chambers');
      var scraperOn = engines.indexOf('Scraper') !== -1;
      var descriptorOn = engines.indexOf('Descriptor') !== -1;

      var ok = engines.length > 0 && portals.length > 0 &&
        (!scraperOn || keywords.length > 0) &&
        ((scraperOn || descriptorOn) ? locations.length > 0 : true);
      broadcastBtn.disabled = !ok;
      broadcastBtn.classList.toggle('rq-disabled', !ok);
    }

    // Re-check gating on every interaction that can change selection —
    // delegated on the hub so newly-added/removed chambers are covered
    // without re-binding per element.
    hub.addEventListener('click', function () { updateSectionVisibility(); checkSubmit(); });

    function activityLog(message) {
      fetch('/solaris/api/scraper-activity-log', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'ScraperAbyss', message: message })
      }).catch(function () {});
    }

    if (broadcastBtn) {
      broadcastBtn.addEventListener('click', function () {
        if (broadcastBtn.disabled) return;
        var payload = {
          engines: activeLabels('rq-engine-chambers'),
          portals: activeLabels('rq-portal-chambers'),
          keywords: activeLabels('rq-keywords-chambers'),
          locations: activeLabels('rq-location-chambers'),
          blacklist: activeLabels('rq-blacklist-chambers')
        };
        broadcastBtn.disabled = true;
        fetch('/solaris/api/scraper-submit', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).then(function (r) { return r.json(); }).then(function (d) {
          if (d.ok) {
            var msg = 'Workflow' + ((d.workflow_ids || []).length > 1 ? 's' : '') + ' submitted: ' + (d.workflow_ids || []).join(', ');
            if (window.SolarisScraperToast) window.SolarisScraperToast(msg, 'success');
            document.dispatchEvent(new CustomEvent('sa:workflow-submitted', { detail: d.workflow_ids }));
            activityLog('Request submitted: ' + payload.engines.join(',') + ' engine(s) | ' +
              payload.portals.join(',') + ' | ' + payload.keywords.length + ' keyword(s) | ' +
              payload.locations.length + ' location(s) | ' + payload.blacklist.length + ' blacklist keyword(s) — workflow(s): ' +
              (d.workflow_ids || []).join(', '));
          } else {
            if (window.SolarisScraperToast) window.SolarisScraperToast('Submit failed: ' + (d.error || 'unknown error'), 'error');
            activityLog('Request submit FAILED: ' + (d.error || 'unknown error'));
          }
          // Matches source's saSubmit(), which calls saReset() unconditionally
          // once any response comes back from the server — success or a
          // reported failure both clear the form back to its cascading
          // starting point, ready for the next request.
          resetForm();
        }).catch(function () {
          if (window.SolarisScraperToast) window.SolarisScraperToast('Submit failed: could not reach server', 'error');
          activityLog('Request submit FAILED: could not reach server');
        }).finally(function () {
          checkSubmit();
        });
      });
    }

    updateSectionVisibility();
    checkSubmit();
  }

  window.__solarisInit = window.__solarisInit || {};
  window.__solarisInit.scraperRequestsUi = initScraperRequestsUi;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initScraperRequestsUi);
  } else {
    initScraperRequestsUi();
  }
})();

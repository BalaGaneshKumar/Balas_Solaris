/* profile_nexus_ui.js — Profile Nexus tab page: BEHAVIOR ONLY.
   All markup for this page lives in html/fragments/profile_nexus.html
   (as Jinja macros), rendered server-side by tab.html's conditionals
   when current_key == 'profile-nexus'. This file does not build or
   inject any HTML strings; the one exception (Work History job cards,
   which are genuinely dynamic/repeatable) uses the
   <template id="pnx-job-template"> already defined in
   profile_nexus.html via cloneNode(), never string concatenation.

   Registered on window.__solarisInit like every other planet/tab file
   (see tab.js, nexus.js) so router.js re-runs it after each SPA
   fragment swap. Self-guards on .tab-body[data-current-planet="profile-nexus"]
   so it's a no-op on the other tab pages.

   Save/load wired to real server endpoints — same mechanism as the
   desktop dashboard's dashboard_profile.py (saveProfile() -> POST
   /api/save-profile), adapted to this project's route prefix:
     GET  /solaris/api/profile-data   -> current saved profile (or {})
     POST /solaris/api/save-profile   -> body is the full profile object,
                                          gets written to data/profile.json
   Both routes need to exist in solaris.py — see the snippet shared
   alongside this file (not a full solaris.py, since that file has
   your other tabs' edits in it). Activity log stays in-memory only
   (no logs.json, no logging endpoint) per your call. */
(function () {
  'use strict';

  var API_BASE = '/solaris/api';

  // Every top-level field id in profile_nexus.html, minus the "pnx_"
  // prefix — these are the JSON keys read/written against profile.json.
  var PNX_FIELDS = [
    'firstName', 'lastName', 'fullName', 'legalName', 'middleName', 'preferredName',
    'email', 'phone', 'phoneType', 'phoneCountry', 'birthday', 'location',
    'address', 'city', 'state', 'country', 'postalCode',
    'school', 'degree', 'highestDegree', 'gradYear', 'gpa', 'fieldOfStudy',
    'currentlyEmployed', 'totalExperience', 'relevantExperience', 'noticePeriod',
    'currentCTC', 'expectedCTCText', 'expectedCTCNumber', 'availableFrom', 'nightShift',
    'gender', 'ethnicity', 'hispanic', 'veteran', 'disability', 'lgbt',
    'workAuthorization', 'workAuthUS', 'visaType', 'sponsorship', 'relocate',
    'relocatePreference', 'workLocation',
    'pan', 'aadhaar', 'uan', 'esic',
    'linkedin', 'github', 'portfolio', 'website', 'twitter',
    'skills', 'language', 'nativeLanguage', 'empType', 'summary'
  ];

  var jobCount = 0;

  function addJobCard(container, template, job) {
    job = job || {};
    var frag = template.content.cloneNode(true);
    var idx = jobCount++;
    var card = frag.querySelector('.pnx-job-card');
    card.id = 'pnx-job-' + idx;
    card.querySelector('.pnx-job-number').textContent = String(idx + 1);
    card.querySelectorAll('[id]').forEach(function (el) {
      el.id = el.id.replace('__IDX__', idx);
    });
    card.querySelector('[data-remove-job]').setAttribute('data-remove-job', idx);
    container.appendChild(frag);

    var titleEl = document.getElementById('pnx_job_title_' + idx);
    var companyEl = document.getElementById('pnx_job_company_' + idx);
    var startEl = document.getElementById('pnx_job_start_' + idx);
    var endEl = document.getElementById('pnx_job_end_' + idx);
    var cwEl = document.getElementById('pnx_job_cw_' + idx);
    var descEl = document.getElementById('pnx_job_desc_' + idx);
    if (titleEl) titleEl.value = job.title || '';
    if (companyEl) companyEl.value = job.company || '';
    if (startEl) startEl.value = job.startDate || '';
    if (endEl) endEl.value = job.endDate || '';
    if (cwEl) cwEl.value = job.currentlyWorking === 'Yes' ? 'Yes' : 'No';
    if (descEl) descEl.value = job.description || '';
  }

  function collectJobs(jobsContainer) {
    var jobs = [];
    Array.prototype.forEach.call(jobsContainer.children, function (card) {
      var idx = card.id.replace('pnx-job-', '');
      var titleEl = document.getElementById('pnx_job_title_' + idx);
      var companyEl = document.getElementById('pnx_job_company_' + idx);
      var startEl = document.getElementById('pnx_job_start_' + idx);
      var endEl = document.getElementById('pnx_job_end_' + idx);
      var cwEl = document.getElementById('pnx_job_cw_' + idx);
      var descEl = document.getElementById('pnx_job_desc_' + idx);
      jobs.push({
        title: titleEl ? titleEl.value : '',
        company: companyEl ? companyEl.value : '',
        startDate: startEl ? startEl.value : '',
        endDate: endEl ? endEl.value : '',
        currentlyWorking: cwEl ? cwEl.value : 'No',
        description: descEl ? descEl.value : ''
      });
    });
    return jobs;
  }

  function collectProfile(jobsContainer) {
    var p = {};
    PNX_FIELDS.forEach(function (key) {
      var el = document.getElementById('pnx_' + key);
      if (el) p[key] = el.value;
    });
    p.jobs = collectJobs(jobsContainer);
    return p;
  }

  function fillProfileForm(data, jobsContainer, template) {
    PNX_FIELDS.forEach(function (key) {
      var el = document.getElementById('pnx_' + key);
      if (el && data[key] !== undefined) el.value = data[key];
    });
    jobCount = 0;
    jobsContainer.textContent = '';
    if (data.jobs && data.jobs.length) {
      data.jobs.forEach(function (job) { addJobCard(jobsContainer, template, job); });
    } else {
      addJobCard(jobsContainer, template); // seed with one blank job card
    }
  }

  // Session-only activity log — starts empty, grows only from real
  // actions during this page visit (opening the tab, Save, etc.).
  // Lives purely in memory: nothing here is written to a file, so it
  // resets on reload — deliberate, since logging persistence was
  // explicitly ruled out.
  var SESSION_LOGS = [];
  var pnxLogVisible = 15; // pagination window — grows via "Load more", see renderLogs

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

  function addLogEntry(msg) {
    SESSION_LOGS.unshift({ t: 'Just now', msg: msg, at: new Date().toLocaleTimeString() });
  }

  function renderLogs(content, logBtn) {
    var list = content.querySelector('#pnx-log-list');
    var count = content.querySelector('#pnx-log-count');
    var badge = logBtn.querySelector('#pnx-log-badge');
    list.textContent = '';
    SESSION_LOGS.slice(0, pnxLogVisible).forEach(function (l) {
      var row = document.createElement('div');
      row.className = 'pnx-log-item';
      var msg = document.createElement('span');
      msg.textContent = l.msg;
      var t = document.createElement('span');
      t.className = 't';
      t.textContent = l.t;
      row.appendChild(msg);
      row.appendChild(t);
      list.appendChild(row);
    });
    if (SESSION_LOGS.length > pnxLogVisible) {
      var moreBtn = document.createElement('button');
      moreBtn.type = 'button';
      moreBtn.className = 'pnx-log-more';
      moreBtn.textContent = 'Load more (' + (SESSION_LOGS.length - pnxLogVisible) + ' remaining)';
      moreBtn.addEventListener('click', function () { pnxLogVisible += 15; renderLogs(content, logBtn); });
      list.appendChild(moreBtn);
    }
    count.textContent = SESSION_LOGS.length;
    if (badge) badge.textContent = SESSION_LOGS.length;
  }

  function initProfileNexusUi() {
    var root = document.querySelector('.tab-body[data-current-planet="profile-nexus"]');
    if (!root) return; // not this page — no-op, same guard pattern as saturn.js/mars.js/etc.

    // Normalize the bare /profile-nexus URL to /profile-nexus/personal
    // — Personal Information is already the preselected default page
    // (server-rendered active, nav button already marked active), so
    // the address bar should say so too. replaceState, not pushState/
    // navigate — corrects the CURRENT URL to match what's already on
    // screen, no new history entry, no re-render.
    if (window.location.pathname === '/solaris/profile-nexus') {
      history.replaceState(null, '', '/solaris/profile-nexus/personal');
    }

    var headerBar = root.querySelector('.tab-header-bar');
    var logBtn = root.querySelector('.log-btn');
    var content = root.querySelector('.tab-content');
    var saveBtn = headerBar && headerBar.querySelector('#pnx-save-btn');
    var saveMsg = headerBar && headerBar.querySelector('#pnx-save-msg');
    var subNav = content && content.querySelector('#pnx-sub-nav');
    var jobsContainer = content && content.querySelector('#pnx-jobs-container');
    var jobTemplate = content && content.querySelector('#pnx-job-template');
    var addJobBtn = content && content.querySelector('#pnx-add-job');
    var logPanel = content && content.querySelector('#pnx-log-panel');
    var logRefresh = content && content.querySelector('#pnx-log-refresh');

    // Everything below expects the server-rendered fragments to be
    // present. If they're not (shouldn't happen on this route, but
    // guards against a stale/partial swap), bail out quietly.
    if (!headerBar || !logBtn || !content || !subNav || !jobsContainer || !jobTemplate) return;

    addLogEntry('Opened Profile Nexus'); // this is a real event, not mock data
    renderLogs(content, logBtn); // keeps the badge accurate even before the panel is ever opened
    var logDownload = content.querySelector('#pnx-log-download');
    if (logDownload) logDownload.addEventListener('click', function () {
      downloadLogFile('profile-nexus-activity-log', 'Profile Nexus activity log (this session only)',
        SESSION_LOGS.slice().reverse().map(function (e) { return (e.at || '') + ' | ' + e.msg; }));
    });

    // Seed one blank job card immediately so the form isn't empty
    // while the real data is still loading, then replace it once
    // /api/profile-data responds.
    jobCount = 0;
    jobsContainer.textContent = '';
    addJobCard(jobsContainer, jobTemplate);

    // Load whatever was previously saved to data/profile.json on the server.
    fetch(API_BASE + '/profile-data')
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (data) { fillProfileForm(data || {}, jobsContainer, jobTemplate); })
      .catch(function () { /* no saved profile yet, or endpoint not reachable — keep the blank form */ });

    // Sub-nav switching — panel toggle stays instant/client-side (no
    // data loss on typed-but-unsaved fields, no server round trip);
    // NEW is the URL push so the address bar reflects which sub-page
    // is showing (/profile-nexus/<slug>, same slug as data-sub since
    // solaris.py's PROFILE_NEXUS_SUBTABS route mapping is 1:1 with
    // these ids already). Deliberately NOT window.SolarisRouter.
    // navigate() — see this file's header comment / tab.html's
    // comment on pnx_content() for why a full re-fetch here would be
    // a regression, not an improvement.
    subNav.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-sub]');
      if (!btn) return;
      var id = btn.getAttribute('data-sub');
      content.querySelectorAll('.pnx-sub-page').forEach(function (p) { p.classList.remove('active'); });
      content.querySelectorAll('.pnx-sub-nav button').forEach(function (b) { b.classList.remove('active'); });
      var page = content.querySelector('#pnx-sub-' + id);
      if (page) page.classList.add('active');
      btn.classList.add('active');
      var url = '/solaris/profile-nexus/' + id;
      if (window.location.pathname !== url) {
        history.pushState(null, '', url);
      }
      addLogEntry('Switched to ' + btn.textContent.trim());
      renderLogs(content, logBtn); // keeps the badge/list accurate even while the panel is closed
    });

    // Work history add/remove
    if (addJobBtn) {
      addJobBtn.addEventListener('click', function () { addJobCard(jobsContainer, jobTemplate); });
    }
    jobsContainer.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-remove-job]');
      if (!btn) return;
      var el = document.getElementById('pnx-job-' + btn.getAttribute('data-remove-job'));
      if (el) el.remove();
    });

    // Log panel toggle (mock data only — no persistence, per your call)
    if (logPanel) {
      logBtn.addEventListener('click', function () {
        var open = logPanel.classList.toggle('open');
        logBtn.classList.toggle('pnx-open', open);
        addLogEntry(open ? 'Opened activity log' : 'Closed activity log');
        renderLogs(content, logBtn); // always — keeps badge accurate on close too, shows the new entry immediately on open
      });
      if (logRefresh) logRefresh.addEventListener('click', function () { renderLogs(content, logBtn); });
    }

    // Save — real fetch() POST to /api/save-profile, which writes
    // data/profile.json on the server.
    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        var payload = collectProfile(jobsContainer);
        fetch(API_BASE + '/save-profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
          .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, body: d }; }); })
          .then(function (res) {
            if (saveMsg) {
              saveMsg.textContent = res.ok ? '✓ Saved!' : '✗ ' + (res.body && res.body.error ? res.body.error : 'Save failed');
              setTimeout(function () { saveMsg.textContent = ''; }, 3500);
            }
            if (res.ok) {
              addLogEntry('Saved profile.json');
              renderLogs(content, logBtn); // updates the badge count even if the panel is closed
            }
          })
          .catch(function () {
            if (saveMsg) {
              saveMsg.textContent = '✗ Could not reach the server';
              setTimeout(function () { saveMsg.textContent = ''; }, 3500);
            }
          });
      });
    }
  }

  window.__solarisInit = window.__solarisInit || {};
  window.__solarisInit.profileNexusUi = initProfileNexusUi;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initProfileNexusUi);
  } else {
    initProfileNexusUi();
  }
})();

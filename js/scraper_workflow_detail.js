/* scraper_workflow_detail.js — Workflow Detail page behavior.

   Mechanism ported directly from the source dashboard's
   build_wfd_js() (per your instruction to match that exactly) — same
   width-measured stage packing, same corner-curve SVG connectors
   between wrapped rows, same auto-refresh/action/log-search behavior.
   Only the API paths changed (prefixed with /solaris/api instead of
   /api, matching every other fetch call in this project) and the
   status icon set is now inline SVG matching this app's existing
   .wfd-icon convention instead of source's JSON-embedded strings.

   Registered on window.__solarisInit like every other planet/tab
   file. Self-guards on #wfd-wrap so it's a no-op everywhere except
   this one page (not part of tab.html's dispatch — see solaris.py's
   scraper_abyss_workflow route and this file's own html fragment for
   why).

   Button reposition: wfdRenderDetails() now writes to three separate
   sub-containers (#wfd-details-header/#wfd-details-meta/#wfd-details-
   actions) instead of overwriting #wfd-details-block's entire
   innerHTML in one shot — the static Refresh/Auto-refresh controls
   now live inside that same card (see the html fragment's header
   comment), so a full-card overwrite would have wiped them out, along
   with their event listeners, on every single refresh. */
(function () {
  'use strict';

  var STATUS_BADGES = {
    waiting:     ['Waiting', 'wfd-badge-waiting'],
    in_progress: ['In Progress', 'wfd-badge-in_progress'],
    hold:        ['Hold', 'wfd-badge-hold'],
    failed:      ['Failed', 'wfd-badge-failed'],
    cancelled:   ['Cancelled', 'wfd-badge-cancelled'],
    completed:   ['Completed', 'wfd-badge-completed']
  };

  var STAGE_ICON = {
    not_started: 'not_started',
    in_progress: 'in_progress',
    completed: 'completed',
    failed: 'failed',
    hold: 'hold',
    cancelled: 'cancelled'
  };

  var STATUS_ICON_SVG = {
    completed:   '<svg viewBox="0 0 24 24" class="wfd-icon"><circle cx="12" cy="12" r="10"></circle><path d="M7 12.5l3 3 7-8"></path></svg>',
    in_progress: '<svg viewBox="0 0 24 24" class="wfd-icon wfd-icon-spin"><circle class="wfd-trk" cx="12" cy="12" r="9" fill="none"></circle><circle class="wfd-rng" cx="12" cy="12" r="9" fill="none"></circle></svg>',
    waiting:     '<svg viewBox="0 0 24 24" class="wfd-icon"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5"></path><path d="M12 12l3 2"></path></svg>',
    not_started: '<svg viewBox="0 0 24 24" class="wfd-icon"><circle cx="12" cy="12" r="10"></circle></svg>',
    hold:        '<svg viewBox="0 0 24 24" class="wfd-icon"><circle cx="12" cy="12" r="10"></circle><line x1="10" y1="8" x2="10" y2="16"></line><line x1="14" y1="8" x2="14" y2="16"></line></svg>',
    failed:      '<svg viewBox="0 0 24 24" class="wfd-icon"><circle cx="12" cy="12" r="10"></circle><path d="M9 9l6 6"></path><path d="M15 9l-6 6"></path></svg>',
    cancelled:   '<svg viewBox="0 0 24 24" class="wfd-icon"><circle cx="12" cy="12" r="10"></circle><path d="M6 6l12 12"></path></svg>'
  };

  var CONFIRM_TEXT = {
    hold:   'Hold this workflow? Scraper will finish the current cycle, save its position, and then stop.',
    retry:  'Retry this workflow from the last saved point?',
    cancel: 'Cancel this workflow? The process will stop immediately.',
    revoke: "Force kill this workflow immediately? This will fail the workflow and lose the current stage's progress (emergency stop).",
    reset:  'Reset this workflow? This clears all progress and moves it to Hold — press Retry afterward to start over.'
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Ported exactly from py/workflow_store.py's _alnum_words()/keyword_code()/
  // location_code() — these produce the SAME short codes already shown in
  // Stage labels elsewhere on this page (e.g. "Stage AD0TESUEN0CHI"), so
  // the meta panel's per-keyword/per-location codes stay consistent with
  // that rather than inventing a second, different abbreviation scheme.
  function wfdAlnumWords(text, maxWords) {
    var words = text.trim().split(/\s+/);
    var cleaned = [];
    for (var i = 0; i < Math.min(maxWords, words.length); i++) {
      cleaned.push(words[i].replace(/[^A-Za-z0-9]/g, ''));
    }
    return cleaned;
  }
  function wfdKeywordCode(keyword) {
    var words = wfdAlnumWords(keyword, 3);
    var parts = [];
    words.forEach(function (w) {
      if (w.length >= 2) parts.push(w.slice(0, 2).toUpperCase());
      else if (w.length === 1) parts.push(w.toUpperCase() + '0');
      else parts.push('00');
    });
    while (parts.length < 3) parts.push('00');
    return parts.join('');
  }
  function wfdLocationCode(location) {
    var words = location.trim().split(/\s+/);
    var firstAlnum = words.length ? words[0].replace(/[^A-Za-z0-9]/g, '') : '';
    var lastAlnum = words.length ? words[words.length - 1].replace(/[^A-Za-z0-9]/g, '') : '';
    var head = firstAlnum.slice(0, 2).toUpperCase();
    var tail = lastAlnum ? lastAlnum.slice(-1).toUpperCase() : '0';
    var code = (head + tail).slice(0, 3);
    while (code.length < 3) code += '0';
    return code;
  }

  // Ported from py/workflow_store.py's PORTAL_CODES dict — same
  // explicit-mapping-with-fallback pattern (Adzuna -> 'AD' explicitly;
  // any future portal not in the map falls back to its own first 2
  // letters uppercased, matching portal[:2].upper() there).
  var PORTAL_CODES = { Adzuna: 'AD', JSearch: 'JS', JobsPipe: 'JP' };
  function wfdPortalCode(portal) {
    return PORTAL_CODES[portal] || portal.slice(0, 2).toUpperCase();
  }

  function initScraperWorkflowDetail() {
    var wrap = document.getElementById('wfd-wrap');
    if (!wrap) return; // not this page — no-op, same guard pattern as the other tab files

    var wfdId = wrap.dataset.wfid;
    var wfdAutoTimer = null;
    var wfdLastWorkflow = null;
    var wfdRowSizeCache = {}; // workflow_id -> { containerWidth, signature, result: {groups, pillWidths} }

    var detailsBlock = document.getElementById('wfd-details-block');
    var detailsHeader = document.getElementById('wfd-details-header');
    var detailsMeta = document.getElementById('wfd-details-meta');
    var detailsKeywords = document.getElementById('wfd-details-keywords');
    var detailsActions = document.getElementById('wfd-details-actions');
    var stagesBlock = document.getElementById('wfd-stages-block');
    var logSearch = document.getElementById('wfd-log-search');
    var logCount = document.getElementById('wfd-log-count');
    var logList = document.getElementById('wfd-log-list');
    var refreshBtn = document.getElementById('wfd-refresh-btn');
    var autoCheckbox = document.getElementById('wfd-autorefresh');


    function wfdLoad() {
      if (refreshBtn) refreshBtn.classList.add('wfd-spinning');
      fetch('/solaris/api/workflow-detail?id=' + encodeURIComponent(wfdId))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d.ok) { detailsHeader.innerHTML = '<p class="wfd-no-actions">Workflow not found.</p>'; return; }
          wfdRenderDetails(d.workflow);
          wfdRenderStages(d.workflow);
          wfdScheduleAuto(d.workflow.status);
        })
        .catch(function () {})
        .finally(function () { if (refreshBtn) refreshBtn.classList.remove('wfd-spinning'); });
      wfdLoadLogs();
    }

    // Split across three sub-containers instead of one big innerHTML
    // write to #wfd-details-block — the Refresh/Auto-refresh controls
    // now live as static markup INSIDE that same card (paired with the
    // id+badge they refresh, see scraper_workflow_detail.html's header
    // comment on the button reposition), so overwriting the whole
    // card's innerHTML on every refresh would wipe those out along
    // with their event listeners.
    function wfdRenderDetails(w) {
      var badge = STATUS_BADGES[w.status] || [w.status, ''];
      var icon = STATUS_ICON_SVG[w.status] || '';

      // Row 1: "Workflow Detail" (static, in the html fragment) + id +
      // status badge + colored Portal/Type pills — reusing Job
      // Odyssey's exact .jo-tag/.jo-src/.jo-internal recipe (see
      // css/scraper_workflow_detail.css's .wfd-portal-tag/.wfd-type-tag)
      // instead of plain muted text, which is what made this page read
      // as flatter/plainer than the rest of the app.
      detailsHeader.innerHTML =
        '<span class="wfd-id-text">' + esc(w.workflow_id) + '</span>' +
        '<span class="wfd-badge ' + badge[1] + '">' + icon + ' ' + badge[0] + '</span>' +
        '<span class="wfd-portal-tag">' + esc(w.portal) + ' (' + wfdPortalCode(w.portal) + ')</span>' +
        '<span class="wfd-type-tag">' + (w.kind === 'descriptor' ? 'Descriptor' : 'Scraping') + '</span>';

      // Row 2 left half: Started/Updated as a stacked pair, then
      // locations as an inline "name (code)" list — Refresh/Auto-
      // refresh (static markup, right half of this same row) live
      // outside this container, see the html fragment.
      //
      // Locations is NEVER conditional — per py/workflow_store.py's
      // create_descriptor_workflow(), a descriptor workflow always has
      // its own locations list (that's what its stages iterate over:
      // "Descriptor Chennai", "Descriptor Coimbatore", etc). Source's
      // own wfdRenderDetails() confirms this: only KEYWORDS gets
      // swapped out for "Depends On" on a descriptor workflow —
      // Locations always renders as its own box regardless of kind.
      // An earlier pass here had this backwards (treated Locations as
      // the conditional field instead of Keywords), which meant a
      // descriptor workflow's location list disappeared entirely even
      // though the stage pipeline right below it clearly shows
      // per-location stages.
      var locationsInline = (w.locations || []).map(function (loc) {
        return '<span class="wfd-inline-item">' + esc(loc) + ' <span class="wfd-meta-code">(' + wfdLocationCode(loc) + ')</span></span>';
      }).join('') || '<span class="wfd-inline-item wfd-meta-empty">None selected</span>';

      detailsMeta.innerHTML =
        '<div class="wfd-meta-time-pair">' +
          '<div class="wfd-meta-time-pair-item">' +
            '<div class="wfd-meta-label">Started</div>' +
            '<div class="wfd-meta-value">' + esc(w.started_at || '--') + '</div>' +
          '</div>' +
          '<div class="wfd-meta-time-pair-item">' +
            '<div class="wfd-meta-label">Updated</div>' +
            '<div class="wfd-meta-value">' + esc(w.updated_at || '--') + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="wfd-meta-locations">' +
          '<div class="wfd-meta-label">locations</div>' +
          '<div class="wfd-meta-inline-list">' + locationsInline + '</div>' +
        '</div>';

      // Rows 3+4: EITHER "keywords" (scraper) OR "depends on"
      // (descriptor) as its own centered section below, full width —
      // this is the field that actually swaps per kind, not locations
      // (see comment above). Keywords flows through a CSS multi-
      // column list (auto column count based on width — not
      // hardcoded to 5, so this stays correct with any number of
      // keywords).
      if (w.kind === 'descriptor') {
        detailsKeywords.innerHTML =
          '<div class="wfd-keywords-section">' +
            '<div class="wfd-keywords-label">depends on</div>' +
            '<div class="wfd-keywords-grid"><div class="wfd-kw-item">' + esc(w.depends_on || 'None') + '</div></div>' +
          '</div>';
      } else {
        var keywords = w.keywords || [];
        var keywordsHtml = keywords.map(function (kw) {
          return '<div class="wfd-kw-item">' + esc(kw) + ' <span class="wfd-meta-code">(' + wfdKeywordCode(kw) + ')</span></div>';
        }).join('') || '<div class="wfd-kw-item wfd-meta-empty">None selected</div>';
        detailsKeywords.innerHTML =
          '<div class="wfd-keywords-section">' +
            '<div class="wfd-keywords-label">keywords</div>' +
            '<div class="wfd-keywords-grid">' + keywordsHtml + '</div>' +
          '</div>';
      }

      detailsActions.innerHTML = wfdRenderActions(w);
    }

    // Icons matching Job Odyssey's .jo-act convention (icon + label,
    // not plain text) — Retry mirrors the refresh icon already used
    // elsewhere on this page for visual consistency.
    var ACTION_ICONS = {
      retry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path></svg>',
      cancel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
      revoke: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><line x1="9" y1="9" x2="15" y2="15"></line><line x1="15" y1="9" x2="9" y2="15"></line></svg>',
      hold: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="5" width="4" height="14" rx="1"></rect><rect x="14" y="5" width="4" height="14" rx="1"></rect></svg>',
      reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"></path><path d="M3 4v5h5"></path></svg>'
    };

    function wfdRenderActions(w) {
      var s = w.status;
      var buttons = '';
      if (s === 'waiting') {
        buttons = wfdBtn('cancel', 'Cancel');
      } else if (s === 'in_progress') {
        buttons = wfdBtn('hold', 'Hold') + wfdBtn('cancel', 'Cancel') + wfdBtn('revoke', 'Revoke');
      } else if (s === 'hold' || s === 'failed') {
        buttons = wfdBtn('retry', 'Retry') + wfdBtn('cancel', 'Cancel') + wfdBtn('revoke', 'Revoke') + wfdBtn('reset', 'Reset');
      } else {
        buttons = '<span class="wfd-no-actions">No actions available.</span>';
      }
      return '<div class="wfd-actions">' + buttons + '</div>';
    }

    function wfdBtn(action, label) {
      return '<button class="wfd-act-btn wfd-act-' + action + '" data-action="' + action + '">' + (ACTION_ICONS[action] || '') + '<span>' + label + '</span></button>';
    }

    // Delegated on the whole card (not just #wfd-details-actions) —
    // harmless either way since only actual [data-action] buttons
    // inside detailsActions match, but keeping it on detailsBlock
    // means this listener doesn't need re-binding if the actions
    // sub-container's contents change shape later.
    detailsBlock.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var action = btn.dataset.action;
      if (!window.confirm(CONFIRM_TEXT[action])) return;
      fetch('/solaris/api/workflow-action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow_id: wfdId, action: action })
      }).then(function () { setTimeout(wfdLoad, 300); }).catch(function () {});
    });

    function wfdStagesSignature(stages) {
      return stages.map(function (s) {
        var extra = (s.type === 'fetch' && s.cycles_total) ? (s.cycles_done + '/' + s.cycles_total) : '';
        return s.status + ':' + extra;
      }).join('|');
    }

    // The stage that was mid-work when Hold was pressed keeps its own
    // status field as 'in_progress' in the data — deliberately, so
    // Retry resumes from that exact stage/cycle instead of restarting
    // it (see py/workflow_engine.py's _handle_stop, which only touches
    // Cancel's and Revoke's stages, never Hold's). But displaying it
    // with the live spinning "In Progress" icon while the workflow
    // itself isn't running is misleading — this computes a separate
    // DISPLAY-only status so that one stage reads as "Hold" (static,
    // paused look) instead, without changing what's actually stored.
    //
    // Cancel is different: it fully resets the stage it interrupted
    // back to 'not_started' (there's nothing to resume), so there's no
    // stored marker on the stage itself saying it was the one actually
    // running when Cancel was pressed. current_stage_index still
    // points at it, though — both _handle_stop's cancel branch and
    // cancel_workflow's direct-cancel path preserve it — so use that
    // to show this one stage as "Cancelled" instead of a plain,
    // generic "Not Started" that looks identical to a stage that was
    // simply never reached.
    function wfdEffectiveStageStatus(stage, workflowStatus, stageIdx, currentStageIndex) {
      if (stage.status === 'in_progress' && workflowStatus === 'hold') return 'hold';
      if (stage.status === 'not_started' && workflowStatus === 'cancelled' && stageIdx === currentStageIndex) return 'cancelled';
      return stage.status;
    }

    // Connector/corner tube cores are colored to match whichever stage
    // they're leading into: green once that stage is done, amber while
    // it's actively running, and now also red/orange/gray leading into
    // a stage that's failed/held/cancelled — same status color used on
    // that stage's own ring and label, so the connector reads as part
    // of the same status rather than defaulting to a neutral dark look.
    // Anything else (not yet reached) stays dark/pending.
    function wfdConnStatus(stage, workflowStatus, stageIdx, currentStageIndex) {
      var eff = wfdEffectiveStageStatus(stage, workflowStatus, stageIdx, currentStageIndex);
      if (eff === 'completed' || eff === 'in_progress' || eff === 'failed' || eff === 'hold' || eff === 'cancelled') return eff;
      return 'pending';
    }

    var STATUS_TEXT = { completed: 'COMPLETED', in_progress: 'IN PROGRESS', not_started: 'NOT STARTED', waiting: 'WAITING', hold: 'HOLD', failed: 'FAILED', cancelled: 'CANCELLED' };

    // Chamber/pill dimensions — kept in one place since wfdMeasureRowGroups'
    // packing math and wfdDrawCorner's curve geometry both depend on them
    // matching the CSS exactly (.wfd-union-cap/.wfd-pipe-horizontal).
    var CAP_PROTRUSION = 9;      // how far a union-cap sticks out past its chamber's own box
    var CONNECTOR_OVERLAP = 9;   // how far pipe-horizontal's margin pulls it into each neighboring cap
    var CONNECTOR_WIDTH = 110;   // pipe-horizontal's own width before overlap is subtracted
    var CONNECTOR_NET_WIDTH = CONNECTOR_WIDTH - (CONNECTOR_OVERLAP * 2);
    var CURVE_BULGE = 70;
    var CURVE_RING_HALF = 12.72;
    var CURVE_INSET = CAP_PROTRUSION + 0.75 * CURVE_BULGE + CURVE_RING_HALF;

    function wfdChamberLabel(s) {
      return (s.type === 'fetch' || s.type === 'descriptor') ? s.stage_code : esc(s.name);
    }
    function wfdChamberStatusText(s, eff) {
      var extra = (s.type === 'fetch' && s.cycles_total) ? (' \u00B7 ' + s.cycles_done + '/' + s.cycles_total) : '';
      return (STATUS_TEXT[eff] || eff.toUpperCase()) + extra;
    }

    // Builds one chamber: socket (neon ring + status icon) + glass tube
    // (label + status line), with union caps on whichever sides connect
    // to a neighbor — ported from the reference's buildPill().
    function wfdBuildChamber(s, globalIdx, eff, reversed, hasCapIn, hasCapOut) {
      var el = document.createElement('div');
      el.className = 'wfd-chamber' + (eff === 'not_started' ? ' wfd-dim' : '');
      el.id = 'wfd-stage-' + globalIdx;

      var iconKey = STAGE_ICON[eff] || 'not_started';
      var socketHtml = '<div class="wfd-node-socket"><div class="wfd-neon-ring ' + eff + '">' + (STATUS_ICON_SVG[iconKey] || '') + '</div></div>';
      var textHtml = '<div class="wfd-glass-tube">' +
        '<svg class="wfd-tube-shape" preserveAspectRatio="none"><path class="wfd-tube-shape-fill" fill="#000"/><path class="wfd-tube-shape-stroke" fill="none" stroke="#303030" stroke-width="2"/></svg>' +
        '<div class="wfd-step-label-wrap">' +
          '<span class="wfd-step-label">' + wfdChamberLabel(s) + '</span>' +
          '<span class="wfd-step-status ' + eff + '">' + wfdChamberStatusText(s, eff) + '</span>' +
        '</div></div>';

      var html = '';
      if (!reversed) {
        if (hasCapIn) html += '<div class="wfd-union-cap-in wfd-cap-in"></div>';
        html += socketHtml + textHtml;
        if (hasCapOut) html += '<div class="wfd-union-cap wfd-cap-out"></div>';
      } else {
        if (hasCapOut) html += '<div class="wfd-union-cap-in wfd-cap-out"></div>';
        html += textHtml + socketHtml;
        if (hasCapIn) html += '<div class="wfd-union-cap wfd-cap-in"></div>';
      }
      el.innerHTML = html;
      return el;
    }

    // Draws the glass tube's silhouette so it notches around the ring
    // with no seam — mirrors the reference's shapeTube() exactly.
    function wfdShapeTube(chamberEl) {
      var svg = chamberEl.querySelector('.wfd-tube-shape');
      var socket = chamberEl.querySelector('.wfd-node-socket');
      var tube = chamberEl.querySelector('.wfd-glass-tube');
      if (!svg || !socket || !tube) return;
      var socketRect = socket.getBoundingClientRect();
      var tubeRect = tube.getBoundingClientRect();
      var W = tubeRect.width, H = tubeRect.height;
      var ringR = socketRect.height / 2;
      var topOffset = socketRect.top - tubeRect.top;
      var R2 = Math.min(16, H / 2);
      var notchTop = topOffset, notchBottom = topOffset + 2 * ringR;
      var socketOnLeft = socketRect.left < tubeRect.left;

      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      var d;
      if (socketOnLeft) {
        d = 'M0,0 L' + (W - R2) + ',0 A' + R2 + ',' + R2 + ' 0 0 1 ' + W + ',' + R2 +
          ' L' + W + ',' + (H - R2) + ' A' + R2 + ',' + R2 + ' 0 0 1 ' + (W - R2) + ',' + H +
          ' L0,' + H + ' L0,' + notchBottom + ' L' + (-ringR) + ',' + notchBottom +
          ' A' + ringR + ',' + ringR + ' 0 0 0 ' + (-ringR) + ',' + notchTop + ' L0,' + notchTop + ' L0,0 Z';
      } else {
        d = 'M' + W + ',0 L' + R2 + ',0 A' + R2 + ',' + R2 + ' 0 0 0 0,' + R2 +
          ' L0,' + (H - R2) + ' A' + R2 + ',' + R2 + ' 0 0 0 ' + R2 + ',' + H +
          ' L' + W + ',' + H + ' L' + W + ',' + notchBottom + ' L' + (W + ringR) + ',' + notchBottom +
          ' A' + ringR + ',' + ringR + ' 0 0 1 ' + (W + ringR) + ',' + notchTop + ' L' + W + ',' + notchTop + ' L' + W + ',0 Z';
      }
      svg.querySelector('.wfd-tube-shape-fill').setAttribute('d', d);
      svg.querySelector('.wfd-tube-shape-stroke').setAttribute('d', d);
    }

    function wfdBuildConnector(status, reversed, extraWidth) {
      var el = document.createElement('div');
      el.className = 'wfd-pipe-horizontal wfd-pipe-' + status + (reversed ? ' wfd-flow-rev' : '');
      if (extraWidth) el.style.width = (CONNECTOR_WIDTH + extraWidth) + 'px';
      el.innerHTML = '<div class="wfd-conduit-shaft"><div class="wfd-laser-core"></div></div>';
      return el;
    }

    // Measures each chamber's real rendered width off-DOM (label length
    // varies it, so it can't be assumed) — ported from measurePillWidths().
    function wfdMeasurePillWidths(stages, workflowStatus, currentStageIndex) {
      var probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;visibility:hidden;left:-99999px;top:0;display:flex;';
      document.body.appendChild(probe);
      var widths = stages.map(function (s, i) {
        var eff = wfdEffectiveStageStatus(s, workflowStatus, i, currentStageIndex);
        var chamber = wfdBuildChamber(s, 'measure-' + i, eff, false, true, true);
        probe.appendChild(chamber);
        return chamber.getBoundingClientRect().width;
      });
      document.body.removeChild(probe);
      return widths;
    }

    function wfdMinRowSpan(indices, pillWidths) {
      var total = 0;
      indices.forEach(function (idx, pos) {
        total += pillWidths[idx];
        if (pos < indices.length - 1) total += CONNECTOR_NET_WIDTH;
      });
      return total;
    }

    function wfdRowInsets(r, n) {
      var curveRight = (r % 2 === 1) || (r + 1 < n);
      var curveLeft = (r % 2 === 0 && r >= 2) || (r % 2 === 1 && r + 1 < n);
      return { left: curveLeft ? CURVE_INSET : 0, right: curveRight ? CURVE_INSET : 0 };
    }

    // Groups stage indices into zig-zag rows that fit availableWidth,
    // reserving room at row ends for the curved corner tube — ported
    // from measureRowGroups().
    function wfdMeasureRowGroups(stages, workflowStatus, availableWidth, currentStageIndex) {
      var pillWidths = wfdMeasurePillWidths(stages, workflowStatus, currentStageIndex);
      var firstBudget = availableWidth - CURVE_INSET;
      var middleBudget = availableWidth - CURVE_INSET * 2;
      var groups = [], current = [];
      for (var i = 0; i < stages.length; i++) {
        var budget = groups.length === 0 ? firstBudget : middleBudget;
        var candidate = current.concat([i]);
        if (current.length > 0 && wfdMinRowSpan(candidate, pillWidths) > budget) {
          groups.push(current);
          current = [i];
        } else {
          current = candidate;
        }
      }
      if (current.length) groups.push(current);
      return { groups: groups, pillWidths: pillWidths };
    }

    var wfdRenderToken = 0;
    function wfdRenderStages(w) {
      wfdLastWorkflow = w;
      var myToken = ++wfdRenderToken;
      var stages = w.stages || [];
      var canvas = document.getElementById('wfd-stage-canvas');
      if (!canvas) {
        stagesBlock.innerHTML = '<div id="wfd-stage-canvas"><div class="wfd-pipeline" id="wfd-pipeline"></div></div><div class="wfd-legend"></div>';
        canvas = document.getElementById('wfd-stage-canvas');
      }
      var pipeline = document.getElementById('wfd-pipeline');
      pipeline.innerHTML = '';

      // canvas.clientWidth includes its own left+right padding (34px each,
      // see #wfd-stage-canvas), but that padding isn't usable space for the
      // pipeline sitting inside it — using the full clientWidth as the
      // packing budget overestimates real room by 68px, enough to pack one
      // extra chamber that then genuinely overflows. Subtract the actual
      // padding (read live, so this stays correct if the CSS ever changes),
      // plus a small residual margin for getBoundingClientRect()'s
      // fractional pixels vs. the browser's own integer layout rounding.
      // No horizontal scroll is allowed on this page, so both matter.
      var canvasStyle = getComputedStyle(canvas);
      var canvasHPad = (parseFloat(canvasStyle.paddingLeft) || 0) + (parseFloat(canvasStyle.paddingRight) || 0);
      var WFD_PACK_SAFETY = 8;
      var availableWidth = Math.max((canvas.clientWidth || stagesBlock.clientWidth || 1000) - canvasHPad - WFD_PACK_SAFETY, 200);
      var cache = wfdRowSizeCache[w.workflow_id];
      var signature = wfdStagesSignature(stages);
      var result;
      if (cache && cache.containerWidth === availableWidth && cache.signature === signature) {
        result = cache.result;
      } else {
        result = wfdMeasureRowGroups(stages, w.status, availableWidth, w.current_stage_index);
        wfdRowSizeCache[w.workflow_id] = { containerWidth: availableWidth, signature: signature, result: result };
      }

      var groups = result.groups;
      var rowCount = groups.length;
      var justify = rowCount > 1;
      pipeline.style.width = justify ? availableWidth + 'px' : 'max-content';

      // A row with few chambers has far more leftover space per connector
      // than a full row does (same rowCapacity, fewer connectors to spread
      // it across) — if every row independently stretched to fill its own
      // capacity, a sparse row's one or two connectors would absorb all of
      // it and stretch absurdly long. Instead, derive the per-connector
      // stretch from the first row that actually has more than one
      // chamber — a normally-packed row's natural spacing — and reuse
      // that exact number everywhere, so every connector in the whole
      // pipeline looks the same size. A sparse row then just falls short
      // of its target x, and wfdDrawCorner's straight lead-in bridges the
      // rest, rather than the connector itself inventing the difference.
      var canonicalExtra = 0;
      if (justify) {
        for (var gi = 0; gi < groups.length; gi++) {
          if (groups[gi].length > 1) {
            var insetsGi = wfdRowInsets(gi, rowCount);
            var capacityGi = availableWidth - insetsGi.left - insetsGi.right;
            canonicalExtra = Math.max(0, (capacityGi - wfdMinRowSpan(groups[gi], result.pillWidths)) / (groups[gi].length - 1));
            break;
          }
        }
      }

      var curveJobs = [];
      groups.forEach(function (group, rowIndex) {
        var row = document.createElement('div');
        row.className = 'wfd-pipeline-row';
        var reversed = rowIndex % 2 === 1;
        var isLastRow = rowIndex === rowCount - 1;
        var insets = justify ? wfdRowInsets(rowIndex, rowCount) : { left: 0, right: 0 };
        var rowCapacity = availableWidth - insets.left - insets.right;
        var extraPerConnector = 0, offset = insets.left;
        if (justify) {
          if (group.length > 1) {
            // Never force more stretch than this row's own budget allows
            // (a dense row might not have room for the full canonical
            // amount) — but never invent more than the canonical amount
            // either, however much slack this row happens to have.
            var rawExtra = Math.max(0, (rowCapacity - wfdMinRowSpan(group, result.pillWidths)) / (group.length - 1));
            extraPerConnector = Math.min(canonicalExtra, rawExtra);
            // The last row has no row after it, so with canonical (not
            // full-stretch) spacing it usually falls short of the right
            // edge — left-anchored as normal, that shortfall shows up as
            // a long bridge on its RIGHT (curve-facing) side. If the
            // curve actually attaches on the right (insets.right > 0,
            // insets.left === 0), anchor from the right instead: any
            // leftover slack becomes blank space on the free LEFT side
            // instead, where nothing needs to line up with anything.
            if (isLastRow && insets.left === 0 && insets.right > 0) {
              var naturalWidthWithExtra = wfdMinRowSpan(group, result.pillWidths) + extraPerConnector * (group.length - 1);
              offset = Math.max(insets.left, rowCapacity - naturalWidthWithExtra);
            }
          } else if (reversed) {
            offset += Math.max(0, rowCapacity - result.pillWidths[group[0]]);
          }
        }
        row.style.marginLeft = offset + 'px';

        var visualOrder = reversed ? group.slice().reverse() : group.slice();
        visualOrder.forEach(function (stageIdx, posInRow) {
          var stage = stages[stageIdx];
          var eff = wfdEffectiveStageStatus(stage, w.status, stageIdx, w.current_stage_index);
          var isVeryFirst = stageIdx === 0, isVeryLast = stageIdx === stages.length - 1;
          var chamber = wfdBuildChamber(stage, stageIdx, eff, reversed, !isVeryFirst, !isVeryLast);
          row.appendChild(chamber);

          var isLastInGroup = posInRow === visualOrder.length - 1;
          if (!isLastInGroup) {
            var otherIdx = visualOrder[posInRow + 1];
            var laterIdx = Math.max(stageIdx, otherIdx);
            var laterStage = stages[laterIdx];
            var connClass = wfdConnStatus(laterStage, w.status, laterIdx, w.current_stage_index);
            row.appendChild(wfdBuildConnector(connClass, reversed, extraPerConnector));
          }
        });

        pipeline.appendChild(row);
        row.querySelectorAll('.wfd-chamber').forEach(function (c) { wfdShapeTube(c); });

        if (rowIndex > 0) {
          var prevGroup = groups[rowIndex - 1];
          var prevLastIdx = prevGroup[prevGroup.length - 1];
          var thisFirstIdx = group[0];
          curveJobs.push({ fromId: 'wfd-stage-' + prevLastIdx, toId: 'wfd-stage-' + thisFirstIdx, status: wfdConnStatus(stages[thisFirstIdx], w.status, thisFirstIdx, w.current_stage_index) });
        }
      });

      var legend = stagesBlock.querySelector('.wfd-legend');
      if (legend) {
        legend.innerHTML =
          '<span style="color:#4ade80">' + STATUS_ICON_SVG.completed + ' Completed</span>' +
          '<span style="color:#fbbf24">' + STATUS_ICON_SVG.in_progress + ' In Progress</span>' +
          '<span style="color:#fb923c">' + STATUS_ICON_SVG.hold + ' Hold</span>' +
          '<span style="color:#6c7592">' + STATUS_ICON_SVG.not_started + ' Not Started</span>' +
          '<span style="color:#f87171">' + STATUS_ICON_SVG.failed + ' Failed</span>' +
          '<span style="color:#8292a8">' + STATUS_ICON_SVG.cancelled + ' Cancelled</span>';
      }

      requestAnimationFrame(function () {
        if (myToken !== wfdRenderToken) return; // a newer render already owns drawing curves
        pipeline.querySelectorAll('.wfd-corner-svg').forEach(function (e) { e.remove(); });
        curveJobs.forEach(function (job) {
          try { wfdDrawCorner(pipeline, job.fromId, job.toId, job.status); } catch (err) { /* skip a bad corner rather than break the page */ }
        });
      });
    }

    // Metal-gradient stops sampled from .wfd-conduit-shaft's own CSS
    // gradient, so a curved corner shades like the same physical pipe.
    var WFD_METAL_STOPS = [
      { pos: 0, rgb: [58, 67, 80] }, { pos: 14, rgb: [184, 198, 216] }, { pos: 25, rgb: [255, 255, 255] },
      { pos: 50, rgb: [42, 48, 60] }, { pos: 72, rgb: [20, 24, 32] }, { pos: 90, rgb: [106, 120, 137] }, { pos: 100, rgb: [35, 40, 51] }
    ];
    function wfdInterpMetalColor(t) {
      for (var i = 0; i < WFD_METAL_STOPS.length - 1; i++) {
        var a = WFD_METAL_STOPS[i], b = WFD_METAL_STOPS[i + 1];
        if (t >= a.pos && t <= b.pos) {
          var f = (t - a.pos) / (b.pos - a.pos);
          return 'rgb(' + Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f) + ',' + Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f) + ',' + Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f) + ')';
        }
      }
      return 'rgb(' + WFD_METAL_STOPS[WFD_METAL_STOPS.length - 1].rgb.join(',') + ')';
    }
    // Shades a corner as a stack of thin offset stripes (ported from the
    // reference's buildRingStack()). Takes the corner's own segment list
    // — straight runs plus one cubic — and computes each sample point and
    // its normal with plain math. The reference measured a hidden SVG
    // path instead (getTotalLength/getPointAtLength, ~150 calls per
    // corner), which profiled at ~320ms per re-render at narrow widths
    // (18 corners) — nearly all the real script cost of a resize, and
    // why the curves took seconds to appear on slower machines. The
    // geometry here is fully known up front, so nothing needs measuring.
    function wfdBuildRingStack(segs, group) {
      var svgNS = 'http://www.w3.org/2000/svg';
      var samples = [];
      function push(x, y, dx, dy) {
        var mag = Math.sqrt(dx * dx + dy * dy) || 1;
        samples.push({ x: x, y: y, nx: dy / mag, ny: -dx / mag });
      }
      segs.forEach(function (seg) {
        if (seg.type === 'L') {
          // A straight run has one constant normal, so its two ends are
          // all a stripe needs — no intermediate samples.
          push(seg.x0, seg.y0, seg.x1 - seg.x0, seg.y1 - seg.y0);
          push(seg.x1, seg.y1, seg.x1 - seg.x0, seg.y1 - seg.y0);
        } else {
          var STEPS = 48;
          for (var k = 0; k <= STEPS; k++) {
            var t = k / STEPS, u = 1 - t;
            var x = u*u*u*seg.x0 + 3*u*u*t*seg.x1 + 3*u*t*t*seg.x2 + t*t*t*seg.x3;
            var y = u*u*u*seg.y0 + 3*u*u*t*seg.y1 + 3*u*t*t*seg.y2 + t*t*t*seg.y3;
            var dx = 3*u*u*(seg.x1 - seg.x0) + 6*u*t*(seg.x2 - seg.x1) + 3*t*t*(seg.x3 - seg.x2);
            var dy = 3*u*u*(seg.y1 - seg.y0) + 6*u*t*(seg.y2 - seg.y1) + 3*t*t*(seg.y3 - seg.y2);
            push(x, y, dx, dy);
          }
        }
      });
      var STRIPE_COUNT = 40, HALF_WIDTH = 12;
      var strokeW = ((2 * HALF_WIDTH / STRIPE_COUNT) * 2.4).toFixed(2);
      for (var i = 0; i < STRIPE_COUNT; i++) {
        var tt = i / (STRIPE_COUNT - 1);
        var offset = HALF_WIDTH - (2 * HALF_WIDTH) * tt;
        var pathD = '';
        for (var j = 0; j < samples.length; j++) {
          var sp = samples[j];
          pathD += (j === 0 ? 'M' : 'L') + (sp.x + sp.nx * offset).toFixed(2) + ',' + (sp.y + sp.ny * offset).toFixed(2) + ' ';
        }
        var path = document.createElementNS(svgNS, 'path');
        path.setAttribute('d', pathD.trim());
        path.setAttribute('stroke', wfdInterpMetalColor(tt * 100));
        path.setAttribute('stroke-width', strokeW);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke-linecap', 'butt');
        path.setAttribute('stroke-linejoin', 'round');
        group.appendChild(path);
      }
    }

    // Draws one curved corner tube joining row r's last chamber to row
    // r+1's first — ported from drawCorner(), keyed on wfd-cap-in/wfd-
    // cap-out (semantic roles) rather than assumed left/right sides,
    // same reasoning as the reference for reversed rows.
    function wfdDrawCorner(canvas, idA, idB, status) {
      var elA = document.getElementById(idA), elB = document.getElementById(idB);
      if (!elA || !elB) return;
      var capA = elA.querySelector('.wfd-cap-out'), capB = elB.querySelector('.wfd-cap-in');
      if (!capA || !capB) return;

      var canvasRect = canvas.getBoundingClientRect();
      var rectA = capA.getBoundingClientRect(), rectB = capB.getBoundingClientRect();
      var chamberRectA = elA.getBoundingClientRect(), chamberRectB = elB.getBoundingClientRect();
      var capAProtrudesRight = capA.classList.contains('wfd-union-cap');
      var capBProtrudesRight = capB.classList.contains('wfd-union-cap');
      var xAOrig = Math.round((capAProtrudesRight ? rectA.right : rectA.left) - canvasRect.left);
      var xBOrig = Math.round((capBProtrudesRight ? rectB.right : rectB.left) - canvasRect.left);
      var yA = Math.round(chamberRectA.top + chamberRectA.height / 2 - canvasRect.top);
      var yB = Math.round(chamberRectB.top + chamberRectB.height / 2 - canvasRect.top);
      var bulgeA = capAProtrudesRight ? CURVE_BULGE : -CURVE_BULGE;
      var bulgeB = capBProtrudesRight ? CURVE_BULGE : -CURVE_BULGE;
      var overlapA = capAProtrudesRight ? -CONNECTOR_OVERLAP : CONNECTOR_OVERLAP;
      var overlapB = capBProtrudesRight ? -CONNECTOR_OVERLAP : CONNECTOR_OVERLAP;
      var xAStart = xAOrig + overlapA, xBEnd = xBOrig + overlapB;

      // The two rows can end up with different total widths (especially
      // now that connector stretch is capped on sparse rows), so xAOrig
      // and xBOrig often don't land on the same column — that's what
      // makes the U-turn look diagonal/slanted instead of a clean
      // vertical bend. Snap both to whichever is further out in the
      // protrusion direction, and bridge the gap on the shorter side
      // with a straight run built into the SAME path (not a separate SVG
      // element) — two separate paths would each restart their dash
      // pattern from zero, visibly breaking the flow animation at the
      // seam between them.
      var targetX = capAProtrudesRight ? Math.max(xAOrig, xBOrig) : Math.min(xAOrig, xBOrig);

      var svgNS = 'http://www.w3.org/2000/svg';
      var svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('class', 'wfd-corner-svg wfd-corner-' + status);
      var minX = Math.min(xAStart, xBEnd, targetX) - Math.abs(bulgeA) - 20;
      var maxX = Math.max(xAStart, xBEnd, targetX) + Math.abs(bulgeB) + 20;
      var minY = Math.min(yA, yB) - 20, maxY = Math.max(yA, yB) + 20;
      svg.setAttribute('style', 'left:' + minX + 'px;top:' + minY + 'px;width:' + (maxX - minX) + 'px;height:' + (maxY - minY) + 'px;');

      var d = 'M ' + (xAStart - minX) + ' ' + (yA - minY);
      if (xAStart !== targetX) d += ' L ' + (targetX - minX) + ' ' + (yA - minY);
      d += ' C ' + (targetX - minX + bulgeA) + ' ' + (yA - minY) + ', ' + (targetX - minX + bulgeB) + ' ' + (yB - minY) + ', ' + (targetX - minX) + ' ' + (yB - minY);
      if (xBEnd !== targetX) d += ' L ' + (xBEnd - minX) + ' ' + (yB - minY);

      var group = document.createElementNS(svgNS, 'g');
      group.setAttribute('class', 'wfd-ring-stack');
      var ax = xAStart - minX, ay = yA - minY, tx = targetX - minX, by = yB - minY, ex = xBEnd - minX;
      var segs = [];
      if (xAStart !== targetX) segs.push({ type: 'L', x0: ax, y0: ay, x1: tx, y1: ay });
      segs.push({ type: 'C', x0: tx, y0: ay, x1: tx + bulgeA, y1: ay, x2: tx + bulgeB, y2: by, x3: tx, y3: by });
      if (xBEnd !== targetX) segs.push({ type: 'L', x0: tx, y0: by, x1: ex, y1: by });
      wfdBuildRingStack(segs, group);
      svg.appendChild(group);

      // In-progress only: a continuous glow path under the solid dark base, so
      // the glow shows outside the tube but never inside the dark gaps.
      if (status === 'in_progress') {
        var glow = document.createElementNS(svgNS, 'path');
        glow.setAttribute('class', 'wfd-corner-glow');
        glow.setAttribute('d', d);
        svg.appendChild(glow);
      }
      var base = document.createElementNS(svgNS, 'path');
      base.setAttribute('class', 'wfd-corner-core-base');
      base.setAttribute('d', d);
      svg.appendChild(base);
      var core = document.createElementNS(svgNS, 'path');
      core.setAttribute('class', 'wfd-corner-core');
      core.setAttribute('d', d);
      svg.appendChild(core);
      // In-progress corners get a stack of thin highlight layers on the SAME
      // path, so each dash fades yellow -> pale -> yellow exactly like the
      // straight pipe's repeating-linear-gradient (#fbbf24 0px, #fff4be 12px,
      // #fbbf24 24px, then 12px dark; 36px period). An SVG stroke can't take
      // a gradient along a curve, so the fade is built from nested dashes:
      // layer i is centered on the dash's midpoint (12px), gets narrower the
      // higher i is, and is paler the higher i is — a triangle brightness
      // profile, stepped finely enough (1px per layer) to read as smooth.
      // Other statuses stay flat.
      if (status === 'in_progress') {
        var HL_LAYERS = 12, HL_PERIOD = 36, HL_CENTER = 12;
        var HL_EDGE = [251, 191, 36], HL_PEAK = [255, 244, 190];
        for (var li = 1; li < HL_LAYERS; li++) {
          var halfW = HL_CENTER * (1 - li / HL_LAYERS);          // 12 -> ~1px
          var t = 1 - (halfW + HL_CENTER * (1 - (li + 1) / HL_LAYERS)) / (2 * HL_CENTER); // avg brightness of this ring
          var rgb = [0, 1, 2].map(function (k) { return Math.round(HL_EDGE[k] + (HL_PEAK[k] - HL_EDGE[k]) * t); });
          var layer = document.createElementNS(svgNS, 'path');
          layer.setAttribute('class', 'wfd-corner-core wfd-corner-core-hl');
          layer.setAttribute('d', d);
          layer.style.stroke = 'rgb(' + rgb.join(',') + ')';
          layer.style.strokeDasharray = (2 * halfW) + ' ' + (HL_PERIOD - 2 * halfW);
          layer.style.filter = 'none';
          layer.style.setProperty('--o', (-(HL_CENTER - halfW)) + 'px');
          svg.appendChild(layer);
        }
      }

      canvas.appendChild(svg);
    }

    function wfdLoadLogs() {
      var search = logSearch ? logSearch.value : '';
      fetch('/solaris/api/workflow-logs?id=' + encodeURIComponent(wfdId) + '&search=' + encodeURIComponent(search))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var logs = (d.logs || []).slice().reverse();
          if (logCount) logCount.textContent = logs.length;
          if (!logs.length) { logList.innerHTML = '<p class="wfd-log-empty">No logs yet.</p>'; return; }
          logList.innerHTML = logs.map(function (l) {
            return '<div class="wfd-log-row"><span>' + esc(l.ts) + '</span><span>' + esc(l.workflow_id) + '</span><span>' + esc(l.message) + '</span></div>';
          }).join('');
        }).catch(function () {});
    }

    function wfdScheduleAuto(status) {
      clearTimeout(wfdAutoTimer);
      var auto = autoCheckbox && autoCheckbox.checked;
      if (auto && status !== 'completed' && status !== 'cancelled') {
        wfdAutoTimer = setTimeout(wfdLoad, 5000);
      }
    }

    if (refreshBtn) refreshBtn.addEventListener('click', wfdLoad);
    if (logSearch) logSearch.addEventListener('input', wfdLoadLogs);
    if (autoCheckbox) autoCheckbox.addEventListener('change', function () { wfdScheduleAuto(wfdLastWorkflow ? wfdLastWorkflow.status : 'in_progress'); });

    var wfdResizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(wfdResizeTimer);
      wfdResizeTimer = setTimeout(function () {
        if (wfdLastWorkflow) requestAnimationFrame(function () { wfdRenderStages(wfdLastWorkflow); });
      }, 150);
    });

    wfdLoad();
  }

  window.__solarisInit = window.__solarisInit || {};
  window.__solarisInit.scraperWorkflowDetail = initScraperWorkflowDetail;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initScraperWorkflowDetail);
  } else {
    initScraperWorkflowDetail();
  }
})();

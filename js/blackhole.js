/* ---- Black hole power button ---- */
/* solaris-blackhole.js — clicking the black-hole power button pulls the
   sun, all planets, and the starfield into it, then shuts the server down.

   Before any of that plays, checks /solaris/shutdown-check — if a
   Scraper Abyss workflow is actually running (a background thread is
   alive for it right now, not paused/finished — see solaris.py's
   _running_workflow_block()), shows a blocking popup naming it instead
   of playing the destructive animation. The real /shutdown POST at the
   end of the animation re-checks this itself too, as the authoritative
   gate — the pre-check here is purely to avoid animating the whole
   scene away only to then show an error over an empty screen. */
(function () {
  'use strict';

  // Splits an element's text into one <span> per character (in place),
  // so each letter can be animated independently.
  function splitIntoLetterSpans(el) {
    const text = el.textContent;
    el.textContent = '';
    const frag = document.createDocumentFragment();
    const spans = [];
    for (const ch of text) {
      const span = document.createElement('span');
      span.style.display = 'inline-block';
      span.textContent = ch === ' ' ? '\u00A0' : ch;
      frag.appendChild(span);
      spans.push(span);
    }
    el.appendChild(frag);
    return spans;
  }

  // Pulls each letter toward (targetX, targetY), starting with whichever
  // letters are already closest to the black hole and rippling outward —
  // the "gravity picks off the nearest matter first" illusion — rather
  // than every letter starting at once. Returns how long the whole
  // sequence takes, in ms, so the caller can time the shutdown after it.
  function suckLetters(spans, targetX, targetY) {
    const STAGGER_MS = 22;
    const DUR_S = 0.7;

    const ordered = spans
      .map((span) => {
        const r = span.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        return { span, cx, cy, dist: Math.hypot(targetX - cx, targetY - cy) };
      })
      .sort((a, b) => a.dist - b.dist);

    ordered.forEach(({ span, cx, cy }, i) => {
      const dx = targetX - cx;
      const dy = targetY - cy;
      const delay = i * STAGGER_MS;
      span.style.transition = `transform ${DUR_S}s cubic-bezier(0.55, 0, 0.85, 0.35) ${delay}ms, opacity ${DUR_S}s ease-in ${delay}ms`;
      span.style.willChange = 'transform, opacity';
      void span.offsetWidth;
      span.style.transform = `translate(${dx}px, ${dy}px) scale(0.1) rotate(360deg)`;
      span.style.opacity = '0';
    });

    return ordered.length * STAGGER_MS + DUR_S * 1000;
  }

  function showBlockedPopup(message) {
    // Self-contained — this file can't assume any tab-specific JS
    // (e.g. Scraper Abyss's own toast helper) has ever been mounted,
    // since Terminus lives on the home page, not inside a tab. Same
    // frosted-glass "cloud" treatment as the rest of the app
    // (backdrop-filter blur + saturate) rather than a bare alert().
    var overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(0,0,0,0.4);opacity:0;transition:opacity .2s ease;';

    var card = document.createElement('div');
    card.style.cssText =
      'max-width:380px;margin:20px;padding:22px 24px;border-radius:16px;text-align:center;' +
      'background:rgba(255,255,255,0.08);backdrop-filter:blur(16px) saturate(130%);' +
      'border:1px solid rgba(248,113,113,0.4);box-shadow:0 20px 50px rgba(0,0,0,0.5);' +
      'font-family:\'Segoe UI\',system-ui,sans-serif;color:#eef1fa;' +
      'transform:scale(0.92);transition:transform .2s ease;';
    card.innerHTML =
      '<div style="width:42px;height:42px;margin:0 auto 12px;border-radius:50%;' +
        'background:rgba(248,113,113,0.15);display:flex;align-items:center;justify-content:center;">' +
        '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2" ' +
          'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle>' +
          '<line x1="12" y1="8" x2="12" y2="13"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>' +
      '</div>' +
      '<div style="font-size:14px;font-weight:700;margin-bottom:6px;">Can\'t shut down yet</div>' +
      '<div id="bh-blocked-msg" style="font-size:12.5px;color:#c7ccd6;line-height:1.5;margin-bottom:18px;"></div>' +
      '<button type="button" id="bh-blocked-ok" style="padding:9px 26px;border:none;border-radius:999px;' +
        'background:#f87171;color:#1a0505;font-size:12.5px;font-weight:700;cursor:pointer;">OK</button>';
    card.querySelector('#bh-blocked-msg').textContent = message; // textContent, not innerHTML — message embeds a workflow id
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    requestAnimationFrame(function () { overlay.style.opacity = '1'; card.style.transform = 'scale(1)'; });

    function dismiss() {
      overlay.style.opacity = '0';
      card.style.transform = 'scale(0.92)';
      setTimeout(function () { overlay.remove(); }, 200);
    }
    card.querySelector('#bh-blocked-ok').addEventListener('click', dismiss);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) dismiss(); });
  }

  function init() {
    const btn = document.querySelector('.blackhole-btn');
    if (!btn) return;

    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      btn.disabled = true;

      // Pre-check BEFORE playing the destructive suck-in animation —
      // asking after (the old behavior) would mean the sun, every
      // planet, and the whole starfield already got pulled apart and
      // faded out, only to show a blocking error on top of an empty
      // scene. See solaris.py's /shutdown-check and _running_workflow_
      // block() for what "safe" means here.
      fetch('/solaris/shutdown-check')
        .then((r) => r.json())
        .then((d) => {
          if (!d.ok) {
            btn.disabled = false;
            showBlockedPopup('Workflow ' + d.workflow_id + ' is running. Please wait until it completes.');
            return;
          }
          runShutdownSequence(btn);
        })
        .catch(() => {
          // Couldn't even reach the server to ask — proceed as before
          // rather than leaving Terminus permanently unusable; the
          // real /shutdown POST at the end of the animation still
          // re-checks authoritatively and will refuse if unsafe.
          runShutdownSequence(btn);
        });
    });
  }

  function runShutdownSequence(btn) {
      const holeRect = btn.getBoundingClientRect();
      const targetX = holeRect.left + holeRect.width / 2;
      const targetY = holeRect.top + holeRect.height / 2;

      // Sun + planet visuals still suck in as whole blobs. Each planet's
      // visual wrapper is targeted directly (.planet-node's first child)
      // rather than the whole .planet-node anchor — .planet-node also
      // contains the label, and transforming both the anchor AND the
      // label independently would compound (nested transforms stack),
      // sending letters further than intended.
      const blobTargets = [
        document.querySelector('.sun-wrap'),
        ...Array.from(document.querySelectorAll('.planet-node')).map((n) => n.firstElementChild),
      ].filter(Boolean);

      blobTargets.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        const elCenterX = r.left + r.width / 2;
        const elCenterY = r.top + r.height / 2;
        const dx = targetX - elCenterX;
        const dy = targetY - elCenterY;

        el.style.transition = `transform 1.1s cubic-bezier(0.55, 0, 0.85, 0.35) ${i * 90}ms, opacity 1.1s ease-in ${i * 90}ms`;
        el.style.willChange = 'transform, opacity';
        // force reflow so the transition actually applies before we change values
        void el.offsetWidth;
        el.style.transform = `translate(${dx}px, ${dy}px) scale(0.02) rotate(540deg)`;
        el.style.opacity = '0';
      });

      // All text — title, tagline, planet labels, and the Terminus label
      // itself — pulled apart letter by letter (see suckLetters above)
      // instead of dragged in as whole blocks.
      let textDurationMs = 0;
      const textEls = [
        document.querySelector('.solaris-title'),
        document.querySelector('.solaris-tagline'),
        ...document.querySelectorAll('.planet-label'),
        document.querySelector('.blackhole-label'),
      ].filter(Boolean);
      textEls.forEach((el) => {
        const spans = splitIntoLetterSpans(el);
        textDurationMs = Math.max(textDurationMs, suckLetters(spans, targetX, targetY));
      });

      // pull the starfield in on the same timeline
      if (window.solarisSuckStars) {
        const canvas = document.getElementById('starfield');
        const cRect = canvas.getBoundingClientRect();
        window.solarisSuckStars(targetX - cRect.left, targetY - cRect.top, 1600);
      }

      // brighten/pulse the black hole itself while it feeds
      btn.classList.add('is-feeding');

      const totalDelay = Math.max(blobTargets.length * 90 + 1200, textDurationMs + 200);

      setTimeout(() => {
        // A deliberate power-off via Terminus actually shuts the server
        // process down (see /solaris/shutdown in solaris.py), which also
        // resets the GLOBAL power flag every tab/link relies on — so
        // every tab, new window, and direct link shows the boot screen
        // again from here on, until the sun is clicked again.
        showShuttingDownOverlay();
        fetch('/solaris/shutdown', { method: 'POST' })
          .then((r) => r.json().catch(() => ({})).then((d) => ({ status: r.status, body: d })))
          .then(({ status, body }) => {
            // Authoritative re-check refused it — a workflow started
            // during the animation itself (rare race, see solaris.py's
            // /shutdown route comment). The suck-in animation already
            // played, so restore the page instead of leaving the sun/
            // planets/starfield gone with a server that's still alive.
            if (status === 409 && body && body.blocked) {
              document.body.removeChild(document.body.lastElementChild); // the "powered down" overlay
              btn.disabled = false;
              btn.classList.remove('is-feeding');
              showBlockedPopup('Workflow ' + body.workflow_id + ' is running. Please wait until it completes.');
              window.location.reload();
            }
          })
          .catch(() => {
            // server may drop the connection as it exits — that's expected
            // in the normal (allowed) shutdown case.
          });
      }, totalDelay);
  }

  function showShuttingDownOverlay() {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; inset: 0; background: #000; color: #cbd5e1;
      display: flex; align-items: center; justify-content: center;
      font-family: 'Segoe UI', system-ui, sans-serif; font-size: 18px;
      letter-spacing: 0.04em; z-index: 999; opacity: 0;
      transition: opacity 0.6s ease;
    `;
    overlay.textContent = 'Solaris powered down.';
    document.body.appendChild(overlay);
    requestAnimationFrame(() => { overlay.style.opacity = '1'; });
  }

  window.__solarisInit = window.__solarisInit || {};
  window.__solarisInit.blackhole = init;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();


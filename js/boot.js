/* ---- Power-on boot sequence ---- */
/* boot.js — every fresh page load renders powered-off ONLY if Solaris's
   GLOBAL server-side power flag (see solaris.py) is off: only the sun
   shows, desaturated; the title is dim and greyed out; the planets and
   the Terminus button are hidden. They're still fully present in the
   DOM the whole time though (see css/base.css's body.solaris-booting
   rules — opacity only, never display:none), so all their assets are
   already warm in the background; "turning on" is just a reveal, not a
   build. Clicking the sun removes body.solaris-booting: a pulse spreads
   out from the sun (css/base.css's .power-pulse), the sun's own
   desaturation clears, and the title/planets/Terminus fade in one after
   another via the transition-delay stagger below.
   Power state is GLOBAL, not per-tab: solaris.py renders <body> with
   solaris-booting already present or absent based on a single
   server-side flag shared by every client. Clicking the sun here just
   flips that flag on server-side (POST /solaris/power-on) — after that,
   any OTHER tab, new window, or direct/bookmarked link renders straight
   into the powered-on state with no boot screen at all, until Terminus
   shuts the server down (js/blackhole.js), which ends the flag along
   with the process. Detecting the home page uses [data-page="home"]
   rather than the presence of #sun-canvas, since tab.js injects a
   decorative element with that same id into every tab page's nav
   cluster for the "back to home" icon. */
(function () {
  'use strict';

  function initBoot() {
    // Only the home fragment carries data-page="home" — unlike checking
    // for #sun-canvas, this can't be confused by the small decorative
    // sun icon tab.js injects into every tab page's nav cluster (which
    // reuses the same id="sun-canvas").
    const isHomePage = !!document.querySelector('[data-page="home"]');
    const canvas = document.getElementById('sun-canvas');

    if (!isHomePage || !canvas) {
      // Not the home page (a tab page) — nothing to boot, but make sure
      // a stale class from a previous fragment never lingers on <body>.
      // (In practice tab pages only ever render once the server's
      // global flag is already on, so this class won't be present here
      // anyway — this is just a defensive no-op.)
      document.body.classList.remove('solaris-booting');
      return;
    }

    if (!document.body.classList.contains('solaris-booting')) {
      // Server already says Solaris is powered on globally — nothing
      // to boot, no click needed.
      return;
    }

    // While powered off nothing may be reachable. The planets and the Terminus
    // button are hidden with opacity:0 + pointer-events:none, which stops the
    // mouse but NOT the keyboard - the Tab key still landed on them and Enter
    // started a transition (and Enter on the invisible Terminus button would
    // have started a shutdown). `inert` removes them from the tab order and
    // blocks activation entirely until the sun is clicked.
    const lockedWhileOff = Array.from(document.querySelectorAll('.planet-node, .blackhole-btn'));
    lockedWhileOff.forEach((node) => node.setAttribute('inert', ''));

    function powerOn() {
      canvas.removeEventListener('click', powerOn);
      lockedWhileOff.forEach((node) => node.removeAttribute('inert'));

      // Flip the GLOBAL flag on server-side. Best-effort: even if this
      // request fails, this tab still powers on locally below — it's
      // only OTHER tabs/windows that would miss out on skipping boot.
      fetch('/solaris/power-on', { method: 'POST' }).catch(() => { /* ignore */ });

      const rect = canvas.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;

      const pulse = document.createElement('div');
      pulse.className = 'power-pulse';
      pulse.style.left = `${cx}px`;
      pulse.style.top = `${cy}px`;
      document.body.appendChild(pulse);
      void pulse.offsetWidth; // lock the starting frame in before animating
      pulse.style.transform = 'scale(70)';
      pulse.style.opacity = '0';
      setTimeout(() => pulse.remove(), 1600);

      // Stagger planets and Terminus in one by one as the "wave" from
      // the sun would reach them, instead of all appearing at once.
      Array.from(document.querySelectorAll('.planet-node')).forEach((node, i) => {
        node.style.transitionDelay = `${350 + i * 220}ms`;
      });
      const blackhole = document.querySelector('.blackhole-btn');
      if (blackhole) blackhole.style.transitionDelay = '300ms';

      document.body.classList.remove('solaris-booting');
    }

    canvas.addEventListener('click', powerOn);
  }

  window.__solarisInit = window.__solarisInit || {};
  window.__solarisInit.boot = initBoot;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBoot);
  } else {
    initBoot();
  }
})();

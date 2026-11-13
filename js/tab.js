/* tab.js — shared behavior for the 4 planet tab pages' nav cluster.
   Registers window.__solarisInit.tab so the SPA router (router.js) can
   re-run this after every fragment swap, not just on the very first
   page load — the injected planet markup and click bindings need to
   be redone each time a tab fragment gets swapped into #app, since the
   previous fragment's DOM (and its listeners) was just discarded. */
(function () {
  'use strict';

  // Scroll buttons: the Top/Bottom pair beside the Log button and the "Top"
  // button above each Activity Log all carry data-scroll="top|bottom". One
  // delegated listener on document (added once) covers every tab, including
  // fragments swapped in later by the SPA router. Jumps instantly — the point
  // is to skip the scrolling, not to animate it.
  // On these pages the <body> itself is the scroll container (overflow-y:auto
  // at viewport height), so window.scrollTo() would do nothing. Use whichever
  // element actually scrolls, falling back to <body>.
  function scrollBox() {
    var cands = [document.body, document.scrollingElement, document.documentElement];
    for (var i = 0; i < cands.length; i++) {
      var el = cands[i];
      if (el && el.scrollHeight > el.clientHeight + 1) {
        var oy = getComputedStyle(el).overflowY;
        if (el === document.scrollingElement || oy === 'auto' || oy === 'scroll') return el;
      }
    }
    return document.body;
  }
  if (!window.__solarisScrollNav) {
    window.__solarisScrollNav = true;
    document.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('[data-scroll]');
      if (!btn) return;
      if (document.body.classList.contains('solaris-transitioning')) return; // locked during page transitions
      var box = scrollBox();
      box.scrollTop = btn.getAttribute('data-scroll') === 'top' ? 0 : box.scrollHeight;
    });
  }

  // Same markup solaris.html uses for each planet, just without the
  // outer <a>/label wrapper (the cluster node itself is the link).
  var PLANET_MARKUP = {
    'sun':
      '<span class="sun-wrap">' +
        '<span class="sun-flare" aria-hidden="true"></span>' +
        '<canvas id="sun-canvas" class="sun-orb" aria-hidden="true"></canvas>' +
      '</span>',
    'job-odyssey':
      '<div class="saturn-system">' +
        '<span class="planet-ring-back" aria-hidden="true"><span class="ring-squash"><span class="ring-spin"></span></span></span>' +
        '<div class="planet-orb planet-saturn"></div>' +
        '<span class="planet-ring-front" aria-hidden="true"><span class="ring-squash"><span class="ring-spin"></span></span></span>' +
      '</div>',
    'career-voyager':
      '<div class="mars-system">' +
        '<div class="planet-orb planet-mars"></div>' +
        '<span class="voyager-sat" id="voyager-sat" aria-hidden="true"><span class="sat-dish"></span></span>' +
      '</div>',
    'scraper-abyss':
      '<div class="abyss-system">' +
        '<div class="planet-orb planet-neptune">' +
          '<span class="sonar-ping"></span>' +
          '<span class="sonar-ping sonar-ping--delayed"></span>' +
        '</div>' +
        '<span class="sonar-probe" id="sonar-probe" aria-hidden="true"><span class="sonar-light"></span></span>' +
      '</div>',
    'profile-nexus':
      '<div class="planet-orb planet-gold">' +
        '<span class="twinkle"></span><span class="twinkle"></span><span class="twinkle"></span><span class="twinkle"></span>' +
        '<span class="twinkle"></span><span class="twinkle"></span><span class="twinkle"></span><span class="twinkle"></span>' +
      '</div>',
  };

  function injectPlanetMarkup() {
    document.querySelectorAll('[data-planet-shell]').forEach(function (shell) {
      var key = shell.getAttribute('data-planet-shell');
      if (PLANET_MARKUP[key]) shell.innerHTML = PLANET_MARKUP[key];
    });
  }

  function setupTabPage() {
    // No-op safely if the current #app content isn't a tab fragment —
    // same self-guarding pattern as the planet init functions.
    injectPlanetMarkup();

    // Mini planet circles -> orbit-rotate to that tab (see the
    // rotateToTab shrink/swap/reduce/rotate/swap/grow choreography in
    // transition.js). Falls back to the plain iris warp if
    // transition.js somehow isn't loaded or the layout doesn't match
    // what rotateToTab expects.
    document.querySelectorAll('.cluster-mini').forEach(function (link) {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        var key = link.getAttribute('data-planet');
        var href = link.getAttribute('href');
        if (!href || !key) return;
        if (window.SolarisTransition && SolarisTransition.rotateToTab) {
          SolarisTransition.rotateToTab(href, key);
        } else if (window.SolarisTransition) {
          SolarisTransition.preloadTextures(key);
          SolarisTransition.warpTo(href, { originEl: link, color: '#05060c' });
        }
      });
    });

    // Home -> converge cluster into the Home icon, then the home page
    // plays the matching expand-out entrance (true reverse of the
    // home->tab collapse, not the iris effect)
    var home = document.getElementById('cluster-home');
    if (home) {
      home.addEventListener('click', function (e) {
        e.preventDefault();
        SolarisTransition.collapseToHome();
      });
    }
  }

  window.__solarisInit = window.__solarisInit || {};
  window.__solarisInit.tab = setupTabPage;

  document.addEventListener('DOMContentLoaded', function () {
    setupTabPage();
    // In case this page was itself reached via warpTo() from somewhere,
    // play the matching entrance. No-op otherwise.
    if (window.SolarisTransition) SolarisTransition.playEntrance();
  });
})();

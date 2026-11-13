/* router.js — SPA navigation. Fetches just the page's content fragment
   and swaps it into #app instead of a full browser reload, so the
   persistent shell (starfield, loaded scripts) never restarts.

   Each planet/tab file registers a re-callable init function on
   window.__solarisInit (see the bottom of saturn.js/mars.js/etc and
   tab.js) — every one of those functions already self-guards with a
   null check on its own target element, so it's safe to just call ALL
   of them after every swap; only the ones relevant to the new fragment
   will actually do anything. */
(function () {
  'use strict';

  const ROUTER_HEADER = 'X-Solaris-Router';

  // Maps url -> Promise<html text>. transition.js calls prefetch(url) the
  // moment a collapse/warp animation STARTS (not when it finishes), so the
  // network round-trip overlaps the ~1s animation instead of happening
  // after it. By the time navigate() actually runs, the fragment is
  // usually already sitting here — turning what used to be "animation
  // ends, THEN wait for the server, THEN swap" into "animation ends,
  // swap immediately." Entries are consumed (deleted) on use so a later
  // revisit to the same url fetches fresh content rather than reusing a
  // stale response forever.
  const prefetchCache = new Map();

  // The server tags every response X-Solaris-Power: on|off. "off" on a
  // navigation means this page was open across a server restart: the server
  // now answers with the home/boot page (a redirect, which fetch follows
  // silently) instead of the page we asked for. That body must NEVER be
  // swapped in - it used to land under the tab's own URL, leaving the home
  // screen at a tab address. js/shared.js shows the "server was restarted"
  // popup; here the navigation just stops (poweredOff marks the error so no
  // fallback page load runs behind the popup).
  // NB: an ordinary redirect (e.g. /career-voyager -> /career-voyager/apps)
  // is NOT this case and still navigates in-page as before.
  function isPoweredOff(res) { return res.headers.get('X-Solaris-Power') === 'off'; }
  function poweredOffError() { const e = new Error('powered off'); e.poweredOff = true; return e; }

  function prefetch(url) {
    if (!prefetchCache.has(url)) {
      const p = fetch(url, { headers: { [ROUTER_HEADER]: '1' } })
        .then((res) => {
          if (isPoweredOff(res)) throw poweredOffError(); // see below — never swap in the home page the server sends while off
          return res.ok ? res.text() : Promise.reject(new Error('bad status'));
        })
        .catch((err) => {
          prefetchCache.delete(url); // don't poison future navigate() calls with a rejected promise
          throw err;
        });
      prefetchCache.set(url, p);
    }
    return prefetchCache.get(url);
  }

  function getApp() {
    return document.getElementById('app');
  }

  // body[data-page-key="..."] is what every per-tab --scroll-thumb
  // override (css/base.css, job_odyssey_ui.css, career_voyager_ui.css,
  // profile_nexus_ui.css) is scoped to. It's only ever written server-side,
  // once, in html/shell.html on the very first full page load. Since this
  // router swaps #app's innerHTML instead of reloading the page, that
  // attribute was being left stuck on whatever page loaded first FOREVER —
  // every subsequent SPA navigation kept the original page's scrollbar
  // color no matter which tab was actually showing. Each fragment's root
  // element carries the info needed to fix it: data-page="home" for the
  // home fragment, or data-page="tab" + data-current-planet="job-odyssey"
  // (etc, see html/fragments/tab.html) for the 4 tab fragments.
  function syncPageKey(root) {
    if (!root) return;
    const page = root.dataset ? root.dataset.page : null;
    const key = page === 'home' ? 'home'
      : page === 'tab' ? (root.dataset.currentPlanet || null)
      : null;
    if (key) document.body.dataset.pageKey = key;
  }

  // Used instead of animating opacity from a hard 0. reinit() below can do
  // real synchronous work (sun.js rebuilds its whole WebGL context on
  // EVERY navigation, since every page — home and all 4 tabs — has its
  // own #sun-canvas). While that blocks the main thread, the browser
  // can't paint at all, so nothing appears until the block ends — and if
  // the committed opacity was 0 when it ends, the very FIRST frame the
  // user sees is fully transparent, with no in-between blend. That reads
  // as a black flash, not a fade. A floor of 0.55 instead of 0 means even
  // that worst-case first frame is dim, not black — and because this is
  // a @keyframes animation (not a transition), the browser starts it
  // correctly the moment the class is added, with no forced-reflow dance
  // needed to establish a "from" state first.
  function ensureFadeStyle() {
    if (document.getElementById('solaris-router-fade-style')) return;
    const style = document.createElement('style');
    style.id = 'solaris-router-fade-style';
    style.textContent =
      '@keyframes solaris-app-settle { from { opacity: 0.55; } to { opacity: 1; } }' +
      '#app.solaris-settling { animation: solaris-app-settle 160ms ease-out; }';
    document.head.appendChild(style);
  }

  function reinit() {
    const init = window.__solarisInit || {};
    // 'tab' MUST run first — it injects the planet markup into the nav
    // cluster's placeholder divs, which saturn/mars/abyss/nexus below
    // need to already exist before they can find their target elements.
    const orderedKeys = ['tab', ...Object.keys(init).filter((k) => k !== 'tab')];
    orderedKeys.forEach((key) => {
      const fn = init[key];
      if (!fn) return;
      try { fn(); } catch (e) { console.warn('[router] reinit failed for', key, e); }
    });
    // transition system's own entrance/return animations also need to
    // re-check after a swap (e.g. arriving at home via collapseToHome)
    if (window.SolarisTransition) {
      try { window.SolarisTransition.playEntrance(); } catch (e) { /* ignore */ }
      try { window.SolarisTransition.playHomeReturnEntrance(); } catch (e) { /* ignore */ }
    }
  }

  async function navigate(url, opts) {
    opts = opts || {};
    const app = getApp();
    if (!app) { window.location.href = url; return; } // no SPA shell present — real nav

    try {
      let html;
      if (prefetchCache.has(url)) {
        const p = prefetchCache.get(url);
        prefetchCache.delete(url); // one-shot: consume it so we don't serve it again on a later visit
        html = await p;
      } else {
        const res = await fetch(url, { headers: { [ROUTER_HEADER]: '1' } });
        if (isPoweredOff(res)) throw poweredOffError();
        if (!res.ok) { window.location.href = url; return; }
        html = await res.text();
      }

      // Settle the new fragment in rather than popping it in on the same
      // frame the old one disappears — masks both the hard DOM-replace cut
      // itself and any leftover fetch/render lag prefetch() didn't fully
      // absorb. See ensureFadeStyle() above for why this floors at 0.55
      // instead of animating from a literal 0.
      //
      // opts.skipFade: used by transition.js's cluster-collapse/rotate
      // animations, whose own last frame is built to already match the
      // destination fragment's first frame pixel-for-pixel. Running the
      // 0.55->1 opacity keyframe on TOP of that seamless handoff was
      // itself the visible "blink" — a needless dim-then-brighten over
      // content that never actually changed. Skip it there and swap at
      // full opacity immediately.
      if (!opts.skipFade) ensureFadeStyle();
      app.classList.remove('solaris-settling');
      app.innerHTML = html;
      syncPageKey(app.firstElementChild);
      if (window.SolarisTransition && window.SolarisTransition.hideSkeleton) window.SolarisTransition.hideSkeleton();

      if (opts.replace) {
        history.replaceState({ url }, '', url);
      } else {
        history.pushState({ url }, '', url);
      }

      reinit();
      if (window.SolarisTransition && window.SolarisTransition.endTransition) window.SolarisTransition.endTransition();

      if (!opts.skipFade) {
        // eslint-disable-next-line no-unused-expressions
        void app.offsetWidth; // restart the animation in case the class was already present from a very rapid double-navigation
        app.classList.add('solaris-settling');

        app.addEventListener('animationend', function handler() {
          app.classList.remove('solaris-settling');
          app.removeEventListener('animationend', handler);
        });
      }
    } catch (e) {
      if (e && e.poweredOff) return; // the popup (js/shared.js) is already up; OK takes the user to the start page
      // network hiccup or anything unexpected — fall back to a real
      // navigation rather than leaving the user stuck
      window.location.href = url;
    }
  }

  window.addEventListener('popstate', function () {
    navigate(location.pathname, { replace: true });
  });

  window.SolarisRouter = { navigate, reinit, prefetch };
})();

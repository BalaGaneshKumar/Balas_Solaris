/* shared.js — small shared state used across the other scripts. Must be
   loaded BEFORE sun.js/saturn.js/mars.js/abyss.js/nexus.js/transition.js.

   __solarisTexCache: caches the FINISHED generated texture (not just the
   raw source image) in sessionStorage. The canvas work — mirroring the
   tile, drawing hundreds of grit/noise rectangles, sampling the ring —
   is real CPU time that reruns from scratch on every page load
   regardless of whether the source .jpg/.png is already in the browser's
   HTTP cache. Caching the RESULT is what actually eliminates the
   fallback-color flash on repeat visits.

   __solarisPregenerate: registry each planet file adds itself to, so the
   transition system can trigger real texture generation during the
   collapse animation, before the destination page even starts loading. */
window.__solarisTexCache = window.__solarisTexCache || {
  get(key) { try { return sessionStorage.getItem('stex_' + key); } catch (e) { return null; } },
  set(key, v) { try { sessionStorage.setItem('stex_' + key, v); } catch (e) { /* storage full/unavailable — just skip caching */ } },
};
window.__solarisPregenerate = window.__solarisPregenerate || {};

/* Powered-off guard. The server tags every response X-Solaris-Power: on|off
   (and refuses /solaris/api/* with HTTP 403 while off). A page that was open
   across a server restart still LOOKS powered on, so the first time ANY
   script's fetch (a submit, a poll, an auto-refresh, a page navigation) hears
   "off", this shows a popup instead of silently dumping the user on the boot
   screen: the server was restarted, start it (click the sun) and repeat the
   action. OK takes them to the start page. It is skipped on the boot screen
   itself - that page is meant to be off. Wrapping window.fetch here is why
   this file loads before everything else. */
(function () {
  if (window.__solarisPowerGuard) return;
  window.__solarisPowerGuard = true;

  function showRestartNotice() {
    if (window.__solarisRestartNotice) return;                       // one popup, however many requests fail
    if (document.body.classList.contains('solaris-booting')) return; // this page IS the off screen
    window.__solarisRestartNotice = true;

    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'solaris-restart-title');
    overlay.setAttribute('aria-describedby', 'solaris-restart-text');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(3,5,10,0.74);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);font-family:inherit;';
    overlay.innerHTML =
      '<div style="width:min(440px,90vw);padding:26px 28px 22px;border-radius:16px;background:#0e121c;' +
      'border:1px solid rgba(255,255,255,0.16);box-shadow:0 18px 60px rgba(0,0,0,0.6);color:#e8ecf8;text-align:left;">' +
      '<div id="solaris-restart-title" style="font-size:18px;font-weight:700;margin-bottom:10px;">Server was restarted</div>' +
      '<div id="solaris-restart-text" style="font-size:14px;line-height:1.55;color:#b9c1d9;">' +
      'The server was restarted in the middle, so Solaris is turned off. ' +
      'Please start the server (click the sun) and perform the action again.<br><br>' +
      'Click <b style="color:#e8ecf8;">OK</b> to go to the start page.</div>' +
      '<div style="display:flex;justify-content:flex-end;margin-top:22px;">' +
      '<button type="button" id="solaris-restart-ok" style="min-width:92px;padding:9px 22px;border-radius:999px;cursor:pointer;' +
      'font:inherit;font-size:14px;font-weight:600;color:#fff;background:rgba(32,146,229,0.28);border:1.5px solid rgba(74,168,238,0.7);">OK</button>' +
      '</div></div>';
    document.body.appendChild(overlay);

    const ok = overlay.querySelector('#solaris-restart-ok');
    ok.addEventListener('click', function () { window.location.href = '/solaris'; });
    // keep keyboard focus inside the dialog; Escape does not dismiss it
    overlay.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') { e.preventDefault(); ok.focus(); }
    });
    ok.focus();
  }

  const nativeFetch = window.fetch.bind(window);
  window.fetch = function () {
    return nativeFetch.apply(window, arguments).then(function (res) {
      if (res.headers.get('X-Solaris-Power') === 'off') showRestartNotice();
      return res;
    });
  };
})();

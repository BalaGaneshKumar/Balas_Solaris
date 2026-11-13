/* ---- Scraper Abyss ---- */
/* solaris-abyss.js — Scraper Abyss surface, mapped from a swirling blue
   marble/ocean texture (scraper_abyss_texture.jpg). Same mirrored
   ("ping-pong") tile + scroll technique as solaris-saturn.js /
   solaris-mars.js. No poles to avoid here since it's abstract swirl art,
   not a real planet map, so the crop can just be a straightforward slice.

   Tracks its own two requestAnimationFrame loops (sonar probe orbit +
   surface scroll) at module scope and cancels the previous ones before
   starting new ones — without this, every SPA navigation back to this
   tab page starts ANOTHER overlapping loop, all fighting to set the
   same element's position/style each frame, which reads as jerky. */
(function () {
  'use strict';

  let sonarRafId = null;
  let spinRafId = null;

  // See mars.js for why these live here instead of inside the functions
  // that start the loops: the raf ids were already module-scoped so
  // navigation could cancel a stale loop, but angle/offset were being
  // re-declared to 0 every time those functions re-ran (i.e. every SPA
  // navigation back to this tab) — snapping the orbit/scroll back to
  // frame zero on arrival, which reads as a skipped-frame jerk.
  let sonarAngle = 0;
  let spinOffset = 0;

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function buildAbyssTexture(img, w, h) {
    const base = document.createElement('canvas');
    base.width = w;
    base.height = h;
    const bctx = base.getContext('2d');

    const srcW = img.width, srcH = img.height;
    // crop a wide-but-not-full slice for scroll variety; source has no
    // poles to dodge so we can just center-crop generously
    const lonFrac = 0.85;
    const sx0 = srcW * (0.5 - lonFrac / 2);
    const sw = srcW * lonFrac;
    const latFrac = 0.85;
    const sy0 = srcH * (0.5 - latFrac / 2);
    const sh = srcH * latFrac;

    bctx.filter = 'contrast(1.15) saturate(1.1)';
    bctx.drawImage(img, sx0, sy0, sw, sh, 0, 0, w, h);
    bctx.filter = 'none';

    const canvas = document.createElement('canvas');
    canvas.width = w * 2;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(base, 0, 0, w, h);          // left half: normal
    ctx.save();
    ctx.translate(w * 2, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(base, 0, 0, w, h);           // right half: mirrored
    ctx.restore();

    return canvas.toDataURL('image/png');
  }

  function animateSonarProbe() {
    const probeEl = document.getElementById('sonar-probe');
    const planetEl = document.querySelector('.planet-neptune');
    const pingEls = document.querySelectorAll('.sonar-ping');
    if (sonarRafId !== null) {
      cancelAnimationFrame(sonarRafId);
      sonarRafId = null;
    }
    if (!probeEl || !planetEl) return;

    const rx = 58;
    const ry = rx * 0.5;
    const tilt = 60 * Math.PI / 180; // steeper, different angle from Voyager's -45
    const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
    const ORBIT_SECONDS = 8;

    let lastTs = null; // reset on purpose: first tick after resuming should compute dt≈0, not a huge jump from a stale timestamp

    function frame(ts) {
      if (lastTs === null) lastTs = ts;
      const dt = (ts - lastTs) / 1000;
      lastTs = ts;
      sonarAngle += (Math.PI * 2 / ORBIT_SECONDS) * dt;

      const localX = rx * Math.cos(sonarAngle);
      const localY = ry * Math.sin(sonarAngle);
      const screenX = localX * cosT - localY * sinT;
      const screenY = localX * sinT + localY * cosT;

      probeEl.style.left = `calc(50% + ${screenX.toFixed(2)}px)`;
      probeEl.style.top = `calc(50% + ${screenY.toFixed(2)}px)`;

      const inFront = Math.sin(sonarAngle) > 0;
      probeEl.style.zIndex = inFront ? '2' : '0'; // planet itself is z-index:1
      const depthT = (Math.sin(sonarAngle) + 1) / 2;
      const scale = 0.75 + depthT * 0.35;
      probeEl.style.opacity = (inFront ? 1 : 0.5).toString();
      probeEl.style.transform = `translate(-50%, -50%) rotate(${(sonarAngle * 180 / Math.PI + 90).toFixed(1)}deg) scale(${scale.toFixed(2)})`;

      // ping follows the probe's projected position — pulled in slightly
      // toward center so it reads as scanning the surface beneath it
      pingEls.forEach(el => {
        el.style.left = `calc(50% + ${(screenX * 0.7).toFixed(2)}px)`;
        el.style.top = `calc(50% + ${(screenY * 0.7).toFixed(2)}px)`;
        el.style.visibility = inFront ? 'visible' : 'hidden';
      });

      sonarRafId = requestAnimationFrame(frame);
    }
    sonarRafId = requestAnimationFrame(frame);
  }

  async function getAbyssSurfaceDataUrl() {
    let dataUrl = window.__solarisTexCache.get('abyss-surface');
    if (dataUrl) return dataUrl;
    const surfaceImg = await loadImage('/solaris/Assets/webp/scraper_abyss_texture.webp');
    dataUrl = buildAbyssTexture(surfaceImg, 700, 300); // returns 1400px wide
    window.__solarisTexCache.set('abyss-surface', dataUrl);
    return dataUrl;
  }

  window.__solarisPregenerate['scraper-abyss'] = async function () {
    try { await getAbyssSurfaceDataUrl(); } catch (e) { /* ignore, will retry on the actual page */ }
  };

  async function applyAbyss() {
    const planetEl = document.querySelector('.planet-neptune');
    if (spinRafId !== null) {
      cancelAnimationFrame(spinRafId);
      spinRafId = null;
    }
    if (!planetEl) return;

    animateSonarProbe();

    try {
      const baseW = 700, tileH = 300;
      const dataUrl = await getAbyssSurfaceDataUrl();
      const boxH = planetEl.clientHeight || 110;
      const renderedTileW = (baseW * 2) * (boxH / tileH);

      planetEl.style.backgroundImage = `url(${dataUrl})`;
      planetEl.style.backgroundRepeat = 'repeat-x';
      planetEl.style.backgroundSize = `${renderedTileW}px 100%`;
      planetEl.style.backgroundPosition = '0 center';

      let lastTs = null; // reset on purpose, see comment near the state declarations above
      const SPIN_SPEED = 12; // px per second
      function spin(ts) {
        if (lastTs === null) lastTs = ts;
        const dt = (ts - lastTs) / 1000;
        lastTs = ts;
        spinOffset = (spinOffset + SPIN_SPEED * dt) % renderedTileW;
        planetEl.style.backgroundPosition = `${-spinOffset}px center`;
        spinRafId = requestAnimationFrame(spin);
      }
      spinRafId = requestAnimationFrame(spin);
    } catch (e) {
      console.warn('Scraper Abyss texture failed to load, keeping fallback color.', e);
    }
  }

  window.__solarisInit = window.__solarisInit || {};
  window.__solarisInit.abyss = applyAbyss;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyAbyss);
  } else {
    applyAbyss();
  }
})();

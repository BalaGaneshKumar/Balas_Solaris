/* ---- Career Voyager (Mars) ---- */
/* solaris-mars.js — Career Voyager surface, mapped from a real Mars-style
   texture (2k_mars.jpg). Same mirrored ("ping-pong") tile + scroll
   technique as solaris-saturn.js, no ring/tilt needed for this planet.

   Tracks its own two requestAnimationFrame loops (satellite orbit +
   surface scroll) at module scope and cancels the previous ones before
   starting new ones — without this, every SPA navigation back to this
   tab page starts ANOTHER overlapping loop, all fighting to set the
   same element's position/style each frame, which reads as jerky. */
(function () {
  'use strict';

  let voyagerRafId = null;
  let spinRafId = null;

  // Motion state lives here (module scope), NOT inside the functions that
  // start the loops below. The raf ids already lived here so navigation
  // could cancel a stale loop instead of stacking duplicates — but the
  // actual angle/offset were being re-declared to 0 inside animateVoyager()/
  // applyMars() every time those ran, which is every SPA navigation back to
  // this tab. That meant the orbit and surface scroll silently snapped back
  // to frame zero on every arrival, which reads as a skipped-frame jerk
  // right when the cluster-collapse transition hands off to the real page.
  // Keeping these here means resuming the loop continues exactly where it
  // left off, however long ago that was.
  let voyagerAngle = 0;
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

  function buildMarsTexture(img, w, h) {
    const base = document.createElement('canvas');
    base.width = w;
    base.height = h;
    const bctx = base.getContext('2d');

    const srcW = img.width, srcH = img.height;
    const lonFrac = 0.9;
    const sx0 = srcW * (0.5 - lonFrac / 2);
    const sw = srcW * lonFrac;
    // exclude the bright polar ice caps top/bottom of the source map
    const latFrac = 0.56;
    const sy0 = srcH * (0.5 - latFrac / 2);
    const sh = srcH * latFrac;

    bctx.filter = 'contrast(1.5) saturate(1.25) brightness(1.1)';
    bctx.drawImage(img, sx0, sy0, sw, sh, 0, 0, w, h);
    bctx.filter = 'none';

    // Fine grit/dust noise so the rocky surface doesn't look flat-painted
    for (let i = 0; i < 2600; i++) {
      const yy = Math.random() * h;
      const xx = Math.random() * w;
      const len = 2 + Math.random() * 7;
      const alpha = 0.08 + Math.random() * 0.16;
      bctx.fillStyle = Math.random() > 0.5
        ? `rgba(255,220,190,${alpha})`
        : `rgba(25,10,5,${alpha})`;
      bctx.fillRect(xx, yy, len, 1 + Math.random() * 1.3);
    }

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

  function animateVoyager() {
    const satEl = document.getElementById('voyager-sat');
    const planetEl = document.querySelector('.planet-mars');
    if (voyagerRafId !== null) {
      cancelAnimationFrame(voyagerRafId);
      voyagerRafId = null;
    }
    if (!satEl || !planetEl) return;

    const rx = 59;              // orbit semi-major radius, hugs close to the surface
    const ry = rx * 0.45;       // squash factor for the ellipse
    const tilt = -45 * Math.PI / 180; // top-right to bottom-left
    const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
    const ORBIT_SECONDS = 10;

    let lastTs = null; // reset on purpose: first tick after resuming should compute dt≈0, not a huge jump from a stale timestamp

    function frame(ts) {
      if (lastTs === null) lastTs = ts;
      const dt = (ts - lastTs) / 1000;
      lastTs = ts;
      voyagerAngle += (Math.PI * 2 / ORBIT_SECONDS) * dt;

      // position in the untilted ellipse's own local space, then rotate
      // into screen space by the tilt angle
      const localX = rx * Math.cos(voyagerAngle);
      const localY = ry * Math.sin(voyagerAngle);
      const screenX = localX * cosT - localY * sinT;
      const screenY = localX * sinT + localY * cosT;

      satEl.style.left = `calc(50% + ${screenX.toFixed(2)}px)`;
      satEl.style.top = `calc(50% + ${screenY.toFixed(2)}px)`;

      // sin(angle) > 0 = near/front half of the tilted loop, else far/behind
      const inFront = Math.sin(voyagerAngle) > 0;
      satEl.style.zIndex = inFront ? '2' : '0'; // planet itself is z-index:1
      // slight fade + shrink on the far side sells the depth further
      const depthT = (Math.sin(voyagerAngle) + 1) / 2; // 0 = far, 1 = near
      const scale = 0.75 + depthT * 0.35;
      satEl.style.opacity = (inFront ? 1 : 0.55).toString();
      satEl.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(2)})`;

      voyagerRafId = requestAnimationFrame(frame);
    }
    voyagerRafId = requestAnimationFrame(frame);
  }

  async function getMarsSurfaceDataUrl() {
    let dataUrl = window.__solarisTexCache.get('mars-surface');
    if (dataUrl) return dataUrl;
    const surfaceImg = await loadImage('/solaris/Assets/webp/2k_mars.webp');
    dataUrl = buildMarsTexture(surfaceImg, 700, 300); // returns 1400px wide
    window.__solarisTexCache.set('mars-surface', dataUrl);
    return dataUrl;
  }

  window.__solarisPregenerate['career-voyager'] = async function () {
    try { await getMarsSurfaceDataUrl(); } catch (e) { /* ignore, will retry on the actual page */ }
  };

  async function applyMars() {
    const planetEl = document.querySelector('.planet-mars');
    if (spinRafId !== null) {
      cancelAnimationFrame(spinRafId);
      spinRafId = null;
    }
    if (!planetEl) return;

    animateVoyager();

    try {
      const baseW = 700, tileH = 300;
      const dataUrl = await getMarsSurfaceDataUrl();
      const boxH = planetEl.clientHeight || 110;
      const renderedTileW = (baseW * 2) * (boxH / tileH);

      planetEl.style.backgroundImage = `url(${dataUrl})`;
      planetEl.style.backgroundRepeat = 'repeat-x';
      planetEl.style.backgroundSize = `${renderedTileW}px 100%`;
      planetEl.style.backgroundPosition = '0 center';

      let lastTs = null; // reset on purpose, see comment near the state declarations above
      const SPIN_SPEED = 14; // px per second
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
      console.warn('Mars surface texture failed to load, keeping fallback color.', e);
    }
  }

  window.__solarisInit = window.__solarisInit || {};
  window.__solarisInit.mars = applyMars;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyMars);
  } else {
    applyMars();
  }
})();

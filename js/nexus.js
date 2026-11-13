/* ---- Profile Nexus ---- */
/* solaris-nexus.js — Profile Nexus surface, mapped from a real icy/rocky
   dwarf-planet-style texture (2k_nexus.jpg). Pushed toward maximum
   roughness and a cold silver tint per request — heavier grit noise and
   contrast than Mars/Saturn. Same mirrored-tile scroll technique.

   Tracks its own two requestAnimationFrame loops (twinkle stars +
   surface scroll) at module scope and cancels the previous ones before
   starting new ones — without this, every SPA navigation back to this
   tab page starts ANOTHER overlapping loop, all fighting to set the
   same elements' style each frame, which reads as jerky. */
(function () {
  'use strict';

  let twinkleRafId = null;
  let spinRafId = null;

  // See mars.js for why these live here instead of inside the functions
  // that start the loops: the raf ids were already module-scoped so
  // navigation could cancel a stale loop, but the twinkle phases/speeds
  // and the spin offset were being regenerated from scratch every time
  // those functions re-ran (i.e. every SPA navigation back to this tab)
  // — snapping the sparkle rhythm and surface scroll back to frame zero
  // on arrival, which reads as a skipped-frame jerk.
  let twinklePhases = null;
  let twinkleSpeeds = null;
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

  function buildNexusTexture(img, w, h) {
    const base = document.createElement('canvas');
    base.width = w;
    base.height = h;
    const bctx = base.getContext('2d');

    const srcW = img.width, srcH = img.height;
    const lonFrac = 0.9;
    const sx0 = srcW * (0.5 - lonFrac / 2);
    const sw = srcW * lonFrac;
    const latFrac = 0.6;
    const sy0 = srcH * (0.5 - latFrac / 2);
    const sh = srcH * latFrac;

    // Strong contrast + desaturation-toward-blue-white for a cold silver
    // metallic read, per request ("more silverish").
    bctx.filter = 'contrast(1.6) saturate(0.55) brightness(0.92) hue-rotate(190deg)';
    bctx.drawImage(img, sx0, sy0, sw, sh, 0, 0, w, h);
    bctx.filter = 'none';

    // Slight silver-blue color wash on top to unify the tint
    bctx.fillStyle = 'rgba(190, 205, 220, 0.1)';
    bctx.fillRect(0, 0, w, h);

    // Maximum roughness: heavy fine grit + coarser rock speckle, denser
    // and higher-contrast than the Mars treatment.
    for (let i = 0; i < 3200; i++) {
      const yy = Math.random() * h;
      const xx = Math.random() * w;
      const len = 1.5 + Math.random() * 6;
      const alpha = 0.08 + Math.random() * 0.2;
      bctx.fillStyle = Math.random() > 0.5
        ? `rgba(255,255,255,${alpha})`
        : `rgba(10,15,20,${alpha})`;
      bctx.fillRect(xx, yy, len, 1 + Math.random() * 1.6);
    }
    for (let i = 0; i < 500; i++) {
      const yy = Math.random() * h;
      const xx = Math.random() * w;
      const r = 1 + Math.random() * 3;
      bctx.beginPath();
      bctx.arc(xx, yy, r, 0, Math.PI * 2);
      bctx.fillStyle = Math.random() > 0.5
        ? 'rgba(235,240,250,0.25)'
        : 'rgba(15,18,25,0.3)';
      bctx.fill();
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

  function animateTwinkles() {
    const stars = document.querySelectorAll('.planet-gold .twinkle');
    if (twinkleRafId !== null) {
      cancelAnimationFrame(twinkleRafId);
      twinkleRafId = null;
    }
    if (!stars.length) return;

    // Only roll new random phases/speeds the first time (or if the
    // fragment's star count ever changes) — reusing them on every
    // subsequent re-init is what keeps the twinkle rhythm continuous
    // instead of jumping to a new random pattern on each arrival.
    if (!twinklePhases || twinklePhases.length !== stars.length) {
      twinklePhases = Array.from(stars).map((_, i) => Math.random() * Math.PI * 2 + i);
      twinkleSpeeds = Array.from(stars).map(() => 1.8 + Math.random() * 0.9);
    }
    const phases = twinklePhases;
    const speeds = twinkleSpeeds;
    // note: `ts` below is the rAF timestamp, which is relative to page load
    // and never resets — since this script only ever loads once per SPA
    // session, that's what keeps the sine wave itself continuous too.

    function frame(ts) {
      const t = ts / 1000;
      stars.forEach((el, i) => {
        const baseScale = parseFloat(getComputedStyle(el).getPropertyValue('--base-scale')) || 0.7;
        const wave = (Math.sin(t * speeds[i] + phases[i]) + 1) / 2; // 0..1
        const opacity = 0.1 + wave * 0.9;
        const scale = baseScale * (0.7 + wave * 0.6);
        const rotate = wave * 70;
        const drift = (wave - 0.5) * 3;
        el.style.opacity = opacity.toFixed(2);
        el.style.transform = `translate(${drift.toFixed(2)}px, ${(-drift).toFixed(2)}px) rotate(${rotate.toFixed(1)}deg) scale(${scale.toFixed(2)})`;
      });
      twinkleRafId = requestAnimationFrame(frame);
    }
    twinkleRafId = requestAnimationFrame(frame);
  }

  async function getNexusSurfaceDataUrl() {
    let dataUrl = window.__solarisTexCache.get('nexus-surface');
    if (dataUrl) return dataUrl;
    const surfaceImg = await loadImage('/solaris/Assets/webp/2k_nexus.webp');
    dataUrl = buildNexusTexture(surfaceImg, 700, 300); // returns 1400px wide
    window.__solarisTexCache.set('nexus-surface', dataUrl);
    return dataUrl;
  }

  window.__solarisPregenerate['profile-nexus'] = async function () {
    try { await getNexusSurfaceDataUrl(); } catch (e) { /* ignore, will retry on the actual page */ }
  };

  async function applyNexus() {
    const planetEl = document.querySelector('.planet-gold');
    if (spinRafId !== null) {
      cancelAnimationFrame(spinRafId);
      spinRafId = null;
    }
    if (!planetEl) return;

    animateTwinkles();

    try {
      const baseW = 700, tileH = 300;
      const dataUrl = await getNexusSurfaceDataUrl();
      const boxH = planetEl.clientHeight || 110;
      const renderedTileW = (baseW * 2) * (boxH / tileH);

      planetEl.style.backgroundImage = `url(${dataUrl})`;
      planetEl.style.backgroundRepeat = 'repeat-x';
      planetEl.style.backgroundSize = `${renderedTileW}px 100%`;
      planetEl.style.backgroundPosition = '0 center';

      let lastTs = null; // reset on purpose: first tick after resuming should compute dt≈0, not a huge jump from a stale timestamp
      const SPIN_SPEED = 13; // px per second
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
      console.warn('Profile Nexus texture failed to load, keeping fallback color.', e);
    }
  }

  window.__solarisInit = window.__solarisInit || {};
  window.__solarisInit.nexus = applyNexus;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyNexus);
  } else {
    applyNexus();
  }
})();

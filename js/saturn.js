/* ---- Job Odyssey (Saturn) ---- */
/* solaris-saturn.js — Saturn surface + ring, mapped from real texture
   images (2k_saturn.jpg, 2k_saturn_ring_alpha.png). The surface is built
   as a mirrored ("ping-pong") tile so it can scroll/spin with no visible
   seam; the ring samples the real ring image radially for banding. */
(function () {
  'use strict';

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function buildSaturnTexture(img, w, h) {
    // Build one base crop, then mirror it beside itself so the final
    // tile (2w wide) wraps with no seam.
    const base = document.createElement('canvas');
    base.width = w;
    base.height = h;
    const bctx = base.getContext('2d');

    const srcW = img.width, srcH = img.height;
    const lonFrac = 0.9;
    const sx0 = srcW * (0.5 - lonFrac / 2);
    const sw = srcW * lonFrac;
    const latFrac = 0.62;
    const sy0 = srcH * (0.5 - latFrac / 2);
    const sh = srcH * latFrac;

    bctx.drawImage(img, sx0, sy0, sw, sh, 0, 0, w, h);

    // Gas-giant turbulence: streaky noise along the band direction so the
    // surface reads as swirling atmosphere, not a smooth painted marble.
    for (let i = 0; i < 700; i++) {
      const yy = Math.random() * h;
      const xx = Math.random() * w;
      const len = 14 + Math.random() * 46;
      const alpha = 0.05 + Math.random() * 0.10;
      bctx.fillStyle = Math.random() > 0.5
        ? `rgba(255,244,215,${alpha})`
        : `rgba(70,48,18,${alpha})`;
      bctx.fillRect(xx, yy, len, 1 + Math.random() * 1.4);
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

  let ringImgRef = null;

  function buildRingTexture(size) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const cx = size / 2, cy = size / 2;
    const rOuter = size / 2 - 2;

    const bandDepth = rOuter * 0.32;
    const rInner = rOuter - bandDepth;

    const srcW = ringImgRef.width;
    const sy = Math.floor(ringImgRef.height / 2);
    const sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = srcW;
    sampleCanvas.height = 1;
    const sctx = sampleCanvas.getContext('2d');
    sctx.drawImage(ringImgRef, 0, sy, srcW, 1, 0, 0, srcW, 1);
    const rowData = sctx.getImageData(0, 0, srcW, 1).data;

    ctx.save();
    ctx.translate(cx, cy);

    const grad = ctx.createRadialGradient(0, 0, rInner, 0, 0, rOuter);
    const stops = 40;
    for (let i = 0; i <= stops; i++) {
      const t = i / stops;
      const sx = Math.min(srcW - 1, Math.floor(t * (srcW - 1)));
      const px = sx * 4;
      const rr = Math.min(255, rowData[px] * 1.3 + 35);
      const gg = Math.min(255, rowData[px + 1] * 1.28 + 30);
      const bb = Math.min(255, rowData[px + 2] * 1.2 + 22);
      const luminance = (rowData[px] + rowData[px + 1] + rowData[px + 2]) / 3;
      const srcAlpha = rowData[px + 3] / 255;
      const density = Math.max(0.45, Math.pow(luminance / 255, 1.05) * srcAlpha);
      grad.addColorStop(t, `rgba(${rr.toFixed(0)},${gg.toFixed(0)},${bb.toFixed(0)},${Math.min(0.95, density).toFixed(3)})`);
    }

    ctx.beginPath();
    ctx.arc(0, 0, rOuter, 0, Math.PI * 2);
    ctx.arc(0, 0, rInner, 0, Math.PI * 2, true);
    ctx.fillStyle = grad;
    ctx.shadowColor = 'rgba(235,215,180,0.85)';
    ctx.shadowBlur = 6;
    ctx.fill('evenodd');
    ctx.shadowBlur = 0;

    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, rOuter, 0, Math.PI * 2);
    ctx.arc(0, 0, rInner, 0, Math.PI * 2, true);
    ctx.clip('evenodd');
    for (let i = 0; i < 140; i++) {
      const angle = Math.random() * Math.PI * 2;
      const rMid = rInner + Math.random() * (rOuter - rInner);
      const streakLen = 8 + Math.random() * 20;
      const x1 = Math.cos(angle) * rMid;
      const y1 = Math.sin(angle) * rMid;
      const x2 = Math.cos(angle + streakLen / rMid) * rMid;
      const y2 = Math.sin(angle + streakLen / rMid) * rMid;
      ctx.strokeStyle = Math.random() > 0.5
        ? 'rgba(255,250,235,0.35)'
        : 'rgba(40,30,15,0.30)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.restore();
    ctx.restore();

    return canvas.toDataURL('image/png');
  }

  async function getSaturnSurfaceDataUrl() {
    let dataUrl = window.__solarisTexCache.get('saturn-surface');
    if (dataUrl) return dataUrl;
    const surfaceImg = await loadImage('/solaris/Assets/webp/2k_saturn.webp');
    dataUrl = buildSaturnTexture(surfaceImg, 700, 300); // returns 1400px wide
    window.__solarisTexCache.set('saturn-surface', dataUrl);
    return dataUrl;
  }

  async function getSaturnRingDataUrl() {
    let dataUrl = window.__solarisTexCache.get('saturn-ring');
    if (dataUrl) return dataUrl;
    ringImgRef = await loadImage('/solaris/Assets/png/2k_saturn_ring_alpha.png');
    dataUrl = buildRingTexture(196);
    window.__solarisTexCache.set('saturn-ring', dataUrl);
    return dataUrl;
  }

  window.__solarisPregenerate['job-odyssey'] = async function () {
    try { await getSaturnSurfaceDataUrl(); } catch (e) { /* ignore, will retry on the actual page */ }
    try { await getSaturnRingDataUrl(); } catch (e) { /* ignore */ }
  };

  let spinRafId = null;

  async function applyAll() {
    const planetEl = document.querySelector('.planet-saturn');
    const ringSpinEls = document.querySelectorAll('.ring-spin');
    if (spinRafId !== null) {
      cancelAnimationFrame(spinRafId);
      spinRafId = null;
    }
    if (!planetEl && ringSpinEls.length === 0) return;

    try {
      if (planetEl) {
        const baseW = 700, tileH = 300;
        const dataUrl = await getSaturnSurfaceDataUrl();
        const boxH = planetEl.clientHeight || 100;
        const renderedTileW = (baseW * 2) * (boxH / tileH);

        planetEl.style.backgroundImage = `url(${dataUrl})`;
        planetEl.style.backgroundRepeat = 'repeat-x';
        planetEl.style.backgroundSize = `${renderedTileW}px 100%`;
        planetEl.style.backgroundPosition = '0 center';

        let offset = 0;
        let lastTs = null;
        const SPIN_SPEED = 16; // px per second
        function spin(ts) {
          if (lastTs === null) lastTs = ts;
          const dt = (ts - lastTs) / 1000;
          lastTs = ts;
          offset = (offset + SPIN_SPEED * dt) % renderedTileW;
          planetEl.style.backgroundPosition = `${-offset}px center`; // scrolls left
          spinRafId = requestAnimationFrame(spin);
        }
        spinRafId = requestAnimationFrame(spin);
      }
    } catch (e) {
      console.warn('Saturn surface texture failed to load, keeping fallback color.', e);
    }

    try {
      if (ringSpinEls.length > 0) {
        const dataUrl = await getSaturnRingDataUrl();
        ringSpinEls.forEach(el => {
          el.style.backgroundImage = `url(${dataUrl})`;
          el.style.backgroundSize = '100% 100%';
        });
      }
    } catch (e) {
      console.warn('Ring texture failed to load, keeping fallback.', e);
    }
  }

  window.__solarisInit = window.__solarisInit || {};
  window.__solarisInit.saturn = applyAll;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyAll);
  } else {
    applyAll();
  }
})();


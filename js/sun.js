/* ---- Sun ---- */
/* sun.js — Three.js sun: texture sphere (X rotation). The corona/flare
   glow is a pure CSS radial-gradient (.sun-flare in css/sun.css) behind
   the canvas now, same technique every other planet's glow already
   used — no PNG for it anymore.
   Registers window.__solarisInit.sun so the SPA router can re-run this
   every time you navigate back to the home fragment — the previous
   <canvas id="sun-canvas"> gets destroyed on every swap (innerHTML
   replacement), so Three.js has to be reattached to the fresh one each
   time. Cleans up the previous renderer/animation loop first so
   repeated home<->tab navigation doesn't leak WebGL contexts.

   There is deliberately NO low-quality fallback: if WebGL is switched off or
   blocked (e.g. Firefox's fingerprinting protection asks "Allow localhost to
   create a WebGL context?" and the answer is Block), or the Three.js library
   can't be loaded, a small popup says so instead - the sun is not redrawn in
   a cheaper style. */
(function () {
  'use strict';

  let currentRafId = null;
  let currentRenderer = null;

  // Cached once, reused forever within this page session — sun.js's
  // whole script only executes ONCE in a true SPA (the page never
  // actually reloads), so there's no reason to refetch/redecode this
  // texture every time initSun() runs again after a swap.
  let cachedSphereTex = null;

  // One small popup, shown only when the full graphics cannot start.
  function showWebglPopup(reason) {
    if (document.getElementById('solaris-gfx-dialog')) return;
    const text = reason === 'library'
      ? 'The 3D graphics library could not be loaded. Please check your internet connection, else you can\u2019t experience our graphics.'
      : 'Please enable WebGL, else you can\u2019t experience our graphics.';
    const overlay = document.createElement('div');
    overlay.id = 'solaris-gfx-dialog';
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'solaris-gfx-text');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147482000;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(3,5,10,0.74);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);font-family:inherit;';
    overlay.innerHTML =
      '<div style="width:min(420px,90vw);padding:26px 28px 22px;border-radius:16px;background:#0e121c;' +
      'border:1px solid rgba(255,255,255,0.16);box-shadow:0 18px 60px rgba(0,0,0,0.6);color:#e8ecf8;text-align:left;">' +
      '<div id="solaris-gfx-text" style="font-size:15px;line-height:1.55;">' + text + '</div>' +
      '<div style="display:flex;justify-content:flex-end;margin-top:20px;">' +
      '<button type="button" id="solaris-gfx-ok" style="min-width:92px;padding:9px 22px;border-radius:999px;cursor:pointer;' +
      'font:inherit;font-size:14px;font-weight:600;color:#fff;background:rgba(32,146,229,0.28);border:1.5px solid rgba(74,168,238,0.7);">OK</button>' +
      '</div></div>';
    document.body.appendChild(overlay);
    const ok = overlay.querySelector('#solaris-gfx-ok');
    ok.addEventListener('click', function () { overlay.remove(); });
    overlay.addEventListener('keydown', function (e) { if (e.key === 'Tab') { e.preventDefault(); ok.focus(); } });
    ok.focus();
  }

  function initSun() {
    const canvas = document.getElementById('sun-canvas');
    if (!canvas) return;

    // stop and free whatever the previous canvas instance was doing
    if (currentRafId !== null) {
      cancelAnimationFrame(currentRafId);
      currentRafId = null;
    }
    if (currentRenderer) {
      try {
        // dispose() frees internal GPU resources (geometries, programs,
        // textures) but does NOT release the WebGLRenderingContext slot
        // itself — that's what was still piling up despite this call
        // already being here. forceContextLoss() is the one that
        // actually tells the browser to free the context.
        currentRenderer.dispose();
        currentRenderer.forceContextLoss();
      } catch (e) { /* ignore */ }
      currentRenderer = null;
    }

    // Clicking the sun refreshes the page — acts like a "home/reset" logo.
    canvas.style.cursor = 'pointer';
    canvas.title = 'Refresh Solaris';
    canvas.addEventListener('click', () => {
      // While the power-on boot sequence hasn't run yet (see
      // js/boot.js), the sun's click is the power button instead of the
      // usual refresh-on-click.
      if (document.body.classList.contains('solaris-booting')) return;
      window.location.reload();
    });

    if (typeof THREE === 'undefined') { showWebglPopup('library'); return; } // the Three.js CDN script didn't load

    const SIZE = 280;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    } catch (e) {                                   // WebGL is off, blocked, or unsupported
      showWebglPopup('webgl');
      return;
    }
    currentRenderer = renderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(SIZE, SIZE, false);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, 3.2);
    camera.lookAt(0, 0, 0);

    const loader = new THREE.TextureLoader();

    /* ── Sun sphere (X-axis rotation) ── */
    function addSphere(tex) {
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.72, 64, 64),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.85 })
      );
      sphere.renderOrder = 1;
      sphere.userData.rotX = true;
      scene.add(sphere);
    }
    if (cachedSphereTex) {
      addSphere(cachedSphereTex);
    } else {
      loader.load('/solaris/Assets/webp/sun_texture.webp', (tex) => {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        cachedSphereTex = tex;
        addSphere(tex);
      });
    }

    /* ── Render loop ── */
    function animate(ts) {
      const t = ts * 0.00004; // slow
      scene.children.forEach(obj => {
        if (obj.userData.rotX) obj.rotation.x = t;
      });
      renderer.render(scene, camera);
      currentRafId = requestAnimationFrame(animate);
    }
    currentRafId = requestAnimationFrame(animate);
  }

  window.__solarisInit = window.__solarisInit || {};
  window.__solarisInit.sun = initSun;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSun);
  } else {
    initSun();
  }
})();

/* ---- Starfield ---- */
/* solaris.js — Starfield background only.
   Planets self-rotate via CSS (see solaris.css), no JS orbit logic needed. */

(function () {
  'use strict';

  const canvas = document.getElementById('starfield');
  if (!canvas) return; // tab pages don't have a starfield canvas
  const ctx    = canvas.getContext('2d');
  let stars    = [];

  function resize() {
    canvas.width  = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    buildStars();
  }

  function buildStars() {
    stars = [];
    const count = Math.floor((canvas.width * canvas.height) / 3200);
    for (let i = 0; i < count; i++) {
      stars.push({
        x:     Math.random() * canvas.width,
        y:     Math.random() * canvas.height,
        r:     Math.random() * 1.2 + 0.2,
        alpha: Math.random() * 0.7 + 0.3,
        speed: Math.random() * 0.004 + 0.001,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  let driftX = 0;
  const DRIFT_SPEED = 4; // px per second, slow and steady

  let suck = null; // { targetX, targetY, startTs, duration }

  function drawStars(t, dt, ts) {
    if (!suck) {
      driftX -= DRIFT_SPEED * dt;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (suck) {
      const elapsed = ts - suck.startTs;
      const progress = Math.min(1, elapsed / suck.duration);
      const eased = progress * progress * (3 - 2 * progress); // smoothstep
      for (const s of stars) {
        if (s._sx === undefined) { s._sx = (s.x + driftX) % canvas.width; if (s._sx < 0) s._sx += canvas.width; s._sy = s.y; }
        const x = s._sx + (suck.targetX - s._sx) * eased;
        const y = s._sy + (suck.targetY - s._sy) * eased;
        const r = Math.max(0, s.r * (1 - eased));
        const a = s.alpha * (1 - eased * 0.7);
        if (r <= 0.02) continue;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(220, 220, 255, ${a})`;
        ctx.fill();
      }
      return;
    }

    for (const s of stars) {
      const a = s.alpha * (0.6 + 0.4 * Math.sin(t * s.speed + s.phase));
      // wrap star x position with drift for seamless infinite scroll
      let x = (s.x + driftX) % canvas.width;
      if (x < 0) x += canvas.width;
      ctx.beginPath();
      ctx.arc(x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(220, 220, 255, ${a})`;
      ctx.fill();
    }
  }

  // Called externally (by the black-hole power button) to pull every star
  // toward a screen point and shrink them out, e.g.:
  //   window.solarisSuckStars(blackholeX, blackholeY, 1800)
  window.solarisSuckStars = function (targetX, targetY, duration) {
    suck = { targetX, targetY, startTs: performance.now(), duration: duration || 1800 };
  };

  let lastTs = null;

  function loop(ts) {
    if (!lastTs) lastTs = ts;
    const dt = (ts - lastTs) / 1000;
    lastTs = ts;
    drawStars(ts * 0.001, dt, ts);
    requestAnimationFrame(loop);
  }

  window.addEventListener('resize', resize);
  resize();
  requestAnimationFrame(loop);
})();


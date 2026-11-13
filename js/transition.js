/* ---- Page transition system (home <-> tab) ---- */
/* transition.js — shared transition system between the Solaris home page
   and each planet's tab. Include this on EVERY page (home + all tabs)
   alongside transition.css.

   HOME → TAB (cluster-collapse, no color/iris effect):
   Each .planet-node on the home page needs a data-planet attribute
   matching one of: "job-odyssey", "career-voyager", "scraper-abyss",
   "profile-nexus". On click, the clicked planet shrinks/moves into the
   "big circle" nav-cluster position, the other three shrink/move into
   the three mini corner slots (Home's corner is left empty here — the
   destination tab page renders its own Home icon there), the sun/tagline
   and black-hole button fade out, then it navigates. See the CLUSTER
   constant below for the exact target coordinates — reuse the same
   numbers when building each tab page's own header so the cluster lines
   up with where this animation leaves off.

     SolarisTransition.bindPlanetLinks('.planet-node');  // already wired on the home page

   TAB → HOME (iris/color-wipe, still available for the return trip):
     <a href="/solaris" class="solaris-return-btn" id="solaris-back">
       <span class="dot"></span> Back to Solaris
     </a>
     <script src="/solaris/transition.js"></script>
     <script>
       document.getElementById('solaris-back').addEventListener('click', function (e) {
         e.preventDefault();
         SolarisTransition.returnHome();
       });
     </script>

   On page load, EVERY page should also call SolarisTransition.playEntrance()
   (already done automatically below on DOMContentLoaded) — it's a no-op
   unless the previous page just called warpTo()/returnHome() (the iris
   variant), in which case it plays the reverse "materializing" animation
   from the same screen point/color. It has no effect on cluster-collapse
   navigations.
*/
(function () {
  'use strict';

  const STORAGE_KEY = 'solaris_transition_origin';
  const DURATION_MS = 750;
  const STALE_MS = 15000; // ignore leftover origin data older than this

  // Prefer the SPA router (fetch+swap, no full reload) when it's present;
  // fall back to a real navigation if router.js wasn't loaded for some
  // reason (e.g. this page predates it, or fetch failed).
  function navigateTo(url, opts) {
    if (window.SolarisRouter) {
      window.SolarisRouter.navigate(url, opts);
    } else {
      window.location.href = url;
    }
  }

  // Transition state. While any planet-to-planet / home-to-planet /
  // planet-to-home transition runs, <body> carries .solaris-transitioning
  // (see css/tab.css): page scrolling is locked and the scroll buttons are
  // hidden. It starts at the very first click and is cleared by
  // router.navigate() the moment the new page is in (endTransition), with a
  // timer as a safety net so a failed navigation can never leave the page
  // stuck locked. The scrollbar is about to disappear (overflow:hidden), so
  // its width is added back as padding to stop the layout jumping sideways.
  let transitionSafetyTimer = null;
  function beginTransition() {
    const b = document.body;
    if (!b.classList.contains('solaris-transitioning')) {
      const sbw = b.offsetWidth - b.clientWidth;
      if (sbw > 0) b.style.paddingRight = (parseFloat(getComputedStyle(b).paddingRight) || 0) + sbw + 'px';
      b.classList.add('solaris-transitioning');
    }
    clearTimeout(transitionSafetyTimer);
    transitionSafetyTimer = setTimeout(endTransition, 12000);
  }
  function endTransition() {
    clearTimeout(transitionSafetyTimer);
    document.body.classList.remove('solaris-transitioning');
    document.body.style.paddingRight = '';
  }

  function ensureOverlay() {
    let el = document.getElementById('solaris-transition-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'solaris-transition-overlay';
      el.className = 'solaris-transition-overlay';
      const streaks = document.createElement('div');
      streaks.className = 'warp-streaks';
      el.appendChild(streaks);
      document.body.appendChild(el);
    }
    return el;
  }

  // ── Skeleton loader — fills the empty center that appears once the
  //    orbs have shrunk to their corner-cluster positions. That empty
  //    stretch is by design (the cluster-collapse choreography), not a
  //    rendering glitch, but on its own it reads as "the screen went
  //    blank" for a good chunk of the ~950ms animation. This fades a
  //    generic placeholder in over that same stretch and is removed by
  //    router.js the instant the real page swaps in, so timing between
  //    "show" and "hide" can never drift out of sync with each other —
  //    hide is driven by the actual swap event, not a guessed duration. */
  function ensureSkeletonStyle() {
    if (document.getElementById('solaris-skeleton-style')) return;
    const style = document.createElement('style');
    style.id = 'solaris-skeleton-style';
    style.textContent =
      '.solaris-skeleton { position: fixed; inset: 0; z-index: 400; opacity: 0; pointer-events: none; transition: opacity 380ms ease; }' +
      '.solaris-skeleton.is-visible { opacity: 1; }' +
      '.solaris-skel-bar { position: fixed; border-radius: 999px; background: linear-gradient(90deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.13) 50%, rgba(255,255,255,0.05) 100%);' +
      ' background-size: 200% 100%; animation: solarisSkelShimmer 1.3s ease-in-out infinite; }' +
      '@keyframes solarisSkelShimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }';
    document.head.appendChild(style);
  }

  function ensureSkeleton() {
    ensureSkeletonStyle();
    let el = document.getElementById('solaris-skeleton');
    if (!el) {
      el = document.createElement('div');
      el.id = 'solaris-skeleton';
      el.className = 'solaris-skeleton';
      document.body.appendChild(el);
    }
    return el;
  }

  function skelPiece(rect) {
    const el = document.createElement('div');
    el.className = 'solaris-skel-bar';
    el.style.left = rect.left + 'px';
    el.style.top = rect.top + 'px';
    el.style.width = Math.max(0, rect.width) + 'px';
    el.style.height = Math.max(0, rect.height) + 'px';
    return el;
  }

  // Renders the destination's own HTML off-screen (but laid out — a
  // detached node has no size to measure) and reads the real position
  // of its title/tagline area, its header buttons, its log button, and
  // its content region. Returns null for a destination that doesn't
  // have this tab shell (the home page), so the caller can fall back
  // to something else rather than measuring elements that don't exist.
  function measureDestination(html) {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed; left:0; top:0; width:' + window.innerWidth + 'px; visibility:hidden; pointer-events:none; z-index:-1;';
    document.body.appendChild(probe);
    probe.innerHTML = html;

    const root = probe.firstElementChild;
    const headerBar = root && root.querySelector('.tab-header-bar');
    const logBtn = root && root.querySelector('#log-btn');
    const content = root && root.querySelector('.tab-content');
    const scrollBtn = root && root.querySelector('.scroll-nav .scroll-circle-btn');

    let result = null;
    if (headerBar && content) {
      // Job Odyssey/Career Voyager/Scraper Abyss all name their title and
      // tagline elements with a -title/-sub class suffix; Profile Nexus
      // uses plain <h1>/<p> instead of its own classes. Reading the real
      // element directly (rather than inferring a position from the
      // header's own bounding box) is what makes this work on Profile
      // Nexus's centered layout as well as the other three tabs' left-
      // aligned ones — assuming a specific alignment was the bug.
      const titleEl = headerBar.querySelector('[class$="-title"], h1');
      const tagEl = headerBar.querySelector('[class$="-sub"], p');
      const buttonRects = Array.from(headerBar.querySelectorAll('button')).map((b) => b.getBoundingClientRect());
      // The log visual's own real element (e.g. .jo-log-visual), not
      // #log-btn itself — that wrapper has a leftover placeholder size
      // (80x222px, predating each tab's own badge) that doesn't match
      // what's actually visible on screen.
      const logVisual = logBtn && (logBtn.querySelector('[class$="-log-visual"]') || logBtn.firstElementChild);
      result = {
        title: titleEl ? titleEl.getBoundingClientRect() : null,
        tagline: tagEl ? tagEl.getBoundingClientRect() : null,
        buttons: buttonRects,
        log: logVisual ? logVisual.getBoundingClientRect() : null,
        scrollBtn: scrollBtn ? scrollBtn.getBoundingClientRect() : null,
        content: content.getBoundingClientRect(),
        contentBlocks: collectContentBlocks(content),
      };
    }
    document.body.removeChild(probe);
    return result;
  }

  // Walks .tab-content's real DOM tree and returns one rect per
  // "repeated unit" block — a filter dropdown, a stat card, a form
  // group, a sub-nav button — rather than a fixed, fabricated set of
  // placeholder lines. An element counts as one such block (a leaf of
  // this walk, even though it may itself have children, e.g. a stat
  // card wrapping an icon + a number) once none of its own children
  // branch any further themselves; otherwise its children are each
  // examined the same way. <svg> is always treated as a leaf — its
  // internal <path> children aren't a content structure to describe.
  function collectContentBlocks(root) {
    const MAX_BLOCKS = 60, MAX_DEPTH = 6;
    const blocks = [];
    function isLeaf(el) {
      const kids = Array.from(el.children);
      if (kids.length === 0) return true;
      return kids.every((c) => c.tagName === 'svg' || c.children.length === 0);
    }
    function visit(el, depth) {
      if (blocks.length >= MAX_BLOCKS) return;
      if (el.classList && el.classList.contains('log-scroll-row')) return; // the lone scroll button row isn't page content
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return; // collapsed/hidden — nothing to show here
      // A leaf-like container with a large reserved height (e.g.
      // .jo-list-pane before its job cards load via JS — itself leaf-
      // like because its own children, like an empty list-scroll div
      // and an empty-state message, are each individually empty too)
      // is only empty because this is a prefetch of the static HTML —
      // at runtime it holds a list of real rows/cards. One block
      // matching its full inflated height rendered as a single
      // oversized capsule (border-radius:999px caps at half the
      // SMALLER dimension, so a narrow-but-tall box like this still
      // gets fully rounded ends); a handful of card-shaped placeholders
      // within its real bounds reads as "a list is loading here" instead.
      if (isLeaf(el) && r.height > 120) {
        const cardH = 72, gap = 10, pad = 6;
        const count = Math.max(1, Math.min(6, Math.floor((r.height - pad * 2 + gap) / (cardH + gap))));
        for (let i = 0; i < count && blocks.length < MAX_BLOCKS; i++) {
          blocks.push({ left: r.left + pad, top: r.top + pad + i * (cardH + gap), width: r.width - pad * 2, height: cardH });
        }
        return;
      }
      if (isLeaf(el) || depth >= MAX_DEPTH) { blocks.push(r); return; }
      for (const c of Array.from(el.children)) visit(c, depth + 1);
    }
    for (const c of Array.from(root.children)) visit(c, 1);
    return blocks.slice(0, MAX_BLOCKS);
  }

  function buildMeasuredSkeleton(el, m) {
    el.innerHTML = '';

    // Title and tagline — each piece sits exactly where that real
    // element renders, whether that's left-aligned (Job Odyssey, Career
    // Voyager, Scraper Abyss) or centered (Profile Nexus), since the
    // rect itself came from the real element rather than an assumption
    // about how the header aligns its text.
    if (m.title) el.appendChild(skelPiece(m.title));
    if (m.tagline) el.appendChild(skelPiece(m.tagline));

    // One pill per real header button (Reload/Export, Save, the
    // sub-tab buttons, etc.) at that exact button's own real position
    // and size — not a fixed guessed count.
    m.buttons.forEach((r) => el.appendChild(skelPiece(r)));

    // The log button, at its own real position and size.
    if (m.log) el.appendChild(skelPiece(m.log));

    // The circular scroll button beside it (a circle: equal width and height).
    if (m.scrollBtn) el.appendChild(skelPiece(m.scrollBtn));

    // Body — one piece per real block actually found in the
    // destination's own content area (a filter dropdown, a stat card, a
    // form group, a sub-nav button), each at that block's own real
    // position and size. Falls back to a few generic rows only for a
    // content area collectContentBlocks found nothing usable in (an
    // empty shell with no server-rendered chrome at all).
    if (m.contentBlocks.length) {
      m.contentBlocks.forEach((r) => el.appendChild(skelPiece(r)));
    } else {
      const c = m.content, rowH = 16, rowGap = 12, pad = 4;
      const rows = Math.max(1, Math.min(6, Math.floor((c.height - pad * 2) / (rowH + rowGap))));
      for (let i = 0; i < rows; i++) {
        const w = i === rows - 1 ? c.width * 0.4 : c.width * (0.75 - (i % 3) * 0.08);
        el.appendChild(skelPiece({ left: c.left + pad, top: c.top + pad + i * (rowH + rowGap), width: w, height: rowH }));
      }
    }
  }

  // Generic last-resort skeleton: only for a destination that can't be
  // measured (no tab shell, or its fetch failed). It is NOT drawn while
  // waiting for the measurement — see showSkeleton().
  let skeletonToken = 0;
  function buildGenericSkeleton(el) {
    el.innerHTML = '';
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    el.appendChild(skelPiece({ left: cx - 110, top: cy - 60, width: 220, height: 22 }));
    el.appendChild(skelPiece({ left: cx - 160, top: cy - 24, width: 320, height: 12 }));
    el.appendChild(skelPiece({ left: cx - 110, top: cy + 10, width: 96, height: 34 }));
    el.appendChild(skelPiece({ left: cx + 6, top: cy + 10, width: 96, height: 34 }));
  }

  // destinationUrl is used to measure that exact page's real layout
  // (title/tagline area, each header button, the log button, the
  // content region) via prefetch() — which is already fetching this
  // same URL for the real navigation at this point, so this doesn't
  // add a second network request, just reads the response it gets.
  function showSkeleton(destinationUrl) {
    const el = ensureSkeleton();
    el.innerHTML = ''; // never show leftovers from an earlier destination
    const prefetchFn = window.SolarisRouter && window.SolarisRouter.prefetch;
    const token = ++skeletonToken; // hideSkeleton() bumps this, cancelling a still-pending show

    function reveal(build) {
      build();
      void el.offsetWidth; // make sure the fade-in actually runs
      el.classList.add('is-visible');
    }

    // Nothing is drawn until the destination's REAL layout is known. This used
    // to paint a generic centred placeholder (title, tagline, two buttons)
    // first and swap the measured one in afterwards, so every destination
    // skeleton began with a flash of a layout that belongs to no page -
    // for as long as the fetch took. Both callers (home -> tab, tab -> tab)
    // always land on a tab page, so that generic one was never the right
    // answer; it now only appears as a last resort (below).
    if (!destinationUrl || !prefetchFn) { reveal(() => buildGenericSkeleton(el)); return; }
    prefetchFn(destinationUrl).then((html) => {
      if (token !== skeletonToken) return; // already navigated away/hidden — don't resurrect it
      const m = measureDestination(html);
      reveal(() => (m ? buildMeasuredSkeleton(el, m) : buildGenericSkeleton(el)));
    }).catch((err) => {
      if (token !== skeletonToken) return;
      if (err && err.poweredOff) return; // server was restarted: the popup is showing, draw nothing behind it
      reveal(() => buildGenericSkeleton(el)); // fetch failed — the navigation will fall back to a real page load anyway
    });
  }

  function hideSkeleton() {
    skeletonToken++; // cancel any show that is still waiting on its fetch
    const el = document.getElementById('solaris-skeleton');
    if (el) el.classList.remove('is-visible');
  }

  function centerOf(el) {
    if (!el) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  // Warps the screen closed (iris-in) centered on originEl / a given
  // point, tinted by color, then navigates to url.
  function warpTo(url, opts) {
    beginTransition();
    opts = opts || {};
    const { x, y } = opts.point || centerOf(opts.originEl);
    const color = opts.color || '#05060c';

    if (window.SolarisRouter && window.SolarisRouter.prefetch) {
      window.SolarisRouter.prefetch(url);
    }

    const overlay = ensureOverlay();
    overlay.style.background = color;
    overlay.style.transition = 'none';
    overlay.style.clipPath = `circle(0px at ${x}px ${y}px)`;
    overlay.style.pointerEvents = 'auto';
    overlay.classList.add('is-active');
    void overlay.offsetWidth; // force reflow before animating
    overlay.style.transition = `clip-path ${DURATION_MS}ms cubic-bezier(0.65,0,0.35,1)`;
    overlay.style.clipPath = `circle(150% at ${x}px ${y}px)`;

    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ x, y, color, ts: Date.now() }));
    } catch (e) { /* sessionStorage unavailable — entrance animation just won't play */ }

    setTimeout(() => {
      navigateTo(url);
    }, DURATION_MS - 50);
  }

  function returnHome(opts) {
    warpTo('/solaris', Object.assign({ color: '#05060c' }, opts || {}));
  }

  // Plays the reverse (iris-out) animation from wherever the previous
  // page's warpTo()/returnHome() was centered. No-op if there's no
  // recent origin recorded (e.g. direct page load / bookmark).
  function playEntrance() {
    let origin = null;
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) {
        origin = JSON.parse(raw);
        sessionStorage.removeItem(STORAGE_KEY);
        if (Date.now() - origin.ts > STALE_MS) origin = null;
      }
    } catch (e) { /* ignore */ }

    if (!origin) return;

    const overlay = ensureOverlay();
    overlay.style.background = origin.color;
    overlay.style.transition = 'none';
    overlay.style.clipPath = `circle(150% at ${origin.x}px ${origin.y}px)`;
    overlay.style.pointerEvents = 'none';
    overlay.classList.add('is-active');
    void overlay.offsetWidth;
    overlay.style.transition = `clip-path ${DURATION_MS}ms cubic-bezier(0.65,0,0.35,1)`;
    overlay.style.clipPath = `circle(0px at ${origin.x}px ${origin.y}px)`;

    setTimeout(() => overlay.classList.remove('is-active'), DURATION_MS);
  }

  // ── Cluster-collapse transition (home → tab page) ────────────────
  // No iris/color-wipe here — the planets themselves shrink and move to
  // fixed positions matching each tab page's nav cluster (see the sketch:
  // Home top-left, current planet big, other 3 as mini circles at the
  // remaining corners). These exact coordinates should be reused when
  // building each tab page's own header, so the destination page's
  // cluster lines up with where the animation left off.
  // scale values here are the SAME fixed factors tab.css uses on
  // .cluster-planet-wrap — using them directly (instead of computing
  // scale from the orb's own bounding box) is what makes the animation's
  // end state match what the destination page actually renders. The
  // orb's own box is only ~110-116px, but the ring/satellite/probe
  // extend well beyond it via absolute positioning, so a size-based
  // scale calc was shrinking those extras far less than tab.css does —
  // that mismatch was the "grows big then snaps small" jump.
  // scale values are divided by 0.85 (0.23/0.85, 0.68/0.85, 0.28/0.85)
  // to compensate for the home page's planet/sun elements now being
  // 0.85x their original native size (see css/sun.css, saturn.css,
  // mars.css, abyss.css, nexus.css, planet_base.css) — keeps these
  // matching css/tab.css's .cluster-* scale values exactly, and the
  // animation still lands at the same final pixel size as before.
  const CLUSTER = {
    home: { cx: 32, cy: 36, scale: 0.2706 },
    big: { cx: 120, cy: 108, scale: 0.8 },
    tr: { cx: 208, cy: 36, scale: 0.3294 },
    bl: { cx: 34, cy: 180, scale: 0.3294 },
    br: { cx: 206, cy: 180, scale: 0.3294 },
  };

  const PLANET_ORDER = ['job-odyssey', 'career-voyager', 'scraper-abyss', 'profile-nexus'];

  // Mirrors solaris.py's _render_tab(): given the page we're headed to,
  // this is the exact slot ('big' for the destination itself, else
  // 'tr'/'bl'/'br' in PLANET_ORDER order with the destination removed)
  // that key will render at once we land there. Keep this in sync with
  // SLOT_ORDER in solaris.py if either ever changes.
  const SLOT_ORDER = ['tr', 'bl', 'br'];
  function destSlotFor(key, destinationKey) {
    if (key === destinationKey) return 'big';
    const othersKeys = PLANET_ORDER.filter((k) => k !== destinationKey);
    return SLOT_ORDER[othersKeys.indexOf(key)];
  }

  const ORB_SELECTOR_BY_PLANET = {
    'job-odyssey': '.saturn-system',
    'career-voyager': '.mars-system',
    'scraper-abyss': '.abyss-system',
    'profile-nexus': '.planet-orb.planet-gold',
  };

  const CLUSTER_DURATION_MS = 950;
  const TEXT_SINK_MS = 260; // home->tab: how long text takes to sink+fade before element motion starts

  // Builds a throwaway, invisible copy of tab.css's own cluster markup
  // (cluster-node + cluster-planet-wrap, using whichever slot class
  // carries the real scale rule) around a CLONE of the actual orb
  // being animated, then measures how big that clone renders. tab.css
  // is loaded on every page (see shell.html), so this reports exactly
  // what the orb will look like once it really lands in that slot on
  // the destination tab page — no hand-tuned constant to drift out of
  // sync with it.
  // Measures where a whole batch of orbs would land if each were placed
  // into its cluster slot, in one pass: appends every probe first, reads
  // every rect second, removes every probe third. Interleaving these
  // per-orb (append, measure, remove, repeat) forced a fresh synchronous
  // layout reflow on every single measurement, since each removal
  // invalidated the layout the next one needed — grouping means the
  // browser only has to settle layout once for the whole batch.
  // The measured scale ratio for a given orb + slot never actually
  // changes between navigations — it's driven entirely by static CSS
  // (each orb's own fixed px size in planet_base.css/sun.css, and the
  // fixed slot scale in tab.css), neither of which changes at runtime.
  // Caching it means the clone/append/measure/remove probe work in
  // measureClusterTargets only ever has to run once per orb+slot combo,
  // for the whole page session, instead of on every single transition.
  const scaleCache = {};
  function cacheKeyFor(id, slotKey) {
    // tr/bl/br all share the same .cluster-mini scale in tab.css, so
    // they're one cache bucket ("mini"), not three.
    return `${id}:${slotKey === 'big' ? 'big' : slotKey === 'home' ? 'home' : 'mini'}`;
  }

  function measureClusterTargets(items) {
    // items: [{ orbEl, slotKey }]
    const probes = items.map(({ orbEl, slotKey }) => {
      const nodeClass = slotKey === 'home' ? 'cluster-home'
        : slotKey === 'big' ? 'cluster-big'
        : 'cluster-mini';
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed; left:-9999px; top:-9999px; visibility:hidden; pointer-events:none;';
      probe.innerHTML = `<div class="cluster-node ${nodeClass}"><div class="cluster-planet-wrap"></div></div>`;
      const wrap = probe.firstElementChild.firstElementChild;
      const clone = orbEl.cloneNode(true);
      wrap.appendChild(clone);
      return { probe, clone };
    });
    probes.forEach(({ probe }) => document.body.appendChild(probe));
    const rects = probes.map(({ clone }) => clone.getBoundingClientRect());
    probes.forEach(({ probe }) => probe.remove());
    return rects;
  }

  // scale is now passed in pre-measured (see measureClusterTargets above)
  // rather than measured per-call — animateOrbTo itself no longer does
  // any probe DOM work.
  function animateOrbTo(orbEl, target, scale, rect) {
    rect = rect || orbEl.getBoundingClientRect();
    const curCx = rect.left + rect.width / 2;
    const curCy = rect.top + rect.height / 2;
    const dx = target.cx - curCx;
    const dy = target.cy - curCy;

    orbEl.style.transition = `transform ${CLUSTER_DURATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
    orbEl.style.willChange = 'transform';
    void orbEl.offsetWidth;
    orbEl.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
    return scale;
  }

  // Call from the home page when a planet link is clicked. clickedKey
  // must be one of PLANET_ORDER. Fades out the sun/tagline/black-hole,
  // shrinks the clicked planet into the "big" slot and the other three
  // into the remaining corner slots (in PLANET_ORDER, skipping the
  // clicked one), then navigates.
  const TEXTURE_BY_PLANET = {
    'job-odyssey': ['/solaris/Assets/webp/2k_saturn.webp', '/solaris/Assets/png/2k_saturn_ring_alpha.png'],
    'career-voyager': ['/solaris/Assets/webp/2k_mars.webp'],
    'scraper-abyss': ['/solaris/Assets/webp/scraper_abyss_texture.webp'],
    'profile-nexus': ['/solaris/Assets/webp/2k_nexus.webp'],
  };

  function preloadTextures(key) {
    const pregen = window.__solarisPregenerate && window.__solarisPregenerate[key];
    if (pregen) {
      pregen(); // runs the actual canvas generation now, caches the result
      return;
    }
    // fallback: at least warm the raw image bytes if the pregenerate
    // hook isn't available for some reason
    (TEXTURE_BY_PLANET[key] || []).forEach((src) => {
      const img = new Image();
      img.src = src;
    });
  }

  function collapseToTab(url, clickedKey) {
    beginTransition();
    preloadTextures(clickedKey);
    // Fire the fragment fetch now, in parallel with the ~1s collapse
    // animation below, instead of after it finishes. router.navigate()
    // will pick up this in-flight/finished request when the animation's
    // setTimeout calls it, so the visible swap has nothing left to wait
    // on in the common case.
    if (window.SolarisRouter && window.SolarisRouter.prefetch) {
      window.SolarisRouter.prefetch(url);
    }

    const others = PLANET_ORDER.filter((k) => k !== clickedKey);
    const slotFor = { [clickedKey]: CLUSTER.big };
    const slotKeyFor = { [clickedKey]: 'big' };
    const cornerKeys = ['tr', 'bl', 'br'];
    others.forEach((key, i) => {
      slotFor[key] = CLUSTER[cornerKeys[i]];
      slotKeyFor[key] = cornerKeys[i];
    });

    // Phase 1: text sinks down + fades out, on its own — no tab-page
    // text to hand off to anymore, so every label/title/tagline just
    // leaves first, out of the way of the element choreography below.
    const title = document.querySelector('.solaris-title');
    const tagline = document.querySelector('.solaris-tagline');
    const labels = PLANET_ORDER.map((key) => {
      const orbSel = ORB_SELECTOR_BY_PLANET[key];
      const orbEl = orbSel && document.querySelector(orbSel);
      const node = orbEl && orbEl.closest('.planet-node');
      return node && node.querySelector('.planet-label');
    }).filter(Boolean);

    [title, tagline, ...labels].forEach((el) => {
      if (!el) return;
      const cs = getComputedStyle(el);
      const curOpacity = cs.opacity;
      const curTransform = cs.transform === 'none' ? '' : cs.transform;
      el.style.animation = 'none';
      el.style.opacity = curOpacity;
      el.style.transform = curTransform;
      void el.offsetWidth; // lock the current look in before transitioning away from it
      el.style.transition = `transform ${TEXT_SINK_MS}ms ease, opacity ${TEXT_SINK_MS}ms ease`;
      el.style.transform = 'translateY(10px)';
      el.style.opacity = '0';
    });

    // Phase 2: element animation, once the text is out of the way.
    setTimeout(() => {
      showSkeleton(url);
      const sun = document.querySelector('.sun-wrap');

      const batch = PLANET_ORDER.map((key) => {
        const orbSel = ORB_SELECTOR_BY_PLANET[key];
        const orbEl = orbSel && document.querySelector(orbSel);
        if (!orbEl) return null;
        return { id: key, orbEl, target: slotFor[key], slotKey: slotKeyFor[key] };
      }).filter(Boolean);
      if (sun) batch.push({ id: 'sun', orbEl: sun, target: CLUSTER.home, slotKey: 'home' });

      const toMeasure = batch.filter((item) => !(cacheKeyFor(item.id, item.slotKey) in scaleCache));
      const measuredRects = toMeasure.length ? measureClusterTargets(toMeasure) : [];
      const ownRects = batch.map(({ orbEl }) => orbEl.getBoundingClientRect());

      let measuredIdx = 0;
      batch.forEach((item, i) => {
        const { orbEl, target, id, slotKey } = item;
        const cacheKey = cacheKeyFor(id, slotKey);
        const rect = ownRects[i];
        let scale;
        if (cacheKey in scaleCache) {
          scale = scaleCache[cacheKey];
        } else {
          const measured = measuredRects[measuredIdx++];
          scale = (rect.width > 0 && measured.width > 0) ? measured.width / rect.width : target.scale;
          scaleCache[cacheKey] = scale;
        }
        animateOrbTo(orbEl, target, scale, rect);
      });

      const blackhole = document.querySelector('.blackhole-btn');
      if (blackhole) {
        blackhole.style.transition = 'opacity 0.5s ease';
        blackhole.style.opacity = '0';
      }

      setTimeout(() => {
        navigateTo(url, { skipFade: true });
      }, Math.max(0, CLUSTER_DURATION_MS - 80));
    }, TEXT_SINK_MS);
  }

  // ── TAB → HOME: true reverse of collapseToTab ────────────────────
  const HOME_RETURN_KEY = 'solaris_returning_from_tab';

  // Quick departure fade for the tab-only chrome that has no equivalent
  // on the home page (header bar, log button, tab body copy, the
  // current-planet label) — used by both the new and legacy paths below.
  const TAB_EXIT_MS = 220;

  function fadeTabChrome() {
    ['.tab-header-bar', '.log-btn', '.tab-content'].forEach((sel) => {
      const el = document.querySelector(sel);
      if (el) {
        el.style.transition = `opacity ${TAB_EXIT_MS}ms ease`;
        el.style.opacity = '0';
      }
    });
  }

  // Old behavior, kept as a fallback (see collapseToHome below): holds
  // the cluster planets exactly where they already are, fades the
  // tab-only chrome, stores which planet this tab was so the home page
  // knows which expand-out entrance to play, then navigates — the ONE
  // real animated phase is playHomeReturnEntrance()'s expand-out, which
  // only starts after the swap. That's what used to cause the freeze
  // collapseToHome below was rewritten to fix: the swap does real
  // synchronous work (full innerHTML replace + 6 init functions,
  // including sun.js rebuilding its WebGL context) sitting right
  // between this fade finishing and the entrance's first visible frame,
  // which reads as the page stalling.
  function legacyCollapseToHome() {
    if (window.SolarisRouter && window.SolarisRouter.prefetch) {
      window.SolarisRouter.prefetch('/solaris');
    }

    const home = document.getElementById('cluster-home');
    if (home) {
      home.style.transition = `transform ${TAB_EXIT_MS}ms ease`;
      home.style.transform = 'scale(1.04)';
    }
    fadeTabChrome();

    try {
      const tabBody = document.querySelector('.tab-body');
      const currentKey = (tabBody && tabBody.getAttribute('data-current-planet')) || '';
      sessionStorage.setItem(HOME_RETURN_KEY, currentKey);
    } catch (e) { /* ignore */ }

    setTimeout(() => {
      navigateTo('/solaris');
    }, TAB_EXIT_MS + 30);
  }

  const TAB_HOME_ENTRANCE_MS = 950; // matches CLUSTER_DURATION_MS elsewhere for visual consistency
  const TAB_HOME_BOX = 340; // generous box size while growing, so overflow:hidden never crops the ring/satellite/probe extents (see growClusterNodeTo)

  // Renders the fetched home HTML into a hidden, full-viewport probe
  // purely to MEASURE where each planet/sun will naturally sit once
  // shown (getBoundingClientRect works fine on visibility:hidden
  // elements — they're laid out, just not painted). No scripts run
  // against this probe and it's removed immediately after measuring, so
  // it never collides with the live tab page's own same-named elements
  // (e.g. both fragments have a #sun-canvas).
  function measureHomeTargets(html) {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed; inset:0; visibility:hidden; pointer-events:none; z-index:-1;';
    probe.innerHTML = html;
    document.body.appendChild(probe);

    const targets = {};
    const sunEl = probe.querySelector('.sun-wrap');
    if (sunEl) targets.sun = sunEl.getBoundingClientRect();
    PLANET_ORDER.forEach((key) => {
      const sel = ORB_SELECTOR_BY_PLANET[key];
      const el = sel && probe.querySelector(sel);
      if (el) targets[key] = el.getBoundingClientRect();
    });

    probe.remove();
    return targets;
  }

  // Grows one cluster node (the tab page's own sun/planet icon) from its
  // current on-screen position/size to a measured target rect (from
  // measureHomeTargets), reusing the exact same "switch to explicit
  // left/top/width/height so the box can grow without clipping its own
  // ring/satellite/probe extents" technique the tab-to-tab rotate
  // animation already uses in finishRing() above — just with a
  // measured, responsive-layout-aware target instead of a fixed CLUSTER
  // constant. nativeSlotKey gives the node's current resting scale (from
  // CLUSTER, already tuned to match tab.css) so the new wrap scale is
  // derived relative to that, rather than by measuring the wrap's own
  // box — which the CLUSTER comment above already found to undershoot
  // for parts (ring/satellite) that overflow their element's own box
  // via absolute positioning.
  function growClusterNodeTo(nodeEl, orbSelector, nativeSlotKey, targetRect, durationMs) {
    if (!nodeEl || !targetRect) return;
    const wrapEl = nodeEl.querySelector('.cluster-planet-wrap');
    const orbEl = (orbSelector && nodeEl.querySelector(orbSelector)) || wrapEl;
    if (!orbEl) return;

    const currentOrbRect = orbEl.getBoundingClientRect();
    const nodeRect = nodeEl.getBoundingClientRect();
    const native = CLUSTER[nativeSlotKey];
    const growthRatio = currentOrbRect.width > 0 ? (targetRect.width / currentOrbRect.width) : 1;
    const finalWrapScale = (native ? native.scale : 1) * growthRatio;

    const targetCx = targetRect.left + targetRect.width / 2;
    const targetCy = targetRect.top + targetRect.height / 2;

    nodeEl.style.transition = 'none';
    nodeEl.style.zIndex = '9999';
    nodeEl.style.position = 'fixed';
    nodeEl.style.left = `${nodeRect.left}px`;
    nodeEl.style.top = `${nodeRect.top}px`;
    nodeEl.style.width = `${nodeRect.width}px`;
    nodeEl.style.height = `${nodeRect.height}px`;
    nodeEl.style.transform = 'none';
    void nodeEl.offsetWidth; // lock the snap in before animating

    const ease = `${durationMs}ms cubic-bezier(0.22, 1, 0.36, 1)`;
    nodeEl.style.transition = `left ${ease}, top ${ease}, width ${ease}, height ${ease}`;
    nodeEl.style.left = `${targetCx - TAB_HOME_BOX / 2}px`;
    nodeEl.style.top = `${targetCy - TAB_HOME_BOX / 2}px`;
    nodeEl.style.width = `${TAB_HOME_BOX}px`;
    nodeEl.style.height = `${TAB_HOME_BOX}px`;

    if (wrapEl) setWrapScale(wrapEl, finalWrapScale, `transform ${ease}`);
  }

  // Call from a tab page's Home icon click.
  //
  // Rewritten so the real, visible motion starts on THIS page
  // immediately (using the tab's own already-painted cluster icons —
  // nothing new has to be built before it can move), while the actual
  // home page is fetched AND fully measured off-screen in parallel. The
  // DOM swap only happens once that motion has already finished landing
  // in the right spot, so the swap becomes an invisible same-pixels
  // handoff instead of the moment the animation has to start — which is
  // what used to read as a freeze (see legacyCollapseToHome's comment).
  function collapseToHome() {
    beginTransition();
    const tabBody = document.querySelector('.tab-body');
    const sunNode = document.getElementById('cluster-home');
    const bigNode = document.querySelector('.cluster-big');
    const miniNodes = Array.from(document.querySelectorAll('.cluster-mini'));

    // Layout not what we expect — fall back rather than break nav.
    if (!tabBody || !sunNode || !bigNode || miniNodes.length !== 3) {
      legacyCollapseToHome();
      return;
    }

    tabBody.style.pointerEvents = 'none';
    fadeTabChrome();

    const fetchHome = (window.SolarisRouter && window.SolarisRouter.prefetch)
      ? window.SolarisRouter.prefetch('/solaris')
      : fetch('/solaris', { headers: { 'X-Solaris-Router': '1' } }).then((res) => {
        if (!res.ok) throw new Error('bad status');
        return res.text();
      });

    fetchHome.then((html) => {
      const targets = measureHomeTargets(html);
      const currentKey = tabBody.getAttribute('data-current-planet');

      growClusterNodeTo(sunNode, '.sun-orb', 'home', targets.sun, TAB_HOME_ENTRANCE_MS);
      growClusterNodeTo(bigNode, ORB_SELECTOR_BY_PLANET[currentKey], 'big', targets[currentKey], TAB_HOME_ENTRANCE_MS);
      miniNodes.forEach((node) => {
        const key = node.getAttribute('data-planet');
        const slot = node.classList.contains('cluster-tr') ? 'tr'
          : node.classList.contains('cluster-bl') ? 'bl'
          : node.classList.contains('cluster-br') ? 'br' : null;
        growClusterNodeTo(node, ORB_SELECTOR_BY_PLANET[key], slot, targets[key], TAB_HOME_ENTRANCE_MS);
      });

      // html is already sitting in the router's prefetch cache at this
      // point, so this navigate() is just an instant swap+reinit once
      // the motion above has visually finished — nothing left to wait on.
      setTimeout(() => {
        navigateTo('/solaris', { skipFade: true });
      }, TAB_HOME_ENTRANCE_MS + 80);
    }).catch((err) => {
      if (err && err.poweredOff) return; // server was restarted: the popup is showing, don't start another transition
      legacyCollapseToHome();
    });
  }


  // Call on home page load. No-op unless the previous page was a tab
  // that called collapseToHome(). Starts each of the 4 real planets at
  // its cluster position (big for whichever tab we're returning from,
  // mini for the other three, matching collapseToTab's slot mapping),
  // sun/tagline/black-hole hidden, then animates everything out to its
  // natural layout position — the visual reverse of collapseToTab.
  function playHomeReturnEntrance() {
    let returningKey = null;
    try {
      returningKey = sessionStorage.getItem(HOME_RETURN_KEY);
      sessionStorage.removeItem(HOME_RETURN_KEY);
    } catch (e) { /* ignore */ }
    if (!returningKey || PLANET_ORDER.indexOf(returningKey) === -1) return;

    const others = PLANET_ORDER.filter((k) => k !== returningKey);
    const slotFor = { [returningKey]: CLUSTER.big };
    const cornerSlots = [CLUSTER.tr, CLUSTER.bl, CLUSTER.br];
    others.forEach((key, i) => { slotFor[key] = cornerSlots[i]; });

    const header = document.querySelector('.solaris-header');
    // .sun-wrap, not .sun-orb — see the matching note in collapseToTab()
    // above: the wrap carries the glow, so it has to be what's animated.
    const sun = document.querySelector('.sun-wrap');
    const title = document.querySelector('.solaris-title');
    const tagline = document.querySelector('.solaris-tagline');
    const blackhole = document.querySelector('.blackhole-btn');
    [title, tagline].forEach((el) => { if (el) el.style.opacity = '0'; });
    if (blackhole) blackhole.style.opacity = '0';

    if (sun) {
      const rect = sun.getBoundingClientRect();
      const curCx = rect.left + rect.width / 2;
      const curCy = rect.top + rect.height / 2;
      const dx = CLUSTER.home.cx - curCx;
      const dy = CLUSTER.home.cy - curCy;
      const scale = CLUSTER.home.scale;
      sun.style.transition = 'none';
      sun.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
    }

    const orbEls = {};
    PLANET_ORDER.forEach((key) => {
      const orbSel = ORB_SELECTOR_BY_PLANET[key];
      const orbEl = orbSel && document.querySelector(orbSel);
      if (!orbEl) return;
      orbEls[key] = orbEl;

      const rect = orbEl.getBoundingClientRect();
      const curCx = rect.left + rect.width / 2;
      const curCy = rect.top + rect.height / 2;
      const slot = slotFor[key];
      const dx = slot.cx - curCx;
      const dy = slot.cy - curCy;
      const scale = slot.scale;

      orbEl.style.transition = 'none';
      orbEl.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;

      const label = orbEl.closest('.planet-node')?.querySelector('.planet-label');
      if (label) label.style.opacity = '0';
    });

    // two rAFs: let the "start" transform paint first, then animate to
    // natural position on the next frame
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        PLANET_ORDER.forEach((key) => {
          const orbEl = orbEls[key];
          if (!orbEl) return;
          orbEl.style.transition = `transform ${CLUSTER_DURATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
          orbEl.style.transform = 'translate(0, 0) scale(1)';

          const label = orbEl.closest('.planet-node')?.querySelector('.planet-label');
          if (label) {
            label.style.transition = 'opacity 0.5s ease 0.3s';
            label.style.opacity = '1';
          }
        });
        if (sun) {
          sun.style.transition = `transform ${CLUSTER_DURATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
          sun.style.transform = 'translate(0, 0) scale(1)';
        }
        if (title) { title.style.transition = 'opacity 0.6s ease 0.25s'; title.style.opacity = '1'; }
        if (tagline) { tagline.style.transition = 'opacity 0.6s ease 0.35s'; tagline.style.opacity = '1'; }
        if (blackhole) {
          blackhole.style.transition = 'opacity 0.6s ease 0.2s';
          blackhole.style.opacity = '1';
        }
      });
    });
  }

  // ── TAB → TAB: orbit-rotation transition ──────────────────────────
  // Used when the person clicks one of the 3 mini planets in a tab
  // page's own nav-cluster (see tab.js). Choreography (always the same
  // 6 beats, per the feature spec):
  //   1. Shrink — the current big planet drops to mini scale in place.
  //   2. Swap   — sun <-> shrunk current planet trade positions (sun
  //               lands center, current lands in the home/top-left slot).
  //   3. Reduce — every ring member (current + the 3 minis) pulls in
  //               toward the now-centered sun, so the orbit motion in
  //               the next beat is visible instead of happening off in
  //               the corners.
  //   4. Rotate — the whole ring orbits clockwise (always clockwise,
  //               never the short way) around the sun until the
  //               clicked/destination planet's angle matches the home
  //               slot's angle.
  //   5. Swap   — destination planet <-> sun trade positions again
  //               (destination lands center, sun returns home).
  //   6. Grow   — the destination planet, now centered, grows to full
  //               (cluster-big) scale, then we navigate.
  // Geometry reuses CLUSTER (same slot coordinates tab.css is built
  // against) so a node's "natural" resting point is always one of
  // CLUSTER.home/tr/bl/br/big — every beat below just computes how far
  // (dx, dy) a node's transform needs to travel FROM that fixed native
  // point TO wherever it should visually be this instant.
  // Per the spec's own note: geometry here is an approximation (the 4
  // corner slots aren't a perfect square, so a rigid rotation can't
  // land every ring member exactly on another slot's angle) — that's
  // fine, since the destination tab's own fragment renders each planet
  // at its exact correct position the moment navigation completes, so
  // any last-frame mismatch here is invisible.
  const RING_STEP_MS = 260;   // duration per ~90deg of rotation
  const SHRINK_MS = 300;
  const SWAP_MS = 400;
  const REDUCE_MS = 280;
  const GROW_MS = 420;
  const REDUCE_FACTOR = 0.55; // how far the ring pulls toward the sun
  const MINI_BOX = 64;  // .cluster-home / .cluster-mini box size (px)
  const BIG_BOX = 160;  // .cluster-big box size (px)

  function polarPoint(center, angleDeg, radius) {
    const rad = (angleDeg * Math.PI) / 180;
    return { cx: center.cx + radius * Math.cos(rad), cy: center.cy + radius * Math.sin(rad) };
  }

  // Angle/radius of a CLUSTER slot relative to CLUSTER.big (the sun's
  // centered parking spot). atan2 here is in screen space (+y down), so
  // increasing angle already reads as clockwise motion visually.
  function polarOfSlot(slotKey) {
    const s = CLUSTER[slotKey];
    const center = CLUSTER.big;
    const dx = s.cx - center.cx;
    const dy = s.cy - center.cy;
    return { angle: (Math.atan2(dy, dx) * 180) / Math.PI, radius: Math.hypot(dx, dy) };
  }

  function setNodeTransform(nodeEl, targetCx, targetCy, nativeSlotKey, transitionCss) {
    const native = CLUSTER[nativeSlotKey];
    nodeEl.style.transition = transitionCss || 'none';
    void nodeEl.offsetWidth; // force reflow so the transition is picked up
    nodeEl.style.transform = `translate(${targetCx - native.cx}px, ${targetCy - native.cy}px)`;
  }

  function setWrapScale(wrapEl, scale, transitionCss) {
    wrapEl.style.transition = transitionCss || 'none';
    void wrapEl.offsetWidth;
    wrapEl.style.transform = `translate(-50%, -50%) scale(${scale})`;
  }

  function rotateToTab(url, destinationKey) {
    beginTransition();
    const tabBody = document.querySelector('.tab-body');
    const sunNode = document.getElementById('cluster-home');
    const currentNode = document.querySelector('.cluster-big');
    const currentWrap = currentNode && currentNode.querySelector('.cluster-planet-wrap');
    const miniNodes = Array.from(document.querySelectorAll('.cluster-mini'));
    const destNode = miniNodes.find((n) => n.getAttribute('data-planet') === destinationKey);

    // Layout not what we expect (missing a node, markup changed, etc) —
    // fall back to the plain iris transition rather than breaking nav.
    if (!tabBody || !sunNode || !currentNode || !currentWrap || miniNodes.length !== 3 || !destNode) {
      preloadTextures(destinationKey);
      warpTo(url, { color: '#05060c' });
      return;
    }

    preloadTextures(destinationKey);
    if (window.SolarisRouter && window.SolarisRouter.prefetch) window.SolarisRouter.prefetch(url);

    tabBody.style.pointerEvents = 'none';
    const currentPlanetKey = tabBody.getAttribute('data-current-planet');

    function slotKeyOf(node) {
      if (node.classList.contains('cluster-tr')) return 'tr';
      if (node.classList.contains('cluster-bl')) return 'bl';
      if (node.classList.contains('cluster-br')) return 'br';
      return null;
    }

    ['.tab-header-bar', '.log-btn', '.tab-content'].forEach((sel) => {
      const el = document.querySelector(sel);
      if (el) { el.style.transition = 'opacity 0.3s ease'; el.style.opacity = '0'; }
    });
    showSkeleton(url);

    // ── 1. Shrink — current planet drops to mini scale, stays centered ──
    setWrapScale(currentWrap, CLUSTER.tr.scale, `transform ${SHRINK_MS}ms ease`);

    setTimeout(() => {
      // ── 2. Swap — sun <-> shrunk current planet ──
      setNodeTransform(sunNode, CLUSTER.big.cx, CLUSTER.big.cy, 'home', `transform ${SWAP_MS}ms cubic-bezier(0.45,0,0.55,1)`);
      setNodeTransform(currentNode, CLUSTER.home.cx, CLUSTER.home.cy, 'big', `transform ${SWAP_MS}ms cubic-bezier(0.45,0,0.55,1)`);

      setTimeout(runReduce, SWAP_MS + 20);
    }, SHRINK_MS + 20);

    function runReduce() {
      // Ring membership: current planet is logically parked in the
      // 'home' slot now; the 3 minis haven't moved yet, still in their
      // own natural slots. `key` is each member's actual planet id —
      // used at the end to send it to its EXACT slot on the destination
      // page (see destSlotFor), not an approximation.
      const ring = [{ node: currentNode, nativeSlot: 'big', logicalSlot: 'home', key: currentPlanetKey, isDest: false }]
        .concat(miniNodes.map((n) => {
          const slot = slotKeyOf(n);
          return { node: n, nativeSlot: slot, logicalSlot: slot, key: n.getAttribute('data-planet'), isDest: n === destNode };
        }));

      // ── 3. Reduce — pull every ring member in toward the centered sun ──
      ring.forEach((m) => {
        const polar = polarOfSlot(m.logicalSlot);
        m.angle = polar.angle;
        m.radius = polar.radius;
        const p = polarPoint(CLUSTER.big, m.angle, m.radius * REDUCE_FACTOR);
        setNodeTransform(m.node, p.cx, p.cy, m.nativeSlot, `transform ${REDUCE_MS}ms ease-in`);
      });

      setTimeout(() => runRotate(ring), REDUCE_MS + 20);
    }

    function runRotate(ring) {
      // ── 4. Rotate — orbit the whole ring clockwise (always) until the
      // destination member's angle lines up with the home slot's angle ──
      const destMember = ring.find((m) => m.isDest);
      const homeAngle = polarOfSlot('home').angle;
      let delta = homeAngle - destMember.angle;
      delta = ((delta % 360) + 360) % 360;
      if (delta < 1) delta = 360; // still read as a rotation, never a no-op

      const steps = Math.max(1, Math.round(delta / 90)); // for timing only
      const duration = steps * RING_STEP_MS;
      const start = performance.now();
      ring.forEach((m) => { m.node.style.transition = 'none'; });

      function frame(now) {
        const t = Math.min(1, (now - start) / duration);
        const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // ease-in-out
        const angleNow = eased * delta;
        ring.forEach((m) => {
          const p = polarPoint(CLUSTER.big, m.angle + angleNow, m.radius * REDUCE_FACTOR);
          const native = CLUSTER[m.nativeSlot];
          m.node.style.transform = `translate(${p.cx - native.cx}px, ${p.cy - native.cy}px)`;
        });
        if (t < 1) {
          requestAnimationFrame(frame);
        } else {
          ring.forEach((m) => { m.angle += delta; }); // land exactly
          finishRing(ring, destMember);
        }
      }
      requestAnimationFrame(frame);
    }

    function finishRing(ring, destMember) {
      // Non-destination ring members go EXACTLY to the slot they'll
      // occupy on the destination page (mirrors solaris.py's own
      // PLANET_ORDER/SLOT_ORDER assignment) — not an approximation of
      // wherever the rotation happened to land them. This is what
      // makes the transition's end state match the destination tab's
      // actual rendered layout pixel-for-pixel, so there's no pop when
      // the page swaps in.
      ring.forEach((m) => {
        if (m.isDest) return;
        const target = CLUSTER[destSlotFor(m.key, destinationKey)];
        setNodeTransform(m.node, target.cx, target.cy, m.nativeSlot, `transform ${SWAP_MS}ms ease-out`);
      });

      // ── 5. Swap — destination planet <-> sun ──
      setNodeTransform(destMember.node, CLUSTER.big.cx, CLUSTER.big.cy, destMember.nativeSlot, `transform ${SWAP_MS}ms cubic-bezier(0.45,0,0.55,1)`);
      setNodeTransform(sunNode, CLUSTER.home.cx, CLUSTER.home.cy, 'home', `transform ${SWAP_MS}ms cubic-bezier(0.45,0,0.55,1)`);

      setTimeout(() => {
        // ── 6. Grow — destination planet, now centered, grows to full
        // size. A slight overshoot (back-out easing) makes the growth
        // read as complete rather than trailing off, and we hold well
        // past GROW_MS before navigating so the scale has fully settled
        // at CLUSTER.big.scale — the exact same value tab.css's own
        // .cluster-big uses — before the page swap ever happens.
        //
        // IMPORTANT: destMember.node is still a MINI_BOX-sized
        // (64x64) .cluster-node, and .cluster-node clips its content
        // via overflow:hidden. If we only scaled the inner wrap up to
        // big-planet size, this 64px box would crop the grown planet
        // down to a small porthole showing just its center — which is
        // what "grow isn't big enough" actually was. So the node's own
        // box has to grow to BIG_BOX right alongside the wrap's scale.
        // We switch this one node from transform-based positioning to
        // explicit left/top so we can animate width/height at the same
        // time — first snapping (no transition) to the exact same
        // visual spot/size it's already at, then transitioning
        // left/top/width/height together with the SAME easing as the
        // wrap's scale so the box's center never drifts and the box
        // never lags behind the content it's supposed to contain. ──
        const node = destMember.node;
        const destWrap = node.querySelector('.cluster-planet-wrap');

        node.style.transition = 'none';
        node.style.transform = 'none';
        node.style.left = `${CLUSTER.big.cx - MINI_BOX / 2}px`;
        node.style.top = `${CLUSTER.big.cy - MINI_BOX / 2}px`;
        node.style.width = `${MINI_BOX}px`;
        node.style.height = `${MINI_BOX}px`;
        void node.offsetWidth; // lock the snap in before animating

        const growEase = `${GROW_MS}ms cubic-bezier(0.34,1.56,0.64,1)`;
        node.style.transition = `left ${growEase}, top ${growEase}, width ${growEase}, height ${growEase}`;
        node.style.left = `${CLUSTER.big.cx - BIG_BOX / 2}px`;
        node.style.top = `${CLUSTER.big.cy - BIG_BOX / 2}px`;
        node.style.width = `${BIG_BOX}px`;
        node.style.height = `${BIG_BOX}px`;

        if (destWrap) setWrapScale(destWrap, CLUSTER.big.scale, `transform ${growEase}`);
        setTimeout(() => {
          navigateTo(url, { skipFade: true });
        }, Math.max(0, GROW_MS - 60));
      }, SWAP_MS + 20);
    }
  }

  // Wires up planet links on the home page: intercepts the click and
  // plays the cluster-collapse transition instead of a plain page jump.
  // Requires each .planet-node to have a data-planet="job-odyssey" (etc)
  // attribute matching PLANET_ORDER's keys.
  function bindPlanetLinks(selector) {
    document.querySelectorAll(selector || '.planet-node').forEach((link) => {
      link.addEventListener('click', (e) => {
        const href = link.getAttribute('href');
        const key = link.getAttribute('data-planet');
        if (!href || !key) return;
        e.preventDefault();
        // Powered off (sun not clicked yet): nothing may be approached.
        if (document.body.classList.contains('solaris-booting')) return;
        collapseToTab(href, key);
      });
    });
  }

  // Warms scaleCache for every orb+slot combo up front, during idle
  // time, instead of waiting for the user's first click to discover
  // what needs measuring. Idempotent and cheap to call repeatedly
  // (skips anything already cached), so it's safe to re-trigger on
  // every return to home, not just the very first load.
  //
  // Processes a couple of combos per idle callback rather than all 9 in
  // one shot — measuring everything at once was itself long enough to
  // trip the same "handler took Xms" violation this was meant to avoid,
  // just moved from the click to the idle callback. Chunking keeps each
  // individual callback short; queue() below re-schedules itself until
  // the queue's empty.
  const CHUNK_SIZE = 2;
  let scaleCachePrewarmed = false;

  function prewarmScaleCache() {
    if (scaleCachePrewarmed) return;
    const sun = document.querySelector('.sun-wrap');
    if (!document.querySelector('.planet-row') || !sun) return; // not the home page

    const queue = [];
    PLANET_ORDER.forEach((key) => {
      const orbSel = ORB_SELECTOR_BY_PLANET[key];
      const orbEl = orbSel && document.querySelector(orbSel);
      if (!orbEl) return;
      ['big', 'mini'].forEach((slotKey) => {
        const cacheKey = cacheKeyFor(key, slotKey);
        if (!(cacheKey in scaleCache)) queue.push({ orbEl, slotKey, cacheKey });
      });
    });
    const homeCacheKey = cacheKeyFor('sun', 'home');
    if (!(homeCacheKey in scaleCache)) queue.push({ orbEl: sun, slotKey: 'home', cacheKey: homeCacheKey });

    if (!queue.length) { scaleCachePrewarmed = true; return; }

    function processChunk() {
      const chunk = queue.splice(0, CHUNK_SIZE);
      if (!chunk.length) { scaleCachePrewarmed = true; return; }

      const ownRects = chunk.map(({ orbEl }) => orbEl.getBoundingClientRect());
      const measuredRects = measureClusterTargets(chunk);
      chunk.forEach((item, i) => {
        const rect = ownRects[i];
        const measured = measuredRects[i];
        if (rect.width > 0 && measured.width > 0) scaleCache[item.cacheKey] = measured.width / rect.width;
      });

      if (queue.length) scheduleChunk(processChunk);
    }

    scheduleChunk(processChunk);
  }

  function scheduleChunk(fn) {
    if ('requestIdleCallback' in window) {
      requestIdleCallback(fn, { timeout: 2000 });
    } else {
      setTimeout(fn, 50);
    }
  }

  window.SolarisTransition = {
    warpTo, returnHome, playEntrance, bindPlanetLinks, collapseToTab,
    collapseToHome, playHomeReturnEntrance, preloadTextures, CLUSTER,
    rotateToTab, hideSkeleton, endTransition,
  };

  // Re-callable so the SPA router can rebind after every swap back to
  // the home fragment — the previous fragment's elements (and their
  // listeners) are gone each time #app's content is replaced.
  window.__solarisInit = window.__solarisInit || {};
  window.__solarisInit.home = function () {
    bindPlanetLinks('.planet-node');
    scaleCachePrewarmed = false; // this is a fresh fragment's elements — reset the guard so a first-ever prewarm still runs if the cache is somehow still empty (it usually won't be, since the cache itself persists across navigations)
    prewarmScaleCache();
  };

  document.addEventListener('DOMContentLoaded', () => {
    window.__solarisInit.home();
    playEntrance();
    playHomeReturnEntrance();
  });
})();

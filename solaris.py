"""
solaris.py — Flask server for Bala's Solaris (SPA).

Project layout:
    solaris.py
    html/
        shell.html              persistent document — loads ALL css/js once,
                                 holds the starfield canvas, wraps #app
        fragments/
            home.html            home page's swappable content
            tab.html              shared Jinja template for the 4 tab pages
        transition.html         reference doc only, not a live route
    css/  (see FILE_LOCATIONS below for the full list — each concern its
           own small file: base, planet_base, blackhole, sun,
           starfield_shell, planet_row, saturn, mars, abyss, nexus,
           transition, tab, responsive)
    js/   (shared, sun, saturn, mars, abyss, nexus, starfield, blackhole,
           tab, transition, router — same one-concern-per-file split)
    py/
        transition.py            currently unused by this app (kept for a
                                  possible future standalone tab server)
    Assets/
        jpg/..., png/...

SPA routing: every route below can be requested two ways —
  1. A normal browser navigation (typed URL, refresh, bookmark, or any
     link click that ISN'T intercepted by js/router.js) -> returns the
     FULL page: shell.html with the right fragment already rendered
     inside #app, so there's no flash of empty content and no second
     request.
  2. A fetch() from js/router.js, identified by the X-Solaris-Router
     header it sends -> returns ONLY the fragment's HTML, which the
     router swaps into the already-loaded page's #app div. No shell,
     no <head>, no scripts — those are already running from the first
     load and never restart.
"""

from flask import Flask, send_from_directory, jsonify, render_template, request, redirect
import os
import signal
import threading
import time
import py.workflow_store as scraper_workflow_store

_ROOT = os.path.dirname(os.path.abspath(__file__))
HTML_DIR = os.path.join(_ROOT, "html")
CSS_DIR = os.path.join(_ROOT, "css")
JS_DIR = os.path.join(_ROOT, "js")
ASSETS_DIR = os.path.join(_ROOT, "Assets")
# Scraper Abyss's real data layer — JSON workflow/temp files live under
# data/, per-workflow log files live under logs/ (both top-level,
# siblings of html/css/js/db — see py/workflow_store.py's own docstring
# for the full source->destination path mapping).
DATA_DIR = os.path.join(_ROOT, "data")
LOGS_DIR = os.path.join(_ROOT, "logs")

app = Flask(__name__, template_folder=HTML_DIR)

# fragments/scraper_workflows_table.html reads workflow_store.
# list_workflows()'s fields directly (status/stage/portal/type/
# started_at/updated_at are already computed, final-display values —
# no per-field remap macro needed the way the old mock data required
# scraper_table_status()/scraper_current_stage() jinja globals; those
# were removed along with py/scraper_store.py, which is no longer used
# anywhere in this app).

BASE = "/solaris"
ROUTER_HEADER = "X-Solaris-Router"

# ── Global power state ────────────────────────────────────────────
# Whether Solaris is "powered on" used to live in each browser tab's own
# sessionStorage — meaning a fresh tab/window always replayed the boot
# screen even if you'd already powered on elsewhere. This is now a
# single server-side flag shared by every client: powering on once (via
# POST /solaris/power-on, called by js/boot.js when the sun is clicked)
# makes ANY tab or direct link — including ones opened after that click
# — skip boot and land straight on its page, until Terminus shuts the
# server down (which ends the process entirely, so the flag naturally
# resets to off the next time the server starts).
_power_lock = threading.Lock()
_powered_on = False


def is_powered_on():
    with _power_lock:
        return _powered_on


def set_powered_on(value):
    global _powered_on
    with _power_lock:
        _powered_on = value


def is_router_request():
    return request.headers.get(ROUTER_HEADER) == "1"


def render_page(fragment_template, page_title, page_key=None, powered_on=False, **fragment_ctx):
    """Renders a fragment; wraps it in the shell unless this is a
    router.js fetch, in which case the fragment alone is returned.
    page_key (e.g. "home", "job-odyssey") is passed through to
    shell.html so <body> itself can carry data-page-key — needed
    because <body> is the actual scroll container (see base.css'
    html,body rule) and is an ANCESTOR of .tab-body/[data-page], so
    per-tab CSS variables scoped only to those descendant elements
    never reach body's own scrollbar. Scoping on body directly fixes
    that without duplicating every --cv-*/--jo-*/--pnx-* variable.
    powered_on decides whether shell.html renders <body> with the
    solaris-booting class already present or not, so a brand new
    tab/window opened while Solaris is powered on renders straight
    into its final state with no boot flash at all."""
    body_html = render_template(fragment_template, **fragment_ctx)
    if is_router_request():
        return body_html
    return render_template(
        "shell.html", title=page_title, body_html=body_html, page_key=page_key, powered_on=powered_on
    )


# ── Home page ──────────────────────────────────────────────────
@app.route(BASE)
@app.route(BASE + "/")
def home():
    return render_page("fragments/home.html", "Bala's Solaris", page_key="home", powered_on=is_powered_on())


# ── Tab pages (placeholders — see project notes) ─────────────────
# Order matters here — it's the same order used for the home page's
# cluster-collapse animation (see PLANET_ORDER in transition.js). Each
# tab's "others" list is this order with itself removed, filled into
# tr/bl/br in that order — keep both in sync if you reorder.
TAB_DATA = {
    "job-odyssey": {"title": "Job Odyssey", "icon": "🪐", "short": "Job"},
    "career-voyager": {"title": "Career Voyager", "icon": "🚀", "short": "Career"},
    "scraper-abyss": {"title": "Scraper Abyss", "icon": "🌀", "short": "Scrape"},
    "profile-nexus": {"title": "Profile Nexus", "icon": "⭐", "short": "Profile"},
}
PLANET_ORDER = ["job-odyssey", "career-voyager", "scraper-abyss", "profile-nexus"]
SLOT_ORDER = ["tr", "bl", "br"]


def _render_tab(key, active_sub=None):
    # Gated on the GLOBAL power state, not on how the request arrived.
    # While Solaris is powered off, every tab link — typed URL,
    # bookmark, direct link, or even an in-app router.js fetch — bounces
    # to home/boot. Once powered on (see set_powered_on / the
    # /solaris/power-on route below), a direct link/bookmark/new tab
    # renders that tab's full page immediately, no boot screen, no
    # detour through home — exactly like an in-app click would.
    if not is_powered_on():
        return redirect(BASE)

    data = TAB_DATA[key]
    others_keys = [k for k in PLANET_ORDER if k != key]
    others = [
        {
            "key": k,
            "url": f"{BASE}/{k}",
            "label": TAB_DATA[k]["title"],
            "short": TAB_DATA[k]["short"],
            "slot": SLOT_ORDER[i],
        }
        for i, k in enumerate(others_keys)
    ]
    # Only scraper-abyss's fragment (sa_content()) reads "workflows";
    # every other tab's macro call doesn't take this param, so it's
    # harmless to pass through unconditionally rather than branching.
    # Real, file-backed data now (py/workflow_store.list_workflows()),
    # not the old in-memory mock list.
    #
    # active_sub carries which sub-tab/sub-page should be
    # server-rendered active (None on the bare tab route, where
    # tab.html's macro calls fall back to each tab's own default —
    # see SCRAPER_ABYSS_SUBTABS/CAREER_VOYAGER_SUBTABS/
    # PROFILE_NEXUS_SUBTABS routes below for where a real value comes
    # from). This is what makes a sub-tab URL — e.g.
    # /scraper-abyss/workflow — render with the right panel visible
    # immediately, rather than always defaulting to the first one and
    # requiring a client-side click to correct it.
    return render_page(
        "fragments/tab.html",
        f"{data['title']} — Bala's Solaris",
        page_key=key,
        powered_on=True,
        title=data["title"],
        icon=data["icon"],
        current_key=key,
        others=others,
        workflows=scraper_workflow_store.list_workflows() if key == "scraper-abyss" else None,
        active_sub=active_sub,
    )


# Sub-tab URL slugs, one dict per tab that has sub-tabs (Job Odyssey has
# none). Keys are the URL segment; values are the internal panel/page
# id each fragment's macros already key off of (data-sa-tab/data-cv-tab/
# data-sub attribute values — see scraper_abyss.html/career_voyager.html/
# profile_nexus.html). Scraper Abyss deliberately uses "request"/
# "workflow" here rather than "beacon"/"hyperlane" — matches the
# source dashboard's original naming for these two screens, kept for
# the URL even though the UI labels themselves became Beacon/Hyperlane.
SCRAPER_ABYSS_SUBTABS = {"request": "beacon", "workflow": "hyperlane"}
CAREER_VOYAGER_SUBTABS = {"apps": "apps", "sites": "sites"}
PROFILE_NEXUS_SUBTABS = {
    "personal": "personal", "education": "education", "experience": "experience",
    "workhistory": "workhistory", "eeo": "eeo", "workauth": "workauth",
    "india": "india", "social": "social", "skills": "skills",
}

# The URL slug each tab's bare route (e.g. /career-voyager) redirects
# to — the first/preselected sub-tab in each *_SUBTABS dict above.
# A real 302 here, not just the client-side history.replaceState
# normalization already in each tab's *_ui.js: that JS only runs once
# the page's own script executes, so a direct hit on the bare URL
# (typed in, bookmarked, opened in a new tab) would otherwise render
# and briefly sit on an ambiguous URL before correcting itself. This
# way the bare URL never actually renders content — it always forwards
# straight to the real one server-side.
DEFAULT_SUBTAB = {
    "scraper-abyss": "request",
    "career-voyager": "apps",
    "profile-nexus": "personal",
}


@app.route(BASE + "/job-odyssey")
def job_odyssey():
    return _render_tab("job-odyssey")


@app.route(BASE + "/career-voyager")
def career_voyager():
    # Real server-side redirect, not just the client-side history.
    # replaceState normalization in career_voyager_ui.js — that JS
    # fix only runs after the page's own JS executes, so a direct hit
    # on the bare URL (typed in, bookmarked, or middle-clicked before
    # any script has run) would sit on an ambiguous URL for a moment.
    # This makes the bare URL never actually render — it always
    # forwards straight to the default sub-tab. Power-on gating still
    # happens exactly once, in career_voyager_apps()'s _render_tab()
    # call, same as before this redirect existed.
    return redirect(BASE + "/career-voyager/" + DEFAULT_SUBTAB["career-voyager"])


@app.route(BASE + "/career-voyager/apps")
def career_voyager_apps():
    return _render_tab("career-voyager", active_sub=CAREER_VOYAGER_SUBTABS["apps"])


@app.route(BASE + "/career-voyager/sites")
def career_voyager_sites():
    return _render_tab("career-voyager", active_sub=CAREER_VOYAGER_SUBTABS["sites"])


@app.route(BASE + "/profile-nexus")
def profile_nexus():
    # Real server-side redirect, not just the client-side history.
    # replaceState normalization in profile_nexus_ui.js — see
    # career_voyager()'s comment above for why this exists as an
    # actual redirect rather than relying on that alone.
    return redirect(BASE + "/profile-nexus/" + DEFAULT_SUBTAB["profile-nexus"])


@app.route(BASE + "/profile-nexus/<sub>")
def profile_nexus_sub(sub):
    # One dynamic route for all 9 rather than 9 near-identical
    # functions (career-voyager/scraper-abyss only have 2 each, so
    # those stay as explicit named routes for readability — this is
    # the one case where that pattern would get repetitive).
    if sub not in PROFILE_NEXUS_SUBTABS:
        return redirect(BASE + "/profile-nexus/" + DEFAULT_SUBTAB["profile-nexus"])
    return _render_tab("profile-nexus", active_sub=PROFILE_NEXUS_SUBTABS[sub])


@app.route(BASE + "/scraper-abyss")
def scraper_abyss():
    # Same real-redirect reasoning as career_voyager() above.
    return redirect(BASE + "/scraper-abyss/" + DEFAULT_SUBTAB["scraper-abyss"])


@app.route(BASE + "/scraper-abyss/request")
def scraper_abyss_request():
    return _render_tab("scraper-abyss", active_sub=SCRAPER_ABYSS_SUBTABS["request"])


@app.route(BASE + "/scraper-abyss/workflow")
def scraper_abyss_workflow_list():
    return _render_tab("scraper-abyss", active_sub=SCRAPER_ABYSS_SUBTABS["workflow"])


@app.route(BASE + "/scraper-abyss/workflow/<workflow_id>")
def scraper_abyss_workflow(workflow_id):
    # Same global power-on gate as every other direct link (see
    # _render_tab's comment above) — a workflow link opened while
    # powered off still bounces to home/boot, not straight to the
    # workflow (there'd be nothing coherent to show; Solaris itself
    # hasn't "booted" yet).
    if not is_powered_on():
        return redirect(BASE)
    wf = scraper_workflow_store.load_workflow(workflow_id)
    if not wf:
        return redirect(BASE + "/scraper-abyss")
    # Deliberately NOT routed through fragments/tab.html — that file's
    # nav-cluster + sa_header()/sa_log()/sa_content() dispatch is built
    # for the 4 top-level tabs, not a per-item detail page one level
    # below one of them. This fragment is fully self-contained (its own
    # back-link/breadcrumb, its own body) and only borrows shell.html
    # for the outer starfield/css/js wrapper, same as every other page.
    return render_page(
        "fragments/scraper_workflow_detail.html",
        f"{wf['workflow_id']} — Scraper Abyss",
        page_key="scraper-abyss",
        powered_on=True,
        workflow=wf,
    )


# ── Static assets ────────────────────────────────────────────────
# Every individual css/js file just needs a name -> folder mapping. No
# per-file allowlist patching needed for NEW planets/features beyond
# this — just add one line here, or drop images straight into
# Assets/jpg or Assets/png (those are handled generically below).
FILE_LOCATIONS = {
    # css/
    "base.css": CSS_DIR,
    "planet_base.css": CSS_DIR,
    "planet_row.css": CSS_DIR,
    "blackhole.css": CSS_DIR,
    "sun.css": CSS_DIR,
    "starfield_shell.css": CSS_DIR,
    "saturn.css": CSS_DIR,
    "mars.css": CSS_DIR,
    "abyss.css": CSS_DIR,
    "nexus.css": CSS_DIR,
    "profile_nexus_ui.css": CSS_DIR,
    "career_voyager_ui.css": CSS_DIR,
    "job_odyssey_ui.css": CSS_DIR,
    "scraper_abyss_ui.css": CSS_DIR,
    "scraper_workflow_detail.css": CSS_DIR,
    "scraper_requests_ui.css": CSS_DIR,
    "scraper_workflows_table_ui.css": CSS_DIR,
    "transition.css": CSS_DIR,
    "tab.css": CSS_DIR,
    "responsive.css": CSS_DIR,
    "export_wizard.css": CSS_DIR,
    # js/
    "shared.js": JS_DIR,
    "sun.js": JS_DIR,
    "saturn.js": JS_DIR,
    "mars.js": JS_DIR,
    "abyss.js": JS_DIR,
    "nexus.js": JS_DIR,
    "profile_nexus_ui.js": JS_DIR,
    "career_voyager_ui.js": JS_DIR,
    "job_odyssey_ui.js": JS_DIR,
    "scraper_abyss_ui.js": JS_DIR,
    "scraper_requests_ui.js": JS_DIR,
    "scraper_workflows_table_ui.js": JS_DIR,
    "scraper_workflow_detail.js": JS_DIR,
    "starfield.js": JS_DIR,
    "blackhole.js": JS_DIR,
    "boot.js": JS_DIR,
    "transition.js": JS_DIR,
    "tab.js": JS_DIR,
    "router.js": JS_DIR,
    "export_wizard.js": JS_DIR,
}


@app.route(BASE + "/<path:filename>")
def static_files(filename):
    if filename in FILE_LOCATIONS:
        return send_from_directory(FILE_LOCATIONS[filename], filename)

    if filename.startswith("Assets/jpg/") or filename.startswith("Assets/png/") or filename.startswith("Assets/webp/"):
        # Guard against path traversal without mangling separators — on
        # Windows, os.path.normpath() would convert to backslashes, which
        # send_from_directory does NOT treat as a path separator (it looks
        # for a literal "Assets\jpg\x.jpg" filename and 404s). Keep the
        # forward-slash form for Flask; only use an OS-native join for the
        # local existence check.
        parts = filename.split("/")
        if ".." in parts or filename.startswith("/"):
            return "Invalid path", 400
        full_path = os.path.join(_ROOT, *parts)
        if os.path.isfile(full_path):
            return send_from_directory(_ROOT, filename)

    # Let unknown sub-paths fall through to your other blueprints.
    return f"Route /{filename} is handled by another module.", 404


# ── Register your existing blueprints here ─────────────────────
from py.career_api import career_api_bp
app.register_blueprint(career_api_bp, url_prefix=BASE + "/api")

from py.profile_api import profile_api_bp
app.register_blueprint(profile_api_bp, url_prefix=BASE + "/api")

from py.jobodyssey_api import jobodyssey_api_bp
app.register_blueprint(jobodyssey_api_bp, url_prefix=BASE + "/api")

from py.scraper_abyss_api import scraper_abyss_api_bp
app.register_blueprint(scraper_abyss_api_bp, url_prefix=BASE + "/api")

from py.export_api import export_api_bp
app.register_blueprint(export_api_bp, url_prefix=BASE + "/api")

# NOTE: py/transition.py is not registered here — the transition system's
# actual logic lives in js/transition.js (a plain static file served via
# FILE_LOCATIONS above), not a Flask Blueprint. py/transition.py is kept
# only as a template for a possible future standalone tab-page server;
# see its own docstring.


# ── Nothing runs or answers while Solaris is powered off ──────────
# The tab PAGES were already gated (_render_tab and the workflow page
# bounce to home/boot while off), but every /solaris/api/* route was open:
# a tab left open across a server restart (which resets the power flag to
# off) could still submit a request and start a workflow while the app
# showed - and was - off. Every API request is now refused until the sun is
# clicked. The X-Solaris-Power header lets js/shared.js recognise this
# refusal and send the stale page back to the boot screen.
@app.before_request
def _block_api_while_powered_off():
    if request.path.startswith(BASE + "/api/") and not is_powered_on():
        resp = jsonify({
            "ok": False,
            "powered_off": True,
            "error": "Solaris is powered off - click the sun on the home screen first.",
        })
        resp.status_code = 403
        resp.headers["X-Solaris-Power"] = "off"
        return resp


@app.after_request
def _tag_power_state(resp):
    # Lets the browser tell, on ANY response, whether the server is powered on.
    # A page that was open across a server restart sees "off" here the moment
    # it asks for anything (see js/shared.js and js/router.js).
    resp.headers["X-Solaris-Power"] = "on" if is_powered_on() else "off"
    return resp


def _power_on_once():
    """Atomically turns the flag on. True only for the call that actually
    flipped it from off to on (a second tab's sun click returns False)."""
    global _powered_on
    with _power_lock:
        was_on = _powered_on
        _powered_on = True
    return not was_on


def _resume_waiting_workflows():
    """Workflows run as background threads inside this process, so a restart
    (Ctrl+C, crash, reboot) silently kills any workflow that was waiting on
    a chained dependency - its status stays "waiting" but nothing is left
    polling, and Hyperlane's Retry/Cancel can't act on it. A waiting
    workflow has never started, so it is always safe to start it again; its
    own dependency check then holds it until the workflow it waits on has
    finished. Workflows that were mid-run (in_progress) are left alone: they
    stopped partway through a stage and need Retry.

    Called only at the moment of power-on (never at server start), so
    nothing runs while the app is off."""
    try:
        import py.workflow_engine as scraper_workflow_engine
        for wf in reversed(scraper_workflow_store.list_workflows()):  # oldest first
            if wf.get("status") == "waiting":
                scraper_workflow_engine.start_workflow(wf["workflow_id"])
                print(f"Resumed waiting workflow {wf['workflow_id']}")
    except Exception as e:
        print(f"Could not resume waiting workflows: {e}")


# ── Power on (sun click) ──────────────────────────────────────────
@app.route(BASE + "/power-on", methods=["POST"])
def power_on():
    if _power_on_once():
        _resume_waiting_workflows()
    return jsonify({"status": "on"}), 200


def _running_workflow_block():
    """Returns the workflow_id of the first workflow currently in a
    state that means a background thread is actually alive for it
    (in_progress = mid-cycle right now; waiting = a descriptor
    workflow's dependency-poll loop, see workflow_engine.run_workflow's
    `while True: ... time.sleep(3)` block) — or None if every workflow
    is in a terminal or paused state (completed/cancelled/failed/hold),
    none of which have a live thread, so it's genuinely safe to exit
    the process. Killing the process while a workflow is actually
    running would cut a fetch/validation/transmission cycle off
    mid-write rather than stopping it cleanly the way Hold/Cancel/
    Revoke do (see py/workflow_engine.py)."""
    for wf in scraper_workflow_store.list_workflows():
        if wf.get("status") in ("in_progress", "waiting"):
            return wf.get("workflow_id")
    return None


# ── Shutdown pre-check (Terminus button, BEFORE the suck-in animation
# plays) — a plain read-only GET so js/blackhole.js can ask "is this
# safe?" without committing to anything, and skip playing an entire
# destructive animation sequence only to then show a blocking error
# with the sun/planets/starfield already gone. The actual /shutdown
# POST below re-checks this itself right before killing the process —
# this pre-check is a courtesy for the animation, not the real gate. ──
@app.route(BASE + "/shutdown-check", methods=["GET"])
def shutdown_check():
    blocking_id = _running_workflow_block()
    if blocking_id:
        return jsonify({"ok": False, "workflow_id": blocking_id})
    return jsonify({"ok": True})


# ── Shutdown (power button) ─────────────────────────────────────
@app.route(BASE + "/shutdown", methods=["POST"])
def shutdown():
    # Authoritative check — runs even if a caller skips /shutdown-check
    # entirely, and covers the (rare) race where a workflow started
    # during the ~1-2s suck-in animation between the pre-check passing
    # and this POST actually arriving. Refusing here means the process
    # never dies with live work in flight, no matter how this route
    # was reached.
    blocking_id = _running_workflow_block()
    if blocking_id:
        return jsonify({
            "ok": False,
            "blocked": True,
            "workflow_id": blocking_id,
            "error": f"Workflow {blocking_id} is running. Please wait until it completes before shutting down.",
        }), 409

    set_powered_on(False)

    def _kill():
        time.sleep(0.35)  # give the response time to reach the browser
        # If running under the Werkzeug debug reloader, this process is the
        # child worker — also signal the parent watcher so it doesn't
        # just restart us.
        try:
            os.kill(os.getppid(), signal.SIGTERM)
        except Exception:
            pass
        os._exit(0)

    threading.Thread(target=_kill, daemon=True).start()
    return jsonify({"status": "shutting down", "ok": True}), 200


if __name__ == "__main__":
    # Jinja2 only compiles a template into Python bytecode the FIRST time
    # it's rendered in this process, then caches the compiled version —
    # every render after that is fast. Without this, the first real visit
    # to each tab pays that one-time compile cost live, in front of the
    # user, which is what shows up as one slow ~300ms fetch in devtools
    # while every other navigation is ~10-20ms. Rendering each fragment
    # once here, before the server starts accepting requests, moves that
    # cost to startup where nobody's waiting on it.
    with app.test_request_context():
        render_template("fragments/home.html")
        render_template(
            "fragments/tab.html",
            title="warmup", icon="", current_key="job-odyssey", others=[],
        )
        render_template("shell.html", title="warmup", body_html="")

    print(f"Solaris running at http://localhost:8090{BASE}")
    app.run(host="0.0.0.0", port=8090, debug=False, threaded=True)

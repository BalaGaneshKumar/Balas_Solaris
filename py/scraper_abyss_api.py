"""
py/scraper_abyss_api.py — Flask blueprint for the Scraper Abyss tab
(Beacon + Hyperlane + workflow detail).

Mechanism ported directly from the source dashboard's
dashboard_server.py routes (per your instruction to match that
exactly), same as py/career_api.py did for Career Voyager. This file
is a thin HTTP wrapper — all business logic stays in
py/workflow_store.py and py/workflow_engine.py, this just calls them
and returns JSON.

Registered in solaris.py the same way career_api_bp/jobodyssey_api_bp
are:
    from py.scraper_abyss_api import scraper_abyss_api_bp
    app.register_blueprint(scraper_abyss_api_bp, url_prefix=BASE + "/api")

Routes (relative to that prefix):

    POST /scraper-submit
        Body: {engines, portals, keywords, locations, blacklist}
        Creates a Scraper and/or Descriptor workflow per portal (same
        engine-driven branching as source), chained one after another via
        depends_on, starts each in a background thread (Descriptor is
        skipped for JSearch/JobsPipe), returns
        {"ok": true, "workflow_ids": [...]}.

    POST /workflow-action
        Body: {workflow_id, action}  — action is one of
        hold/cancel/revoke/retry/reset. Returns {"ok": bool}.

    GET /workflow-list
        Returns {"workflows": [...]} — same shape workflow_store.
        list_workflows() already produces (status/stage already in
        final display form), used directly by Hyperlane's table.

    GET /workflow-detail?id=<workflow_id>
        Returns {"ok": true, "workflow": {...}} or 404 or {"ok": false}.

    GET /workflow-logs?id=<workflow_id>&search=<optional>
        Returns {"logs": [...]} from that workflow's own log file.

    GET /scraper-activity-log
        Returns {"logs": [...]} — the live cross-workflow Activity Log
        (see py/scraper_activity_log.py).

    POST /scraper-activity-log
        Body: {"source": "...", "message": "..."} — records one
        client-side UI event (tab switch, log panel open/close, etc),
        same mechanism as source's /api/client-log.
"""

from flask import Blueprint, jsonify, request, Response

import time

import logging

import py.workflow_store as ws
import py.workflow_engine as we
from py.scraper_activity_log import add_entry as add_activity_entry, get_entries as get_activity_entries


class _ScraperAbyssAccessLogFilter(logging.Filter):
    """Silences Werkzeug's per-request access log line for THIS
    blueprint's own routes only. Scraper Abyss actions already get their
    own entry in the tab's Activity Log panel (client-side, via
    js/scraper_requests_ui.js's activityLog() -> POST
    /scraper-activity-log -> py/scraper_activity_log.py) or the
    per-workflow log file (py/workflow_store.py's wf_log) — a duplicate
    line dumped to the terminal on every submit, poll, or status check
    is just noise. Matches on request path text only, so every other
    tab's requests (career, profile, job odyssey) print exactly as
    before — nothing global is touched. Same fix as
    py/jobodyssey_api.py's _JobOdysseyAccessLogFilter."""
    _PATHS = (
        '/scraper-submit', '/workflow-action', '/workflow-list',
        '/workflow-detail', '/workflow-logs', '/scraper-activity-log',
    )

    def filter(self, record):
        message = record.getMessage()
        return not any(p in message for p in self._PATHS)


logging.getLogger('werkzeug').addFilter(_ScraperAbyssAccessLogFilter())

scraper_abyss_api_bp = Blueprint("scraper_abyss_api", __name__)

# JSearch and JobsPipe both return complete descriptions straight from the
# Scraper fetch, so there is no detail page left for Descriptor to visit —
# Descriptor is always skipped for them.
NO_DESCRIPTOR_PORTALS = ("JSearch", "JobsPipe")


# ── Submit — creates + starts workflow(s) ────────────────────────
@scraper_abyss_api_bp.route("/scraper-submit", methods=["POST"])
def scraper_submit():
    try:
        body = request.get_json(force=True, silent=False) or {}
        engines   = body.get("engines", [])
        portals   = body.get("portals", [])
        keywords  = body.get("keywords", [])
        locations = body.get("locations", [])
        blacklist = body.get("blacklist", [])
        created_ids = []
        prev_wf_id = None  # each workflow waits on the one created before it

        # Workflows are chained across portals (and Scraper -> Descriptor
        # within a portal) so only one portal hits its API at a time. Every
        # workflow is started right away; each one polls its depends_on
        # target (see workflow_engine.run_workflow) until that finishes.
        for portal in portals:
            if "Scraper" in engines:
                scraper_wf_id = ws.create_workflow(portal, keywords, locations,
                                                   blacklist=blacklist, depends_on=prev_wf_id)
                we.start_workflow(scraper_wf_id)
                created_ids.append(scraper_wf_id)
                prev_wf_id = scraper_wf_id

            if "Descriptor" in engines:
                if portal in NO_DESCRIPTOR_PORTALS:
                    add_activity_entry("ScraperAbyss", "Descriptor skipped for " + portal +
                                       " — full description already included by Scraper")
                # Uses the same location list as Scraper — same
                # request-time selection, not a DB-driven "all
                # locations that currently need enrichment" query. If a
                # location has nothing to enrich at run time, the
                # engine skips that stage gracefully.
                elif locations:
                    desc_wf_id = ws.create_descriptor_workflow(portal, locations, depends_on=prev_wf_id)
                    we.start_workflow(desc_wf_id)
                    created_ids.append(desc_wf_id)
                    prev_wf_id = desc_wf_id
                else:
                    add_activity_entry("ScraperAbyss", "Descriptor skipped for " + portal + " — no locations selected")

        add_activity_entry("ScraperAbyss", "Request submitted — workflow(s) created: " + str(created_ids))
        return jsonify({"ok": True, "workflow_ids": created_ids})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)[:120]}), 500


# ── Workflow control actions ─────────────────────────────────────
@scraper_abyss_api_bp.route("/workflow-action", methods=["POST"])
def workflow_action():
    try:
        body = request.get_json(force=True, silent=False) or {}
        wf_id  = str(body.get("workflow_id", ""))
        action = str(body.get("action", ""))
        result = False
        if action == "hold":
            we.hold_workflow(wf_id); result = True
        elif action == "cancel":
            we.cancel_workflow(wf_id); result = True
        elif action == "revoke":
            we.revoke_workflow(wf_id); result = True
        elif action == "retry":
            result = we.retry_workflow(wf_id)
        elif action == "reset":
            result = we.reset_workflow(wf_id)
        return jsonify({"ok": result})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)[:120]}), 500


# ── Workflow list (Hyperlane table) ──────────────────────────────
@scraper_abyss_api_bp.route("/workflow-list", methods=["GET"])
def workflow_list():
    return jsonify({"workflows": ws.list_workflows()})


# ── Workflow detail (single workflow's full JSON) ────────────────
@scraper_abyss_api_bp.route("/workflow-detail", methods=["GET"])
def workflow_detail():
    wf_id = request.args.get("id", "")
    data = ws.load_workflow(wf_id)
    if data is None:
        return jsonify({"ok": False, "error": "Workflow not found"}), 404
    return jsonify({"ok": True, "workflow": data})


# ── Per-workflow logs ─────────────────────────────────────────────
@scraper_abyss_api_bp.route("/workflow-logs", methods=["GET"])
def workflow_logs():
    wf_id  = request.args.get("id", "")
    search = request.args.get("search", "")
    return jsonify({"logs": ws.wf_get_logs(wf_id, search=search or None)})


# ── Log downloads (plain-text files, oldest entry first) ─────────
# The on-screen logs rebuild themselves on a timer, which makes text hard
# to select; a downloaded file can be opened, searched and copied freely.
def _text_download(lines, filename):
    return Response(
        "\n".join(lines) + "\n",
        mimetype="text/plain",
        headers={"Content-Disposition": 'attachment; filename="' + filename + '"'},
    )


@scraper_abyss_api_bp.route("/scraper-activity-log/download", methods=["GET"])
def scraper_activity_log_download():
    entries = get_activity_entries(limit=1000)
    lines = ["# Scraper Abyss activity log — " + str(len(entries)) +
             " entries (oldest first; in memory only, resets when the server restarts)",
             "# timestamp | source | message"]
    for e in entries:
        lines.append(str(e.get("ts", "")) + " | " + str(e.get("source", "")) + " | " + str(e.get("message", "")))
    return _text_download(lines, "scraper-abyss-activity-log-" + time.strftime("%Y%m%d-%H%M%S") + ".txt")


# ── Live cross-workflow Activity Log ─────────────────────────────
@scraper_abyss_api_bp.route("/scraper-activity-log", methods=["GET"])
def scraper_activity_log_get():
    return jsonify({"logs": get_activity_entries()})


@scraper_abyss_api_bp.route("/scraper-activity-log", methods=["POST"])
def scraper_activity_log_post():
    try:
        body = request.get_json(force=True, silent=False) or {}
        source  = str(body.get("source", "ScraperAbyss"))[:40]
        message = str(body.get("message", ""))[:300]
        if message:
            add_activity_entry(source, message)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)[:120]}), 500

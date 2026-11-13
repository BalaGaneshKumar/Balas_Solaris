"""
py/jobodyssey_api.py — Flask blueprint for the Job Odyssey tab.

This is a thin HTTP wrapper around py/jobodyssey_store.py — every route
here just calls a store function and returns its result as JSON. No
filtering/sorting/status/duplicate/blacklist logic lives here; all of
that stays in jobodyssey_store.py (copied over unmodified — see that
file's own docstring). If that logic changes later, nothing in this
file needs to change — it just passes through whatever the store
returns.

Registered in solaris.py the same way career_api_bp/profile_api_bp are:
    from py.jobodyssey_api import jobodyssey_api_bp
    app.register_blueprint(jobodyssey_api_bp, url_prefix=BASE + "/api")

Routes (relative to that prefix, so BASE + "/api" + the paths below) —
mirrors the original dashboard_server.py's two-endpoint mechanism:

    GET  /jobodyssey-load
        Query params (all optional): status, portal, location, search,
        sort, validation, link_type, is_duplicate.
        Returns {"jobs": [...], "stats": {...}, "filterOptions": {...}}
        in one combined call, same as the desktop dashboard's
        /api/jobodyssey-load — jobs + stats + filter dropdown options
        together, so the frontend never has to make 3 round trips just
        to render the page. stats includes a "duplicate" count (rows
        where is_duplicate=1) alongside the store's own status counts —
        computed here by counting load_jobs(is_duplicate=True) results,
        not by adding logic to the store.

    POST /jobodyssey-status
        Body: {"job_id": <int>, "status": "<one of VALID_STATUSES>"}
        Calls jobodyssey_store.update_status() and returns {"ok": bool}.
        This is the only write path the dashboard uses — it's what the
        Eligible / Hold / Ineligible / Applied buttons call. Nothing
        else in the store (insert_jobs, update_description, the
        descriptor-queue helpers) is exposed here, since those belong
        to the scraper/descriptor pipeline, not this dashboard — see
        the store file's own docstrings for those.

    GET  /jobodyssey-job-detail
        Query param: id (<int>).
        Returns {"ok": true, "job": {...}} with the FULL row for one
        job, including description — the only place description is
        ever sent to the browser. /jobodyssey-load above deliberately
        excludes it (see load_jobs()'s own comment for why: it runs to
        ~3,600 chars/job and that endpoint returns every matching row
        unpaginated). The frontend fetches this once per job selected,
        not on every list load.
"""

from flask import Blueprint, jsonify, request

from py.jobodyssey_store import load_jobs, get_stats, get_filter_options, update_status, get_job

import logging


class _JobOdysseyAccessLogFilter(logging.Filter):
    """Silences Werkzeug's per-request access log line for THIS
    blueprint's own routes only (/jobodyssey-load, /jobodyssey-status,
    /jobodyssey-job-detail — anything containing '/jobodyssey-').
    Job tab actions already get their own entry in the tab's Activity
    Log panel client-side (js/job_odyssey_ui.js's joLogPush) — a
    duplicate line dumped to the terminal on every filter click is just
    noise. Matches on request path text only, so every other tab's
    requests (career, profile, scraper) print exactly as before —
    nothing global is touched."""
    def filter(self, record):
        return '/jobodyssey-' not in record.getMessage()


logging.getLogger('werkzeug').addFilter(_JobOdysseyAccessLogFilter())

jobodyssey_api_bp = Blueprint("jobodyssey_api", __name__)


def _bool_param(raw):
    """?is_duplicate=1 / true -> True, ?is_duplicate=0 / false -> False,
    absent -> None (no filter applied) — mirrors the store's own
    is_duplicate=None-means-"don't filter" convention."""
    if raw is None or raw == '':
        return None
    return raw.lower() in ('1', 'true', 'yes')


@jobodyssey_api_bp.route("/jobodyssey-load", methods=["GET"])
def jobodyssey_load():
    try:
        status = request.args.get('status') or None
        status_op = request.args.get('statusOp') or 'or'
        if status_op not in ('or', 'not'):
            status_op = 'or'
        portal = request.args.get('portal') or None
        location = request.args.get('location') or None
        search = request.args.get('search') or None
        sort = request.args.get('sort') or 'date_desc'
        validation = request.args.get('validation') or None
        link_type = request.args.get('link_type') or None
        is_duplicate = _bool_param(request.args.get('is_duplicate'))

        jobs = load_jobs(
            status=status, status_op=status_op, portal=portal, location=location, search=search,
            sort=sort, validation=validation, link_type=link_type,
            is_duplicate=is_duplicate,
        )
        stats = get_stats(
            portal=portal, location=location, search=search,
            validation=validation, link_type=link_type, is_duplicate=is_duplicate,
        )
        filter_options = get_filter_options()

        return jsonify({"jobs": jobs, "stats": stats, "filterOptions": filter_options})
    except Exception as e:
        return jsonify({"jobs": [], "stats": {}, "filterOptions": {"portals": [], "locations": []}, "error": str(e)}), 500


@jobodyssey_api_bp.route("/jobodyssey-status", methods=["POST"])
def jobodyssey_status():
    try:
        payload = request.get_json(force=True, silent=False) or {}
        job_id = payload.get("job_id")
        status = payload.get("status")
        if job_id is None or not status:
            return jsonify({"ok": False, "error": "job_id and status are required"}), 400
        ok = update_status(job_id, status)
        return jsonify({"ok": ok})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@jobodyssey_api_bp.route("/jobodyssey-job-detail", methods=["GET"])
def jobodyssey_job_detail():
    try:
        raw_id = request.args.get('id')
        if raw_id is None:
            return jsonify({"ok": False, "error": "id is required"}), 400
        job = get_job(int(raw_id))
        if job is None:
            return jsonify({"ok": False, "error": "job not found"}), 404
        return jsonify({"ok": True, "job": job})
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "id must be an integer"}), 400
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

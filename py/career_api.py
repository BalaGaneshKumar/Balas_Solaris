"""
py/career_api.py — Flask blueprint for the Career Voyager tab's
save/load endpoints.

Mechanism ported directly from the desktop dashboard's career_tracker.py
+ dashboard_server.py (per your instruction to match that exactly),
replacing this project's previous per-row REST API (GET/POST/PUT/DELETE
on /apps/:id and /sites/:id). The new mechanism:

  - ONE combined load:  GET  /career-load  -> {"apps": [...], "sites": [...]}
  - ONE combined save:  POST /career-save  -> body is {"apps": [...], "sites": [...]};
                        each table is fully DELETEd and re-INSERTed from
                        the arrays given, every single call. No per-row
                        ids are used by the frontend at all — array
                        position is the only identity (same as
                        dashboard_career.py's crApps/crSites arrays).

Registered in solaris.py the same way profile_api_bp is:
    from py.career_api import career_api_bp
    app.register_blueprint(career_api_bp, url_prefix=BASE + "/api")

Data lives in db/career.db (SQLite) — same file/schema this project
already had (career_apps, career_sites tables with these exact column
names), so existing data is preserved; _ensure_schema() only CREATEs
tables IF NOT EXISTS, never drops anything.
"""

from flask import Blueprint, jsonify, request
import os
import sqlite3

career_api_bp = Blueprint("career_api", __name__)

_PY_DIR = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_PY_DIR)  # py/ -> project root
DB_DIR = os.path.join(_ROOT, "db")
CAREER_DB = os.path.join(DB_DIR, "career.db")

APP_COLUMNS = [
    "company", "link", "credential", "credtype", "passhint", "role",
    "location", "date", "stage", "substage", "ghostedsub", "jobid", "notes",
]
SITE_COLUMNS = ["name", "url", "cred", "notes"]


# ── Connection / schema ──────────────────────────────────────────
def _get_conn():
    os.makedirs(DB_DIR, exist_ok=True)
    conn = sqlite3.connect(CAREER_DB)
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_schema(conn):
    conn.execute('''
        CREATE TABLE IF NOT EXISTS career_apps (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            company     TEXT,
            link        TEXT,
            credential  TEXT,
            credtype    TEXT,
            passhint    TEXT,
            role        TEXT,
            location    TEXT,
            date        TEXT,
            stage       TEXT,
            substage    TEXT,
            ghostedsub  TEXT,
            jobid       TEXT,
            notes       TEXT
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS career_sites (
            id     INTEGER PRIMARY KEY AUTOINCREMENT,
            name   TEXT,
            url    TEXT,
            cred   TEXT,
            notes  TEXT
        )
    ''')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_apps_stage ON career_apps(stage)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_apps_company ON career_apps(company)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_sites_name ON career_sites(name)')
    conn.commit()


# ── Load ──────────────────────────────────────────────────────────
def load_career_apps():
    conn = _get_conn()
    _ensure_schema(conn)
    cols = ",".join(APP_COLUMNS)
    cur = conn.execute(f"SELECT {cols} FROM career_apps ORDER BY id")
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows


def load_career_sites():
    conn = _get_conn()
    _ensure_schema(conn)
    cols = ",".join(SITE_COLUMNS)
    cur = conn.execute(f"SELECT {cols} FROM career_sites ORDER BY id")
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows


# ── Save (full replace — see file header) ────────────────────────
def save_career_apps(rows):
    conn = _get_conn()
    _ensure_schema(conn)
    with conn:
        conn.execute("DELETE FROM career_apps")
        placeholders = ",".join(["?"] * len(APP_COLUMNS))
        insert_sql = f"INSERT INTO career_apps ({','.join(APP_COLUMNS)}) VALUES ({placeholders})"
        conn.executemany(insert_sql, [[row.get(c, "") for c in APP_COLUMNS] for row in rows])
    conn.close()


def save_career_sites(rows):
    conn = _get_conn()
    _ensure_schema(conn)
    with conn:
        conn.execute("DELETE FROM career_sites")
        placeholders = ",".join(["?"] * len(SITE_COLUMNS))
        insert_sql = f"INSERT INTO career_sites ({','.join(SITE_COLUMNS)}) VALUES ({placeholders})"
        conn.executemany(insert_sql, [[row.get(c, "") for c in SITE_COLUMNS] for row in rows])
    conn.close()


# ── Routes ────────────────────────────────────────────────────────
@career_api_bp.route("/career-load", methods=["GET"])
def career_load():
    try:
        return jsonify({"apps": load_career_apps(), "sites": load_career_sites()})
    except Exception as e:
        return jsonify({"apps": [], "sites": [], "error": str(e)}), 500


@career_api_bp.route("/career-save", methods=["POST"])
def career_save():
    try:
        payload = request.get_json(force=True, silent=False) or {}
        save_career_apps(payload.get("apps", []))
        save_career_sites(payload.get("sites", []))
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

"""
jobodyssey_store.py — Job Odyssey data layer
Stores every job pulled by Scraper Abyss workflows. One row per unique
(portal, raw_id) pair — this is the same dedup key discussed for the
Deduplication and Patching stage.

STATUS values: scraped | eligible | hold | ineligible | blacklist | applied
VALIDATION values: valid | defect   (set by the Validation stage)
"""

import os
import sqlite3
import datetime


def log_event(source, message):
    """Local, self-contained console logger — this store's own errors
    print straight to this server's console, tagged by source (e.g.
    'JobOdyssey'), same as every call site in this file already passes.
    No shared/external logging module — matches how Career Voyager and
    Profile Nexus each keep their own Activity Log independently
    (in-memory, per tab) rather than funneling through one common file."""
    ts = datetime.datetime.now().strftime('%H:%M:%S')
    print(f'[{ts}] [{source}] {message}')

BASE_DIR = os.path.dirname(os.path.abspath(__file__))  # py/
_ROOT = os.path.dirname(BASE_DIR)                       # py/ -> project root
DB_DIR = os.path.join(_ROOT, 'db')                      # matches career_api.py's convention
JOBS_DB = os.path.join(DB_DIR, 'jobodyssey.db')

JOB_COLUMNS = [
    'id', 'portal', 'raw_id', 'title', 'company', 'location', 'link',
    'description', 'posted_date', 'keyword', 'search_location',
    'status', 'validation', 'created_at', 'updated_at'
]

VALID_STATUSES = ('scraped', 'eligible', 'hold', 'ineligible', 'blacklist', 'applied')


def _get_conn():
    os.makedirs(DB_DIR, exist_ok=True)  # db/ folder, matching career_api.py's convention
    conn = sqlite3.connect(JOBS_DB)
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_schema(conn):
    conn.execute('''
        CREATE TABLE IF NOT EXISTS jobs (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            portal          TEXT,
            raw_id          TEXT,
            title           TEXT,
            company         TEXT,
            location        TEXT,
            link            TEXT,
            description     TEXT,
            posted_date     TEXT,
            keyword         TEXT,
            search_location TEXT,
            status          TEXT DEFAULT 'scraped',
            validation      TEXT DEFAULT 'valid',
            description_full INTEGER DEFAULT 0,
            link_type       TEXT DEFAULT 'unknown',
            is_duplicate    INTEGER DEFAULT 0,
            created_at      TEXT DEFAULT (datetime('now')),
            updated_at      TEXT DEFAULT (datetime('now')),
            UNIQUE(portal, raw_id)
        )
    ''')
    # ALTER for DBs created before these columns existed — ignore if already present
    for stmt in (
        'ALTER TABLE jobs ADD COLUMN description_full INTEGER DEFAULT 0',
        "ALTER TABLE jobs ADD COLUMN link_type TEXT DEFAULT 'unknown'",
        "ALTER TABLE jobs ADD COLUMN is_duplicate INTEGER DEFAULT 0",
    ):
        try:
            conn.execute(stmt)
        except Exception:
            pass
    conn.execute('CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_jobs_portal ON jobs(portal)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_jobs_location ON jobs(location)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_jobs_desc_full ON jobs(description_full)')
    conn.commit()


# ---------------------------------------------------------------------------
# Load (with filters)
# ---------------------------------------------------------------------------
def load_jobs(status=None, status_op='or', portal=None, location=None, search=None, sort='date_desc', validation=None, link_type=None, is_duplicate=None):
    try:
        conn = _get_conn()
        _ensure_schema(conn)
        where = []
        params = []
        # status may be a single string, a comma-separated string, or a
        # list — normalized to a list here so 'or'/'not' both work the
        # same way whichever form the caller passes.
        if status:
            status_list = status if isinstance(status, (list, tuple)) else [s for s in status.split(',') if s]
            if status_list:
                placeholders = ','.join(['?'] * len(status_list))
                if status_op == 'not':
                    where.append('status NOT IN (' + placeholders + ')')
                else:
                    where.append('status IN (' + placeholders + ')')
                params.extend(status_list)
        if portal:
            where.append('portal = ?')
            params.append(portal)
        if location:
            where.append('search_location = ?')
            params.append(location)
        if search:
            where.append('(title LIKE ? OR company LIKE ?)')
            params.append('%' + search + '%')
            params.append('%' + search + '%')
        if validation:
            where.append('validation = ?')
            params.append(validation)
        if is_duplicate is not None:
            where.append('is_duplicate = ?')
            params.append(1 if is_duplicate else 0)
        if link_type:
            if link_type == 'others':
                where.append("(link_type IS NULL OR link_type NOT IN ('internal', 'external'))")
            else:
                where.append('link_type = ?')
                params.append(link_type)

        # description deliberately excluded — can run to ~3,600 chars per
        # job (see descriptor_engine.py), and this query returns every
        # matching row unpaginated (client-side pagination, remember —
        # same reason a separate export endpoint wasn't needed). Shipping
        # full description text for every row on every filter change
        # would balloon the response for no benefit, since only one job's
        # description is ever shown at a time. get_job() below fetches
        # the full row (including description) for just the selected job.
        sql = ('SELECT id, portal, raw_id, title, company, location, link, '
               'posted_date, keyword, search_location, status, validation, '
               'description_full, link_type, is_duplicate, created_at, updated_at '
               'FROM jobs')
        if where:
            sql += ' WHERE ' + ' AND '.join(where)

        order_map = {
            'date_desc':    'posted_date DESC',
            'date_asc':     'posted_date ASC',
            'title_asc':    'title ASC',
            'title_desc':   'title DESC',
            'company_asc':  'company ASC',
            'company_desc': 'company DESC',
        }
        sql += ' ORDER BY ' + order_map.get(sort, 'posted_date DESC')

        cur = conn.execute(sql, params)
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return rows
    except Exception as e:
        log_event('JobOdyssey', 'Load error: ' + str(e)[:80])
        return []


# ---------------------------------------------------------------------------
# Single job (full row, including description) — for the detail panel,
# fetched only for whichever one job is currently selected. Companion to
# load_jobs() above excluding description from the bulk list response.
# NOTE: get_job() already existed further down this file (used elsewhere) —
# reused as-is rather than duplicated; see its definition below.
# ---------------------------------------------------------------------------


def get_stats(portal=None, location=None, search=None, validation=None, link_type=None, is_duplicate=None):
    try:
        conn = _get_conn()
        _ensure_schema(conn)
        where = []
        params = []
        if portal:
            where.append('portal = ?')
            params.append(portal)
        if location:
            where.append('search_location = ?')
            params.append(location)
        if search:
            where.append('(title LIKE ? OR company LIKE ?)')
            params.append('%' + search + '%')
            params.append('%' + search + '%')
        if validation:
            where.append('validation = ?')
            params.append(validation)
        if is_duplicate is not None:
            where.append('is_duplicate = ?')
            params.append(1 if is_duplicate else 0)
        if link_type:
            if link_type == 'others':
                where.append("(link_type IS NULL OR link_type NOT IN ('internal', 'external'))")
            else:
                where.append('link_type = ?')
                params.append(link_type)

        sql = 'SELECT status, COUNT(*) as c FROM jobs'
        if where:
            sql += ' WHERE ' + ' AND '.join(where)
        sql += ' GROUP BY status'

        cur = conn.execute(sql, params)
        counts = {row['status']: row['c'] for row in cur.fetchall()}
        total = sum(counts.values())
        conn.close()
        return {
            'total': total,
            'scraped':    counts.get('scraped', 0),
            'applied':    counts.get('applied', 0),
            'ineligible': counts.get('ineligible', 0),
            'blacklist':  counts.get('blacklist', 0),
            'eligible':   counts.get('eligible', 0),
            'hold':       counts.get('hold', 0),
        }
    except Exception as e:
        log_event('JobOdyssey', 'Stats error: ' + str(e)[:80])
        return {'total': 0, 'scraped': 0, 'applied': 0, 'ineligible': 0, 'blacklist': 0, 'eligible': 0, 'hold': 0}


def get_filter_options():
    """Distinct portal / location values for filter dropdowns."""
    try:
        conn = _get_conn()
        _ensure_schema(conn)
        portals   = [r[0] for r in conn.execute('SELECT DISTINCT portal FROM jobs WHERE portal IS NOT NULL ORDER BY portal')]
        locations = [r[0] for r in conn.execute('SELECT DISTINCT search_location FROM jobs WHERE search_location IS NOT NULL ORDER BY search_location')]
        conn.close()
        return {'portals': portals, 'locations': locations}
    except Exception as e:
        log_event('JobOdyssey', 'Filter options error: ' + str(e)[:80])
        return {'portals': [], 'locations': []}


# ---------------------------------------------------------------------------
# Insert (used by Scraper Abyss transmission stage — dedup on portal+raw_id)
# ---------------------------------------------------------------------------
def insert_jobs(rows):
    """Pure writer — no business logic here. rows: list of dicts with
    portal, raw_id, title, company, location, link, description,
    posted_date, keyword, search_location, validation, link_type,
    status (defaults to 'scraped'), is_duplicate (defaults to 0).
    Both status and is_duplicate are decided upstream by the workflow's
    Blacklist and Deduplication-and-Patching stages before this ever
    runs — Job Odyssey and this store layer only read/display and write
    the label a person explicitly chose via a button, nothing automatic.
    Existing (portal, raw_id) rows are left untouched (ignore-on-conflict)."""
    try:
        conn = _get_conn()
        _ensure_schema(conn)
        cols = ['portal', 'raw_id', 'title', 'company', 'location', 'link',
                'description', 'posted_date', 'keyword', 'search_location', 'validation',
                'link_type', 'status', 'is_duplicate']
        placeholders = ','.join(['?'] * len(cols))
        sql = 'INSERT OR IGNORE INTO jobs (' + ','.join(cols) + ') VALUES (' + placeholders + ')'
        with conn:
            conn.executemany(sql, [
                [r.get(c, 'unknown' if c == 'link_type' else ('scraped' if c == 'status' else (0 if c == 'is_duplicate' else ''))) for c in cols]
                for r in rows
            ])
        conn.close()
        return True
    except Exception as e:
        log_event('JobOdyssey', 'Insert error: ' + str(e)[:80])
        return False


# ---------------------------------------------------------------------------
# Status update (Eligible / Hold / Ineligible / Applied buttons)
# ---------------------------------------------------------------------------
def update_status(job_id, status):
    if status not in VALID_STATUSES:
        return False
    try:
        conn = _get_conn()
        _ensure_schema(conn)
        with conn:
            conn.execute(
                "UPDATE jobs SET status = ?, updated_at = datetime('now') WHERE id = ?",
                (status, job_id)
            )
        conn.close()
        return True
    except Exception as e:
        log_event('JobOdyssey', 'Status update error: ' + str(e)[:80])
        return False


def get_job(job_id):
    try:
        conn = _get_conn()
        _ensure_schema(conn)
        cur = conn.execute('SELECT * FROM jobs WHERE id = ?', (job_id,))
        row = cur.fetchone()
        conn.close()
        return dict(row) if row else None
    except Exception as e:
        log_event('JobOdyssey', 'Get job error: ' + str(e)[:80])
        return None


# ---------------------------------------------------------------------------
# Descriptor engine support — find jobs missing a full description, grouped
# by location (description_full = 0 or NULL both count as "needs enrichment",
# since jobs collected before this column existed have no value at all).
# ---------------------------------------------------------------------------
def get_jobs_needing_description(portal):
    try:
        conn = _get_conn()
        _ensure_schema(conn)
        cur = conn.execute(
            "SELECT * FROM jobs WHERE portal = ? AND (description_full = 0 OR description_full IS NULL) "
            "AND (link_type != 'external' OR link_type IS NULL) AND status != 'ineligible'",
            (portal,)
        )
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return rows
    except Exception as e:
        log_event('JobOdyssey', 'Get jobs needing description error: ' + str(e)[:80])
        return []


def get_description_locations(portal):
    """Distinct locations among jobs still needing a full description —
    used to build one Descriptor stage per location."""
    try:
        conn = _get_conn()
        _ensure_schema(conn)
        cur = conn.execute(
            "SELECT DISTINCT search_location FROM jobs WHERE portal = ? "
            "AND (description_full = 0 OR description_full IS NULL) "
            "AND (link_type != 'external' OR link_type IS NULL) AND status != 'ineligible' "
            "AND search_location IS NOT NULL",
            (portal,)
        )
        locs = [r[0] for r in cur.fetchall()]
        conn.close()
        return locs
    except Exception as e:
        log_event('JobOdyssey', 'Get description locations error: ' + str(e)[:80])
        return []


def update_description(job_id, full_description):
    try:
        conn = _get_conn()
        _ensure_schema(conn)
        with conn:
            conn.execute(
                "UPDATE jobs SET description = ?, description_full = 1, "
                "updated_at = datetime('now') WHERE id = ?",
                (full_description, job_id)
            )
        conn.close()
        return True
    except Exception as e:
        log_event('JobOdyssey', 'Update description error: ' + str(e)[:80])
        return False

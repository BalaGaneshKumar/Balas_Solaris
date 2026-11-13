"""
py/migrate_career_data.py — one-time migration from the OLD Career
Voyager mechanism (dashboard_career.py + career_tracker.py, storing
data in career_tracker.db) into THIS project's own db/career.db
(py/career_api.py).

Both sides are SQLite with the same table/column shapes, so this is a
straight row-for-row copy — original ids are preserved so nothing gets
renumbered.

Usage:
    python3 py/migrate_career_data.py /path/to/career_tracker.db

Safe to re-run: existing rows in db/career.db are cleared first, so
running it twice just re-imports cleanly rather than duplicating rows.
"""

import os
import sys
import sqlite3

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)

from py.career_api import DB_PATH, init_db, APP_FIELDS, SITE_FIELDS  # noqa: E402


def migrate(old_db_path):
    if not os.path.exists(old_db_path):
        print(f"Source file not found: {old_db_path}")
        return False

    init_db()

    old = sqlite3.connect(old_db_path)
    old.row_factory = sqlite3.Row
    new = sqlite3.connect(DB_PATH)

    # Applications
    app_cols = ["id"] + APP_FIELDS
    old_apps = old.execute(f"SELECT {','.join(app_cols)} FROM career_apps ORDER BY id").fetchall()
    with new:
        new.execute("DELETE FROM applications")
        new.executemany(
            f"INSERT INTO applications ({','.join(app_cols)}) VALUES ({','.join('?' for _ in app_cols)})",
            [[row[c] for c in app_cols] for row in old_apps],
        )
    print(f"Migrated {len(old_apps)} applications.")

    # Job sites
    site_cols = ["id"] + SITE_FIELDS
    old_sites = old.execute(f"SELECT {','.join(site_cols)} FROM career_sites ORDER BY id").fetchall()
    with new:
        new.execute("DELETE FROM sites")
        new.executemany(
            f"INSERT INTO sites ({','.join(site_cols)}) VALUES ({','.join('?' for _ in site_cols)})",
            [[row[c] for c in site_cols] for row in old_sites],
        )
    print(f"Migrated {len(old_sites)} job sites.")

    old.close()
    new.close()
    return True


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 py/migrate_career_data.py /path/to/career_tracker.db")
        sys.exit(1)
    ok = migrate(sys.argv[1])
    sys.exit(0 if ok else 1)

"""
py/scraper_activity_log.py — Scraper Abyss Activity Log.

Ported from the source dashboard's dashboard_log.py, scoped down to
just this one tab (the source kept one dict of buckets across several
tabs — 'career'/'profile' — but every OTHER tab in this project already
keeps its own Activity Log independently in-memory/client-side, so a
single flat buffer here matches that same one-store-per-tab convention
instead of reintroducing a shared multi-tab dict).

Unlike the other 3 tabs' logs (js/*_ui.js in-memory only, lost on full
reload), this one is server-backed and file-agnostic — see
py/workflow_store.wf_log() for the SEPARATE per-workflow log files
under logs/{workflow_id}.log. This module is for the live cross-workflow
Activity Log feed (major lifecycle events only: started/completed/
failed/held/etc — never per-cycle noise), the source of which is:
  - server-side: py/workflow_engine.py's _activity() calls add_entry()
  - client-side: any UI action worth recording (tab switch, log panel
    open/close) POSTs to /api/scraper-activity-log, same as the
    source's /api/client-log did for Career/Profile.

In-memory ring buffer, same lifetime as this Python process — resets
on server restart, same as every other tab's log already does.
"""

import time
import threading

_lock = threading.Lock()
_ENTRIES = []
_MAX_ENTRIES = 300  # ring buffer cap, same as source's _MAX_LOGS_PER_TAB


def log_event(source, message):
    """Server-side system log — console only, mirrors jobodyssey_store's
    own log_event() convention (never stored, never shown in-browser)."""
    print('[' + source + '] ' + str(message), flush=True)


def add_entry(source, message):
    """Adds one entry to the live Activity Log — called both by
    workflow_engine.py (server-side lifecycle events) and by the
    /api/scraper-activity-log POST route (client-side UI events)."""
    entry = {
        'ts': time.strftime('%Y-%m-%d %H:%M:%S'),
        'source': str(source),
        'message': str(message),
    }
    with _lock:
        _ENTRIES.append(entry)
        if len(_ENTRIES) > _MAX_ENTRIES:
            del _ENTRIES[: len(_ENTRIES) - _MAX_ENTRIES]
    return entry


def get_entries(limit=200):
    with _lock:
        return list(_ENTRIES[-limit:])

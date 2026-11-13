"""
py/scraper_store.py — Scraper Abyss data layer (Workflows)

In-memory only, no DB — this tab has no persistence yet, same as
Career Voyager's/Profile Nexus's own Activity Logs (in-memory,
per-tab, never funneled through one shared store).

Pipeline stages deliberately mirror the REAL stages
py/jobodyssey_store.py already documents and depends on (see that
file's docstring and its insert_jobs() comment): Scrape -> Validation
-> Blacklist Check -> Deduplication and Patching -> Transmission. This
mock data is written to match that existing story rather than invent
an unrelated pipeline shape — "Adzuna" below is also a real portal
name already present in db/jobodyssey.db, not a made-up one.
"""

PIPELINE_TEMPLATE = ['Scrape', 'Validation', 'Blacklist Check', 'Deduplication and Patching', 'Transmission']

# table_status(): maps this store's actual statuses (running/idle/error)
# onto the richer 6-value vocabulary the Workflows table's status
# filter uses (Waiting/In Progress/Hold/Failed/Cancelled/Completed) —
# matches the pipeline-stage vocabulary already established for the
# detail page's Pipeline section. "Hold"/"Cancelled"/"Waiting" have no
# real example in this mock data yet, but the filter bar still shows
# all 6 options regardless, same as the reference table did.
_TABLE_STATUS = {'running': 'In Progress', 'idle': 'Completed', 'error': 'Failed'}


def table_status(wf):
    return _TABLE_STATUS.get(wf['status'], 'Waiting')


def current_stage(wf):
    """The pipeline stage actually in flight — first non-done stage,
    or the last stage's name if everything's done."""
    for step in wf['pipeline']:
        if step['status'] not in ('done',):
            return step['stage']
    return wf['pipeline'][-1]['stage']


WORKFLOWS = [
    {
        'id': 'wf_adzuna_daily',
        'name': 'Adzuna — Daily Sweep',
        'portal': 'Adzuna',
        'type': 'Scraping',
        'status': 'running',
        'schedule': 'Every day at 03:00 UTC',
        'started': '2026-08-12T03:00:01Z',
        'updated': '2026-08-12T03:06:03Z',
        'description': 'Full daily pull across all tracked keywords and locations for the Adzuna portal.',
        'pipeline': [
            {'stage': 'Scrape', 'status': 'done', 'detail': '1,204 postings pulled'},
            {'stage': 'Validation', 'status': 'done', 'detail': '1,180 valid / 24 defect'},
            {'stage': 'Blacklist Check', 'status': 'done', 'detail': '96 flagged, excluded'},
            {'stage': 'Deduplication and Patching', 'status': 'running', 'detail': 'Deduping against 41,209 existing rows'},
            {'stage': 'Transmission', 'status': 'pending', 'detail': 'Awaiting dedup pass'},
        ],
        'logs': [
            {'ts': '03:00:01', 'level': 'info', 'message': 'Workflow triggered by schedule'},
            {'ts': '03:00:04', 'level': 'info', 'message': 'Scrape stage started — Adzuna, 18 keyword/location pairs'},
            {'ts': '03:04:52', 'level': 'info', 'message': 'Scrape complete — 1,204 postings pulled'},
            {'ts': '03:04:53', 'level': 'info', 'message': 'Validation stage started'},
            {'ts': '03:05:40', 'level': 'warn', 'message': '24 postings marked defect — missing apply link'},
            {'ts': '03:05:41', 'level': 'info', 'message': 'Blacklist Check stage started'},
            {'ts': '03:06:02', 'level': 'warn', 'message': '96 postings excluded — blacklisted company match'},
            {'ts': '03:06:03', 'level': 'info', 'message': 'Deduplication and Patching stage started'},
        ],
    },
    {
        'id': 'wf_adzuna_descriptor',
        'name': 'Adzuna — Descriptor Enrich',
        'portal': 'Adzuna',
        'type': 'Descriptor',
        'status': 'idle',
        'schedule': 'Follows Adzuna — Daily Sweep',
        'started': '2026-08-12T15:45:33Z',
        'updated': '2026-08-12T15:45:45Z',
        'description': 'Enriches postings from Adzuna — Daily Sweep with full descriptions, once that scrape finishes.',
        'pipeline': [
            {'stage': 'Scrape', 'status': 'done', 'detail': '3 location batches enriched'},
            {'stage': 'Validation', 'status': 'done', 'detail': '3/3 valid'},
            {'stage': 'Blacklist Check', 'status': 'done', 'detail': '0 flagged'},
            {'stage': 'Deduplication and Patching', 'status': 'done', 'detail': 'No duplicates'},
            {'stage': 'Transmission', 'status': 'done', 'detail': '3 description(s) written to main DB'},
        ],
        'logs': [
            {'ts': '15:45:33', 'level': 'info', 'message': 'Workflow started'},
            {'ts': '15:45:33', 'level': 'info', 'message': 'Waiting for Adzuna — Daily Sweep to complete before starting'},
            {'ts': '15:45:37', 'level': 'info', 'message': 'Descriptor Chennai: 0 job(s) to enrich'},
            {'ts': '15:45:38', 'level': 'info', 'message': 'Descriptor Coimbatore: 0 job(s) to enrich'},
            {'ts': '15:45:42', 'level': 'info', 'message': 'Descriptor Bangalore: 2 job(s) to enrich'},
            {'ts': '15:45:45', 'level': 'info', 'message': 'Transmission complete — 3 description(s) written to main DB'},
            {'ts': '15:45:45', 'level': 'info', 'message': 'Workflow completed'},
        ],
    },
    {
        'id': 'wf_linkedin_keyword',
        'name': 'LinkedIn — Keyword Watch',
        'portal': 'LinkedIn',
        'type': 'Scraping',
        'status': 'idle',
        'schedule': 'Every 6 hours',
        'started': '2026-08-13T09:00:00Z',
        'updated': '2026-08-13T09:02:31Z',
        'description': 'Targeted scrape for a fixed set of high-priority keywords across LinkedIn.',
        'pipeline': [
            {'stage': 'Scrape', 'status': 'done', 'detail': '312 postings pulled'},
            {'stage': 'Validation', 'status': 'done', 'detail': '298 valid / 14 defect'},
            {'stage': 'Blacklist Check', 'status': 'done', 'detail': '11 flagged, excluded'},
            {'stage': 'Deduplication and Patching', 'status': 'done', 'detail': '203 duplicates skipped, 84 patched'},
            {'stage': 'Transmission', 'status': 'done', 'detail': '0 new rows — fully deduped this run'},
        ],
        'logs': [
            {'ts': '09:00:00', 'level': 'info', 'message': 'Workflow triggered by schedule'},
            {'ts': '09:01:12', 'level': 'info', 'message': 'Scrape complete — 312 postings pulled'},
            {'ts': '09:01:40', 'level': 'info', 'message': 'Validation complete — 298 valid / 14 defect'},
            {'ts': '09:01:55', 'level': 'info', 'message': 'Blacklist Check complete — 11 excluded'},
            {'ts': '09:02:30', 'level': 'info', 'message': 'Dedup complete — 203 duplicates skipped, 84 patched'},
            {'ts': '09:02:31', 'level': 'info', 'message': 'Transmission complete — 0 new rows'},
            {'ts': '09:02:31', 'level': 'info', 'message': 'Workflow finished — idle until next run'},
        ],
    },
    {
        'id': 'wf_naukri_bulk',
        'name': 'Naukri — Bulk Import',
        'portal': 'Naukri',
        'type': 'Scraping',
        'status': 'error',
        'schedule': 'Manual trigger only',
        'started': '2026-08-10T14:12:00Z',
        'updated': '2026-08-10T14:24:05Z',
        'description': 'One-off bulk backfill for older Naukri postings not covered by the standing schedule.',
        'pipeline': [
            {'stage': 'Scrape', 'status': 'done', 'detail': '4,890 postings pulled'},
            {'stage': 'Validation', 'status': 'done', 'detail': '4,701 valid / 189 defect'},
            {'stage': 'Blacklist Check', 'status': 'error', 'detail': 'Blacklist source unreachable (timeout)'},
            {'stage': 'Deduplication and Patching', 'status': 'pending', 'detail': 'Blocked on Blacklist Check'},
            {'stage': 'Transmission', 'status': 'pending', 'detail': 'Blocked on Blacklist Check'},
        ],
        'logs': [
            {'ts': '14:12:00', 'level': 'info', 'message': 'Workflow triggered manually'},
            {'ts': '14:19:44', 'level': 'info', 'message': 'Scrape complete — 4,890 postings pulled'},
            {'ts': '14:21:03', 'level': 'info', 'message': 'Validation complete — 4,701 valid / 189 defect'},
            {'ts': '14:21:05', 'level': 'info', 'message': 'Blacklist Check stage started'},
            {'ts': '14:24:05', 'level': 'error', 'message': 'Blacklist source unreachable — timeout after 180s'},
            {'ts': '14:24:05', 'level': 'error', 'message': 'Workflow halted — manual retry required'},
        ],
    },
]


def get_workflow(workflow_id):
    for wf in WORKFLOWS:
        if wf['id'] == workflow_id:
            return wf
    return None

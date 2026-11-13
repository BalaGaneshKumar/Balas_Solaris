"""
py/workflow_store.py — Scraper Abyss workflow persistence.

Ported from the source dashboard's workflow_store.py. Path layout is
the one change from source (which kept everything BASE_DIR-relative,
i.e. beside the module itself): this project keeps JSON data under a
top-level data/ folder and logs under a top-level logs/ folder, same
level as html/ css/ js/ db/, rather than inside py/ — so:

    source                          -> destination
    workflows/{id}.json             -> data/workflows/{id}.json
    temp/{id}.json                  -> data/temp/{id}.json
    workflow_counter.json           -> data/workflow_counter.json
    logs/{id}.log                   -> logs/{id}.log   (unchanged — was
                                        already its own top-level-ish
                                        folder in source, just now a
                                        sibling of html/css/js/db here)

Generates workflow IDs (WFISCRAD-style) and stage codes, and reads/
writes one workflow.json per workflow under data/workflows/. Per-
workflow raw fetch data lives under data/temp/{workflow_id}.json until
Cleanup removes it. Per-workflow logs live under logs/{workflow_id}.log
(isolated from the live-only Activity Log — see
py/scraper_activity_log.py for that one).
"""

import os
import re
import json
import time
import threading

_PY_DIR       = os.path.dirname(os.path.abspath(__file__))
_ROOT         = os.path.dirname(_PY_DIR)  # py/ -> project root
DATA_DIR      = os.path.join(_ROOT, 'data')
WORKFLOWS_DIR = os.path.join(DATA_DIR, 'workflows')
TEMP_DIR      = os.path.join(DATA_DIR, 'temp')
LOGS_DIR      = os.path.join(_ROOT, 'logs')
COUNTER_FILE  = os.path.join(DATA_DIR, 'workflow_counter.json')

for d in (DATA_DIR, WORKFLOWS_DIR, TEMP_DIR, LOGS_DIR):
    os.makedirs(d, exist_ok=True)

_counter_lock = threading.Lock()

PORTAL_CODES = {'Adzuna': 'AD', 'JSearch': 'JS', 'JobsPipe': 'JP'}

STATUS_ORDER = ['scraped', 'eligible', 'hold', 'ineligible', 'blacklist', 'applied']

# ---------------------------------------------------------------------------
# Workflow ID generation — WFI + SCR + portal + AAA..ZZZ + 0000..9999,
# independent counter per portal, rolling AAA9999 -> AAB0000.
# ---------------------------------------------------------------------------
def _load_counters():
    if not os.path.exists(COUNTER_FILE):
        return {}
    try:
        with open(COUNTER_FILE, 'r') as f:
            return json.load(f)
    except Exception:
        return {}

def _save_counters(counters):
    with open(COUNTER_FILE, 'w') as f:
        json.dump(counters, f, indent=2)

def _increment_alpha(alpha):
    """AAA -> AAB -> ... -> ZZZ (base-26 over 3 letters)."""
    chars = list(alpha)
    i = 2
    while i >= 0:
        if chars[i] != 'Z':
            chars[i] = chr(ord(chars[i]) + 1)
            break
        else:
            chars[i] = 'A'
            i -= 1
    return ''.join(chars)

def _highest_existing_state(prefix):
    """Scans data/workflows/ for files matching WFI<prefix><alpha><num>.json
    and returns the state to resume AFTER the highest one found, or None
    if none exist. Used to self-heal if workflow_counter.json is lost/
    reset — prevents a fresh counter from colliding with workflows
    already on disk."""
    highest = None
    plen = len('WFI' + prefix)
    for fname in os.listdir(WORKFLOWS_DIR):
        if not fname.startswith('WFI' + prefix) or not fname.endswith('.json'):
            continue
        tail = fname[plen:-5]  # strip 'WFI<prefix>' and '.json'
        if len(tail) != 7:
            continue
        alpha, num_str = tail[:3], tail[3:]
        if not (alpha.isalpha() and num_str.isdigit()):
            continue
        key = (alpha, int(num_str))
        if highest is None or key > highest:
            highest = key
    if highest is None:
        return None
    alpha, num = highest
    if num >= 9999:
        return {'alpha': _increment_alpha(alpha), 'num': 0}
    return {'alpha': alpha, 'num': num + 1}


def next_workflow_id(portal, type_code='SCR'):
    portal_code = PORTAL_CODES.get(portal, portal[:2].upper())
    counter_key = type_code + portal_code
    with _counter_lock:
        counters = _load_counters()
        state = counters.get(counter_key)
        if state is None:
            # Counter has no record for this key — could be genuinely new,
            # or the counter file was lost/reset. Check disk before
            # defaulting to AAA0000 to avoid colliding with old workflows.
            state = _highest_existing_state(counter_key) or {'alpha': 'AAA', 'num': 0}
        alpha, num = state['alpha'], state['num']
        workflow_id = 'WFI' + type_code + portal_code + alpha + str(num).zfill(4)

        # Final safety net: even after the self-heal above, never hand out
        # an ID that's already sitting on disk — keep advancing until free.
        while os.path.exists(_wf_path(workflow_id)):
            if num >= 9999:
                alpha, num = _increment_alpha(alpha), 0
            else:
                num += 1
            workflow_id = 'WFI' + type_code + portal_code + alpha + str(num).zfill(4)

        if num >= 9999:
            state = {'alpha': _increment_alpha(alpha), 'num': 0}
        else:
            state = {'alpha': alpha, 'num': num + 1}
        counters[counter_key] = state
        _save_counters(counters)
    return workflow_id


# ---------------------------------------------------------------------------
# Stage code — <PORTAL>0<KW_CODE>0<LOC_CODE>
# ---------------------------------------------------------------------------
def _alnum_words(text, max_words=3):
    words = re.split(r'\s+', text.strip())
    cleaned = []
    for w in words[:max_words]:
        alnum = re.sub(r'[^A-Za-z0-9]', '', w)
        cleaned.append(alnum)
    return cleaned

def keyword_code(keyword):
    words = _alnum_words(keyword, 3)
    parts = []
    for w in words:
        if len(w) >= 2:
            parts.append(w[:2].upper())
        elif len(w) == 1:
            parts.append(w.upper() + '0')
        else:
            parts.append('00')
    while len(parts) < 3:
        parts.append('00')
    return ''.join(parts)

def location_code(location):
    words = re.split(r'\s+', location.strip())
    first_alnum = re.sub(r'[^A-Za-z0-9]', '', words[0]) if words else ''
    last_alnum  = re.sub(r'[^A-Za-z0-9]', '', words[-1]) if words else ''
    head = first_alnum[:2].upper()
    tail = last_alnum[-1:].upper() if last_alnum else '0'
    return (head + tail)[:3].ljust(3, '0')

def stage_code(portal, keyword, location):
    portal_code = PORTAL_CODES.get(portal, portal[:2].upper())
    return portal_code + '0' + keyword_code(keyword) + '0' + location_code(location)

def descriptor_stage_code(portal, location):
    """DCR + portal_code + location_code, e.g. DCRADCOE for Adzuna/Coimbatore.
    Auto-extends to any new location via the same 3-char location_code rule."""
    portal_code = PORTAL_CODES.get(portal, portal[:2].upper())
    return 'DCR' + portal_code + location_code(location)


# ---------------------------------------------------------------------------
# Cycle count — how many API calls to split a keyword+location fetch into,
# splitting the total as evenly as possible (e.g. 52 -> 26+26, not 50+2).
# ---------------------------------------------------------------------------
def compute_cycles(total_count):
    if total_count > 200:
        n = 8
    elif total_count > 100:
        n = 4
    elif total_count > 50:
        n = 2
    else:
        n = 1
    base = total_count // n
    remainder = total_count % n
    sizes = [base + (1 if i < remainder else 0) for i in range(n)]
    return sizes  # e.g. [26, 26]


# ---------------------------------------------------------------------------
# workflow.json read/write
# ---------------------------------------------------------------------------
def _wf_path(workflow_id):
    return os.path.join(WORKFLOWS_DIR, workflow_id + '.json')

def save_workflow(data):
    data['updated_at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ')
    with open(_wf_path(data['workflow_id']), 'w') as f:
        json.dump(data, f, indent=2)

def load_workflow(workflow_id):
    path = _wf_path(workflow_id)
    if not os.path.exists(path):
        return None
    try:
        with open(path, 'r') as f:
            return json.load(f)
    except Exception:
        return None

def list_workflows():
    out = []
    for fname in os.listdir(WORKFLOWS_DIR):
        if fname.endswith('.json'):
            try:
                with open(os.path.join(WORKFLOWS_DIR, fname), 'r') as f:
                    d = json.load(f)
                stages = d.get('stages', [])
                idx = d.get('current_stage_index', 0)
                cur_stage = stages[idx] if idx < len(stages) else (stages[-1] if stages else {})
                if cur_stage.get('type') in ('fetch', 'descriptor'):
                    stage_label = 'Stage ' + cur_stage.get('stage_code', '')
                else:
                    stage_label = cur_stage.get('name', '')
                out.append({
                    'workflow_id': d.get('workflow_id'),
                    'status': d.get('status'),
                    'portal': d.get('portal'),
                    'type': 'Descriptor' if d.get('kind') == 'descriptor' else 'Scraping',
                    'stage': stage_label,
                    'started_at': d.get('started_at'),
                    'updated_at': d.get('updated_at'),
                    'created_at': d.get('created_at', ''),
                })
            except Exception:
                continue
    out.sort(key=lambda w: w.get('created_at', ''), reverse=True)
    return out


# ---------------------------------------------------------------------------
# Temp file (per workflow, holds raw fetched job dicts until Cleanup)
# ---------------------------------------------------------------------------
def _temp_path(workflow_id):
    return os.path.join(TEMP_DIR, workflow_id + '.json')

def temp_append(workflow_id, jobs):
    path = _temp_path(workflow_id)
    existing = []
    if os.path.exists(path):
        try:
            with open(path, 'r') as f:
                existing = json.load(f)
        except Exception:
            existing = []
    existing.extend(jobs)
    with open(path, 'w') as f:
        json.dump(existing, f, indent=2)

def temp_load(workflow_id):
    path = _temp_path(workflow_id)
    if not os.path.exists(path):
        return []
    try:
        with open(path, 'r') as f:
            return json.load(f)
    except Exception:
        return []

def temp_save(workflow_id, jobs):
    with open(_temp_path(workflow_id), 'w') as f:
        json.dump(jobs, f, indent=2)

def temp_cleanup(workflow_id):
    path = _temp_path(workflow_id)
    if os.path.exists(path):
        os.remove(path)


# ---------------------------------------------------------------------------
# Per-workflow log file — isolated from the live-only Activity Log
# ---------------------------------------------------------------------------
def wf_log(workflow_id, message):
    entry = {'ts': time.strftime('%Y-%m-%d %H:%M:%S'), 'workflow_id': workflow_id, 'message': message}
    path = os.path.join(LOGS_DIR, workflow_id + '.log')
    with open(path, 'a') as f:
        f.write(json.dumps(entry) + '\n')
    return entry

def wf_get_logs(workflow_id, search=None):
    path = os.path.join(LOGS_DIR, workflow_id + '.log')
    if not os.path.exists(path):
        return []
    entries = []
    with open(path, 'r') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
                if search and search.lower() not in json.dumps(e).lower():
                    continue
                entries.append(e)
            except Exception:
                continue
    return entries


# ---------------------------------------------------------------------------
# Create workflow — builds the stage list from keywords x locations
# ---------------------------------------------------------------------------
def create_workflow(portal, keywords, locations, blacklist=None, depends_on=None):
    blacklist = blacklist or []
    workflow_id = next_workflow_id(portal)
    stages = [{'name': 'Create order', 'status': 'not_started'}]

    fetch_index = 1
    for kw in keywords:
        for loc in locations:
            stages.append({
                'name': 'Fetching ' + str(fetch_index),
                'type': 'fetch',
                'keyword': kw,
                'location': loc,
                'stage_code': stage_code(portal, kw, loc),
                'status': 'not_started',
                'cycles_total': None,
                'cycles_done': 0,
            })
            fetch_index += 1

    stages.append({'name': 'Validation', 'status': 'not_started'})
    stages.append({'name': 'Blacklist', 'status': 'not_started'})
    stages.append({'name': 'Deduplication and Patching', 'status': 'not_started'})
    stages.append({'name': 'Transmission', 'status': 'not_started'})
    stages.append({'name': 'Cleanup', 'status': 'not_started'})
    stages.append({'name': 'Completed', 'status': 'not_started'})

    data = {
        'workflow_id': workflow_id,
        'kind': 'scraper',
        'portal': portal,
        'keywords': keywords,
        'locations': locations,
        'blacklist': blacklist,
        'depends_on': depends_on,
        'status': 'waiting',
        'current_stage_index': 0,
        'stages': stages,
        'created_at': time.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'started_at': None,
        'updated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ'),
    }
    save_workflow(data)
    wf_log(workflow_id, 'Workflow created — ' + str(len(keywords)) + ' keyword(s) x ' +
           str(len(locations)) + ' location(s) = ' + str(fetch_index - 1) + ' fetch stage(s)' +
           (', blacklist: ' + ', '.join(blacklist) if blacklist else '') +
           (' — waiting for ' + depends_on + ' to complete' if depends_on else ''))
    return workflow_id


def create_descriptor_workflow(portal, locations, depends_on=None):
    """Descriptor workflow: Create order (collects jobs missing a full
    description into a temp file) -> Descriptor <location> per location
    -> Transmission -> Cleanup -> Completed. No Validation/Dedup stages —
    it's enriching existing rows, not fetching new ones.
    `depends_on`: if a Scraper workflow is running in the same request,
    this workflow waits for it to complete before starting."""
    workflow_id = next_workflow_id(portal, type_code='DCR')
    stages = [{'name': 'Create order', 'status': 'not_started'}]

    for loc in locations:
        stages.append({
            'name': 'Descriptor ' + loc,
            'type': 'descriptor',
            'location': loc,
            'stage_code': descriptor_stage_code(portal, loc),
            'status': 'not_started',
            'jobs_done': 0,
            'jobs_total': None,
        })

    stages.append({'name': 'Transmission', 'status': 'not_started'})
    stages.append({'name': 'Cleanup', 'status': 'not_started'})
    stages.append({'name': 'Completed', 'status': 'not_started'})

    data = {
        'workflow_id': workflow_id,
        'kind': 'descriptor',
        'portal': portal,
        'keywords': [],
        'locations': locations,
        'depends_on': depends_on,
        'status': 'waiting',
        'current_stage_index': 0,
        'stages': stages,
        'created_at': time.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'started_at': None,
        'updated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ'),
    }
    save_workflow(data)
    wf_log(workflow_id, 'Descriptor workflow created — ' + str(len(locations)) + ' location(s)' +
           (' — waiting for ' + depends_on + ' to complete' if depends_on else ''))
    return workflow_id

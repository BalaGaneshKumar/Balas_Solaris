"""
py/jsearch.py — live JSearch (RapidAPI) client (renamed from the source
project's real_jsearch.py, matching py/adzuna.py's same renaming —
this project doesn't keep a separate mock module alongside it).

Confirmed live against the /search-v2 endpoint during testing — the
older /search endpoint returns 404, it was deprecated on RapidAPI's
side. Auth is header-based (X-RapidAPI-Key), not URL params like Adzuna.
Cursor-paginated, not page-numbered — pass back the cursor from the
previous response's data.cursor to get the next page; None/empty means
no more results.

Timeout is 59s, not the usual 15s — search-v2 does live aggregation
under the hood (not a pre-indexed lookup like Adzuna), and real testing
showed successful calls already taking up to 12s. A tight timeout was
killing entire workflows over normal latency variance, not real
failures. A timeout gets exactly ONE retry at the same 59s limit, then
fails — if the vendor is genuinely this slow twice in a row, retrying
further just burns quota for no benefit.

Transient 5xx errors are retried with backoff (unchanged, same pattern
as py/adzuna.py). 4xx errors (bad key, bad query) are not retried,
since those won't fix themselves.
"""

import re
import time
import requests
from py.jsearch_config import JSEARCH_API_KEY

URL = 'https://jsearch.p.rapidapi.com/search-v2'

REQUEST_TIMEOUT = 59
MAX_TIMEOUT_RETRIES = 1  # one retry on a slow/no response, then fail — not a backoff loop
MAX_RETRIES = 3           # for 5xx errors specifically
RETRY_DELAY_SECONDS = 5   # doubles each retry: 5s, 10s, 20s


class JSearchQuotaExceeded(RuntimeError):
    """Raised specifically when RapidAPI returns 429 for this subscription
    — i.e. the monthly call quota is used up, not a transient failure.
    Kept distinct from the generic RuntimeError other 4xx/5xx errors raise
    so callers (workflow_engine) can choose to gracefully stop remaining
    JSearch fetch work instead of failing the whole workflow outright."""
    pass


def _redact(message):
    return re.sub(r'(key["\']?\s*[:=]\s*["\']?)[\w-]+', r'\1***', message, flags=re.IGNORECASE)


def real_search(query, country='in', cursor=None):
    headers = {
        'X-RapidAPI-Key': JSEARCH_API_KEY,
        'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
    }
    params = {'query': query, 'country': country}
    if cursor:
        params['cursor'] = cursor

    last_error = None
    delay = RETRY_DELAY_SECONDS
    timeout_retries_used = 0
    attempt = 1

    while True:
        try:
            response = requests.get(URL, headers=headers, params=params, timeout=REQUEST_TIMEOUT)
            response.raise_for_status()
            data = response.json()
            # RapidAPI returns quota info as headers on every response —
            # free to read, no extra API call. Guarded with .get() so a
            # missing/renamed header just means no quota info this call,
            # never a crash.
            limit = response.headers.get('X-RateLimit-Requests-Limit')
            remaining = response.headers.get('X-RateLimit-Requests-Remaining')
            if limit is not None and remaining is not None:
                data['_quota'] = {'limit': limit, 'remaining': remaining}
            return data
        except requests.exceptions.Timeout as e:
            last_error = e
            if timeout_retries_used < MAX_TIMEOUT_RETRIES:
                timeout_retries_used += 1
                continue  # one immediate retry, same 59s timeout, no backoff delay
            raise RuntimeError('JSearch API request timed out after ' + str(REQUEST_TIMEOUT) +
                                's (retried once, still no response): ' + _redact(str(e)))
        except requests.exceptions.HTTPError as e:
            status = e.response.status_code if e.response is not None else None
            last_error = e
            if status == 429:
                raise JSearchQuotaExceeded(
                    'JSearch monthly quota exceeded (HTTP 429 Too Many Requests): ' + _redact(str(e))
                )
            if status is not None and 500 <= status < 600 and attempt < MAX_RETRIES:
                time.sleep(delay)
                delay *= 2
                attempt += 1
                continue
            raise RuntimeError('JSearch API request failed (' + type(e).__name__ + '): ' + _redact(str(e)))
        except requests.exceptions.RequestException as e:
            raise RuntimeError('JSearch API request failed (' + type(e).__name__ + '): ' + _redact(str(e)))

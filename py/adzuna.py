"""
py/adzuna.py — live Adzuna API client (renamed from the source project's
real_adzuna.py — same content, this project just doesn't keep a
separate mock module alongside it, so the plain "adzuna" name is
unambiguous here).

Credentials come from .env via adzuna_config — never logged, and any
error message is scrubbed of app_id/app_key before it can propagate up
into workflow logs. Transient 5xx errors (Adzuna's own server hiccups,
e.g. 503) are retried automatically with backoff before giving up —
4xx errors are not retried since those won't fix themselves.
"""

import re
import time
import requests
from py.adzuna_config import ADZUNA_APP_ID, ADZUNA_APP_KEY

BASE_URL = "https://api.adzuna.com/v1/api/jobs/in/search/{page}"

MAX_RETRIES = 3
RETRY_DELAY_SECONDS = 5  # doubles each retry: 5s, 10s, 20s


def _redact(message):
    message = re.sub(r'app_id=[^&\s]+', 'app_id=***', message)
    message = re.sub(r'app_key=[^&\s]+', 'app_key=***', message)
    return message


def real_search(what, where, page=1, results_per_page=20):
    url = BASE_URL.format(page=page)
    params = {
        "app_id": ADZUNA_APP_ID,
        "app_key": ADZUNA_APP_KEY,
        "results_per_page": min(results_per_page, 50),  # Adzuna's documented max per page
        "what": what,
        "where": where,
        "content-type": "application/json",
    }

    last_error = None
    delay = RETRY_DELAY_SECONDS
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = requests.get(url, params=params, timeout=15)
            response.raise_for_status()
            return response.json()
        except requests.exceptions.HTTPError as e:
            status = e.response.status_code if e.response is not None else None
            last_error = e
            if status is not None and 500 <= status < 600 and attempt < MAX_RETRIES:
                time.sleep(delay)
                delay *= 2
                continue
            raise RuntimeError('Adzuna API request failed (' + type(e).__name__ + '): ' + _redact(str(e)))
        except requests.exceptions.RequestException as e:
            raise RuntimeError('Adzuna API request failed (' + type(e).__name__ + '): ' + _redact(str(e)))

    raise RuntimeError('Adzuna API request failed after ' + str(MAX_RETRIES) +
                        ' attempts (' + type(last_error).__name__ + '): ' + _redact(str(last_error)))

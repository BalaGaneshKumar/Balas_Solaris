"""
py/descriptor_engine.py — Descriptor scraper (ported from source as-is —
no filesystem paths, no changes needed).

Visits a job's redirect_url (Adzuna's own hosted listing page, confirmed
to return plain HTML with no bot-blocking) and extracts the FULL,
untruncated job description from the page's embedded JSON-LD structured
data (schema.org JobPosting block) — verified against a real listing to
contain the complete HTML-formatted description (~3600 chars), unlike
both the search API's snippet and the og:description meta tag, which are
both truncated to a short preview.
"""

import re
import json
import time
import html as html_module
import requests

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
}

_UNAVAILABLE_RE = re.compile(r'this job is no longer available', re.IGNORECASE)


def classify_link(link):
    """Adzuna redirect_url comes in two flavors:
    - /details/{id} — Adzuna's own hosted page (may have full JobPosting
      JSON-LD, a plain-HTML fallback description, or a 'no longer
      available' notice if the listing expired) -> 'internal'
    - /land/ad/{id} — a direct redirect straight to the original external
      job board, which always hits bot detection and can't be scraped
      -> 'external', skipped entirely, no point spending a request on it
    """
    if not link:
        return 'unknown'
    if '/details/' in link:
        return 'internal'
    if '/land/ad/' in link:
        return 'external'
    return 'unknown'


def is_job_unavailable(html):
    """True if the page shows Adzuna's 'this job is no longer available'
    notice — happens for expired /details/ listings with no JSON-LD."""
    return bool(_UNAVAILABLE_RE.search(html))

_JSONLD_RE = re.compile(
    r'<script type="application/ld\+json">(.*?)</script>',
    re.DOTALL
)


def _html_to_text(html):
    """Converts a description HTML block into readable plain text —
    keeps paragraph breaks and bullet points, strips remaining tags."""
    html = re.sub(r'<li[^>]*>', '\n* ', html)
    html = re.sub(r'<br\s*/?>', '\n', html)
    html = re.sub(r'</p>', '\n\n', html)
    html = re.sub(r'<p[^>]*>', '', html)
    html = re.sub(r'<h[1-6][^>]*>(.*?)</h[1-6]>', r'\n\1\n', html, flags=re.DOTALL)
    html = re.sub(r'<strong[^>]*>(.*?)</strong>', r'\1', html, flags=re.DOTALL)
    html = re.sub(r'<[^>]+>', '', html)  # strip any remaining tags
    html = html_module.unescape(html)
    lines = [line.strip() for line in html.splitlines()]
    text = '\n'.join(line for line in lines if line)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


def _find_jobposting_description(html):
    """Scans all JSON-LD <script> blocks on the page for a JobPosting
    entry (some pages have multiple blocks, e.g. BreadcrumbList + JobPosting,
    and some wrap the JobPosting in a list rather than a bare object)."""
    for block in _JSONLD_RE.findall(html):
        try:
            data = json.loads(block)
        except (json.JSONDecodeError, ValueError):
            continue
        items = data if isinstance(data, list) else [data]
        for item in items:
            if isinstance(item, dict) and item.get('@type') == 'JobPosting' and item.get('description'):
                return item['description']
    return None


_ADP_BODY_RE = re.compile(
    r'<section[^>]*class="[^"]*adp-body[^"]*"[^>]*>(.*?)</section>',
    re.DOTALL | re.IGNORECASE
)


def fetch_full_description(url, timeout=15, delay=1.0):
    """Fetches one job's page and returns (full_text, fail_reason, is_unavailable).
    full_text is None on any failure, with fail_reason explaining why.
    is_unavailable is True when the page shows Adzuna's 'this job is no
    longer available' notice, or the site answers HTTP 410 Gone (caller
    should mark the job ineligible rather than keep retrying it).
    `delay`: politeness pause before the request (avoid hammering the site)."""
    if delay:
        time.sleep(delay)
    try:
        response = requests.get(url, headers=HEADERS, timeout=timeout)
    except requests.exceptions.RequestException as e:
        return None, 'connection failed: ' + type(e).__name__, False

    # HTTP 410 Gone means the site has permanently removed this listing, so
    # retrying will never succeed — treat it as unavailable (the caller marks
    # the job ineligible) instead of skipping it and trying again next run.
    if response.status_code == 410:
        return None, 'HTTP 410 Gone — listing permanently removed', True

    # Don't discard the body just because the status code is non-200 —
    # Adzuna may return a 404/410 for expired listings while still
    # including the friendly "no longer available" message in the HTML.
    if response.text and is_job_unavailable(response.text):
        return None, 'job listing expired — no longer available (HTTP ' + str(response.status_code) + ')', True

    if response.status_code != 200:
        return None, 'HTTP ' + str(response.status_code) + ' ' + (response.reason or ''), False

    if is_job_unavailable(response.text):
        return None, 'job listing expired — no longer available', True

    raw_html_desc = _find_jobposting_description(response.text)
    if not raw_html_desc:
        # Fallback: some legitimate active listings simply don't have
        # JobPosting JSON-LD — try the plain visible description section.
        match = _ADP_BODY_RE.search(response.text)
        if match:
            raw_html_desc = match.group(1)

    if not raw_html_desc:
        return None, 'description not found in page via JSON-LD or fallback (page fetched OK, ' + str(len(response.text)) + ' bytes)', False

    text = _html_to_text(raw_html_desc)
    if not text:
        return None, 'description found but produced empty text after cleanup', False
    return text, None, False

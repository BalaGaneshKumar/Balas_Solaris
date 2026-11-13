# Bala's Solaris

A personal job-search command center, themed as a solar system. Pull jobs from job-board APIs, triage them, track your applications and keep one reusable profile, all running locally on your own machine.

> **Phase 3 of the Job Hunter Agent project**, designed by Bala. This repo follows [Phase 1](https://github.com/BalaGaneshKumar/Job-Hunter-Agent-Phase-1) and [Phase 2](https://github.com/BalaGaneshKumar/Job-Hunter-Agent-Phase-2).

## The three phases

| Phase | Repo | What it is | Status |
|---|---|---|---|
| 1 | [Job-Hunter-Agent-Phase-1](https://github.com/BalaGaneshKumar/Job-Hunter-Agent-Phase-1) | Selenium-based scraper for Naukri, LinkedIn and Indeed, with a local dashboard and an application tracker | Archived. The portals' terms prohibit automated scraping, and CSV/XLSX storage did not scale |
| 2 | [Job-Hunter-Agent-Phase-2](https://github.com/BalaGaneshKumar/Job-Hunter-Agent-Phase-2) | A rebuild on job-board APIs (Adzuna, JSearch, JobsPipe) and SQLite storage | Completed |
| 3 | This repo | Bala's Solaris: a single-page Flask application, version 1.0.0 as the baseline | In progress |

## What it does

The home screen shows a sun on a starfield. Clicking the sun powers the app on, and each feature is a planet you navigate to from there. Every screen is swapped into one persistent page, so navigating never reloads it.

- **Career Voyager** is the application tracker. *Applications* lists every job you applied to, and you add, edit and delete directly with no separate save step. *Job Sites* keeps the boards you use for quick reference.
- **Job Odyssey** is the database of every job fetched so far. You can filter and sort by status, portal, location, search text and validation state. Jobs move from scraped to eligible, hold, ineligible or blacklist, and then to applied. Duplicate listings are detected automatically, jobs are blacklisted by title keyword, and any filtered view can be exported to CSV or XLSX.
- **Profile Nexus** holds your profile in nine sections: Personal, Education, Experience, Work History, EEO, Work Authorization, India-specific details, Social links and Skills. It all saves to one profile record.
- **Scraper Abyss** is where new jobs come in. In *Beacon* you pick an engine (Scraper or Descriptor), a portal, keywords, locations and a blacklist filter, then start a background workflow. *Hyperlane* shows every workflow run as a live table with its stages and Hold, Cancel, Retry and Revoke controls.
- **Terminus** shuts the server down cleanly from the browser.

Every tab has its own Activity Log, and every data table exports through one shared mechanism.

## Job sources

| Portal | Free tier |
|---|---|
| Adzuna | n/a |
| JSearch (via RapidAPI) | 200 calls a month |
| JobsPipe | 1,000 jobs a month |

## Requirements

- Windows (tested on Windows 10)
- Python (tested on 3.14.5)
- Flask, requests and openpyxl, pinned in `requirements.txt`

## Setup

1. Clone the repo and open it in a terminal.
2. Install the dependencies:
   ```
   pip install -r requirements.txt
   ```
3. Copy the key template and fill in your own keys:
   ```
   copy vault\env.example vault\.env
   ```
   The file takes one `NAME=value` per line, no quotes, for `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`, `JSEARCH_API_KEY` and `JOBSPIPE_API_KEY`.
4. Start the server:
   ```
   python solaris.py
   ```
5. Open `http://localhost:8090/solaris` and click the sun.

The app starts without keys. A workflow that needs a missing key fails when you run it.

## Project layout

```
solaris.py     Flask server and routes
py/            API clients, workflow engine, stores, per-tab APIs
js/  css/      Front-end scripts and styles
html/          Page shell and the fragments swapped into it
Assets/        Images and static files
vault/         env.example (the template); your real .env stays here, never committed
```

## Data stays local

Nothing personal is in this repo. These are created on your machine when the app runs, and they are not in version control:

| Path | Contents |
|---|---|
| `vault/.env` | Your API keys |
| `db/` | SQLite databases (`career.db`, `jobodyssey.db`) |
| `data/` | `profile.json`, workflow state, temp files |
| `logs/` | Per-run workflow logs |

No data leaves your machine except the calls Scraper Abyss makes to the job-board APIs.

## Status

Version 1.0.0 is the baseline release.

"""
py/jobspipe_config.py — loads the JobsPipe API key from vault/.env (the
`vault` folder at the project root; never hardcoded here, never
logged). Add the vault folder to .gitignore before committing this repo.

Ported directly from the source dashboard's jobspipe_config.py — only
the .env location changed, matching py/adzuna_config.py's/
py/jsearch_config.py's same adjustment.
"""

import os

_PY_DIR = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_PY_DIR)  # py/ -> project root
ENV_PATH = os.path.join(_ROOT, 'vault', '.env')   # <project root>/vault/.env


def _load_env(path):
    if not os.path.exists(path):
        return
    with open(path, 'r') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            os.environ[key.strip()] = value.strip()


_load_env(ENV_PATH)

JOBSPIPE_API_KEY = os.environ.get('JOBSPIPE_API_KEY', '')

if not JOBSPIPE_API_KEY:
    print('[jobspipe_config] WARNING: JOBSPIPE_API_KEY missing — check .env at', ENV_PATH)
else:
    print('[jobspipe_config] Loaded credentials OK (key ends with ...' + JOBSPIPE_API_KEY[-4:] + ')')

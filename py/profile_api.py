"""
py/profile_api.py — Flask blueprint for the Profile Nexus tab's
save/load endpoints.

Registered in solaris.py the same way career_api_bp is:
    from py.profile_api import profile_api_bp
    app.register_blueprint(profile_api_bp, url_prefix=BASE + "/api")

Routes (relative to that prefix, so BASE + "/api" + the paths below):
    GET  /profile-data   -> current saved profile (or {} if none saved yet)
    POST /save-profile   -> body is the full profile object; overwrites
                             data/profile.json

Data lives in data/profile.json — a new top-level folder for this file
type (JSON), same convention as css/, js/, html/, py/, Assets/ each
holding their own format.

No logging here on purpose — Activity Log in the Profile Nexus UI is
in-memory only (js/profile_nexus_ui.js), nothing gets written to disk
for it.
"""

from flask import Blueprint, jsonify, request
import os
import json

profile_api_bp = Blueprint("profile_api", __name__)

_PY_DIR = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_PY_DIR)  # py/ -> project root
DATA_DIR = os.path.join(_ROOT, "data")
PROFILE_PATH = os.path.join(DATA_DIR, "profile.json")


@profile_api_bp.route("/profile-data", methods=["GET"])
def get_profile_data():
    """Returns the saved profile from data/profile.json, or {} if
    nothing has been saved yet."""
    try:
        with open(PROFILE_PATH, "r", encoding="utf-8") as f:
            return jsonify(json.load(f))
    except (FileNotFoundError, json.JSONDecodeError):
        return jsonify({})


@profile_api_bp.route("/save-profile", methods=["POST"])
def save_profile_data():
    """Overwrites data/profile.json with the posted profile object."""
    try:
        payload = request.get_json(force=True, silent=False)
        if not isinstance(payload, dict):
            return jsonify({"ok": False, "error": "Invalid payload"}), 400
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(PROFILE_PATH, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

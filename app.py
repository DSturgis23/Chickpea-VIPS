"""
Chickpea VIP Tagger — mobile web app for marking SevenRooms guests as VIP
without logging into SevenRooms.

How SevenRooms tagging works (verified 9 Oct 2026, docs are login-gated):
  - Search:  GET  /clients?venue_group_id=...&name=<partial name>  (or email=)
  - Update:  POST /clients/{id}  form data  add_tags / remove_tags = "<Category>:<Tag>"
  - Wrong tag formats still return 200 but do nothing, so every change is
    re-read from SevenRooms and only reported as done if the tag really moved.

Config (environment variables — never commit these):
  SR_CLIENT_ID, SR_CLIENT_SECRET   SevenRooms API key
  APP_PIN                          PIN to open the app
  SECRET_KEY                       random string for signing the login cookie
  VIP_TAGS                         comma-separated tags in the category (default "VIP")
"""
import os
import time
import logging
import secrets
from concurrent.futures import ThreadPoolExecutor
from functools import wraps

import requests
from flask import Flask, jsonify, redirect, render_template, request, session, url_for

SR_BASE = "https://api.sevenrooms.com/2_4"
VENUE_GROUP_ID = "ahNzfnNldmVucm9vbXMtc2VjdXJlciELEhRuaWdodGxvb3BfVmVudWVHcm91cBiAgIXEovSaCQw"
TAG_CATEGORY = "VIP client type"
ASSET_VERSION = "2"  # bump when CSS/JS change so installed apps pick up the new files
VIP_TAGS = [t.strip() for t in os.environ.get("VIP_TAGS", "VIP").split(",") if t.strip()]

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax",
                  SESSION_COOKIE_SECURE=os.environ.get("RENDER") is not None,
                  PERMANENT_SESSION_LIFETIME=60 * 60 * 24 * 90)  # stay logged in on his phone
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("vip")

# ── SevenRooms ────────────────────────────────────────────────────────────────
_token = {"value": None, "at": 0.0}
_venues = {"names": None, "at": 0.0}


def _sr_token(force=False):
    if force or not _token["value"] or time.time() - _token["at"] > 30 * 60:
        r = requests.post(f"{SR_BASE}/auth", timeout=30, data={
            "client_id": os.environ["SR_CLIENT_ID"],
            "client_secret": os.environ["SR_CLIENT_SECRET"]})
        r.raise_for_status()
        _token.update(value=r.json()["data"]["token"], at=time.time())
    return _token["value"]


def sr(method, path, **kw):
    for attempt in (0, 1):
        r = requests.request(method, SR_BASE + path, timeout=30,
                             headers={"Authorization": _sr_token(force=attempt == 1)}, **kw)
        if r.status_code != 401:
            return r
    return r


def venue_names():
    if not _venues["names"] or time.time() - _venues["at"] > 6 * 3600:
        res = sr("GET", "/venues").json()["data"]["results"]
        _venues.update(names={v["id"]: v["name"].strip() for v in res}, at=time.time())
    return _venues["names"]


def _fresh_client(c):
    try:
        r = sr("GET", f"/clients/{c['id']}")
        if r.ok and r.json().get("data"):
            return r.json()["data"]
    except requests.RequestException:
        pass
    return c


def _mask_email(email):
    if not email or "@" not in email:
        return ""
    user, domain = email.split("@", 1)
    return f"{user[:2]}{'•' * max(len(user) - 2, 1)}@{domain}"


def summarise(c):
    """Cut a SevenRooms client down to what's needed to pick the right profile."""
    names = venue_names()
    last_date, last_venue = "", ""
    fav_venue, fav_visits, pubs = "", 0, 0
    for vid, s in (c.get("venue_stats") or {}).items():
        venue = names.get(s.get("venue_id") or vid, "")
        d = (s.get("last_visit_date") or "")[:10]
        if d > last_date:
            last_date, last_venue = d, venue
        v = s.get("total_visits") or 0
        pubs += v > 0
        if v > fav_visits:
            fav_venue, fav_visits = venue, v
    phone = (c.get("phone_number") or "").replace(" ", "")
    return {
        "id": c["id"],
        "name": f"{(c.get('first_name') or '').strip()} {(c.get('last_name') or '').strip()}".strip().title(),
        "email": _mask_email(c.get("email")),
        "phone": f"•••{phone[-4:]}" if len(phone) >= 4 else "",
        "visits": c.get("total_visits") or 0,
        "covers": c.get("total_covers") or 0,
        "spend": round(c.get("total_spend") or 0),
        "pubs": pubs,
        "fav_venue": fav_venue if pubs > 1 else "",
        "last_visit": last_date,
        "last_venue": last_venue,
        "tags": sorted({t["tag_display"] for t in c.get("client_tags") or []
                        if t.get("group_display") == TAG_CATEGORY}),
    }


# ── Auth ──────────────────────────────────────────────────────────────────────
_fails = {}  # ip -> (count, first_fail_time)


def login_required(view):
    @wraps(view)
    def wrapped(*a, **kw):
        if not session.get("ok"):
            if request.path.startswith("/api/"):
                return jsonify(error="Please log in again."), 401
            return redirect(url_for("login"))
        return view(*a, **kw)
    return wrapped


@app.route("/login", methods=["GET", "POST"])
def login():
    error = None
    if request.method == "POST":
        ip = request.headers.get("X-Forwarded-For", request.remote_addr or "").split(",")[0]
        count, first = _fails.get(ip, (0, time.time()))
        if time.time() - first > 15 * 60:
            count, first = 0, time.time()
        if count >= 5:
            error = "Too many attempts — try again in 15 minutes."
        elif secrets.compare_digest(request.form.get("pin", ""), os.environ.get("APP_PIN", "")) and os.environ.get("APP_PIN"):
            _fails.pop(ip, None)
            session.permanent = True
            session["ok"] = True
            return redirect(url_for("index"))
        else:
            _fails[ip] = (count + 1, first)
            error = "That PIN isn't right."
    return render_template("login.html", error=error)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


# ── Pages & API ───────────────────────────────────────────────────────────────
@app.route("/")
@login_required
def index():
    return render_template("index.html", tags=VIP_TAGS, category=TAG_CATEGORY)


@app.route("/api/search")
@login_required
def search():
    q = (request.args.get("q") or "").strip()
    if len(q) < 2:
        return jsonify(results=[])
    params = {"venue_group_id": VENUE_GROUP_ID, "limit": 50}
    params["email" if "@" in q else "name"] = q
    r = sr("GET", "/clients", params=params)
    if not r.ok:
        log.warning("search failed %s %s", r.status_code, r.text[:200])
        return jsonify(error="SevenRooms didn't respond — try again."), 502
    found = [c for c in r.json().get("data", {}).get("results", []) if not c.get("deleted")]
    # The search index lags behind real profiles (a removed tag can still show
    # for hours), so re-read each match directly for its current tags.
    with ThreadPoolExecutor(max_workers=16) as pool:
        fresh = list(pool.map(_fresh_client, found))
    results = [summarise(c) for c in fresh]
    results.sort(key=lambda x: (bool(x["tags"]), x["visits"], x["last_visit"]), reverse=True)
    return jsonify(results=results)


@app.route("/api/tag", methods=["POST"])
@login_required
def tag():
    body = request.get_json(silent=True) or {}
    client_id, tag_name, action = body.get("client_id"), body.get("tag"), body.get("action")
    if tag_name not in VIP_TAGS or action not in ("add", "remove") or not client_id:
        return jsonify(error="Invalid request."), 400

    field = "add_tags" if action == "add" else "remove_tags"
    r = sr("POST", f"/clients/{client_id}", data={field: f"{TAG_CATEGORY}:{tag_name}"})
    if not r.ok:
        log.warning("tag %s failed %s %s", action, r.status_code, r.text[:200])
        return jsonify(error="SevenRooms rejected the change."), 502

    # SevenRooms says 200 even when it ignores a change — read back to be sure.
    after = sr("GET", f"/clients/{client_id}").json().get("data", {})
    summary = summarise(after)
    done = (tag_name in summary["tags"]) == (action == "add")
    log.info("TAG %s %s:%s on %s (%s) -> %s", action, TAG_CATEGORY, tag_name,
             summary["name"], client_id, "OK" if done else "NOT APPLIED")
    if not done:
        return jsonify(error="SevenRooms didn't apply the change.", client=summary), 502
    return jsonify(client=summary)


@app.route("/sw.js")
def service_worker():
    # Served from the root so it can control the whole app (scope "/").
    resp = app.send_static_file("sw.js")
    resp.headers["Cache-Control"] = "no-cache"
    resp.headers["Service-Worker-Allowed"] = "/"
    return resp


@app.route("/offline")
def offline():
    return render_template("offline.html")


@app.context_processor
def asset_version():
    return {"v": ASSET_VERSION}


@app.route("/healthz")
def healthz():
    return "ok"


if __name__ == "__main__":
    app.run(debug=True, port=5050)

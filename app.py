"""
GymBro — Gym session tracker with LM Studio integration.

Run with: uvicorn app:app --reload --host 0.0.0.0 --port 8000
"""

import json
import re
import secrets
from datetime import date, datetime
from typing import Optional
from urllib.parse import urlencode

from fastapi import FastAPI, Request, HTTPException, Query
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

import auth
import coaching
import config
import db
import llm
from calculator import Scheme, convert_scheme, parse_scheme_str, REP_SCHEME_INFO, estimate_1rm

app = FastAPI(title="GymBro", version="1.1.0")

# Static files & templates
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

LM_STUDIO_URL = config.get("LM_STUDIO_URL", "http://localhost:1234/v1/chat/completions")

# Always-admin account (case-insensitive match on signup/login email or username).
# Configurable via ADMIN_EMAIL in .env / environment.
ADMIN_EMAIL = config.get("ADMIN_EMAIL", "georgekstr@gmail.com").lower()

# Google OAuth server-side flow; secrets live in .env (see .env.example) or env:
#   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, optional GOOGLE_REDIRECT_URI
GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"


@app.on_event("startup")
def startup():
    db.ensure_db()
    # First-ever user becomes admin (bootstrap)
    if db.count_users() == 0:
        pass  # admin is created via signup when no users exist


def set_session_cookie(response, token: str):
    response.set_cookie(
        auth.COOKIE_NAME, token, httponly=True, samesite="lax",
        max_age=60 * 60 * 24 * 30, path="/",
    )


# ──────────────────────────────────────────────
#  HTML Pages
# ──────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    user = auth.get_current_user(request)
    return templates.TemplateResponse("index.html", {
        "request": request, "user": auth.public_user(user) if user else None,
    })


# ──────────────────────────────────────────────
#  API: Auth
# ──────────────────────────────────────────────

@app.post("/api/auth/signup")
async def api_signup(request: Request):
    """Sign up. George's email is always admin; otherwise the very first
    account when no users exist yet becomes admin."""
    body = await request.json()
    username = (body.get("username") or "").strip()
    is_george = username.lower() == ADMIN_EMAIL
    # Only the configured ADMIN_EMAIL bootstraps as admin; everyone else
    # starts as trainee. There is no "first user becomes admin" rule.
    role = "admin" if is_george else "trainee"
    try:
        user = auth.create_account(username, body.get("password", ""), role)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if is_george:
        user = db.set_user_email(user["id"], ADMIN_EMAIL)

    # Bind any pending coaching invites addressed to this email/username
    db.bind_pending_invites_for_user(
        user["id"], (user.get("email") or username).lower())
    token = auth.start_session(user)
    resp = JSONResponse({"user": auth.public_user(user), "is_first_admin": is_george})
    set_session_cookie(resp, token)
    return resp


@app.post("/api/auth/login")
async def api_login(request: Request):
    body = await request.json()
    try:
        user = auth.authenticate(body.get("username", ""), body.get("password", ""))
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    if not user:
        raise HTTPException(status_code=401, detail="Invalid username or password")
    token = auth.start_session(user)
    resp = JSONResponse({"user": auth.public_user(user)})
    set_session_cookie(resp, token)
    return resp


@app.post("/api/auth/logout")
def api_logout(request: Request):
    token = request.cookies.get(auth.COOKIE_NAME)
    auth.destroy_session(token)
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(auth.COOKIE_NAME, path="/")
    return resp


@app.get("/api/auth/google/status")
def api_google_status():
    enabled = bool(config.get("GOOGLE_CLIENT_ID") and config.get("GOOGLE_CLIENT_SECRET"))
    return JSONResponse({"enabled": enabled})


def _google_redirect_uri(request: Request) -> str:
    return config.get("GOOGLE_REDIRECT_URI") or (
        str(request.base_url).rstrip("/") + "/api/auth/google/callback"
    )


@app.get("/api/auth/google/start")
async def api_google_start(request: Request):
    client_id = config.get("GOOGLE_CLIENT_ID")
    if not client_id or not config.get("GOOGLE_CLIENT_SECRET"):
        raise HTTPException(status_code=503, detail="Google login is not configured on this server")
    state = secrets.token_hex(16)
    params = {
        "client_id": client_id,
        "redirect_uri": _google_redirect_uri(request),
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "prompt": "select_account",
    }
    resp = RedirectResponse(GOOGLE_AUTH_URL + "?" + urlencode(params))
    resp.set_cookie("google_oauth_state", state, httponly=True,
                    samesite="lax", max_age=600, path="/")
    return resp


@app.get("/api/auth/google/callback")
async def api_google_callback(request: Request):
    import httpx

    code = request.query_params.get("code")
    error = request.query_params.get("error")
    err_desc = request.query_params.get("error_description", "")
    state = request.query_params.get("state")
    if error:
        hint = ""
        if "access_denied" in error.lower():
            hint = ("<p><strong>Most common cause:</strong> the OAuth consent screen is in "
                    "<em>Testing</em> mode and this Google account is not on its test-users "
                    "list. In Google Cloud Console → APIs &amp; Services → OAuth consent "
                    "screen (Audience), add the account under <strong>Test users</strong>, "
                    "or set the app to <strong>In production</strong>.</p>")
        print(f"[gymbro] Google auth error: {error} — {err_desc}", flush=True)
        return HTMLResponse(
            f"<h3>Google login failed: {error}</h3><p>{err_desc}</p>{hint}"
            "<a href='/'>Back</a>", status_code=400)
    if not code:
        return HTMLResponse("<h3>Google login cancelled.</h3><a href='/'>Back</a>", status_code=400)
    if not state or state != request.cookies.get("google_oauth_state"):
        return HTMLResponse("<h3>Invalid OAuth state.</h3><a href='/'>Back</a>", status_code=400)

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            token_resp = await client.post(GOOGLE_TOKEN_URL, data={
                "code": code,
                "client_id": config.get("GOOGLE_CLIENT_ID"),
                "client_secret": config.get("GOOGLE_CLIENT_SECRET"),
                "redirect_uri": _google_redirect_uri(request),
                "grant_type": "authorization_code",
            })
            token_resp.raise_for_status()
            access_token = token_resp.json()["access_token"]
            info_resp = await client.get(
                GOOGLE_USERINFO_URL,
                headers={"Authorization": f"Bearer {access_token}"},
            )
            info_resp.raise_for_status()
            info = info_resp.json()
    except Exception as e:
        return HTMLResponse(f"<h3>Google login failed.</h3><p>{e}</p><a href='/'>Back</a>", status_code=502)

    email = info.get("email", "")
    google_sub = info.get("sub", "")
    name = info.get("name") or email.split("@")[0]
    if not email or not google_sub:
        return HTMLResponse("<h3>Google account returned no email.</h3><a href='/'>Back</a>", status_code=400)

    user = db.upsert_google_user(email, google_sub, name)

    # Bind any pending coaching invites addressed to this email
    db.bind_pending_invites_for_user(user["id"], email.lower())

    # Role rules:
    #  - George's email is always admin
    #  - anyone else signing in with Google is a trainee (no first-user rule)
    if email.lower() == ADMIN_EMAIL and user["role"] != "admin":
        user = db.set_user_role(user["id"], "admin")

    token = auth.start_session(user)
    resp = RedirectResponse("/")
    resp.delete_cookie("google_oauth_state", path="/")
    set_session_cookie(resp, token)
    return resp


@app.get("/api/auth/me")
def api_me(request: Request):
    try:
        user = auth.get_current_user(request)
    except PermissionError:
        from fastapi.responses import JSONResponse as _JR
        resp = _JR({"user": None, "banned": True})
        resp.delete_cookie(auth.COOKIE_NAME, path="/")
        return resp
    user = user and user if not isinstance(user, dict) else user
    user = None if (user and user.get("banned")) else user
    if not user:
        return JSONResponse({"user": None})
    resp = {"user": auth.public_user(user),
            "has_any_timeline": len(db.get_timelines_for_user(user["id"], user["role"])) > 0}
    if user["role"] == "trainee":
        resp["pending_requests"] = len([
            r for r in db.get_requests_for_user(user["id"], incoming=True)
            if r["status"] == "pending"
        ])
        tl = db.get_trainee_timeline(user["id"])
        resp["has_timeline"] = tl is not None
        if tl:
            resp["timeline_id"] = tl["id"]
            resp["coach_name"] = db.get_user_by_id(tl["coach_id"])["username"]
    if user["role"] == "coach":
        resp["sent_requests"] = len([
            r for r in db.get_requests_for_user(user["id"], incoming=False)
            if r["status"] == "pending"
        ])
    return JSONResponse(resp)


# ──────────────────────────────────────────────
#  API: Users & roles (admin only)
# ──────────────────────────────────────────────

@app.get("/api/users")
def api_users(request: Request, page: int = Query(1, ge=1), page_size: int = Query(10, ge=1, le=100),
              role: str = "all", search: str = "", include_banned: bool = False, banned_only: bool = False):
    """Admin user list: pagination + role filter + fuzzy search."""
    auth.require_role(request, "admin")
    users = db.get_users_filtered(role, search, include_banned=True)
    if banned_only:
        users = [u for u in users if u.get("banned")]
    total = len(users)
    pages = max(1, -(-total // page_size))
    page = min(page, pages)
    items = users[(page - 1) * page_size: page * page_size]
    for u in items:
        u.pop("password_hash", None); u.pop("salt", None)
    return JSONResponse({"items": items, "page": page, "pages": pages, "total": total})


@app.post("/api/users/{user_id}/role")
async def api_set_role(user_id: int, request: Request):
    admin = auth.require_role(request, "admin")
    body = await request.json()
    role = body.get("role")
    if role not in ("coach", "trainee", "admin"):
        raise HTTPException(status_code=400, detail="Role must be coach, trainee or admin")
    if user_id == admin["id"] and role != "admin":
        # self-demotion is fine as long as another admin remains
        remaining_admins = sum(1 for u in db.get_all_users()
                               if u["role"] == "admin" and u["id"] != user_id)
        if remaining_admins == 0:
            raise HTTPException(status_code=400, detail="You cannot demote yourself — no other admin exists")
    try:
        user = db.set_user_role(user_id, role)
    except LookupError:
        raise HTTPException(status_code=404, detail="User not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return JSONResponse(auth.public_user(user))


# ──────────────────────────────────────────────
#  API: Coaching requests
# ──────────────────────────────────────────────

@app.get("/api/coaching/requests")
def api_coach_requests(request: Request):
    user = auth.require_user(request)
    incoming = db.get_requests_for_user(user["id"], incoming=True)
    outgoing = db.get_requests_for_user(user["id"], incoming=False)
    return JSONResponse({"incoming": incoming, "outgoing": outgoing})


@app.get("/api/coaching/trainees")
def api_coach_trainees(request: Request):
    """Coach/admin: list users (for sending requests)."""
    user = auth.require_role(request, "coach", "admin")
    users = [u for u in db.get_all_users() if u["role"] in ("trainee", "coach") and u["id"] != user["id"]]
    return JSONResponse(users)


@app.post("/api/coaching/requests")
async def api_send_coach_request(request: Request):
    coach = auth.require_role(request, "coach", "admin")
    body = await request.json()
    try:
        if body.get("email"):
            req = coaching.send_request(
                coach["id"], None, body.get("message", ""), invite_email=body["email"]
            )
        else:
            req = coaching.send_request(
                coach["id"], int(body["trainee_id"]), body.get("message", "")
            )
    except (ValueError, PermissionError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    return JSONResponse(req)


@app.post("/api/coaching/requests/{request_id}/respond")
async def api_respond_coach_request(request_id: int, request: Request):
    trainee = auth.require_user(request)
    body = await request.json()
    accept = bool(body.get("accept", False))
    try:
        result = coaching.respond_request(request_id, trainee["id"], accept)
    except (ValueError, PermissionError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    return JSONResponse(result)


# ──────────────────────────────────────────────
#  API: Timelines
# ──────────────────────────────────────────────

@app.get("/api/timelines")
def api_timelines(request: Request):
    user = auth.require_user(request)
    return JSONResponse(db.get_timelines_for_user(user["id"], user["role"]))


def _load_timeline(timeline_id: int, user: dict) -> dict:
    tl = db.get_timeline(timeline_id)
    if not tl:
        raise HTTPException(status_code=404, detail="Timeline not found")
    if not coaching.can_access_timeline(user, tl):
        raise HTTPException(status_code=403, detail="No access to this timeline")
    return tl


@app.get("/api/timelines/{timeline_id}")
def api_timeline_detail(timeline_id: int, request: Request):
    user = auth.require_user(request)
    tl = _load_timeline(timeline_id, user)
    coach = db.get_user_by_id(tl["coach_id"])
    trainee = db.get_user_by_id(tl["trainee_id"])
    return JSONResponse({
        **tl,
        "coach_name": coach["username"],
        "trainee_name": trainee["username"],
        "exercises": db.get_programmed_exercises(timeline_id),
        "notes": db.get_timeline_notes(timeline_id),
    })


@app.post("/api/timelines/{timeline_id}/exercises")
async def api_add_programmed(timeline_id: int, request: Request):
    user = auth.require_user(request)
    tl = _load_timeline(timeline_id, user)
    if user["id"] != tl["coach_id"] and user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Only the coach can program exercises")
    body = await request.json()
    try:
        ex = coaching.add_programmed(timeline_id, user["id"], body)
    except (ValueError, LookupError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    return JSONResponse(ex)


@app.post("/api/timelines/{timeline_id}/plan")
async def api_timeline_plan(timeline_id: int, request: Request):
    """Apply an AI-parsed plan to a timeline (coach/admin only).

    Body: exactly the `{workouts: [...]}` shape /api/parse returns.
    Rules:
    - dates in the past (or today) are rejected: frozen history
    - entries already marked done/skipped are never touched
    - nothing is deleted; new exercises are simply added on those dates
    """
    user = auth.require_user(request)
    tl = _load_timeline(timeline_id, user)
    if user["id"] != tl["coach_id"] and user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Only the coach can program exercises")
    body = await request.json()
    workouts = body.get("workouts", []) if "workouts" in body else [body]

    today = date.today().isoformat()
    added, skipped_frozen = [], []
    for w in workouts:
        wdate = w.get("workout_date")
        if not wdate:
            continue
        if wdate <= today:
            skipped_frozen.append(wdate)
            continue
        for ex in w.get("exercises", []):
            if not ex.get("name"):
                continue
            entry = coaching.add_programmed(timeline_id, user["id"], {
                "name": ex.get("name") or "unnamed",
                "sets": int(ex.get("sets", 3)),
                "reps": int(ex.get("reps", 8)),
                "load_kg": ex.get("load_kg"),
                "rir": ex.get("rir"),
                "plan_date": wdate,
                "instructions": ex.get("comments", ""),
            })
            added.append({"name": entry["name"], "date": wdate, "id": entry["id"]})
    return JSONResponse({
        "added": added,
        "skipped_frozen": skipped_frozen,
        "timeline_id": timeline_id,
    })


def _build_ai_context(tl: dict, limit: int = 12) -> list[dict]:
    """Assemble recent chat as LLM messages for AI replies."""
    msgs = db.get_chat_messages(tl["id"], limit=20)
    out = []
    for m in msgs[-limit:]:
        role = "assistant" if m["sender_role"] == "ai" else "user"
        out.append({"role": role,
                    "content": f"{m.get('sender_name') or m['sender_role']}: {m['body']}"})
    return out


def _ai_reply_for_timeline(tl: dict) -> str:
    coach_name = db.get_user_by_id(tl["coach_id"])["username"]
    trainee = db.get_user_by_id(tl["trainee_id"])
    trainee_name = trainee["username"]
    prog = db.get_programmed_exercises(tl["id"])
    plan = "; ".join(
        f"{e['name']} {e['sets']}x{e['reps']}"
        + (f" @{e['load_kg']}kg" if e.get("load_kg") else "")
        + (f" [{e['plan_date']}]" if e.get("plan_date") else "")
        + (f" ({e['status']})" if e["status"] != "pending" else "")
        for e in prog
    ) or "none yet"
    note = (
        "You are GymBro's AI coaching assistant. The coach uses this chat to "
        "establish durable RULES and guidance for their trainee; remember them "
        "and reflect them in replies. Answer briefly (2-5 sentences), friendly, "
        "concrete."
        f" Coach: {coach_name}. Trainee: {trainee_name}. "
        f"Programmed sessions: {plan}. Recent conversation follows."
    )
    return llm.ai_chat_reply(_build_ai_context(tl), note)


@app.post("/api/timelines/{timeline_id}/chat")
async def api_chat_post(timeline_id: int, request: Request):
    """Send a chat message in a timeline.

    - coach/admin: plain message to trainee; with the coach's AI toggle on
      (timeline.ai_chat), the text is instead instructions for the AI, which replies.
    - trainee: message to coach; when ai_autoreply is enabled, an AI reply
      is generated automatically using the coach's established guidance.
    """
    user = auth.require_user(request)
    tl = _load_timeline(timeline_id, user)
    is_coach = user["id"] == tl["coach_id"] or user["role"] == "admin"
    is_trainee = user["id"] == tl["trainee_id"]
    if not (is_coach or is_trainee):
        raise HTTPException(status_code=403, detail="No access to this chat")
    body = await request.json()
    text = (body.get("body") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty message")
    role = "coach" if is_coach else "trainee"
    out = [db.add_chat_message(timeline_id, user["id"], role, text)]

    ai_mode = bool(tl.get("ai_chat"))
    autoreply = bool(tl.get("ai_autoreply"))
    want_reply = (is_coach and ai_mode) or (is_trainee and autoreply)
    if want_reply:
        try:
            reply = llm.ai_chat_reply(_build_ai_context(tl),
                                      "You are GymBro's AI coaching assistant. The coach "
                                      "establishes rules/guidance for their trainee. Reply "
                                      "briefly (2-5 sentences), friendly and concrete.")
            out.append(db.add_chat_message(timeline_id, None, "ai", reply))
        except Exception as e:
            out.append(db.add_chat_message(timeline_id, None, "ai",
                        "⚠️ AI provider unavailable right now."))
    return JSONResponse({"messages": out})


@app.get("/api/timelines/{timeline_id}/chat")
def api_chat_get(timeline_id: int, request: Request):
    user = auth.require_user(request)
    tl = _load_timeline(timeline_id, user)
    return JSONResponse({
        "messages": db.get_chat_messages(timeline_id),
        "ai_chat": bool(tl.get("ai_chat")),
        "ai_autoreply": bool(tl.get("ai_autoreply")),
        "is_coach": user["id"] == tl["coach_id"] or user["role"] == "admin",
    })


@app.put("/api/timelines/{timeline_id}/chat-settings")
async def api_chat_settings(timeline_id: int, request: Request):
    user = auth.require_user(request)
    tl = _load_timeline(timeline_id, user)
    if user["id"] != tl["coach_id"] and user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Only the coach can change chat settings")
    body = await request.json()
    db.set_chat_flags(
        timeline_id,
        ai_mode=body.get("ai_mode"),
        ai_autoreply=body.get("ai_autoreply"),
    )
    return JSONResponse({"ok": True})


@app.get("/api/timelines/{timeline_id}/blocks")
def api_get_blocks(timeline_id: int, request: Request):
    user = auth.require_user(request)
    _load_timeline(timeline_id, user)
    return JSONResponse({"blocks": db.get_blocks(timeline_id),
                         "day_map": db.get_day_block_map(timeline_id)})


@app.post("/api/timelines/{timeline_id}/blocks")
async def api_create_block(timeline_id: int, request: Request):
    user = auth.require_user(request)
    tl = _load_timeline(timeline_id, user)
    if user["id"] != tl["coach_id"] and user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Only the coach can create blocks")
    body = await request.json()
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Block name required")
    color = body.get("color") or "#6c5ce7"
    if not re.match(r"^#[0-9a-fA-F]{6}$", color):
        raise HTTPException(status_code=400, detail="color must be hex")
    return JSONResponse(db.create_block(timeline_id, name, color))


@app.delete("/api/blocks/{block_id}")
def api_delete_block(block_id: int, request: Request):
    user = auth.require_user(request)
    conn = db.get_conn()
    bl = conn.execute("SELECT * FROM timeline_blocks WHERE id=?", (block_id,)).fetchone()
    conn.close()
    if not bl:
        raise HTTPException(status_code=404, detail="Block not found")
    tl = _load_timeline(bl["timeline_id"], user)
    if user["id"] != tl["coach_id"] and user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Only the coach can delete blocks")
    return JSONResponse(db.delete_block(block_id))


@app.put("/api/timelines/{timeline_id}/assign-block")
async def api_assign_block(timeline_id: int, request: Request):
    """Coach/admin: assign the selected days to a block (or clear with block_id=null)."""
    user = auth.require_user(request)
    tl = _load_timeline(timeline_id, user)
    if user["id"] != tl["coach_id"] and user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Only the coach can assign blocks")
    body = await request.json()
    days = sorted(set(body.get("days") or []))
    block_id = body.get("block_id")
    if not days:
        raise HTTPException(status_code=400, detail="No days selected")
    if block_id is None:
        db.unassign_days(timeline_id, days)
        return JSONResponse({"ok": True, "assigned": days, "block_id": None})
    bl = db.get_blocks(timeline_id)
    if block_id not in [b["id"] for b in db.get_blocks(timeline_id)]:
        raise HTTPException(status_code=400, detail="Unknown block")
    db.assign_days_to_block(timeline_id, days, block_id)
    return JSONResponse({"ok": True, "assigned": days, "block_id": block_id})


@app.put("/api/programmed/{ex_id}")
async def api_set_block(timeline_id: int, request: Request):
    """Coach/admin: define a training block for the timeline.
    Body: {start_week: 'YYYY-MM-DD' (a Monday), weeks: n, days_per_week: n}.
    Trainees see this read-only."""
    import re as _re
    user = auth.require_user(request)
    tl = _load_timeline(timeline_id, user)
    if user["id"] != tl["coach_id"] and user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Only the coach can set the training block")
    body = await request.json()
    weeks = int(body.get("weeks", 0))
    days = int(body.get("days_per_week", 0))
    start = body.get("start_week", "")
    if not _re.match(r"^\d{4}-\d{2}-\d{2}$", start or ""):
        raise HTTPException(status_code=400, detail="start_week must be a YYYY-MM-DD Monday")
    if weeks < 1 or weeks > 52:
        raise HTTPException(status_code=400, detail="weeks must be 1-52")
    if days < 1 or days > 7:
        raise HTTPException(status_code=400, detail="days_per_week must be 1-7")
    conn = db.get_conn()
    conn.execute(
        "UPDATE timelines SET block_start=?, block_weeks=?, block_days=? WHERE id=?",
        (start, weeks, days, tl["id"]),
    )
    conn.commit()
    conn.close()
    return JSONResponse({"start_week": start, "weeks": weeks, "days_per_week": days})


@app.delete("/api/timelines/{timeline_id}/block")
def api_clear_block(timeline_id: int, request: Request):
    user = auth.require_user(request)
    tl = _load_timeline(timeline_id, user)
    if user["id"] != tl["coach_id"] and user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Only the coach can clear the training block")
    conn = db.get_conn()
    conn.execute(
        "UPDATE timelines SET block_start=NULL, block_weeks=NULL, block_days=NULL WHERE id=?",
        (tl["id"],),
    )
    conn.commit()
    conn.close()
    return JSONResponse({"ok": True})


@app.post("/api/users/{user_id}/ban")
async def api_ban_user(user_id: int, request: Request):
    admin = auth.require_role(request, "admin")
    body = await request.json()
    banned = bool(body.get("banned"))
    if user_id == admin["id"]:
        raise HTTPException(status_code=400, detail="You cannot ban yourself")
    target = db.get_user_by_id(user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if target["role"] == "admin":
        admins = [u for u in db.get_all_users() if u["role"] == "admin" and u["id"] != user_id]
        if not admins:
            raise HTTPException(status_code=400, detail="Cannot ban the last remaining admin")
        if banned:
            raise HTTPException(status_code=400, detail="Demote this admin first, then ban")
    return JSONResponse(db.set_user_banned(user_id, banned))


@app.delete("/api/users/{user_id}")
def api_delete_user(user_id: int, request: Request):
    admin = auth.require_role(request, "admin")
    if user_id == admin["id"]:
        raise HTTPException(status_code=400, detail="You cannot delete your own account")
    admins = [u for u in db.get_all_users() if u["role"] == "admin" and u["id"] != user_id]
    if not admins:
        raise HTTPException(status_code=400, detail="Cannot delete the last remaining admin")
    try:
        result = db.delete_user(user_id)
    except LookupError:
        raise HTTPException(status_code=404, detail="User not found")
    return JSONResponse(result)


@app.get("/api/timelines/{timeline_id}/blocks")
def api_get_blocks(timeline_id: int, request: Request):
    user = auth.require_user(request)
    _load_timeline(timeline_id, user)
    return JSONResponse({"blocks": db.get_blocks(timeline_id),
                         "day_map": db.get_day_block_map(timeline_id)})


@app.post("/api/timelines/{timeline_id}/blocks")
async def api_create_block(timeline_id: int, request: Request):
    user = auth.require_user(request)
    tl = _load_timeline(timeline_id, user)
    if user["id"] != tl["coach_id"] and user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Only the coach can create blocks")
    body = await request.json()
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Block name required")
    color = body.get("color") or "#6c5ce7"
    if not re.match(r"^#[0-9a-fA-F]{6}$", color):
        raise HTTPException(status_code=400, detail="color must be hex")
    return JSONResponse(db.create_block(timeline_id, name, color))


@app.delete("/api/blocks/{block_id}")
def api_delete_block(block_id: int, request: Request):
    user = auth.require_user(request)
    conn = db.get_conn()
    bl = conn.execute("SELECT * FROM timeline_blocks WHERE id=?", (block_id,)).fetchone()
    conn.close()
    if not bl:
        raise HTTPException(status_code=404, detail="Block not found")
    tl = _load_timeline(bl["timeline_id"], user)
    if user["id"] != tl["coach_id"] and user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Only the coach can delete blocks")
    return JSONResponse(db.delete_block(block_id))


@app.put("/api/timelines/{timeline_id}/assign-block")
async def api_assign_block(timeline_id: int, request: Request):
    """Coach/admin: assign the selected days to a block (or clear with block_id=null)."""
    user = auth.require_user(request)
    tl = _load_timeline(timeline_id, user)
    if user["id"] != tl["coach_id"] and user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Only the coach can assign blocks")
    body = await request.json()
    days = sorted(set(body.get("days") or []))
    block_id = body.get("block_id")
    if not days:
        raise HTTPException(status_code=400, detail="No days selected")
    if block_id is None:
        db.unassign_days(timeline_id, days)
        return JSONResponse({"ok": True, "assigned": days, "block_id": None})
    bl = db.get_blocks(timeline_id)
    if block_id not in [b["id"] for b in db.get_blocks(timeline_id)]:
        raise HTTPException(status_code=400, detail="Unknown block")
    db.assign_days_to_block(timeline_id, days, block_id)
    return JSONResponse({"ok": True, "assigned": days, "block_id": block_id})


@app.put("/api/programmed/{ex_id}")
async def api_update_programmed(ex_id: int, request: Request):
    user = auth.require_user(request)
    body = await request.json()
    try:
        ex = coaching.update_programmed(ex_id, user, body)
    except LookupError:
        raise HTTPException(status_code=404, detail="Exercise not found")
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    return JSONResponse(ex)


@app.delete("/api/programmed/{ex_id}")
def api_delete_programmed(ex_id: int, request: Request):
    user = auth.require_user(request)
    try:
        coaching.delete_programmed(ex_id, user["id"])
    except LookupError:
        raise HTTPException(status_code=404, detail="Exercise not found")
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    return JSONResponse({"ok": True})


@app.post("/api/programmed/{ex_id}/feedback")
async def api_programmed_feedback(ex_id: int, request: Request):
    user = auth.require_user(request)
    body = await request.json()
    try:
        ex = coaching.set_status(
            ex_id, user["id"], body.get("status", "pending"),
            actual_load=body.get("actual_load"),
            actual_sets=body.get("actual_sets"),
            actual_reps=body.get("actual_reps"),
            comments=body.get("comments", ""),
        )
    except LookupError:
        raise HTTPException(status_code=404, detail="Exercise not found")
    except (ValueError, PermissionError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    return JSONResponse(ex)


@app.post("/api/timelines/{timeline_id}/notes")
async def api_add_timeline_note(timeline_id: int, request: Request):
    user = auth.require_user(request)
    tl = _load_timeline(timeline_id, user)
    body = await request.json()
    note = db.add_timeline_note(timeline_id, user["id"], body.get("body", "").strip())
    note["author_name"] = user["username"]
    return JSONResponse(note)


# ──────────────────────────────────────────────
#  API: Parse natural language
# ──────────────────────────────────────────────

@app.post("/api/parse")
async def api_parse(request: Request):
    """Parse natural language workout description into structured data.
    Returns {"workouts": [{workout_date, notes, exercises}, ...]} for multi-day support."""
    body = await request.json()
    text = body.get("text", "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="No text provided")

    today_str = body.get("today")
    today = date.today()
    if today_str:
        try:
            today = datetime.strptime(today_str, "%Y-%m-%d").date()
        except ValueError:
            pass

    lm_url = body.get("lm_studio_url", LM_STUDIO_URL)
    parsed = await llm.parse_workout_text(text, today=today, lm_studio_url=lm_url)
    return JSONResponse(parsed)


# ──────────────────────────────────────────────
#  API: Save parsed workout
# ──────────────────────────────────────────────

@app.post("/api/workouts")
async def api_save_workout(request: Request):
    """Save one or more workouts. Accepts:
    - Single: {"workout_date": ..., "notes": ..., "exercises": [...]}
    - Batch:  {"workouts": [{"workout_date": ..., "notes": ..., "exercises": [...]}, ...]}
    - merge=True: keep existing exercises for those dates (AI edit mode) —
      exercises with a matching name are updated, others inserted, nothing removed.
    """
    user = auth.require_user(request)
    body = await request.json()
    merge = bool(body.get("merge"))  # merge: keep existing exercises, update/insert only

    # Detect format
    if "workouts" in body:
        workout_list = body["workouts"]
    else:
        workout_list = [body]

    db.backup_db()  # safety net on every save
    saved = []

    # Trainee rule: may only log on days that have planned exercises for them
    if user["role"] == "trainee":
        tl = db.get_trainee_timeline(user["id"])
        if tl:
            planned_days = {
                e["plan_date"] for e in db.get_programmed_exercises(tl["id"])
                if e.get("plan_date")
            }
        else:
            planned_days = set()
        wanted_days = {w.get("workout_date") for w in workout_list if w.get("workout_date")}
        off_plan = wanted_days - planned_days
        if off_plan:
            raise HTTPException(
                status_code=403,
                detail="You can only log exercises on days your coach has planned "
                       f"(no plan for: {', '.join(sorted(off_plan))})",
            )

    for w_data in workout_list:
        workout_date = w_data.get("workout_date")
        notes = w_data.get("notes", "")
        exercises = w_data.get("exercises", [])

        if not workout_date:
            continue

        def _save_one():
            w = db.get_or_create_workout(workout_date, user_id=user["id"])
            if notes:
                db.update_workout_notes(workout_date, notes)
            if merge:
                # Keep existing entries; update matching names, insert the rest.
                full = db.get_workout(workout_date) or w
                incoming = {e["name"].lower(): e for e in exercises}
                for existing_ex in full.get("exercises", []):
                    m = incoming.pop(existing_ex["name"].lower(), None)
                    if m is not None:
                        db.update_exercise(existing_ex["id"], **{
                            "sets": int(m.get("sets", 0)),
                            "reps": int(m.get("reps", 0)),
                            "load_kg": m.get("load_kg"),
                            "rir": m.get("rir"),
                            "comments": m.get("comments", ""),
                        })
                for ex in exercises:
                    if ex.get("name", "").lower() not in incoming:
                        continue  # already updated above
                    db.add_exercise(
                        workout_id=w["id"], name=ex.get("name", ""),
                        sets=int(ex.get("sets", 0)), reps=int(ex.get("reps", 0)),
                        load_kg=ex.get("load_kg"), rir=ex.get("rir"),
                        comments=ex.get("comments", ""))
            else:
                conn = db.get_conn()
                conn.execute("DELETE FROM exercises WHERE workout_id=?", (w["id"],))
                conn.commit()
                conn.close()
                for ex in exercises:
                    db.add_exercise(
                        workout_id=w["id"],
                        name=ex.get("name", "unknown"),
                        sets=int(ex.get("sets", 0)),
                        reps=int(ex.get("reps", 0)),
                        load_kg=ex.get("load_kg"),
                        rir=ex.get("rir"),
                        comments=ex.get("comments", "")
                    )
            return db.get_workout(workout_date)

        try:
            saved.append(_save_one())
        except Exception:
            db.ensure_db()
            saved.append(_save_one())

    return JSONResponse({"saved": saved})


# ──────────────────────────────────────────────
#  API: Get workouts
# ──────────────────────────────────────────────

@app.get("/api/workouts")
def api_get_workouts(request: Request, year: Optional[int] = Query(default=None)):
    """Get all workouts, optionally filtered by year (scoped to logged-in user)."""
    user = auth.require_user(request)
    if year is None:
        year = date.today().year
    try:
        workouts = db.get_workouts_for_year(year, user_id=user["id"])
        return JSONResponse(workouts)
    except Exception as e:
        db.ensure_db()
        workouts = db.get_workouts_for_year(year, user_id=user["id"])
        return JSONResponse(workouts)


@app.get("/api/workouts/{workout_date}")
def api_get_workout(workout_date: str, request: Request):
    """Get a single workout by date."""
    user = auth.require_user(request)
    w = db.get_or_create_workout(workout_date, user_id=user["id"])
    if not w:
        raise HTTPException(status_code=404, detail="Workout not found")
    return JSONResponse(w)


@app.delete("/api/workouts/{workout_date}")
def api_delete_workout(workout_date: str, request: Request):
    """Delete a workout and its exercises."""
    user = auth.require_user(request)
    db.delete_workout(workout_date, user_id=user["id"])
    return JSONResponse({"ok": True})


# ──────────────────────────────────────────────
#  API: Exercises (manual CRUD)
# ──────────────────────────────────────────────

@app.put("/api/exercises/{exercise_id}")
async def api_update_exercise(exercise_id: int, request: Request):
    """Update an exercise's fields."""
    body = await request.json()
    db.update_exercise(exercise_id, **body)
    return JSONResponse({"ok": True})


@app.delete("/api/exercises/{exercise_id}")
def api_delete_exercise(exercise_id: int):
    """Delete a single exercise."""
    db.delete_exercise(exercise_id)
    return JSONResponse({"ok": True})


# ──────────────────────────────────────────────
#  API: Calculator
# ──────────────────────────────────────────────

@app.post("/api/calculator/convert")
async def api_calculator_convert(request: Request):
    """
    Convert a rep scheme to another.
    Body: {
        "source_sets": 5, "source_reps": 5, "source_load": 180,
        "source_rir": 0,
        "target_reps": 3,
        "target_rir": 0,
        "target_sets": null   // optional, if omitted we suggest multiple
    }
    """
    body = await request.json()

    source = Scheme(
        sets=int(body["source_sets"]),
        reps=int(body["source_reps"]),
        load_kg=float(body["source_load"]),
        rir=float(body.get("source_rir", 0))
    )
    target_reps = int(body["target_reps"])
    target_rir = float(body.get("target_rir", 0))
    target_sets = body.get("target_sets")
    if target_sets is not None:
        target_sets = int(target_sets)

    results = convert_scheme(source, target_reps, target_rir, target_sets)
    return JSONResponse({
        "source": {
            "sets": source.sets, "reps": source.reps, "load_kg": source.load_kg,
            "rir": source.rir,
            "e1rm": round(estimate_1rm(source.load_kg, source.reps, source.rir), 1)
        },
        "conversions": [
            {
                "sets": r.sets, "reps": r.reps, "load_kg": r.load_kg,
                "rir": r.rir, "difficulty_match": r.difficulty_match
            }
            for r in results
        ]
    })


@app.post("/api/calculator/parse-scheme")
async def api_parse_scheme(request: Request):
    """Parse a scheme string like '5x5 @ 180kg rir 2' into components."""
    body = await request.json()
    text = body.get("text", "")
    scheme = parse_scheme_str(text)
    if scheme is None:
        raise HTTPException(status_code=400, detail="Could not parse scheme")
    return JSONResponse({
        "sets": scheme.sets,
        "reps": scheme.reps,
        "load_kg": scheme.load_kg,
        "rir": scheme.rir
    })


# ──────────────────────────────────────────────
#  API: Exercise progression
# ──────────────────────────────────────────────

@app.get("/api/exercises/{exercise_name}/progression")
def api_exercise_progression(exercise_name: str, year: Optional[int] = Query(default=None)):
    """Return progression data (date, top-set e1RM, avg e1RM) for an exercise."""
    if year is None:
        year = date.today().year
    data = db.get_exercise_progression(exercise_name, year)
    return JSONResponse(data)


# ──────────────────────────────────────────────
#  API: Exercise autocomplete
# ──────────────────────────────────────────────

@app.get("/api/exercise-names")
def api_exercise_names():
    """Return all previously used exercise names for autocomplete."""
    exercises = db.get_all_exercises()
    return JSONResponse(exercises)


# ──────────────────────────────────────────────
#  API: LM Studio status
# ──────────────────────────────────────────────

@app.get("/api/lm-status")
async def api_lm_status():
    """Check the configured AI provider (cloud if configured, else LM Studio)."""
    import httpx
    ai = llm._ai_settings()
    headers = {"Authorization": f"Bearer {ai['key']}"} if ai["key"] else {}
    models_ep = ai["url"].rsplit("/chat/completions", 1)[0] + "/models" if ai["cloud"] else "http://localhost:1234/v1/models"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(models_ep, headers=headers)
            if resp.status_code == 200:
                data = resp.json()
                models = [m.get("id", "unknown") for m in data.get("data", [])]
                return JSONResponse({
                    "connected": True,
                    "provider": ai["provider_name"],
                    "cloud": ai["cloud"],
                    "model": ai["model"],
                    "models": models if not ai["cloud"] else models[:20],
                })
    except Exception:
        pass
    return JSONResponse({"connected": False, "models": [], "cloud": ai["cloud"], "provider": ai["provider_name"]})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

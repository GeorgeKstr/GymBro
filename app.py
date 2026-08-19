"""
GymBro — Gym session tracker with LM Studio integration.

Run with: uvicorn app:app --reload --host 0.0.0.0 --port 8000
"""

import json
from datetime import date, datetime
from typing import Optional

from fastapi import FastAPI, Request, HTTPException, Query
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

import db
import llm
from calculator import Scheme, convert_scheme, parse_scheme_str, REP_SCHEME_INFO, estimate_1rm

app = FastAPI(title="GymBro", version="1.0.0")

# Static files & templates
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

LM_STUDIO_URL = "http://localhost:1234/v1/chat/completions"


@app.on_event("startup")
def startup():
    db.ensure_db()


# ──────────────────────────────────────────────
#  HTML Pages
# ──────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


# ──────────────────────────────────────────────
#  API: Parse natural language
# ──────────────────────────────────────────────

@app.post("/api/parse")
async def api_parse(request: Request):
    """Parse natural language workout description into structured data."""
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
    """Save a parsed workout (from /api/parse or manual entry)."""
    body = await request.json()
    workout_date = body.get("workout_date")
    notes = body.get("notes", "")
    exercises = body.get("exercises", [])

    if not workout_date:
        raise HTTPException(status_code=400, detail="workout_date required")

    try:
        w = db.get_or_create_workout(workout_date)
        if notes:
            db.update_workout_notes(workout_date, notes)

        # Replace existing exercises for this workout (delete old, insert new)
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

        saved = db.get_workout(workout_date)
        return JSONResponse(saved)
    except Exception:
        db.ensure_db()
        # Retry once
        w = db.get_or_create_workout(workout_date)
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
        saved = db.get_workout(workout_date)
        return JSONResponse(saved)


# ──────────────────────────────────────────────
#  API: Get workouts
# ──────────────────────────────────────────────

@app.get("/api/workouts")
def api_get_workouts(year: Optional[int] = Query(default=None)):
    """Get all workouts, optionally filtered by year."""
    if year is None:
        year = date.today().year
    try:
        workouts = db.get_workouts_for_year(year)
        return JSONResponse(workouts)
    except Exception as e:
        db.ensure_db()
        workouts = db.get_workouts_for_year(year)
        return JSONResponse(workouts)


@app.get("/api/workouts/{workout_date}")
def api_get_workout(workout_date: str):
    """Get a single workout by date."""
    w = db.get_workout(workout_date)
    if not w:
        raise HTTPException(status_code=404, detail="Workout not found")
    return JSONResponse(w)


@app.delete("/api/workouts/{workout_date}")
def api_delete_workout(workout_date: str):
    """Delete a workout and its exercises."""
    db.delete_workout(workout_date)
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
    """Check if LM Studio is reachable."""
    import httpx
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get("http://localhost:1234/v1/models")
            if resp.status_code == 200:
                data = resp.json()
                models = data.get("data", [])
                return JSONResponse({
                    "connected": True,
                    "models": [m.get("id", "unknown") for m in models]
                })
    except Exception:
        pass
    return JSONResponse({"connected": False, "models": []})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

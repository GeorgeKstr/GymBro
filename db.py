"""
SQLite database for GymBro: stores workouts, exercises, sets, and comments.
"""

import sqlite3
import os
import shutil
from datetime import date, datetime
from typing import Optional

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gymbro.db")
BACKUP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".backups")


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def ensure_db():
    """Ensure DB file and tables exist. Safe to call repeatedly."""
    try:
        init_db()
    except Exception as e:
        # If DB is corrupted, delete and recreate
        print(f"DB init error ({e}), recreating...")
        for suffix in ["", "-wal", "-shm"]:
            try:
                os.remove(DB_PATH + suffix)
            except FileNotFoundError:
                pass
        init_db()


def backup_db():
    """Create a timestamped backup of the database."""
    if not os.path.exists(DB_PATH):
        return
    os.makedirs(BACKUP_DIR, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = os.path.join(BACKUP_DIR, f"gymbro_{ts}.db")
    shutil.copy2(DB_PATH, backup_path)
    # Keep only last 10 backups
    backups = sorted(
        [f for f in os.listdir(BACKUP_DIR) if f.endswith('.db')],
        reverse=True
    )
    for old in backups[10:]:
        os.remove(os.path.join(BACKUP_DIR, old))


def init_db():
    backup_db()
    conn = get_conn()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS workouts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL UNIQUE,
            notes TEXT DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS exercises (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            workout_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            sets INTEGER NOT NULL,
            reps INTEGER NOT NULL,
            load_kg REAL,
            rir REAL,
            comments TEXT DEFAULT '',
            FOREIGN KEY (workout_id) REFERENCES workouts(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_exercises_workout ON exercises(workout_id);
        CREATE INDEX IF NOT EXISTS idx_workouts_date ON workouts(date);
    """)
    conn.commit()
    conn.close()


# --- Workout CRUD ---

def get_or_create_workout(workout_date: str) -> dict:
    """Get a workout by date string YYYY-MM-DD, creating it if needed."""
    conn = get_conn()
    conn.execute("INSERT OR IGNORE INTO workouts (date) VALUES (?)", (workout_date,))
    conn.commit()
    row = conn.execute("SELECT * FROM workouts WHERE date=?", (workout_date,)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_workouts_for_year(year: int) -> list[dict]:
    """Return all workouts (with exercises) for a given year."""
    conn = get_conn()
    workouts = conn.execute(
        "SELECT * FROM workouts WHERE date LIKE ? ORDER BY date",
        (f"{year}-%",)
    ).fetchall()
    result = []
    for w in workouts:
        wd = dict(w)
        exs = conn.execute(
            "SELECT * FROM exercises WHERE workout_id=? ORDER BY id",
            (w["id"],)
        ).fetchall()
        wd["exercises"] = [dict(e) for e in exs]
        result.append(wd)
    conn.close()
    return result


def get_workout(workout_date: str) -> dict | None:
    """Get a single workout by date with its exercises."""
    conn = get_conn()
    w = conn.execute("SELECT * FROM workouts WHERE date=?", (workout_date,)).fetchone()
    if not w:
        conn.close()
        return None
    wd = dict(w)
    exs = conn.execute(
        "SELECT * FROM exercises WHERE workout_id=? ORDER BY id",
        (w["id"],)
    ).fetchall()
    wd["exercises"] = [dict(e) for e in exs]
    conn.close()
    return wd


def update_workout_notes(workout_date: str, notes: str):
    conn = get_conn()
    conn.execute("UPDATE workouts SET notes=? WHERE date=?", (notes, workout_date))
    conn.commit()
    conn.close()


# --- Exercise CRUD ---

def add_exercise(workout_id: int, name: str, sets: int, reps: int,
                 load_kg: float | None = None, rir: float | None = None,
                 comments: str = "") -> int:
    conn = get_conn()
    cur = conn.execute(
        """INSERT INTO exercises (workout_id, name, sets, reps, load_kg, rir, comments)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (workout_id, name, sets, reps, load_kg, rir, comments)
    )
    conn.commit()
    eid = cur.lastrowid
    conn.close()
    return eid


def delete_exercise(exercise_id: int):
    conn = get_conn()
    conn.execute("DELETE FROM exercises WHERE id=?", (exercise_id,))
    conn.commit()
    conn.close()


def update_exercise(exercise_id: int, **kwargs):
    """Update fields of an exercise. kwargs: name, sets, reps, load_kg, rir, comments."""
    allowed = {"name", "sets", "reps", "load_kg", "rir", "comments"}
    fields = {k: v for k, v in kwargs.items() if k in allowed and v is not None}
    if not fields:
        return
    set_clause = ", ".join(f"{k}=?" for k in fields)
    values = list(fields.values()) + [exercise_id]
    conn = get_conn()
    conn.execute(f"UPDATE exercises SET {set_clause} WHERE id=?", values)
    conn.commit()
    conn.close()


def delete_workout(workout_date: str):
    conn = get_conn()
    conn.execute("DELETE FROM workouts WHERE date=?", (workout_date,))
    conn.commit()
    conn.close()


def get_all_exercises() -> list[dict]:
    """Return all exercises ever logged, with date, for autocomplete."""
    conn = get_conn()
    rows = conn.execute("""
        SELECT e.name, MAX(e.load_kg) as max_load, COUNT(*) as cnt
        FROM exercises e
        GROUP BY LOWER(e.name)
        ORDER BY cnt DESC
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_exercise_progression(exercise_name: str, year: int | None = None) -> list[dict]:
    """Return progression data for a given exercise: date, load, reps, sets, rir, e1rm.
    For each workout date, returns the top set (highest e1RM) for that exercise."""
    conn = get_conn()
    if year:
        rows = conn.execute("""
            SELECT w.date, e.sets, e.reps, e.load_kg, e.rir
            FROM exercises e
            JOIN workouts w ON e.workout_id = w.id
            WHERE LOWER(e.name) = LOWER(?)
              AND w.date LIKE ?
            ORDER BY w.date ASC
        """, (exercise_name, f"{year}-%"))
    else:
        rows = conn.execute("""
            SELECT w.date, e.sets, e.reps, e.load_kg, e.rir
            FROM exercises e
            JOIN workouts w ON e.workout_id = w.id
            WHERE LOWER(e.name) = LOWER(?)
            ORDER BY w.date ASC
        """, (exercise_name,))

    # Group by date, compute e1RM for each set, take the highest per day
    from collections import defaultdict
    by_date = defaultdict(list)
    for r in rows:
        r = dict(r)
        if r["load_kg"] is not None and r["reps"] and r["reps"] > 0:
            eff_reps = r["reps"] + (r["rir"] or 0)
            e1rm = r["load_kg"] * (1 + eff_reps / 30.0)
            by_date[r["date"]].append({
                "sets": r["sets"],
                "reps": r["reps"],
                "load_kg": r["load_kg"],
                "rir": r["rir"],
                "e1rm": round(e1rm, 1)
            })

    result = []
    for date_str in sorted(by_date.keys()):
        entries = by_date[date_str]
        top = max(entries, key=lambda x: x["e1rm"])
        avg_e1rm = round(sum(e["e1rm"] for e in entries) / len(entries), 1)
        result.append({
            "date": date_str,
            "top_set": top,
            "avg_e1rm": avg_e1rm,
            "total_sets": len(entries)
        })

    conn.close()
    return result

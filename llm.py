"""
LM Studio integration: parse natural language gym entries into structured data.

LM Studio runs an OpenAI-compatible API, typically at http://localhost:1234/v1
"""

import json
import re
import httpx
from datetime import date, datetime, timedelta
from typing import Optional

# Default LM Studio endpoint
LM_STUDIO_URL = "http://localhost:1234/v1/chat/completions"

PARSE_SYSTEM_PROMPT = """You are a gym workout parser. Extract structured workout data from the user's natural language description.

Output ONLY valid JSON — no markdown, no explanation. Use this exact schema:

{{
  "workouts": [
    {{
      "workout_date": "YYYY-MM-DD",
      "notes": "any overall notes or empty string",
      "exercises": [
        {{
          "name": "exercise name (lowercase, standardised)",
          "sets": number,
          "reps": number,
          "load_kg": number or null,
          "rir": number or null,
          "comments": "any specific comments about this exercise"
        }}
      ]
    }}
  ]
}}

Rules:
- ALWAYS output the "workouts" array, even if there is only one workout.
- The user may describe MULTIPLE DAYS. Split them into separate workout objects — one per date.
- If the user says "today", use TODAY'S DATE.
- If the user says "Monday" / "this tuesday" / "last Wednesday" etc., resolve each relative to today.
- If they say "yesterday" or "tomorrow", resolve those.
- If no date is mentioned for a group of exercises, assume today.
- Sets×reps: "5x5" means 5 sets of 5 reps. "single" means 1 set of 1 rep.
- Load: "180kg", "180", "at 180", "@180" → load_kg=180. "135lb" → load_kg≈61.2.
- RIR (Reps In Reserve): "rir 2", "2 rir", "2 in the tank" → rir=2.
- Comments: anything about technique, difficulty, sensation, etc.
- Standardise exercise names (e.g., "bench" → "bench press", "squats" → "squat").
- If multiple exercises are mentioned for the same day, put them all in that day's exercises array.
- If sets/reps are missing, use null but try to infer from context.

Examples:
Input: "today I did 5x5 on bench at 180kg"
Output: {{"workouts":[{{"workout_date":"<today>","notes":"","exercises":[{{"name":"bench press","sets":5,"reps":5,"load_kg":180,"rir":null,"comments":""}}]}}]}}

Input: "monday bench 5x5 at 180, tuesday squat 3x8 at 140 rir 2"
Output: {{"workouts":[{{"workout_date":"<monday>","notes":"","exercises":[{{"name":"bench press","sets":5,"reps":5,"load_kg":180,"rir":null,"comments":""}}]}},{{"workout_date":"<tuesday>","notes":"","exercises":[{{"name":"squat","sets":3,"reps":8,"load_kg":140,"rir":2,"comments":""}}]}}]}}

Today's date is: {today}
This Tuesday is: {this_tuesday}
Last Monday was: {last_monday}
Yesterday was: {yesterday}
Tomorrow is: {tomorrow}
"""


def _get_relative_dates(today: date) -> dict:
    """Compute relative dates for the prompt."""
    # This Tuesday: next Tuesday if today is after Tuesday, else this week's Tuesday
    days_until_tuesday = (1 - today.weekday()) % 7  # Monday=0, Tuesday=1
    if days_until_tuesday == 0:
        days_until_tuesday = 0  # Today is Tuesday
    this_tuesday = today + timedelta(days=days_until_tuesday)
    # If today is Tuesday, "this Tuesday" means today. If later in week, it's past.
    if today.weekday() > 1:  # After Tuesday
        this_tuesday = today - timedelta(days=(today.weekday() - 1))

    last_monday = today - timedelta(days=(today.weekday() + 6) % 7)
    # Actually "last Monday" = most recent Monday (could be today if Monday)
    days_since_monday = today.weekday()  # 0 if Monday
    last_monday = today - timedelta(days=days_since_monday)

    return {
        "today": today.isoformat(),
        "this_tuesday": this_tuesday.isoformat(),
        "last_monday": last_monday.isoformat(),
        "yesterday": (today - timedelta(days=1)).isoformat(),
        "tomorrow": (today + timedelta(days=1)).isoformat(),
    }


async def parse_workout_text(text: str, today: Optional[date] = None,
                             lm_studio_url: Optional[str] = None) -> dict:
    """
    Send natural language text to LM Studio and parse into structured workout data.
    Falls back to regex-based parsing if LM Studio is unavailable.
    """
    if today is None:
        today = date.today()

    url = lm_studio_url or LM_STUDIO_URL
    dates = _get_relative_dates(today)
    system_prompt = PARSE_SYSTEM_PROMPT.format(**dates)

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(url, json={
                "model": "local-model",  # LM Studio ignores this, uses whatever is loaded
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": text}
                ],
                "temperature": 0.1,
                "max_tokens": 1024
            })
            resp.raise_for_status()
            data = resp.json()
            content = data["choices"][0]["message"]["content"].strip()

            # Extract JSON from response (strip any markdown fences)
            json_match = re.search(r'\{[\s\S]*\}', content)
            if json_match:
                parsed = json.loads(json_match.group(0))
                return _validate_parsed(parsed, today)
            else:
                raise ValueError(f"No JSON found in response: {content[:200]}")

    except (httpx.ConnectError, httpx.TimeoutException, Exception) as e:
        print(f"LM Studio unavailable ({e}), falling back to regex parser")
        return fallback_parse(text, today)


def _resolve_day(day_name: str, today: date) -> date:
    """Resolve a day name like 'monday', 'last tuesday', 'this wednesday' to a date.
    
    Default interpretation (for logging past workouts):
    - "Monday" → most recent Monday (including today if today is Monday)
    - "This Monday" → upcoming Monday (or today if today is Monday)  
    - "Last Monday" → Monday of previous week
    """
    day_names = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    day_name = day_name.lower().strip()

    # Handle "last X"
    is_last = day_name.startswith("last ")
    if is_last:
        day_name = day_name[5:]

    # Handle "this X"
    is_this = day_name.startswith("this ")
    if is_this:
        day_name = day_name[5:]

    if day_name not in day_names:
        return today

    target_dow = day_names.index(day_name)  # Monday=0
    today_dow = today.weekday()  # Monday=0

    if is_last:
        # "Last Monday" = Monday of previous week
        days_back = (today_dow - target_dow) % 7
        if days_back == 0:
            days_back = 7
        return today - timedelta(days=days_back)
    elif is_this:
        # "This Monday" = upcoming (or today)
        if today_dow == target_dow:
            return today
        days_ahead = (target_dow - today_dow) % 7
        if days_ahead == 0:
            days_ahead = 7
        return today + timedelta(days=days_ahead)
    else:
        # Bare day name (e.g., "Monday") → most recent occurrence
        days_back = (today_dow - target_dow) % 7
        return today - timedelta(days=days_back)


def _parse_exercise_blocks(text: str) -> list[dict]:
    """Extract exercise entries from text using regex."""
    text_clean = re.sub(r'\b(?:at|@)\s*(\d+(?:\.\d+)?)\s*(kg|lb)?', r'@\1\2', text.lower())
    block_pat = r'([a-z][a-z\s]*?)\s*(\d+x\d+|\d+\s*x\s*\d+|single|double|triple)\s*(?:@\s*([\d.]+)\s*(kg|lb)?)?(?:\s*rir\s*(\d+))?'

    exercises = []
    for m in re.findall(block_pat, text_clean):
        name = m[0].strip().rstrip(',').rstrip('and').strip()
        # Strip leading "and "
        name = re.sub(r'^and\s+', '', name).strip()
        if not name or len(name) < 2 or name in ('and', 'or', 'then'):
            continue

        scheme_str = m[1].strip()
        if scheme_str == 'single':
            sets, reps = 1, 1
        elif scheme_str == 'double':
            sets, reps = 1, 2
        elif scheme_str == 'triple':
            sets, reps = 1, 3
        else:
            scheme_clean = re.sub(r'\s+', '', scheme_str)
            parts = scheme_clean.split('x')
            if len(parts) == 2:
                try:
                    sets = int(parts[0])
                    reps = int(parts[1])
                except ValueError:
                    continue
            else:
                continue

        load_val = float(m[2]) if m[2] else None
        load_unit = m[3] if m[3] else 'kg'
        if load_val and load_unit == 'lb':
            load_val = round(load_val * 0.453592, 1)
        rir_val = float(m[4]) if m[4] else None

        exercises.append({
            "name": _standardize_name(name),
            "sets": sets,
            "reps": reps,
            "load_kg": load_val,
            "rir": rir_val,
            "comments": ""
        })
    return exercises


def fallback_parse(text: str, today: date) -> dict:
    """Regex-based fallback parser with multi-day support."""
    text_lower = text.lower().strip()
    day_names = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]

    # Try to split by day markers: "Monday ... Tuesday ..." or "today ... yesterday ..."
    # Build a pattern to detect day boundaries
    day_patterns = [
        r'\b(last\s+)?(this\s+)?(?:' + '|'.join(day_names) + r')\b',
        r'\btoday\b',
        r'\b(?:yesterday|tomorrow)\b',
    ]
    combined = '(' + '|'.join(day_patterns) + ')'

    # Find all day markers and their positions
    segments = []  # [(date, text_between_markers)]
    current_date = today

    matches = list(re.finditer(combined, text_lower))

    if not matches:
        # No day markers found — treat entire text as today
        exercises = _parse_exercise_blocks(text_lower)
        return {"workouts": [{
            "workout_date": today.isoformat(),
            "notes": "",
            "exercises": exercises
        }]}

    for i, m in enumerate(matches):
        marker = m.group(0).strip()

        # Resolve the date for this marker
        if marker == "today":
            current_date = today
        elif marker == "yesterday":
            current_date = today - timedelta(days=1)
        elif marker == "tomorrow":
            current_date = today + timedelta(days=1)
        else:
            current_date = _resolve_day(marker, today)

        # Extract text from this marker to the next marker (or end of string)
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text_lower)
        segment_text = text_lower[start:end].strip().lstrip(',;').strip()

        exercises = _parse_exercise_blocks(segment_text)
        if exercises:
            segments.append({
                "workout_date": current_date.isoformat(),
                "notes": "",
                "exercises": exercises
            })

    # Also check for text before the first marker
    if matches:
        before = text_lower[:matches[0].start()].strip().rstrip(',;').strip()
        if before and len(before) > 3:
            exercises = _parse_exercise_blocks(before)
            if exercises:
                segments.insert(0, {
                    "workout_date": today.isoformat(),
                    "notes": "",
                    "exercises": exercises
                })

    if not segments:
        # Fallback: treat whole text as today
        exercises = _parse_exercise_blocks(text_lower)
        segments = [{"workout_date": today.isoformat(), "notes": "", "exercises": exercises}]

    return {"workouts": segments}


def _standardize_name(name: str) -> str:
    """Standardize common exercise names."""
    name = name.strip().lower()
    aliases = {
        "bench": "bench press",
        "bp": "bench press",
        "deadlift": "deadlift",
        "dl": "deadlift",
        "squat": "squat",
        "sq": "squat",
        "ohp": "overhead press",
        "overhead press": "overhead press",
        "pull up": "pull up",
        "pullup": "pull up",
        "chin up": "chin up",
        "chinup": "chin up",
        "row": "row",
        "barbell row": "barbell row",
        "curl": "curl",
        "dip": "dip",
        "lunge": "lunge",
        "leg press": "leg press",
        "lat pulldown": "lat pulldown",
        "lat pull down": "lat pulldown",
    }
    return aliases.get(name, name)


def _validate_parsed(parsed: dict, today: date) -> dict:
    """Validate and clean up LLM-parsed output. Normalises to {{"workouts": [...]}} format."""

    def _clean_exercises(ex_list):
        clean = []
        for ex in ex_list:
            c = {
                "name": _standardize_name(ex.get("name", "unknown")),
                "sets": int(ex.get("sets", 0)) if ex.get("sets") is not None else 0,
                "reps": int(ex.get("reps", 0)) if ex.get("reps") is not None else 0,
                "load_kg": float(ex["load_kg"]) if ex.get("load_kg") is not None else None,
                "rir": float(ex["rir"]) if ex.get("rir") is not None else None,
                "comments": str(ex.get("comments", "")),
            }
            if c["sets"] > 0 and c["reps"] > 0:
                clean.append(c)
        return clean

    def _clean_workout(w):
        try:
            datetime.strptime(w.get("workout_date", ""), "%Y-%m-%d")
        except (ValueError, TypeError):
            w["workout_date"] = today.isoformat()
        return {
            "workout_date": w["workout_date"],
            "notes": str(w.get("notes", "")),
            "exercises": _clean_exercises(w.get("exercises", []))
        }

    # New format: {"workouts": [...]}
    if "workouts" in parsed and isinstance(parsed["workouts"], list):
        parsed["workouts"] = [_clean_workout(w) for w in parsed["workouts"]]
        parsed["workouts"] = [w for w in parsed["workouts"] if w["exercises"]]
        return parsed

    # Old format: {"workout_date": ..., "exercises": [...]} → normalise
    return {"workouts": [_clean_workout(parsed)]}

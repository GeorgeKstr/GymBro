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

Rules:
- If the user says "today", use TODAY'S DATE.
- If the user says "this tuesday" / "last Monday" / "Wednesday", resolve relative to today.
- If they say "yesterday" or "tomorrow", resolve those.
- If no date is mentioned, assume today.
- Sets×reps: "5x5" means 5 sets of 5 reps. "single" means 1 set of 1 rep.
- Load: "180kg", "180", "at 180", "@180" → load_kg=180. "135lb" → load_kg≈61.2.
- RIR (Reps In Reserve): "rir 2", "2 rir", "2 in the tank" → rir=2.
- Comments: anything about technique, difficulty, sensation, etc.
- Standardise exercise names (e.g., "bench" → "bench press", "squats" → "squat").
- If multiple exercises are mentioned, list them all.
- If sets/reps are missing, use null but try to infer from context.

Examples:
Input: "today I did 5x5 on bench at 180kg"
Output: {{"workout_date":"<today>","notes":"","exercises":[{{"name":"bench press","sets":5,"reps":5,"load_kg":180,"rir":null,"comments":""}}]}}

Input: "this tuesday squat single at 210 and 7x5 at 180"
Output: {{"workout_date":"<this tuesday>","notes":"","exercises":[{{"name":"squat","sets":1,"reps":1,"load_kg":210,"rir":null,"comments":""}},{{"name":"squat","sets":7,"reps":5,"load_kg":180,"rir":null,"comments":""}}]}}

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


def fallback_parse(text: str, today: date) -> dict:
    """Regex-based fallback parser when LM Studio is not available."""
    text_lower = text.lower().strip()

    # --- Date resolution ---
    workout_date = today
    if "today" in text_lower:
        workout_date = today
    elif "yesterday" in text_lower:
        workout_date = today - timedelta(days=1)
    elif "tomorrow" in text_lower:
        workout_date = today + timedelta(days=1)
    elif "this tuesday" in text_lower:
        days_until_tuesday = (1 - today.weekday()) % 7
        if today.weekday() > 1:
            workout_date = today - timedelta(days=(today.weekday() - 1))
        else:
            workout_date = today + timedelta(days=days_until_tuesday if days_until_tuesday > 0 else 0)
    elif "last" in text_lower and any(d in text_lower for d in
                                       ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]):
        day_names = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
        for i, dn in enumerate(day_names):
            if dn in text_lower:
                days_back = (today.weekday() - i) % 7
                if days_back == 0:
                    days_back = 7
                workout_date = today - timedelta(days=days_back)
                break

    # --- Exercise parsing ---
    # Pattern: match exercise name followed by rep scheme and optional weight
    # e.g. "bench 5x5 at 180kg" or "squat single at 210"
    
    # First, find all "X at Y" or "X @ Y" patterns for loads
    # More robust: split on common separators
    exercises = []

    # Try to find exercise blocks: "exercise_name NxM at/@ weight" patterns
    # Also handle "single", "double", "triple"
    text_clean = re.sub(r'(?:at|@)\s*(\d+(?:\.\d+)?)\s*(kg|lb)?', r'@\1\2', text_lower)
    
    # Pattern for exercise blocks:
    # (name) (sets)x(reps) or (name) single/double/triple ... @weight ... rir X
    block_pat = r'([a-z][a-z\s]*?)\s*(\d+x\d+|\d+\s*x\s*\d+|single|double|triple)\s*(?:@\s*([\d.]+)\s*(kg|lb)?)?(?:\s*rir\s*(\d+))?'
    
    matches = re.findall(block_pat, text_lower)
    
    for m in matches:
        name = m[0].strip().rstrip(',').rstrip('and').strip()
        if not name or len(name) < 2:
            continue
            
        scheme_str = m[1].strip()
        if scheme_str in ('single',):
            sets, reps = 1, 1
        elif scheme_str in ('double',):
            sets, reps = 1, 2
        elif scheme_str in ('triple',):
            sets, reps = 1, 3
        else:
            # Clean up "5 x 5" → "5x5"
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

        # Extract comments: anything after rir or between exercises
        comments = ""

        exercises.append({
            "name": _standardize_name(name),
            "sets": sets,
            "reps": reps,
            "load_kg": load_val,
            "rir": rir_val,
            "comments": comments
        })

    # Extract any overall notes (text that isn't part of exercise blocks)
    notes = ""
    # Remove exercise blocks from text to get notes
    remaining = text_lower
    for pat in [r'\d+x\d+', r'single', r'double', r'triple', r'@[\d.]+', r'rir\s*\d+',
                r'this tuesday', r'today', r'yesterday', r'tomorrow', r'last \w+day',
                r'i did', r'on ']:
        remaining = re.sub(pat, '', remaining)
    # Clean up remaining
    remaining = re.sub(r'[,;]\s*[,;]', '', remaining)
    remaining = ' '.join(remaining.split()).strip()
    if remaining and len(remaining) > 5:
        notes = remaining

    return {
        "workout_date": workout_date.isoformat(),
        "notes": notes,
        "exercises": exercises if exercises else []
    }


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
    """Validate and clean up LLM-parsed output."""
    # Ensure workout_date is valid
    try:
        datetime.strptime(parsed.get("workout_date", ""), "%Y-%m-%d")
    except (ValueError, TypeError):
        parsed["workout_date"] = today.isoformat()

    if "notes" not in parsed:
        parsed["notes"] = ""

    if "exercises" not in parsed or not isinstance(parsed["exercises"], list):
        parsed["exercises"] = []

    clean_exercises = []
    for ex in parsed["exercises"]:
        clean = {
            "name": _standardize_name(ex.get("name", "unknown")),
            "sets": int(ex.get("sets", 0)) if ex.get("sets") is not None else 0,
            "reps": int(ex.get("reps", 0)) if ex.get("reps") is not None else 0,
            "load_kg": float(ex["load_kg"]) if ex.get("load_kg") is not None else None,
            "rir": float(ex["rir"]) if ex.get("rir") is not None else None,
            "comments": str(ex.get("comments", "")),
        }
        if clean["sets"] > 0 and clean["reps"] > 0:
            clean_exercises.append(clean)

    parsed["exercises"] = clean_exercises
    return parsed

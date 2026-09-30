"""
AI integration: parse natural language gym entries into structured data.

Two provider modes (chosen automatically, driven by .env / environment):
  - Cloud (default when AI_API_KEY is set): any OpenAI-compatible provider —
    OpenAI, Groq, OpenRouter, DeepSeek, Together, LM Studio behind a VPN, ...
    Configured via AI_BASE_URL / AI_API_KEY / AI_MODEL.
  - LM Studio (local fallback/development): AI_PROVIDER=lmstudio or no API
    key present → uses LM_STUDIO_URL without authentication.

If the provider is unreachable, a regex fallback parser is used.
"""

import json
import re
import httpx
import config
from datetime import date, datetime, timedelta
from typing import Optional

# Local LM Studio endpoint (development / offline testing)
LM_STUDIO_URL = config.get("LM_STUDIO_URL", "http://localhost:1234/v1/chat/completions")


def _ai_settings(lm_studio_url: str | None = None) -> dict:
    """Resolve which AI endpoint to use.

    Cloud is active when AI_API_KEY is configured and AI_PROVIDER is not
    explicitly 'lmstudio'. Otherwise the local LM Studio endpoint is used
    (allowing the client to override the URL, useful for testing).
    """
    key = config.get("AI_API_KEY") or ""
    provider = (config.get("AI_PROVIDER") or "").lower().strip()
    use_cloud = bool(key) and provider != "lmstudio"

    if use_cloud:
        base = (config.get("AI_BASE_URL") or "https://api.openai.com/v1").rstrip("/")
        return {
            "url": f"{base}/chat/completions",
            "model": config.get("AI_MODEL", "gpt-4o-mini"),
            "key": key,
            "cloud": True,
            "no_think": (config.get("AI_NO_THINK") or "true").strip().lower() in ("1", "true", "yes"),
            "provider_name": _provider_name(base),
        }

    return {
        "url": lm_studio_url or LM_STUDIO_URL,
        "model": "local-model",  # LM Studio serves the loaded model
        "key": "",
        "cloud": False,
        "no_think": (config.get("AI_NO_THINK") or "true").strip().lower() in ("1", "true", "yes"),
        "provider_name": "lmstudio",
    }


def _provider_name(base: str) -> str:
    host = re.sub(r"^https?://", "", base).split("/")[0]
    if "openai" in host:
        return "openai"
    if "openrouter" in host:
        return "openrouter"
    if "groq" in host:
        return "groq"
    if "deepseek" in host:
        return "deepseek"
    if "together" in host:
        return "together"
    if "anthropic" in host:
        return "anthropic"
    if "gemini" in host or "generativelanguage" in host:
        return "gemini"
    return host

PARSE_SYSTEM_PROMPT = """You are a gym workout assistant helping both TRAINERS (planning future sessions) and TRAINEES (logging past sessions). Extract structured data from the user's natural language description as a PLAN MERGE — you are told existing data will be kept.

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
  ],
  "blocks": [
    {{
      "block_name": "training block name (from phrases like 'start a block called Hypertrophy')",
      "color": "#rrggbb colour from the text, or empty string",
      "days": ["YYYY-MM-DD", "..."]
    }}
  ]
}}

The "blocks" array is OPTIONAL — only output it when the text is about training BLOCKS (e.g. "create a block called Strength for the next 4 weeks", "assign next week's Mon/Wed/Fri to my Hypertrophy block", "start a new block"). Enumerate every concrete workout day covered by the block (same relative-date expansion rules as above). Leave "color" as "" unless a colour is named.

Rules:
- ALWAYS output the "workouts" array, even if there is only one workout.
- MERGE SEMANTICS: you are ADDING to existing data. The application keeps any exercises the user already has on those days and does not delete anything. Only describe exercises that should exist after this instruction.
- EXPAND RECURRING REQUESTS: "every Tuesday for the next 4 weeks", "Mon/Wed/Fri for 3 weeks starting tomorrow" etc. must be enumerated as one workout object per concrete date.
- DURATION RANGES: "for the next 20 days", "every day for 2 weeks" etc. mean one identical workout PER DAY for the whole span — enumerate one workout object per date starting today. "for N weeks" with named weekdays (e.g. "Mon/Wed/Fri for 3 weeks") means only those weekdays.
- PERCENTAGE loads: "70% to 85%" without an absolute weigh-in → ramp across the range dates and say e.g. comments="~70-85% of 1RM". If a base load is given use it.
- MULTI-DAY descriptions: split into one workout object per date.
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
- BLOCKS: recurring-block requests must enumerate their days in the blocks array (one entry per block); do NOT put block-only text into workouts.

Examples:
Input: "today I did 5x5 on bench at 180kg"
Output: {{"workouts":[{{"workout_date":"<today>","notes":"","exercises":[{{"name":"bench press","sets":5,"reps":5,"load_kg":180,"rir":null,"comments":""}}]}}]}}

Input: "monday bench 5x5 at 180, tuesday squat 3x8 at 140 rir 2"
Output: {{"workouts":[{{"workout_date":"<monday>","notes":"","exercises":[{{"name":"bench press","sets":5,"reps":5,"load_kg":180,"rir":null,"comments":""}}]}},{{"workout_date":"<tuesday>","notes":"","exercises":[{{"name":"squat","sets":3,"reps":8,"load_kg":140,"rir":2,"comments":""}}]}}],"blocks":[]}}

Input: "start a 3-week strength block, training Mon/Wed/Fri"
Output: {{"workouts":[],"blocks":[{{"block_name":"strength","color":"","days":["<this monday>","<wed>","<fri>","<next monday>","<next wed>","<next fri>","<mon after>","<wed after>","<fri after>"]}}]}}

Today's date is: {today}
This Tuesday is: {this_tuesday}
Last Monday was: {last_monday}
Yesterday was: {yesterday}
Tomorrow is: {tomorrow}
"""


DURATION_RANGE_RE = re.compile(
    r'\b(?:for\s+)?(?:the\s+)?next\s+(\d+)\s+(day|week)s?\b'
    r'|\bfor\s+(\d+)\s+(day|week)s?\b', re.I)


def _expand_duration_range(text: str, parsed: dict, today: date) -> dict:
    """Deterministic safety net for duration-range requests like
    'for the next 20 days add a 5x5 squat at 200kg'.

    When the text names a day-count range and the model returned exactly
    ONE workout, replicate that workout across every date of the span
    (starting today). Skipped when the request is block-related (blocks
    enumerate their own days) or the model already enumerated multiple
    workouts."""
    if not isinstance(parsed, dict):
        return parsed
    m = DURATION_RANGE_RE.search(text or "")
    if not m:
        return parsed
    n = int(m.group(1) or m.group(3))
    unit = (m.group(2) or m.group(4) or "").lower()
    if unit == "week":
        # weekly spans only expand when every single day is implied
        if not re.search(r'\b(every day|daily|each day)\b', text or "", re.I):
            return parsed
        n *= 7
    n = max(1, min(n, 90))
    workouts = parsed.get("workouts") or []
    if parsed.get("blocks"):
        return parsed
    if len(workouts) != 1 or not workouts[0].get("exercises"):
        return parsed
    template = workouts[0]
    expanded = []
    for i in range(n):
        w = dict(template)
        w["workout_date"] = (today + timedelta(days=i)).isoformat()
        expanded.append(w)
    parsed["workouts"] = expanded
    return parsed


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
    Send natural language text to the configured AI provider and parse into
    structured workout data. Falls back to regex-based parsing on failure.

    When a cloud provider is configured, requests go there with the server's
    API key; client-provided lm_studio_url overrides are ignored for safety.
    """
    if today is None:
        today = date.today()

    ai = _ai_settings(lm_studio_url if not ai_cloud_configured() else None)
    dates = _get_relative_dates(today)
    system_prompt = PARSE_SYSTEM_PROMPT.format(**dates)

    headers = {"Content-Type": "application/json"}
    if ai["key"]:
        headers["Authorization"] = f"Bearer {ai['key']}"

    payload = {
        "model": ai["model"],
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": text}
        ],
        "temperature": 0.1,
        "max_tokens": 4096,  # long recurring expansions (e.g. 20 days) need room
    }
    # Non-thinking mode (Qwen-style chat template switch); honoured by
    # OpenCode Zen, vLLM and LM Studio. Disable with AI_NO_THINK=false.
    if ai["no_think"]:
        payload["chat_template_kwargs"] = {"enable_thinking": False}

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(ai["url"], json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            content = data["choices"][0]["message"]["content"].strip()

            # Extract JSON from response (strip any markdown fences)
            json_match = re.search(r'\{[\s\S]*\}', content)
            if json_match:
                parsed = json.loads(json_match.group(0))
                return _expand_duration_range(text, _validate_parsed(parsed, today), today)
            else:
                raise ValueError(f"No JSON found in response: {content[:200]}")

    except (httpx.ConnectError, httpx.TimeoutException, Exception) as e:
        print(f"AI provider unavailable ({ai['provider_name']} @ {ai['url']}): {e}; "
              f"falling back to regex parser")
        return fallback_parse(text, today)


def ai_cloud_configured() -> bool:
    """True when a cloud provider is active (key set, not forced to lmstudio)."""
    return _ai_settings()["cloud"]


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
    text_clean = re.sub(r'\b(?:at|@)\s*(\d+(?:\.\d+)?)\s*(kg|lb)?\s*', r'@\1\2 ', text.lower())
    # Strip leading filler phrases so "add a 5x5 squat" parses as "5x5 squat"
    text_clean = re.sub(
        r'^\s*(?:please\b|can you\b|could you\b)?[\s,]*'
        r'(?:i\s+)?(?:want\s+to\s+|would\s+like\s+to\s+)?'
        r'(?:add|added|log|logged|did|do|plan|planned|schedule|scheduled)\s+'
        r'(?:a\s+|an\s+|the\s+|my\s+)?', '', text_clean)
    block_pat = r'([a-z][a-z\s]*?)\s*(\d+x\d+|\d+\s*x\s*\d+|single|double|triple)\s*(?:@\s*([\d.]+)\s*(kg|lb)?)?(?:\s*rir\s*(\d+))?'

    exercises = []
    last_name = None
    for m in re.findall(block_pat, text_clean):
        name = m[0].strip().rstrip(',').rstrip('and').strip()
        # Strip leading "and "
        name = re.sub(r'^and\s+', '', name).strip()
        scheme_str = m[1].strip()
        # A scheme whose "name" is just a connector ("... single at 210 and
        # 7x5 at 180") is a second entry for the previous exercise.
        if (not name or name in ('and', 'or', 'then')) and last_name and exercises:
            name = last_name
        elif not name or len(name) < 2 or name in ('and', 'or', 'then'):
            continue
        else:
            last_name = name

        ex = _build_exercise(name, scheme_str, m[2], m[3], m[4])
        if ex:
            exercises.append(ex)

    # Scheme-first phrasing: "5x5 squat at 200kg" (name AFTER the scheme).
    # The primary pattern only matches name-before-scheme order.
    if not exercises:
        inv_pat = (r'(\d+x\d+|\d+\s*x\s*\d+|single|double|triple)\s+'
                   r'([a-z][a-z\s]*?)'
                   r'(?:\s*(?:@|at\s+)\s*([\d.]+)\s*(kg|lb)?)?'
                   r'(?:\s*rir\s*(\d+))?'
                   r'(?=\s*(?:\brir\b|[,;.!]|$))')
        for m in re.findall(inv_pat, text_clean):
            name = m[1].strip().rstrip(',').rstrip('and').strip()
            name = re.sub(r'^and\s+', '', name).strip()
            if not name or len(name) < 2:
                continue
            ex = _build_exercise(name, m[0].strip(), m[2], m[3], m[4])
            if ex:
                exercises.append(ex)
    return exercises


def _build_exercise(name: str, scheme_str: str,
                    load_val: str | None, load_unit: str | None,
                    rir_val: str | None) -> dict | None:
    """Turn a name + rep-scheme + load/rir captures into an exercise dict."""
    # The lazy name capture often swallows sentence filler ("on bench",
    # "the squat", "my deadlift"). Strip leading stop-words repeatedly.
    for _ in range(4):
        new_name = re.sub(r'^(?:on|of|the|a|an|my|with|and|or|i|did|did a|for)\s+', '', name)
        if new_name == name:
            break
        name = new_name
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
                return None
        else:
            return None

    load = float(load_val) if load_val else None
    unit = load_unit or 'kg'
    if load and unit == 'lb':
        load = round(load * 0.453592, 1)
    rir = float(rir_val) if rir_val else None

    return {
        "name": _standardize_name(name),
        "sets": sets,
        "reps": reps,
        "load_kg": load,
        "rir": rir,
        "comments": ""
    }


def fallback_parse(text: str, today: date) -> dict:
    """Regex-based fallback parser with multi-day support."""
    text_lower = text.lower().strip()

    # Strip duration-range phrases first ("for the next 20 days") so they
    # don't pollute exercise-name extraction; the range itself is applied
    # by _expand_duration_range below.
    text_lower = DURATION_RANGE_RE.sub(' ', text_lower)

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
        result = {"workouts": [{
            "workout_date": today.isoformat(),
            "notes": "",
            "exercises": exercises
        }]}
        return _expand_duration_range(text, result, today)

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
        # optional blocks [{block_name, color, days:[...]}]
        blocks = parsed.get("blocks") if isinstance(parsed.get("blocks"), list) else []
        clean_blocks = []
        for b in blocks:
            if not isinstance(b, dict):
                continue
            name = str(b.get("block_name", "")).strip()
            if not name:
                continue
            days = []
            for d in (b.get("days") or []):
                try:
                    datetime.strptime(str(d), "%Y-%m-%d")
                    days.append(str(d))
                except (ValueError, TypeError):
                    pass
            color = str(b.get("color") or "").strip()
            if color and not re.match(r"^#[0-9a-fA-F]{6}$", color):
                color = ""
            if days:
                clean_blocks.append({"block_name": name[:60], "color": color, "days": sorted(set(days))})
        parsed["blocks"] = clean_blocks
        return parsed

    # Old format: {"workout_date": ..., "exercises": [...]} → normalise
    return {"workouts": [_clean_workout(parsed)]}


def ai_chat_reply(context_messages: list[dict], system_note: str) -> str:
    """Generic chat completion for the coach/trainee chat widget.

    context_messages: [{role: 'system'|'user'|'assistant', content: ...}]
    Returns plain text, or raises when no AI provider is configured.
    """
    ai = _ai_settings()
    headers = {"Content-Type": "application/json"}
    if ai["key"]:
        headers["Authorization"] = f"Bearer {ai['key']}"
    payload = {
        "model": ai["model"],
        "messages": [
            {"role": "system", "content": system_note},
            *context_messages,
        ],
        "temperature": 0.4,
        "max_tokens": 300,
    }
    if ai.get("no_think"):
        payload["chat_template_kwargs"] = {"enable_thinking": False}

    import asyncio
    async def _post():
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(ai["url"], json=payload, headers=headers)
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"].strip()
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = None
    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor() as ex:
        return ex.submit(asyncio.run, _post()).result()

/**
 * GymBro — Frontend App
 * Week-row calendar, NL parsing, workout CRUD, rep-load calculator.
 */

// ────────────────────────────────────────
// State
// ────────────────────────────────────────

const state = {
  currentYear: new Date().getFullYear(),
  todaysDate: new Date().toISOString().slice(0, 10),
  workouts: {},
  selectedDate: null,
  parsedWorkout: null,
  sidebarVisible: true,
};

// ────────────────────────────────────────
// DOM refs
// ────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const dom = {
  currentYear: $("#current-year"),
  lmStatus: $("#lm-status"),
  sidebar: $("#sidebar"),
  btnToggleSidebar: $("#btn-toggle-sidebar"),
  nlInput: $("#nl-input"),
  btnParse: $("#btn-parse"),
  btnQuickSave: $("#btn-quick-save"),
  parseResult: $("#parse-result"),
  detailTitle: $("#detail-title"),
  detailContent: $("#detail-content"),
  calendarContainer: $("#calendar-container"),
  btnYearPrev: $("#btn-year-prev"),
  btnYearNext: $("#btn-year-next"),
  btnToday: $("#btn-today"),
  toast: $("#toast"),
  calcSourceText: $("#calc-source-text"),
  btnParseSource: $("#btn-parse-source"),
  calcSrcSets: $("#calc-src-sets"),
  calcSrcReps: $("#calc-src-reps"),
  calcSrcLoad: $("#calc-src-load"),
  calcSrcRir: $("#calc-src-rir"),
  calcE1rm: $("#calc-e1rm"),
  calcTgtReps: $("#calc-tgt-reps"),
  calcTgtRir: $("#calc-tgt-rir"),
  calcTgtSets: $("#calc-tgt-sets"),
  btnConvert: $("#btn-convert"),
  calcResults: $("#calc-results"),
};

// ────────────────────────────────────────
// API helpers
// ────────────────────────────────────────

async function api(method, path, body = null) {
  const opts = { method, headers: body ? { "Content-Type": "application/json" } : {} };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(path, opts);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ detail: resp.statusText }));
    throw new Error(err.detail || `HTTP ${resp.status}`);
  }
  return resp.json();
}

// ────────────────────────────────────────
// Toast
// ────────────────────────────────────────

let toastTimer;
function showToast(msg, type = "success") {
  clearTimeout(toastTimer);
  dom.toast.textContent = msg;
  dom.toast.className = `toast ${type}`;
  toastTimer = setTimeout(() => dom.toast.classList.add("hidden"), 3000);
}

// ────────────────────────────────────────
// Load workouts
// ────────────────────────────────────────

async function loadWorkouts(year) {
  try {
    const data = await api("GET", `/api/workouts?year=${year}`);
    state.workouts = {};
    for (const w of data) state.workouts[w.date] = w;
    console.log(`GymBro: loaded ${data.length} workouts for ${year}`, Object.keys(state.workouts));
    renderCalendar(year);
  } catch (e) {
    console.error('GymBro: loadWorkouts failed', e);
    showToast(`Failed to load workouts: ${e.message}`, "error");
  }
}

// ────────────────────────────────────────
// Calendar — Weekly Row View
// ────────────────────────────────────────

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];
const DOW_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Get ISO week number for a date */
function getISOWeek(d) {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  return Math.ceil((((dt - yearStart) / 86400000) + 1) / 7);
}

function renderCalendar(year) {
  dom.currentYear.textContent = year;
  state.currentYear = year;

  let html = '<table class="calendar-table"><thead>';

  // Day-of-week header
  html += '<tr class="calendar-dow-row"><th>Wk</th>';
  for (const d of DOW_SHORT) {
    html += `<th>${d}</th>`;
  }
  html += '</tr></thead><tbody>';

  // Generate all weeks of the year
  // Start from the Monday of the week containing Jan 1
  const jan1 = new Date(year, 0, 1);
  const jan1Dow = jan1.getDay(); // 0=Sun
  // Monday of the week containing Jan 1 (ISO: week starts Mon, if Jan 1 is Thu-Sun it belongs to prev year's week)
  // For display, we want the Monday on or before Jan 1
  const daysFromMon = jan1Dow === 0 ? 6 : jan1Dow - 1; // days from Monday
  let cursor = new Date(year, 0, 1 - daysFromMon); // Monday of week containing Jan 1

  const yearEnd = new Date(year, 11, 31);
  let lastMonth = -1;
  let weekRows = [];

  while (cursor <= yearEnd || cursor.getDay() !== 1) {
    const week = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(cursor);
      d.setDate(cursor.getDate() + i);
      week.push(d);
    }

    // Determine which month this week "belongs to" (majority rule)
    const monthTally = {};
    week.forEach(d => {
      const m = d.getMonth();
      monthTally[m] = (monthTally[m] || 0) + 1;
    });
    let bestMonth = week[3].getMonth(); // default to Thursday's month (ISO rule)
    let bestCount = 0;
    for (const [m, c] of Object.entries(monthTally)) {
      if (c > bestCount) { bestCount = c; bestMonth = parseInt(m); }
    }

    weekRows.push({ days: week, month: bestMonth, weekNum: getISOWeek(week[0]) });

    // Advance to next Monday
    cursor.setDate(cursor.getDate() + 7);
  }

  // Render rows
  for (const row of weekRows) {
    // Month label if month changed
    if (row.month !== lastMonth) {
      lastMonth = row.month;
      html += `<tr><td colspan="8" class="calendar-month-label">${MONTH_NAMES[row.month]} ${year}</td></tr>`;
    }

    html += '<tr class="calendar-week-row">';
    html += `<td class="calendar-week-num">${row.weekNum}</td>`;

    for (const d of row.days) {
      const dateStr = fmtDate(d);
      const inYear = d.getFullYear() === year;
      const isToday = dateStr === state.todaysDate;
      const isSelected = dateStr === state.selectedDate;
      const workout = state.workouts[dateStr];

      let cls = 'calendar-day';
      if (!inYear) cls += ' out-of-month';
      if (isToday) cls += ' today';
      if (isSelected) cls += ' selected';

      html += `<td class="${cls}" data-date="${dateStr}">`;
      html += `<div class="calendar-day-num">${d.getDate()}</div>`;

      if (workout && workout.exercises && workout.exercises.length > 0) {
        for (const ex of workout.exercises) {
          html += renderExerciseBadge(ex);
        }
      } else {
        html += '<div class="empty-day">—</div>';
      }

      html += '</td>';
    }

    html += '</tr>';
  }

  html += '</tbody></table>';
  dom.calendarContainer.innerHTML = html;

  // Click handlers on day cells
  dom.calendarContainer.querySelectorAll('.calendar-day').forEach(cell => {
    cell.addEventListener('click', (e) => {
      // Don't select if clicking on an exercise badge (it opens the day for editing)
      const date = cell.dataset.date;
      selectDate(date);
    });
  });
}

function renderExerciseBadge(ex) {
  const load = ex.load_kg != null ? `${ex.load_kg}kg` : '';
  const rir = ex.rir != null ? ` RIR${ex.rir}` : '';
  const detail = [load, rir].filter(Boolean).join(' ');
  const comment = ex.comments ? `<span class="ex-comment">${escHtml(ex.comments)}</span>` : '';

  return `
    <div class="day-exercise" title="${escHtml(ex.name)}: ${ex.sets}×${ex.reps} ${detail} ${escHtml(ex.comments || '')}">
      <span class="ex-name">${escHtml(ex.name)}</span>
      <span class="ex-detail">${ex.sets}×${ex.reps} ${detail}</span>
      ${comment}
    </div>`;
}

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function selectDate(dateStr) {
  state.selectedDate = dateStr;
  renderCalendar(state.currentYear);
  renderDetail(dateStr);

  // Scroll to the selected day
  const cell = dom.calendarContainer.querySelector(`.calendar-day[data-date="${dateStr}"]`);
  if (cell) cell.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ────────────────────────────────────────
// Detail panel
// ────────────────────────────────────────

function renderDetail(dateStr) {
  dom.detailTitle.textContent = `📋 ${dateStr}`;
  const workout = state.workouts[dateStr];

  if (!workout || workout.exercises.length === 0) {
    dom.detailContent.innerHTML = `
      <div class="detail-placeholder">
        <p>No workout logged for this day.</p>
        <button class="btn-secondary" style="margin-top:6px" id="btn-manual-add">+ Add Exercise</button>
      </div>`;
    $("#btn-manual-add")?.addEventListener("click", () => addManualExercise(dateStr));
    return;
  }

  let html = '<div class="workout-detail">';
  html += '<div class="ex-row header">';
  html += '<span>Exercise</span><span>Sets</span><span>Reps</span><span>Load</span><span>Comments</span><span></span>';
  html += '</div>';

  workout.exercises.forEach((ex) => {
    html += `
      <div class="ex-row" data-id="${ex.id}">
        <input type="text" class="ex-name" value="${escHtml(ex.name)}" data-field="name">
        <input type="number" class="ex-sets" value="${ex.sets}" data-field="sets" min="0">
        <input type="number" class="ex-reps" value="${ex.reps}" data-field="reps" min="0">
        <input type="number" class="ex-load" value="${ex.load_kg ?? ''}" data-field="load_kg" placeholder="—" step="0.5">
        <input type="text" class="ex-comments" value="${escHtml(ex.comments || '')}" data-field="comments" placeholder="notes">
        <button class="btn-small btn-danger ex-delete" data-id="${ex.id}">✕</button>
      </div>`;
  });

  html += `
    <div class="detail-actions">
      <button id="btn-add-ex" class="btn-secondary">+ Add</button>
      <button id="btn-save-detail" class="btn-primary">💾 Save</button>
      <button id="btn-delete-workout" class="btn-danger">🗑 Delete Day</button>
    </div>`;
  html += '</div>';
  dom.detailContent.innerHTML = html;

  $("#btn-add-ex")?.addEventListener("click", () => addManualExercise(dateStr));
  $("#btn-save-detail")?.addEventListener("click", () => saveDetailChanges(dateStr));
  $("#btn-delete-workout")?.addEventListener("click", () => deleteWorkout(dateStr));

  $$(".ex-delete").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      try {
        await api("DELETE", `/api/exercises/${id}`);
        await refreshWorkouts();
        selectDate(dateStr);
        showToast("Exercise deleted");
      } catch (e) {
        showToast(`Error: ${e.message}`, "error");
      }
    });
  });
}

function addManualExercise(dateStr) {
  if (!state.workouts[dateStr]) {
    state.workouts[dateStr] = { date: dateStr, notes: "", exercises: [] };
  }
  state.workouts[dateStr].exercises.push({
    id: -Date.now(),
    name: "",
    sets: 0,
    reps: 0,
    load_kg: null,
    rir: null,
    comments: "",
    _new: true,
  });
  renderDetail(dateStr);
  const lastInput = dom.detailContent.querySelector(".ex-row:last-of-type .ex-name");
  if (lastInput) lastInput.focus();
}

async function saveDetailChanges(dateStr) {
  const rows = dom.detailContent.querySelectorAll(".ex-row:not(.header)");
  const exercises = [];
  rows.forEach(row => {
    const getVal = (cls) => row.querySelector(`.${cls}`)?.value || '';
    exercises.push({
      id: row.dataset.id ? parseInt(row.dataset.id) : null,
      name: getVal("ex-name").trim() || "unknown",
      sets: parseInt(getVal("ex-sets")) || 0,
      reps: parseInt(getVal("ex-reps")) || 0,
      load_kg: getVal("ex-load") ? parseFloat(getVal("ex-load")) : null,
      rir: null,
      comments: getVal("ex-comments").trim(),
    });
  });
  const valid = exercises.filter(e => e.name && e.sets > 0 && e.reps > 0);
  try {
    await api("POST", "/api/workouts", {
      workout_date: dateStr,
      notes: state.workouts[dateStr]?.notes || "",
      exercises: valid,
    });
    await refreshWorkouts();
    selectDate(dateStr);
    showToast("Workout saved! 💪");
  } catch (e) {
    showToast(`Save failed: ${e.message}`, "error");
  }
}

async function deleteWorkout(dateStr) {
  if (!confirm(`Delete workout for ${dateStr}?`)) return;
  try {
    await api("DELETE", `/api/workouts/${dateStr}`);
    await refreshWorkouts();
    state.selectedDate = null;
    renderCalendar(state.currentYear);
    dom.detailTitle.textContent = "📋 No day selected";
    dom.detailContent.innerHTML = '<div class="detail-placeholder">Click a date in the calendar to view or edit.</div>';
    showToast("Workout deleted");
  } catch (e) {
    showToast(`Error: ${e.message}`, "error");
  }
}

// ────────────────────────────────────────
// NL Parsing
// ────────────────────────────────────────

async function parseWorkout() {
  const text = dom.nlInput.value.trim();
  if (!text) { showToast("Enter a workout description first", "error"); return; }

  dom.btnParse.disabled = true;
  dom.btnParse.textContent = "⏳ Parsing...";
  dom.parseResult.classList.remove("hidden");
  dom.parseResult.innerHTML = '<p style="color:var(--text-dim)">Asking LLM to parse...</p>';

  try {
    const parsed = await api("POST", "/api/parse", { text, today: state.todaysDate });
    state.parsedWorkout = parsed;
    renderParseResult(parsed);
  } catch (e) {
    dom.parseResult.innerHTML = `<p style="color:var(--red)">Parse failed: ${e.message}</p>
      <p style="color:var(--text-dim);font-size:0.75rem;">Is LM Studio running at localhost:1234?</p>`;
  } finally {
    dom.btnParse.disabled = false;
    dom.btnParse.textContent = "🔍 Parse with LLM";
  }
}

async function quickSave() {
  const text = dom.nlInput.value.trim();
  if (!text) { showToast("Enter a workout description first", "error"); return; }
  try {
    const parsed = await api("POST", "/api/parse", {
      text, today: state.todaysDate, lm_studio_url: "http://localhost:1"
    });
    state.parsedWorkout = parsed;
    await confirmSave();
  } catch (e) {
    showToast(`Quick save failed: ${e.message}`, "error");
  }
}

function renderParseResult(parsed) {
  const exs = parsed.exercises || [];
  if (exs.length === 0) {
    dom.parseResult.innerHTML = '<p style="color:var(--orange)">No exercises detected. Try being more specific.</p>';
    return;
  }
  let html = `<p style="margin-bottom:4px;font-weight:600;">📅 ${parsed.workout_date}</p>`;
  html += '<ul class="ex-list">';
  exs.forEach(ex => {
    const loadStr = ex.load_kg ? ` @ ${ex.load_kg}kg` : '';
    const rirStr = ex.rir != null ? ` RIR ${ex.rir}` : '';
    const cmtStr = ex.comments ? ` — ${ex.comments}` : '';
    html += `<li class="ex-item">🏋️ <strong>${ex.name}</strong>: ${ex.sets}×${ex.reps}${loadStr}${rirStr}${cmtStr}</li>`;
  });
  html += '</ul>';
  if (parsed.notes) {
    html += `<p style="margin-top:2px;font-size:0.75rem;color:var(--text-dim)">📝 ${escHtml(parsed.notes)}</p>`;
  }
  html += `
    <div class="confirm-row">
      <button id="btn-confirm-save" class="btn-primary">✅ Confirm & Save</button>
      <button id="btn-cancel-parse" class="btn-secondary">Cancel</button>
    </div>`;
  dom.parseResult.innerHTML = html;
  $("#btn-confirm-save")?.addEventListener("click", confirmSave);
  $("#btn-cancel-parse")?.addEventListener("click", () => {
    state.parsedWorkout = null;
    dom.parseResult.classList.add("hidden");
  });
}

async function confirmSave() {
  if (!state.parsedWorkout) return;
  const pw = state.parsedWorkout;
  console.log('GymBro: saving workout', pw);
  try {
    const saved = await api("POST", "/api/workouts", pw);
    console.log('GymBro: saved response', saved);
    dom.parseResult.classList.add("hidden");
    dom.nlInput.value = "";
    state.parsedWorkout = null;
    await refreshWorkouts();
    selectDate(pw.workout_date);
    showToast(`Workout saved for ${pw.workout_date}! 💪`);
  } catch (e) {
    console.error('GymBro: save failed', e);
    showToast(`Save failed: ${e.message}`, "error");
  }
}

// ────────────────────────────────────────
// Calculator
// ────────────────────────────────────────

function updateE1rm() {
  const reps = parseInt(dom.calcSrcReps.value) || 1;
  const load = parseFloat(dom.calcSrcLoad.value) || 0;
  const rir = parseFloat(dom.calcSrcRir.value) || 0;
  const e1rm = load * (1 + (reps + rir) / 30);
  dom.calcE1rm.textContent = e1rm.toFixed(1);
}

async function convertScheme() {
  const srcSets = parseInt(dom.calcSrcSets.value) || 1;
  const srcReps = parseInt(dom.calcSrcReps.value) || 1;
  const srcLoad = parseFloat(dom.calcSrcLoad.value) || 0;
  const srcRir = parseFloat(dom.calcSrcRir.value) || 0;
  const tgtReps = parseInt(dom.calcTgtReps.value) || 1;
  const tgtRir = parseFloat(dom.calcTgtRir.value) || 0;
  const tgtSetsVal = dom.calcTgtSets.value;
  const tgtSets = tgtSetsVal ? parseInt(tgtSetsVal) : null;

  try {
    const result = await api("POST", "/api/calculator/convert", {
      source_sets: srcSets, source_reps: srcReps, source_load: srcLoad,
      source_rir: srcRir, target_reps: tgtReps, target_rir: tgtRir,
      target_sets: tgtSets,
    });
    dom.calcE1rm.textContent = result.source.e1rm.toFixed(1);

    let h = '<table><thead><tr><th>Sets</th><th>Reps</th><th>Load</th><th>RIR</th><th>Match</th></tr></thead><tbody>';
    for (const c of result.conversions) {
      h += `<tr>
        <td>${c.sets}</td><td>${c.reps}</td><td><strong>${c.load_kg}</strong></td>
        <td>${c.rir}</td><td class="match-${c.difficulty_match}">${c.difficulty_match}</td></tr>`;
    }
    h += '</tbody></table>';
    dom.calcResults.innerHTML = h;
  } catch (e) {
    dom.calcResults.innerHTML = `<p style="color:var(--red)">Error: ${e.message}</p>`;
  }
}

async function parseSourceScheme() {
  const text = dom.calcSourceText.value.trim();
  if (!text) return;
  try {
    const scheme = await api("POST", "/api/calculator/parse-scheme", { text });
    dom.calcSrcSets.value = scheme.sets;
    dom.calcSrcReps.value = scheme.reps;
    dom.calcSrcLoad.value = scheme.load_kg;
    dom.calcSrcRir.value = scheme.rir;
    updateE1rm();
  } catch (e) {
    showToast("Could not parse scheme. Use: 5x5 @ 180kg rir 2", "error");
  }
}

// ────────────────────────────────────────
// LM Status
// ────────────────────────────────────────

async function checkLmStatus() {
  try {
    const data = await api("GET", "/api/lm-status");
    if (data.connected) {
      dom.lmStatus.className = "status-dot connected";
      dom.lmStatus.title = `LM Studio: ${data.models.join(", ") || "model loaded"}`;
    } else {
      dom.lmStatus.className = "status-dot disconnected";
      dom.lmStatus.title = "LM Studio not reachable — fallback parser active";
    }
  } catch {
    dom.lmStatus.className = "status-dot disconnected";
    dom.lmStatus.title = "LM Studio not reachable";
  }
}

// ────────────────────────────────────────
// Utility
// ────────────────────────────────────────

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

async function refreshWorkouts() {
  await loadWorkouts(state.currentYear);
}

// ────────────────────────────────────────
// Init
// ────────────────────────────────────────

function init() {
  // Year nav
  dom.btnYearPrev.addEventListener("click", () => {
    state.currentYear--;
    loadWorkouts(state.currentYear);
  });
  dom.btnYearNext.addEventListener("click", () => {
    state.currentYear++;
    loadWorkouts(state.currentYear);
  });
  dom.btnToday.addEventListener("click", () => {
    state.currentYear = new Date().getFullYear();
    loadWorkouts(state.currentYear).then(() => selectDate(state.todaysDate));
  });

  // Refresh button
  const btnRefresh = $("#btn-refresh");
  btnRefresh.addEventListener("click", () => {
    refreshWorkouts();
    showToast("Refreshed");
  });

  // Sidebar toggle
  dom.btnToggleSidebar.addEventListener("click", () => {
    state.sidebarVisible = !state.sidebarVisible;
    if (state.sidebarVisible) {
      dom.sidebar.classList.remove("collapsed");
      dom.btnToggleSidebar.textContent = "☰ Panel";
    } else {
      dom.sidebar.classList.add("collapsed");
      dom.btnToggleSidebar.textContent = "☰ Show";
    }
  });

  // Parse
  dom.btnParse.addEventListener("click", parseWorkout);
  dom.btnQuickSave.addEventListener("click", quickSave);
  dom.nlInput.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      parseWorkout();
    }
  });

  // Calculator
  dom.btnParseSource.addEventListener("click", parseSourceScheme);
  dom.btnConvert.addEventListener("click", convertScheme);
  [dom.calcSrcSets, dom.calcSrcReps, dom.calcSrcLoad, dom.calcSrcRir].forEach(el => {
    el.addEventListener("input", updateE1rm);
  });

  // Init
  loadWorkouts(state.currentYear);
  checkLmStatus();
  updateE1rm();
  setInterval(checkLmStatus, 30000);
}

document.addEventListener("DOMContentLoaded", init);

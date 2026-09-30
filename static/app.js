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
  chartExercise: null,  // name of exercise whose chart is shown
  chartData: null,       // progression data for active chart
};

// ────────────────────────────────────────
// DOM refs
// ────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const dom = {
  currentYear: $("#current-year"),
  sidebar: $("#sidebar"),
  btnToggleSidebar: $("#btn-toggle-sidebar"),
  nlInput: $("#nl-input"),
  btnParse: $("#btn-parse"),
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


function toggleDrawer() {
  const open = dom.sidebar.classList.toggle("open");
  $("#drawer-backdrop").classList.toggle("hidden", !open);
  $("#sidebar-hamburger").textContent = open ? "✕" : "☰";
}

function closeDrawer() {
  dom.sidebar.classList.remove("open");
  $("#drawer-backdrop").classList.add("hidden");
  $("#sidebar-hamburger").textContent = "☰";
}

// ────────────────────────────────────────
// Load workouts
// ────────────────────────────────────────

async function loadWorkouts(year) {
  await loadBlockColors();
  try {
    const data = await api("GET", `/api/workouts?year=${year}`);
    state.workouts = {};
    for (const w of data) state.workouts[w.date] = w;
    console.log(`GymBro: loaded ${data.length} workouts for ${year}`, Object.keys(state.workouts));
    renderCalendar(year);
    renderExerciseList();
    clearChart();
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


// ── Block view (weeks as columns, days stacked, weeks on X axis) ──
function renderCalendarBlocks(year) {
  dom.currentYear.textContent = year;
  state.currentYear = year;
  const jan1 = new Date(year, 0, 1);
  const daysFromMon = jan1.getDay() === 0 ? 6 : jan1.getDay() - 1;
  let cursor = new Date(year, 0, 1 - daysFromMon);

  // collect weeks
  const weeks = [];
  while (cursor <= new Date(year, 11, 31)) {
    const weekNum = getISOWeek(cursor);
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(cursor); d.setDate(cursor.getDate() + i);
      const ds = fmtDate(d);
      const w = state.workouts[ds];
      const exs = (w && w.exercises) ? w.exercises : [];
      days.push({ date: ds, num: d.getDate(), dow: ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"][i], exs, isToday: ds === state.todaysDate });
    }
    weeks.push({ weekNum, days });
    cursor.setDate(cursor.getDate() + 7);
  }

  let html = '<div class="blocks-ext">';
  html += '<div class="blocks-axis"></div>';   // corner cell
  for (const wk of weeks) {
    const workoutDays = wk.days.filter(d => d.exs.length);
    if (!workoutDays.length) continue;   // skip empty weeks entirely
    html += `<div class="blocks-col ${wk.weekNum % 2 ? "alt" : ""}">
      <div class="blocks-col-head">Wk ${wk.weekNum}</div>`;
    for (const d of workoutDays) {
      html += `<div class="blocks-day ${d.isToday ? "today" : ""}">
        <div class="blocks-day-head"><span class="dow">${d.dow}</span> <span class="dnum">${d.date}</span></div>`;
      for (const ex of d.exs) {
        html += `<div class="blocks-ex" data-date="${d.date}">${escHtml(ex.name)}<span class="ex-detail">${ex.sets}×${ex.reps}${ex.load_kg != null ? " @ " + ex.load_kg + "kg" : ""}</span></div>`;
      }
      html += '</div>';
    }
    html += '</div>';
  }
  html += '</div>';
  dom.calendarContainer.innerHTML = html;
  dom.calendarContainer.parentElement.parentElement
      .querySelector(".calendar-area")?.scrollTo(0, 0);
}

// ── Workouts-per-week view ──
function renderCalendarWeeks(year) {
  dom.currentYear.textContent = year;
  state.currentYear = year;
  let html = '<table class="calendar-table"><tbody>';
  html += '<tr><td colspan="8" class="weekview-hint">📋 Workouts scheduled for each week</td></tr>';

  const jan1 = new Date(year, 0, 1);
  const daysFromMon = jan1.getDay() === 0 ? 6 : jan1.getDay() - 1;
  let cursor = new Date(year, 0, 1 - daysFromMon);
  let shown = 0;
  while (cursor <= new Date(year, 11, 31)) {
    const weekNum = getISOWeek(cursor);
    const chips = [];
    let count = 0;
    const ds = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(cursor); d.setDate(cursor.getDate() + i);
      ds.push(fmtDate(d));
    }
    for (const dsStr of ds) {
      const w = state.workouts[dsStr];
      if (!w || !w.exercises || !w.exercises.length) continue;
      count += w.exercises.length;
      for (const ex of w.exercises) {
        chips.push(`<span class="weekchip" data-date="${dsStr}">${dsStr.slice(8)}: ${escHtml(ex.name)}</span>`);
      }
    }
    html += `<tr class="weekview-row"${count ? "" : ' style="opacity:.45"'}>
      <td class="calendar-week-num">${weekNum}</td>
      <td colspan="7" class="weekview-cells">`;
    html += chips.length ? chips.join(" ") + ` <span class="weekcount">${count}</span>` : '<span class="empty-day">—</span>';
    html += '</td></tr>';
    shown++;
    cursor.setDate(cursor.getDate() + 7);
  }
  html += '</tbody></table>';
  dom.calendarContainer.innerHTML = html;
}
let dayBlockColors = {};   // date → block color

async function loadBlockColors() {
  const tid = parseInt(localStorage.getItem("gymbro-selected-timeline"));
  if (!tid || !currentUser) { dayBlockColors = {}; return; }
  try {
    const res = await api("GET", `/api/timelines/${tid}/blocks`);
    const colorBy = {};
    for (const b of res.blocks) for (const d of b.days) colorBy[d] = b.color;
    dayBlockColors = colorBy;
  } catch { dayBlockColors = {}; }
}

function renderCalendar(year) {
  dom.currentYear.textContent = year;
  state.currentYear = year;
  if (calendarMode === "weeks") { renderCalendarWeeks(year); return; }
  if (calendarMode === "blocks") { renderCalendarBlocks(year); return; }

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

  // Group weeks by month for chart insertion
  const monthGroups = {};
  for (const row of weekRows) {
    if (!monthGroups[row.month]) monthGroups[row.month] = [];
    monthGroups[row.month].push(row);
  }

  // Build chart data lookup: date → e1rm
  const chartLookup = {};
  if (state.chartData) {
    for (const d of state.chartData) {
      chartLookup[d.date] = d.top_set.e1rm;
    }
  }

  // Render rows with monthly chart rows inserted
  for (let m = 0; m < 12; m++) {
    const rows = monthGroups[m];
    if (!rows) continue;

    // Month label
    html += `<tr><td colspan="8" class="calendar-month-label">${MONTH_NAMES[m]} ${year}</td></tr>`;

    // Week rows for this month
    for (const row of rows) {
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
        if (selection.has(dateStr)) cls += ' selected-multi';
        // Highlight if chart data exists for this date
        if (chartLookup[dateStr]) cls += ' chart-highlight';

        const bc = dayBlockColors[dateStr];
        html += `<td class="${cls}" data-date="${dateStr}" ${bc ? `style="box-shadow: inset 0 0 0 2px ${bc};"` : ""}>`;
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

    // Monthly chart row (if chart active and month has data)
    if (state.chartData && state.chartExercise) {
      const monthDates = rows.flatMap(r => r.days.map(d => fmtDate(d)));
      const monthPoints = state.chartData.filter(d => monthDates.includes(d.date));
      if (monthPoints.length >= 2) {
        html += `<tr class="chart-row"><td colspan="8"><div class="mini-chart"><div class="chart-title">${MONTH_NAMES[m]} — ${escHtml(state.chartExercise)}</div><canvas id="chart-m${m}"></canvas></div></td></tr>`;
      }
      // Spacer after every month
      html += '<tr class="chart-spacer"><td colspan="8"></td></tr>';
    }
  }

  // Year chart row at bottom
  if (state.chartData && state.chartExercise && state.chartData.length >= 2) {
    html += `<tr class="chart-row chart-row-year"><td colspan="8"><div class="mini-chart year-chart"><div class="chart-title">📈 Full Year — ${escHtml(state.chartExercise)}</div><canvas id="chart-year"></canvas></div></td></tr>`;
  }

  html += '</tbody></table>';
  dom.calendarContainer.innerHTML = html;

  // Draw all charts
  if (state.chartData && state.chartExercise) {
    setTimeout(() => drawAllCharts(monthGroups, year), 50);
  }

  isCoachUser = !!(currentUser && ["coach","admin"].includes(currentUser.role) && localStorage.getItem("gymbro-selected-timeline"));
  // Selected-multi highlight from any prior selection
  if (selection.size) {
    // noop here; classes added during render below
  }
  // Click handlers on day cells (coach drag-select in grid mode)
  if (isCoachUser && calendarMode === "grid") {
    let dragging = false;
    const cells = [...dom.calendarContainer.querySelectorAll(".calendar-day")];
    cells.forEach(cell => {
      cell.addEventListener("mousedown", () => {
        if (!selectedDays.size) state.dragStart = null;
      });
      cell.addEventListener("mousedown", e => {
        if (e.button !== 0) return;
        dragging = true;
        state.selection = new Set();
        addToSelection(cell.dataset.date, cell);
      });
      cell.addEventListener("mouseenter", () => {
        if (dragging) addToSelection(cell.dataset.date, cell);
      });
    });
    document.addEventListener("mouseup", () => { dragging = false; });
  } else {  dom.calendarContainer.querySelectorAll('.calendar-day').forEach(cell => {
    cell.addEventListener('click', (e) => {
      // Don't select if clicking on an exercise badge (it opens the day for editing)
      const date = cell.dataset.date;
      if (clickedMultiselect) return;
      selectDate(date);
    });
  });
  }
}

let clickedMultiselect = false;
let selectionShownFromCalendar = false;
let isCoachUser = false;
let selection = new Set();
function addToSelection(dateStr, cell) {
  if (!dateStr || selection.has(dateStr)) return;
  selection.add(dateStr);
  cell.classList.add("selected-multi");
  document.getElementById("detail-section").hidden = false;
  renderBlockMenu();
}
function clearSelection() {
  selection.clear();
  document.querySelectorAll(".calendar-day.selected-multi").forEach(c => c.classList.remove("selected-multi"));
  clickedMultiselect = false;
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

const phoneMQ = () => window.matchMedia("(max-width: 700px)").matches;

// On phone the day panel is a fullscreen popup — it must live in <body>,
// otherwise the (transformed) drawer creates a containing block and traps it.
function popDetailOut() {
  const sec = $("#detail-section");
  if (phoneMQ() && sec.parentElement !== document.body) document.body.appendChild(sec);
}
function popDetailBack() {
  // On phone the day editor is a standalone fullscreen popup and must NOT
  // live inside the drawer — only reparent on desktop.
  if (phoneMQ()) {
    const sec = $("#detail-section");
    if (sec.parentElement !== document.body) document.body.appendChild(sec);
    return;
  }
  const sec = $("#detail-section");
  if (sec.parentElement !== dom.sidebar) dom.sidebar.insertBefore(sec, $("#exercise-section"));
}

function renderDetail(dateStr) {
  popDetailOut();
  $("#detail-section").hidden = false;
  if (!document.getElementById("day-close")) {
    const closeBtn = document.createElement("button");
    closeBtn.id = "day-close";
    closeBtn.className = "day-close";
    closeBtn.title = "Close";
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => {
      $("#detail-section").hidden = true;
      popDetailBack();
    });
    $("#detail-title").after(closeBtn);
  }
  dom.detailTitle.textContent = selection.size > 1
      ? `📋 ${selection.size} days selected`
      : `📋 ${dateStr}`;
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

  workout.exercises.forEach((ex) => {
    html += `
      <div class="ex-row" data-id="${ex.id}">
        <div class="ex-line1">
          <input type="text" class="ex-name" value="${escHtml(ex.name)}" data-field="name" placeholder="Exercise">
          <button class="btn-small btn-danger ex-delete" data-id="${ex.id}">✕</button>
        </div>
        <div class="ex-line2">
          <input type="number" class="ex-sets" value="${ex.sets}" data-field="sets" min="0" placeholder="Sets">
          <span style="color:var(--text-dim);font-size:0.7rem;">×</span>
          <input type="number" class="ex-reps" value="${ex.reps}" data-field="reps" min="0" placeholder="Reps">
          <span style="color:var(--text-dim);font-size:0.7rem;">@</span>
          <input type="number" class="ex-load" value="${ex.load_kg ?? ''}" data-field="load_kg" placeholder="kg" step="0.5">
          <input type="text" class="ex-comments" value="${escHtml(ex.comments || '')}" data-field="comments" placeholder="notes...">
        </div>
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
    $("#detail-section").hidden = true;
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
    dom.btnParse.textContent = "🔍 Parse with AI";
  }
}

function renderParseResult(parsed) {
  // New format: {"workouts": [...], "blocks": [... optional]}
  const workouts = parsed.workouts || [];
  const blocks = parsed.blocks || [];
  if (workouts.length === 0 && blocks.length === 0) {
    dom.parseResult.innerHTML = '<p style="color:var(--orange)">No exercises or blocks detected. Try being more specific.</p>';
    return;
  }

  let html = '';
  workouts.forEach((w, wi) => {
    html += `<p style="margin-bottom:2px;font-weight:600;">📅 ${w.workout_date}</p>`;
    html += '<ul class="ex-list">';
    (w.exercises || []).forEach(ex => {
      const loadStr = ex.load_kg ? ` @ ${ex.load_kg}kg` : '';
      const rirStr = ex.rir != null ? ` RIR ${ex.rir}` : '';
      const cmtStr = ex.comments ? ` — ${ex.comments}` : '';
      html += `<li class="ex-item">🏋️ <strong>${ex.name}</strong>: ${ex.sets}×${ex.reps}${loadStr}${rirStr}${cmtStr}</li>`;
    });
    html += '</ul>';
    if (w.notes) {
      html += `<p style="margin-top:2px;font-size:0.75rem;color:var(--text-dim)">📝 ${escHtml(w.notes)}</p>`;
    }
  });

  if (blocks.length) {
    html += '<p style="margin:8px 0 2px;font-weight:600;">🧱 Blocks</p><ul class="ex-list">';
    blocks.forEach(b => {
      const days = b.days.length;
      html += `<li class="ex-item">🧱 <strong>${escHtml(b.block_name)}</strong> — ${days} day${days>1?'s':''} assigned` +
        (b.color ? ` <span class="block-dot" style="background:${escHtml(b.color)}"></span>` : '') +
        ` <span style="color:var(--text-dim);font-size:0.72rem;">(${escHtml(b.days[0])} → ${escHtml(b.days[days-1])})</span></li>`;
    });
    html += '</ul>';
  }

  const nWork = workouts.length, nBlock = blocks.length;
  html += `
    <div class="confirm-row">
      <button id="btn-confirm-save" class="btn-primary">✅ Confirm & Save (${nWork} day${nWork>1?'s':''}${nBlock?` + ${nBlock} block${nBlock>1?'s':''}`:''})</button>
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
  try {
    let result = {};
    if (currentUser && (currentUser.role === "coach" || currentUser.role === "admin")) {
      // Coach: apply plan to the selected trainee's timeline (frozen rules apply server-side)
      const tid = localStorage.getItem("gymbro-selected-timeline");
      if (!tid) {
        showToast("Open 🎓 Coaching and select a trainee first", "error");
        renderParseResult(pw);   // keep the confirmation visible
        return;
      }
      if (pw.workouts && pw.workouts.length) {
        result = await api("POST", `/api/timelines/${tid}/plan`, pw);
        showToast(`Plan applied: ${result.added.length} exercise(s)` +
          (result.skipped_frozen.length ? `, ${result.skipped_frozen.length} frozen day(s) skipped` : ""));
      }
      // AI-parsed blocks: create (if missing by name) + assign days (coach only)
      if (pw.blocks && pw.blocks.length) {
        let made = 0, assigned = 0;
        for (const b of pw.blocks) {
          const { blocks: existing, day_map } = await api("GET", `/api/timelines/${tid}/blocks`);
          let blk = existing.find(x => x.name.toLowerCase() === b.block_name.toLowerCase());
          if (!blk) {
            blk = await api("POST", `/api/timelines/${tid}/blocks`, { name: b.block_name, color: b.color });
            made++;
          }
          await api("PUT", `/api/timelines/${tid}/assign-block`, { days: b.days, block_id: blk.id });
          assigned += b.days.length;
        }
        if (pw.blocks.length) showToast(`🧱 ${pw.blocks.length} block(s): ${made?made+" created, ":""}${assigned} day(s) assigned`);
      }
    } else {
      // Trainee: merge into own calendar (blocks are coach-only)
      if (pw.workouts && pw.workouts.length) {
        result = await api("POST", "/api/workouts", { ...pw, merge: true });
        showToast(`Saved ${result.saved.length} workout${result.saved.length>1?"s":""} — existing entries kept 💪`);
      }
      if (pw.blocks && pw.blocks.length)
        showToast("🧱 Training blocks can only be set by your coach", "error");
    }
    dom.parseResult.classList.add("hidden");
    dom.nlInput.value = "";
    state.parsedWorkout = null;
    await refreshWorkouts();
    const savedDates = (result.saved || result.added || []).map(s => s.date || s.workout_date).filter(Boolean);
    await loadBlockColors();          // refresh block colors after AI block assignment
    if (savedDates.length > 0) selectDate(savedDates[0]);
    renderCalendar(state.currentYear);
  } catch (e) {
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
  renderExerciseList();
}

// ────────────────────────────────────────
// Exercise List & Progression Chart
// ────────────────────────────────────────

function getUniqueExercises() {
  const map = new Map(); // name → { count, lastLoad }
  for (const w of Object.values(state.workouts)) {
    for (const ex of w.exercises) {
      const key = ex.name.toLowerCase();
      if (!map.has(key)) {
        map.set(key, { name: ex.name, count: 0, lastLoad: 0 });
      }
      const entry = map.get(key);
      entry.count++;
      if (ex.load_kg && ex.load_kg > entry.lastLoad) entry.lastLoad = ex.load_kg;
    }
  }
  // Sort by count desc
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function renderExerciseList() {
  const exercises = getUniqueExercises();
  const container = $("#exercise-list");
  const section = $("#exercise-section");

  if (exercises.length === 0) {
    section.hidden = true;   // only appear once exercises exist
    container.innerHTML = "";
    return;
  }
  section.hidden = false;

  let html = '';
  for (const ex of exercises) {
    html += `
      <div class="ex-list-item" data-exercise="${escHtml(ex.name)}">
        <span class="ex-name" title="${escHtml(ex.name)}">${escHtml(ex.name)}</span>
        <span class="ex-count">${ex.count}×</span>
        <button class="ex-chart-toggle" data-exercise="${escHtml(ex.name)}">📈</button>
      </div>`;
  }
  container.innerHTML = html;

  // Attach chart toggle handlers
  container.querySelectorAll('.ex-chart-toggle').forEach(btn => {
    btn.addEventListener('click', () => toggleChart(btn.dataset.exercise, btn));
  });
}

function escAttr(s) {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function toggleChart(exerciseName, btn) {
  // If already showing this exercise, close it
  if (state.chartExercise === exerciseName && state.chartData) {
    clearChart();
    btn.classList.remove('active');
    return;
  }

  // Deactivate all toggle buttons
  document.querySelectorAll('.ex-chart-toggle.active').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  try {
    const data = await api("GET", `/api/exercises/${encodeURIComponent(exerciseName)}/progression?year=${state.currentYear}`);
    if (data.length < 2) {
      btn.classList.remove('active');
      showToast(`${exerciseName}: need ≥2 sessions with load data for charts`, 'error');
      return;
    }
    state.chartExercise = exerciseName;
    state.chartData = data;
    renderCalendar(state.currentYear);
  } catch (e) {
    btn.classList.remove('active');
    showToast(`Failed to load chart: ${e.message}`, 'error');
  }
}

function clearChart() {
  state.chartExercise = null;
  state.chartData = null;
  document.querySelectorAll('.ex-chart-toggle.active').forEach(b => b.classList.remove('active'));
  renderCalendar(state.currentYear);
}

function drawAllCharts(monthGroups, year) {
  const data = state.chartData;
  if (!data || data.length < 2) return;

  const allVals = data.map(d => d.top_set.e1rm);
  const gMin = Math.min(...allVals);
  const gMax = Math.max(...allVals);
  const gRange = gMax - gMin || 1;

  // Draw each monthly chart
  for (let m = 0; m < 12; m++) {
    const canvas = document.getElementById(`chart-m${m}`);
    if (!canvas) continue;

    const rows = monthGroups[m];
    if (!rows) continue;
    const monthDates = rows.flatMap(r => r.days.map(d => fmtDate(d)));
    const pts = data.filter(d => monthDates.includes(d.date));
    if (pts.length < 2) continue;

    drawMiniChart(canvas, pts, gMin, gMax, gRange);
  }

  // Draw year chart
  const yearCanvas = document.getElementById('chart-year');
  if (yearCanvas) {
    drawYearChart(yearCanvas, data, gMin, gMax, gRange);
  }
}

function drawMiniChart(canvas, pts, gMin, gMax, gRange) {
  const container = canvas.parentElement;
  const W = container.clientWidth;
  const H = 100;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const cs = getComputedStyle(document.body);
  const chartBg = cs.getPropertyValue('--chart-bg').trim();
  const chartGrid = cs.getPropertyValue('--chart-grid').trim();

  const pad = { top: 14, right: 12, bottom: 20, left: 38 };
  const pw = W - pad.left - pad.right;
  const ph = H - pad.top - pad.bottom;

  ctx.fillStyle = chartBg;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = chartGrid;
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 2; i++) {
    const y = pad.top + (i / 2) * ph;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(W - pad.right, y);
    ctx.stroke();
    const val = gMax - (i / 2) * gRange;
    ctx.fillStyle = '#8b90a5';
    ctx.font = 'bold 10px Inter, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(val), pad.left - 4, y + 4);
  }

  const xScale = i => pad.left + (i / Math.max(pts.length - 1, 1)) * pw;
  const yScale = v => pad.top + ph - ((v - gMin) / gRange) * ph;

  ctx.strokeStyle = '#a29bfe';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = xScale(i);
    const y = yScale(p.top_set.e1rm);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  pts.forEach((p, i) => {
    const x = xScale(i);
    const y = yScale(p.top_set.e1rm);
    ctx.fillStyle = '#a29bfe';
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  [0, pts.length - 1].forEach(i => {
    if (i < 0 || i >= pts.length) return;
    const x = xScale(i);
    const y = yScale(pts[i].top_set.e1rm);
    ctx.fillStyle = '#e1e4ed';
    ctx.font = 'bold 11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(Math.round(pts[i].top_set.e1rm), x, y - 10);
  });

  // Store point positions for hover interaction
  canvas._chartPoints = pts.map((p, i) => ({
    x: xScale(i),
    date: p.date
  }));

  // Hover: highlight nearest calendar cell
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    // Find nearest point
    let best = null, bestDist = Infinity;
    for (const pt of canvas._chartPoints) {
      const d = Math.abs(pt.x - mx);
      if (d < bestDist) { bestDist = d; best = pt; }
    }
    // Highlight corresponding cell, clear others
    document.querySelectorAll('.calendar-day.chart-hover').forEach(c => c.classList.remove('chart-hover'));
    if (best && bestDist < 40) {
      const cell = document.querySelector(`.calendar-day[data-date="${best.date}"]`);
      if (cell) cell.classList.add('chart-hover');
    }
  });
  canvas.addEventListener('mouseleave', () => {
    document.querySelectorAll('.calendar-day.chart-hover').forEach(c => c.classList.remove('chart-hover'));
  });
}

function drawYearChart(canvas, data, gMin, gMax, gRange) {
  const container = canvas.parentElement;
  const W = container.clientWidth;
  const H = 160;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const cs = getComputedStyle(document.body);
  const chartBg = cs.getPropertyValue('--chart-bg').trim();
  const chartGrid = cs.getPropertyValue('--chart-grid').trim();

  const pad = { top: 14, right: 16, bottom: 28, left: 42 };
  const pw = W - pad.left - pad.right;
  const ph = H - pad.top - pad.bottom;

  ctx.fillStyle = chartBg;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = chartGrid;
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (i / 4) * ph;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(W - pad.right, y);
    ctx.stroke();
    const val = gMax - (i / 4) * gRange;
    ctx.fillStyle = '#8b90a5';
    ctx.font = 'bold 11px Inter, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(val), pad.left - 5, y + 4);
  }

  const xScale = i => pad.left + (i / Math.max(data.length - 1, 1)) * pw;
  const yScale = v => pad.top + ph - ((v - gMin) / gRange) * ph;

  const months = ['J','F','M','A','M','J','J','A','S','O','N','D'];
  ctx.textAlign = 'center';
  ctx.fillStyle = '#8b90a5';
  ctx.font = 'bold 10px Inter, sans-serif';
  for (let m = 0; m < 12; m++) {
    const pts = data.filter(d => new Date(d.date + 'T00:00:00').getMonth() === m);
    if (pts.length > 0) {
      const first = data.findIndex(d => d.date === pts[0].date);
      const last = data.findIndex(d => d.date === pts[pts.length - 1].date);
      const midX = xScale((first + last) / 2);
      ctx.fillText(months[m], midX, H - pad.bottom + 14);
    }
  }

  data.forEach((d, i) => {
    const x = xScale(i);
    ctx.strokeStyle = chartGrid;
    ctx.beginPath();
    ctx.moveTo(x, pad.top + ph);
    ctx.lineTo(x, pad.top + ph + 4);
    ctx.stroke();
  });

  ctx.strokeStyle = '#a29bfe';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.shadowColor = '#a29bfe';
  ctx.shadowBlur = 6;
  ctx.beginPath();
  data.forEach((d, i) => {
    const x = xScale(i);
    const y = yScale(d.top_set.e1rm);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.shadowBlur = 0;

  data.forEach((d, i) => {
    const x = xScale(i);
    const y = yScale(d.top_set.e1rm);
    ctx.fillStyle = '#a29bfe';
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = chartBg;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });

  [0, data.length - 1].forEach(i => {
    if (i < 0 || i >= data.length) return;
    const x = xScale(i);
    const y = yScale(data[i].top_set.e1rm);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(Math.round(data[i].top_set.e1rm), x, y - 14);
  });
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

  // Auto-refresh: silently refresh data every 60 s while logged in
  setInterval(() => {
    if (currentUser) {
      refreshWorkouts().catch(() => {});
      updateNotifBadge();
    }
  }, 60000);
  // also refresh the badge whenever the panel opens or state changes
  if ($("#btn-notif")) ["click", "transitionend"].forEach(evt =>
    $("#btn-notif").addEventListener(evt, () => setTimeout(updateNotifBadge, 400)));

  // Sidebar toggle
  dom.btnToggleSidebar.addEventListener("click", () => {
    if (window.matchMedia("(max-width: 700px)").matches) {
      toggleDrawer();   // phone: hamburger opens the drawer
      return;
    }
    state.sidebarVisible = !state.sidebarVisible;
    dom.sidebar.classList.toggle("collapsed", !state.sidebarVisible);
    document.body.classList.toggle("sidebar-collapsed", !state.sidebarVisible);
    // Chevron points toward where the panel went: ‹ close, › reopen
    dom.btnToggleSidebar.textContent = state.sidebarVisible ? "‹" : "›";
  });
  $("#sidebar-hamburger").addEventListener("click", toggleDrawer);
  $("#drawer-backdrop").addEventListener("click", closeDrawer);
  $("#btn-today-fab").addEventListener("click", () => $("#btn-today").click());

  // Phone: tapping outside the day-edit popup closes it. The popup is a
  // body-level fixed element; anything tapped outside of it (calendar,
  // header, FABs) counts as "outside". Use pointerdown so it fires before
  // the click that would re-open it for a newly tapped day.
  document.addEventListener("pointerdown", (e) => {
    if (!phoneMQ()) return;
    const sec = document.getElementById("detail-section");
    if (!sec || sec.hidden || sec.parentElement !== document.body) return;
    if (sec.contains(e.target)) return;
    sec.hidden = true;
  });

  // Parse
  dom.btnParse.addEventListener("click", parseWorkout);
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

  // Theme toggle
  const btnTheme = $("#btn-theme");
  // Load saved theme
  if (localStorage.getItem('gymbro-theme') === 'light') {
    document.body.classList.add('light');
    btnTheme.textContent = '☀️ Theme: light';
  }
  btnTheme.addEventListener('click', () => {
    const isLight = document.body.classList.toggle('light');
    localStorage.setItem('gymbro-theme', isLight ? 'light' : 'dark');
    btnTheme.textContent = isLight ? '☀️ Theme: light' : '🌙 Theme: dark';
    // Redraw charts if visible
    if (state.chartData && state.chartExercise) {
      renderCalendar(state.currentYear);
    }
  });

  function setCalendarMode(mode) {
    calendarMode = mode;
    localStorage.setItem("gymbro-cal-view", mode);

    if (typeof updateViewLabels === "function") updateViewLabels();
    renderCalendar(state.currentYear);
  }


  function updateViewLabels() {
    const labels = { grid: "📅 Calendar", weeks: "📋 Workouts", blocks: "🧱 Block" };
    document.querySelectorAll(".vs-capsule").forEach(c => c.dataset.mode = calendarMode);
    const lbl = $("#vc-label");
    if (lbl) lbl.textContent = labels[calendarMode];
    const m = $("#btn-cal-view-menu");
    if (m) m.textContent = `🗓 Calendar view: ${labels[calendarMode]}`;
  }
  function shiftView(dir) {
    const order = ["grid", "weeks", "blocks"];
    const next = order[(order.indexOf(calendarMode) + dir + order.length) % order.length];
    setCalendarMode(next);
    updateViewLabels();
  }
  $("#vc-next")?.addEventListener("click", () => shiftView(1));
  $("#vc-prev")?.addEventListener("click", () => shiftView(-1));
  updateViewLabels();


  $("#btn-open-day-editor").addEventListener("click", () => {
    closeDrawer();
    const d = state.selectedDate || new Date().toISOString().slice(0, 10);
    selectDate(d);          // ensures stable day popup above everything
  });

  initChat();
  initAiThread();
  initAuth();
  initUserMenu();
  initAdminPanel();
  initCoachPanel();
  refreshMe();

  updateE1rm();
}

document.addEventListener("DOMContentLoaded", init);

// ────────────────────────────────────────
//  Auth, roles & coaching UI
// ────────────────────────────────────────

let currentUser = null;
let calendarMode = localStorage.getItem("gymbro-cal-view") || "grid";   // persisted

async function refreshMe() {
  let meData = null;
  try {
    meData = await api("GET", "/api/auth/me");
    currentUser = meData.user;
    if (!currentUser) meData = null;   // me endpoint may return {user:null}
  } catch {
    currentUser = null;
  }
  renderAuthState(meData);
  updateNotifBadge();
  if (currentUser) await loadWorkouts(state.currentYear);
}

function renderAuthState(meData = null) {
  const loggedIn = !!currentUser;
  $("#app-main").classList.toggle("hidden", !loggedIn);
  $("#landing").classList.toggle("hidden", loggedIn);
  // Only show app controls once logged in
  document.querySelectorAll(".app-controls").forEach(el => {
    el.classList.toggle("hidden", !loggedIn);
  });
  $("#auth-area").classList.toggle("hidden", loggedIn);
  ["#btn-logout", "#btn-notif"].forEach(s => $(s).classList.toggle("hidden", !loggedIn));
  // hamburger FAB only otherwise (chevron hidden via CSS on phone)
  $("#sidebar-hamburger").classList.toggle("hidden", !loggedIn);
  // Mobile jump-to-today FAB (stacked above the hamburger)
  $("#btn-today-fab").classList.toggle("hidden", !loggedIn);

  $("#chat-fab").classList.toggle("hidden", !loggedIn);
  $("#btn-open-day-editor").classList.toggle("hidden", !loggedIn);
  const traineeHasTimeline = !!(meData && (
    meData.has_timeline || meData.timeline_id !== undefined ||
    (currentUser.role === "trainee" && state.traineeTimelineId)
  ));
  $("#btn-coach-menu").classList.toggle("hidden", !loggedIn ||
      !(["coach","admin"].includes(currentUser.role) || traineeHasTimeline));

  // Role-aware prompt area: coach/admin plan sessions for others; trainees log their own
  const isCoachView = loggedIn && (currentUser.role === "coach" || currentUser.role === "admin");
  $("#input-title").textContent = isCoachView ? "🎯 Plan workout" : "📝 Log workout";
  $("#btn-parse").textContent = "🔍 Parse with AI";
  $("#btn-admin").classList.toggle("hidden", !loggedIn || currentUser.role !== "admin");
  document.querySelector(".um-viewswitch")?.classList.toggle("hidden", !loggedIn);
  $("#btn-notif-menu").classList.toggle("hidden", !loggedIn);
  ["#btn-login", "#btn-signup"].forEach(s => $(s).classList.toggle("hidden", loggedIn));
  const btn = $("#user-menu-btn");
  btn.classList.toggle("hidden", !loggedIn);
  $("#user-badge").textContent = loggedIn ? currentUser.username : "";
  $("#um-role").textContent = loggedIn ? `Signed in as ${currentUser.role}` : "—";
  const coached = $("#um-coached");
  if (meData && meData.coach_name) {
    coached.classList.remove("hidden");
    $("#um-coach-name").textContent = meData.coach_name;
  } else {
    coached.classList.add("hidden");
  }
  // Onboarding message when a user has no coaching relationship yet
  const hasRelationship = meData && meData.has_any_timeline;
  const noRelation = loggedIn && currentUser.role !== "admin" && !hasRelationship &&
    (currentUser.role === "trainee" || currentUser.role === "coach");
  const note = $("#relation-note");
  if (noRelation) {
    note.classList.remove("hidden");
    $("#app-main").style.display = "block";
    document.querySelector(".sidebar").style.display = "none";
    document.querySelector(".calendar-area").style.display = "none";
    document.querySelector(".sidebar-chevron").style.display = "none";
    document.querySelector(".header-center").style.display = "none";
    document.querySelector("#sidebar-hamburger").style.display = "none";
    document.querySelector("#btn-today-fab").classList.add("lonely-fab");   /* drop into bottom corner */
    if (currentUser.role === "coach") {
      $("#rn-title").textContent = "No trainees yet";
      $("#rn-body").textContent =
        "You have no coaching relationships yet. Invite a trainee by email from the Coaching panel to start programming their training.";
      $("#rn-action").textContent = "🎓 Open Coaching panel";
      $("#rn-action").onclick = () => openCoachPanel();
    } else {
      $("#rn-title").textContent = "Your fitness journey starts here!";
      $("#rn-body").textContent =
        "You don't have a coach yet. Accept a coaching invitation (the bell-mail notification), " +
        "or register with the same email a coach invited you with, and your training block will appear here.";
      $("#rn-action").textContent = "🔔 Check notifications";
      $("#rn-action").onclick = () => openNotifPanel();
    }
  } else {
    note.classList.add("hidden");
    document.querySelector(".sidebar").style.display = "";
    document.querySelector(".calendar-area").style.display = "";
    document.querySelector(".sidebar-chevron").style.display = "";
    document.querySelector(".header-center").style.display = "";
    document.querySelector("#sidebar-hamburger").style.display = "";
    document.querySelector("#btn-today-fab").classList.remove("lonely-fab");
    $("#app-main").style.display = "";
  }
  $("#user-menu").classList.add("hidden");
}

function toggleUserMenu(force) {
  const menu = $("#user-menu");
  const show = force !== undefined ? force : menu.classList.contains("hidden");
  menu.classList.toggle("hidden", !show);
}

function initUserMenu() {
  $("#user-menu-btn").addEventListener("click", e => { e.stopPropagation(); toggleUserMenu(); });
  $("#btn-coach-menu").addEventListener("click", () => { toggleUserMenu(false); openCoachPanel(); });
  document.addEventListener("click", e => {
    const menu = $("#user-menu");
    if (!menu.classList.contains("hidden") &&
        !menu.contains(e.target) && e.target.id !== "user-menu-btn") {
      toggleUserMenu(false);
    }
  });
}

function openAuthModal(mode) {
  const isSignup = mode === "signup";
  $("#auth-title").textContent = isSignup ? "Create your account" : "Welcome back";
  $("#auth-sub").textContent = isSignup
    ? "The first account ever becomes the admin 👑"
    : "Log in to track your gains";
  $("#auth-submit").textContent = isSignup ? "Sign up" : "Log in";
  $("#auth-submit").dataset.mode = mode;
  $("#auth-switch-text").textContent = isSignup ? "Already have an account?" : "No account yet?";
  $("#auth-switch").textContent = isSignup ? "Log in instead" : "Create one";
  $("#auth-error").classList.add("hidden");
  $("#auth-modal").classList.remove("hidden");
  setTimeout(() => $("#auth-username").focus(), 50);
}

function closeAuthModal() { $("#auth-modal").classList.add("hidden"); }

async function submitAuth() {
  const mode = $("#auth-submit").dataset.mode || "login";
  try {
    if (mode === "signup") {
      await api("POST", "/api/auth/signup", {
        username: $("#auth-username").value.trim(),
        password: $("#auth-password").value,
      });
      showToast("Account created! 💪");
    } else {
      await api("POST", "/api/auth/login", {
        username: $("#auth-username").value.trim(),
        password: $("#auth-password").value,
      });
      showToast("Welcome back!");
    }
    closeAuthModal();
    await refreshMe();
  } catch (e) {
    const errBox = $("#auth-error");
    errBox.textContent = e.message;
    errBox.classList.remove("hidden");
  }
}

// ────────────────────────────────────────
//  Chat widget (coach ↔ trainee, coach ↔ AI)
// ────────────────────────────────────────

let chatOpen = false;
let chatTimelineId = null;
let chatTimer = null;

function chatTimelineFor(role) {
  if (!currentUser) return null;
  if (role === "trainee") {
    const tl = null;   // fetched via /api/timelines
    return tl;
  }
  return null;
}

function chatTargetId() {
  // trainee: own timeline; coach/admin: selected timeline from localStorage or first
  let tid = localStorage.getItem("gymbro-selected-timeline");
  return tid ? parseInt(tid) : null;
}

function openChat() {
  if (!currentUser) return;
  chatOpen = true;
  $("#chat-panel").classList.remove("hidden");
  $("#chat-panel").classList.add("open");
  $("#chat-head-buttons").classList.toggle("hidden",
      !(currentUser.role === "coach" || currentUser.role === "admin"));
  $("#chat-fab").textContent = "✕";
  refreshChat();
  clearInterval(chatTimer);
  chatTimer = setInterval(() => { if (chatOpen) refreshChat(); }, 15000);
}

function closeChat() {
  chatOpen = false;
  $("#chat-panel").classList.add("hidden");
  $("#chat-fab").textContent = "💬";
  clearInterval(chatTimer);
}

async function refreshChat() {
  const tid = await chatTimelineResolve();
  if (!tid) {
    $("#chat-title").textContent = "💬 Chat";
    $("#chat-messages").innerHTML = '<div class="chat-empty">' +
      (currentUser.role === "coach"
        ? "Select a trainee's timeline to chat with them (or toggle ☑ Talk to AI)."
        : "Accept a coaching request to chat with your coach.") + '</div>';
    $("#chat-head-buttons").classList.add("hidden");
    return;
  }
  const data = await api("GET", `/api/timelines/${tid}/chat`);
  chatTimelineId = tid;
  $("#chat-title").textContent = data.is_coach
    ? "💬 Chat with trainee"
    : `💬 ${data.messages?.[0] || ""}`.slice(0, 0) || "💬 Chat with coach";
  $("#chat-head-buttons").classList.toggle("hidden", !data.is_coach);
  $("#chat-autoreply").checked = data.ai_autoreply;
  const box = $("#chat-messages");
  box.innerHTML = data.messages.map(m => {
    const cls = m.sender_role === "ai" ? "msg-ai" :
                (m.sender_role === (data.is_coach ? "coach" : "trainee") ? "msg-me" : "msg-them");
    return `<div class="chatmsg ${cls}"><span class="msg-who">${escHtml(m.sender_name || m.sender_role)}</span>${escHtml(m.body)}</div>`;
  }).join("") || '<div class="chat-empty">No messages yet — say hi 👋</div>';
  box.scrollTop = box.scrollHeight;
  $("#chat-input").focus();
}

async function chatTimelineResolve() {
  try {
    const t = await api("GET", "/api/timelines");
    if (!t.length) return null;
    let id = parseInt(localStorage.getItem("gymbro-selected-timeline"));
    if (id && t.some(x => x.id === id)) return id;
    return t[0].id;
  } catch { return null; }
}

async function sendChatMessage() {
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text || !chatTimelineId) return;
  input.value = "";
  try {
    await api("POST", `/api/timelines/${chatTimelineId}/chat`, { body: text });
    await refreshChat();
  } catch (e) { showToast(e.message, "error"); }
}

async function appendChatMessages() {
  await refreshChat();
}

function initChat() {
  $("#chat-fab").addEventListener("click", () => chatOpen ? closeChat() : openChat());
  $("#chat-close").addEventListener("click", closeChat);
  $("#chat-send").addEventListener("click", sendChatMessage);
  $("#chat-input").addEventListener("keydown", e => { if (e.key === "Enter") sendChatMessage(); });
  $("#chat-ai-thread")?.addEventListener("click", openAiThread);
  $("#chat-autoreply").addEventListener("change", async e => {
    if (!chatTimelineId) return;
    await api("PUT", `/api/timelines/${chatTimelineId}/chat-settings`, { ai_autoreply: e.target.checked });
  });
}


// ────────────────────────────────────────
//  Block menu (assign selected days to training blocks)
// ────────────────────────────────────────

let blockList = [];       // [{id, name, color, days}]

async function loadBlockList() {
  const tid = parseInt(localStorage.getItem("gymbro-selected-timeline"));
  if (!tid) { blockList = []; return; }
  try {
    const res = await api("GET", `/api/timelines/${tid}/blocks`);
    blockList = res.blocks;
  } catch { blockList = []; }
}

async function renderBlockMenu() {
  if (!(currentUser && ["coach","admin"].includes(currentUser.role))) return;
  await loadBlockList();
  const detail = $("#detail-section");
  if (detail.hidden) return;
  let box = document.getElementById("block-menu");
  if (!box) {
    box = document.createElement("div");
    box.id = "block-menu";
    box.className = "block-menu";
    $("#detail-title").after(box);
  }
  const days = selection.size ? [...selection] : [state.selectedDate].filter(Boolean);
  const opts = blockList.map(b =>
    `<option value="${b.id}" style="color:${b.color}">🧱 ${escHtml(b.name)}</option>`).join("");
  box.innerHTML = `
    <button id="block-btn" class="btn-small block-btn">🧱 Block ▾</button>
    <div id="block-drop" class="block-drop hidden">
      <select id="block-pick" ${selection.size ? "" : ""}>
        <option value="">— select block —</option>${opts}
      </select>
      <div class="block-drop-row">
        <button id="block-assign" class="btn-primary btn-small">Assign</button>
        <button id="block-new" class="btn-small">＋</button>
        <button id="block-unassign" class="btn-small btn-danger" title="Clear block from these days">🚫</button>
        <input type="color" id="block-color" title="Block color" value="#6c5ce7">
      </div>
    </div>`;
  $("#block-btn").addEventListener("click", () => $("#block-drop").classList.toggle("hidden"));
  $("#block-new").addEventListener("click", () => createBlockDialog());
  $("#block-assign").addEventListener("click", async () => {
    const bid = $("#block-pick").value;
    if (!bid) { showToast("Pick a block first", "error"); return; }
    const tid = parseInt(localStorage.getItem("gymbro-selected-timeline"));
    if (!tid) { showToast("No timeline selected — open 🎓 Coaching first", "error"); return; }
    await api("PUT", `/api/timelines/${tid}/assign-block`, { days, block_id: parseInt(bid) });
    showToast(`Assigned ${days.length} day(s)`);
    clearSelection();
    await loadBlockColors(); await refreshWorkouts(); renderBlockMenuHideKeep();
  });
  $("#block-unassign").addEventListener("click", async () => {
    const tid = parseInt(localStorage.getItem("gymbro-selected-timeline"));
    if (!tid) return;
    await api("PUT", `/api/timelines/${tid}/assign-block`, { days, block_id: null });
    clearSelection(); await loadBlockColors(); await renderBlockMenu();
  });
}

function createBlockDialog() {
  const name = prompt("Block name:");
  if (!name) return;
  const color = $("#block-color") ? $("#block-color").value : "#6c5ce7";
  const tid = parseInt(localStorage.getItem("gymbro-selected-timeline"));
  if (!tid) { showToast("No timeline selected", "error"); return; }
  api("POST", `/api/timelines/${tid}/blocks`, { name, color })
    .then(async () => {
      showToast("Block created 🧱");
      await loadBlockColors();
      await renderBlockMenu();
      renderCalendar(state.currentYear);
    })
    .catch(e => showToast(e.message, "error"));
}

function renderBlockMenuHideKeep() {
  if (selection.size === 0) { renderBlockMenu(); } else { renderBlockMenu(); }
}

// ────────────────────────────────────────
//  Load workouts
// ────────────────────────────────────────

function initAuth() {
  $("#btn-login").addEventListener("click", () => openAuthModal("login"));
  $("#btn-signup").addEventListener("click", () => openAuthModal("signup"));
  $("#auth-switch").addEventListener("click", () => {
    openAuthModal($("#auth-submit").dataset.mode === "signup" ? "login" : "signup");
  });
  $("#auth-x").addEventListener("click", closeAuthModal);

  // Google button only if the server has OAuth credentials
  api("GET", "/api/auth/google/status").then(st => {
    if (st.enabled) {
      $("#btn-google").classList.remove("hidden");
      $(".auth-divider").classList.remove("hidden");
    }
  }).catch(() => {});
  $("#btn-google")?.addEventListener("click", () => {
    window.location.href = "/api/auth/google/start";
  });
  $("#auth-submit").addEventListener("click", submitAuth);
  $("#auth-password").addEventListener("keydown", e => { if (e.key === "Enter") submitAuth(); });
  $("#btn-logout").addEventListener("click", async () => {
    await api("POST", "/api/auth/logout");
    // Never leak the previous user's selected timeline to the next session
    localStorage.removeItem("gymbro-selected-timeline");
    currentUser = null;
    state.workouts = {};
    renderCalendar(state.currentYear);
    renderExerciseList();
    renderAuthState();
    showToast("Logged out");
  });
  // Landing CTAs reuse the auth modal
  $("#landing-signup")?.addEventListener("click", () => openAuthModal("signup"));
  $("#landing-login")?.addEventListener("click", () => openAuthModal("login"));
  $("#auth-modal").addEventListener("click", e => { if (e.target.id === "auth-modal") closeAuthModal(); });
}

// ────────────────────────────────────────
//  Admin panel
// ────────────────────────────────────────

const adminState = { page: 1, pageSize: 10, role: "all", search: "", bannedOnly: false, total: 0, pages: 1 };

async function openAdminPanel(resetPage = true) {
  $("#admin-modal").classList.remove("hidden");
  if (resetPage) adminState.page = 1;
  const box = $("#admin-users");

  const controls = `<div class="admin-controls">
    <input id="adm-search" placeholder="🔍 Search users (fuzzy)…" value="${adminState.search}">
    <select id="adm-role">
      ${["all","admin","coach","trainee"].map(r =>
        `<option value="${r}" ${adminState.role === r ? "selected" : ""}>${r === "all" ? "all roles" : r}</option>`).join("")}
    </select>
    <select id="adm-pagesize">
      ${[10,25,50].map(n => `<option value="${n}" ${adminState.pageSize===n?"selected":""}>${n} / page</option>`).join("")}
    </select>
    <label class="adm-banchk"><input type="checkbox" id="adm-banned" ${adminState.bannedOnly?"checked":""}> banned only</label>
  </div>`;

  box.innerHTML = controls + "<p style='color:var(--text-dim)'>Loading…</p>";
  try {
    const qs = new URLSearchParams({
      page: adminState.page, page_size: adminState.pageSize,
      role: adminState.role, search: adminState.search,
      banned_only: adminState.bannedOnly,
    });
    const data = await api("GET", `/api/users?${qs}`);
    adminState.total = data.total; adminState.pages = data.pages;

    let html = '<table class="admin-table"><tr><th>User</th><th>Role</th><th>Status</th><th>Actions</th></tr>';
    for (const u of data.items) {
      const isSelf = currentUser && currentUser.id === u.id;
      html += `<tr>
        <td>${escHtml(u.username)}</td>
        <td><span class="role-chip role-${u.role}">${u.role}</span></td>
        <td>${getattr_banned(u)}</td>`;
      if (isSelf) {
        html += '<td style="color:var(--text-dim)">you</td>';
      } else {
        html += "<td>" +
          ["admin","coach","trainee"].filter(r => r !== u.role)
            .map(r => `<button class="btn-small" data-user="${u.id}" data-role="${r}">→ ${r}</button>`).join(" ") +
          `<button class="btn-small ${u.banned ? "" : "btn-danger"}" data-ban="${u.id}" data-to="${u.banned ? "0" : "1"}">${u.banned ? "Unban" : "Ban"}</button>` +
          `<button class="btn-small btn-danger" data-del="${u.id}">🗑</button></td>`;
      }
      html += "</tr>";
    }
    if (data.items.length === 0) html = '<div class="detail-placeholder">No users match.</div>' + controls;
    html += '</table>';
    html += `<div class="adm-pager">
      <button class="btn-small" id="adm-prev" ${adminState.page<=1?"disabled":""}>◀ Prev</button>
      <span>Page ${data.page} / ${data.pages} — ${data.total} user(s)</span>
      <button class="btn-small" id="adm-next" ${adminState.page>=data.pages?"disabled":""}>Next ▶</button>
    </div>`;
    $("#admin-users").innerHTML = html;

    // rebind
    bindAdminControls();
    $("#admin-users").querySelectorAll("button[data-user]").forEach(btn => {
      btn.addEventListener("click", async () => {
        try {
          await api("POST", `/api/users/${btn.dataset.user}/role`, { role: btn.dataset.role });
          showToast(`Role updated to ${btn.dataset.role}`);
          openAdminPanel(false);
        } catch (e) { showToast(e.message, "error"); }
      });
    });
    $("#admin-users").querySelectorAll("button[data-ban]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const banned = btn.dataset.to === "1";
        if (banned && !confirm("Ban this user? They will be logged out and cannot log in.")) return;
        try {
          await api("POST", `/api/users/${btn.dataset.ban}/ban`, { banned });
          showToast(banned ? "User banned" : "User unbanned");
          openAdminPanel(false);
        } catch (e) { showToast(e.message, "error"); }
      });
    });
    $("#admin-users").querySelectorAll("button[data-del]").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("DELETE this user permanently (timelines, requests and sessions go too)?")) return;
        try {
          await api("DELETE", `/api/users/${btn.dataset.del}`);
          showToast("User deleted");
          openAdminPanel(false);
        } catch (e) { showToast(e.message, "error"); }
      });
    });
  } catch (e) {
    $("#admin-users").innerHTML = `<p class="auth-error">${escHtml(e.message)}</p>` + controls;
  }
}

function getattr_banned(u) {
  return u.banned ? '<span class="role-chip role-admin">🚫 banned</span>' : '<span style="color:var(--green)">active</span>';
}

function bindAdminControls() {
  const box = $("#admin-users");
  const search = box.querySelector("#adm-search");
  let tmr;
  search?.addEventListener("input", e => {
    clearTimeout(tmr);
    tmr = setTimeout(() => { adminState.search = e.target.value; openAdminPanel(); }, 300);
  });
  box.querySelector("#adm-role")?.addEventListener("change", e => { adminState.role = e.target.value; openAdminPanel(); });
  box.querySelector("#adm-pagesize")?.addEventListener("change", e => { adminState.pageSize = parseInt(e.target.value); openAdminPanel(); });
  box.querySelector("#adm-banned")?.addEventListener("change", e => { adminState.bannedOnly = e.target.checked; openAdminPanel(); });
  box.querySelector("#adm-prev")?.addEventListener("click", () => { adminState.page--; openAdminPanel(false); });
  box.querySelector("#adm-next")?.addEventListener("click", () => { adminState.page++; openAdminPanel(); });
}

function initAdminPanel() {
  $("#btn-admin").addEventListener("click", () => { toggleUserMenu(false); openAdminPanel(); });
  $("#admin-close").addEventListener("click", () => $("#admin-modal").classList.add("hidden"));
}

// ────────────────────────────────────────
//  Coaching panel
// ────────────────────────────────────────

// Remember the selected user across panel opens
let coachSelectedUser = null;

async function openCoachPanel() {
  $("#coach-modal").classList.remove("hidden");
  $("#coach-send").classList.toggle("hidden", !(currentUser.role === "coach" || currentUser.role === "admin"));

  // Timelines list — clicking an entry selects that relationship
  try {
    const timelines = await api("GET", "/api/timelines");
    const list = $("#coach-timelines");
    if (!timelines.length) {
      list.innerHTML = '<div class="detail-placeholder">No coaching relationships yet.</div>';
      renderTimelinesFor(null);
      return;
    }
    // Preselect: remembered user or first timeline
    if (coachSelectedUser === null) {
      const first = timelines[0];
      coachSelectedUser = currentUser.id === first.coach_id ? first.trainee_id : first.coach_id;
    }
    list.innerHTML = timelines.map(t => {
      const uid = currentUser.id === t.coach_id ? t.trainee_id : t.coach_id;
      const who = currentUser.id === t.coach_id ? t.trainee_name : t.coach_name;
      const rel = currentUser.id === t.coach_id ? "Trainee" : "Coach";
      const active = coachSelectedUser === uid;
      return `<div class="tl-entry ${active ? "active" : ""}" data-uid="${uid}">
        <span class="tl-who">${rel === "Trainee" ? "🎓" : "🧑‍🏫"} ${escHtml(who)}</span>
        <span class="tl-rel">${rel === "Trainee" ? "your trainee" : "your coach"}</span>
      </div>`;
    }).join("");
    list.querySelectorAll(".tl-entry").forEach(el => {
      el.addEventListener("click", () => {
        coachSelectedUser = parseInt(el.dataset.uid) || null;
        list.querySelectorAll(".tl-entry").forEach(x => x.classList.toggle("active", x === el));
      });
    });
    renderTimelinesFor(coachSelectedUser);
  } catch (e) {
    $("#coach-timelines").innerHTML = `<p class="auth-error">${escHtml(e.message)}</p>`;
  }
}

async function renderTimelinesFor(_userId) {
  /* timeline selection now lives in the coach panel list itself */
  return;
}

// ────────────────────────────────────────
//  Notifications panel (bell icon)
// ────────────────────────────────────────

async function updateNotifBadge() {
  if (!currentUser) return;
  try {
    const me = await api("GET", "/api/auth/me");
    const count = (me.pending_requests || 0) + (me.sent_requests || 0);
    const has = count > 0;
    const badge = $("#notif-count");
    badge.classList.toggle("hidden", !has);
    badge.textContent = count > 9 ? "9+" : count;
    // Phone fallback: bell is drawer-only on mobile — pulse the ☰ hamburger instead
    const hamb = $("#hamb-notif");
    if (hamb) {
      hamb.classList.toggle("hidden", !has);
      hamb.textContent = count > 9 ? "9+" : count;
      hamb.classList.toggle("pulse", has);
    }
  } catch { /* ignore */ }
}

async function openNotifPanel() {
  const modal = $("#notif-modal");
  if (!modal.classList.contains("hidden")) {
    modal.classList.add("hidden");   // toggle closed via bell icon
    return;
  }
  modal.classList.remove("hidden");
  const box = $("#notif-list");
  box.innerHTML = "<p style='color:var(--text-dim)'>Loading…</p>";
  try {
    const data = await api("GET", "/api/coaching/requests");
    let html = "";

    // Incoming requests — actionable for trainees
    for (const r of data.incoming) {
      if (r.status === "pending" && currentUser.role === "trainee") {
        html += `<div class="req-card">
          <span>📨 <strong>${escHtml(r.coach_name)}</strong> wants to coach you${r.message ? ' — "' + escHtml(r.message) + '"' : ''}</span>
          <div class="btn-row">
            <button class="btn-primary btn-small" data-req="${r.id}" data-accept="1">Accept</button>
            <button class="btn-secondary btn-small" data-req="${r.id}" data-accept="0">Reject</button>
          </div></div>`;
      } else if (r.status !== "pending") {
        html += `<div class="req-card req-${r.status}">
          <span>Request from <strong>${escHtml(r.coach_name)}</strong> — you ${r.status}</span></div>`;
      }
    }

    // Outgoing (coach): status updates
    if (currentUser.role === "coach") {
      for (const r of data.outgoing) {
        html += `<div class="req-card req-${r.status}">
          <span>→ <strong>${escHtml(r.trainee_name)}</strong> — ${r.status}</span></div>`;
      }
    }

    if (!html) html = '<div class="detail-placeholder">No notifications. 🎉</div>';
    box.innerHTML = html;

    box.querySelectorAll("button[data-req]").forEach(btn => {
      btn.addEventListener("click", async () => {
        try {
          const res = await api("POST", `/api/coaching/requests/${btn.dataset.req}/respond`, { accept: btn.dataset.accept === "1" });
          showToast(res.status === "accepted" ? "Accepted! Timeline created 🎉" : "Request rejected");
          await openNotifPanel();
          openCoachPanel(); // refresh user chips/timelines if the panel was open
          await updateNotifBadge();
        } catch (e) { showToast(e.message, "error"); }
      });
    });
  } catch (e) {
    box.innerHTML = `<p class="auth-error">${escHtml(e.message)}</p>`;
  }
}

async function openTimeline(timelineId) {
  $("#coach-modal").classList.add("hidden");
  localStorage.setItem("gymbro-selected-timeline", timelineId);
  $("#timeline-modal").classList.remove("hidden");
  const box = $("#timeline-content");
  box.innerHTML = "<p style='color:var(--text-dim)'>Loading…</p>";
  try {
    const tl = await api("GET", `/api/timelines/${timelineId}`);
    const isCoach = currentUser && currentUser.id === tl.coach_id;
    const isTrainee = currentUser && currentUser.id === tl.trainee_id;

    let h = `<h2>📅 Coach ${escHtml(tl.coach_name)} → ${escHtml(tl.trainee_name)}</h2>`;

    // Training block (weeks & days per week) — coach editable, trainee read-only
    const mondayOf = d => { const x = new Date(d); const dd = (x.getDay()===0?6:x.getDay()-1); x.setDate(x.getDate()-dd); return fmtDate(x); };
    const curMonday = mondayOf(new Date());
    let weekOptions = '<option value="">— select start week —</option>';
    for (let i = 0; i < 16; i++) {
      const d = new Date(); d.setDate(d.getDate() + 7*i);
      const mon = mondayOf(d);
      weekOptions += `<option value="${mon}" ${tl.block_start === mon ? "selected" : ""}>Week of ${mon}</option>`;
    }
    const dis = !isCoach ? "disabled" : "";
    h += `<div class="block-box">
      <h3>🧱 Training block ${isCoach ? "" : '<span class="status-chip st-pending">read-only</span>'}</h3>
      <div class="field block-row">
        <div><label>Start week</label><select id="blk-start" ${dis}>${weekOptions}</select></div>
        <div><label>Weeks</label><input id="blk-weeks" type="number" min="1" max="52" value="${tl.block_weeks ?? 4}" ${dis} style="width:70px;"></div>
        <div><label>Days/week</label><input id="blk-days" type="number" min="1" max="7" value="${tl.block_days ?? 3}" ${dis} style="width:70px;"></div>
      </div>
      ${isCoach ? `<div class="btn-row">
        <button id="blk-save" class="btn-primary btn-small">Save block</button>
        <button id="blk-clear" class="btn-secondary btn-small">Clear</button>
      </div>`
      : `<div class="prg-note">${tl.block_start ? `Current block: ${tl.block_weeks} week(s) × ${tl.block_days} day(s)/week starting ${tl.block_start}` : "No training block set yet."}</div>`}
    </div>`;
    h += `<div class="field" style="display:flex;gap:6px;">
      <input id="tl-ex-name" placeholder="Exercise" style="flex:2;">
      <input id="tl-ex-sets" type="number" placeholder="Sets" value="3" style="width:60px;">
      <input id="tl-ex-reps" type="number" placeholder="Reps" value="8" style="width:60px;">
      <input id="tl-ex-load" type="number" placeholder="kg" step="0.5" style="width:80px;">
      <input id="tl-ex-notes" placeholder="Instructions" style="flex:2;">
      <button id="btn-tl-add" class="btn-primary btn-small">+ Add</button>
    </div>`;
    h += '<div class="programmed-list">';
    for (const ex of tl.exercises) {
      const frozen = !!ex.is_locked;
      const statusCls = { done: "st-done", skipped: "st-skipped", pending: "st-pending" }[ex.status] || "";
      h += `<div class="programmed-ex${frozen ? " frozen" : ""}">
        <div class="prg-line1">
          <strong>${escHtml(ex.name)}</strong>
          <span>${ex.sets}×${ex.reps}${ex.load_kg != null ? " @ " + ex.load_kg + "kg" : ""}${ex.rir != null ? " RIR " + ex.rir : ""}</span>
          ${frozen ? '<span class="status-chip st-locked" title="Frozen history — read only">🔒</span>' : ""}
          <span class="status-chip ${statusCls}">${ex.status}</span>
          ${isCoach && !frozen ? `<button class="btn-small btn-danger prg-del" data-id="${ex.id}">✕</button>` : ""}
        </div>
        ${ex.instructions ? `<div class="prg-note">💬 ${escHtml(ex.instructions)}</div>` : ""}`;
      if (ex.feedback) {
        h += `<div class="prg-feedback">✅ Report: ${ex.feedback.actual_sets ?? "?"}×${ex.feedback.actual_reps ?? "?"}${ex.feedback.actual_load != null ? " @ " + ex.feedback.actual_load + "kg" : ""}${ex.feedback.comments ? ' — "' + escHtml(ex.feedback.comments) + '"' : ""}</div>`;
      }
      if (isTrainee && !frozen) {
        h += `<div class="prg-feedback-form">
          <button class="btn-small btn-primary prg-done" data-id="${ex.id}">✅ Done</button>
          <button class="btn-small prg-skip" data-id="${ex.id}">⏭ Skipped</button>
          <input class="pf-load" data-id="${ex.id}" type="number" placeholder="actual kg" step="0.5" style="width:90px;">
          <input class="pf-comments" data-id="${ex.id}" placeholder="comments..." style="flex:1;">
        </div>`;
      }
      h += `</div>`;
    }
    if (tl.exercises.length === 0) h += '<p style="color:var(--text-dim)">No exercises programmed yet.</p>';
    h += '</div>';

    // Notes
    h += '<h3 style="margin-top:12px;">📝 Notes</h3>';
    for (const n of tl.notes) {
      h += `<div class="timeline-note"><strong>${escHtml(n.author_name)}</strong>: ${escHtml(n.body)}</div>`;
    }
    h += `<div class="field" style="margin-top:6px;display:flex;gap:6px;">
      <input id="tl-note-input" placeholder="Add a note..." style="flex:1;">
      <button id="btn-tl-note" class="btn-small btn-primary">Post</button>
    </div>`;
    box.innerHTML = h;

    if (isCoach) {
      $("#btn-tl-add")?.addEventListener("click", async () => {
        const name = $("#tl-ex-name").value.trim();
        if (!name) { showToast("Exercise name required", "error"); return; }
        try {
          await api("POST", `/api/timelines/${timelineId}/exercises`, {
            name, sets: parseInt($("#tl-ex-sets").value) || 3,
            reps: parseInt($("#tl-ex-reps").value) || 8,
            load_kg: $("#tl-ex-load").value ? parseFloat($("#tl-ex-load").value) : null,
            instructions: $("#tl-ex-notes").value.trim(),
          });
          showToast("Exercise programmed 💪");
          openTimeline(timelineId);
        } catch (e) { showToast(e.message, "error"); }
      });
      box.querySelectorAll(".prg-del").forEach(btn => {
        btn.addEventListener("click", async () => {
          try {
            await api("DELETE", `/api/programmed/${btn.dataset.id}`);
            openTimeline(timelineId);
          } catch (e) { showToast(e.message, "error"); }
        });
      });
    }
    if (isTrainee) {
      box.querySelectorAll(".prg-done, .prg-skip").forEach(btn => {
        btn.addEventListener("click", async () => {
          const id = btn.dataset.id;
          const done = btn.classList.contains("prg-done");
          const actualLoad = box.querySelector(`.pf-load[data-id="${id}"]`)?.value;
          const comments = box.querySelector(`.pf-comments[data-id="${id}"]`)?.value || "";
          try {
            await api("POST", `/api/programmed/${id}/feedback`, {
              status: done ? "done" : "skipped",
              actual_load: actualLoad ? parseFloat(actualLoad) : null,
              actual_sets: done ? (parseInt(box.querySelector(`.pf-sets[data-id="${id}"]`)?.value) || null) : null,
              actual_reps: done ? (parseInt(box.querySelector(`.pf-reps[data-id="${id}"]`)?.value) || null) : null,
              comments,
            });
            showToast(done ? "Marked done! 🎉" : "Marked skipped");
            openTimeline(timelineId);
          } catch (e) { showToast(e.message, "error"); }
        });
      });
    }
    $("#blk-save")?.addEventListener("click", async () => {
      try {
        await api("PUT", `/api/timelines/${timelineId}/block`, {
          start_week: $("#blk-start").value,
          weeks: parseInt($("#blk-weeks").value) || 4,
          days_per_week: parseInt($("#blk-days").value) || 3,
        });
        showToast("Training block saved 🧱");
        openTimeline(timelineId);
      } catch (e) { showToast(e.message, "error"); }
    });
    $("#blk-clear")?.addEventListener("click", async () => {
      try {
        await api("DELETE", `/api/timelines/${timelineId}/block`);
        showToast("Block cleared");
        openTimeline(timelineId);
      } catch (e) { showToast(e.message, "error"); }
    });
    $("#btn-tl-note")?.addEventListener("click", async () => {
      try {
        await api("POST", `/api/timelines/${timelineId}/notes`, { body: $("#tl-note-input").value.trim() });
        openTimeline(timelineId);
      } catch (e) { showToast(e.message, "error"); }
    });
  } catch (e) {
    box.innerHTML = `<p class="auth-error">${escHtml(e.message)}</p>`;
  }
}

function initCoachPanel() {
  // btn-coach may be absent (its menu counterpart #btn-coach-menu is used instead)
  $("#btn-coach")?.addEventListener("click", openCoachPanel);
  $("#btn-notif").addEventListener("click", openNotifPanel);
  $("#notif-close").addEventListener("click", () => $("#notif-modal").classList.add("hidden"));
  $("#notif-modal").addEventListener("click", e => {
    if (e.target.id === "notif-modal") $("#notif-modal").classList.add("hidden");
  });
  $("#coach-close").addEventListener("click", () => $("#coach-modal").classList.add("hidden"));
  $("#timeline-close").addEventListener("click", () => {
    $("#timeline-modal").classList.add("hidden");
    if (currentUser) openCoachPanel();
  });
  $("#btn-open-invite")?.addEventListener("click", () => {
    $("#coach-email").value = ""; $("#coach-message").value = "";
    $("#invite-modal").classList.remove("hidden");
  });
  $("#invite-close")?.addEventListener("click", () => $("#invite-modal").classList.add("hidden"));
  $("#invite-modal")?.addEventListener("click", e => {
    if (e.target.id === "invite-modal") $("#invite-modal").classList.add("hidden");
  });
  $("#btn-send-coach-request")?.addEventListener("click", async () => {
    const email = $("#coach-email").value.trim();
    if (!email || !email.includes("@")) { showToast("Enter a valid email", "error"); return; }
    try {
      const res = await api("POST", "/api/coaching/requests", {
        email,
        message: $("#coach-message").value.trim(),
      });
      showToast(res.trainee_id ? "Request sent 📨" : "Invite created — awaits signup 📨");
      $("#invite-modal").classList.add("hidden");
      openCoachPanel();
    } catch (e) { showToast(e.message, "error"); }
  });
}

// ────────────────────────────────────────
//  AI thread modal (coach ↔ AI per trainee)
// ────────────────────────────────────────

let aiThreadTimeline = null;

async function openAiThread() {
  if (!chatTimelineId) chatTimelineId = await chatTimelineResolve();
  if (!chatTimelineId) { showToast("No timeline found for AI guidance", "error"); return; }
  aiThreadTimeline = chatTimelineId;
  $("#ai-thread-modal").classList.remove("hidden");
  const tl = await api("GET", `/api/timelines/${aiThreadTimeline}`).catch(() => null);
  $("#ai-thread-title").textContent =
    `🤖 AI thread — guidance for ${tl ? tl.trainee_name : "trainee"}`;
  await refreshAiThread();
}

async function refreshAiThread() {
  if (!aiThreadTimeline) return;
  const full = await api("GET", `/api/timelines/${aiThreadTimeline}/chat`);
  const aiMsgs = full.messages.filter(m => m.sender_role === "ai");
  const box = $("#ai-thread-messages");
  box.innerHTML = aiMsgs.map(m =>
    `<div class="chatmsg msg-ai"><span class="msg-who">${escHtml(m.sender_name || "AI")}</span>${escHtml(m.body)}</div>`
  ).join("") || '<div class="chat-empty">Give the AI your rules now — it will reference them in auto-replies.</div>';
  box.scrollTop = box.scrollHeight;
}

async function sendAiThread() {
  const input = $("#ai-thread-input");
  const text = input.value.trim();
  if (!text || !aiThreadTimeline) return;
  input.value = "";
  try {
    // AI thread prompt: same endpoint (ai_chat mode ON = coach talking to AI)
    const res = await api("POST", `/api/timelines/${aiThreadTimeline}/chat`, { body: text });
    await refreshAiThread();
    if (chatOpen) await refreshChat();
  } catch (e) { showToast(e.message, "error"); }
}

function initAiThread() {
  $("#ai-thread-close").addEventListener("click", () => $("#ai-thread-modal").classList.add("hidden"));
  $("#ai-thread-send").addEventListener("click", sendAiThread);
  $("#ai-thread-input").addEventListener("keydown", e => { if (e.key === "Enter") sendAiThread(); });
  $("#ai-thread-modal").addEventListener("click", e => {
    if (e.target.id === "ai-thread-modal") $("#ai-thread-modal").classList.add("hidden");
  });
}

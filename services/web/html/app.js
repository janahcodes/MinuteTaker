"use strict";

const $ = (id) => document.getElementById(id);
const PENDING = new Set(["UPLOADING", "UPLOADED", "QUEUED", "PROCESSING"]);
const LABEL = { UPLOADING: "Uploading", UPLOADED: "Uploaded", QUEUED: "Queued",
  PROCESSING: "Transcribing", DONE: "Ready", FAILED: "Failed" };
const AVATAR_COLORS = ["#5b8def", "#7aa7f5", "#4a6fb8", "#6c95e0", "#8fa8d6", "#3f6fd8", "#7f93c4", "#5a7bd0"];

const state = { selected: null, hl: "", filter: "all", tab: null, meetings: [], current: null };
let pollTimer = null;

// ---------- helpers ----------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function highlight(text, q) {
  const safe = esc(text);
  if (!q) return safe;
  const re = new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  return safe.replace(re, (m) => `<mark>${m}</mark>`);
}
function clock(sec) {
  if (sec == null) return "";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(s).padStart(2, "0")}`;
}
function ago(ts) {
  if (!ts) return "";
  const d = Date.now() / 1000 - ts;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function initials(title) {
  const w = String(title || "?").replace(/[^\p{L}\p{N} ]/gu, "").trim().split(/\s+/);
  return ((w[0]?.[0] || "?") + (w[1]?.[0] || "")).toUpperCase();
}
function colorFor(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function pill(status) {
  return `<span class="pill p-${esc(status)}">${esc(LABEL[status] || status)}</span>`;
}
async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || `${res.status} ${res.statusText}`);
  return body;
}
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 2600);
}
function setMsg(text, err = false) {
  const el = $("upload-msg");
  el.textContent = text;
  el.className = "msg" + (err ? " err" : "");
}
function download(filename, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function safeFile(name) { return String(name || "untitled").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_") || "untitled"; }
const ICON = {
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z"/></svg>',
  cpu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
  g: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 12h-9"/></svg>',
  empty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
};

// ---------- list + stats ----------
async function loadList() {
  try {
    const all = (await api("/api/meetings")).meetings;
    state.meetings = all;
    renderStats(all);
    const rows = all.filter((m) =>
      state.filter === "all" ? true
        : state.filter === "pending" ? PENDING.has(m.status)
        : m.status === state.filter);
    $("list-title").textContent = { all: "All recordings", DONE: "Ready", pending: "In progress", FAILED: "Failed" }[state.filter];
    $("list-hint").textContent = `${rows.length} ${rows.length === 1 ? "item" : "items"}`;
    renderList(rows);
    schedulePoll(all.some((r) => PENDING.has(r.status)));
  } catch (e) {
    $("list").innerHTML = `<div class="empty">${ICON.empty}<b>Couldn't load recordings</b><div>${esc(e.message)}</div></div>`;
    $("health-dot").classList.add("down");
    schedulePoll(true);
  }
  loadSystem();
}

function renderStats(all) {
  const minutes = all.reduce((s, m) => s + (m.duration_s || 0), 0) / 60;
  const actions = all.reduce((s, m) => s + (m.action_count || 0), 0);
  const pending = all.filter((m) => PENDING.has(m.status)).length;
  $("st-meetings").textContent = all.length;
  $("st-minutes").textContent = minutes < 10 ? minutes.toFixed(1) : Math.round(minutes);
  $("st-actions").textContent = actions;
  $("st-pending").textContent = pending;
  $("c-all").textContent = all.length;
  $("c-done").textContent = all.filter((m) => m.status === "DONE").length;
  $("c-pending").textContent = pending;
  $("c-failed").textContent = all.filter((m) => m.status === "FAILED").length;
}

function renderList(rows) {
  if (!rows.length) {
    $("list").innerHTML = `<div class="empty">${ICON.empty}<b>Nothing here yet</b><div>Upload or record something above.</div></div>`;
    return;
  }
  $("list").innerHTML = rows.map((m) => `
    <div class="item ${m.id === state.selected ? "sel" : ""}" data-id="${esc(m.id)}" tabindex="0" role="button">
      <div class="av" style="background:${colorFor(m.id)}">${esc(initials(m.title))}</div>
      <div style="min-width:0">
        <div class="t">${esc(m.title)}</div>
        <div class="m">${pill(m.status)}
          ${m.kind === "lecture" ? `<span class="kind-tag">Lecture</span>` : ""}
          ${m.duration_s ? `<span>${clock(m.duration_s)}</span>` : ""}
          ${m.action_count ? `<span>${m.action_count} ${m.kind === "lecture" ? "deadline" : "action"}${m.action_count > 1 ? "s" : ""}</span>` : ""}
          <span>${ago(m.created_at)}</span></div>
      </div>
    </div>`).join("");
}

function schedulePoll(active) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    loadList();
    if (state.selected && state.current && PENDING.has(state.current.status)) loadDetail(state.selected, true);
  }, active ? 3000 : 15000);
}

async function loadSystem() {
  try {
    const s = await api("/api/stats");
    $("s-pod").textContent = s.pod;
    $("s-pod").title = s.pod;
    $("s-wait").textContent = s.queue.waiting;
    $("s-busy").textContent = s.queue.in_progress;
    $("health-dot").classList.remove("down");
  } catch {
    $("health-dot").classList.add("down");
  }
}

$("list").addEventListener("click", (e) => {
  const row = e.target.closest(".item");
  if (row) openMeeting(row.dataset.id);
});
$("list").addEventListener("keydown", (e) => {
  const row = e.target.closest(".item");
  if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openMeeting(row.dataset.id); }
});
document.querySelectorAll(".nav a").forEach((a) => a.addEventListener("click", () => {
  document.querySelectorAll(".nav a").forEach((x) => x.classList.toggle("active", x === a));
  state.filter = a.dataset.filter;
  loadList();
}));

// ---------- detail ----------
function openMeeting(id, hl = "") {
  state.selected = id;
  state.hl = hl;
  state.tab = null; // pick the default for this recording's kind once loaded
  document.querySelectorAll(".item").forEach((el) => el.classList.toggle("sel", el.dataset.id === id));
  loadDetail(id);
  if (hl || window.innerWidth < 960) setTimeout(() => $("detail").scrollIntoView({ behavior: "smooth", block: "start" }), 150);
}

async function loadDetail(id, quiet = false) {
  if (!quiet) $("detail").innerHTML = `<div class="state"><div class="spinner"></div></div>`;
  try {
    state.current = await api(`/api/meetings/${id}`);
    if (!state.tab) state.tab = state.hl || state.current.kind === "lecture" ? "transcript" : "actions";
    renderDetail();
  } catch (e) {
    if (!quiet) $("detail").innerHTML = `<div class="empty">${ICON.empty}<div>${esc(e.message)}</div></div>`;
  }
}

function doneKey(id) { return `mt-done-${id}`; }
function loadDone(id) { try { return new Set(JSON.parse(localStorage.getItem(doneKey(id)) || "[]")); } catch { return new Set(); } }
function saveDone(id, set) { try { localStorage.setItem(doneKey(id), JSON.stringify([...set])); } catch { /* storage blocked */ } }

function renderDetail() {
  const m = state.current;
  const lecture = m.kind === "lecture";
  const chips = [
    pill(m.status),
    lecture ? `<span class="chip">Lecture</span>` : "",
    m.duration_s ? `<span class="chip">${ICON.clock}${clock(m.duration_s)} long</span>` : "",
    m.processing_s ? `<span class="chip">${ICON.bolt}Transcribed in ${m.processing_s}s</span>` : "",
    m.processed_by ? `<span class="chip">${ICON.cpu}<code>${esc(m.processed_by)}</code></span>` : "",
    `<span class="chip">${ICON.cal}${ago(m.created_at)}</span>`,
  ].join("");

  let body;
  if (m.status === "FAILED") {
    body = `<div class="state"><div class="err-box">${esc(m.error || "Transcription failed.")}</div>
      <button class="btn primary" data-act="retry">Try again</button></div>`;
  } else if (PENDING.has(m.status)) {
    body = `<div class="state"><div class="spinner"></div>
      <div class="big">${m.status === "PROCESSING" ? "Transcribing now…" : "Waiting for a free worker…"}</div>
      <div>This updates on its own. Transcribing takes roughly a fifth of the recording's length.</div>
      ${m.error ? `<div>${esc(m.error)}</div>` : ""}
      ${m.status === "UPLOADED" ? `<button class="btn primary" data-act="retry">Queue it</button>` : ""}</div>`;
  } else {
    const actionsLabel = lecture ? "Deadlines" : "Action items";
    const tabs = lecture
      ? [["transcript", "Transcript"], ["actions", actionsLabel]]
      : [["actions", actionsLabel], ["transcript", "Transcript"]];
    body = `<div class="tabs" role="tablist">${tabs.map(([k, label]) =>
      `<button class="tab ${state.tab === k ? "on" : ""}" data-tab="${k}" role="tab">${label}${k === "actions" ? `<span class="n">${m.action_items.length}</span>` : ""}</button>`).join("")}</div>
      <div class="d-body">${state.tab === "actions" ? actionsHtml(m) : transcriptHtml(m)}</div>`;
  }

  $("detail").innerHTML = `
    <div class="d-head"><h2>${esc(m.title)}</h2><div class="chips">${chips}</div></div>
    ${body}
    <div class="toolbar">
      ${m.status === "DONE" ? `
        ${lecture ? `<button class="btn primary" data-act="notes">Turn into notes</button>` : `<button class="btn" data-act="copy">Copy minutes</button>`}
        <button class="btn" data-act="download">Download ${lecture ? "transcript" : "minutes"} .md</button>
        ${m.action_items.some((a) => a.due_date) ? `<button class="btn" data-act="cal-all">${ICON.cal}Add all deadlines</button>` : ""}` : ""}
      <span class="spacer"></span>
      <button class="btn ghost danger" data-act="delete">Delete</button>
    </div>`;
}

function prettyDate(iso) {
  const [y, mo, d] = iso.split("-").map(Number);
  return new Date(y, mo - 1, d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function actionsHtml(m) {
  const lecture = m.kind === "lecture";
  if (!m.action_items.length) return `<div class="empty">${ICON.empty}<b>${lecture ? "No deadlines mentioned" : "No action items detected"}</b>
    <div>${lecture ? "Homework or due dates said in class will show up here." : "Nobody committed to anything in this one."}</div></div>`;
  const done = loadDone(m.id);
  const pct = Math.round((done.size / m.action_items.length) * 100);
  return `<div class="progress"><span>${done.size} of ${m.action_items.length} done</span><div class="bar"><i style="width:${pct}%"></i></div></div>
    <ul class="actions">${m.action_items.map((a, i) => `
      <li class="${done.has(i) ? "done" : ""}">
        <input class="check" type="checkbox" data-i="${i}" ${done.has(i) ? "checked" : ""} aria-label="Mark done">
        <div><div class="txt">${esc(a.text)}</div>
          <div class="tags">
            ${a.owner ? `<span class="tag owner">@${esc(a.owner)}</span>` : ""}
            ${a.due_date ? `<span class="tag date">Due ${esc(prettyDate(a.due_date))}</span>`
              : a.due ? `<span class="tag due">${esc(a.due)}</span>` : ""}
            <span class="tag time">at ${clock(a.start)}</span>
          </div>
          ${a.due_date ? `<div class="cal">
            <button class="mini" data-act="ics" data-i="${i}" title="Downloads an event with reminders at 9 AM the day before and on the day">${ICON.bell}Add to calendar + reminder</button>
            <a class="mini" href="${esc(googleLink(m, a))}" target="_blank" rel="noopener">${ICON.g}Google Calendar</a>
          </div>` : ""}
        </div>
      </li>`).join("")}</ul>`;
}

function transcriptHtml(m) {
  const notesCta = m.kind === "lecture" ? `<div class="notes-cta"><p><b>Study notes</b>
      A condensed page with the summary, key terms, definitions and section-by-section points. Not word for word.</p>
      <button class="btn primary" data-act="notes">Turn into notes</button></div>` : "";
  if (!m.segments.length) return notesCta + `<p>${highlight(m.transcript || "(no speech detected)", state.hl)}</p>`;
  return notesCta + m.segments.map((s) => `<div class="seg"><time>${clock(s.start)}</time><div>${highlight(s.text, state.hl)}</div></div>`).join("");
}

// ---------- calendar ----------
function ymd(iso, plusDays = 0) {
  const [y, mo, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d + plusDays));
  return dt.toISOString().slice(0, 10).replace(/-/g, "");
}
function icsText(s) { return String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n"); }
function eventTitle(a) { return `${a.task || a.text}${a.owner && a.owner !== "Speaker" ? ` (${a.owner})` : ""}`; }
function eventDetails(m, a) { return `From "${m.title}" at ${clock(a.start)}:\n"${a.text}"\n\nAdded by MinuteTaker`; }

function vevent(m, a, i) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return [
    "BEGIN:VEVENT",
    `UID:${m.id}-${i}@minutetaker`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${ymd(a.due_date)}`,
    `DTEND;VALUE=DATE:${ymd(a.due_date, 1)}`,
    `SUMMARY:${icsText(eventTitle(a))}`,
    `DESCRIPTION:${icsText(eventDetails(m, a))}`,
    "TRANSP:TRANSPARENT",
    // Reminders: 9 AM the day before, and 9 AM on the day.
    "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsText("Due tomorrow: " + (a.task || a.text))}`, "TRIGGER:-PT15H", "END:VALARM",
    "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsText("Due today: " + (a.task || a.text))}`, "TRIGGER:PT9H", "END:VALARM",
    "END:VEVENT",
  ].join("\r\n");
}
function icsFile(events) {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//MinuteTaker//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", ...events, "END:VCALENDAR", ""].join("\r\n");
}
function googleLink(m, a) {
  const p = new URLSearchParams({
    action: "TEMPLATE",
    text: eventTitle(a),
    dates: `${ymd(a.due_date)}/${ymd(a.due_date, 1)}`,
    details: eventDetails(m, a),
  });
  return `https://calendar.google.com/calendar/render?${p}`;
}

// ---------- lecture notes ----------
function notesPage(n, m) {
  const pt = (p) => `<li><span class="ts">${clock(p.start)}</span><span>${esc(p.text)}</span></li>`;
  const date = new Date((m.created_at || Date.now() / 1000) * 1000).toLocaleDateString(undefined, { dateStyle: "long" });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(n.title)} · Notes</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,500&family=Manrope:wght@400;600;700&display=swap" rel="stylesheet">
<style>
:root{--ink:#17213a;--muted:#687692;--line:#dbe3f0;--accent:#3f6fd8;--soft:#eef3fc;--bg:#f7f9fd}
@media (prefers-color-scheme:dark){:root{--ink:#eaf1ff;--muted:#93a3c2;--line:#25324b;--accent:#8fb3ff;--soft:#141d2e;--bg:#0b0f18}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15.5px/1.7 Manrope,-apple-system,sans-serif}
main{max-width:780px;margin:0 auto;padding:56px 24px 80px}
.eyebrow{font-size:11px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--accent)}
h1{font-family:Fraunces,Georgia,serif;font-weight:300;font-size:clamp(34px,6vw,52px);line-height:1.05;margin:10px 0 8px;letter-spacing:-.02em}
.meta{color:var(--muted);font-size:13.5px;margin-bottom:34px}
h2{font-family:Fraunces,Georgia,serif;font-weight:500;font-size:24px;margin:40px 0 12px;display:flex;align-items:baseline;gap:12px}
h2 .ts{font:12px ui-monospace,Menlo,monospace;color:var(--accent);background:var(--soft);padding:2px 9px;border-radius:99px}
.box{background:var(--soft);border:1px solid var(--line);border-radius:20px;padding:20px 24px}
.box ul{margin:0;padding-left:20px}
.terms{display:flex;flex-wrap:wrap;gap:8px}.terms span{border:1px solid var(--line);border-radius:99px;padding:4px 12px;font-size:13px;font-weight:600;text-transform:capitalize}
dl{margin:0;display:grid;gap:14px}dt{font-weight:700}dd{margin:2px 0 0}
ul.pts{list-style:none;padding:0;margin:0;display:grid}
ul.pts li{display:grid;grid-template-columns:52px 1fr;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)}
ul.pts .ts{font:12px ui-monospace,Menlo,monospace;color:var(--muted);padding-top:3px}
footer{margin-top:56px;color:var(--muted);font-size:12.5px}
@media print{body{background:#fff;color:#000}.box{background:#f4f6fb}}
</style></head><body><main>
<div class="eyebrow">Lecture notes</div>
<h1>${esc(n.title)}</h1>
<div class="meta">${esc(date)} · ${clock(m.duration_s)} recording · ${n.stats.kept || 0} key points from ${n.stats.sentences || 0} spoken sentences</div>
${n.summary.length ? `<div class="box"><div class="eyebrow" style="margin-bottom:8px">Summary</div><ul>${n.summary.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>` : ""}
${n.key_terms.length ? `<h2>Key terms</h2><div class="terms">${n.key_terms.map((t) => `<span>${esc(t)}</span>`).join("")}</div>` : ""}
${n.definitions.length ? `<h2>Definitions</h2><dl>${n.definitions.map((d) => `<div><dt>${esc(d.term)}</dt><dd>${esc(d.definition)}</dd></div>`).join("")}</dl>` : ""}
${n.sections.map((s) => `<h2>${esc(s.heading)} <span class="ts">${clock(s.start)}</span></h2><ul class="pts">${s.points.map(pt).join("")}</ul>`).join("")}
${m.action_items.length ? `<h2>Deadlines mentioned</h2><ul class="pts">${m.action_items.map((a) => `<li><span class="ts">${clock(a.start)}</span><span>${esc(a.text)}${a.due_date ? ` <b>(${esc(prettyDate(a.due_date))})</b>` : ""}</span></li>`).join("")}</ul>` : ""}
<footer>Generated by MinuteTaker from the lecture transcript. Points are selected and condensed from what was said, so check anything critical against the recording.</footer>
</main></body></html>`;
}

// ---------- detail actions ----------
$("detail").addEventListener("change", (e) => {
  if (!e.target.classList.contains("check")) return;
  const m = state.current, done = loadDone(m.id), i = Number(e.target.dataset.i);
  e.target.checked ? done.add(i) : done.delete(i);
  saveDone(m.id, done);
  renderDetail();
});

function minutesMarkdown(m) {
  const lines = [`# ${m.title}`, "", `Length: ${clock(m.duration_s)}`, "", m.kind === "lecture" ? "## Deadlines" : "## Action items"];
  if (!m.action_items.length) lines.push("- (none detected)");
  m.action_items.forEach((a) => lines.push(`- [ ] ${a.text}${a.owner ? ` (owner: ${a.owner})` : ""}${a.due_date ? ` (due: ${prettyDate(a.due_date)})` : a.due ? ` (due: ${a.due})` : ""}`));
  lines.push("", "## Transcript", "");
  if (m.segments.length) m.segments.forEach((s) => lines.push(`[${clock(s.start)}] ${s.text}`));
  else lines.push(m.transcript);
  return lines.join("\n");
}

$("detail").addEventListener("click", async (e) => {
  const tab = e.target.closest("[data-tab]");
  if (tab) { state.tab = tab.dataset.tab; renderDetail(); return; }
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const m = state.current;
  try {
    switch (btn.dataset.act) {
      case "retry":
        await api(`/api/meetings/${m.id}/retry`, { method: "POST" });
        toast("Queued again");
        await loadDetail(m.id); loadList();
        break;
      case "delete":
        if (!confirm(`Delete “${m.title}” and its recording? This can't be undone.`)) return;
        await api(`/api/meetings/${m.id}`, { method: "DELETE" });
        state.selected = null; state.current = null;
        $("detail").innerHTML = `<div class="empty">${ICON.empty}<b>Deleted</b></div>`;
        toast("Recording deleted");
        loadList();
        break;
      case "copy":
        await navigator.clipboard.writeText(minutesMarkdown(m));
        toast("Minutes copied to clipboard");
        break;
      case "download":
        download(`${safeFile(m.title)}.md`, minutesMarkdown(m), "text/markdown");
        break;
      case "ics": {
        const i = Number(btn.dataset.i), a = m.action_items[i];
        download(`${safeFile(a.task || "deadline")}.ics`, icsFile([vevent(m, a, i)]), "text/calendar");
        toast(`Open the downloaded file to add it: ${prettyDate(a.due_date)}, reminder the day before`);
        break;
      }
      case "cal-all": {
        const evs = m.action_items.map((a, i) => (a.due_date ? vevent(m, a, i) : null)).filter(Boolean);
        download(`${safeFile(m.title)}_deadlines.ics`, icsFile(evs), "text/calendar");
        toast(`${evs.length} deadline${evs.length > 1 ? "s" : ""} ready. Open the file to add them`);
        break;
      }
      case "notes": {
        btn.disabled = true;
        const old = btn.textContent;
        btn.textContent = "Writing notes…";
        try {
          const n = await api(`/api/meetings/${m.id}/notes`);
          download(`${safeFile(m.title)}_notes.html`, notesPage(n, m), "text/html");
          toast("Notes downloaded. Open the file to read or print them");
        } finally { btn.disabled = false; btn.textContent = old; }
        break;
      }
    }
  } catch (err) { toast(err.message); }
});

// ---------- upload ----------
function selectedKind() { return document.querySelector('input[name="kind"]:checked')?.value || "meeting"; }

async function upload(file, nameHint) {
  const fd = new FormData();
  fd.append("title", $("title").value.trim());
  fd.append("kind", selectedKind());
  fd.append("file", file, nameHint || file.name);
  setMsg(`Uploading ${nameHint || file.name}…`);
  try {
    const m = await api("/api/meetings", { method: "POST", body: fd });
    setMsg("");
    toast("Uploaded. Transcription queued");
    $("title").value = "";
    await loadList();
    openMeeting(m.id);
  } catch (e) {
    setMsg(`Upload failed: ${e.message}`, true);
  }
}
document.querySelectorAll('input[name="kind"]').forEach((r) => r.addEventListener("change", () => {
  $("title").placeholder = selectedKind() === "lecture" ? "Course or lecture title (optional)" : "Name this meeting (optional)";
}));

$("file").addEventListener("change", (e) => { if (e.target.files[0]) upload(e.target.files[0]); e.target.value = ""; });
const zone = $("zone");
["dragenter", "dragover"].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.add("over"); }));
["dragleave", "drop"].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.remove("over"); }));
zone.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) upload(f); });

// ---------- recording: mic only, or a call (tab audio + mic) ----------
let rec = null; // { recorder, mode, tick }

function pickMime() {
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) if (MediaRecorder.isTypeSupported(t)) return t;
  return "";
}

async function startRecording(mode) {
  const btn = $(mode === "call" ? "rec-call" : "rec");
  const label = $(mode === "call" ? "call-label" : "rec-label");
  const idle = label.textContent;
  const cleanups = [];
  let stream;

  if (mode === "mic") {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    cleanups.push(() => stream.getTracks().forEach((t) => t.stop()));
  } else {
    if (!navigator.mediaDevices.getDisplayMedia) throw new Error("This browser can't capture other tabs. Use Chrome or Edge.");
    // Chrome only offers tab audio when video is requested too; the video is ignored.
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, systemAudio: "include" });
    cleanups.push(() => display.getTracks().forEach((t) => t.stop()));
    if (!display.getAudioTracks().length) {
      cleanups.forEach((f) => f());
      throw new Error("No call audio was shared. Pick the meeting's tab and tick “Share tab audio”.");
    }
    const ctx = new AudioContext();
    cleanups.push(() => ctx.close());
    const dest = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(new MediaStream(display.getAudioTracks())).connect(dest);
    try { // mix in your own voice too, if the mic is allowed
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      cleanups.push(() => mic.getTracks().forEach((t) => t.stop()));
      ctx.createMediaStreamSource(mic).connect(dest);
    } catch { toast("Recording call audio only (microphone not allowed)"); }
    // Clicking "Stop sharing" in Chrome's bar ends the recording too.
    display.getVideoTracks().forEach((t) => (t.onended = () => rec?.recorder.state === "recording" && rec.recorder.stop()));
    stream = dest.stream;
  }

  const mime = pickMime();
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  const started = Date.now();
  recorder.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
  recorder.onstop = () => {
    clearInterval(rec.tick);
    cleanups.forEach((f) => { try { f(); } catch { /* already stopped */ } });
    btn.classList.remove("live"); label.textContent = idle;
    const type = (mime || "audio/webm").split(";")[0];
    const ext = type.endsWith("mp4") ? "m4a" : "webm";
    const name = `${mode === "call" ? "Call" : "Recording"} ${new Date(started).toLocaleString()}.${ext}`;
    rec = null;
    upload(new File(chunks, `recording.${ext}`, { type }), name);
  };
  recorder.start(1000);
  btn.classList.add("live");
  rec = { recorder, mode, tick: setInterval(() => (label.textContent = `Stop ${clock((Date.now() - started) / 1000)}`), 500) };
  label.textContent = "Stop 0:00";
  toast(mode === "call" ? "Recording the call. Click Stop (or Stop sharing) when it ends" : "Recording. Click Stop when you're done");
}

for (const [id, mode] of [["rec", "mic"], ["rec-call", "call"]]) {
  $(id).addEventListener("click", async (e) => {
    e.preventDefault(); // these buttons sit inside the drop-zone label
    if (rec) {
      if (rec.mode === mode) rec.recorder.stop();
      else toast("Stop the current recording first");
      return;
    }
    try { await startRecording(mode); }
    catch (err) { setMsg(err.name === "NotAllowedError" ? "Permission was denied." : err.message, true); }
  });
}

// ---------- search: results drop down right under the bar ----------
let searchTimer = null, searchSeq = 0;
function closeResults() { $("results").classList.remove("open"); $("q").setAttribute("aria-expanded", "false"); }

async function runSearch(q) {
  const box = $("results");
  if (q.length < 2) { closeResults(); return; }
  const seq = ++searchSeq;
  box.innerHTML = `<div class="none">Searching…</div>`;
  box.classList.add("open"); $("q").setAttribute("aria-expanded", "true");
  try {
    const res = (await api(`/api/search?q=${encodeURIComponent(q)}`)).results;
    if (seq !== searchSeq) return; // a newer search is in flight
    box.innerHTML = res.length
      ? `<div class="rh"><span>${res.length} result${res.length > 1 ? "s" : ""}</span><span>Esc to close</span></div>` +
        res.map((r) => `<button class="r" type="button" role="option" data-id="${esc(r.id)}">
          <b>${highlight(r.title, q)}</b><span>${highlight(r.snippet, q)}</span></button>`).join("")
      : `<div class="none">No recordings mention “${esc(q)}”.</div>`;
  } catch (e) {
    box.innerHTML = `<div class="none">${esc(e.message)}</div>`;
  }
}

$("q").addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = $("q").value.trim();
  searchTimer = setTimeout(() => runSearch(q), 250);
});
$("q").addEventListener("focus", () => { if ($("q").value.trim().length >= 2) runSearch($("q").value.trim()); });
$("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const first = $("results").querySelector(".r");
  if (first && $("results").classList.contains("open")) first.click();
  else runSearch($("q").value.trim());
});
$("results").addEventListener("click", (e) => {
  const r = e.target.closest(".r");
  if (!r) return;
  closeResults();
  openMeeting(r.dataset.id, $("q").value.trim());
});
document.addEventListener("click", (e) => { if (!e.target.closest("#search-form")) closeResults(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeResults(); $("q").blur(); }
  if (e.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) { e.preventDefault(); $("q").focus(); }
  if (e.key === "ArrowDown" && document.activeElement === $("q")) { e.preventDefault(); $("results").querySelector(".r")?.focus(); }
});
$("results").addEventListener("keydown", (e) => {
  const items = [...$("results").querySelectorAll(".r")], i = items.indexOf(document.activeElement);
  if (e.key === "ArrowDown") { e.preventDefault(); items[Math.min(i + 1, items.length - 1)]?.focus(); }
  if (e.key === "ArrowUp") { e.preventDefault(); (i <= 0 ? $("q") : items[i - 1]).focus(); }
});

loadList();

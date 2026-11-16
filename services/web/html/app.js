"use strict";

const $ = (id) => document.getElementById(id);
const PENDING = new Set(["UPLOADING", "UPLOADED", "QUEUED", "PROCESSING"]);
const LABEL = { UPLOADING: "Uploading", UPLOADED: "Uploaded", QUEUED: "Queued",
  PROCESSING: "Transcribing", DONE: "Ready", FAILED: "Failed" };
const AVATAR_COLORS = ["#d98ba3", "#c79a86", "#a98bb8", "#e2a6a0", "#b5868f", "#c7a37b", "#9c8fb0", "#e6b3c4"];

const state = { selected: null, query: "", filter: "all", tab: "actions", meetings: [], current: null };
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
  toast.timer = setTimeout(() => t.classList.remove("show"), 2200);
}
function setMsg(text, err = false) {
  const el = $("upload-msg");
  el.textContent = text;
  el.className = "msg" + (err ? " err" : "");
}
const ICON = {
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z"/></svg>',
  cpu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>',
  empty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
};

// ---------- list + stats ----------
async function loadList() {
  try {
    const all = (await api("/api/meetings")).meetings;
    state.meetings = all;
    renderStats(all);
    let rows;
    if (state.query) {
      rows = (await api(`/api/search?q=${encodeURIComponent(state.query)}`)).results;
      $("list-title").textContent = `Results for “${state.query}”`;
    } else {
      rows = all.filter((m) =>
        state.filter === "all" ? true
          : state.filter === "pending" ? PENDING.has(m.status)
          : m.status === state.filter);
      $("list-title").textContent = { all: "All meetings", DONE: "Ready", pending: "In progress", FAILED: "Failed" }[state.filter];
    }
    $("list-hint").textContent = `${rows.length} ${rows.length === 1 ? "meeting" : "meetings"}`;
    renderList(rows);
    schedulePoll(all.some((r) => PENDING.has(r.status)));
  } catch (e) {
    $("list").innerHTML = `<div class="empty">${ICON.empty}<div><b>Couldn't load meetings</b></div><div>${esc(e.message)}</div></div>`;
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
    $("list").innerHTML = `<div class="empty">${ICON.empty}<div><b>${state.query ? "No matches" : "Nothing here yet"}</b></div>
      <div>${state.query ? "Try a different word." : "Upload a recording above to create your first meeting."}</div></div>`;
    return;
  }
  $("list").innerHTML = rows.map((m) => `
    <div class="item ${m.id === state.selected ? "sel" : ""}" data-id="${esc(m.id)}" tabindex="0" role="button">
      <div class="av" style="background:${colorFor(m.id)}">${esc(initials(m.title))}</div>
      <div style="min-width:0">
        <div class="t">${esc(m.title)}</div>
        <div class="m">${pill(m.status)}
          ${m.duration_s ? `<span>${clock(m.duration_s)}</span>` : ""}
          ${m.action_count ? `<span>${m.action_count} action${m.action_count > 1 ? "s" : ""}</span>` : ""}
          <span>${ago(m.created_at)}</span></div>
      </div>
      ${m.snippet ? `<div class="snip">${highlight(m.snippet, state.query)}</div>` : ""}
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
  state.query = ""; $("q").value = "";
  loadList();
}));

// ---------- detail ----------
function openMeeting(id) {
  state.selected = id;
  state.tab = "actions";
  document.querySelectorAll(".item").forEach((el) => el.classList.toggle("sel", el.dataset.id === id));
  loadDetail(id);
  if (window.innerWidth < 980) $("detail").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function loadDetail(id, quiet = false) {
  if (!quiet) $("detail").innerHTML = `<div class="state"><div class="spinner"></div></div>`;
  try {
    state.current = await api(`/api/meetings/${id}`);
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
  const chips = [
    pill(m.status),
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
      <div>This updates on its own. Longer recordings take about a third of their length.</div>
      ${m.error ? `<div>${esc(m.error)}</div>` : ""}
      ${m.status === "UPLOADED" ? `<button class="btn primary" data-act="retry">Queue it</button>` : ""}</div>`;
  } else {
    const tabs = `<div class="tabs" role="tablist">
      <button class="tab ${state.tab === "actions" ? "on" : ""}" data-tab="actions" role="tab">Action items<span class="n">${m.action_items.length}</span></button>
      <button class="tab ${state.tab === "transcript" ? "on" : ""}" data-tab="transcript" role="tab">Transcript</button></div>`;
    body = tabs + `<div class="d-body">${state.tab === "actions" ? actionsHtml(m) : transcriptHtml(m)}</div>`;
  }

  $("detail").innerHTML = `
    <div class="d-head"><h2>${esc(m.title)}</h2><div class="chips">${chips}</div></div>
    ${body}
    <div class="toolbar">
      ${m.status === "DONE" ? `<button class="btn" data-act="copy">Copy minutes</button>
        <button class="btn" data-act="download">Download .md</button>` : ""}
      <span class="spacer"></span>
      <button class="btn ghost danger" data-act="delete">Delete</button>
    </div>`;
}

function actionsHtml(m) {
  if (!m.action_items.length) return `<div class="empty">${ICON.empty}<div><b>No action items detected</b></div><div>Nobody committed to anything in this one.</div></div>`;
  const done = loadDone(m.id);
  const pct = Math.round((done.size / m.action_items.length) * 100);
  return `<div class="progress"><span>${done.size} of ${m.action_items.length} done</span><div class="bar"><i style="width:${pct}%"></i></div></div>
    <ul class="actions">${m.action_items.map((a, i) => `
      <li class="${done.has(i) ? "done" : ""}">
        <input class="check" type="checkbox" data-i="${i}" ${done.has(i) ? "checked" : ""} aria-label="Mark done">
        <div><div class="txt">${esc(a.text)}</div>
          <div class="tags">
            ${a.owner ? `<span class="tag owner">@${esc(a.owner)}</span>` : ""}
            ${a.due ? `<span class="tag due">${esc(a.due)}</span>` : ""}
            <span class="tag time">at ${clock(a.start)}</span>
          </div></div>
      </li>`).join("")}</ul>`;
}

function transcriptHtml(m) {
  if (!m.segments.length) return `<p>${highlight(m.transcript || "(no speech detected)", state.query)}</p>`;
  return m.segments.map((s) => `<div class="seg"><time>${clock(s.start)}</time><div>${highlight(s.text, state.query)}</div></div>`).join("");
}

function minutesMarkdown(m) {
  const lines = [`# ${m.title}`, "", `Length: ${clock(m.duration_s)}`, "", "## Action items"];
  if (!m.action_items.length) lines.push("- (none detected)");
  m.action_items.forEach((a) => lines.push(`- [ ] ${a.text}${a.owner ? ` (owner: ${a.owner})` : ""}${a.due ? ` (due: ${a.due})` : ""}`));
  lines.push("", "## Transcript", "");
  if (m.segments.length) m.segments.forEach((s) => lines.push(`[${clock(s.start)}] ${s.text}`));
  else lines.push(m.transcript);
  return lines.join("\n");
}

$("detail").addEventListener("change", (e) => {
  if (!e.target.classList.contains("check")) return;
  const m = state.current, done = loadDone(m.id), i = Number(e.target.dataset.i);
  e.target.checked ? done.add(i) : done.delete(i);
  saveDone(m.id, done);
  renderDetail();
});

$("detail").addEventListener("click", async (e) => {
  const tab = e.target.closest("[data-tab]");
  if (tab) { state.tab = tab.dataset.tab; renderDetail(); return; }
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const m = state.current;
  try {
    if (btn.dataset.act === "retry") {
      await api(`/api/meetings/${m.id}/retry`, { method: "POST" });
      toast("Queued again");
      await loadDetail(m.id); loadList();
    } else if (btn.dataset.act === "delete") {
      if (!confirm(`Delete “${m.title}” and its recording? This can't be undone.`)) return;
      await api(`/api/meetings/${m.id}`, { method: "DELETE" });
      state.selected = null; state.current = null;
      $("detail").innerHTML = `<div class="empty">${ICON.empty}<div><b>Meeting deleted</b></div></div>`;
      toast("Meeting deleted");
      loadList();
    } else if (btn.dataset.act === "copy") {
      await navigator.clipboard.writeText(minutesMarkdown(m));
      toast("Minutes copied to clipboard");
    } else if (btn.dataset.act === "download") {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([minutesMarkdown(m)], { type: "text/markdown" }));
      a.download = `${m.title.replace(/[^\w-]+/g, "_")}.md`;
      a.click();
      URL.revokeObjectURL(a.href);
    }
  } catch (err) { toast(err.message); }
});

// ---------- upload ----------
async function upload(file, nameHint) {
  const fd = new FormData();
  fd.append("title", $("title").value.trim());
  fd.append("file", file, nameHint || file.name);
  setMsg(`Uploading ${nameHint || file.name}…`);
  try {
    const m = await api("/api/meetings", { method: "POST", body: fd });
    setMsg("");
    toast("Uploaded. Transcription queued");
    $("title").value = "";
    state.query = ""; $("q").value = "";
    await loadList();
    openMeeting(m.id);
  } catch (e) {
    setMsg(`Upload failed: ${e.message}`, true);
  }
}

$("file").addEventListener("change", (e) => { if (e.target.files[0]) upload(e.target.files[0]); e.target.value = ""; });
const zone = $("zone");
["dragenter", "dragover"].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.add("over"); }));
["dragleave", "drop"].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.remove("over"); }));
zone.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) upload(f); });

// ---------- record ----------
let recorder = null, chunks = [], recStart = 0, recTick = null;
$("rec").addEventListener("click", async (e) => {
  e.preventDefault(); // the button sits inside the drop-zone label
  const btn = $("rec"), label = $("rec-label");
  if (recorder) { recorder.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
    recorder = new MediaRecorder(stream, { mimeType: mime });
    chunks = [];
    recorder.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(recTick);
      btn.classList.remove("live"); label.textContent = "● Record";
      const blob = new Blob(chunks, { type: mime });
      recorder = null;
      const ext = mime === "audio/webm" ? "webm" : "m4a";
      upload(new File([blob], `recording.${ext}`, { type: mime }), `Recording ${new Date().toLocaleString()}.${ext}`);
    };
    recorder.start(1000);
    recStart = Date.now();
    btn.classList.add("live");
    label.textContent = "Stop 0:00";
    recTick = setInterval(() => (label.textContent = `Stop ${clock((Date.now() - recStart) / 1000)}`), 500);
  } catch (err) {
    setMsg(`Microphone unavailable: ${err.message}`, true);
  }
});

// ---------- search ----------
$("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("q").value.trim();
  if (q.length === 1) { toast("Search for at least 2 characters"); return; }
  state.query = q;
  loadList();
  if (state.current?.status === "DONE") renderDetail();
});
$("q").addEventListener("search", () => { if (!$("q").value) { state.query = ""; loadList(); } });
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement.tagName !== "INPUT") { e.preventDefault(); $("q").focus(); }
});

loadList();

"use strict";

const $ = (id) => document.getElementById(id);
const PENDING = new Set(["UPLOADING", "UPLOADED", "QUEUED", "PROCESSING"]);
const LABEL = { UPLOADING: "Uploading", UPLOADED: "Uploaded", QUEUED: "Queued",
  PROCESSING: "Transcribing", DONE: "Ready", FAILED: "Failed" };

let selected = null;
let searchQuery = "";
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
  return new Date(ts * 1000).toLocaleDateString();
}
async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const pod = res.headers.get("X-Served-By");
  if (pod) lastPod = pod;
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || `${res.status} ${res.statusText}`);
  return body;
}
let lastPod = null;
function badge(status) {
  return `<span class="badge s-${esc(status)}">${esc(LABEL[status] || status)}</span>`;
}
function setMsg(text, err = false) {
  const el = $("upload-msg");
  el.textContent = text;
  el.className = "msg" + (err ? " err" : "");
}

// ---------- list ----------
async function loadList() {
  try {
    let rows;
    if (searchQuery) {
      rows = (await api(`/api/search?q=${encodeURIComponent(searchQuery)}`)).results;
      $("list-title").textContent = `Results for “${searchQuery}” (${rows.length})`;
    } else {
      rows = (await api("/api/meetings")).meetings;
      $("list-title").textContent = `Meetings (${rows.length})`;
    }
    renderList(rows);
    schedulePoll(rows.some((r) => PENDING.has(r.status)));
  } catch (e) {
    $("list").innerHTML = `<div class="empty">Couldn't load meetings: ${esc(e.message)}</div>`;
    schedulePoll(true);
  }
  loadFooter();
}

function renderList(rows) {
  if (!rows.length) {
    $("list").innerHTML = `<div class="empty">${searchQuery ? "No matches." : "No meetings yet."}</div>`;
    return;
  }
  $("list").innerHTML = rows.map((m) => `
    <div class="item ${m.id === selected ? "sel" : ""}" data-id="${esc(m.id)}" tabindex="0" role="button">
      <div class="t">${esc(m.title)}</div>
      <div class="m">${badge(m.status)}
        ${m.duration_s ? `<span>${clock(m.duration_s)}</span>` : ""}
        ${m.action_count ? `<span>${m.action_count} action item${m.action_count > 1 ? "s" : ""}</span>` : ""}
        <span>${ago(m.created_at)}</span></div>
      ${m.snippet ? `<div class="m">${highlight(m.snippet, searchQuery)}</div>` : ""}
    </div>`).join("");
}

function schedulePoll(active) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(() => { loadList(); if (selected) loadDetail(selected, true); }, active ? 3000 : 15000);
}

$("list").addEventListener("click", (e) => {
  const row = e.target.closest(".item");
  if (row) openMeeting(row.dataset.id);
});
$("list").addEventListener("keydown", (e) => {
  const row = e.target.closest(".item");
  if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openMeeting(row.dataset.id); }
});

// ---------- detail ----------
function openMeeting(id) {
  selected = id;
  document.querySelectorAll(".item").forEach((el) => el.classList.toggle("sel", el.dataset.id === id));
  loadDetail(id);
}

async function loadDetail(id, quiet = false) {
  if (!quiet) $("detail").innerHTML = `<div class="empty">Loading…</div>`;
  try {
    renderDetail(await api(`/api/meetings/${id}`));
  } catch (e) {
    if (!quiet) $("detail").innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function doneKey(id) { return `mt-done-${id}`; }
function loadDone(id) { try { return new Set(JSON.parse(localStorage.getItem(doneKey(id)) || "[]")); } catch { return new Set(); } }
function saveDone(id, set) { try { localStorage.setItem(doneKey(id), JSON.stringify([...set])); } catch { /* private mode */ } }

function renderDetail(m) {
  const facts = [
    badge(m.status),
    m.duration_s ? `Length ${clock(m.duration_s)}` : "",
    m.processing_s ? `Transcribed in ${m.processing_s}s` : "",
    m.processed_by ? `by worker <code>${esc(m.processed_by)}</code>` : "",
    `Added ${ago(m.created_at)}`,
  ].filter(Boolean).map((f) => `<span>${f}</span>`).join("");

  let body = "";
  if (m.status === "FAILED") {
    body = `<div class="section"><p class="msg err">${esc(m.error || "Transcription failed.")}</p>
      <button class="primary" data-act="retry">Try again</button></div>`;
  } else if (PENDING.has(m.status)) {
    body = `<div class="section"><p class="msg">${m.status === "PROCESSING"
      ? "A worker is transcribing this recording now…"
      : "Waiting for a free worker…"} This page updates by itself.</p>
      ${m.error ? `<p class="msg">${esc(m.error)}</p>` : ""}
      ${m.status === "UPLOADED" ? `<button data-act="retry">Queue it</button>` : ""}</div>`;
  } else {
    const done = loadDone(m.id);
    const actions = m.action_items.length
      ? `<ul class="actions">${m.action_items.map((a, i) => `
          <li class="${done.has(i) ? "done" : ""}">
            <input type="checkbox" data-i="${i}" ${done.has(i) ? "checked" : ""} aria-label="Mark done">
            <div><div class="txt">${esc(a.text)}</div>
              <div class="meta">
                ${a.owner ? `<span>👤 ${esc(a.owner)}</span>` : ""}
                ${a.due ? `<span>📅 ${esc(a.due)}</span>` : ""}
                <span>at ${clock(a.start)}</span></div></div>
          </li>`).join("")}</ul>`
      : `<p class="msg">No action items detected.</p>`;
    const transcript = m.segments.length
      ? m.segments.map((s) => `<div class="seg"><time>${clock(s.start)}</time><div>${highlight(s.text, searchQuery)}</div></div>`).join("")
      : `<p>${highlight(m.transcript || "(no speech detected)", searchQuery)}</p>`;
    body = `
      <div class="section"><h4>Action items</h4>${actions}</div>
      <div class="section"><h4>Transcript</h4>${transcript}</div>
      <div class="toolbar">
        <button data-act="copy">Copy minutes</button>
        <button data-act="download">Download .md</button>
      </div>`;
  }
  $("detail").innerHTML = `<h3>${esc(m.title)}</h3><div class="facts">${facts}</div>${body}
    <div class="toolbar"><button data-act="delete">Delete meeting</button></div>`;
  $("detail").dataset.id = m.id;
  $("detail")._meeting = m;
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
  if (e.target.type !== "checkbox") return;
  const id = $("detail").dataset.id, done = loadDone(id), i = Number(e.target.dataset.i);
  e.target.checked ? done.add(i) : done.delete(i);
  saveDone(id, done);
  e.target.closest("li").classList.toggle("done", e.target.checked);
});

$("detail").addEventListener("click", async (e) => {
  const act = e.target.dataset.act;
  if (!act) return;
  const m = $("detail")._meeting;
  try {
    if (act === "retry") {
      await api(`/api/meetings/${m.id}/retry`, { method: "POST" });
      await loadDetail(m.id); loadList();
    } else if (act === "delete") {
      if (!confirm(`Delete “${m.title}” and its recording? This can't be undone.`)) return;
      await api(`/api/meetings/${m.id}`, { method: "DELETE" });
      selected = null;
      $("detail").innerHTML = `<div class="empty">Meeting deleted.</div>`;
      loadList();
    } else if (act === "copy") {
      await navigator.clipboard.writeText(minutesMarkdown(m));
      e.target.textContent = "Copied ✓";
      setTimeout(() => (e.target.textContent = "Copy minutes"), 1500);
    } else if (act === "download") {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([minutesMarkdown(m)], { type: "text/markdown" }));
      a.download = `${m.title.replace(/[^\w-]+/g, "_")}.md`;
      a.click();
      URL.revokeObjectURL(a.href);
    }
  } catch (err) { alert(err.message); }
});

// ---------- upload ----------
async function upload(file, nameHint) {
  const fd = new FormData();
  fd.append("title", $("title").value.trim());
  fd.append("file", file, nameHint || file.name);
  setMsg(`Uploading ${nameHint || file.name}…`);
  try {
    const m = await api("/api/meetings", { method: "POST", body: fd });
    setMsg("Uploaded. Transcription has been queued.");
    $("title").value = "";
    searchQuery = ""; $("q").value = "";
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
$("rec").addEventListener("click", async () => {
  const btn = $("rec");
  if (recorder) { recorder.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
    recorder = new MediaRecorder(stream, { mimeType: mime });
    chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(recTick);
      btn.classList.remove("live"); btn.textContent = "● Record from mic";
      const blob = new Blob(chunks, { type: mime });
      recorder = null;
      const ext = mime === "audio/webm" ? "webm" : "m4a";
      upload(new File([blob], `recording.${ext}`, { type: mime }), `Recording ${new Date().toLocaleString()}.${ext}`);
    };
    recorder.start(1000);
    recStart = Date.now();
    btn.classList.add("live");
    recTick = setInterval(() => (btn.textContent = `■ Stop recording (${clock((Date.now() - recStart) / 1000)})`), 500);
  } catch (e) {
    setMsg(`Microphone unavailable: ${e.message}`, true);
  }
});

// ---------- search ----------
$("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  searchQuery = $("q").value.trim();
  if (searchQuery.length === 1) { setMsg("Search for at least 2 characters.", true); return; }
  loadList();
  if (selected) loadDetail(selected, true);
});
$("q").addEventListener("search", () => { if (!$("q").value) { searchQuery = ""; loadList(); } });

// ---------- footer: which pods are answering (handy for the scaling demo) ----------
async function loadFooter() {
  try {
    const s = await api("/api/stats");
    $("footer").innerHTML = `API pod <code>${esc(s.pod)}</code> · queue: ${s.queue.waiting} waiting, ${s.queue.in_progress} in progress`;
  } catch { $("footer").textContent = lastPod ? `API pod ${lastPod}` : ""; }
}

loadList();

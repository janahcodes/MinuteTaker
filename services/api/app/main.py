"""MinuteTaker API service.

Accepts meeting recordings, stores them in S3, records them in DynamoDB and
queues a transcription job on SQS. The worker service does the transcription;
this service only reads its results back.
"""
from __future__ import annotations

import logging
import os
import re
import socket
import uuid
from functools import lru_cache

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse

from .notes import make_notes
from .store import Settings, Store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("api")

MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_MB", "50")) * 1024 * 1024
ALLOWED_TYPES = {
    "audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/m4a", "audio/wav",
    "audio/x-wav", "audio/wave", "audio/webm", "audio/ogg", "audio/flac", "video/mp4",
    "video/webm", "audio/aac",
}
HOSTNAME = socket.gethostname()

app = FastAPI(title="MinuteTaker API", version="1.0.0")


@lru_cache
def get_store() -> Store:
    return Store(Settings.from_env())


@app.middleware("http")
async def served_by(request: Request, call_next):
    # Lets the demo show which replica answered each request.
    response = await call_next(request)
    response.headers["X-Served-By"] = HOSTNAME
    return response


@app.exception_handler(ClientError)
@app.exception_handler(BotoCoreError)
async def aws_error(_: Request, exc: Exception):
    log.error("dependency error: %s", exc)
    return JSONResponse(status_code=503, content={"detail": "A backing service is unavailable. Try again shortly."})


# ---- probes ---------------------------------------------------------------
@app.get("/healthz")
def healthz():
    """Liveness: the process is up and serving HTTP. No dependency checks."""
    return {"status": "ok", "pod": HOSTNAME}


@app.get("/readyz")
def readyz(store: Store = Depends(get_store)):
    """Readiness: we can reach DynamoDB, so we can do useful work."""
    try:
        store.ping()
    except Exception as exc:  # noqa: BLE001 - any failure means "not ready"
        log.warning("not ready: %s", exc)
        raise HTTPException(status_code=503, detail="datastore unreachable")
    return {"status": "ready", "pod": HOSTNAME}


# ---- meetings -------------------------------------------------------------
@app.post("/api/meetings", status_code=201)
def create_meeting(
    title: str = Form("", max_length=200),
    kind: str = Form("meeting"),
    file: UploadFile = File(...),
    store: Store = Depends(get_store),
):
    content_type = (file.content_type or "").split(";")[0].strip().lower()
    if content_type not in ALLOWED_TYPES:
        raise HTTPException(415, f"Unsupported file type '{content_type}'. Upload an audio file.")

    file.file.seek(0, os.SEEK_END)
    size = file.file.tell()
    file.file.seek(0)
    if size == 0:
        raise HTTPException(400, "The file is empty.")
    if size > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"File is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.")

    if kind not in {"meeting", "lecture"}:
        raise HTTPException(400, "kind must be 'meeting' or 'lecture'.")
    meeting_id = uuid.uuid4().hex[:12]
    title = title.strip() or _default_title(file.filename)
    key = f"uploads/{meeting_id}/{_safe_name(file.filename)}"

    # Order matters for failure handling:
    # 1. record the meeting (UPLOADING) so a crash leaves a visible trace,
    # 2. store the audio, 3. mark UPLOADED, 4. queue the job, 5. mark QUEUED.
    # If step 4 fails the meeting stays UPLOADED and can be re-queued with
    # POST /api/meetings/{id}/retry.
    meeting = store.create_meeting(meeting_id, title, key, size, kind)
    store.upload_audio(key, file.file, content_type)
    store.set_status(meeting_id, "UPLOADED")
    store.enqueue(meeting_id)
    store.set_status(meeting_id, "QUEUED")
    meeting["status"] = "QUEUED"
    log.info("queued meeting %s (%d bytes)", meeting_id, size)
    return _public(meeting)


@app.get("/api/meetings")
def list_meetings(store: Store = Depends(get_store)):
    return {"meetings": [_public(m) for m in store.list_meetings()]}


@app.get("/api/meetings/{meeting_id}")
def get_meeting(meeting_id: str, store: Store = Depends(get_store)):
    return _public(_require(store, meeting_id), full=True)


@app.post("/api/meetings/{meeting_id}/retry")
def retry_meeting(meeting_id: str, store: Store = Depends(get_store)):
    meeting = _require(store, meeting_id)
    if meeting["status"] not in {"UPLOADED", "FAILED"}:
        raise HTTPException(409, f"Meeting is {meeting['status']}; only UPLOADED or FAILED meetings can be retried.")
    store.enqueue(meeting_id)
    store.set_status(meeting_id, "QUEUED")
    return {"id": meeting_id, "status": "QUEUED"}


@app.delete("/api/meetings/{meeting_id}", status_code=204)
def delete_meeting(meeting_id: str, store: Store = Depends(get_store)):
    store.delete_meeting(_require(store, meeting_id))


@app.get("/api/meetings/{meeting_id}/notes")
def lecture_notes(meeting_id: str, store: Store = Depends(get_store)):
    """Condensed study notes built from the transcript (see notes.py)."""
    m = _require(store, meeting_id)
    if m.get("status") != "DONE":
        raise HTTPException(409, "Notes are available once the transcript is ready.")
    segments = [{"start": float(s["start"]), "end": float(s["end"]), "text": s["text"]} for s in m.get("segments", [])]
    duration = float(m["duration_s"]) if m.get("duration_s") is not None else None
    return make_notes(m.get("title", ""), segments, m.get("transcript", ""), duration)


@app.get("/api/search")
def search(q: str, store: Store = Depends(get_store)):
    q = q.strip()
    if len(q) < 2:
        raise HTTPException(400, "Search for at least 2 characters.")
    return {"query": q, "results": store.search(q)}


@app.get("/api/stats")
def stats(store: Store = Depends(get_store)):
    return {"queue": store.queue_depth(), "pod": HOSTNAME}


# ---- helpers --------------------------------------------------------------
def _require(store: Store, meeting_id: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{12}", meeting_id):
        raise HTTPException(404, "Meeting not found.")
    meeting = store.get_meeting(meeting_id)
    if not meeting:
        raise HTTPException(404, "Meeting not found.")
    return meeting


def _public(m: dict, full: bool = False) -> dict:
    out = {
        "id": m["id"],
        "title": m.get("title", ""),
        "kind": m.get("kind", "meeting"),
        "status": m.get("status"),
        "created_at": _num(m.get("created_at")),
        "duration_s": _num(m.get("duration_s")),
        "action_count": _num(m.get("action_count")),
        "error": m.get("error"),
    }
    if full:
        out["transcript"] = m.get("transcript", "")
        out["segments"] = [
            {"start": _num(s["start"]), "end": _num(s["end"]), "text": s["text"]}
            for s in m.get("segments", [])
        ]
        out["action_items"] = m.get("action_items", [])
        out["processed_by"] = m.get("processed_by")
        out["processing_s"] = _num(m.get("processing_s"))
    return out


def _num(v):
    """DynamoDB returns Decimal; JSON wants int/float."""
    if v is None:
        return None
    f = float(v)
    return int(f) if f.is_integer() else round(f, 2)


def _safe_name(name: str | None) -> str:
    name = os.path.basename(name or "recording")
    return re.sub(r"[^A-Za-z0-9._-]", "_", name)[:100] or "recording"


def _default_title(name: str | None) -> str:
    stem = os.path.splitext(os.path.basename(name or ""))[0]
    return stem.replace("_", " ").replace("-", " ").strip()[:200] or "Untitled meeting"

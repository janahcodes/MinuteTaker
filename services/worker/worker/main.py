"""MinuteTaker transcription worker.

Long-polls SQS for meeting IDs, downloads the audio from S3, transcribes it
with Whisper, extracts action items and writes the result to DynamoDB.

Reliability rules (see docs/report.md, "Worker failure modes"):
* A message is deleted only after the result is saved, so a crash mid-job
  means the job is redelivered, never lost.
* While a job runs, a heartbeat thread keeps extending the message's
  visibility timeout. If the pod dies the heartbeat stops and the job
  reappears on the queue within VISIBILITY_TIMEOUT seconds.
* Processing is idempotent: a meeting already DONE is skipped, so duplicate
  deliveries are harmless.
* Bad input (undecodable / too long) fails at once. Other errors are retried
  with backoff up to MAX_RECEIVES times; the queue's redrive policy moves
  messages that keep crashing the worker to a dead-letter queue.
"""
from __future__ import annotations

import json
import logging
import os
import signal
import socket
import tempfile
import threading
import time
from datetime import datetime
from decimal import Decimal
from zoneinfo import ZoneInfo
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Protocol

import boto3
from boto3.dynamodb.conditions import Attr
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from .actions import extract_action_items

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("worker")

HOSTNAME = socket.gethostname()
MAX_DDB_ITEM_BYTES = 350_000  # DynamoDB's hard limit is 400 KB per item
# Deadlines like "by Friday" are resolved in the users' time zone.
LOCAL_TZ = ZoneInfo(os.environ.get("TZ_NAME", "America/New_York"))


class PermanentError(Exception):
    """The input itself is bad; retrying will not help."""


class Transcriber(Protocol):
    def transcribe(self, path: str, on_progress: Callable[[], None]) -> tuple[list[dict], float]:
        """Return (segments, duration_seconds). Each segment: {start, end, text}."""


class WhisperTranscriber:
    """faster-whisper on CPU with int8 weights. The model is baked into the image."""

    def __init__(self, model: str, model_dir: str, threads: int, max_minutes: float):
        from faster_whisper import WhisperModel  # heavy import; keep tests fast

        self.max_seconds = max_minutes * 60
        self.model = WhisperModel(
            model, device="cpu", compute_type="int8", download_root=model_dir, cpu_threads=threads
        )

    def transcribe(self, path, on_progress):
        try:
            segments, info = self.model.transcribe(path, beam_size=1, vad_filter=True)
        except Exception as exc:  # PyAV raises a variety of errors on bad media
            raise PermanentError(f"Could not decode audio: {exc}") from exc
        if info.duration > self.max_seconds:
            raise PermanentError(
                f"Recording is {info.duration / 60:.0f} min; the limit is {self.max_seconds / 60:.0f} min."
            )
        out = []
        for s in segments:  # generator: decoding happens as we iterate
            out.append({"start": s.start, "end": s.end, "text": s.text.strip()})
            on_progress()
        return out, info.duration


class Health:
    """Shared state behind the /healthz and /readyz endpoints."""

    def __init__(self, stall_after: float):
        self.stall_after = stall_after
        self.last_beat = time.monotonic()
        self.ready = False

    def beat(self):
        self.last_beat = time.monotonic()

    def alive(self) -> bool:
        return time.monotonic() - self.last_beat < self.stall_after


def serve_health(health: Health, port: int) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/healthz":
                ok = health.alive()
            elif self.path == "/readyz":
                ok = health.ready and health.alive()
            else:
                self.send_error(404)
                return
            self.send_response(200 if ok else 503)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": ok, "pod": HOSTNAME}).encode())

        def log_message(self, *args):  # keep probe traffic out of the logs
            pass

    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class Worker:
    def __init__(self, transcriber: Transcriber, health: Health | None = None):
        cfg = Config(connect_timeout=3, read_timeout=30, retries={"max_attempts": 5, "mode": "standard"})
        session = boto3.session.Session(region_name=os.environ.get("AWS_REGION", "us-east-1"))
        self.table = session.resource("dynamodb", config=cfg).Table(os.environ["TABLE_NAME"])
        self.s3 = session.client("s3", config=cfg)
        self.sqs = session.client("sqs", config=cfg)
        self.bucket = os.environ["BUCKET_NAME"]
        self.queue_url = os.environ["QUEUE_URL"]
        self.visibility = int(os.environ.get("VISIBILITY_TIMEOUT", "120"))
        self.max_receives = int(os.environ.get("MAX_RECEIVES", "3"))
        self.transcriber = transcriber
        self.health = health or Health(stall_after=300)
        self.stopping = threading.Event()

    # ---- main loop ------------------------------------------------------
    def run(self):
        log.info("worker %s polling %s", HOSTNAME, self.queue_url)
        while not self.stopping.is_set():
            self.health.beat()
            try:
                self.poll_once()
            except (ClientError, BotoCoreError) as exc:
                # SQS/DynamoDB unreachable or erroring: back off, don't crash
                # the pod (a restart can't fix a downstream outage).
                log.error("AWS error in poll loop: %s", exc)
                self.stopping.wait(5)
        log.info("worker %s stopped cleanly", HOSTNAME)

    def poll_once(self, wait: int = 20) -> int:
        resp = self.sqs.receive_message(
            QueueUrl=self.queue_url,
            MaxNumberOfMessages=1,
            WaitTimeSeconds=wait,
            VisibilityTimeout=self.visibility,
            AttributeNames=["ApproximateReceiveCount"],
        )
        msgs = resp.get("Messages", [])
        for msg in msgs:
            self.handle(msg)
        return len(msgs)

    # ---- one job --------------------------------------------------------
    def handle(self, msg: dict):
        meeting_id = msg["Body"].strip()
        receipt = msg["ReceiptHandle"]
        receives = int(msg.get("Attributes", {}).get("ApproximateReceiveCount", "1"))
        log.info("job %s (delivery %d)", meeting_id, receives)

        meeting = self.claim(meeting_id)
        if meeting is None:
            self.ack(receipt)  # deleted or already done: drop the duplicate
            return

        stop_heartbeat = self.keep_invisible(receipt)
        t0 = time.monotonic()
        try:
            result = self.process(meeting)
        except PermanentError as exc:
            log.warning("job %s failed permanently: %s", meeting_id, exc)
            self.mark_failed(meeting_id, str(exc))
            self.ack(receipt)
            return
        except Exception as exc:  # noqa: BLE001 - anything else is retryable
            log.exception("job %s failed (delivery %d)", meeting_id, receives)
            if receives >= self.max_receives:
                self.mark_failed(meeting_id, f"Gave up after {receives} attempts: {exc}")
                self.ack(receipt)
            else:
                self.requeue(meeting_id, receipt, receives, str(exc))
            return
        finally:
            stop_heartbeat()

        result["processing_s"] = Decimal(str(round(time.monotonic() - t0, 2)))
        try:
            self.save(meeting_id, result)
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
            log.info("job %s was deleted while transcribing; result discarded", meeting_id)
        self.ack(receipt)
        log.info("job %s done in %.1fs, %d action items", meeting_id,
                 float(result["processing_s"]), len(result["action_items"]))

    def claim(self, meeting_id: str) -> dict | None:
        """Move the meeting to PROCESSING unless it's gone or already DONE."""
        try:
            return self.table.update_item(
                Key={"id": meeting_id},
                UpdateExpression="SET #s = :p, processed_by = :h, started_at = :t ADD attempts :one",
                ConditionExpression=Attr("id").exists() & Attr("status").ne("DONE"),
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={":p": "PROCESSING", ":h": HOSTNAME, ":t": int(time.time()), ":one": 1},
                ReturnValues="ALL_NEW",
            )["Attributes"]
        except ClientError as exc:
            if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
                log.info("job %s skipped (missing or already done)", meeting_id)
                return None
            raise

    def process(self, meeting: dict) -> dict:
        suffix = os.path.splitext(meeting["s3_key"])[1] or ".audio"
        with tempfile.NamedTemporaryFile(suffix=suffix) as tmp:
            try:
                self.s3.download_fileobj(self.bucket, meeting["s3_key"], tmp)
            except ClientError as exc:
                if exc.response["Error"]["Code"] in {"404", "NoSuchKey"}:
                    raise PermanentError("Audio file is missing from storage.") from exc
                raise
            tmp.flush()
            segments, duration = self.transcriber.transcribe(tmp.name, self.health.beat)

        transcript = " ".join(s["text"] for s in segments).strip()
        meeting_day = datetime.fromtimestamp(int(meeting.get("created_at") or time.time()), LOCAL_TZ).date()
        actions = extract_action_items(segments, ref=meeting_day)
        return {
            "transcript": transcript,
            "segments": [
                {"start": _dec(s["start"]), "end": _dec(s["end"]), "text": s["text"]} for s in segments
            ],
            "action_items": [{**a, "start": _dec(a["start"])} for a in actions],
            "duration_s": _dec(duration),
        }

    # ---- DynamoDB writes ----------------------------------------------
    def save(self, meeting_id: str, r: dict):
        # Keep under DynamoDB's 400 KB item limit: timestamps are a nice-to-have.
        if len(json.dumps(r, default=str)) > MAX_DDB_ITEM_BYTES:
            r["segments"] = []
        if len(r["transcript"]) > MAX_DDB_ITEM_BYTES // 2:
            r["transcript"] = r["transcript"][: MAX_DDB_ITEM_BYTES // 2] + " …[truncated]"
        self.table.update_item(
            Key={"id": meeting_id},
            UpdateExpression=(
                "SET #s = :d, #tr = :t, transcript_lower = :tl, #seg = :seg, "
                "action_items = :a, action_count = :ac, duration_s = :dur, processing_s = :ps, "
                "finished_at = :f REMOVE #e"
            ),
            # Never resurrect a meeting the user deleted mid-transcription.
            ConditionExpression=Attr("id").exists(),
            # status, error, segments and transcript collide with DynamoDB reserved words
            ExpressionAttributeNames={"#s": "status", "#e": "error", "#seg": "segments", "#tr": "transcript"},
            ExpressionAttributeValues={
                ":d": "DONE", ":t": r["transcript"], ":tl": r["transcript"].lower(),
                ":seg": r["segments"], ":a": r["action_items"], ":ac": len(r["action_items"]),
                ":dur": r["duration_s"], ":ps": r["processing_s"], ":f": int(time.time()),
            },
        )

    def mark_failed(self, meeting_id: str, error: str):
        self.table.update_item(
            Key={"id": meeting_id},
            UpdateExpression="SET #s = :f, #e = :e",
            ConditionExpression=Attr("id").exists(),
            ExpressionAttributeNames={"#s": "status", "#e": "error"},
            ExpressionAttributeValues={":f": "FAILED", ":e": error[:500]},
        )

    # ---- SQS bookkeeping -----------------------------------------------
    def ack(self, receipt: str):
        self.sqs.delete_message(QueueUrl=self.queue_url, ReceiptHandle=receipt)

    def requeue(self, meeting_id: str, receipt: str, receives: int, error: str):
        backoff = min(30 * 2 ** (receives - 1), 600)  # 30s, 60s, 120s ... capped
        self.table.update_item(
            Key={"id": meeting_id},
            UpdateExpression="SET #s = :q, #e = :e",
            ExpressionAttributeNames={"#s": "status", "#e": "error"},
            ExpressionAttributeValues={":q": "QUEUED", ":e": f"Retrying: {error[:300]}"},
        )
        self.sqs.change_message_visibility(QueueUrl=self.queue_url, ReceiptHandle=receipt, VisibilityTimeout=backoff)
        log.info("job %s will be retried in %ds", meeting_id, backoff)

    def keep_invisible(self, receipt: str) -> Callable[[], None]:
        """Extend the message's visibility every visibility/2 s until stopped."""
        done = threading.Event()

        def loop():
            while not done.wait(self.visibility / 2):
                try:
                    self.sqs.change_message_visibility(
                        QueueUrl=self.queue_url, ReceiptHandle=receipt, VisibilityTimeout=self.visibility
                    )
                except ClientError as exc:
                    log.warning("could not extend visibility: %s", exc)

        threading.Thread(target=loop, daemon=True).start()
        return done.set


def _dec(x: float) -> Decimal:
    return Decimal(str(round(float(x), 2)))


def main():
    health = Health(stall_after=float(os.environ.get("STALL_AFTER_S", "300")))
    serve_health(health, int(os.environ.get("HEALTH_PORT", "8081")))

    log.info("loading model %s", os.environ.get("WHISPER_MODEL", "tiny.en"))
    transcriber = WhisperTranscriber(
        model=os.environ.get("WHISPER_MODEL", "tiny.en"),
        model_dir=os.environ.get("MODEL_DIR", "/models"),
        threads=int(os.environ.get("CPU_THREADS", "1")),
        max_minutes=float(os.environ.get("MAX_AUDIO_MINUTES", "45")),
    )
    worker = Worker(transcriber, health)
    health.ready = True

    def on_sigterm(*_):
        # Kubernetes sends SIGTERM on scale-in / rollout. Finish the current
        # job (up to terminationGracePeriodSeconds), then exit; an unfinished
        # job simply becomes visible on the queue again.
        log.info("SIGTERM: finishing current job then exiting")
        worker.stopping.set()

    signal.signal(signal.SIGTERM, on_sigterm)
    signal.signal(signal.SIGINT, on_sigterm)
    worker.run()


if __name__ == "__main__":
    main()

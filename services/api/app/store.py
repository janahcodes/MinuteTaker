"""Thin wrappers around the three managed services the API uses.

DynamoDB holds one item per meeting, S3 holds the audio, SQS carries
"please transcribe meeting X" jobs to the worker. Endpoints are taken from
the standard AWS environment variables, so the same code talks to real AWS
or to a local emulator when AWS_ENDPOINT_URL is set.
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Any, BinaryIO

import boto3
from boto3.dynamodb.conditions import Attr
from botocore.config import Config

# Short timeouts and few retries: a request should fail fast with a 503
# instead of hanging while a dependency is down.
_BOTO_CONFIG = Config(
    connect_timeout=2,
    read_timeout=5,
    retries={"max_attempts": 3, "mode": "standard"},
)

# Fields returned by the list endpoint (the transcript can be large).
SUMMARY_FIELDS = ["id", "title", "kind", "status", "created_at", "duration_s", "action_count", "error"]


@dataclass
class Settings:
    table_name: str
    bucket_name: str
    queue_url: str
    region: str

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            table_name=os.environ["TABLE_NAME"],
            bucket_name=os.environ["BUCKET_NAME"],
            queue_url=os.environ["QUEUE_URL"],
            region=os.environ.get("AWS_REGION", "us-east-1"),
        )


class Store:
    def __init__(self, settings: Settings):
        self.s = settings
        session = boto3.session.Session(region_name=settings.region)
        self.table = session.resource("dynamodb", config=_BOTO_CONFIG).Table(settings.table_name)
        self.s3 = session.client("s3", config=_BOTO_CONFIG)
        self.sqs = session.client("sqs", config=_BOTO_CONFIG)

    # ---- meetings (DynamoDB) -------------------------------------------
    def create_meeting(self, meeting_id: str, title: str, s3_key: str, size: int, kind: str = "meeting") -> dict:
        item = {
            "id": meeting_id,
            "title": title,
            "title_lower": title.lower(),
            "kind": kind,
            "status": "UPLOADING",
            "s3_key": s3_key,
            "size_bytes": size,
            "created_at": int(time.time()),
        }
        self.table.put_item(Item=item, ConditionExpression=Attr("id").not_exists())
        return item

    def set_status(self, meeting_id: str, status: str) -> None:
        self.table.update_item(
            Key={"id": meeting_id},
            UpdateExpression="SET #s = :s",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":s": status},
        )

    def get_meeting(self, meeting_id: str) -> dict | None:
        return self.table.get_item(Key={"id": meeting_id}).get("Item")

    def list_meetings(self, limit: int = 100) -> list[dict]:
        # A scan is fine at class-project scale; see docs/report.md for the
        # GSI we would add before this held thousands of meetings.
        items: list[dict] = []
        kwargs: dict[str, Any] = {
            "ProjectionExpression": ", ".join(f"#{f}" for f in SUMMARY_FIELDS),
            "ExpressionAttributeNames": {f"#{f}": f for f in SUMMARY_FIELDS},
        }
        while True:
            page = self.table.scan(**kwargs)
            items.extend(page["Items"])
            if "LastEvaluatedKey" not in page or len(items) >= limit:
                break
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
        items.sort(key=lambda m: m.get("created_at", 0), reverse=True)
        return items[:limit]

    def search(self, query: str, limit: int = 50) -> list[dict]:
        q = query.lower()
        kwargs: dict[str, Any] = {
            "FilterExpression": Attr("transcript_lower").contains(q) | Attr("title_lower").contains(q),
            "ProjectionExpression": "#id, #t, #s, created_at, transcript",
            "ExpressionAttributeNames": {"#id": "id", "#t": "title", "#s": "status"},
        }
        hits: list[dict] = []
        while True:
            page = self.table.scan(**kwargs)
            for item in page["Items"]:
                hits.append({
                    "id": item["id"],
                    "title": item.get("title", ""),
                    "status": item.get("status"),
                    "created_at": item.get("created_at"),
                    "snippet": _snippet(item.get("transcript", ""), q),
                })
            if "LastEvaluatedKey" not in page or len(hits) >= limit:
                break
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
        hits.sort(key=lambda m: m.get("created_at") or 0, reverse=True)
        return hits[:limit]

    def delete_meeting(self, meeting: dict) -> None:
        self.s3.delete_object(Bucket=self.s.bucket_name, Key=meeting["s3_key"])
        self.table.delete_item(Key={"id": meeting["id"]})

    # ---- audio (S3) -----------------------------------------------------
    def upload_audio(self, key: str, fileobj: BinaryIO, content_type: str) -> None:
        self.s3.upload_fileobj(
            fileobj, self.s.bucket_name, key, ExtraArgs={"ContentType": content_type}
        )

    # ---- jobs (SQS) -----------------------------------------------------
    def enqueue(self, meeting_id: str) -> None:
        self.sqs.send_message(QueueUrl=self.s.queue_url, MessageBody=meeting_id)

    def queue_depth(self) -> dict:
        attrs = self.sqs.get_queue_attributes(
            QueueUrl=self.s.queue_url,
            AttributeNames=["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
        )["Attributes"]
        return {
            "waiting": int(attrs.get("ApproximateNumberOfMessages", 0)),
            "in_progress": int(attrs.get("ApproximateNumberOfMessagesNotVisible", 0)),
        }

    # ---- health ---------------------------------------------------------
    def ping(self) -> None:
        """Raise if the table cannot be reached. Used by the readiness probe."""
        self.table.meta.client.describe_table(TableName=self.s.table_name)


def _snippet(text: str, q: str, width: int = 80) -> str:
    i = text.lower().find(q)
    if i < 0:
        return text[: width * 2]
    start = max(0, i - width)
    end = min(len(text), i + len(q) + width)
    return ("…" if start else "") + text[start:end] + ("…" if end < len(text) else "")

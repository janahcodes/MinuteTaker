"""Worker tests: a fake transcriber stands in for Whisper, moto stands in for AWS."""
import os

import boto3
import pytest
from moto import mock_aws

from worker.actions import extract_action_items
from worker.main import Health, PermanentError, Worker

os.environ.update(
    AWS_ACCESS_KEY_ID="test", AWS_SECRET_ACCESS_KEY="test",
    AWS_REGION="us-east-1", AWS_DEFAULT_REGION="us-east-1",
    TABLE_NAME="meetings", BUCKET_NAME="audio", VISIBILITY_TIMEOUT="30",
)

SEGMENTS = [
    {"start": 0.0, "end": 4.0, "text": "Okay, thanks everyone for joining."},
    {"start": 4.0, "end": 9.5, "text": "Sarah, can you send the revised proposal to the client by Friday?"},
    {"start": 9.5, "end": 13.0, "text": "Sure. I'll also update the budget sheet."},
    {"start": 13.0, "end": 17.0, "text": "The demo went well last week."},
]


class FakeTranscriber:
    def __init__(self, fail_with=None):
        self.calls = 0
        self.fail_with = fail_with

    def transcribe(self, path, on_progress):
        self.calls += 1
        assert os.path.getsize(path) > 0
        if self.fail_with:
            raise self.fail_with
        on_progress()
        return SEGMENTS, 17.0


@pytest.fixture
def aws():
    with mock_aws():
        boto3.client("dynamodb").create_table(
            TableName="meetings",
            KeySchema=[{"AttributeName": "id", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "id", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        s3 = boto3.client("s3")
        s3.create_bucket(Bucket="audio")
        sqs = boto3.client("sqs")
        os.environ["QUEUE_URL"] = sqs.create_queue(QueueName="jobs")["QueueUrl"]
        table = boto3.resource("dynamodb").Table("meetings")
        yield s3, sqs, table


def add_meeting(s3, sqs, table, mid="abc123abc123", status="QUEUED", upload=True):
    key = f"uploads/{mid}/call.wav"
    if upload:
        s3.put_object(Bucket="audio", Key=key, Body=b"RIFFfakeaudio")
    table.put_item(Item={"id": mid, "title": "Call", "status": status, "s3_key": key})
    sqs.send_message(QueueUrl=os.environ["QUEUE_URL"], MessageBody=mid)
    return mid


def queue_empty(sqs):
    attrs = sqs.get_queue_attributes(
        QueueUrl=os.environ["QUEUE_URL"],
        AttributeNames=["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    )["Attributes"]
    return attrs["ApproximateNumberOfMessages"] == "0" and attrs["ApproximateNumberOfMessagesNotVisible"] == "0"


def test_happy_path(aws):
    s3, sqs, table = aws
    mid = add_meeting(s3, sqs, table)
    w = Worker(FakeTranscriber())
    assert w.poll_once(wait=0) == 1

    item = table.get_item(Key={"id": mid})["Item"]
    assert item["status"] == "DONE"
    assert "revised proposal" in item["transcript"]
    assert item["transcript_lower"] == item["transcript"].lower()
    assert item["action_count"] == 2
    assert float(item["duration_s"]) == 17.0
    assert queue_empty(sqs)  # message deleted only after save


def test_duplicate_delivery_is_skipped(aws):
    s3, sqs, table = aws
    mid = add_meeting(s3, sqs, table, status="DONE")
    fake = FakeTranscriber()
    Worker(fake).poll_once(wait=0)
    assert fake.calls == 0
    assert queue_empty(sqs)


def test_deleted_meeting_is_dropped(aws):
    s3, sqs, table = aws
    sqs.send_message(QueueUrl=os.environ["QUEUE_URL"], MessageBody="ffffffffffff")
    fake = FakeTranscriber()
    Worker(fake).poll_once(wait=0)
    assert fake.calls == 0
    assert queue_empty(sqs)


def test_missing_audio_fails_permanently(aws):
    s3, sqs, table = aws
    mid = add_meeting(s3, sqs, table, upload=False)
    Worker(FakeTranscriber()).poll_once(wait=0)
    item = table.get_item(Key={"id": mid})["Item"]
    assert item["status"] == "FAILED"
    assert "missing" in item["error"]
    assert queue_empty(sqs)


def test_bad_audio_fails_permanently(aws):
    s3, sqs, table = aws
    mid = add_meeting(s3, sqs, table)
    Worker(FakeTranscriber(fail_with=PermanentError("Could not decode audio"))).poll_once(wait=0)
    assert table.get_item(Key={"id": mid})["Item"]["status"] == "FAILED"
    assert queue_empty(sqs)


def test_transient_error_is_retried_then_gives_up(aws):
    s3, sqs, table = aws
    mid = add_meeting(s3, sqs, table)
    w = Worker(FakeTranscriber(fail_with=RuntimeError("out of memory")))
    w.max_receives = 2
    w.poll_once(wait=0)
    item = table.get_item(Key={"id": mid})["Item"]
    assert item["status"] == "QUEUED" and item["error"].startswith("Retrying")
    assert not queue_empty(sqs)  # still on the queue, hidden for the backoff period

    # Make it visible again and fail the final attempt.
    msg_receipt = None
    sqs_q = os.environ["QUEUE_URL"]
    # moto honours ChangeMessageVisibility; reset it to 0 to skip the wait
    for m in sqs.receive_message(QueueUrl=sqs_q, VisibilityTimeout=0, WaitTimeSeconds=0).get("Messages", []):
        msg_receipt = m["ReceiptHandle"]
    if msg_receipt is None:  # message was still hidden: un-hide via a fresh send for the test
        sqs.send_message(QueueUrl=sqs_q, MessageBody=mid)
    w.max_receives = 1
    w.poll_once(wait=0)
    item = table.get_item(Key={"id": mid})["Item"]
    assert item["status"] == "FAILED"
    assert "Gave up" in item["error"]


def test_health_goes_stale():
    h = Health(stall_after=0.0)
    assert not h.alive()
    h = Health(stall_after=60)
    assert h.alive()


# ---- action items ------------------------------------------------------
def test_action_items_owner_and_due():
    items = extract_action_items(SEGMENTS)
    assert len(items) == 2
    first, second = items
    assert first["owner"] == "Sarah"
    assert first["due"].lower() == "by friday"
    assert first["start"] == 4.0
    assert "budget sheet" in second["text"]


def test_action_items_ignore_small_talk():
    segs = [
        {"start": 0, "end": 2, "text": "Can you hear me okay?"},
        {"start": 2, "end": 5, "text": "The weather was great this weekend."},
        {"start": 5, "end": 9, "text": "We need to finalize the hiring plan before next Monday."},
    ]
    items = extract_action_items(segs)
    assert [i["text"] for i in items] == ["We need to finalize the hiring plan before next Monday."]
    assert items[0]["due"].lower() == "before next monday"


def test_sentences_spanning_segments():
    segs = [
        {"start": 0, "end": 2, "text": "Let's make sure the"},
        {"start": 2, "end": 4, "text": "contract is signed by end of week."},
    ]
    items = extract_action_items(segs)
    assert items[0]["text"] == "Let's make sure the contract is signed by end of week."
    assert items[0]["start"] == 0

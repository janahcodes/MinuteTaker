"""API tests. DynamoDB, S3 and SQS are faked in-process with moto."""
import io
import os

import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

os.environ.update(
    AWS_ACCESS_KEY_ID="test",
    AWS_SECRET_ACCESS_KEY="test",
    AWS_REGION="us-east-1",
    AWS_DEFAULT_REGION="us-east-1",
    TABLE_NAME="meetings",
    BUCKET_NAME="audio",
)


@pytest.fixture
def env():
    with mock_aws():
        ddb = boto3.client("dynamodb", region_name="us-east-1")
        ddb.create_table(
            TableName="meetings",
            KeySchema=[{"AttributeName": "id", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "id", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        boto3.client("s3", region_name="us-east-1").create_bucket(Bucket="audio")
        sqs = boto3.client("sqs", region_name="us-east-1")
        os.environ["QUEUE_URL"] = sqs.create_queue(QueueName="jobs")["QueueUrl"]

        from app import main
        main.get_store.cache_clear()
        yield TestClient(main.app), sqs


def upload(client, name="standup.wav", data=b"RIFF....fake", ctype="audio/wav", title=""):
    return client.post(
        "/api/meetings",
        data={"title": title},
        files={"file": (name, io.BytesIO(data), ctype)},
    )


def test_health_and_ready(env):
    client, _ = env
    assert client.get("/healthz").status_code == 200
    r = client.get("/readyz")
    assert r.status_code == 200
    assert "X-Served-By" in r.headers


def test_upload_queues_job(env):
    client, sqs = env
    r = upload(client, title="Weekly sync")
    assert r.status_code == 201
    body = r.json()
    assert body["status"] == "QUEUED"
    assert body["title"] == "Weekly sync"

    msgs = sqs.receive_message(QueueUrl=os.environ["QUEUE_URL"])["Messages"]
    assert msgs[0]["Body"] == body["id"]

    listed = client.get("/api/meetings").json()["meetings"]
    assert [m["id"] for m in listed] == [body["id"]]


def test_default_title_from_filename(env):
    client, _ = env
    assert upload(client, name="client_kickoff-call.m4a", ctype="audio/x-m4a").json()["title"] == "client kickoff call"


def test_rejects_non_audio(env):
    client, _ = env
    assert upload(client, name="x.pdf", ctype="application/pdf").status_code == 415


def test_rejects_empty(env):
    client, _ = env
    assert upload(client, data=b"").status_code == 400


def test_get_unknown_and_malformed_ids(env):
    client, _ = env
    assert client.get("/api/meetings/000000000000").status_code == 404
    assert client.get("/api/meetings/../etc").status_code == 404


def test_retry_only_for_failed_or_uploaded(env):
    client, _ = env
    mid = upload(client).json()["id"]
    assert client.post(f"/api/meetings/{mid}/retry").status_code == 409

    from app import main
    main.get_store().set_status(mid, "FAILED")
    r = client.post(f"/api/meetings/{mid}/retry")
    assert r.status_code == 200 and r.json()["status"] == "QUEUED"


def test_search_finds_transcript_text(env):
    client, _ = env
    mid = upload(client, title="Budget review").json()["id"]
    from app import main
    main.get_store().table.update_item(
        Key={"id": mid},
        UpdateExpression="SET transcript = :t, transcript_lower = :l, #s = :s",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":t": "We agreed the Q3 budget is final.", ":l": "we agreed the q3 budget is final.", ":s": "DONE"},
    )
    res = client.get("/api/search", params={"q": "q3 budget"}).json()["results"]
    assert res[0]["id"] == mid
    assert "Q3 budget" in res[0]["snippet"]
    # title search
    assert client.get("/api/search", params={"q": "review"}).json()["results"][0]["id"] == mid


def test_delete_removes_item_and_audio(env):
    client, _ = env
    mid = upload(client).json()["id"]
    assert client.delete(f"/api/meetings/{mid}").status_code == 204
    assert client.get(f"/api/meetings/{mid}").status_code == 404
    assert boto3.client("s3", region_name="us-east-1").list_objects_v2(Bucket="audio").get("KeyCount") == 0


def test_dependency_outage_returns_503(env):
    client, _ = env
    boto3.client("dynamodb", region_name="us-east-1").delete_table(TableName="meetings")
    assert client.get("/readyz").status_code == 503
    assert client.get("/api/meetings").status_code == 503
    # liveness must stay green so Kubernetes doesn't restart-loop us over a downstream outage
    assert client.get("/healthz").status_code == 200


def test_stats_reports_queue_depth(env):
    client, _ = env
    upload(client)
    upload(client)
    assert client.get("/api/stats").json()["queue"]["waiting"] == 2

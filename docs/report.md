# MinuteTaker: Project 2 Report
### Containerized Multi-Service Application (AI 255, Cloud Computing Concepts)

## 1. What the system does

MinuteTaker turns meeting recordings into searchable minutes. A user uploads a
recording (or records one in the browser) and a few seconds later gets a
timestamped transcript and a list of **action items** with the owner and due
date when one was said ("Sarah, can you send the proposal *by Friday*?").
Every transcript is full-text searchable.

The target users are small teams that record calls but never write minutes,
such as agencies, clinics and consultancies. The transcription runs on our own
containers instead of a paid speech API, so recordings never leave the
deployment. For those clients that is a privacy selling point.

## 2. Architecture

```
            browser
               │  HTTP :80 (LoadBalancer / NodePort)
       ┌───────▼────────┐
       │  web  (nginx)  │  ×2–4   static UI, reverse proxy for /api
       └───────┬────────┘
               │  ClusterIP Service "api"
       ┌───────▼────────┐      put/get/scan       ┌────────────────────┐
       │  api (FastAPI) │  ×2–6 ────────────────▶ │ DynamoDB  meetings │
       └──┬──────────┬──┘                          └────────▲───────────┘
   upload │          │ SendMessage(meeting id)               │ update result
          ▼          ▼                                       │
   ┌──────────┐  ┌─────────────────┐  ReceiveMessage  ┌──────┴──────────────┐
   │ S3 audio │  │ SQS jobs (+DLQ) │ ───────────────▶ │ worker (Whisper)    │ ×1–5
   └────▲─────┘  └─────────────────┘                  └──────┬──────────────┘
        └──────────────── GetObject ─────────────────────────┘
```

| Component | Kind | Image / service | Role |
|---|---|---|---|
| **web** | stateless service | `minutetaker-web` (nginx-unprivileged 1.27) | Serves the single-page UI, proxies `/api/*` to the API, health endpoint `/healthz` |
| **api** | stateless service | `minutetaker-api` (Python 3.12, FastAPI) | Validates uploads, writes audio to S3 and a record to DynamoDB, queues a job on SQS; read/search/delete endpoints |
| **worker** | stateless consumer | `minutetaker-worker` (Python 3.12, faster-whisper `tiny.en`, int8) | Long-polls SQS, transcribes, extracts action items, writes results back |
| DynamoDB | managed NoSQL | table `minutetaker-meetings` | System of record for meetings and transcripts |
| S3 | managed object store | bucket `minutetaker-audio` | Raw recordings |
| SQS | managed queue | `minutetaker-jobs` + `minutetaker-jobs-dlq` | Decouples upload from transcription; buffers bursts |

### Why three services and a queue
Transcribing takes seconds to minutes of full CPU, while serving the UI and API
takes milliseconds. If they ran in one process, a burst of uploads would starve
the web requests. Splitting them lets each tier **scale on its own signal**.
The queue also means an upload succeeds even when every worker is busy or down;
the work simply waits.

### Meeting lifecycle (state machine in DynamoDB)
`UPLOADING → UPLOADED → QUEUED → PROCESSING → DONE`, with `FAILED` reachable
from `PROCESSING`. `POST /api/meetings/{id}/retry` moves `UPLOADED|FAILED`
back to `QUEUED`. Each step is written *before* the next side effect, so a
crash at any point leaves a visible, recoverable state rather than a silent gap.

## 3. Containerization

* **Small, layered images.** Dependencies are installed before the code is copied,
  so editing code only rebuilds the last layer. `.dockerignore` keeps tests and
  virtualenvs out.
* **Non-root.** API and worker run as uid 10001. The web tier uses
  `nginx-unprivileged` (uid 101, port 8080). In Kubernetes all containers drop
  every Linux capability, disallow privilege escalation and use the
  `RuntimeDefault` seccomp profile. API and worker also have a read-only root
  filesystem with an `emptyDir` at `/tmp`.
* **Model baked into the image.** The Whisper weights (~75 MB) are downloaded at
  build time and `HF_HUB_OFFLINE=1` is set at runtime. A new worker pod
  therefore starts without depending on Hugging Face, and every replica runs
  identical weights.
* **Docker `HEALTHCHECK`s** mirror the Kubernetes probes so `docker compose ps`
  shows health too.
* **Same image everywhere.** Configuration comes only from environment variables
  (`TABLE_NAME`, `BUCKET_NAME`, `QUEUE_URL`, optional `AWS_ENDPOINT_URL`). The
  identical image talks to the local emulator or to real AWS.

## 4. Orchestration: health checks and horizontal scaling

All of this is in `k8s/base`, with environment differences in overlays
(`k8s/overlays/local`).

### Probes

| Service | startup | liveness | readiness |
|---|---|---|---|
| web | none | `GET /healthz` (nginx returns 200, no upstream) | same |
| api | `/healthz` up to 60 s | `/healthz`: process answers; **no dependency check** | `/readyz`: `DescribeTable` on DynamoDB must succeed |
| worker | `/healthz` up to 120 s (model load) | `/healthz`: the poll loop has ticked in the last `STALL_AFTER_S` (300 s) | `/readyz`: model loaded **and** loop alive |

The split between liveness and readiness is deliberate. If DynamoDB has an
outage, every API pod fails *readiness*. It is taken out of the Service so it
stops receiving traffic, but it is **not restarted**. Restarting cannot fix
a downstream outage and would only add a restart storm on top of it. The
worker's liveness probe catches the failure a process check would miss: a
worker that is running but stuck (for example a hung decode) stops sending
heartbeats and gets restarted.

### Horizontal scaling

| Deployment | min | max | metric | notes |
|---|---|---|---|---|
| web | 2 | 4 | CPU 70 % | 2 minimum for availability |
| api | 2 | 6 | CPU 60 % | rolling updates with `maxUnavailable: 0` |
| worker | 1 | 5 | CPU 60 % of 500 m request | scale up 2 pods / 30 s; scale down 1 pod / 60 s after a 180 s stabilization window |

The worker scales on CPU because transcription is CPU-bound. An idle worker
long-polling SQS uses close to 0 % CPU, while a busy one uses about 200 % of its
request. CPU is therefore a good proxy for "is there a backlog". The ideal
signal is queue depth (see §7). The slow scale-down avoids killing workers
in the short gaps between jobs.

Other availability settings: `topologySpreadConstraints` spread replicas across
nodes; `PodDisruptionBudget`s keep at least one web and one api pod through
voluntary disruptions such as node drains and upgrades.

## 5. Failure-mode analysis

For each component: what can fail, how the failure shows up, what limits the
damage, and what the user sees. "Tested" marks failures that were injected on
the running system (§6).

### 5.1 web (nginx)

| Failure | Detection | Mitigation | User impact |
|---|---|---|---|
| A web pod crashes or its node dies | liveness probe / node NotReady | Service stops routing to it; ReplicaSet replaces it; a 2nd replica on another node keeps serving | None, or one failed request at most |
| nginx can't resolve `api` at start (Service missing) | container exits → CrashLoopBackOff | Manifests are applied together; the pod restarts until DNS resolves | UI unavailable until resolved |
| An API pod refuses or resets a connection | nginx upstream error | `proxy_next_upstream error timeout http_502 http_503` retries once on another pod | Transparent |
| Every API pod is unready | nginx gets 503 / 502 | UI shows "Couldn't load meetings" and keeps polling | Read-only failure; recovers by itself |
| Oversized upload | `client_max_body_size 50m` | Rejected at the edge before it reaches the API | Clear 413 error |

The web tier holds no state, so every failure is fixed by replacement.

### 5.2 api (FastAPI)

| Failure | Detection | Mitigation | User impact |
|---|---|---|---|
| Pod crash / OOM (e.g. many concurrent large uploads) | liveness, container exit code | Restart; other replicas serve; uploads spool to `/tmp` (on disk, not in memory), memory limit 320 Mi | In-flight upload on that pod fails; the user retries |
| DynamoDB unavailable or throttling | boto timeouts (connect 2 s, read 5 s, 3 attempts) → **503**; readiness fails | Pods leave the Service but are **not** restarted; boto retries with backoff | "A backing service is unavailable" (tested) |
| S3 upload fails after the meeting record was written | exception → 503 | Record stays `UPLOADING`, visible in the list | User sees a stuck "Uploading" entry and can delete it (known gap, see §7) |
| SQS `SendMessage` fails after the audio is stored | exception → 503 | Record stays `UPLOADED`; the UI offers **"Queue it"** → `/retry` | One click to recover; no audio lost |
| CPU saturation under traffic | HPA | Scale out to 6 | Higher latency during the scale-out |
| Bad input (wrong type, empty, path tricks, malformed IDs) | validation | 415 / 400 / 404; filenames sanitized; IDs must match `[0-9a-f]{12}` | Clear error |

The write order (DynamoDB → S3 → DynamoDB → SQS → DynamoDB) is the important
design choice. The system **never** has audio in S3 without a record pointing
to it, and never queues a job whose audio isn't stored yet.

### 5.3 worker (transcription)

The worker has the most failure modes, because it does long-running work
that has side effects.

| Failure | Detection | Mitigation | User impact |
|---|---|---|---|
| Pod killed mid-job (crash, OOM, node loss, eviction) | message never deleted | The visibility heartbeat stops, so the message reappears after ≤ 120 s and another worker picks it up | Job finishes a couple of minutes late (tested) |
| Scale-in or rolling update while busy | SIGTERM | Stops taking new jobs and finishes the current one within `terminationGracePeriodSeconds: 90`; if it runs longer, as above | None |
| The same message delivered twice (SQS standard queues are at-least-once) | conditional `UpdateItem` on `status <> DONE` | Duplicate is acknowledged and dropped; a result is written once | None (unit-tested) |
| Meeting deleted while queued | conditional check fails (`id` missing) | Message dropped | None |
| Corrupt / undecodable audio, or longer than 45 min | `PermanentError` | Marked `FAILED` with a reason **immediately**; no retries wasted | Clear error message with a retry button |
| Audio object missing in S3 | `NoSuchKey` → `PermanentError` | `FAILED: Audio file is missing` | Clear error |
| Transient error (S3/DynamoDB blip, unexpected exception) | exception | Status back to `QUEUED` with the reason; message hidden for 30 s, 60 s, 120 s… (exponential backoff); after `MAX_RECEIVES` (3) attempts → `FAILED` | Delayed, then either succeeds or fails clearly |
| Poison message that crashes the process before it can record a failure | receive count grows | Queue redrive policy moves it to the **DLQ** after 5 receives, so it can't block the queue forever | That meeting stays `PROCESSING`; an operator inspects the DLQ |
| Worker hangs (stuck decode, deadlock) | heartbeat older than 300 s → liveness fails | kubelet restarts the container; message redelivered | Delay |
| Transcript too big for one DynamoDB item (400 KB) | size check before write | Drop per-segment timestamps first, then truncate the text | Very long meetings lose timestamps |
| Backlog (many uploads at once) | CPU → HPA | Scale out to 5 workers; SQS holds the rest durably | Longer waits, nothing lost (tested) |
| A job never finishes because it is longer than the visibility timeout | n/a | Heartbeat extends visibility every 60 s while the job runs | None |

### 5.4 Managed datastore and queue

| Failure | Effect | Mitigation |
|---|---|---|
| DynamoDB regional outage / throttling | API reads and writes return 503; workers back off and retry | Pay-per-request mode (no capacity to exhaust at our scale); point-in-time recovery enabled on AWS |
| S3 unavailable | Uploads fail with 503; workers retry with backoff | S3's 11-nines durability: once stored, audio isn't lost |
| SQS unavailable | New uploads stay `UPLOADED` (recoverable with `/retry`); workers log and back off for 5 s | Messages already queued are kept durably |
| Local only: moto pod restarts | Emulator data is in memory and is lost | Local development only; the real services are durable |

### 5.5 Platform-level failures

| Failure | Effect | Mitigation |
|---|---|---|
| A node dies | Its pods are rescheduled after the node is marked NotReady (~40 s + eviction) | Replicas spread across nodes; web and api keep ≥ 1 replica elsewhere; worker jobs are redelivered |
| Bad deploy (new image crashes) | New pods never become Ready | `maxUnavailable: 0` means old pods keep serving; `kubectl rollout undo` |
| metrics-server down | HPAs can't read metrics and **freeze at the current replica count** | Minimum replicas still keep the system available, just not elastic |
| Cluster out of capacity | New pods stay `Pending` | Requests are sized so max replicas fit the cluster; node autoscaling is future work (§7) |

## 6. Results

*Filled in from the local run; see §6.1 to reproduce.*

### 6.1 How to reproduce
```bash
scripts/local-up.sh                 # build, create 3-node kind cluster, deploy
scripts/loadtest.sh 20              # 20 uploads → backlog
kubectl -n minutetaker get hpa,pods -w
```

## 7. Limitations and what I would change

* **Scale workers on queue depth, not CPU.** CPU is a lagging proxy. KEDA's SQS
  scaler would scale on `ApproximateNumberOfMessages` and could scale to zero
  when idle. I left it out to keep the stack to core Kubernetes.
* **Search uses a DynamoDB `Scan`.** It is fine for hundreds of meetings but
  O(n) in cost and latency. A GSI on `created_at` for listing, plus
  OpenSearch for full-text search, is the production design.
* **Uploads pass through the API.** This is simple and works the same locally
  and on AWS, but it ties up API pods for large files. Presigned S3 PUT URLs
  would let browsers upload directly to S3.
* **No authentication.** Every visitor sees every meeting. This is the first
  feature a real client would need (Cognito, plus a `owner_id` on each
  item).
* **Stuck `UPLOADING` records** when the S3 write fails. A small reaper could
  mark records older than 10 minutes as `FAILED`.
* **Action-item extraction is rule-based.** It is predictable and free, but it
  misses indirect phrasing. An LLM pass would be more accurate at a per-call cost.
* **Node autoscaling** (Cluster Autoscaler / Karpenter) so the HPA's extra pods
  always have room.

## 8. Use of AI tools (disclosure required by the course policy)

*To be completed by the student:* describe which parts were AI-assisted and
confirm you can explain every file.

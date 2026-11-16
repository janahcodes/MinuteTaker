# MinuteTaker: Cloud Computing Project 2

Upload a meeting recording, or record one in the browser, and get back a
timestamped transcript plus the **action items** with their owners and due
dates. Every transcript is searchable.

Three containerized services run under Kubernetes with health checks and
horizontal autoscaling. They are backed by managed AWS data services:
DynamoDB holds meetings, S3 holds the audio and SQS queues the jobs.

| Service | What it does | Scales on |
|---|---|---|
| `web` | nginx: UI + reverse proxy | CPU, 2–4 pods |
| `api` | FastAPI: uploads, listing, search | CPU, 2–6 pods |
| `worker` | Whisper speech-to-text + action-item extraction, fed by SQS | CPU, 1–5 pods |

**Images (GHCR):** `ghcr.io/janahcodes/minutetaker-api:v1` · `ghcr.io/janahcodes/minutetaker-worker:v1` · `ghcr.io/janahcodes/minutetaker-web:v1`

**Report, including the failure-mode analysis:** [docs/report.md](docs/report.md)

## Layout
```
services/api      FastAPI service + tests (AWS mocked with moto)
services/worker   SQS consumer, Whisper transcription, action items + tests
services/web      nginx config + single-page UI
k8s/base          Deployments, Services, probes, HPAs, PDBs
k8s/overlays/     local = kind cluster + moto emulating DynamoDB/S3/SQS
infra/            Terraform: DynamoDB, S3, SQS (+DLQ), ECR, least-privilege IAM
scripts/          local-up / local-down / loadtest / make-sample
docs/report.md    design, health checks, scaling, failure modes, results
```

## Run the tests
```bash
python3 -m venv .venv
.venv/bin/pip install -r services/api/requirements-dev.txt moto pytest
make test
```

## Run it on a local Kubernetes cluster
Needs Docker Desktop, `kind` and `kubectl`.
```bash
scripts/local-up.sh        # build images, 3-node kind cluster, metrics-server, deploy
open http://localhost:8080
scripts/loadtest.sh 20     # pile up jobs, then:
kubectl -n minutetaker get hpa,pods -w
scripts/local-down.sh
```

## Run it without Kubernetes
```bash
docker compose up --build   # http://localhost:8080
```

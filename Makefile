.PHONY: test up down load compose
test:      ## run both test suites
	cd services/api && ../../.venv/bin/pytest -q
	cd services/worker && ../../.venv/bin/pytest -q
up:        ## build + deploy to a local 3-node kind cluster
	scripts/local-up.sh
down:
	scripts/local-down.sh
load:      ## 20 uploads to trigger worker autoscaling
	scripts/loadtest.sh 20
compose:   ## run without Kubernetes
	docker compose up --build

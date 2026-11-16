#!/usr/bin/env bash
# Build the images, create a 3-node kind cluster, install metrics-server
# (needed by the HorizontalPodAutoscalers) and deploy MinuteTaker.
# Afterwards: http://localhost:8080
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER=minutetaker
METRICS_SERVER_VERSION=v0.7.2

docker compose build api worker web || true   # images may already be built

if ! kind get clusters | grep -qx "$CLUSTER"; then
  kind create cluster --config k8s/overlays/local/kind-cluster.yaml
fi
kubectl config use-context "kind-$CLUSTER" >/dev/null

# kind nodes can't pull images from the host's Docker, so load them in.
for svc in api worker web; do kind load docker-image "minutetaker-$svc:dev" --name "$CLUSTER"; done

if ! kubectl -n kube-system get deploy metrics-server >/dev/null 2>&1; then
  kubectl apply -f "https://github.com/kubernetes-sigs/metrics-server/releases/download/${METRICS_SERVER_VERSION}/components.yaml"
  # kind's kubelets use self-signed certs.
  kubectl -n kube-system patch deploy metrics-server --type=json \
    -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
fi

kubectl apply -k k8s/overlays/local
kubectl -n minutetaker wait --for=condition=complete job/init-local-aws --timeout=180s
# Pick up freshly loaded images with the same :dev tag.
kubectl -n minutetaker rollout restart deploy/api deploy/worker deploy/web
kubectl -n minutetaker rollout status deploy/api --timeout=180s
kubectl -n minutetaker rollout status deploy/web --timeout=180s
kubectl -n minutetaker rollout status deploy/worker --timeout=300s
kubectl -n minutetaker get pods -o wide
echo
echo "MinuteTaker is up: http://localhost:8080"

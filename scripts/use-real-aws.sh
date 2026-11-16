#!/usr/bin/env bash
# Switch the local cluster from the moto emulator to the real AWS resources
# created by `terraform -chdir=infra apply`. Re-run after any terraform change.
set -euo pipefail
cd "$(dirname "$0")/.."
OV=k8s/overlays/aws
out() { terraform -chdir=infra output -raw "$1"; }

cat > "$OV/aws-config.yaml" <<YAML
apiVersion: v1
kind: ConfigMap
metadata:
  name: minutetaker-config
data:
  AWS_REGION: $(out region)
  TABLE_NAME: $(out table_name)
  BUCKET_NAME: $(out bucket_name)
  QUEUE_URL: $(out queue_url)
YAML
umask 077
printf 'AWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s\n' "$(out app_access_key_id)" "$(out app_secret_access_key)" > "$OV/creds.env"

# Remove the emulator and its settings, then deploy against real AWS.
kubectl -n minutetaker delete deploy/moto svc/moto job/init-local-aws --ignore-not-found
kubectl -n minutetaker delete configmap minutetaker-config --ignore-not-found
kubectl apply -k "$OV"
kubectl -n minutetaker rollout restart deploy/api deploy/worker
kubectl -n minutetaker rollout status deploy/api --timeout=180s
kubectl -n minutetaker rollout status deploy/worker --timeout=300s
echo "Now using DynamoDB table $(out table_name), bucket $(out bucket_name) in $(out region)."

#!/bin/sh
# Creates the table, bucket and queues inside the local AWS emulator (moto).
# Used by docker-compose and by the k8s "local" overlay. On EKS these
# resources are real managed services created by Terraform instead.
set -eu
EP="${AWS_ENDPOINT_URL:?}"
aws() { command aws --endpoint-url "$EP" "$@"; }

until aws sts get-caller-identity >/dev/null 2>&1; do echo "waiting for emulator at $EP"; sleep 1; done

aws dynamodb describe-table --table-name "$TABLE_NAME" >/dev/null 2>&1 || \
  aws dynamodb create-table --table-name "$TABLE_NAME" \
    --attribute-definitions AttributeName=id,AttributeType=S \
    --key-schema AttributeName=id,KeyType=HASH --billing-mode PAY_PER_REQUEST >/dev/null

aws s3api head-bucket --bucket "$BUCKET_NAME" 2>/dev/null || aws s3api create-bucket --bucket "$BUCKET_NAME" >/dev/null

DLQ_URL=$(aws sqs create-queue --queue-name minutetaker-jobs-dlq --query QueueUrl --output text)
DLQ_ARN=$(aws sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)
cat > /tmp/attrs.json <<JSON
{"VisibilityTimeout":"120","ReceiveMessageWaitTimeSeconds":"20",
 "RedrivePolicy":"{\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":\"5\"}"}
JSON
aws sqs create-queue --queue-name minutetaker-jobs --attributes file:///tmp/attrs.json >/dev/null
echo "local AWS resources ready"

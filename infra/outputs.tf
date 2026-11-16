output "region" { value = var.region }
output "table_name" { value = aws_dynamodb_table.meetings.name }
output "bucket_name" { value = aws_s3_bucket.audio.bucket }
output "queue_url" { value = aws_sqs_queue.jobs.url }
output "dlq_url" { value = aws_sqs_queue.dlq.url }
output "ecr" { value = { for k, r in aws_ecr_repository.svc : k => r.repository_url } }
output "app_access_key_id" { value = aws_iam_access_key.app.id }
output "app_secret_access_key" {
  value     = aws_iam_access_key.app.secret
  sensitive = true
}

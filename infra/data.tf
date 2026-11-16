# Managed datastore: one item per meeting. On-demand billing = no capacity
# planning and ~$0 at class scale. PITR allows restoring to any second in 35 days.
resource "aws_dynamodb_table" "meetings" {
  name         = "${var.name}-meetings"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }

  point_in_time_recovery { enabled = true }
  server_side_encryption { enabled = true }
}

resource "aws_s3_bucket" "audio" {
  bucket        = "${var.name}-audio-${local.suffix}"
  force_destroy = true # Project 3 needs a clean teardown
}

resource "aws_s3_bucket_public_access_block" "audio" {
  bucket                  = aws_s3_bucket.audio.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audio" {
  bucket = aws_s3_bucket.audio.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "audio" {
  bucket = aws_s3_bucket.audio.id
  rule {
    id     = "expire-recordings"
    status = "Enabled"
    filter { prefix = "uploads/" }
    expiration { days = 30 }
  }
}

resource "aws_sqs_queue" "dlq" {
  name                      = "${var.name}-jobs-dlq"
  message_retention_seconds = 1209600 # 14 days to inspect poison messages
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "jobs" {
  name                       = "${var.name}-jobs"
  visibility_timeout_seconds = 120 # worker heartbeat extends this while busy
  receive_wait_time_seconds  = 20  # long polling
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = 5
  })
}

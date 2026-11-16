# Least-privilege identity for the pods. Only the actions each code path uses,
# only on these three resources. (On EKS this policy would hang off a pod role
# via EKS Pod Identity instead of an access key.)
data "aws_iam_policy_document" "app" {
  statement {
    sid = "Meetings"
    actions = [
      "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
      "dynamodb:DeleteItem", "dynamodb:Scan", "dynamodb:DescribeTable",
    ]
    resources = [aws_dynamodb_table.meetings.arn]
  }
  statement {
    sid       = "Audio"
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.audio.arn}/uploads/*"]
  }
  statement {
    sid = "Jobs"
    actions = [
      "sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes",
    ]
    resources = [aws_sqs_queue.jobs.arn]
  }
}

resource "aws_iam_user" "app" {
  name = "${var.name}-app"
}

resource "aws_iam_user_policy" "app" {
  name   = "${var.name}-app"
  user   = aws_iam_user.app.name
  policy = data.aws_iam_policy_document.app.json
}

resource "aws_iam_access_key" "app" {
  user = aws_iam_user.app.name
}

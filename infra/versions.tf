terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.80" }
  }
}

provider "aws" {
  region = var.region
  default_tags { tags = { Project = "minutetaker", Course = "AI255-project2" } }
}

variable "region" {
  type    = string
  default = "us-east-2" # the project is region-locked to Ohio
}

variable "name" {
  type    = string
  default = "minutetaker"
}

data "aws_caller_identity" "me" {}

locals {
  suffix = substr(data.aws_caller_identity.me.account_id, -6, 6) # S3 names are global
}

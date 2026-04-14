resource "random_id" "bucket_suffix" {
  byte_length = 3
}

locals {
  enabled_effective = var.enabled && var.root_domain_name != null && var.route53_zone_id != null
  name_prefix       = "${var.project}-${var.environment}"
  bucket_name       = "${local.name_prefix}-static-${random_id.bucket_suffix.hex}"
  auth_paths        = toset([for path in var.auth_no_cache_paths : trimspace(path)])
}

data "aws_cloudfront_cache_policy" "optimized" {
  count = local.enabled_effective ? 1 : 0
  name  = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "disabled" {
  count = local.enabled_effective ? 1 : 0
  name  = "Managed-CachingDisabled"
}

resource "aws_s3_bucket" "site" {
  count         = local.enabled_effective ? 1 : 0
  bucket        = local.bucket_name
  force_destroy = true

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-static-site"
  })
}

resource "aws_s3_bucket_public_access_block" "site" {
  count  = local.enabled_effective ? 1 : 0
  bucket = aws_s3_bucket.site[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "site" {
  count  = local.enabled_effective ? 1 : 0
  bucket = aws_s3_bucket.site[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_cloudfront_origin_access_control" "site" {
  count                             = local.enabled_effective ? 1 : 0
  name                              = "${local.name_prefix}-static-oac"
  description                       = "OAC for ${var.root_domain_name} static frontend"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_acm_certificate" "apex" {
  count             = local.enabled_effective ? 1 : 0
  domain_name       = var.root_domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-apex-static-cert"
  })
}

resource "aws_route53_record" "cert_validation" {
  for_each = local.enabled_effective ? {
    for dvo in aws_acm_certificate.apex[0].domain_validation_options : dvo.domain_name => {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  } : {}

  allow_overwrite = true
  zone_id         = var.route53_zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.value]
  ttl             = 60
}

resource "aws_acm_certificate_validation" "apex" {
  count                   = local.enabled_effective ? 1 : 0
  certificate_arn         = aws_acm_certificate.apex[0].arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}

resource "aws_cloudfront_distribution" "site" {
  count               = local.enabled_effective ? 1 : 0
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "${var.root_domain_name} static/auth distribution"
  aliases             = [var.root_domain_name]
  default_root_object = "index.html"

  origin {
    domain_name              = aws_s3_bucket.site[0].bucket_regional_domain_name
    origin_id                = "static-s3-origin"
    origin_access_control_id = aws_cloudfront_origin_access_control.site[0].id
  }

  default_cache_behavior {
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "static-s3-origin"

    viewer_protocol_policy = "redirect-to-https"
    compress               = true
    cache_policy_id        = data.aws_cloudfront_cache_policy.optimized[0].id
  }

  dynamic "ordered_cache_behavior" {
    for_each = local.auth_paths

    content {
      path_pattern           = ordered_cache_behavior.value
      allowed_methods        = ["GET", "HEAD", "OPTIONS"]
      cached_methods         = ["GET", "HEAD"]
      target_origin_id       = "static-s3-origin"
      viewer_protocol_policy = "redirect-to-https"
      compress               = true
      cache_policy_id        = data.aws_cloudfront_cache_policy.disabled[0].id
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.apex[0].certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }

  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-static-edge"
  })
}

resource "aws_s3_bucket_policy" "site" {
  count  = local.enabled_effective ? 1 : 0
  bucket = aws_s3_bucket.site[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCloudFrontServicePrincipalReadOnly"
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.site[0].arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.site[0].arn
          }
        }
      }
    ]
  })
}

resource "aws_route53_record" "apex_alias" {
  count           = local.enabled_effective ? 1 : 0
  allow_overwrite = true
  zone_id         = var.route53_zone_id
  name            = var.root_domain_name
  type            = "A"

  alias {
    name                   = aws_cloudfront_distribution.site[0].domain_name
    zone_id                = aws_cloudfront_distribution.site[0].hosted_zone_id
    evaluate_target_health = false
  }
}

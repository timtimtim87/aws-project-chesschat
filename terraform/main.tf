# Root configuration that stitches together the reusable modules.
moved {
  from = module.ecs
  to   = module.ecs_identity
}

# ---------------------------------------------------------------------------
# Google OAuth credentials — pulled from Secrets Manager so they never appear
# in tfvars or state in plaintext beyond what Terraform already marks sensitive.
# Secret path: chesschat/dev/google/oauth  (keys: client_id, client_secret)
# ---------------------------------------------------------------------------
data "aws_secretsmanager_secret" "google_oauth" {
  count = var.cognito_enable_google_identity_provider ? 1 : 0
  name  = "${var.project}/${var.environment}/google/oauth"
}

data "aws_secretsmanager_secret_version" "google_oauth" {
  count     = var.cognito_enable_google_identity_provider ? 1 : 0
  secret_id = data.aws_secretsmanager_secret.google_oauth[0].id
}

locals {
  common_tags = merge({
    Project     = var.project
    Environment = var.environment
  }, var.tags)

  apex_domain_name = var.root_domain_name
  app_domain_name  = var.root_domain_name == null ? null : "${var.app_subdomain}.${var.root_domain_name}"
  cognito_callback_urls_effective = var.use_app_domain_for_cognito_urls && local.apex_domain_name != null ? [
    "https://${local.apex_domain_name}/auth/callback"
  ] : var.cognito_callback_urls
  cognito_logout_urls_effective = var.use_app_domain_for_cognito_urls && local.apex_domain_name != null ? [
    "https://${local.apex_domain_name}/"
  ] : var.cognito_logout_urls
  ecs_container_secrets_effective = concat(
    var.ecs_container_secrets,
    [{
      name      = "REDIS_AUTH_TOKEN"
      valueFrom = "${module.elasticache.redis_auth_secret_arn}:auth_token::"
    }]
  )

  # Google OAuth values resolved from Secrets Manager when IdP is enabled;
  # fall back to null (module ignores them when enable flag is false).
  google_oauth_secret_string = (
    var.cognito_enable_google_identity_provider
    ? data.aws_secretsmanager_secret_version.google_oauth[0].secret_string
    : null
  )
  google_client_id_effective = (
    local.google_oauth_secret_string != null
    ? jsondecode(local.google_oauth_secret_string)["client_id"]
    : var.cognito_google_client_id
  )
  google_client_secret_effective = (
    local.google_oauth_secret_string != null
    ? jsondecode(local.google_oauth_secret_string)["client_secret"]
    : var.cognito_google_client_secret
  )
}

module "vpc" {
  source               = "./modules/vpc"
  project              = var.project
  environment          = var.environment
  vpc_cidr             = var.vpc_cidr
  az_count             = var.az_count
  nat_gateway_mode     = var.nat_gateway_mode
  enable_vpc_endpoints = var.enable_vpc_endpoints
  enable_flow_logs     = var.enable_flow_logs
  tags                 = local.common_tags
}

module "ecs_identity" {
  source      = "./modules/ecs"
  project     = var.project
  environment = var.environment
  dynamodb_table_arns = [
    module.dynamodb.users_table_arn,
    module.dynamodb.games_table_arn,
    module.dynamodb.pair_rooms_table_arn,
    module.dynamodb.friendships_table_arn,
    module.dynamodb.friend_requests_table_arn,
    module.dynamodb.challenges_table_arn,
    module.dynamodb.notifications_table_arn
  ]
  ecr_repository_arns   = var.ecr_repository_arns
  cognito_user_pool_arn = module.cognito.user_pool_arn
  tags                  = local.common_tags
}

module "alb" {
  source                                   = "./modules/alb"
  project                                  = var.project
  environment                              = var.environment
  enabled                                  = var.enable_edge
  vpc_id                                   = module.vpc.vpc_id
  public_subnet_ids                        = module.vpc.public_subnet_ids
  target_port                              = var.ecs_container_port
  certificate_domains                      = local.app_domain_name == null ? [] : [local.app_domain_name]
  canonical_host                           = local.app_domain_name
  redirect_hosts                           = []
  route53_zone_id                          = var.route53_zone_id
  health_check_path                        = var.alb_health_check_path
  enable_target_group_stickiness           = true
  target_group_stickiness_duration_seconds = 86400
  tags                                     = local.common_tags
}

module "static_edge" {
  source              = "./modules/static_edge"
  project             = var.project
  environment         = var.environment
  enabled             = var.enable_static_edge
  root_domain_name    = local.apex_domain_name
  route53_zone_id     = var.route53_zone_id
  auth_no_cache_paths = var.static_auth_no_cache_paths
  tags                = local.common_tags
}

module "ecs_compute" {
  source                 = "./modules/ecs_compute"
  project                = var.project
  environment            = var.environment
  enabled                = var.enable_ecs_compute
  vpc_id                 = module.vpc.vpc_id
  private_subnet_ids     = module.vpc.private_app_subnet_ids
  execution_role_arn     = module.ecs_identity.task_execution_role_arn
  task_role_arn          = module.ecs_identity.task_role_arn
  ecr_repository_name    = var.ecr_repository_name
  image_tag              = var.ecs_image_tag
  container_name         = var.ecs_container_name
  container_port         = var.ecs_container_port
  container_environment  = var.ecs_container_environment
  container_secrets      = local.ecs_container_secrets_effective
  task_cpu               = var.ecs_task_cpu
  task_memory            = var.ecs_task_memory
  desired_count          = var.ecs_service_desired_count
  enable_alb_integration = var.enable_edge
  alb_target_group_arn   = module.alb.target_group_arn
  alb_security_group_id  = module.alb.alb_security_group_id
  log_retention_days     = var.ecs_log_retention_days
  tags                   = local.common_tags
}

module "github_actions_oidc" {
  source                            = "./modules/github_actions_oidc"
  enabled                           = var.enable_github_actions_oidc && var.enable_ecs_compute
  project                           = var.project
  environment                       = var.environment
  github_repository                 = var.github_actions_repository
  github_branch                     = var.github_actions_branch
  oidc_thumbprints                  = var.github_actions_oidc_thumbprints
  ecr_repository_arn                = module.ecs_compute.ecr_repository_arn
  ecs_cluster_name                  = module.ecs_compute.cluster_name
  ecs_service_name                  = module.ecs_compute.service_name
  task_execution_role_arn           = module.ecs_identity.task_execution_role_arn
  task_role_arn                     = module.ecs_identity.task_role_arn
  cognito_user_pool_arn             = module.cognito.user_pool_arn
  static_site_bucket_name           = module.static_edge.bucket_name
  static_cloudfront_distribution_id = module.static_edge.cloudfront_distribution_id
  tags                              = local.common_tags
}

module "elasticache" {
  source                        = "./modules/elasticache"
  project                       = var.project
  environment                   = var.environment
  vpc_id                        = module.vpc.vpc_id
  private_data_subnet_ids       = module.vpc.private_data_subnet_ids
  allowed_security_group_ids    = var.redis_allowed_security_group_ids
  ecs_service_security_group_id = module.ecs_compute.service_security_group_id
  enable_ecs_service_ingress    = var.enable_ecs_compute
  node_type                     = var.redis_node_type
  num_cache_clusters            = var.redis_num_cache_clusters
  tags                          = local.common_tags
}

module "dynamodb" {
  source                     = "./modules/dynamodb"
  project                    = var.project
  environment                = var.environment
  users_table_name           = var.dynamodb_users_table_name
  games_table_name           = var.dynamodb_games_table_name
  pair_rooms_table_name      = var.dynamodb_pair_rooms_table_name
  friendships_table_name     = var.dynamodb_friendships_table_name
  friend_requests_table_name = var.dynamodb_friend_requests_table_name
  challenges_table_name      = var.dynamodb_challenges_table_name
  notifications_table_name   = var.dynamodb_notifications_table_name
  deletion_protection_enabled = false
  tags                       = local.common_tags
}

module "cognito" {
  source                          = "./modules/cognito"
  project                         = var.project
  environment                     = var.environment
  cognito_domain_prefix           = var.cognito_domain_prefix
  callback_urls                   = local.cognito_callback_urls_effective
  logout_urls                     = local.cognito_logout_urls_effective
  enable_google_identity_provider = var.cognito_enable_google_identity_provider
  google_client_id                = local.google_client_id_effective
  google_client_secret            = local.google_client_secret_effective
  apple_service_id                = var.cognito_apple_service_id
  apple_team_id                   = var.cognito_apple_team_id
  apple_key_id                    = var.cognito_apple_key_id
  apple_private_key               = var.cognito_apple_private_key
  tags                            = local.common_tags
}

module "route53" {
  source             = "./modules/route53"
  project            = var.project
  environment        = var.environment
  enabled            = var.enable_dns
  enable_app_alias   = var.enable_edge
  create_hosted_zone = var.create_route53_zone
  root_domain_name   = var.root_domain_name
  route53_zone_id    = var.route53_zone_id
  alias_records      = local.app_domain_name == null ? [] : [local.app_domain_name]
  alb_dns_name       = module.alb.alb_dns_name
  alb_zone_id        = module.alb.alb_zone_id
  tags               = local.common_tags
}

module "monitoring" {
  source                           = "./modules/monitoring"
  project                          = var.project
  environment                      = var.environment
  aws_region                       = var.aws_region
  enabled                          = var.enable_monitoring
  ecs_cluster_name                 = module.ecs_compute.cluster_name
  ecs_service_name                 = module.ecs_compute.service_name
  alb_arn_suffix                   = module.alb.alb_arn == null ? null : replace(join(":", slice(split(":", module.alb.alb_arn), 5, length(split(":", module.alb.alb_arn)))), "loadbalancer/", "")
  target_group_arn_suffix          = module.alb.target_group_arn == null ? null : join(":", slice(split(":", module.alb.target_group_arn), 5, length(split(":", module.alb.target_group_arn))))
  redis_replication_group_id       = module.elasticache.redis_replication_group_id
  dynamodb_users_table_name        = module.dynamodb.users_table_name
  dynamodb_games_table_name        = module.dynamodb.games_table_name
  alarm_email_endpoints            = var.monitoring_alarm_email_endpoints
  alarm_period_seconds             = var.monitoring_alarm_period_seconds
  alarm_evaluation_periods         = var.monitoring_alarm_evaluation_periods
  alarm_datapoints_to_alarm        = var.monitoring_alarm_datapoints_to_alarm
  ecs_cpu_utilization_threshold    = var.monitoring_ecs_cpu_utilization_threshold
  ecs_memory_utilization_threshold = var.monitoring_ecs_memory_utilization_threshold
  alb_5xx_count_threshold          = var.monitoring_alb_5xx_count_threshold
  alb_min_healthy_hosts_threshold  = var.monitoring_alb_min_healthy_hosts_threshold
  redis_engine_cpu_threshold       = var.monitoring_redis_engine_cpu_threshold
  monthly_budget_limit_usd         = var.monitoring_monthly_budget_limit_usd
  budget_alert_thresholds          = var.monitoring_budget_alert_thresholds
  tags                             = local.common_tags
}

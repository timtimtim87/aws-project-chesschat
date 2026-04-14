# ChessChat V2 — Redeploy Guide

This guide walks you through rebuilding the entire AWS infrastructure from scratch using Terraform.
The state bucket and Route53 hosted zone are preserved from the previous deployment, so re-provisioning
is a single `terraform apply` followed by a few config updates.

**Estimated time: ~30–45 minutes** (most of it waiting for CloudFront to deploy and ECS to stabilise)

---

## Prerequisites

- AWS CLI configured for account `723580627470` (us-east-1)
- Terraform >= 1.5.0 installed
- GitHub repo access to update Actions variables/secrets

---

## Step 1 — Re-enable the deploy workflow

The deploy workflow was set to manual-only during teardown to prevent failed runs while infra was offline.
Revert it so pushes to `main` trigger a deploy automatically.

**File:** `.github/workflows/deploy-main.yml`

Change:
```yaml
on:
  workflow_dispatch:
```

Back to:
```yaml
on:
  push:
    branches:
      - main
```

Commit this change to a branch — **do not push to `main` yet** (infra isn't up yet).

---

## Step 2 — Provision infrastructure

```bash
cd terraform
terraform init
terraform apply -var-file=environments/dev/terraform.tfvars
```

Type `yes` when prompted. Terraform creates all ~50 resources in the correct order.

**What takes the longest:**
- ElastiCache Redis cluster: ~10 min
- CloudFront distribution: ~15–20 min
- ACM certificate DNS validation: ~5–10 min

Terraform will wait for all of these automatically. Total apply time is typically **25–35 minutes**.

---

## Step 3 — Capture the new resource values

After apply completes, run:

```bash
terraform output
```

You need these specific values for the next steps:

| Output | Used for |
|--------|----------|
| `ecr_repository_url` | GitHub variable `ECR_REPOSITORY_URL` |
| `ecs_cluster_name` | GitHub variable `ECS_CLUSTER_NAME` |
| `ecs_service_name` | GitHub variable `ECS_SERVICE_NAME` |
| `static_site_bucket_name` | GitHub variable `STATIC_SITE_BUCKET` |
| `static_cloudfront_distribution_id` | GitHub variable `STATIC_CLOUDFRONT_DISTRIBUTION_ID` |
| `cognito_user_pool_id` | GitHub variable `COGNITO_USER_POOL_ID` + tfvars |
| `cognito_app_client_id` | GitHub variable `COGNITO_CLIENT_ID` + tfvars |
| `cognito_hosted_ui_base_url` | GitHub variable `COGNITO_HOSTED_UI_BASE_URL` + tfvars |
| `redis_primary_endpoint_address` | tfvars update only |
| `github_actions_deploy_role_arn` | GitHub secret `AWS_GHA_DEPLOY_ROLE_ARN` |

**Note:** `ECS_TASK_FAMILY` is deterministic — it is always `chesschat-dev-task`. `APP_HOST` is always `https://app.chess-chat.com`.

---

## Step 4 — Update `terraform.tfvars` with new resource endpoints

New Cognito and Redis resources will have different IDs/endpoints than the previous deployment.
Update `terraform/environments/dev/terraform.tfvars` — find the `ecs_container_environment` block
and replace the four stale values:

```hcl
ecs_container_environment = {
  ...
  REDIS_HOST                     = "<redis_primary_endpoint_address output>"
  ...
  COGNITO_USER_POOL_ID           = "<cognito_user_pool_id output>"
  COGNITO_CLIENT_ID              = "<cognito_app_client_id output>"
  COGNITO_HOSTED_UI_BASE_URL     = "<cognito_hosted_ui_base_url output>"
  ...
}
```

Then apply again to update the ECS task definition with the correct env vars:

```bash
terraform apply -var-file=environments/dev/terraform.tfvars -target=module.ecs_compute -auto-approve
```

---

## Step 5 — Update GitHub repo variables

Go to: **GitHub → timtimtim87/CHESSCHAT_V2 → Settings → Secrets and variables → Actions → Variables**

Update all 10 variables with values from `terraform output`:

| Variable | Value |
|----------|-------|
| `ECR_REPOSITORY_URL` | `terraform output -raw ecr_repository_url` |
| `ECS_CLUSTER_NAME` | `terraform output -raw ecs_cluster_name` |
| `ECS_SERVICE_NAME` | `terraform output -raw ecs_service_name` |
| `ECS_TASK_FAMILY` | `chesschat-dev-task` (unchanged) |
| `STATIC_SITE_BUCKET` | `terraform output -raw static_site_bucket_name` |
| `STATIC_CLOUDFRONT_DISTRIBUTION_ID` | `terraform output -raw static_cloudfront_distribution_id` |
| `COGNITO_USER_POOL_ID` | `terraform output -raw cognito_user_pool_id` |
| `COGNITO_CLIENT_ID` | `terraform output -raw cognito_app_client_id` |
| `COGNITO_HOSTED_UI_BASE_URL` | `terraform output -raw cognito_hosted_ui_base_url` |
| `APP_HOST` | `https://app.chess-chat.com` (unchanged) |

You can get all raw values at once from the `terraform/` directory:
```bash
for var in ecr_repository_url ecs_cluster_name ecs_service_name static_site_bucket_name \
           static_cloudfront_distribution_id cognito_user_pool_id cognito_app_client_id \
           cognito_hosted_ui_base_url redis_primary_endpoint_address github_actions_deploy_role_arn; do
  echo "$var = $(terraform output -raw $var 2>/dev/null)"
done
```

---

## Step 6 — Update the GitHub deploy secret

Go to: **GitHub → timtimtim87/CHESSCHAT_V2 → Settings → Secrets and variables → Actions → Secrets**

Update:

| Secret | Value |
|--------|-------|
| `AWS_GHA_DEPLOY_ROLE_ARN` | `terraform output -raw github_actions_deploy_role_arn` |

---

## Step 7 — Trigger the first deploy

Merge or push to `main` (including the workflow trigger change from Step 1).

The `deploy-main.yml` workflow will:
1. Build and push the Docker image to ECR
2. Publish the static auth site to S3 + invalidate CloudFront
3. Register a new ECS task definition with the updated image
4. Deploy and wait for ECS service to stabilise (~5 min)

Monitor progress at: **GitHub → Actions → Deploy Main to ECS**

---

## Step 8 — Verify the deployment

Once the deploy workflow finishes:

1. Open `https://app.chess-chat.com` — the app should load
2. Sign in with Google (or email) — Cognito should authenticate successfully
3. Optionally run the full E2E suite: **GitHub → Actions → E2E Post Deploy** (manual trigger)

---

## Troubleshooting

**ECS tasks keep restarting / failing health checks**
- Check CloudWatch logs: `/aws/ecs/chesschat-dev/app`
- Likely cause: stale env vars in task definition — re-run Step 4 + 7

**Cognito login redirects to wrong URL**
- Verify `cognito_callback_urls` and `cognito_logout_urls` in tfvars match the live domain
- Both should point to `https://app.chess-chat.com/...`

**CloudFront returns 403 on apex domain (`chess-chat.com`)**
- Check that Route53 alias record for the apex was recreated and points to the CloudFront distribution
- Verify `terraform output apex_domain_target` matches the Route53 alias value

**`terraform apply` fails on Cognito domain**
- Cognito domain prefix must be globally unique. If there's a conflict, add `cognito_domain_prefix = "chesschat-dev-XXXX"` to `terraform.tfvars` with a new suffix.

---

## What's already provisioned (no action needed)

| Resource | Details |
|----------|---------|
| Route53 hosted zone | `Z03927582T9WNB6PUN708` — `chess-chat.com` |
| Terraform state bucket | `chesschat-tfstate-723580627470-us-east-1` |
| GitHub repo + code + workflows | All intact at `timtimtim87/CHESSCHAT_V2` |

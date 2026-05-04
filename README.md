# Chess-Chat

A real-time chess app with in-browser video chat, built as an AWS portfolio project.

Portfolio write-ups: [timtimtim87.github.io](https://timtimtim87.github.io)

---

## Stack

**Application**
- Node.js + Express — REST API and WebSocket server
- React + Vite — single-page frontend
- `chess.js` — move validation and game state
- Amazon Chime SDK — in-browser peer video/audio

**Infrastructure (AWS)**
- ECS Fargate — containerised app tier in private subnets
- Application Load Balancer — HTTPS termination, WebSocket upgrade, sticky sessions
- CloudFront + S3 — static auth/landing page on the apex domain
- ElastiCache (Redis) — room state, game finalization queue
- DynamoDB — user profiles, game history, social graph
- Cognito — authentication with hosted UI
- Secrets Manager — runtime secrets injected into ECS tasks
- CloudWatch — metrics, alarms, and operations dashboard

**Delivery**
- Terraform — all infrastructure as code, modular per service
- GitHub Actions — CI quality checks on PRs; ECS deploy on manual trigger via OIDC (no static keys)
- Docker — single-container image for local dev and production

---

## Architecture notes

- Multi-AZ across three availability zones; single region (`us-east-1`)
- App and data planes in private subnets; only ALB and CloudFront are internet-facing
- Least-privilege IAM throughout — separate task execution role and task role
- GitHub Actions uses OIDC federated identity; no long-lived access keys anywhere
- Redis-backed game finalization queue with retry and dead-letter handling
- WebSocket sessions are stateful per ECS task; ALB stickiness is the current scaling guardrail (documented constraint)

---

## Running locally

Requires Docker and a populated `app/.env` (see `app/.env.example`).

```bash
docker-compose up --build
```

The app runs on `http://localhost:8080`. Cognito and Chime require real AWS credentials even in local mode.

---

## Repo layout

```
app/
  backend/   Node.js API + WebSocket server
  frontend/  React/Vite client
terraform/   Infrastructure as code (modular)
DOCS/        Architecture decisions, API contract, design guides
```

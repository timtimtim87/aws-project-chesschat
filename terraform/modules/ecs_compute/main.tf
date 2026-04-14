locals {
  module_name         = "ecs_compute"
  name_prefix         = "${var.project}-${var.environment}"
  cluster_name        = "${local.name_prefix}-ecs-cluster"
  service_name        = "${local.name_prefix}-ecs-service"
  task_family         = "${local.name_prefix}-task"
  log_group_name      = "/aws/ecs/${local.name_prefix}/${var.container_name}"
  service_sg_name     = "${local.name_prefix}-ecs-service-sg"
  effective_repo_name = coalesce(var.ecr_repository_name, "${local.name_prefix}-app")
  effective_environment = merge(
    var.container_environment,
    {
      PORT = tostring(var.container_port)
    }
  )
  container_environment_list = [
    for key in sort(keys(local.effective_environment)) : {
      name  = key
      value = tostring(local.effective_environment[key])
    }
  ]
}

resource "aws_ecr_repository" "app" {
  count = var.enabled ? 1 : 0

  name                 = local.effective_repo_name
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = merge(var.tags, {
    Name = local.effective_repo_name
  })
}

resource "aws_cloudwatch_log_group" "app" {
  count = var.enabled ? 1 : 0

  name              = local.log_group_name
  retention_in_days = var.log_retention_days

  tags = merge(var.tags, {
    Name = local.log_group_name
  })
}

resource "aws_ecs_cluster" "this" {
  count = var.enabled ? 1 : 0

  name = local.cluster_name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = merge(var.tags, {
    Name = local.cluster_name
  })
}

resource "aws_security_group" "service" {
  count = var.enabled ? 1 : 0

  name        = local.service_sg_name
  description = "Security group attached to CHESSCHAT ECS service tasks."
  vpc_id      = var.vpc_id

  tags = merge(var.tags, {
    Name = local.service_sg_name
  })
}

resource "aws_vpc_security_group_egress_rule" "service_all" {
  count = var.enabled ? 1 : 0

  security_group_id = aws_security_group.service[0].id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
  description       = "Allow ECS tasks outbound access to AWS services and dependencies."
}

resource "aws_vpc_security_group_ingress_rule" "service_from_alb" {
  count = var.enabled && var.enable_alb_integration ? 1 : 0

  security_group_id            = aws_security_group.service[0].id
  referenced_security_group_id = var.alb_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = var.container_port
  to_port                      = var.container_port
  description                  = "Allow app traffic from ALB to ECS tasks."
}

resource "aws_ecs_task_definition" "app" {
  count = var.enabled ? 1 : 0

  family                   = local.task_family
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.task_cpu)
  memory                   = tostring(var.task_memory)
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.task_role_arn

  container_definitions = jsonencode([
    {
      name      = var.container_name
      image     = "${aws_ecr_repository.app[0].repository_url}:${var.image_tag}"
      essential = true
      portMappings = [
        {
          containerPort = var.container_port
          hostPort      = var.container_port
          protocol      = "tcp"
        }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.app[0].name
          awslogs-region        = data.aws_region.current.region
          awslogs-stream-prefix = "ecs"
        }
      }
      environment = [
        for item in local.container_environment_list : {
          name  = item.name
          value = item.value
        }
      ]
      secrets = var.container_secrets
    }
  ])

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  tags = merge(var.tags, {
    Name = local.task_family
  })
}

resource "aws_ecs_service" "app" {
  count = var.enabled ? 1 : 0

  name            = local.service_name
  cluster         = aws_ecs_cluster.this[0].id
  task_definition = aws_ecs_task_definition.app[0].arn
  launch_type     = "FARGATE"
  desired_count   = var.desired_count

  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200
  enable_execute_command             = true

  dynamic "load_balancer" {
    for_each = var.enable_alb_integration ? [1] : []

    content {
      target_group_arn = var.alb_target_group_arn
      container_name   = var.container_name
      container_port   = var.container_port
    }
  }

  network_configuration {
    assign_public_ip = false
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.service[0].id]
  }

  lifecycle {
    # CI/CD deploy workflow updates task definition revisions out-of-band.
    ignore_changes = [task_definition]
  }

  tags = merge(var.tags, {
    Name = local.service_name
  })
}

data "aws_region" "current" {}

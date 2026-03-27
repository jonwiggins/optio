# Database Schema

~26 tables (Drizzle, ~28 migrations). Schema source: `apps/api/src/db/schema.ts`.

## Core

- **tasks** -- id, title, prompt, repoUrl, repoBranch, state (enum), agentType, containerId, sessionId, prUrl, prNumber, prState, prChecksStatus, prReviewStatus, prReviewComments, resultSummary, costUsd, inputTokens, outputTokens, modelUsed, errorMessage, ticketSource, ticketExternalId, metadata (jsonb), retryCount, maxRetries, priority, parentTaskId, taskType, subtaskOrder, blocksParent, worktreeState, lastPodId, workspaceId, createdBy, timestamps
- **task_events** -- id, taskId, fromState, toState, trigger, message, userId, createdAt
- **task_logs** -- id, taskId, stream, content, logType, metadata (jsonb), timestamp
- **task_comments** -- id, taskId, userId, content, timestamps
- **task_dependencies** -- id, taskId, dependsOnTaskId, createdAt
- **task_templates** -- id, name, description, repoUrl, prompt, agentType, metadata, workspaceId

## Infrastructure

- **repos** -- id, repoUrl, fullName, defaultBranch, isPrivate, imagePreset, autoMerge, claudeModel, claudeContextWindow, claudeThinking, claudeEffort, autoResume, maxConcurrentTasks, maxPodInstances, maxAgentsPerPod, reviewEnabled, reviewTrigger, slackEnabled, slackWebhookUrl, workspaceId, etc.
- **repo_pods** -- id, repoUrl, repoBranch, podName, podId, state, activeTaskCount, instanceIndex, workspaceId
- **pod_health_events** -- id, repoPodId, repoUrl, eventType, podName, message, createdAt
- **secrets** -- id, name, scope, encryptedValue (bytea), iv, authTag (AES-256-GCM), workspaceId

## Auth and Multi-tenancy

- **users** -- id, provider, externalId, email, displayName, avatarUrl, defaultWorkspaceId, timestamps
- **sessions** -- id, userId, tokenHash (SHA256), expiresAt (30-day TTL), createdAt
- **workspaces** -- id, name, slug, description, createdBy, timestamps
- **workspace_members** -- id, workspaceId, userId, role (admin/member/viewer), createdAt

## Interactive Sessions

- **interactive_sessions** -- id, repoUrl, userId, worktreePath, branch, state (active/ended), podId, costUsd, timestamps
- **session_prs** -- id, sessionId, prUrl, prNumber, prState, prChecksStatus, prReviewStatus, timestamps

## Integrations

- **webhooks** -- id, url, events (jsonb), secret, active, workspaceId
- **webhook_deliveries** -- id, webhookId, event, payload, statusCode, success, deliveredAt
- **ticket_providers** -- id, source, config (jsonb), enabled
- **prompt_templates** -- id, name, template, isDefault, repoUrl, autoMerge
- **schedules** / **schedule_runs** -- scheduled/recurring task execution
- **workflow_templates** / **workflow_runs** -- multi-step workflow automation
- **mcp_servers** -- MCP server configs (global or per-repo)
- **custom_skills** -- custom agent skills/commands

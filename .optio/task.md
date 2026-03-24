# Improve test coverage for critical paths

Improve test coverage for critical paths

## Description

Current test coverage is estimated at 10-15%, focused on shared utilities. The core orchestration paths have zero tests.

## What's tested today

- State machine transitions (`state-machine.test.ts`)
- Error classifier patterns (`error-classifier.test.ts`)
- Prompt template rendering (`prompt-template.test.ts`)
- Agent event parser (`agent-event-parser.test.ts`)
- PR watcher decision logic (`pr-watcher-worker.test.ts`)

## Critical untested paths (priority order)

1. **Task worker** — the main orchestration loop: concurrency checks, pod provisioning, agent execution, result handling (~200+ lines of complex logic)
2. **Repo pool service** — pod creation, worktree exec, cleanup (~150+ lines)
3. **Secret encryption/decryption** — round-trip correctness
4. **Review agent flow** — subtask creation, prompt rendering, completion callbacks
5. **Subtask completion checks** — `onSubtaskComplete()` parent advancement logic
6. **API routes** — at minimum: task CRUD, secrets CRUD, bulk operations

## Acceptance criteria

- Task worker has unit tests covering: concurrency limiting, retry logic, state transitions on success/failure
- Repo pool service has tests for pod lifecycle
- Secret encryption has round-trip test
- Overall coverage meaningfully improved (target: 40%+ of backend logic)

---

_Optio Task ID: 6c9dbab8-e267-48d8-97a5-2530561d6cc3_

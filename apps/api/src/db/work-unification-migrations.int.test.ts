/**
 * The Work-unification migrations against populated databases: each test
 * stages a database at the release before a migration, seeds rows in the old
 * shape with raw SQL, applies the rest, and checks where every row landed.
 * See docs/plans/work-unification.md.
 */
import { describe, expect, it } from "vitest";
import { stageDatabase } from "../test-utils/integration/staged-migration.js";

/** The last migration before the unification. */
const BEFORE = "1791800000_task_prs";

describe("1791900000_unified_run_logs", () => {
  it("moves persistent-agent turn logs into task_logs, keyed by turn, cascading from the agent", async () => {
    const db = await stageDatabase(BEFORE);
    try {
      const { sql } = db;
      const [agent] = await sql`
        INSERT INTO persistent_agents (slug, name, initial_prompt)
        VALUES ('forge', 'Forge', 'hi') RETURNING id`;
      const [turn] = await sql`
        INSERT INTO persistent_agent_turns (agent_id, turn_number, wake_source)
        VALUES (${agent.id}, 1, 'initial') RETURNING id`;
      const [first] = await sql`
        INSERT INTO persistent_agent_turn_logs (turn_id, agent_id, content, log_type, metadata, timestamp)
        VALUES (${turn.id}, ${agent.id}, 'thinking…', 'thinking', ${JSON.stringify({ a: 1 })}::jsonb, '2026-09-01T00:00:00Z')
        RETURNING id`;
      await sql`
        INSERT INTO persistent_agent_turn_logs (turn_id, agent_id, content, stream, timestamp)
        VALUES (${turn.id}, ${agent.id}, 'oops', 'stderr', '2026-09-01T00:00:01Z')`;
      const [task] = await sql`
        INSERT INTO tasks (title, prompt, repo_url, agent_type)
        VALUES ('t', 'p', 'https://github.com/acme/app', 'claude-code') RETURNING id`;
      await sql`INSERT INTO task_logs (task_id, content) VALUES (${task.id}, 'task line')`;

      await db.migrateRest();

      const [{ exists }] = await sql`
        SELECT to_regclass('public.persistent_agent_turn_logs') IS NOT NULL AS exists`;
      expect(exists).toBe(false);

      const moved = await sql`
        SELECT id, persistent_agent_turn_id, task_id, content, stream, log_type, metadata, timestamp
        FROM task_logs WHERE persistent_agent_turn_id = ${turn.id} ORDER BY timestamp`;
      expect(moved).toHaveLength(2);
      expect(moved[0]).toMatchObject({
        id: first.id,
        task_id: null,
        content: "thinking…",
        stream: "stdout",
        log_type: "thinking",
        metadata: { a: 1 },
      });
      expect(moved[1]).toMatchObject({ content: "oops", stream: "stderr", log_type: null });

      // Deleting the agent deletes its turns, and with them their logs.
      await sql`DELETE FROM persistent_agents WHERE id = ${agent.id}`;
      const [{ left }] = await sql`
        SELECT count(*)::int AS left FROM task_logs WHERE persistent_agent_turn_id IS NOT NULL`;
      expect(left).toBe(0);
      const [{ taskLines }] = await sql`
        SELECT count(*)::int AS "taskLines" FROM task_logs WHERE task_id = ${task.id}`;
      expect(taskLines).toBe(1);
    } finally {
      await db.drop();
    }
  });
});

describe("1791910000_agent_pods", () => {
  it("moves every pod into agent_pods, keeping ids, keys, counts, and per-pool fields", async () => {
    const db = await stageDatabase(BEFORE);
    try {
      const { sql } = db;
      const [repoPod] = await sql`
        INSERT INTO repo_pods (repo_url, repo_branch, instance_index, pod_name, pod_id, state,
          active_task_count, last_task_at, cache_pvc_name, cache_pvc_state, statefulset_name, managed_by)
        VALUES ('https://github.com/acme/app', 'dev', 1, 'repo-pod-1', 'uid-1', 'ready', 2,
          '2026-09-01T00:00:00Z', 'cache-pvc', 'bound', 'optio-sts', 'statefulset')
        RETURNING id`;
      const [wf] = await sql`
        INSERT INTO workflows (name, prompt_template) VALUES ('Report', 'go') RETURNING id`;
      const [jobPod] = await sql`
        INSERT INTO workflow_pods (workflow_id, instance_index, pod_name, state, active_run_count,
          last_run_at, job_name, managed_by)
        VALUES (${wf.id}, 0, 'wf-pod', 'provisioning', 1, '2026-09-02T00:00:00Z', 'wf-job', 'job')
        RETURNING id`;
      const [agent] = await sql`
        INSERT INTO persistent_agents (slug, name, initial_prompt)
        VALUES ('forge', 'Forge', 'hi') RETURNING id`;
      const [agentPod] = await sql`
        INSERT INTO persistent_agent_pods (agent_id, pod_name, state, last_turn_at, keep_warm_until)
        VALUES (${agent.id}, 'pa-pod', 'ready', '2026-09-03T00:00:00Z', NULL)
        RETURNING id`;
      const [session] = await sql`
        INSERT INTO interactive_sessions (repo_url, branch, pod_id)
        VALUES ('https://github.com/acme/app', 's', ${repoPod.id}) RETURNING id`;

      await db.migrateRest();

      for (const gone of ["repo_pods", "workflow_pods", "persistent_agent_pods"]) {
        const [{ exists }] =
          await sql`SELECT to_regclass(${"public." + gone}) IS NOT NULL AS exists`;
        expect(exists, gone).toBe(false);
      }
      const [{ types }] = await sql`
        SELECT count(*)::int AS types FROM pg_type
        WHERE typname IN ('repo_pod_state', 'workflow_pod_state')`;
      expect(types).toBe(0);

      const rows = await sql`SELECT * FROM agent_pods ORDER BY pool`;
      expect(rows).toHaveLength(3);
      const byPool = Object.fromEntries(rows.map((r) => [r.pool, r]));
      expect(byPool.repo).toMatchObject({
        id: repoPod.id,
        pool_key: "https://github.com/acme/app",
        repo_branch: "dev",
        instance_index: 1,
        pod_name: "repo-pod-1",
        pod_id: "uid-1",
        state: "ready",
        active_count: 2,
        cache_pvc_name: "cache-pvc",
        cache_pvc_state: "bound",
        statefulset_name: "optio-sts",
        managed_by: "statefulset",
        workspace_id: null,
      });
      expect(new Date(byPool.repo.last_used_at).toISOString()).toBe("2026-09-01T00:00:00.000Z");
      expect(byPool.standalone).toMatchObject({
        id: jobPod.id,
        pool_key: wf.id,
        state: "provisioning",
        active_count: 1,
        job_name: "wf-job",
        managed_by: "job",
      });
      expect(byPool["persistent-agent"]).toMatchObject({
        id: agentPod.id,
        pool_key: agent.id,
        keep_warm_until: null,
        active_count: 0,
      });

      // Sessions still find their pod by id.
      const [joined] = await sql`
        SELECT p.pod_name FROM interactive_sessions s JOIN agent_pods p ON p.id = s.pod_id
        WHERE s.id = ${session.id}`;
      expect(joined.pod_name).toBe("repo-pod-1");

      // A Job's (key, instance) stays unique; repo pods never were.
      await expect(
        sql`INSERT INTO agent_pods (pool, pool_key, instance_index) VALUES ('standalone', ${wf.id}, 0)`,
      ).rejects.toThrow(/agent_pods_standalone_instance_key/);
      await sql`
        INSERT INTO agent_pods (pool, pool_key, instance_index)
        VALUES ('repo', 'https://github.com/acme/app', 1)`;
    } finally {
      await db.drop();
    }
  });
});

describe("1791920000_work_definitions", () => {
  it("moves scheduled Tasks, Jobs, and Local automations into work_definitions with their ids and links", async () => {
    const db = await stageDatabase("1791910000_agent_pods");
    try {
      const { sql } = db;
      const [user] = await sql`
        INSERT INTO users (provider, external_id, email, display_name)
        VALUES ('github', 'u1', 'u1@example.com', 'U1') RETURNING id`;
      const [ws] = await sql`
        INSERT INTO workspaces (name, slug) VALUES ('W', 'w-defs') RETURNING id`;
      const [host] = await sql`
        INSERT INTO local_hosts (user_id, name, hostname, platform)
        VALUES (${user.id}, 'M1', 'm1', 'darwin') RETURNING id`;
      const [template] = await sql`
        INSERT INTO prompt_templates (name, template) VALUES ('Saved', 'do {{x}}') RETURNING id`;

      const [config] = await sql`
        INSERT INTO task_configs (name, description, workspace_id, title, prompt, prompt_template_id,
          repo_url, repo_branch, agent_type, max_retries, priority, enabled, created_by,
          run_target, local_host_id, local_dir, local_session_mode, agent_options, auto_resume, auto_merge,
          owner_user_id, pod_secrets)
        VALUES ('Nightly', 'every night', ${ws.id}, 'Nightly {{date}}', 'fix things', ${template.id},
          'https://github.com/acme/app', 'dev', 'codex', 4, 7, false, ${user.id},
          'local', ${host.id}, '/src/app', 'interactive', ${JSON.stringify({ effort: "high" })}::jsonb,
          true, false, ${user.id}, ${JSON.stringify(["NPM_TOKEN"])}::jsonb)
        RETURNING id`;
      const [job] = await sql`
        INSERT INTO workflows (name, workspace_id, environment_spec, prompt_template, params_schema,
          run_title, agent_runtime, model, max_turns, budget_usd, max_concurrent, max_retries,
          warm_pool_size, max_pod_instances, max_agents_per_pod, created_by, pod_secrets)
        VALUES ('Report', ${ws.id}, ${JSON.stringify({ env: 1 })}::jsonb, 'report on {{x}}',
          ${JSON.stringify({ type: "object" })}::jsonb, 'Report {{x}}', 'gemini', 'pro', 12, '2.5',
          3, 2, 1, 4, 5, ${user.id}, ${JSON.stringify([])}::jsonb)
        RETURNING id`;
      const [automation] = await sql`
        INSERT INTO local_blueprints (user_id, workspace_id, name, host_id, dir, repo_url, base_branch,
          command_template, run_title, prompt_template_id, agent, spawn_mode, session_mode, agent_options)
        VALUES (${user.id}, ${ws.id}, 'Review PRs', ${host.id}, '/src/app', 'https://github.com/acme/app',
          'main', 'review {{prUrl}}', 'Review {{prNumber}}', NULL, 'claude-code', 'hold', 'headless', NULL)
        RETURNING id`;

      const [run] = await sql`
        INSERT INTO workflow_runs (workflow_id, state) VALUES (${job.id}, 'completed') RETURNING id`;
      const [jobTrigger] = await sql`
        INSERT INTO workflow_triggers (workflow_id, target_type, target_id, type)
        VALUES (${job.id}, 'job', ${job.id}, 'manual') RETURNING id`;
      const spawned = async (taskConfigId: string) => {
        const [t] = await sql`
          INSERT INTO tasks (title, prompt, repo_url, agent_type, metadata)
          VALUES ('t', 'p', 'https://github.com/acme/app', 'codex',
            ${JSON.stringify({ taskConfigId })}::jsonb)
          RETURNING id`;
        return t.id as string;
      };
      const fromConfig = await spawned(config.id);
      const fromDeleted = await spawned("00000000-0000-0000-0000-000000000000");
      const fromGarbage = await spawned("not-a-uuid");

      await db.migrateRest();

      for (const gone of ["task_configs", "workflows", "local_blueprints"]) {
        const [{ exists }] =
          await sql`SELECT to_regclass(${"public." + gone}) IS NOT NULL AS exists`;
        expect(exists, gone).toBe(false);
      }

      const rows = await sql`SELECT * FROM work_definitions`;
      const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));
      expect(rows).toHaveLength(3);
      expect(byKind["repo-blueprint"]).toMatchObject({
        id: config.id,
        name: "Nightly",
        description: "every night",
        workspace_id: ws.id,
        owner_user_id: user.id,
        pod_secrets: ["NPM_TOKEN"],
        created_by: user.id,
        enabled: false,
        prompt: "fix things",
        prompt_template_id: template.id,
        run_title: "Nightly {{date}}",
        agent_type: "codex",
        agent_options: { effort: "high" },
        repo_url: "https://github.com/acme/app",
        repo_branch: "dev",
        run_target: "local",
        local_host_id: host.id,
        local_dir: "/src/app",
        local_session_mode: "interactive",
        max_retries: 4,
        priority: 7,
        auto_resume: true,
        auto_merge: false,
      });
      expect(byKind.standalone).toMatchObject({
        id: job.id,
        name: "Report",
        workspace_id: ws.id,
        owner_user_id: null,
        pod_secrets: [],
        created_by: user.id,
        prompt: "report on {{x}}",
        run_title: "Report {{x}}",
        params_schema: { type: "object" },
        environment_spec: { env: 1 },
        agent_type: "gemini",
        model: "pro",
        max_turns: 12,
        budget_usd: "2.5",
        max_concurrent: 3,
        max_retries: 2,
        warm_pool_size: 1,
        max_pod_instances: 4,
        max_agents_per_pod: 5,
        run_target: "cluster",
        local_session_mode: "headless",
        repo_url: null,
      });
      expect(byKind["local-blueprint"]).toMatchObject({
        id: automation.id,
        name: "Review PRs",
        // A Local automation's person is its owner, like any personal work.
        owner_user_id: user.id,
        workspace_id: ws.id,
        run_target: "local",
        local_host_id: host.id,
        local_dir: "/src/app",
        repo_url: "https://github.com/acme/app",
        repo_branch: "main",
        prompt: "review {{prUrl}}",
        run_title: "Review {{prNumber}}",
        agent_type: "claude-code",
        spawn_mode: "hold",
        local_session_mode: "headless",
      });

      // Spawned tasks point at their scheduled Task, when it still exists.
      const links = await sql`SELECT id, work_id FROM tasks`;
      const workId = Object.fromEntries(links.map((t) => [t.id, t.work_id]));
      expect(workId[fromConfig]).toBe(config.id);
      expect(workId[fromDeleted]).toBeNull();
      expect(workId[fromGarbage]).toBeNull();

      // Names stay unique per kind: per workspace for scheduled Tasks and Jobs,
      // per person for Local automations.
      await expect(
        sql`INSERT INTO work_definitions (kind, name, workspace_id, prompt)
            VALUES ('standalone', 'Report', ${ws.id}, 'x')`,
      ).rejects.toThrow(/work_definitions_workspace_name_key/);
      await sql`INSERT INTO work_definitions (kind, name, workspace_id, prompt, repo_url)
                VALUES ('repo-blueprint', 'Report', ${ws.id}, 'x', 'https://github.com/acme/app')`;
      await expect(
        sql`INSERT INTO work_definitions (kind, name, owner_user_id, prompt)
            VALUES ('local-blueprint', 'Review PRs', ${user.id}, 'x')`,
      ).rejects.toThrow(/work_definitions_user_name_key/);
      // A scheduled Task needs a repo.
      await expect(
        sql`INSERT INTO work_definitions (kind, name, prompt) VALUES ('repo-blueprint', 'R', 'x')`,
      ).rejects.toThrow(/work_definitions_repo_check/);

      // Deleting a Job takes its runs and its triggers' legacy link with it;
      // deleting a scheduled Task keeps the tasks it spawned.
      await sql`DELETE FROM work_definitions WHERE id = ${job.id}`;
      const [{ runs }] = await sql`
        SELECT count(*)::int AS runs FROM workflow_runs WHERE id = ${run.id}`;
      expect(runs).toBe(0);
      const [{ triggers }] = await sql`
        SELECT count(*)::int AS triggers FROM workflow_triggers WHERE id = ${jobTrigger.id}`;
      expect(triggers).toBe(0);
      await sql`DELETE FROM work_definitions WHERE id = ${config.id}`;
      const [kept] = await sql`SELECT work_id FROM tasks WHERE id = ${fromConfig}`;
      expect(kept.work_id).toBeNull();

      // A person's work outlives them as the organization's (owner cleared).
      await sql`DELETE FROM users WHERE id = ${user.id}`;
      const [automationRow] = await sql`
        SELECT owner_user_id FROM work_definitions WHERE id = ${automation.id}`;
      expect(automationRow.owner_user_id).toBeNull();
    } finally {
      await db.drop();
    }
  });
});

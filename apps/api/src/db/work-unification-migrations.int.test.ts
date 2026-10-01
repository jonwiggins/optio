/**
 * The Work-unification migrations against populated databases: each test
 * stages a database at the release before a migration, seeds rows in the old
 * shape with raw SQL, applies the rest, and checks where every row landed.
 * See docs/plans/work-unification.md.
 */
import { describe, expect, it } from "vitest";
import { stageDatabase } from "../test-utils/integration/staged-migration.js";

/** The last migration before the unification. */
const BEFORE = "1791600000_task_pr_follow_through";

describe("1791612000_unified_run_logs", () => {
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

describe("1791613000_agent_pods", () => {
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

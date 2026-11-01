/** Real admission path: a budget holds the queued run before any fake pod is
 * started, then the same run continues after the administrator lifts it. */
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import postgres from "postgres";
import { startApiServer, waitFor, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";
let server: ApiServerHandle;
let db: postgres.Sql;
beforeAll(async () => {
  // Held work re-checks its budget after OPTIO_BUDGET_RETRY_MS (60 s in production).
  server = await startApiServer({ env: { OPTIO_BUDGET_RETRY_MS: "2000" } });
  db = postgres(process.env.DATABASE_URL!);
}, 150000);
afterAll(async () => {
  await db?.end();
  await server?.stop();
});
async function api(path: string, body?: unknown) {
  const r = await fetch(`${server.baseUrl}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  expect(r.ok, await r.clone().text()).toBe(true);
  return r.json();
}
describe("usage budget admission", () => {
  it("holds new work at the monthly limit and resumes the same run after the limit is raised", async () => {
    const { workflow } = await api("/api/jobs", {
      name: "Budget admission",
      promptTemplate: "Say hello",
      agentRuntime: "claude-code",
    });
    const [ws] =
      await db`INSERT INTO workspaces(name,slug) VALUES('Budget organization','budget-test') RETURNING id`;
    await db`UPDATE work_definitions SET workspace_id=${ws.id} WHERE id=${workflow.id}`;
    const [budget] =
      await db`INSERT INTO usage_budgets(workspace_id,subject_kind,name,token_limit,action) VALUES(${ws.id},'organization','Monthly usage',100,'pause_new') RETURNING id`;
    await db`INSERT INTO tasks(kind,work_id,workspace_id,title,prompt,state,input_tokens) VALUES('standalone',${workflow.id},${ws.id},'Prior run','','completed',100)`;
    const { run } = await api(`/api/jobs/${workflow.id}/runs`, {});
    await waitFor(
      async () => {
        const r = (await api(`/api/workflow-runs/${run.id}`)).run;
        return r.errorMessage?.includes("Usage budget reached") ? r : null;
      },
      { timeoutMs: 15000, label: "budget hold" },
    );
    const [held] = await db`SELECT state,exec_state,pod_id FROM tasks WHERE id=${run.id}`;
    expect(held).toMatchObject({ state: "queued", exec_state: null, pod_id: null });
    await db`UPDATE usage_budgets SET token_limit=10000000 WHERE id=${budget.id}`;
    const finished = await waitFor(
      async () => {
        const r = (await api(`/api/workflow-runs/${run.id}`)).run;
        return ["completed", "failed"].includes(r.state) ? r : null;
      },
      { timeoutMs: 30000, label: "budget released" },
    );
    expect(finished.state).toBe("completed");
    expect(finished.errorMessage).toBeNull();
    const [usage] =
      await db`SELECT SUM(cost_usd) AS cost, SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) AS tokens FROM usage_ledger WHERE source_id=${run.id}`;
    expect(Number(usage.cost)).toBe(0.0123);
    expect(Number(usage.tokens)).toBeGreaterThan(0);
  });
});

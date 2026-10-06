/**
 * E2E: config as code through the real API server with OPTIO_CONFIG_DIR set.
 *
 * Covers: boot applies the mounted directory → the rows show `managedBy` over
 * HTTP (strict response schemas included) → Settings' status endpoint → a UI
 * edit is put back by `POST /api/config/source/sync` → the public JSON Schema
 * → `POST /api/config/apply` (what the CLI posts) → export → detach.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer, waitFor, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";

let server: ApiServerHandle;
let dir: string;

const manifest = (kind: string, name: string, spec: Record<string, unknown>) =>
  JSON.stringify({ apiVersion: "optio/v1", kind, metadata: { name }, spec });

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "optio-e2e-config-"));
  await fs.mkdir(path.join(dir, "prompts"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "prompts", "e2e-managed.yaml"),
    manifest("Prompt", "e2e-managed-prompt", { template: "From the directory {{x}}" }),
  );
  await fs.writeFile(
    path.join(dir, "e2e-job.yaml"),
    manifest("Work", "e2e-managed-job", {
      who: { runtime: "shell" },
      what: { prompt: "echo managed" },
    }),
  );
  server = await startApiServer({
    env: { OPTIO_CONFIG_DIR: dir, OPTIO_CONFIG_INTERVAL: "600000" },
  });
}, 150_000);

afterAll(async () => {
  await server?.stop();
  await fs.rm(dir, { recursive: true, force: true });
});

async function api<T>(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: T; text: string }> {
  // Only a body gets the JSON content type: Fastify answers 400 to an empty
  // JSON body, and the sync and detach POSTs send none.
  const res = await fetch(`${server.baseUrl}${path}`, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  const text = await res.text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = undefined as T;
  }
  return { status: res.status, body, text };
}

interface Status {
  enabled: boolean;
  source: {
    path: string;
    lastSyncAt: string | null;
    lastSync: { summary: Record<string, number> } | null;
  } | null;
  schemaUrl: string;
}

describe("config as code over HTTP", () => {
  it("applies the directory at boot and reports it in the status", async () => {
    const status = await waitFor(
      async () => {
        const { body } = await api<Status>("/api/config/status");
        return body.source?.lastSyncAt ? body : null;
      },
      { timeoutMs: 60_000, label: "first sync of OPTIO_CONFIG_DIR" },
    );
    expect(status.enabled).toBe(true);
    expect(status.source!.path).toBe(dir);
    expect(status.source!.lastSync!.summary).toMatchObject({ created: 2, errors: 0 });
    expect(status.schemaUrl).toMatch(/\/api\/config\/schema\.json$/);
  });

  it("shows managedBy on the Work list row and the prompt, through the response schemas", async () => {
    const work = await api<{
      rows: Array<{ name: string; managedBy?: { path: string; kind: string } }>;
    }>("/api/work");
    const job = work.body.rows.find((r) => r.name === "e2e-managed-job");
    expect(job?.managedBy).toMatchObject({ kind: "Work", path: "e2e-job.yaml" });

    const prompts = await api<{ templates: Array<{ name: string; managedBy?: { path: string } }> }>(
      "/api/prompt-templates",
    );
    const prompt = prompts.body.templates.find((t) => t.name === "e2e-managed-prompt");
    expect(prompt?.managedBy).toMatchObject({ path: "prompts/e2e-managed.yaml" });
  });

  it("puts a UI edit back on the next sync and reports it as reverted", async () => {
    const prompts = await api<{ templates: Array<{ id: string; name: string }> }>(
      "/api/prompt-templates",
    );
    const prompt = prompts.body.templates.find((t) => t.name === "e2e-managed-prompt")!;
    const edit = await api(`/api/prompt-templates/${prompt.id}`, {
      method: "PATCH",
      body: JSON.stringify({ template: "Edited by hand" }),
    });
    expect(edit.status).toBe(200);

    const sync = await api<{
      items: Array<{ name: string; action: string; reverted?: boolean }>;
      summary: Record<string, number>;
    }>("/api/config/source/sync", { method: "POST" });
    expect(sync.status).toBe(200);
    expect(sync.body.items.find((i) => i.name === "e2e-managed-prompt")).toMatchObject({
      action: "update",
      reverted: true,
    });
    expect(sync.body.summary.reverted).toBe(1);

    // There is no GET by id for named prompts: read it back from the list.
    const after = await api<{ templates: Array<{ id: string; template: string }> }>(
      "/api/prompt-templates",
    );
    expect(after.body.templates.find((t) => t.id === prompt.id)?.template).toBe(
      "From the directory {{x}}",
    );
  });

  it("serves the JSON Schema publicly and applies manifests the CLI posts", async () => {
    const schema = await api<{ $schema: string }>("/api/config/schema.json");
    expect(schema.status).toBe(200);
    expect(schema.body.$schema).toContain("draft-07");

    const plan = await api<{ dryRun: boolean; items: Array<{ action: string; name: string }> }>(
      "/api/config/apply",
      {
        method: "POST",
        body: JSON.stringify({
          dryRun: true,
          manifests: [
            {
              path: "cli/prompt.yaml",
              document: JSON.parse(
                manifest("Prompt", "e2e-cli-prompt", { template: "From the CLI" }),
              ),
            },
          ],
        }),
      },
    );
    expect(plan.status).toBe(200);
    expect(plan.body.dryRun).toBe(true);
    expect(plan.body.items).toEqual([
      expect.objectContaining({ action: "create", name: "e2e-cli-prompt" }),
    ]);

    const applied = await api<{ items: Array<{ action: string; resourceId?: string }> }>(
      "/api/config/apply",
      {
        method: "POST",
        body: JSON.stringify({
          manifests: [
            {
              path: "cli/prompt.yaml",
              document: JSON.parse(
                manifest("Prompt", "e2e-cli-prompt", { template: "From the CLI" }),
              ),
            },
          ],
        }),
      },
    );
    expect(applied.body.items[0]).toMatchObject({ action: "create" });
    // A CLI apply manages nothing.
    const prompts = await api<{ templates: Array<{ name: string; managedBy?: unknown }> }>(
      "/api/prompt-templates",
    );
    expect(
      prompts.body.templates.find((t) => t.name === "e2e-cli-prompt")?.managedBy,
    ).toBeUndefined();
  });

  it("exports the workspace as manifests and as YAML", async () => {
    const json = await api<{ manifests: Array<{ kind: string; name: string; path: string }> }>(
      "/api/config/export?kind=Prompt,Work",
    );
    expect(json.body.manifests.map((m) => m.name)).toEqual(
      expect.arrayContaining(["e2e-managed-prompt", "e2e-cli-prompt", "e2e-managed-job"]),
    );
    const yaml = await api<unknown>("/api/config/export.yaml?kind=Work&download=1");
    expect(yaml.status).toBe(200);
    expect(yaml.text).toContain("kind: Work");
    expect(yaml.text).toContain("name: e2e-managed-job");
    expect(yaml.text).toContain("yaml-language-server");
  });

  it("detaches a managed resource", async () => {
    const work = await api<{ rows: Array<{ name: string; managedBy?: { objectId: string } }> }>(
      "/api/work",
    );
    const job = work.body.rows.find((r) => r.name === "e2e-managed-job")!;
    const detach = await api(`/api/config/objects/${job.managedBy!.objectId}/detach`, {
      method: "POST",
    });
    expect(detach.status).toBe(204);
    const again = await api<{ rows: Array<{ name: string; managedBy?: unknown }> }>("/api/work");
    expect(again.body.rows.find((r) => r.name === "e2e-managed-job")!.managedBy).toBeUndefined();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// An in-memory prompt_templates: the seed's queries are decoded from the
// condition objects the mocked drizzle helpers below build.
type Row = {
  id: string;
  name: string;
  template: string;
  kind: string;
  description: string | null;
  paramsSchema: Record<string, unknown> | null;
  workspaceId: string | null;
  ownerUserId: string | null;
};
let table: Row[] = [];
let nextId = 1;

vi.mock("drizzle-orm", () => ({
  and: (...c: unknown[]) => ({ and: c }),
  eq: (col: string, v: unknown) => ({ eq: [col, v] }),
  isNull: (col: string) => ({ isNull: col }),
  inArray: (col: string, v: unknown[]) => ({ inArray: [col, v] }),
}));

vi.mock("../db/schema.js", () => ({
  promptTemplates: {
    id: "id",
    name: "name",
    workspaceId: "workspaceId",
    ownerUserId: "ownerUserId",
  },
}));

type Cond = {
  and?: Cond[];
  eq?: [string, unknown];
  isNull?: string;
  inArray?: [string, unknown[]];
};
function matches(row: Row, c: Cond): boolean {
  if (c.and) return c.and.every((x) => matches(row, x));
  if (c.eq) return (row as Record<string, unknown>)[c.eq[0]] === c.eq[1];
  if (c.isNull) return (row as Record<string, unknown>)[c.isNull] == null;
  if (c.inArray) return c.inArray[1].includes((row as Record<string, unknown>)[c.inArray[0]]);
  return true;
}

vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({
      from: () => ({ where: async (c: Cond) => table.filter((r) => matches(r, c)) }),
    }),
    insert: () => ({
      values: (v: Omit<Row, "id">) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            // The unique (scope, name) index.
            if (table.some((r) => r.name === v.name && r.workspaceId === v.workspaceId)) return [];
            const row = { id: `p${nextId++}`, ...v } as Row;
            table.push(row);
            return [{ id: row.id }];
          },
        }),
      }),
    }),
    update: () => ({
      set: (patch: Partial<Row>) => ({
        where: async (c: Cond) => {
          for (const r of table.filter((x) => matches(x, c))) Object.assign(r, patch);
        },
      }),
    }),
  },
}));

vi.mock("../logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { STARTER_PROMPTS, isStarterRow, seedStarterPrompts } from "./starter-prompts.js";
import { platformTemplateParams, renderTemplateString } from "./prompt-template-service.js";

const N = STARTER_PROMPTS.length;
const byName = (name: string) => table.find((r) => r.name === name);

beforeEach(() => {
  table = [];
  nextId = 1;
  // The deployment asks for the starters at boot (off by default).
  vi.stubEnv("OPTIO_STARTER_PROMPTS", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("seedStarterPrompts by default (OPTIO_STARTER_PROMPTS unset)", () => {
  it("adds none at boot; Restore adds them all", async () => {
    vi.stubEnv("OPTIO_STARTER_PROMPTS", "");
    expect(await seedStarterPrompts()).toEqual({ created: 0, restored: 0, unchanged: 0 });
    expect(table).toHaveLength(0);
    expect((await seedStarterPrompts({ restore: true })).created).toBe(N);
    // Once there, a boot keeps them as with the setting on.
    expect(await seedStarterPrompts()).toEqual({ created: 0, restored: 0, unchanged: N });
  });
});

describe("seedStarterPrompts", () => {
  it("adds every starter as an organization prompt with no workspace, once", async () => {
    expect(await seedStarterPrompts()).toEqual({ created: N, restored: 0, unchanged: 0 });
    expect(table).toHaveLength(N);
    for (const r of table) {
      expect(r.workspaceId).toBeNull();
      expect(r.ownerUserId).toBeNull();
      expect(isStarterRow(r)).toBe(true);
    }
    // Idempotent: a second boot, and a restore with nothing changed, add nothing.
    expect(await seedStarterPrompts()).toEqual({ created: 0, restored: 0, unchanged: N });
    expect(await seedStarterPrompts({ restore: true })).toEqual({
      created: 0,
      restored: 0,
      unchanged: N,
    });
    expect(table).toHaveLength(N);
  });

  it("keeps a starter an admin deleted deleted at boot; Restore brings it back", async () => {
    await seedStarterPrompts();
    table = table.filter((r) => r.name !== "Write a README");

    expect((await seedStarterPrompts()).created).toBe(0);
    expect(byName("Write a README")).toBeUndefined();

    expect((await seedStarterPrompts({ restore: true })).created).toBe(1);
    expect(byName("Write a README")).toBeDefined();
    expect(table).toHaveLength(N);
  });

  it("leaves an edited starter at boot; Restore puts its text back", async () => {
    await seedStarterPrompts();
    const original = byName("Add tests")!.template;
    byName("Add tests")!.template = "our own version";

    await seedStarterPrompts();
    expect(byName("Add tests")!.template).toBe("our own version");

    expect((await seedStarterPrompts({ restore: true })).restored).toBe(1);
    expect(byName("Add tests")!.template).toBe(original);
  });

  it("never touches someone's own prompt that shares a starter's name", async () => {
    table.push({
      id: "mine",
      name: "Refactor safely",
      template: "the team's refactoring prompt",
      kind: "task",
      description: null,
      paramsSchema: null,
      workspaceId: null,
      ownerUserId: null,
    });
    const first = await seedStarterPrompts({ restore: true });
    expect(first.created).toBe(N - 1);
    expect(byName("Refactor safely")!.template).toBe("the team's refactoring prompt");
    expect(table.filter((r) => r.name === "Refactor safely")).toHaveLength(1);
  });
});

describe("the starter prompts", () => {
  it("are the thirteen the Prompts page offers", () => {
    expect(STARTER_PROMPTS.map((p) => p.name)).toEqual([
      "Create a Claude Code skill",
      "Create an MCP tool / connection note",
      "Write or improve CLAUDE.md",
      "Code review (thorough)",
      "Code review (light)",
      "Security review",
      "Document this module",
      "Generate API docs",
      "Write a README",
      "Fix a bug from a ticket",
      "Refactor safely",
      "Add tests",
      "Upgrade a dependency",
    ]);
  });

  // The params a render needs: every declared one, with a value that shows.
  const filled = (p: (typeof STARTER_PROMPTS)[number]) =>
    Object.fromEntries(Object.keys(p.params).map((k) => [k, `<${k}>`]));
  const onGitHub = (p: (typeof STARTER_PROMPTS)[number]) =>
    renderTemplateString(p.template, {
      ...platformTemplateParams(p.template, "github"),
      ...filled(p),
    });
  const onGitLab = (p: (typeof STARTER_PROMPTS)[number]) =>
    renderTemplateString(p.template, {
      ...platformTemplateParams(p.template, "gitlab"),
      ...filled(p),
    });

  it.each(STARTER_PROMPTS.map((p) => [p.name, p] as const))("%s is a real prompt", (_n, p) => {
    for (const text of [onGitHub(p), onGitLab(p)]) {
      const words = text.split(/\s+/).filter(Boolean).length;
      expect(words).toBeGreaterThanOrEqual(250);
      expect(words).toBeLessThanOrEqual(900);
      // Nothing of the template language is left for the agent to read.
      expect(text).not.toMatch(/\{\{[#/]?(?:if|else)\b|\{\{\w+\}\}/);
    }
    expect(["task", "review"]).toContain(p.kind);
    // Every param it takes appears in it, and every {{param}} it uses is
    // declared (or is the repo's platform).
    for (const name of Object.keys(p.params)) expect(p.template).toContain(`{{${name}}}`);
    const used = new Set(
      [...p.template.matchAll(/\{\{(?:#if )?(\w+)\}\}/g)]
        .map((m) => m[1])
        .filter((name) => name !== "else"),
    );
    for (const name of used) {
      expect([...Object.keys(p.params), "GIT_PLATFORM_GITLAB"]).toContain(name);
    }
    // renderTemplateString knows {{#if x}}…{{else}}…{{/if}} without nesting.
    let depth = 0;
    for (const t of p.template.matchAll(/\{\{#if \w+\}\}|\{\{\/if\}\}/g)) {
      depth += t[0].startsWith("{{#") ? 1 : -1;
      expect(depth).toBeLessThanOrEqual(1);
    }
    expect(depth).toBe(0);
    // An approval already given is given again, so it counts after a later
    // "Changes Requested:" note (GitLab refuses a second approve).
    expect(p.template).not.toMatch(/glab mr approve \{\{mr\}\}(?! \|\| \(glab mr revoke|\))/);
    // Neutral about where it runs.
    expect(p.template).not.toMatch(/no internet|this network|package mirror|offline/i);
  });

  it.each(STARTER_PROMPTS.map((p) => [p.name, p] as const))(
    "%s speaks GitHub on a GitHub repo and GitLab on a GitLab repo",
    (_n, p) => {
      const github = onGitHub(p);
      const gitlab = onGitLab(p);
      expect(github).not.toMatch(/\bglab\b|merge request|\.gitlab-ci\.yml/);
      expect(gitlab).not.toMatch(/\bgh (?:pr|run)\b|pull request|\.github\/workflows/);
    },
  );

  it("review with gh pr on GitHub and glab mr on GitLab", () => {
    for (const name of ["Code review (thorough)", "Code review (light)"]) {
      const p = STARTER_PROMPTS.find((x) => x.name === name)!;
      expect(onGitHub(p)).toContain("gh pr diff <mr>");
      expect(onGitHub(p)).toContain("gh pr review <mr> --approve");
      expect(onGitHub(p)).toMatch(/^Review pull request #<mr>|^Give pull request #<mr>/);
      expect(onGitLab(p)).toContain("glab mr diff <mr>");
      expect(onGitLab(p)).toContain('"**Changes Requested:**');
      expect(onGitLab(p)).toMatch(/^Review merge request !<mr>|^Give merge request !<mr>/);
    }
    const security = STARTER_PROMPTS.find((x) => x.name === "Security review")!;
    expect(onGitHub(security)).toContain("gh pr comment <number>");
    expect(onGitLab(security)).toContain("glab mr note <iid>");
  });

  it("render with GitHub's arms when nothing names the platform (a preview)", () => {
    const p = STARTER_PROMPTS.find((x) => x.name === "Code review (light)")!;
    expect(renderTemplateString(p.template, filled(p))).toBe(onGitHub(p));
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("../db/schema.js", () => ({
  promptTemplates: {
    id: "prompt_templates.id",
    isDefault: "prompt_templates.is_default",
    repoUrl: "prompt_templates.repo_url",
    workspaceId: "prompt_templates.workspace_id",
    ownerUserId: "prompt_templates.owner_user_id",
  },
  repos: {
    id: "repos.id",
    repoUrl: "repos.repo_url",
  },
}));

vi.mock("./repo-service.js", () => ({ getRepoByUrl: vi.fn() }));

import { db } from "../db/client.js";
import { getRepoByUrl } from "./repo-service.js";
import {
  getPromptTemplate,
  saveDefaultPromptTemplate,
  saveRepoPromptTemplate,
  listPromptTemplates,
  renderRunTitle,
  renderTemplateString,
} from "./prompt-template-service.js";

describe("renderRunTitle", () => {
  it("fills the template from the trigger's params", () => {
    expect(
      renderRunTitle("Triage: {{ticketTitle}}", { ticketTitle: "Login is broken" }, "Triage"),
    ).toBe("Triage: Login is broken");
  });

  it("falls back to the definition name with no template", () => {
    expect(renderRunTitle(null, { ticketTitle: "x" }, "Linear triage")).toBe("Linear triage");
    expect(renderRunTitle("   ", {}, "Linear triage")).toBe("Linear triage");
  });

  it("drops placeholders the firing didn't carry instead of showing braces", () => {
    expect(renderRunTitle("{{identifier}} {{ticketTitle}}", { ticketTitle: "Bug" }, "n")).toBe(
      "Bug",
    );
    expect(renderRunTitle("{{ticketTitle}}", undefined, "Linear triage")).toBe("Linear triage");
  });

  it("keeps {{#if}} blocks and collapses a multi-line value to one line", () => {
    expect(
      renderRunTitle(
        "{{#if identifier}}[{{identifier}}] {{/if}}{{title}}",
        { identifier: "ENG-1", title: "Two\nlines" },
        "n",
      ),
    ).toBe("[ENG-1] Two lines");
  });

  it("caps a long title", () => {
    const title = renderRunTitle("{{t}}", { t: "x".repeat(500) }, "n");
    expect(title.length).toBe(200);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("renderTemplateString", () => {
  it("substitutes {{param}} placeholders", () => {
    const result = renderTemplateString("Hello {{name}}!", { name: "World" });
    expect(result).toBe("Hello World!");
  });

  it("substitutes multiple and repeated placeholders", () => {
    const result = renderTemplateString("{{a}} and {{b}} and {{a}}", { a: "1", b: "2" });
    expect(result).toBe("1 and 2 and 1");
  });

  it("tolerates whitespace around placeholder names", () => {
    expect(renderTemplateString("{{ name }}", { name: "x" })).toBe("x");
  });

  it("leaves unknown placeholders intact", () => {
    expect(renderTemplateString("Hi {{missing}}", { name: "x" })).toBe("Hi {{missing}}");
  });

  it("renders {{#if param}}...{{/if}} when param is truthy", () => {
    expect(renderTemplateString("a{{#if flag}} mid {{/if}}b", { flag: true })).toBe("a mid b");
  });

  it("drops {{#if}} body when param is falsy", () => {
    expect(renderTemplateString("a{{#if flag}} mid {{/if}}b", { flag: false })).toBe("ab");
  });

  it("drops {{#if}} body when param is missing", () => {
    expect(renderTemplateString("a{{#if flag}} mid {{/if}}b", {})).toBe("ab");
  });

  it("renders {{#if}} with nested {{param}} substitution", () => {
    expect(
      renderTemplateString("{{#if has_name}}Hello {{name}}{{/if}}", {
        has_name: true,
        name: "Ada",
      }),
    ).toBe("Hello Ada");
  });

  it("handles non-string params by coercing to string", () => {
    expect(renderTemplateString("count={{n}}", { n: 42 })).toBe("count=42");
  });

  it("treats null/undefined params as empty string", () => {
    expect(renderTemplateString("x={{v}}y", { v: null })).toBe("x=y");
  });
});

describe("prompt-template-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getPromptTemplate", () => {
    /** The default rows a lookup returns (the workspace's and the deployment's). */
    const defaults = (rows: Array<Record<string, unknown>>) => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }),
      });
    };

    it("returns the workspace's repo override, looked up in that workspace", async () => {
      vi.mocked(getRepoByUrl).mockResolvedValue({
        id: "repo-1",
        promptTemplateOverride: "Custom prompt",
        autoMerge: true,
        cautiousMode: false,
      } as any);

      const result = await getPromptTemplate("https://github.com/o/r.git", { workspaceId: "ws-1" });
      expect(result.template).toBe("Custom prompt");
      expect(result.autoMerge).toBe(true);
      expect(getRepoByUrl).toHaveBeenCalledWith("https://github.com/o/r", "ws-1");
    });

    it("uses the repo row the caller loaded instead of looking one up", async () => {
      defaults([]);
      const repo = {
        id: "r",
        promptTemplateOverride: "Mine",
        autoMerge: false,
        cautiousMode: true,
      };
      const result = await getPromptTemplate("https://github.com/o/r", {
        workspaceId: "ws-1",
        repo,
      });
      expect(result).toMatchObject({ template: "Mine", autoMerge: false, cautiousMode: true });
      expect(getRepoByUrl).not.toHaveBeenCalled();
    });

    it("prefers the workspace's default over the deployment's, with the repo's autoMerge", async () => {
      vi.mocked(getRepoByUrl).mockResolvedValue({
        id: "repo-1",
        promptTemplateOverride: null,
        autoMerge: true,
        cautiousMode: false,
      } as any);
      defaults([
        { id: "pt-dep", workspaceId: null, template: "Deployment template", autoMerge: false },
        { id: "pt-ws", workspaceId: "ws-1", template: "Workspace template", autoMerge: false },
      ]);

      const result = await getPromptTemplate("https://github.com/o/r", { workspaceId: "ws-1" });
      expect(result.template).toBe("Workspace template");
      expect(result.autoMerge).toBe(true); // Uses repo's autoMerge
    });

    it("falls back to the deployment's default when the workspace has none", async () => {
      vi.mocked(getRepoByUrl).mockResolvedValue(null);
      defaults([{ id: "pt-dep", workspaceId: null, template: "Deployment", autoMerge: false }]);
      const result = await getPromptTemplate("https://github.com/o/r", { workspaceId: "ws-2" });
      expect(result.template).toBe("Deployment");
    });

    it("never takes another workspace's default", async () => {
      vi.mocked(getRepoByUrl).mockResolvedValue(null);
      defaults([{ id: "pt-other", workspaceId: "ws-other", template: "Theirs", autoMerge: true }]);
      const result = await getPromptTemplate("https://github.com/o/r", { workspaceId: "ws-1" });
      expect(result.id).toBe("builtin");
    });

    it("falls back to hardcoded default when no global template", async () => {
      vi.mocked(getRepoByUrl).mockResolvedValue(null);
      defaults([]);

      const result = await getPromptTemplate("https://github.com/o/r", { workspaceId: "ws-1" });
      expect(result.id).toBe("builtin");
      expect(result.template).toBeDefined();
      expect(result.autoMerge).toBe(false);
    });

    it("returns global default when no repoUrl provided", async () => {
      defaults([{ id: "pt-1", workspaceId: null, template: "Default", autoMerge: false }]);

      const result = await getPromptTemplate(undefined, { workspaceId: null });
      expect(result.template).toBe("Default");
    });
  });

  describe("saveDefaultPromptTemplate", () => {
    it("updates existing default template", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "pt-1" }]),
        }),
      });

      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      await saveDefaultPromptTemplate("New template", true, "ws-1");
      expect(db.update).toHaveBeenCalled();
    });

    it("inserts the workspace's default when it has none", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      let capturedValues: any;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedValues = vals;
          return Promise.resolve(undefined);
        }),
      });

      await saveDefaultPromptTemplate("New template", false, "ws-1");
      expect(db.insert).toHaveBeenCalled();
      expect(capturedValues).toMatchObject({ isDefault: true, workspaceId: "ws-1" });
    });
  });

  describe("saveRepoPromptTemplate", () => {
    it("updates existing repo template", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "pt-1" }]),
        }),
      });

      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      await saveRepoPromptTemplate("https://github.com/o/r", "Template", true, "ws-1");
      expect(db.update).toHaveBeenCalled();
    });

    it("inserts new repo template when none exists", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      let capturedValues: any;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedValues = vals;
          return Promise.resolve(undefined);
        }),
      });

      await saveRepoPromptTemplate("https://github.com/o/r.git", "Template", false, "ws-1");

      expect(db.insert).toHaveBeenCalled();
      // URL should be normalized, and the row is the workspace's.
      expect(capturedValues.repoUrl).toBe("https://github.com/o/r");
      expect(capturedValues.workspaceId).toBe("ws-1");
    });
  });

  describe("listPromptTemplates", () => {
    it("returns all prompt templates", async () => {
      const templates = [{ id: "pt-1" }, { id: "pt-2" }];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockResolvedValue(templates),
      });

      const result = await listPromptTemplates();
      expect(result).toEqual(templates);
    });
  });
});

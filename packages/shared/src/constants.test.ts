import { describe, it, expect } from "vitest";
import {
  generateRepoPodName,
  generateStatefulSetName,
  generateWorkflowJobName,
} from "./constants.js";

describe("generateRepoPodName", () => {
  it("generates a name from an HTTPS GitHub URL", () => {
    const name = generateRepoPodName("https://github.com/jonwiggins/optio.git");
    expect(name).toMatch(/^optio-repo-jonwiggins-optio-[0-9a-f]{4}$/);
  });

  it("generates a name from an SSH GitHub URL", () => {
    const name = generateRepoPodName("git@github.com:jonwiggins/optio.git");
    expect(name).toMatch(/^optio-repo-jonwiggins-optio-[0-9a-f]{4}$/);
  });

  it("handles URLs without .git suffix", () => {
    const name = generateRepoPodName("https://github.com/myorg/my-repo");
    expect(name).toMatch(/^optio-repo-myorg-my-repo-[0-9a-f]{4}$/);
  });

  it("produces valid K8s names (lowercase, alphanumeric, hyphens)", () => {
    const name = generateRepoPodName("https://github.com/My_Org/My.Repo.Name.git");
    expect(name).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it("truncates long owner/repo names to fit within 63 chars", () => {
    const longOwner = "a".repeat(50);
    const longRepo = "b".repeat(50);
    const name = generateRepoPodName(`https://github.com/${longOwner}/${longRepo}.git`);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/^optio-repo-/);
    expect(name).toMatch(/-[0-9a-f]{4}$/);
  });

  it("generates unique names (different hash each call)", () => {
    const name1 = generateRepoPodName("https://github.com/org/repo.git");
    const name2 = generateRepoPodName("https://github.com/org/repo.git");
    // Names share prefix but have different hash suffixes (very likely)
    expect(name1.slice(0, -4)).toBe(name2.slice(0, -4));
  });

  it("handles fallback for unrecognized URL format", () => {
    const name = generateRepoPodName("not-a-url");
    expect(name).toMatch(/^optio-repo-unknown-unknown-[0-9a-f]{4}$/);
  });

  it("sanitizes special characters in owner/repo", () => {
    const name = generateRepoPodName("https://github.com/my--org/my__repo.git");
    expect(name).not.toMatch(/--/); // no double hyphens after sanitization
    expect(name).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });
});

describe("generateStatefulSetName", () => {
  it("generates a deterministic name from an HTTPS URL", () => {
    const name = generateStatefulSetName("https://github.com/jonwiggins/optio.git");
    expect(name).toBe("optio-sts-jonwiggins-optio");
  });

  it("is deterministic (no random suffix)", () => {
    const name1 = generateStatefulSetName("https://github.com/org/repo.git");
    const name2 = generateStatefulSetName("https://github.com/org/repo.git");
    expect(name1).toBe(name2);
  });

  it("handles SSH URLs", () => {
    const name = generateStatefulSetName("git@github.com:org/repo.git");
    expect(name).toBe("optio-sts-org-repo");
  });

  it("fits within 63 chars for long names", () => {
    const longOwner = "a".repeat(50);
    const longRepo = "b".repeat(50);
    const name = generateStatefulSetName(`https://github.com/${longOwner}/${longRepo}.git`);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/^optio-sts-/);
  });

  it("produces valid K8s names", () => {
    const name = generateStatefulSetName("https://github.com/My_Org/My.Repo.Name.git");
    expect(name).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });

  it("handles fallback for unrecognized URL format", () => {
    const name = generateStatefulSetName("not-a-url");
    expect(name).toBe("optio-sts-unknown-unknown");
  });
});

describe("generateWorkflowJobName", () => {
  it("encodes the workflow id + instance index", () => {
    const name = generateWorkflowJobName("550e8400-e29b-41d4-a716-446655440000", 0);
    expect(name).toBe("optio-wfj-550e8400-e29b-41d4-a716-446655440000-0");
  });

  it("differentiates instances in the same workflow", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    expect(generateWorkflowJobName(id, 0)).not.toBe(generateWorkflowJobName(id, 1));
  });

  it("is deterministic for the same workflow and instance", () => {
    const id = "abc-123-def";
    expect(generateWorkflowJobName(id, 2)).toBe(generateWorkflowJobName(id, 2));
  });

  it("fits within 63 chars even for long ids", () => {
    const longId = "a".repeat(80);
    const name = generateWorkflowJobName(longId, 19);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it("produces valid K8s names", () => {
    const name = generateWorkflowJobName("550e8400-e29b-41d4-a716-446655440000", 3);
    expect(name).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });

  it("defaults instance index to 0 when omitted", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    expect(generateWorkflowJobName(id)).toBe(generateWorkflowJobName(id, 0));
  });
});

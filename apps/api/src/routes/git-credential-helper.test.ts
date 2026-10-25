/**
 * scripts/optio-git-credential — the helper git calls in a repo pod — run
 * with bash against a stand-in curl that answers as the API would.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HELPER = resolve(import.meta.dirname, "../../../../scripts/optio-git-credential");
const hasTools = ["jq", "openssl"].every(
  (tool) => spawnSync("bash", ["-c", `command -v ${tool}`]).status === 0,
);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "git-credential-helper-"));
  // curl: record the URL asked for, answer with $FAKE_REPLY.
  writeFileSync(
    join(dir, "curl"),
    `#!/bin/bash\nfor a in "$@"; do last="$a"; done\necho "$last" >> "${dir}/asked"\nprintf '%s' "$FAKE_REPLY"\n`,
  );
  chmodSync(join(dir, "curl"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function helper(host: string, reply: unknown, env: Record<string, string> = {}): string {
  return execFileSync("bash", [HELPER, "get"], {
    input: `protocol=https\nhost=${host}\n\n`,
    encoding: "utf-8",
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      OPTIO_GIT_CREDENTIAL_URL: "http://optio-api:4000/api/internal/git-credentials?scope=s",
      OPTIO_CREDENTIAL_SECRET: "key",
      FAKE_REPLY: JSON.stringify(reply),
      ...env,
    },
  });
}

const asked = () => readFileSync(join(dir, "asked"), "utf-8").trim().split("\n");

describe.skipIf(!hasTools)("optio-git-credential", () => {
  it("gives a GitLab host the token Optio answers for it, as oauth2", () => {
    const out = helper("git.example.test:8443", { token: "glpat-owner", username: "oauth2" });
    expect(out).toContain("host=git.example.test:8443\nusername=oauth2\npassword=glpat-owner");
    expect(asked()).toEqual([
      "http://optio-api:4000/api/internal/git-credentials?scope=s&host=git.example.test%3A8443",
    ]);
  });

  it("never hands another host an answer without GitLab's user: an older API's GitHub token", () => {
    expect(helper("evil.example", { token: "ghs-installation" })).toBe("");
    // With the pod's own GITLAB_TOKEN for a named GitLab, that one instead.
    const out = helper(
      "git.example.test",
      { token: "ghs-installation" },
      { GITLAB_TOKEN: "glpat-pod", GITLAB_HOSTS: "git.example.test" },
    );
    expect(out).toContain("username=oauth2\npassword=glpat-pod");
    expect(out).not.toContain("ghs-installation");
  });

  it("asks github.com's token the way it always has", () => {
    const out = helper("github.com", { token: "ghs-installation" });
    expect(out).toBe(
      "protocol=https\nhost=github.com\nusername=x-access-token\npassword=ghs-installation\n",
    );
    expect(asked()).toEqual(["http://optio-api:4000/api/internal/git-credentials?scope=s"]);
  });
});

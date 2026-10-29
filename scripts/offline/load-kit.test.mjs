import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("./load-kit.sh", import.meta.url)).replaceAll("\\", "/");

for (const args of [
  [],
  ["--dry-run"],
  ["--username", "operator", "--password-stdin"],
  ["--dry-run", "--tool", "crane"],
]) {
  test(`rejects a changed executable before it runs: ${args.join(" ") || "default"}`, () => {
    const kit = mkdtempSync(join(tmpdir(), "optio-kit-integrity-"));
    try {
      const offline = join(kit, "offline");
      mkdirSync(join(offline, "bin"), { recursive: true });
      const marker = join(kit, "executed").replaceAll("\\", "/");
      const original = "#!/usr/bin/env bash\nexit 0\n";
      writeFileSync(join(offline, "images.txt"), "");
      writeFileSync(join(offline, "pnpm-offline-test.tgz"), "unused");
      writeFileSync(
        join(offline, "SHA256SUMS"),
        `${createHash("sha256").update(original).digest("hex")}  bin/crane\n`,
      );
      writeFileSync(
        join(offline, "bin/crane"),
        `#!/usr/bin/env bash\nprintf executed > '${marker}'\nexit 0\n`,
        { mode: 0o755 },
      );
      const result = spawnSync(
        "bash",
        [
          script,
          "--kit",
          kit.replaceAll("\\", "/"),
          "--registry",
          "registry.example/optio",
          ...args,
        ],
        {
          input: "dummy-registry-password\n",
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /kit does not match/);
      assert.equal(existsSync(marker), false, "unverified crane must never execute");
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /dummy-registry-password/);
    } finally {
      rmSync(kit, { recursive: true, force: true });
    }
  });
}

// Every tracked path must be one Windows can create: a clone or pull there
// stops with "error: invalid path" at the first file it can't (issue #804,
// `packages/shared/src/utils/nul.ts`). Windows reserves the device names
// below as a file or directory name with any extension, in any case, and
// refuses the listed characters and a trailing dot or space.
//
// Run with: node --test scripts/portable-paths.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RESERVED_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;

const FORBIDDEN_CHARACTER = /[<>:"|?*\\\u0000-\u001f]/;
const TRAILING_DOT_OR_SPACE = /[. ]$/;

/** Why Windows can't create `file`, or null when it can. */
function windowsRefusal(file) {
  for (const segment of file.split("/")) {
    if (RESERVED_DEVICE.test(segment)) return `"${segment}" is a reserved device name`;
    if (FORBIDDEN_CHARACTER.test(segment)) return `"${segment}" has a forbidden character`;
    if (TRAILING_DOT_OR_SPACE.test(segment)) return `"${segment}" ends in a dot or a space`;
  }
  return null;
}

test("the rule knows what Windows refuses", () => {
  for (const bad of [
    "packages/shared/src/utils/nul.ts",
    "packages/shared/src/utils/nul.test.ts",
    "NUL",
    "docs/Con.md",
    "aux/readme.md",
    "a/com1.txt",
    "a/lpt9",
    "a/what?.md",
    "a/b:c",
    "a/trailing.",
    "a/trailing ",
  ]) {
    assert.notEqual(windowsRefusal(bad), null, bad);
  }
  for (const good of [
    "packages/shared/src/utils/nul-bytes.ts",
    "docs/console.md",
    "a/null.ts",
    "a/auxiliary.ts",
    "a/com10.txt",
    "apps/web/src/app/work/[id]/page.tsx",
    "apps/web/src/app/(auth)/login/page.tsx",
    ".github/workflows/ci.yml",
  ]) {
    assert.equal(windowsRefusal(good), null, good);
  }
});

test("every tracked path can be checked out on Windows", () => {
  const files = execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
  assert.ok(files.length > 0, "git ls-files listed nothing");
  const refused = files.flatMap((file) => {
    const why = windowsRefusal(file);
    return why ? [`${file}: ${why}`] : [];
  });
  assert.deepEqual(refused, []);
});

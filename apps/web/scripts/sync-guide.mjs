#!/usr/bin/env node
// Copies the people's guide (docs/using-optio.md) into the web app, which
// shows it at /help: the web image is built from apps/web and
// packages/shared alone, so the guide travels as a module.
//
//   node apps/web/scripts/sync-guide.mjs     (from anywhere in the repo)
//
// Run it after changing docs/using-optio.md (prettier the .md first: the
// commit hook would format it after the copy). apps/web/src/content/
// using-optio-guide.test.ts fails while the two differ.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../../docs/using-optio.md");
const target = resolve(here, "../src/content/using-optio-guide.ts");

// Quoted as prettier quotes them (double, or single when that escapes less),
// so the commit hook leaves the file as written.
const quote = (l) => {
  const doubles = l.split('"').length - 1;
  const singles = l.split("'").length - 1;
  if (doubles <= singles) return JSON.stringify(l);
  const inner = JSON.stringify(l).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'");
  return `'${inner}'`;
};
const lines = readFileSync(source, "utf8").replace(/\r\n/g, "\n").split("\n");
const body = lines.map((l) => `  ${quote(l)},`).join("\n");
writeFileSync(
  target,
  `// Generated from docs/using-optio.md by apps/web/scripts/sync-guide.mjs: don't edit by hand.
// The guide for the people who use Optio, shown in the app at /help.
export const USING_OPTIO_GUIDE: string = [
${body}
].join("\\n");
`,
);
console.log(`wrote ${target} (${lines.length} lines)`);

/**
 * `optio apply -f FILE|DIR...` — make the workspace match the manifests
 * (docs/config-as-code.md); `optio diff` is the same with `--dry-run`. A CLI
 * apply is a plain upsert: it manages nothing and never prunes — the
 * configuration directory (OPTIO_CONFIG_DIR) does that.
 */
import { Command } from "commander";
import type { ConfigApplyResult, ConfigPlanItem } from "@optio/shared";
import { buildClient } from "../api/client.js";
import { bold, cyan, dim, green, red, yellow } from "../output/colors.js";
import { isJsonMode, outputJson } from "../output/formatter.js";
import { friendlyError } from "../utils/errors.js";
import { readManifests } from "../manifests/read.js";

const ACTION_COLOR: Record<ConfigPlanItem["action"], (s: string) => string> = {
  create: green,
  update: cyan,
  unchanged: dim,
  adopt: cyan,
  replace: yellow,
  prune: red,
  error: red,
};

function detailOf(item: ConfigPlanItem): string {
  if (item.action === "error") return item.message ?? "";
  const parts: string[] = [];
  if (item.changes?.length) parts.push(item.changes.join(", "));
  if (item.reverted) parts.push("(a UI edit, put back)");
  if (item.message) parts.push(item.message);
  return parts.join(" ");
}

/** The result as `kubectl apply` would print it, one line per manifest. */
export function printApplyResult(
  result: ConfigApplyResult,
  write = (s: string) => process.stdout.write(s),
): void {
  const items = [...result.items].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
  );
  const width = Math.max(9, ...items.map((i) => i.action.length));
  for (const item of items) {
    const color = ACTION_COLOR[item.action] ?? ((s: string) => s);
    const detail = detailOf(item);
    write(
      `${color(item.action.padEnd(width))}  ${bold(item.kind)}/${item.name}` +
        `${dim(`  ${item.path}`)}${detail ? `  ${dim(detail)}` : ""}\n`,
    );
  }
  const s = result.summary;
  const counts = [
    s.created && `${s.created} created`,
    s.updated && `${s.updated} updated${s.reverted ? ` (${s.reverted} UI edits put back)` : ""}`,
    s.adopted && `${s.adopted} adopted`,
    s.replaced && `${s.replaced} replaced`,
    s.pruned && `${s.pruned} pruned`,
    s.unchanged && `${s.unchanged} unchanged`,
    s.errors && red(`${s.errors} errors`),
  ].filter(Boolean);
  write(`\n${result.dryRun ? "Plan" : "Applied"}: ${counts.join(", ") || "nothing"}\n`);
}

async function run(files: string[], opts: { dryRun?: boolean }, cmd: Command): Promise<void> {
  try {
    if (!files.length) {
      process.stderr.write("Pass the manifests to apply: optio apply -f optio/\n");
      process.exitCode = 2;
      return;
    }
    const read = await readManifests(files);
    const client = buildClient(cmd.optsWithGlobals());
    const result = await client.post<ConfigApplyResult>("/api/config/apply", {
      manifests: read.manifests,
      dryRun: opts.dryRun ?? false,
    });
    // Files that didn't parse never reached the server; they count as errors here.
    for (const p of read.problems) {
      result.items.push({
        kind: "?",
        name: "?",
        path: p.path,
        action: "error",
        message: p.message,
      });
      result.summary.errors++;
    }
    if (isJsonMode()) outputJson(result);
    else printApplyResult(result);
    if (result.summary.errors > 0) process.exitCode = 1;
  } catch (err) {
    friendlyError(err);
  }
}

export const applyCommand = new Command("apply")
  .description("Apply manifests (YAML files or directories) to the current workspace")
  .requiredOption("-f, --file <path...>", "A manifest file or a directory of them")
  .option("--dry-run", "Show what would change without changing anything")
  .action((opts: { file: string[]; dryRun?: boolean }, cmd) => run(opts.file, opts, cmd));

export const diffCommand = new Command("diff")
  .description("Show what `optio apply` would change (a dry run)")
  .requiredOption("-f, --file <path...>", "A manifest file or a directory of them")
  .action((opts: { file: string[] }, cmd) => run(opts.file, { dryRun: true }, cmd));

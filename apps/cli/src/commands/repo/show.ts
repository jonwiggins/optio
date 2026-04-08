import { Command } from "commander";
import { buildClient } from "../../api/client.js";
import { bold, dim } from "../../output/colors.js";
import { isJsonMode, outputJson } from "../../output/formatter.js";
import { friendlyError } from "../../utils/errors.js";

export const repoShowCommand = new Command("show")
  .description("Show repository details")
  .argument("<id>", "Repo ID")
  .action(async (id, _opts, cmd) => {
    try {
      const globals = cmd.optsWithGlobals();
      const client = buildClient(globals);
      const data = await client.get<{ repo: Record<string, string> }>(`/api/repos/${id}`);

      if (isJsonMode()) {
        outputJson(data.repo);
        return;
      }

      const r = data.repo;
      process.stdout.write(bold(r.fullName ?? r.repoUrl) + "\n");
      process.stdout.write(dim("  ID:          ") + r.id + "\n");
      process.stdout.write(dim("  URL:         ") + r.repoUrl + "\n");
      process.stdout.write(dim("  Branch:      ") + (r.defaultBranch ?? "main") + "\n");
      process.stdout.write(dim("  Preset:      ") + (r.imagePreset ?? "auto") + "\n");
      process.stdout.write(dim("  Concurrency: ") + (r.maxConcurrentTasks ?? "2") + "\n");
    } catch (err) {
      friendlyError(err);
    }
  });

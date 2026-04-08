import { Command } from "commander";
import { buildClient } from "../../api/client.js";
import { green } from "../../output/colors.js";
import { isJsonMode, outputJson } from "../../output/formatter.js";
import { friendlyError } from "../../utils/errors.js";

export const repoAddCommand = new Command("add")
  .description("Add a repository")
  .argument("<url>", "Repository URL")
  .option("--preset <preset>", "Image preset (node, python, go, rust, full)")
  .option("--branch <branch>", "Default branch")
  .action(async (url, opts, cmd) => {
    try {
      const globals = cmd.optsWithGlobals();
      const client = buildClient(globals);
      const body: Record<string, unknown> = { repoUrl: url };
      if (opts.preset) body.imagePreset = opts.preset;
      if (opts.branch) body.defaultBranch = opts.branch;

      const data = await client.post<{ repo: Record<string, unknown> }>("/api/repos", body);

      if (isJsonMode()) {
        outputJson(data.repo);
      } else {
        process.stdout.write(green(`Added repo ${data.repo.fullName ?? url}`) + "\n");
      }
    } catch (err) {
      friendlyError(err);
    }
  });

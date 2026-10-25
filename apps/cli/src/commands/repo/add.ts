import { Command, Option } from "commander";
import { buildClient } from "../../api/client.js";
import { green } from "../../output/colors.js";
import { isJsonMode, outputJson } from "../../output/formatter.js";
import { friendlyError } from "../../utils/errors.js";
import { repoFullName } from "../../output/repo-label.js";

const GIT_PLATFORMS = ["github", "gitlab", "codecommit"] as const;

export const repoAddCommand = new Command("add")
  .description("Add a repository")
  .argument("<url>", "Repository URL")
  .option("--preset <preset>", "Image preset (node, python, go, rust, full)")
  .option("--branch <branch>", "Default branch")
  .addOption(
    new Option(
      "--platform <platform>",
      "Git platform, for a host Optio can't tell from the URL (a self-hosted GitLab)",
    ).choices(GIT_PLATFORMS),
  )
  .action(async (url, opts, cmd) => {
    try {
      const globals = cmd.optsWithGlobals();
      const client = buildClient(globals);
      const platform = opts.platform as (typeof GIT_PLATFORMS)[number] | undefined;
      const body: Record<string, unknown> = {
        repoUrl: url,
        fullName: repoFullName(url, platform),
      };
      if (opts.preset) body.imagePreset = opts.preset;
      if (opts.branch) body.defaultBranch = opts.branch;
      if (platform) body.gitPlatform = platform;

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

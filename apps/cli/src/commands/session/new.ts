import { Command } from "commander";
import { buildClient } from "../../api/client.js";
import { green } from "../../output/colors.js";
import { isJsonMode, outputJson } from "../../output/formatter.js";
import { friendlyError } from "../../utils/errors.js";

export const sessionNewCommand = new Command("new")
  .description("Create a new interactive session")
  .argument("<repo>", "Repository URL or ID")
  .option("--branch <branch>", "Branch name")
  .action(async (repo, opts, cmd) => {
    try {
      const globals = cmd.optsWithGlobals();
      const client = buildClient(globals);
      const body: Record<string, unknown> = { repoUrl: repo };
      if (opts.branch) body.branch = opts.branch;

      const data = await client.post<{ session: Record<string, unknown> }>("/api/sessions", body);

      if (isJsonMode()) {
        outputJson(data.session);
      } else {
        process.stdout.write(green(`Session ${data.session.id} created`) + "\n");
      }
    } catch (err) {
      friendlyError(err);
    }
  });

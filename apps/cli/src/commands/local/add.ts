import { Command } from "commander";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { red, green, dim } from "../../output/colors.js";
import { isJsonMode, outputJson } from "../../output/formatter.js";
import { loadLocalConfig, saveLocalConfig } from "../../config/local-store.js";
import { detectRepoUrl } from "../../local/git-remote.js";
import { friendlyError } from "../../utils/errors.js";

export const localAddCommand = new Command("add")
  .description("Add a directory to the Optio Local allowlist")
  .argument("<dir>", "Directory to expose to the daemon")
  .action(async (dir: string, _opts, cmd) => {
    try {
      void cmd;
      let path: string;
      try {
        path = realpathSync(resolve(dir));
      } catch {
        process.stderr.write(red(`Error: directory does not exist: ${dir}`) + "\n");
        process.exit(1);
      }
      if (!statSync(path).isDirectory()) {
        process.stderr.write(red(`Error: not a directory: ${path}`) + "\n");
        process.exit(1);
      }

      const repoUrl = await detectRepoUrl(path);
      const config = loadLocalConfig();
      const existing = config.dirs.find((d) => d.path === path);
      if (existing) {
        if (repoUrl) existing.repoUrl = repoUrl;
        else delete existing.repoUrl;
      } else {
        config.dirs.push(repoUrl ? { path, repoUrl } : { path });
      }
      saveLocalConfig(config);

      if (isJsonMode()) {
        outputJson({ path, repoUrl: repoUrl ?? null, alreadyAdded: Boolean(existing) });
        return;
      }
      const suffix = repoUrl ? ` ${dim(`(${repoUrl})`)}` : "";
      process.stdout.write(green(existing ? `Updated ${path}` : `Added ${path}`) + suffix + "\n");
      if (!existing) {
        process.stdout.write(
          dim("Restart `optio local up` (or wait for its next reconnect) to advertise it.") + "\n",
        );
      }
    } catch (err) {
      friendlyError(err);
    }
  });

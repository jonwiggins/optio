import { Command } from "commander";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { red, green } from "../../output/colors.js";
import { isJsonMode, outputJson } from "../../output/formatter.js";
import { loadLocalConfig, saveLocalConfig } from "../../config/local-store.js";
import { friendlyError } from "../../utils/errors.js";

export const localRemoveCommand = new Command("remove")
  .description("Remove a directory from the Optio Local allowlist")
  .argument("<dir>", "Directory to remove")
  .action(async (dir: string, _opts, cmd) => {
    try {
      void cmd;
      const raw = resolve(dir);
      let resolved = raw;
      try {
        resolved = realpathSync(raw);
      } catch {
        // dir may have been deleted — still allow removing its entry
      }

      const config = loadLocalConfig();
      const before = config.dirs.length;
      config.dirs = config.dirs.filter((d) => d.path !== resolved && d.path !== raw);
      if (config.dirs.length === before) {
        process.stderr.write(red(`Error: ${raw} is not in the allowlist`) + "\n");
        process.exit(1);
      }
      saveLocalConfig(config);

      if (isJsonMode()) {
        outputJson({ path: resolved, removed: true });
        return;
      }
      process.stdout.write(green(`Removed ${resolved}`) + "\n");
    } catch (err) {
      friendlyError(err);
    }
  });

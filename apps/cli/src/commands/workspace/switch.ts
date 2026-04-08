import { Command } from "commander";
import { buildClient } from "../../api/client.js";
import { loadConfig, saveConfig } from "../../config/config-store.js";
import { green } from "../../output/colors.js";
import { isJsonMode, outputJson } from "../../output/formatter.js";
import { friendlyError } from "../../utils/errors.js";

export const workspaceSwitchCommand = new Command("switch")
  .description("Switch active workspace")
  .argument("<slug>", "Workspace slug")
  .action(async (slug, _opts, cmd) => {
    try {
      const globals = cmd.optsWithGlobals();
      const client = buildClient(globals);

      // Find workspace by slug
      const data = await client.get<{ workspaces: Record<string, string>[] }>("/api/workspaces");
      const ws = data.workspaces.find((w) => w.slug === slug);
      if (!ws) {
        process.stderr.write(`Workspace "${slug}" not found.\n`);
        process.exit(1);
      }

      // Update local config
      const config = loadConfig();
      if (config.currentHost && config.hosts[config.currentHost]) {
        config.hosts[config.currentHost].workspaceId = ws.id;
        config.hosts[config.currentHost].workspaceSlug = ws.slug;
        saveConfig(config);
      }

      if (isJsonMode()) {
        outputJson({ workspace: ws });
      } else {
        process.stdout.write(green(`Switched to workspace "${slug}"`) + "\n");
      }
    } catch (err) {
      friendlyError(err);
    }
  });

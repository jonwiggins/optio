import { Command } from "commander";
import { loadConfig, saveConfig } from "../config/config-store.js";
import { isJsonMode, outputJson } from "../output/formatter.js";

export const configCommand = new Command("config").description("Manage CLI configuration");

configCommand
  .command("show")
  .description("Show current configuration")
  .action(() => {
    const config = loadConfig();
    if (isJsonMode()) {
      outputJson(config);
    } else {
      process.stdout.write(JSON.stringify(config, null, 2) + "\n");
    }
  });

configCommand
  .command("set <key> <value>")
  .description("Set a configuration value")
  .action((key, value) => {
    const config = loadConfig();
    if (key === "currentHost") {
      config.currentHost = value;
    }
    saveConfig(config);
    process.stdout.write(`Set ${key} = ${value}\n`);
  });

configCommand
  .command("get <key>")
  .description("Get a configuration value")
  .action((key) => {
    const config = loadConfig();
    const value = key === "currentHost" ? config.currentHost : undefined;
    if (isJsonMode()) {
      outputJson({ [key]: value });
    } else {
      process.stdout.write((value ?? "") + "\n");
    }
  });

/** `optio schema` — the JSON Schema of a manifest, for editors and CI. */
import { Command } from "commander";
import { buildClient } from "../api/client.js";
import { friendlyError } from "../utils/errors.js";

export const schemaCommand = new Command("schema")
  .description("Print the JSON Schema that manifests validate against")
  .action(async (_opts, cmd) => {
    try {
      const client = buildClient(cmd.optsWithGlobals());
      const schema = await client.get<Record<string, unknown>>("/api/config/schema.json");
      process.stdout.write(JSON.stringify(schema, null, 2) + "\n");
    } catch (err) {
      friendlyError(err);
    }
  });

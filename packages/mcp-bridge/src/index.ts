import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseConfig } from "./bridge.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = parseConfig(process.env);
  } catch (err) {
    process.stderr.write(`mcp-bridge: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
  const server = createServer(cfg);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`mcp-bridge: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

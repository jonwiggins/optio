import { Command } from "commander";
import { buildClient } from "../../api/client.js";
import { connectWs } from "../../api/ws.js";
import { red, yellow } from "../../output/colors.js";
import { friendlyError } from "../../utils/errors.js";

export const sessionAttachCommand = new Command("attach")
  .description("Attach to an interactive session terminal")
  .argument("<id>", "Session ID")
  .action(async (id, _opts, cmd) => {
    try {
      const globals = cmd.optsWithGlobals();
      const client = buildClient(globals);

      // Verify session exists and is active
      const data = await client.get<{ session: Record<string, string> }>(`/api/sessions/${id}`);
      if (data.session.state !== "active") {
        process.stderr.write(red(`Session ${id} is ${data.session.state}, not active.`) + "\n");
        process.exit(1);
      }

      const wsUrl = client.getWsUrl(`/ws/sessions/${id}/terminal`);
      const token = client.getToken();

      // Enter raw mode
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();

      let detachBuf = 0; // track Ctrl-P Ctrl-Q sequence

      const ws = connectWs({
        url: wsUrl,
        token,
        onMessage: (data) => {
          process.stdout.write(data);
        },
        onClose: (code) => {
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
          }
          process.exit(code === 1000 ? 0 : 1);
        },
        onError: (err) => {
          process.stderr.write(red(`Connection error: ${err.message}`) + "\n");
        },
      });

      // Forward stdin to WebSocket
      process.stdin.on("data", (chunk: Buffer) => {
        for (const byte of chunk) {
          // Detach: Ctrl-P (0x10) followed by Ctrl-Q (0x11)
          if (byte === 0x10) {
            detachBuf = 1;
            continue;
          }
          if (detachBuf === 1 && byte === 0x11) {
            process.stderr.write(yellow("\nDetached from session.") + "\n");
            ws.close();
            if (process.stdin.isTTY) {
              process.stdin.setRawMode(false);
            }
            process.exit(0);
          }
          detachBuf = 0;
        }
        ws.send(chunk);
      });

      // Handle resize
      process.stdout.on("resize", () => {
        const { columns, rows } = process.stdout;
        ws.send(JSON.stringify({ type: "resize", cols: columns, rows }));
      });

      process.on("SIGINT", () => {
        // Forward Ctrl-C as raw byte
        ws.send(Buffer.from([0x03]));
      });
    } catch (err) {
      friendlyError(err);
    }
  });

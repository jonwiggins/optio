vi.mock("../remote-workspace-policy.js", () => ({ remoteWorkspacesEnabled: async () => true }));
/**
 * The boxd client against boxd itself. Skipped unless OPTIO_BOXD_LIVE=1 and
 * BOXD_API_KEY are set (BOXD_ORG, BOXD_REGION and OPTIO_BOXD_LIVE_PREFIX
 * optional); it makes one machine, runs the start script in it, hibernates,
 * wakes and deletes it.
 *
 *   OPTIO_BOXD_LIVE=1 BOXD_API_KEY=bxd_... pnpm --filter @optio/api exec \
 *     vitest run src/services/remote-workspaces/boxd.live.test.ts
 */
import { randomUUID } from "node:crypto";
import { Boxd } from "@boxd-sh/sdk";
import { describe, expect, it, vi } from "vitest";
import { BOXD_DEFAULT_URL, BoxdClient, splitRegion } from "./boxd.js";
import { startScriptEnv } from "./start-script.js";
import type { RemoteWorkspace } from "./types.js";

const live = process.env.OPTIO_BOXD_LIVE === "1" && !!process.env.BOXD_API_KEY;

async function until(
  client: BoxdClient,
  id: string,
  ok: (ws: RemoteWorkspace) => boolean,
): Promise<RemoteWorkspace> {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const ws = await client.workspace(id);
    if (ok(ws)) return ws;
    if (Date.now() > deadline) throw new Error(`${id} is still ${ws.status}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

describe.skipIf(!live)("boxd, live", () => {
  it("creates an isolated machine, starts the daemon's script in it, hibernates, wakes and deletes it", async () => {
    const client = new BoxdClient({
      url: process.env.BOXD_BASE_URL ?? BOXD_DEFAULT_URL,
      token: process.env.BOXD_API_KEY!,
      organizationId: process.env.BOXD_ORG ?? null,
    });
    const me = await client.whoami();
    expect(me.username).not.toBe(undefined);
    const { templates } = await client.templates();
    expect(templates[0].id).toBe("standard");

    const prefix = process.env.OPTIO_BOXD_LIVE_PREFIX ?? "optio-live-";
    const name = `${prefix}${randomUUID().slice(0, 6)}`;
    const bundle = {
      // Nothing answers here: the script starts, then fails to fetch the CLI, in the background.
      OPTIO_SERVER: "https://optio.invalid",
      OPTIO_TOKEN: `optio_pat_${randomUUID()}`,
      OPTIO_LOCAL_HOST_ID: randomUUID(),
    };
    const env = startScriptEnv({
      bundle,
      checkoutDir: "/home/boxd/repo",
      hostname: name,
      parameters: {},
    });
    const ws = await client.create({
      templateVersionId: "standard",
      name,
      declared: [],
      wanted: process.env.BOXD_REGION ? { region: process.env.BOXD_REGION } : {},
      bundle,
      checkoutDir: "/home/boxd/repo",
      env,
      ttlMs: 60 * 60_000,
    });
    console.warn(`created ${ws.name} (${ws.id})`);
    try {
      expect(splitRegion(ws.id).region).toBeTruthy();
      const running = await until(client, ws.id, (w) => w.ready);
      await client.runStartScript(running, env);
      // Detached: the script ran on, tried the (unreachable) server; the file
      // with the bundle is gone and no process carries the token.
      const sdk = new Boxd({
        apiKey: process.env.BOXD_API_KEY!,
        baseURL: process.env.BOXD_BASE_URL ?? BOXD_DEFAULT_URL,
        region: "",
      });
      try {
        const { region, rest } = splitRegion(ws.id);
        let seen = "";
        for (let i = 0; i < 20 && !seen.includes("optio.invalid"); i++) {
          await new Promise((r) => setTimeout(r, 1000));
          seen = (await sdk.machines.exec(rest, { command: "cat /tmp/optio-local.log", region }))
            .stdout;
        }
        expect(seen).toContain("optio.invalid");
        const left = await sdk.machines.exec(rest, {
          command: "ls /tmp/optio-pairing-* 2>/dev/null | wc -l; ps -eo args",
          region,
        });
        expect(left.stdout.split("\n")[0].trim()).toBe("0");
        expect(left.stdout).not.toContain(bundle.OPTIO_TOKEN);
      } finally {
        await sdk.close();
      }
      expect((await client.workspaces()).some((w) => w.id === ws.id)).toBe(true);

      expect(await client.stop(ws.id)).toBe("stopped");
      const asleep = await until(client, ws.id, (w) => w.status === "stopped");
      await client.start(asleep, {
        declared: [],
        wanted: {},
        bundle,
        checkoutDir: "",
        env,
        ttlMs: null,
      });
      const awake = await until(client, ws.id, (w) => w.ready);
      await client.runStartScript(awake, env);
    } finally {
      expect(await client.remove(ws.id)).toBe("deleted");
    }
    await expect(client.workspace(ws.id)).rejects.toMatchObject({ status: 404 });
  }, 600_000);
});

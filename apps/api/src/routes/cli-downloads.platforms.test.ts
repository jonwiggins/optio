import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { isPublicRoute } from "../plugins/auth.js";
import {
  cliBundlePath,
  cliDownloadRoutes,
  installPowerShellScript,
  installScript,
} from "./cli-downloads.js";

const VARS = [
  "OPTIO_CLI_TARBALL",
  "OPTIO_CLI_TARBALL_DARWIN",
  "OPTIO_CLI_TARBALL_WIN32",
  "PUBLIC_API_URL",
  "PUBLIC_URL",
] as const;

let dir: string;
let app: FastifyInstance;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const v of VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
  dir = await mkdtemp(path.join(tmpdir(), "optio-cli-platforms-"));
  // Nothing at any default path in a test run.
  process.env.OPTIO_CLI_TARBALL = path.join(dir, "none-linux.tgz");
  process.env.OPTIO_CLI_TARBALL_DARWIN = path.join(dir, "none-darwin.tgz");
  process.env.OPTIO_CLI_TARBALL_WIN32 = path.join(dir, "none-win32.tgz");
  app = await buildRouteTestApp(cliDownloadRoutes, { user: null });
});

afterEach(async () => {
  await app.close();
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
  await rm(dir, { recursive: true, force: true });
});

/** A bundle in the real layout whose dist/optio.js prints `label` for --version. */
async function fakeBundle(name: string, label: string): Promise<string> {
  const src = path.join(dir, `src-${name}`);
  await mkdir(path.join(src, "optio-cli", "dist"), { recursive: true });
  await writeFile(
    path.join(src, "optio-cli", "dist", "optio.js"),
    `console.log(process.argv.includes('--version') ? ${JSON.stringify(label)} : 'optio');\n`,
  );
  const tarball = path.join(dir, `${name}.tgz`);
  execFileSync("tar", ["czf", tarball, "-C", src, "optio-cli"]);
  return tarball;
}

/** Run `script` with sh, with a stand-in `uname` that says `os`. */
async function runInstaller(script: string, os: string, server: string, home: string) {
  const fakeBin = path.join(dir, `bin-${os}`);
  await mkdir(fakeBin, { recursive: true });
  await writeFile(path.join(fakeBin, "uname"), `#!/bin/sh\necho ${os}\n`);
  await chmod(path.join(fakeBin, "uname"), 0o755);
  await mkdir(home, { recursive: true });
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(
      "sh",
      ["-s"],
      { env: { PATH: `${fakeBin}:${process.env.PATH}`, HOME: home, OPTIO_SERVER: server } },
      (err, stdout, stderr) =>
        resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout, stderr }),
    );
    child.stdin!.end(script);
  });
}

describe("CLI bundles for macOS and Windows", () => {
  it("are public, with their installer and the list of bundles", () => {
    for (const route of [
      "/api/cli/install.ps1",
      "/api/cli/downloads",
      "/api/cli/optio-cli-darwin.tgz",
      "/api/cli/optio-cli-win32.tgz",
    ]) {
      expect(isPublicRoute(route, "GET")).toBe(true);
    }
  });

  it("live under /app/static by default, each movable by its own variable", () => {
    expect(cliBundlePath("linux", {})).toBe("/app/static/optio-cli.tgz");
    expect(cliBundlePath("darwin", {})).toBe("/app/static/optio-cli-darwin.tgz");
    expect(cliBundlePath("win32", {})).toBe("/app/static/optio-cli-win32.tgz");
    expect(cliBundlePath("darwin", { OPTIO_CLI_TARBALL_DARWIN: " /srv/mac.tgz " })).toBe(
      "/srv/mac.tgz",
    );
    expect(cliBundlePath("win32", { OPTIO_CLI_TARBALL: "/srv/linux.tgz" })).toBe(
      "/app/static/optio-cli-win32.tgz",
    );
  });

  it("lists only the bundles this deployment has", async () => {
    let res = await app.inject({ method: "GET", url: "/api/cli/downloads" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ bundles: { linux: false, darwin: false, win32: false } });

    process.env.OPTIO_CLI_TARBALL = await fakeBundle("linux", "1.0.0");
    process.env.OPTIO_CLI_TARBALL_WIN32 = await fakeBundle("win32", "1.0.0");
    // A directory where a bundle should be doesn't count.
    process.env.OPTIO_CLI_TARBALL_DARWIN = dir;
    res = await app.inject({ method: "GET", url: "/api/cli/downloads" });
    expect(res.json()).toEqual({ bundles: { linux: true, darwin: false, win32: true } });
  });

  it("serve each bundle, or a 404 that says how to build that one", async () => {
    let res = await app.inject({ method: "GET", url: "/api/cli/optio-cli-darwin.tgz" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("build-cli-tarball.sh --platform darwin");
    expect(res.json().error).toContain("OPTIO_CLI_TARBALL_DARWIN");

    process.env.OPTIO_CLI_TARBALL_WIN32 = await fakeBundle("win32", "1.0.0");
    res = await app.inject({ method: "GET", url: "/api/cli/optio-cli-win32.tgz" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/gzip");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="optio-cli-win32.tgz"');
  });

  it("install.sh installs the macOS bundle on macOS and the Linux one elsewhere", async () => {
    process.env.OPTIO_CLI_TARBALL = await fakeBundle("linux", "linux-build");
    process.env.OPTIO_CLI_TARBALL_DARWIN = await fakeBundle("darwin", "darwin-build");
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const script = installScript(address);

    const mac = await runInstaller(script, "Darwin", address, path.join(dir, "home-mac"));
    expect(mac.stderr).toBe("");
    expect(mac.stdout).toContain("Installed darwin-build");

    const linux = await runInstaller(script, "Linux", address, path.join(dir, "home-linux"));
    expect(linux.stdout).toContain("Installed linux-build");
  });

  it("install.sh sends a Windows shell (Git Bash, MSYS, Cygwin) to install.ps1", async () => {
    const res = await runInstaller(
      installScript("https://optio.example.com"),
      "MINGW64_NT-10.0-26100",
      "https://optio.example.com",
      path.join(dir, "home-win"),
    );
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("irm https://optio.example.com/api/cli/install.ps1 | iex");
    expect(res.stdout).not.toContain("Installed");
  });

  it("install.ps1 is served with the configured server, not the request Host", async () => {
    process.env.PUBLIC_API_URL = "https://configured.example.com";
    const res = await app.inject({
      method: "GET",
      url: "/api/cli/install.ps1",
      headers: { host: "attacker.example" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
    expect(res.body).toContain("$DefaultServer = 'https://configured.example.com'");
    expect(res.body).not.toContain("attacker.example");
  });

  it("install.ps1 refuses without a configured public URL", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/cli/install.ps1",
      headers: { host: "attacker.example" },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatch(/PUBLIC_API_URL/);
  });

  it("install.ps1 is safe to pipe into iex", () => {
    const ps = installPowerShellScript("https://optio.example.com");
    // A script block, so nothing is left in the caller's session.
    expect(ps).toMatch(/^& \{$/m);
    // `exit` in an iex'd script closes the user's window: errors throw.
    expect(ps).not.toMatch(/^\s*exit\b/m);
    // Windows' own tar, not a GNU tar earlier on PATH.
    expect(ps).toContain("Join-Path $env:SystemRoot 'System32\\tar.exe'");
    expect(ps).toContain('"$Server/api/cli/optio-cli-win32.tgz"');
    expect(ps).toContain("'node \"%~dp0..\\cli\\dist\\optio.js\" %*'");
    expect(ps).toContain("-lt 20");
  });
});

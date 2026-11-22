import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// A repo pod's init (scripts/repo-init.sh; images/dind-entrypoint.sh in front of it on a
// Docker-in-Docker pod) and the readiness marker a run waits for, /workspace/.ready.
//
// These run the checkout's own scripts as a container's entrypoint, in an agent image, on a
// /workspace volume that outlives the container the way a pod's per-ordinal volume outlives
// the pod. They need Docker and an agent image, so they run in CI's "Build Agent Image" job
// (OPTIO_REPO_INIT_TEST_IMAGE names the image it just built, and then nothing is skipped);
// elsewhere they use a local optio-base / optio-agent image and skip without one.

const root = fileURLToPath(new URL("../", import.meta.url));
const docker = (...args) => spawnSync("docker", args, { encoding: "utf8", timeout: 120_000 });
const ok = (...args) => {
  const result = docker(...args);
  assert.equal(result.status, 0, `docker ${args.join(" ")}\n${result.stdout}${result.stderr}`);
  return result.stdout.trim();
};

const required = process.env.OPTIO_REPO_INIT_TEST_IMAGE;
const image =
  required ??
  ["optio-base:latest", "optio-agent:latest"].find(
    (i) => docker("image", "inspect", i).status === 0,
  );
const skip = image ? false : "needs Docker and an agent image (optio-base:latest)";

const STUBS = "/opt/optio-test-stubs";
/** A stand-in for a slow step of the init: says it was reached, then waits to be released. */
const slowStep = (name) =>
  [
    "#!/bin/bash",
    `touch /tmp/optio-test-reached-${name}`,
    "while [ ! -f /tmp/optio-test-release ]; do sleep 0.1; done",
    "exit 0",
    "",
  ].join("\n");

describe("repo pod init and a readiness marker left by the previous boot", { skip }, () => {
  const id = `optio-repo-init-test-${process.pid}-${Date.now()}`;
  const scratch = mkdtempSync(join(tmpdir(), "optio-repo-init-"));
  const containers = [];
  const volumes = [];

  after(() => {
    if (containers.length) docker("rm", "-f", ...containers);
    if (volumes.length) docker("volume", "rm", "-f", ...volumes);
    rmSync(scratch, { recursive: true, force: true });
  });

  const imagePath = ok(
    "image",
    "inspect",
    "--format",
    "{{range .Config.Env}}{{println .}}{{end}}",
    image,
  )
    .split("\n")
    .find((line) => line.startsWith("PATH="))
    ?.slice("PATH=".length);

  /** The gate a run's start script waits on (`taskSetupLines`), as one exec into the pod. */
  const gate = (container) =>
    docker("exec", container, "sh", "-c", "[ -f /workspace/.ready ]").status;
  const running = (container) =>
    ok("inspect", "--format", "{{.State.Running}}", container) === "true";
  const logs = (container) => {
    const result = docker("logs", container);
    return `${result.stdout}${result.stderr}`;
  };
  const until = async (what, container, check) => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (check()) return;
      assert.ok(running(container), `the pod exited before ${what}:\n${logs(container)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`timed out waiting for ${what}:\n${logs(container)}`);
  };

  /**
   * One boot of the pod on `volume`: the checkout's scripts copied over the image's, `stubs`
   * first on PATH, `entrypoint` as the container's command. No network.
   */
  const boot = (name, volume, { entrypoint, env = {}, stubs = {} }) => {
    const container = `${id}-${name}`;
    const dir = mkdtempSync(join(scratch, `${name}-`));
    const stubDir = join(dir, "stubs");
    mkdirSync(stubDir);
    for (const [stub, body] of Object.entries(stubs)) writeFileSync(join(stubDir, stub), body);
    // The scripts as the image builds make them: executable (`RUN chmod +x`).
    for (const script of ["scripts/repo-init.sh", "images/dind-entrypoint.sh"]) {
      copyFileSync(join(root, script), join(dir, basename(script)));
    }
    for (const stub of Object.keys(stubs)) chmodSync(join(stubDir, stub), 0o755);
    for (const file of ["repo-init.sh", "dind-entrypoint.sh"]) chmodSync(join(dir, file), 0o755);
    const allEnv = {
      OPTIO_REPO_URL: "/workspace/.seed",
      OPTIO_REPO_BRANCH: "main",
      PATH: `${STUBS}:${imagePath}`,
      ...env,
    };
    ok(
      "create",
      "--name",
      container,
      "--network",
      "none",
      "-v",
      `${volume}:/workspace`,
      ...Object.entries(allEnv).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      "--entrypoint",
      entrypoint,
      image,
    );
    containers.push(container);
    ok("cp", `${stubDir}/.`, `${container}:${STUBS}`);
    for (const file of ["repo-init.sh", "dind-entrypoint.sh"]) {
      ok("cp", join(dir, file), `${container}:/opt/optio/${file}`);
    }
    ok("start", container);
    return container;
  };

  /**
   * A volume a pod has already initialized: a repo to clone is put on it, then the real init
   * runs to its marker and the pod goes away. What is left is what the next boot finds.
   */
  const initializedVolume = async (name) => {
    const volume = `${id}-${name}`;
    ok("volume", "create", volume);
    volumes.push(volume);
    ok(
      "run",
      "--rm",
      "--network",
      "none",
      "-v",
      `${volume}:/workspace`,
      "--entrypoint",
      "bash",
      image,
      "-c",
      [
        "set -e",
        "git init -q -b main /workspace/.seed",
        "cd /workspace/.seed",
        "git -c user.name=test -c user.email=test@example.com commit -q --allow-empty -m seed",
      ].join("\n"),
    );
    const first = boot(`${name}-boot1`, volume, { entrypoint: "/opt/optio/repo-init.sh" });
    await until("the first boot's marker", first, () => gate(first) === 0);
    ok("rm", "-f", first);
    return volume;
  };

  it("repo-init.sh: a run's gate does not pass while the next boot is still installing packages", async () => {
    const volume = await initializedVolume("init");
    // The second boot of the same volume, held at its package install.
    const pod = boot("init-boot2", volume, {
      entrypoint: "/opt/optio/repo-init.sh",
      env: { OPTIO_EXTRA_PACKAGES: "jq" },
      stubs: { sudo: slowStep("sudo") },
    });
    await until(
      "the package install",
      pod,
      () => docker("exec", pod, "test", "-f", "/tmp/optio-test-reached-sudo").status === 0,
    );
    assert.ok(running(pod));
    assert.equal(
      gate(pod),
      1,
      "the gate passed on the previous boot's marker, before init finished",
    );

    ok("exec", pod, "touch", "/tmp/optio-test-release");
    await until("this boot's own marker", pod, () => gate(pod) === 0);
    assert.match(logs(pod), /Reusing preserved checkout/);
  });

  it("dind-entrypoint.sh: a run's gate does not pass while the next boot waits for dockerd", async () => {
    const volume = await initializedVolume("dind");
    // The second boot, through the Docker-in-Docker entrypoint, held at `docker info`.
    const pod = boot("dind-boot2", volume, {
      entrypoint: "/opt/optio/dind-entrypoint.sh",
      stubs: { dockerd: "#!/bin/bash\nexec sleep 300\n", docker: slowStep("docker") },
    });
    await until(
      "the wait for dockerd",
      pod,
      () => docker("exec", pod, "test", "-f", "/tmp/optio-test-reached-docker").status === 0,
    );
    assert.ok(running(pod));
    assert.equal(
      gate(pod),
      1,
      "the gate passed on the previous boot's marker, before dockerd was up",
    );

    ok("exec", pod, "touch", "/tmp/optio-test-release");
    await until("this boot's own marker", pod, () => gate(pod) === 0);
    assert.match(logs(pod), /Docker daemon ready/);
  });
});

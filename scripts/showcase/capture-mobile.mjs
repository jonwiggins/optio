/** Capture installed Debug apps against the isolated demo. No device credentials are used. */
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
const m = JSON.parse(readFileSync("/tmp/optio-showcase-4965.json", "utf8"));
const simulator = process.env.OPTIO_SHOWCASE_SIMULATOR;
if (!simulator)
  throw new Error("Set OPTIO_SHOWCASE_SIMULATOR to an installed iPhone simulator UUID");
const emulator = process.env.OPTIO_SHOWCASE_EMULATOR ?? "emulator-5562";
const adb = `${process.env.ANDROID_HOME ?? `${process.env.HOME}/Library/Android/sdk`}/platform-tools/adb`;
const out = "/tmp/optio-showcase-shots";
mkdirSync(out, { recursive: true });
const pause = () => new Promise((r) => setTimeout(r, 4500));
const iosEnv = {
  ...process.env,
  SIMCTL_CHILD_OPTIO_DEV_SERVER_URL: m.api,
  SIMCTL_CHILD_OPTIO_DEV_TOKEN: "demo",
  SIMCTL_CHILD_OPTIO_DEV_SERVER_NAME: "Optio demo",
  SIMCTL_CHILD_OPTIO_DEV_NO_PUSH_PROMPT: "1",
};
// A fresh launch opens Overview before we navigate through the Work screens.
execFileSync(
  "xcrun",
  ["simctl", "launch", "--terminate-running-process", simulator, "dev.optio.ios"],
  { env: iosEnv, stdio: "ignore" },
);
await pause();
execFileSync("xcrun", ["simctl", "io", simulator, "screenshot", `${out}/ios-overview.png`], {
  stdio: "ignore",
});
const screens = [
  ["work", "optio://section/work?view=active"],
  ["recurring", "optio://section/work?view=recurring"],
  ["session", `optio://local/${m.live.claude}`],
  ["new-work", "optio://work/new"],
];
for (const [name, url] of screens) {
  execFileSync(
    "xcrun",
    ["simctl", "launch", "--terminate-running-process", simulator, "dev.optio.ios"],
    {
      env: {
        ...iosEnv,
        SIMCTL_CHILD_OPTIO_DEV_OPEN_URL: url,
        ...(name === "new-work"
          ? {
              SIMCTL_CHILD_OPTIO_DEV_NEW_SESSION: "schedule",
              SIMCTL_CHILD_OPTIO_DEV_NEW_SESSION_TWEAKS:
                "prompt=Prepare a daily engineering briefing for review,name=Morning engineering briefing",
            }
          : {}),
      },
      stdio: "ignore",
    },
  );
  const extras = [
    "--es",
    "OPTIO_DEV_SERVER_URL",
    "http://10.0.2.2:4965",
    "--es",
    "OPTIO_DEV_TOKEN",
    "demo",
    "--es",
    "OPTIO_DEV_OPEN_URL",
    url,
  ];
  if (name === "new-work")
    extras.push(
      "--es",
      "OPTIO_DEV_NEW_WORK",
      "schedule",
      "--es",
      "OPTIO_DEV_NEW_WORK_TWEAKS",
      "prompt=Prepare a daily engineering briefing for review,name=Morning engineering briefing",
    );
  execFileSync(
    adb,
    [
      "-s",
      emulator,
      "shell",
      "am",
      "start",
      "-S",
      "-n",
      "dev.optio.android/dev.optio.app.MainActivity",
      ...extras,
    ],
    { stdio: "ignore" },
  );
  await pause();
  execFileSync("xcrun", ["simctl", "io", simulator, "screenshot", `${out}/ios-${name}.png`], {
    stdio: "ignore",
  });
  writeFileSync(
    `${out}/android-${name}.png`,
    execFileSync(adb, ["-s", emulator, "exec-out", "screencap", "-p"], {
      maxBuffer: 8 * 1024 * 1024,
    }),
  );
  console.log(`iOS + Android: ${name}`);
}

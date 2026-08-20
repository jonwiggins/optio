import { execFile } from "node:child_process";

/**
 * Detect the `origin` remote URL of a directory, or undefined when the dir is
 * not a git repo (or git is unavailable). Never throws.
 */
export function detectRepoUrl(dir: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", dir, "remote", "get-url", "origin"],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve(undefined);
        const url = stdout.trim();
        resolve(url.length > 0 ? url : undefined);
      },
    );
  });
}

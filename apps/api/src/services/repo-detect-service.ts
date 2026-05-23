import { parseRepoUrl } from "@optio/shared";
import { getGitPlatformForRepo } from "./git-token-service.js";
import { logger } from "../logger.js";

interface DetectedConfig {
  imagePreset: string;
  languages: string[];
  testCommand?: string;
}

/**
 * Detect the appropriate image preset and test command by checking
 * the git platform API for files in the repo root.
 */
export async function detectRepoConfig(repoUrl: string, token: string): Promise<DetectedConfig> {
  const ri = parseRepoUrl(repoUrl);
  if (!ri) return { imagePreset: "base", languages: [] };

  try {
    const { platform } = await getGitPlatformForRepo(repoUrl, { server: true });
    const files = await platform.listRepoContents(ri);
    const fileNames = new Set(files.map((f) => f.name));

    const languages: string[] = [];
    let testCommand: string | undefined;

    // Detect languages by presence of config files
    if (fileNames.has("Cargo.toml")) {
      languages.push("rust");
      testCommand = testCommand ?? "cargo test";
    }
    if (fileNames.has("package.json")) {
      languages.push("node");
      testCommand = testCommand ?? "npm test";
    }
    if (fileNames.has("go.mod")) {
      languages.push("go");
      testCommand = testCommand ?? "go test ./...";
    }
    if (
      fileNames.has("pyproject.toml") ||
      fileNames.has("setup.py") ||
      fileNames.has("requirements.txt")
    ) {
      languages.push("python");
      testCommand = testCommand ?? "pytest";
    }
    if (fileNames.has("Gemfile")) {
      languages.push("ruby");
      testCommand = testCommand ?? "bundle exec rspec";
    }
    if (fileNames.has("pubspec.yaml")) {
      languages.push("dart");
      testCommand = testCommand ?? "dart test";
    }
    if (fileNames.has("pom.xml") || fileNames.has("build.gradle")) {
      languages.push("java");
    }

    // Choose image preset
    let imagePreset = "base";
    if (languages.length > 1) {
      imagePreset = "full";
    } else if (languages.includes("rust")) {
      imagePreset = "rust";
    } else if (languages.includes("node")) {
      imagePreset = "node";
    } else if (languages.includes("go")) {
      imagePreset = "go";
    } else if (languages.includes("python")) {
      imagePreset = "python";
    } else if (languages.includes("ruby")) {
      imagePreset = "ruby";
    } else if (languages.includes("dart")) {
      imagePreset = "dart";
    }

    logger.info({ repoUrl, imagePreset, languages, testCommand }, "Auto-detected repo config");
    return { imagePreset, languages, testCommand };
  } catch (err) {
    logger.warn({ err, repoUrl }, "Failed to detect repo config");
    return { imagePreset: "base", languages: [] };
  }
}

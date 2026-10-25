import { PRESET_IMAGES, type PresetImageId } from "@optio/shared";

/**
 * The image presets this deployment actually has. A preset whose image isn't
 * there (a release carries only the presets it built; `ruby` and `dart` are never
 * published) used to leave the pod in ImagePullBackOff and the run sitting
 * in provisioning until a sweep failed it, with nothing naming the preset.
 * Now a repo can't pick one, and a run on a repo that still has one fails at
 * once, saying which presets there are.
 *
 * `OPTIO_AGENT_PRESETS` lists them, comma-separated (the chart's
 * `agent.presets`, the Zarf package's `AGENT_PRESETS`). Unset, every preset
 * counts, as before. `base` is the default agent image and always counts.
 */

const ALL_PRESETS = Object.keys(PRESET_IMAGES) as PresetImageId[];

/** A preset this deployment doesn't have, or one Optio doesn't know. */
export class ImagePresetUnavailableError extends Error {
  readonly statusCode = 400;
  constructor(
    readonly preset: string,
    readonly available: readonly PresetImageId[],
  ) {
    super(
      preset in PRESET_IMAGES
        ? `Image preset "${preset}" is not available in this deployment (available: ${available.join(", ")})`
        : `Unknown image preset "${preset}" (available: ${available.join(", ")})`,
    );
    this.name = "ImagePresetUnavailableError";
  }
}

/** The presets this deployment has, in `PRESET_IMAGES` order. */
export function availablePresets(env: NodeJS.ProcessEnv = process.env): PresetImageId[] {
  const raw = env.OPTIO_AGENT_PRESETS?.trim();
  if (!raw) return [...ALL_PRESETS];
  const listed = new Set(
    raw
      .split(/[\s,]+/)
      .map((p) => p.trim())
      .filter(Boolean),
  );
  return ALL_PRESETS.filter((p) => p === "base" || listed.has(p));
}

/** Whether `preset` (absent = `base`) is one this deployment has. */
export function presetAvailable(
  preset: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (availablePresets(env) as string[]).includes(preset || "base");
}

/** Throws an `ImagePresetUnavailableError` for a preset this deployment doesn't have. */
export function assertPresetAvailable(
  preset: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!presetAvailable(preset, env)) {
    throw new ImagePresetUnavailableError(preset as string, availablePresets(env));
  }
}

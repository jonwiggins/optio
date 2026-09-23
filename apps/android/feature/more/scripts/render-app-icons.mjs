#!/usr/bin/env node
// Renders the alternate launcher icons (More › Settings › App icon) from the iOS sources in
// apps/ios/Design/icons/<slug>.svg (plus apps/ios/Design/app-icon.svg for the default), with
// sharp (librsvg; the monorepo's pnpm store has it). Run from the repo root:
//
//   node apps/android/feature/more/scripts/render-app-icons.mjs
//
// It writes:
//   apps/android/app/src/main/res/drawable-nodpi/ic_launcher_alt_<slug>.webp
//     The adaptive icon layer, 432 px (108 dp at xxxhdpi). The artwork fills the inner 288 px
//     (the 72 dp a launcher shows, masked to its shape) and is mirror-extended into the 18 dp
//     margin that launchers use for motion, so a parallax nudge never reveals an edge.
//   apps/android/feature/more/src/main/res/drawable-nodpi/app_icon_<slug>.webp
//     The picker thumbnails, 264 px (88 dp at xxhdpi), the whole square artwork.
//
// The adaptive-icon XMLs (app/src/main/res/mipmap-anydpi/ic_launcher_<slug>.xml) and the
// <activity-alias> entries in app/src/main/AndroidManifest.xml are hand-written; keep the slugs
// in sync with AppIconOption in :feature:more.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../../..");
const pnpmStore = join(repo, "node_modules/.pnpm");
const sharpDir = readdirSync(pnpmStore)
  .filter((d) => d.startsWith("sharp@"))
  .map((d) => join(pnpmStore, d, "node_modules/sharp"))
  .find((d) => existsSync(d));
if (!sharpDir) throw new Error("sharp not found in node_modules/.pnpm (run pnpm install)");
const sharp = createRequire(import.meta.url)(sharpDir);

const SLUGS = ["midnight", "terminal", "blueprint", "sticker", "retro", "sunrise", "chip"];
const iosDesign = join(repo, "apps/ios/Design");
const appRes = join(repo, "apps/android/app/src/main/res/drawable-nodpi");
const featureRes = join(repo, "apps/android/feature/more/src/main/res/drawable-nodpi");
mkdirSync(appRes, { recursive: true });
mkdirSync(featureRes, { recursive: true });

const LAYER = 432; // 108 dp × 4
const INNER = 288; // 72 dp × 4
const MARGIN = (LAYER - INNER) / 2;
const THUMB = 264;

async function render(svgPath, size) {
  // density scales the SVG's 1024 px canvas so librsvg rasterises sharply at the target size.
  return sharp(svgPath, { density: Math.ceil((72 * size) / 1024) * 2 })
    .resize(size, size)
    .flatten({ background: "#000000" })
    .png()
    .toBuffer();
}

async function launcherLayer(slug) {
  const inner = await render(join(iosDesign, "icons", `${slug}.svg`), INNER);
  const out = join(appRes, `ic_launcher_alt_${slug}.webp`);
  await sharp(inner)
    .extend({ top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN, extendWith: "mirror" })
    .webp({ quality: 92, effort: 6 })
    .toFile(out);
  return out;
}

async function thumbnail(slug, svgPath) {
  const out = join(featureRes, `app_icon_${slug}.webp`);
  await sharp(await render(svgPath, THUMB))
    .webp({ quality: 92, effort: 6 })
    .toFile(out);
  return out;
}

for (const slug of SLUGS) {
  console.log(await launcherLayer(slug));
  console.log(await thumbnail(slug, join(iosDesign, "icons", `${slug}.svg`)));
}
console.log(await thumbnail("default", join(iosDesign, "app-icon.svg")));

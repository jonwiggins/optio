#!/usr/bin/env node
// Regenerate all Optio brand assets: node scripts/render-brand.mjs
// Edit design/brand/mark.svg for geometry; edit the themes below for treatments.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { format } from "prettier";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const store = join(root, "node_modules/.pnpm");
const sharpPath = readdirSync(store)
  .filter((d) => d.startsWith("sharp@"))
  .map((d) => join(store, d, "node_modules/sharp"))
  .find((d) => existsSync(d));
if (!sharpPath) throw new Error("Run pnpm install first (sharp is required).");
const sharp = createRequire(import.meta.url)(sharpPath);
const source = readFileSync(join(root, "design/brand/mark.svg"), "utf8");
const paths = [...source.matchAll(/<path[^>]* d="([^"]+)"/g)].map((m) => m[1]);
if (paths.length !== 3) throw new Error("Expected body, corner, and eye paths.");
const geometry = paths.map((d) => `<path fill-rule="evenodd" d="${d}"/>`).join("");
const mark = (color = "#ffffff", transform = "translate(142 142) scale(7.4)") =>
  `<g fill="${color}" transform="${transform}">${geometry}</g>`;
const svg = (body, size = 1024) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>\n`;
const rect = (color) => `<rect width="1024" height="1024" fill="${color}"/>`;
const gradient = (a, b) =>
  `<defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>${rect("url(#bg)")}`;
function save(path, data) {
  const dest = join(root, path);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, data);
}
async function png(art, path, size = 1024, preserveAlpha = false) {
  const raster = sharp(Buffer.from(art)).resize(size, size);
  if (!preserveAlpha) raster.removeAlpha();
  save(path, await raster.png().toBuffer());
}

const standard = svg(gradient("#8738f5", "#5920cb") + mark());
const dark = svg(mark("#c4b5fd"));
const tinted = svg(mark());
const grid = Array.from({ length: 15 }, (_, i) => {
  const n = (i + 1) * 64;
  return `<path d="M${n} 0V1024M0 ${n}H1024"/>`;
}).join("");
// Four banks of leads and routed copper traces surrounding a central CPU package.
const chipLeads = Array.from({ length: 9 }, (_, i) => {
  const x = 344 + i * 42;
  const endX = x + (i - 4) * 28;
  const bend = 132 + Math.abs(i - 4) * 15;
  return `<path d="M${x} 264V${bend + 44}L${endX} ${bend}V48"/>
    <circle cx="${endX}" cy="48" r="10" fill="#0d2629" stroke="#658a78" stroke-width="4"/>`;
}).join("");
const chipPins = Array.from({ length: 9 }, (_, i) => {
  const x = 344 + i * 42;
  return `<rect x="${x - 10}" y="248" width="20" height="58" rx="4" fill="url(#metal)"/>
    <path d="M${x - 6} 258H${x + 6}" stroke="#f1e4b5" stroke-width="3"/>`;
}).join("");
const boardSides = [0, 90, 180, 270]
  .map(
    (angle) => `<g transform="rotate(${angle} 512 512)">
  <g fill="none" stroke="#385f59" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">${chipLeads}</g>
  ${chipPins}
  <rect x="86" y="176" width="76" height="36" rx="5" fill="#071515" stroke="#50706a" stroke-width="2"/>
  <path d="M94 178V210M154 178V210" stroke="#b3b8a2" stroke-width="12"/>
  <rect x="198" y="110" width="36" height="66" rx="5" fill="#76674c"/><path d="M200 118H232M200 168H232" stroke="#b6b6a4" stroke-width="10"/>
  <circle cx="114" cy="114" r="22" fill="#152f2c" stroke="#527e6b" stroke-width="5"/><circle cx="114" cy="114" r="9" fill="#05110f"/>
</g>`,
  )
  .join("");
const themes = {
  Midnight: svg(gradient("#1b1030", "#07050c") + mark("#a78bfa")),
  Terminal: svg(
    gradient("#393047", "#15121c") +
      `<defs><linearGradient id="chrome" x2="0" y2="1"><stop stop-color="#38343f"/><stop offset="1" stop-color="#24212c"/></linearGradient><clipPath id="window"><rect x="86" y="156" width="852" height="712" rx="52"/></clipPath></defs>
      <rect x="86" y="180" width="852" height="712" rx="52" fill="#050408" opacity="0.45"/>
      <g clip-path="url(#window)"><rect x="86" y="156" width="852" height="712" fill="#0c0c12"/><rect x="86" y="156" width="852" height="112" fill="url(#chrome)"/>
      <path d="M86 268H938" stroke="#55505f" stroke-width="2"/>
      <circle cx="154" cy="212" r="17" fill="#ff615b"/><circle cx="210" cy="212" r="17" fill="#ffbd44"/><circle cx="266" cy="212" r="17" fill="#00ca4e"/>
      <path d="M169 346L193 364L169 382" fill="none" stroke="#b09af8" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="220" y="386" font-family="Menlo,monospace" font-size="62" font-weight="bold" fill="#ebe7f3">optio</text>
      ${mark("#bba5ff", "translate(326 426) scale(3.72)")}
      <path d="M169 766L193 784L169 802" fill="none" stroke="#b09af8" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
      <rect x="220" y="757" width="30" height="52" rx="2" fill="#bba5ff"/>
      </g><rect x="86" y="156" width="852" height="712" rx="52" fill="none" stroke="#756a84" stroke-width="3"/>`,
  ),
  Blueprint: svg(
    gradient("#245fc8", "#123c94") +
      `<g fill="none" stroke="#ffffff" stroke-opacity="0.15" stroke-width="2">${grid}</g><g fill="none" stroke="#ffffff" stroke-opacity="0.55" stroke-width="3"><path d="M188 872H836M188 850V894M836 850V894M872 188V836M850 188H894M850 836H894"/></g>` +
      mark(),
  ),
  Sticker: svg(
    gradient("#a347f4", "#6d28d9") +
      `<g transform="rotate(-8 512 512)"><rect x="148" y="164" width="752" height="752" rx="190" fill="#3b0764" opacity="0.3"/><rect x="136" y="136" width="752" height="752" rx="190" fill="#ffffff"/>${mark("#6d28d9", "translate(214 214) scale(5.96)")}</g>`,
  ),
  Retro: svg(
    gradient("#0f3318", "#020604") +
      mark("#b6ffc8") +
      `<g stroke="#000000" stroke-opacity="0.22" stroke-width="3">${Array.from({ length: 128 }, (_, i) => `<path d="M0 ${i * 8}H1024"/>`).join("")}</g>`,
  ),
  Sunrise: svg(
    `<defs><linearGradient id="bg" x2="0" y2="1"><stop stop-color="#3b0f7a"/><stop offset="0.52" stop-color="#b83f9d"/><stop offset="1" stop-color="#ffb65c"/></linearGradient></defs>${rect("url(#bg)")}<circle cx="512" cy="840" r="350" fill="#ffe49a"/><path d="M0 850H1024V1024H0Z" fill="#2e1065"/>` +
      mark("#2e1065"),
  ),
  Chip: svg(
    `<defs>
      <radialGradient id="board"><stop stop-color="#25473e"/><stop offset="1" stop-color="#0a201e"/></radialGradient>
      <linearGradient id="metal" x2="1" y2="0"><stop stop-color="#7b755f"/><stop offset="0.4" stop-color="#ded5b6"/><stop offset="1" stop-color="#817a65"/></linearGradient>
      <linearGradient id="package" x2="1" y2="1"><stop stop-color="#565160"/><stop offset="0.45" stop-color="#24232b"/><stop offset="1" stop-color="#111219"/></linearGradient>
      <linearGradient id="lid" x2="1" y2="1"><stop stop-color="#3e3b49"/><stop offset="1" stop-color="#1b1924"/></linearGradient>
      </defs>${rect("url(#board)")}
      <g stroke="#294c43" stroke-width="3" fill="none"><path d="M0 292H178L242 228V0M1024 732H846L782 796V1024M0 756H166L218 808V1024M1024 268H858L806 216V0"/></g>
      ${boardSides}
      <rect x="278" y="296" width="468" height="468" rx="24" fill="#000000" opacity="0.4"/>
      <rect x="280" y="280" width="464" height="464" rx="22" fill="url(#package)" stroke="#74707c" stroke-width="3"/>
      <rect x="310" y="310" width="404" height="404" rx="16" fill="url(#lid)" stroke="#565060" stroke-width="2"/>
      <path d="M326 312H698Q712 312 712 326" fill="none" stroke="#9991a4" stroke-opacity="0.35" stroke-width="2"/>
      <circle cx="302" cy="302" r="7" fill="#d0c1a0"/>
      ${mark("#d8cbff", "translate(352 352) scale(3.2)")}`,
  ),
};
const assets = "apps/ios/Optio/Resources/Assets.xcassets";
for (const [suffix, art] of [
  ["", standard],
  ["-dark", dark],
  ["-tinted", tinted],
]) {
  save(`apps/ios/Design/app-icon${suffix}.svg`, art);
  await png(art, `${assets}/AppIcon.appiconset/AppIcon${suffix}.png`, 1024, suffix !== "");
}
for (const [name, art] of Object.entries(themes)) {
  const slug = name.toLowerCase();
  save(`apps/ios/Design/icons/${slug}.svg`, art);
  await png(art, `apps/ios/Design/icons/${slug}.png`);
  await png(art, `${assets}/AppIcon-${name}.appiconset/AppIcon-${name}.png`);
}
for (const [name, art] of Object.entries({ Default: standard, ...themes })) {
  await png(art, `${assets}/IconPreview-${name}.imageset/IconPreview-${name}.png`, 180);
}

const faviconBody = `<rect width="32" height="32" rx="7" fill="#6d28d9"/>${mark("#ffffff", "translate(2 2) scale(.28)")}`;
for (const app of ["web", "site"]) {
  save(`apps/${app}/public/favicon.svg`, svg(faviconBody, 32));
  save(
    `apps/${app}/public/optio-mark.svg`,
    source.replace('fill="currentColor"', 'fill="#a78bfa"'),
  );
  await png(standard, `apps/${app}/public/apple-touch-icon.png`, 180);
  await png(svg(faviconBody, 32), `apps/${app}/public/favicon-32.png`, 32);
}
// One generated module supplies the inline UI mark and dynamic attention favicon.
save(
  "apps/web/src/lib/optio-brand.ts",
  await format(
    `// Generated by scripts/render-brand.mjs from design/brand/mark.svg.\nexport const OPTIO_MARK_PATHS = ${JSON.stringify(paths)};\nexport const OPTIO_FAVICON_BODY = ${JSON.stringify(faviconBody)};\n`,
    { parser: "typescript" },
  ),
);
save(
  "apps/android/core/ui/src/main/kotlin/dev/optio/core/ui/components/OptioMarkPaths.kt",
  `// Generated by scripts/render-brand.mjs from design/brand/mark.svg.\npackage dev.optio.core.ui.components\n\ninternal val optioMarkPaths = listOf(\n${paths.map((d) => `    "${d}",`).join("\n")}\n)\n`,
);
// Glance widgets use a drawable resource instead of the Compose vector.
save(
  "apps/android/feature/widgets/src/main/res/drawable/widget_ic_bot.xml",
  `<?xml version="1.0" encoding="utf-8"?>\n<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp" android:viewportWidth="100" android:viewportHeight="100">${paths.map((d) => `<path android:fillColor="#FFFFFFFF" android:fillType="evenOdd" android:pathData="${d}"/>`).join("")}</vector>\n`,
);
save(
  "apps/android/app/src/main/res/drawable/ic_launcher_foreground.xml",
  `<?xml version="1.0" encoding="utf-8"?>\n<!-- Generated Peek mark; also used for monochrome themed icons. Inside the 66dp safe circle. -->\n<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108"><group android:scaleX="0.5" android:scaleY="0.5" android:translateX="29" android:translateY="29">${paths.map((d) => `<path android:fillColor="#FFFFFFFF" android:fillType="evenOdd" android:pathData="${d}"/>`).join("")}</group></vector>\n`,
);
execFileSync(
  process.execPath,
  [join(root, "apps/android/feature/more/scripts/render-app-icons.mjs")],
  { stdio: "inherit" },
);

const entries = Object.entries({
  Default: standard,
  Dark: svg(rect("#100b1b") + mark("#c4b5fd")),
  Tinted: svg(rect("#272727") + mark()),
  ...themes,
});
const cells = await Promise.all(
  entries.map(async ([name, art], i) => ({
    input: await sharp(Buffer.from(art)).resize(180, 180).png().toBuffer(),
    left: 24 + (i % 5) * 224,
    top: 24 + Math.floor(i / 5) * 224,
  })),
);
const labels = `<svg width="1120" height="448">${entries.map(([name], i) => `<text x="${24 + (i % 5) * 224}" y="${224 + Math.floor(i / 5) * 224}" font-family="sans-serif" font-size="14" fill="#24202d">${name}</text>`).join("")}</svg>`;
save(
  "design/brand/app-icons.png",
  await sharp({ create: { width: 1120, height: 448, channels: 4, background: "#f5f3f8" } })
    .composite([...cells, { input: Buffer.from(labels), left: 0, top: 0 }])
    .png()
    .toBuffer(),
);
save(
  "apps/ios/Design/icons/contact-sheet.png",
  readFileSync(join(root, "design/brand/app-icons.png")),
);
console.log("Brand assets generated. Preview: design/brand/app-icons.png");
const dataUrl = (art) => `data:image/svg+xml;base64,${Buffer.from(art).toString("base64")}`;
save(
  "design/brand/preview.html",
  await format(
    `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Optio — Peek</title><link rel="icon" href="../../apps/web/public/favicon.svg">
<style>body{margin:0;padding:48px;font:16px system-ui;background:#f5f3f8;color:#21172e}main{max-width:1100px;margin:auto}h1{font-size:40px;letter-spacing:-1.5px;margin:0 0 8px}p{color:#70667b}.icons{display:flex;gap:28px;flex-wrap:wrap;margin:32px 0}.icon{text-align:center}.icon img{width:160px;height:160px;border-radius:36px;display:block;margin-bottom:12px}.samples{display:flex;gap:28px;align-items:center;padding:24px;background:white;border-radius:16px;margin:16px 0}.samples.dark{background:#17121f;color:#eee}.sample{display:flex;align-items:center;gap:10px}.mask img{border-radius:50%}h2{margin-top:40px;font-size:20px}footer{margin-top:40px;color:#70667b}</style>
<main><h1>Optio / Peek</h1><p>The selected mark, across app icons and the web.</p><div class="icons">${entries.map(([name, art]) => `<div class="icon"><img alt="${name} app icon" src="${dataUrl(art)}">${name}</div>`).join("")}</div>
<h2>Favicons at actual sizes</h2>${["", "dark"].map((tone) => `<div class="samples ${tone}">${[16, 20, 24, 32].map((size) => `<div class="sample"><img alt="${size}px favicon" width="${size}" height="${size}" src="${dataUrl(svg(faviconBody, 32))}">${size}px</div>`).join("")}</div>`).join("")}
<h2>Monochrome and circular masks</h2><div class="icons"><div class="icon mask"><img alt="Circular launcher preview" src="${dataUrl(standard)}">Circle</div><div class="icon"><img alt="Monochrome light" src="${dataUrl(svg(rect("#ffffff") + mark("#6d28d9")))}">Light</div><div class="icon"><img alt="Monochrome dark" src="${dataUrl(svg(rect("#17121f") + mark("#c4b5fd")))}">Dark</div></div></main></html>`,
    { parser: "html" },
  ),
);

/** A social card composed from the real Overview capture and the product wordmark. */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
const root = "apps/site/public";
const screenshot = readFileSync(`${root}/screenshots/showcase/web-overview.webp`).toString(
  "base64",
);
const logo = readFileSync(`${root}/optio-mark.svg`).toString("base64");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<html><style>*{box-sizing:border-box}body{margin:0;width:1200px;height:630px;overflow:hidden;color:#f4f2ed;font-family:Arial,sans-serif;background:radial-gradient(ellipse at 85% 40%,#332047,#0d0d11 75%)}main{padding:62px 64px;position:relative;z-index:1}header{display:flex;align-items:center;gap:13px;font-size:29px;font-weight:bold}header img{width:40px;height:40px}.kicker{margin-top:58px;color:#c2a5ef;letter-spacing:2px;font-size:13px}h1{font-size:57px;line-height:1.13;letter-spacing:-2.6px;margin:23px 0;width:640px}h1 span{color:#b79ae9}.sub{color:#bdb4c8;font-size:18px;line-height:1.8;width:470px}.url{margin-top:39px;color:#b49acd;font-size:14px}.shot{position:absolute;left:770px;top:125px;width:720px;border:1px solid #655273;border-radius:12px;box-shadow:0 20px 80px #0009;transform:rotate(-4deg)}.shot img{width:100%;border-radius:12px;display:block}</style><main><header><img src="data:image/svg+xml;base64,${logo}" alt="">optio</header><div class="kicker">SELF-HOSTED · OPEN SOURCE</div><h1>All your agent work.<br><span>One place to run it.</span></h1><p class="sub">Your cluster. Your machines.<br>Native apps in your pocket.</p><p class="url">optio.host</p></main><div class="shot"><img src="data:image/webp;base64,${screenshot}" alt="Optio Overview"></div></html>`,
  );
  await page.evaluate(() => Promise.all(Array.from(document.images).map((i) => i.decode())));
  await page.screenshot({ path: `${root}/og-image.png` });
} finally {
  await browser.close();
}

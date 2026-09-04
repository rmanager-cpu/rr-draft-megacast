// Load any page of the show in a real browser, photograph it, and fail if the
// console complained. Handy for the pages that have no other check.
// Usage: node scripts/shot-page.mjs curate --out shot.png [--click ".p:nth-child(3)"]
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
// Named, not positional: a bare "/curate" gets rewritten to a Windows path by
// Git Bash before Node ever sees it, which silently loads the wrong page.
const page_ = args.find((a) => !a.startsWith("--") && !/^[A-Za-z]:/.test(a)) ?? "status";
const path = "/" + String(page_).split("/").filter(Boolean).join("/");
const flag = (n, d) => {
  const i = args.indexOf("--" + n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const base = "http://127.0.0.1:" + flag("port", "7788");
const out = flag("out", "");
const click = flag("click", "");
const width = Number(flag("width", 1600));
const height = Number(flag("height", 1000));

// Third-party embeds are noisy and none of it is ours.
const IGNORE = /favicon|youtube|ytimg|doubleclick|googleads|google-analytics|play\.google|gstatic/i;

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width, height } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !IGNORE.test(m.text()) && errors.push(m.text()));

await page.goto(base + path, { waitUntil: "domcontentloaded" });
if (click) {
  await page.waitForSelector(click, { timeout: 8000 });
  await page.click(click);
}
await page.waitForTimeout(900);
if (out) {
  await page.screenshot({ path: out });
  console.log("screenshot:", out);
}
const title = await page.title();
await browser.close();

console.log("loaded", path, "-", title);
if (errors.length) {
  console.error("PAGE ERRORS:\n - " + errors.join("\n - "));
  process.exit(1);
}
console.log("no console errors");

// Drive the studio through a reveal and photograph it.
// Usage: node scripts/shot-studio.mjs [--port 7788] [--picks 3] [--out shot.png]
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf("--" + n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const base = "http://127.0.0.1:" + flag("port", "7788");
const out = flag("out", "studio.png");
const picks = Number(flag("picks", 3));

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !m.text().includes("favicon") && errors.push(m.text()));

await page.goto(base + "/studio", { waitUntil: "domcontentloaded" });
await page.click("#arm");
await page.waitForTimeout(300);

await fetch(base + "/api/dev/step", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ picks }),
});

// Let the sting run and the card settle in.
await page.waitForFunction(() => document.getElementById("card").classList.contains("in"), null, { timeout: 8000 });
await page.waitForTimeout(900);
await page.screenshot({ path: out });

const shown = await page.evaluate(() => ({
  last: document.querySelector("#card .last")?.textContent ?? "",
  first: document.querySelector("#card .first")?.textContent ?? "",
  pos: document.querySelector("#card .pill")?.textContent ?? "",
  team: document.querySelector("#card .to b")?.textContent ?? "",
  slate: document.getElementById("slate")?.textContent ?? "",
  imgReady: document.getElementById("shot")?.classList.contains("ready") ?? false,
  barWidth: document.querySelector("#bar i")?.style.width ?? "",
}));
await browser.close();

console.log("screenshot:", out);
console.log(JSON.stringify(shown, null, 2));
if (errors.length) {
  console.error("PAGE ERRORS:\n - " + errors.join("\n - "));
  process.exit(1);
}

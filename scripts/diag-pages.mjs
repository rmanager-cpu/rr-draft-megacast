// Sit two TV windows in front of a running show for a long time and record every
// request that fails, with its URL. The two-hour soak reported page errors but
// not what actually failed, which is not enough to fix anything.
// Usage: node scripts/diag-pages.mjs [--minutes 45] [--port 7788]
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf("--" + n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const base = "http://127.0.0.1:" + flag("port", "7788");
const minutes = Number(flag("minutes", 45));

const browser = await chromium.launch({ channel: "chrome", headless: true });
const failures = new Map(); // "url :: reason" -> count
const consoleErrors = [];

for (const [path, name] of [["/board", "board"], ["/studio", "studio"]]) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("requestfailed", (r) => {
    const url = r.url().replace(base, "").split("?")[0];
    const key = name + "  " + url + "  ::  " + (r.failure()?.errorText ?? "?");
    failures.set(key, (failures.get(key) ?? 0) + 1);
  });
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon|youtube|ytimg/i.test(m.text())) consoleErrors.push(name + ": " + m.text());
  });
  await page.goto(base + path, { waitUntil: "domcontentloaded" });
  if (name === "studio") await page.click("#arm").catch(() => {});
}

const started = Date.now();
let lastReport = 0;
while (Date.now() - started < minutes * 60000) {
  await new Promise((r) => setTimeout(r, 30000));
  const mins = Math.round((Date.now() - started) / 60000);
  if (mins !== lastReport) {
    lastReport = mins;
    const total = [...failures.values()].reduce((a, b) => a + b, 0);
    console.log(`${String(mins).padStart(3)} min   ${total} failed requests   ${consoleErrors.length} console errors`);
    if (total && mins % 5 === 0) for (const [k, n] of failures) console.log("        " + n + " x  " + k);
  }
}

await browser.close();
console.log("");
if (!failures.size) console.log("no request failed in " + minutes + " minutes");
else {
  console.log("failed requests, by kind:");
  for (const [k, n] of [...failures].sort((a, b) => b[1] - a[1])) console.log("  " + String(n).padStart(5) + " x  " + k);
}

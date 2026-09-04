// Loads /board in a real browser and checks every cell against /api/state.
// This is what turns "the board is never wrong" from an aspiration into a check.
// Usage: node scripts/verify-board.mjs [--port 7788] [--shot out.png]
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf("--" + n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const port = flag("port", "7788");
const shot = flag("shot", "");
const base = "http://127.0.0.1:" + port;

const state = await fetch(base + "/api/state").then((r) => r.json());
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const problems = [];
page.on("pageerror", (e) => problems.push("page error: " + e.message));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  if (m.text().includes("favicon")) return;
  problems.push("console: " + m.text());
});

// The event stream never closes, so the page is never "network idle" - wait on
// content instead of on the network going quiet.
await page.goto(base + "/board", { waitUntil: "domcontentloaded" });
await page.waitForFunction(
  (n) => document.querySelectorAll("#grid .cell:not(.empty):not(.gap)").length >= n,
  state.picks.length,
  { timeout: 15000 },
).catch(() => {});

const drawn = await page.evaluate(() =>
  [...document.querySelectorAll("#grid .cell")].map((el) => ({
    no: el.querySelector(".no")?.textContent ?? "",
    last: el.querySelector(".last")?.textContent ?? "",
    empty: el.classList.contains("empty"),
  })),
);

const filled = drawn.filter((d) => !d.empty);
if (filled.length !== state.picks.length) {
  problems.push(`board shows ${filled.length} filled cells, the server has ${state.picks.length}`);
}
// The board prints the suffix alongside the surname, so compare the same string.
const wanted = new Set(state.picks.map((p) => [p.lastName || p.name, p.suffix].filter(Boolean).join(" ")));
const missing = [...wanted].filter((n) => !filled.some((f) => f.last === n));
if (missing.length) problems.push(`missing from the board: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? " and " + (missing.length - 5) + " more" : ""}`);

const veiled = await page.evaluate(() => !document.getElementById("veil").classList.contains("hidden"));
if (shot) {
  await page.screenshot({ path: shot });
  console.log("screenshot:", shot);
}
await browser.close();

console.log(`server picks: ${state.picks.length}   board cells drawn: ${drawn.length}   filled: ${filled.length}`);
console.log("standby veil still up:", veiled);
if (problems.length) {
  console.error("PROBLEMS:\n - " + problems.join("\n - "));
  process.exit(1);
}
console.log("board matches the server exactly");

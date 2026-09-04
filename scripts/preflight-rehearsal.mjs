// Rehearses draft-night setup end to end: open both TVs, arm the speaker,
// confirm the test line, and check the gate actually goes green.
// Usage: node scripts/preflight-rehearsal.mjs [--port 7788] [--shot out.png]
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf("--" + n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const base = "http://127.0.0.1:" + flag("port", "7788");
const shot = flag("shot", "");

const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors = [];
const open = async (path, name) => {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (e) => errors.push(name + ": " + e.message));
  page.on("console", (m) => m.type() === "error" && !m.text().includes("favicon") && errors.push(name + ": " + m.text()));
  await page.goto(base + path, { waitUntil: "domcontentloaded" });
  return page;
};

const board = await open("/board", "board");
const studio = await open("/studio", "studio");

await studio.click("#arm");
await fetch(base + "/api/audio-test", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
await fetch(base + "/api/audio-confirm", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ heard: true }),
});

// Give the display heartbeats a couple of beats to agree on a version.
let gate = null;
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 700));
  gate = await fetch(base + "/api/checks").then((r) => r.json());
  if (gate.ready) break;
}

const launchPage = await open("/launch", "launch");
await launchPage.waitForTimeout(1200);
if (shot) await launchPage.screenshot({ path: shot, fullPage: true });

console.log("gate ready:", gate?.ready);
for (const c of gate?.checks ?? []) console.log(" ", c.ok ? "ok  " : "BAD ", c.label.padEnd(34), c.detail || "");

// And that the one press works.
const launched = await fetch(base + "/api/launch", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
}).then((r) => r.json());
console.log("launch:", JSON.stringify(launched));

const veilGone = await board.evaluate(() => document.getElementById("veil").classList.contains("hidden"));
console.log("board standby veil cleared:", veilGone);

await browser.close();
if (errors.length) {
  console.error("PAGE ERRORS:\n - " + errors.join("\n - "));
  process.exit(1);
}
if (!gate?.ready || !launched.ok) process.exit(1);

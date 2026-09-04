// A clip that will never play must cost nothing. The card is already on screen
// underneath, so the test is that it is there, readable, and that the black
// video panel never becomes visible.
// Usage: node scripts/verify-badclip.mjs [--port 7806]
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { readJsonSync, writeAtomicSync } from "../server/persist.mjs";

const args = process.argv.slice(2);
const i = args.indexOf("--port");
const port = i >= 0 ? args[i + 1] : "7806";
const base = "http://127.0.0.1:" + port;
const problems = [];

// The first pick the wire delivers in the capture.
const PLAYER = 4685382;
const CATALOG = "data/highlights.json";
const before = readJsonSync(CATALOG, {}) ?? {};
writeAtomicSync(CATALOG, {
  ...before,
  [PLAYER]: { videoId: "zzzzzzzzzzz", start: 0, ceilingMs: 8000, title: "deliberately dead", verifiedAt: 0 },
});

const server = spawn(process.execPath, ["server/main.mjs", "--source", "replay", "--step", "--port", port, "--fresh"], {
  stdio: ["ignore", "pipe", "pipe"],
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(4500);

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(base + "/studio", { waitUntil: "domcontentloaded" });
await page.click("#arm").catch(() => {});
await wait(500);

// Step to the pick that has the dead clip.
await fetch(base + "/api/dev/step", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ picks: 1 }),
});

// Wait for THIS player's card to be readable, not merely for some card to be
// mid-animation - the room-snapshot reveal is still running when we step.
const t0 = Date.now();
await page.waitForFunction(
  () => {
    const card = document.getElementById("card");
    const name = document.querySelector("#card .last")?.textContent ?? "";
    return name.startsWith("Hampton") && getComputedStyle(card).opacity === "1";
  },
  null,
  { timeout: 30000 },
);
const cardMs = Date.now() - t0;

// Give the player every chance to misbehave once the card is up.
await wait(3000);
const shown = await page.evaluate(() => ({
  name: document.querySelector("#card .last")?.textContent ?? "",
  cardVisible: getComputedStyle(document.getElementById("card")).opacity !== "0",
  clipVisible: document.getElementById("clip").classList.contains("live"),
  clipOpacity: getComputedStyle(document.getElementById("clip")).opacity,
}));
await page.screenshot({ path: "C:/Users/Chef/AppData/Local/Temp/badclip.png" });
await browser.close();
server.kill();

writeAtomicSync(CATALOG, before);

console.log("card appeared in " + cardMs + "ms:", JSON.stringify(shown));
if (!shown.name) problems.push("no player name on the card");
if (!shown.cardVisible) problems.push("the card is not visible");
if (shown.clipVisible) problems.push("the dead clip was shown");
if (Number(shown.clipOpacity) > 0) problems.push("the video panel is visible at opacity " + shown.clipOpacity);
// The budget is measured from when this reveal starts, not from the step: the
// previous card is still finishing, and never being interrupted is the point.
if (cardMs > 25000) problems.push("the card took " + cardMs + "ms to become readable");

if (problems.length) {
  console.error("BAD CLIP HANDLING FAILED:\n - " + problems.join("\n - "));
  process.exit(1);
}
console.log("a dead clip costs nothing: the card is up, the video panel never appears");

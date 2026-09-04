// The long unattended run. A full twelve-team draft at real speed with both TVs
// open, a dropout in the middle, and nobody touching anything - which is exactly
// the claim the show has to make on the night.
//
// Usage: node scripts/soak.mjs [--minutes 120] [--speed 1] [--port 7799]
// Prints one pass/fail line and exits non-zero if any invariant broke.

import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf("--" + n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const port = flag("port", "7799");
const speed = flag("speed", "1");
const maxMinutes = Number(flag("minutes", 120));
const base = "http://127.0.0.1:" + port;

const problems = [];
const note = (s) => console.log(new Date().toISOString().slice(11, 19) + "  " + s);

const server = spawn(
  process.execPath,
  ["server/main.mjs", "--source", "synth", "--speed", speed, "--port", port, "--drop-at", "45", "--drop-picks", "9", "--fresh"],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
server.on("exit", (code) => problems.push("the server exited early with code " + code));

const stop = async () => {
  try {
    server.kill();
  } catch {}
};

await new Promise((r) => setTimeout(r, 4000));

const browser = await chromium.launch({ channel: "chrome", headless: true });
const pageErrors = [];
for (const [path, name] of [
  ["/board", "board"],
  ["/studio", "studio"],
]) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (e) => pageErrors.push(name + ": " + e.message));
  page.on("console", (m) => m.type() === "error" && !/favicon|youtube|ytimg|googleads|doubleclick|gstatic/i.test(m.text()) && pageErrors.push(name + ": " + m.text()));
  await page.goto(base + path, { waitUntil: "domcontentloaded" });
  if (name === "studio") await page.click("#arm").catch(() => {});
}

let baselineRss = 0;
let peakRss = 0;
let lastPicks = -1;
let stalledFor = 0;
const started = Date.now();
let health = null;

while (Date.now() - started < maxMinutes * 60000) {
  await new Promise((r) => setTimeout(r, 15000));
  try {
    health = await fetch(base + "/api/health").then((r) => r.json());
  } catch (e) {
    problems.push("health check failed: " + e.message);
    break;
  }
  if (!baselineRss) baselineRss = health.rssMb;
  peakRss = Math.max(peakRss, health.rssMb);

  if (health.committed === lastPicks) {
    stalledFor += 15;
    // Late in a slow draft a five-minute gap between picks is normal; ten is not.
    if (stalledFor > 600 && health.phase !== "complete") {
      problems.push("no pick for ten minutes at " + health.committed);
      break;
    }
  } else {
    stalledFor = 0;
    lastPicks = health.committed;
  }

  if (health.committed % 24 === 0 || health.phase === "complete") {
    note(
      `${health.committed} picks · ${health.phase} · ${health.rssMb}MB · reveal queue ${health.reveal.depth} · audio ${JSON.stringify(health.audio.playing)}`,
    );
  }
  if (health.phase === "complete") break;
}

const state = await fetch(base + "/api/state").then((r) => r.json()).catch(() => null);
await browser.close();
await stop();

if (!state) problems.push("could not read the final state");
else {
  const expected = state.league.teams.length * state.league.rounds;
  if (state.picks.length !== expected) problems.push(`${state.picks.length} picks, expected ${expected}`);
  if (state.gaps.length) problems.push(state.gaps.length + " gaps left open");
  if (state.counters.suspects) problems.push(state.counters.suspects + " picks flagged");
  if (new Set(state.picks.map((p) => p.playerId)).size !== state.picks.length) problems.push("a player was drafted twice");
  if (state.phase !== "complete") problems.push("the draft never reported complete");
}
if (peakRss - baselineRss > 120) problems.push(`memory grew ${peakRss - baselineRss}MB`);
if (pageErrors.length) problems.push(pageErrors.length + " page errors: " + pageErrors.slice(0, 3).join(" | "));
if (/unhandled rejection|uncaught exception/i.test(serverLog)) problems.push("the server logged an unhandled error");

console.log("");
console.log(`picks ${state?.picks.length ?? "?"} · gaps ${state?.gaps.length ?? "?"} · memory ${baselineRss}MB to ${peakRss}MB · ran ${Math.round((Date.now() - started) / 60000)} min`);
if (problems.length) {
  console.error("SOAK FAILED:\n - " + problems.join("\n - "));
  process.exit(1);
}
console.log("SOAK PASSED");

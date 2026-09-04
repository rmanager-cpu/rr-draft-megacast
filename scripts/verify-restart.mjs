// Kill the show computer mid-draft and start it again. The board has to come
// back with everything it had, and the draft has to finish correctly - including
// not double-counting the picks the wire replays on the way back up.
// Usage: node scripts/verify-restart.mjs [--port 7803]
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";

const args = process.argv.slice(2);
const i = args.indexOf("--port");
const port = i >= 0 ? args[i + 1] : "7803";
const base = "http://127.0.0.1:" + port;
const problems = [];

rmSync("data/state.json", { force: true });
rmSync("data/picks.jsonl", { force: true });

const boot = (extra = []) => {
  const p = spawn(process.execPath, ["server/main.mjs", "--source", "replay", "--step", "--port", port, ...extra], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  p.stdout.on("data", (d) => (log += d));
  p.stderr.on("data", (d) => (log += d));
  return { p, log: () => log };
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const state = () => fetch(base + "/api/state").then((r) => r.json());
const step = (picks) =>
  fetch(base + "/api/dev/step", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ picks }),
  }).then((r) => r.json());

// --- first run: get forty picks in, then die without warning ---
let run = boot();
await wait(4500);
await step(30); // plus the ten the room snapshot already carried
const before = await state();
console.log("before the crash:", before.picks.length, "picks");
if (before.picks.length !== 40) problems.push("expected 40 picks before the crash, got " + before.picks.length);
run.p.kill("SIGKILL");
await wait(1500);

// --- second run: it should come back knowing what it knew ---
run = boot();
await wait(4500);
const after = await state();
console.log("after the restart:", after.picks.length, "picks");
if (after.picks.length < before.picks.length) {
  problems.push(`lost picks across the restart: ${before.picks.length} became ${after.picks.length}`);
}
const sameOrder = before.picks.every((p, idx) => after.picks[idx]?.playerId === p.playerId);
if (!sameOrder) problems.push("the board came back different");

// --- and the draft still finishes correctly ---
await step(200);
await wait(800);
const end = await state();
console.log("at the end:", end.picks.length, "picks ·", end.gaps.length, "gaps ·", JSON.stringify(end.counters));
if (end.picks.length !== 160) problems.push("expected 160 picks, got " + end.picks.length);
if (end.gaps.length) problems.push(end.gaps.length + " gaps");
if (new Set(end.picks.map((p) => p.playerId)).size !== end.picks.length) problems.push("a player is on the board twice");
if (end.counters.duplicates < 1) problems.push("the replayed picks were not recognised as duplicates");

const restoredLine = /restored \d+ picks|carried \d+ picks/.test(run.log());
if (!restoredLine) problems.push("the restart did not report restoring anything");

run.p.kill();
await wait(300);

if (problems.length) {
  console.error("RESTART RECOVERY FAILED:\n - " + problems.join("\n - "));
  process.exit(1);
}
console.log("restart recovery passed");

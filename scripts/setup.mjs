// Get a machine ready to run the show, and say plainly what is still missing.
//   npm run setup
//
// Safe to run as many times as you like. It fetches and caches what the show
// needs to work with the network unplugged, then reports on the things only a
// person can supply.

import { existsSync, readFileSync } from "node:fs";
import { loadEnv } from "./env.mjs";
import { loadPlayers } from "../server/players.mjs";
import { createHeadshots } from "../server/headshots.mjs";
import { readJsonSync, writeAtomicSync } from "../server/persist.mjs";
import { untouched } from "./lore-template.mjs";

/** Two complete sentences. A stop is only a stop before a space and a capital. */
function trimNote(text) {
  // Collapse whitespace without a pattern. Escape sequences do not survive
  // being edited through a shell, and this file has now lost one twice.
  let clean = String(text);
  for (const ch of [String.fromCharCode(9), String.fromCharCode(10), String.fromCharCode(13)]) {
    clean = clean.split(ch).join(" ");
  }
  while (clean.includes("  ")) clean = clean.split("  ").join(" ");
  clean = clean.trim();
  const parts = [];
  let last = 0;
  for (let i = 0; i < clean.length - 1; i++) {
    if (!".!?".includes(clean[i])) continue;
    if (clean[i + 1] !== " ") continue;
    const after = clean[i + 2];
    if (!after || after === after.toLowerCase()) continue;
    parts.push(clean.slice(last, i + 1).trim());
    last = i + 1;
    if (parts.length >= 2) break;
  }
  if (parts.length < 2 && last < clean.length) parts.push(clean.slice(last).trim());
  return parts.filter((x, k, all) => k < all.length - 1 || /[.!?]$/.test(x)).join(" ").trim();
}

const ok = (s) => console.log("  ok    " + s);
const no = (s) => console.log("  TODO  " + s);
const bad = (s) => console.log("  STOP  " + s);
let blocked = false;

console.log("");
console.log("Checking this machine");

// --- things that must be right before anything else ---
const major = Number(process.versions.node.split(".")[0]);
if (major >= 22) ok("Node " + process.versions.node);
else {
  bad("Node " + process.versions.node + " is too old. The draft wire needs 22 or newer.");
  blocked = true;
}

if (!existsSync(".env")) {
  bad("no .env file. Copy .env.example to .env and fill it in.");
  blocked = true;
}
const env = existsSync(".env") ? loadEnv() : {};
const missing = ["ESPN_LEAGUE_ID", "ESPN_SWID", "ESPN_S2"].filter((k) => !env[k] || env[k] === "replace_me");
if (!existsSync(".env")) {
  // already reported
} else if (missing.length) {
  bad(".env is missing " + missing.join(", "));
  blocked = true;
} else {
  ok("ESPN cookies and league id are set");
}

if (blocked) {
  console.log("");
  console.log("Fix the STOP lines first, then run this again.");
  process.exitCode = 1;
} else {
  // --- caches, so the show works with the cable out ---
  console.log("");
  console.log("Caching what the show needs offline");
  const players = await loadPlayers({
    season: Number(env.ESPN_SEASON || 2026),
    onInfo: (m) => ok(m),
    onWarn: (m) => no(m),
  });

  // The booth's only source of 2026 facts. These are ESPN's own pre-season
  // write-ups, so they move as the season approaches - refresh before the draft
  // rather than trusting a copy taken days earlier.
  if (players.size > 5000) {
    const notes = {};
    for (const x of players.byAdp.slice(0, 300)) {
      if (!x.outlook) continue;
      const note = trimNote(x.outlook);
      if (note.length >= 40) notes[String(x.id)] = note;
    }
    writeAtomicSync("data/player-notes.json", notes, { onWarn: () => {} });
    ok(Object.keys(notes).length + " player notes from ESPN's 2026 write-ups");
  }

  if (players.size > 5000) {
    const headshots = createHeadshots({ onWarn: () => {} });
    const wanted = players.byAdp.slice(0, 400).map((p) => ({ playerId: p.id, proTeam: p.proTeam }));
    for (const p of players.all) if (p.pos === "D/ST") wanted.push({ playerId: p.id, proTeam: p.proTeam });
    process.stdout.write("  ...   fetching " + wanted.length + " images");
    const { have, done } = await headshots.prefetch(wanted);
    process.stdout.write("\r");
    ok(have + " of " + done + " player images cached");
  }

  // --- what only a person can supply ---
  console.log("");
  console.log("Still needed from you");
  env.ANTHROPIC_API_KEY ? ok("Anthropic key, so the booth writes its own lines") : no("ANTHROPIC_API_KEY in .env, or the booth reads written lines only");
  env.ELEVENLABS_API_KEY ? ok("ElevenLabs key, so the booth has real voices") : no("ELEVENLABS_API_KEY in .env, or the booth uses this laptop's own voice");

  // Exactly the test the generator uses, so the two can never disagree about
  // whether the owner has written anything. A word count could not tell the
  // template's own instructions apart from real writing.
  const loreText = existsSync("data/lore.md") ? readFileSync("data/lore.md", "utf8") : "";
  if (!loreText || untouched(loreText)) {
    no("data/lore.md is still the template. The booth is only as good as this file.");
  } else {
    ok("data/lore.md has been written");
  }

  const clips = Object.values(readJsonSync("data/highlights.json", {}) ?? {}).filter((c) => c && c.videoId);
  const verified = clips.filter((c) => c.verifiedAt).length;
  if (!clips.length) no("no highlight clips yet. Every pick gets its card, which is the design.");
  else if (verified < clips.length) no(clips.length + " clips, " + (clips.length - verified) + " unchecked. Press Check every clip on /curate.");
  else ok(clips.length + " clips, all checked");

  console.log("");
  console.log("Next:  npm test        then  npm run replay:fast");
  console.log("       npm run probe -- " + (env.ESPN_LEAGUE_ID || "<leagueId>") + "   to ask whether the draft room will talk to us");
  console.log("");
}

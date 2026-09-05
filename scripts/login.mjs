// Sign the show in to ESPN and capture that account's cookies.
//
//   npm run login              use the show's own browser profile
//   npm run login -- --fresh   start from a clean profile (to switch accounts)
//
// This opens a separate Chrome profile, so it cannot sign you out of your normal
// browser. Sign in as the account the SHOW should use - the co-manager, not the
// one you draft with - and the cookies are written to .env. It then says which
// ESPN member those cookies belong to and which team they can see, because
// capturing the wrong account is the easy mistake here and a silent one.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { loadEnv } from "./env.mjs";

const args = process.argv.slice(2);
const fresh = args.includes("--fresh");
let profileDir = "data/chrome-profile";
const LF = String.fromCharCode(10);

// Windows will not delete a profile a browser still has open, and the browser
// is often still shutting down. Rather than fight it, start a new profile
// beside it: the point of --fresh is a clean session, not a tidy disk.
if (fresh && existsSync(profileDir)) {
  try {
    rmSync(profileDir, { recursive: true, force: true });
    console.log("cleared the old browser profile");
  } catch {
    profileDir = profileDir + "-" + Date.now().toString(36);
    console.log("the old profile is still in use, so using a new one");
  }
}

const env = loadEnv();
const leagueId = env.ESPN_LEAGUE_ID;
const season = Number(env.ESPN_SEASON || 2026);

function writeCookies(swid, s2) {
  const lines = existsSync(".env") ? readFileSync(".env", "utf8").split(/\r?\n/) : [];
  const set = (key, val) => {
    const i = lines.findIndex((l) => l.startsWith(key + "="));
    if (i >= 0) lines[i] = key + "=" + val;
    else lines.push(key + "=" + val);
  };
  set("ESPN_SWID", swid);
  set("ESPN_S2", s2);
  writeFileSync(".env", lines.filter((l, i) => l !== "" || i < lines.length - 1).join(LF).replace(/\n*$/, "") + LF);
}

/** Whose cookies are these, and what can they see? */
async function identify(swid, s2) {
  if (!leagueId) return "no league id in .env, so the account cannot be checked";
  const H = { accept: "application/json", cookie: "SWID=" + swid + "; espn_s2=" + s2 };
  const url =
    "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/" + season + "/segments/0/leagues/" + leagueId + "?view=mTeam";
  const r = await fetch(url, { headers: H });
  if (!r.ok) return "the league would not load for this account (HTTP " + r.status + ")";
  const j = await r.json();
  const me = (j.members ?? []).find((m) => m.id === swid);
  const team = (j.teams ?? []).find((t) => (t.owners ?? []).includes(swid));
  const name = me ? ((me.firstName ?? "") + " " + (me.lastName ?? "")).trim() || me.displayName : "not a member of this league";
  return name + (team ? "   can see team #" + team.id + " " + (team.name ?? "").trim() : "   owns no team here");
}

console.log("");
console.log("Opening a browser. Sign in as the account the SHOW should use.");
console.log("That is the co-manager account, not the one you draft with.");
console.log("Leave this window open until it says the cookies are captured, then close it.");
console.log("");

const ctx = await chromium.launchPersistentContext(profileDir, {
  channel: "chrome",
  headless: false,
  viewport: null,
  ignoreDefaultArgs: ["--enable-automation"],
  args: ["--start-maximized"],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto("https://www.espn.com/fantasy/football/", { waitUntil: "domcontentloaded" }).catch(() => {});

let last = "";
let captured = false;
const timer = setInterval(async () => {
  try {
    const cookies = await ctx.cookies("https://fantasy.espn.com");
    const swid = cookies.find((c) => c.name === "SWID")?.value;
    const s2 = cookies.find((c) => c.name === "espn_s2")?.value;
    if (!swid || !s2) return;
    const sig = swid + "|" + s2;
    if (sig === last) return;
    last = sig;
    writeCookies(swid, s2);
    const who = await identify(swid, s2);
    console.log("cookies captured:  " + who);
    if (!captured) {
      captured = true;
      console.log("");
      console.log("If that is the wrong account, sign out in the window and sign in again,");
      console.log("or stop this and run:  npm run login -- --fresh");
    }
  } catch {}
}, 3000);

ctx.on("close", () => {
  clearInterval(timer);
  console.log("");
  console.log(captured ? "Done. .env now holds that account's cookies." : "Closed before any cookies were captured.");
  process.exit(0);
});

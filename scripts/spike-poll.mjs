// Phase 0, Test A: does the ESPN v3 league endpoint show picks WHILE the draft
// is live, or only after it completes? (The espn-api maintainer says only after.)
//
// Polls every 2s, logs every new pick with wall-clock time, saves a raw
// snapshot each time the draft state changes. Cookies come from .env only and
// are never logged. Output: spike/out/poll.log + spike/out/snapshot-*.json
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { loadEnv, requireLeague } from "./env.mjs";

const env = loadEnv();
const { id, season } = requireLeague(env);
const url =
  "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/" + season +
  "/segments/0/leagues/" + id + "?view=mDraftDetail&view=mSettings&view=mTeam";
const headers = { accept: "application/json", "user-agent": "Mozilla/5.0 rr-draft-megacast spike" };
const hasCookies = Boolean(env.ESPN_SWID && env.ESPN_S2 && env.ESPN_S2 !== "replace_me");
if (hasCookies) headers.cookie = "SWID=" + env.ESPN_SWID + "; espn_s2=" + env.ESPN_S2;

const out = "spike/out";
mkdirSync(out, { recursive: true });
const ts = () => new Date().toISOString();
const log = (line) => {
  const s = ts() + " " + line;
  console.log(s);
  appendFileSync(out + "/poll.log", s + "\n");
};

const seen = new Set();
let lastSig = "";
let n = 0;
let settingsLogged = false;

async function tick() {
  n++;
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, { headers });
  } catch (e) {
    log("ERR fetch: " + e.message);
    return;
  }
  const ms = Date.now() - t0;
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? "  <- private league: cookies missing or expired?" : "";
    log("HTTP " + res.status + " (" + ms + "ms)" + hint);
    return;
  }
  let j;
  try {
    j = await res.json();
  } catch (e) {
    log("ERR not JSON: " + e.message);
    return;
  }
  if (!settingsLogged) {
    settingsLogged = true;
    const ds = j.settings?.draftSettings ?? {};
    const teams = (j.teams ?? []).map((t) => t.id + ":" + (t.name ?? ((t.location ?? "") + " " + (t.nickname ?? ""))).trim());
    log("league \"" + (j.settings?.name ?? "?") + "\" size=" + (j.settings?.size ?? "?") + " draft=" + JSON.stringify(ds).slice(0, 400));
    log("teams " + teams.join(" | "));
  }
  const dd = j.draftDetail ?? {};
  const picks = Array.isArray(dd.picks) ? [...dd.picks] : [];
  const sig = dd.drafted + "|" + dd.inProgress + "|" + picks.length;
  if (sig !== lastSig) {
    log("STATE drafted=" + dd.drafted + " inProgress=" + dd.inProgress + " picks=" + picks.length + " (" + ms + "ms)");
    writeFileSync(out + "/snapshot-" + String(n).padStart(5, "0") + "-picks" + picks.length + ".json", JSON.stringify(j, null, 2));
    lastSig = sig;
  } else if (n % 15 === 0) {
    log("tick " + n + " unchanged drafted=" + dd.drafted + " inProgress=" + dd.inProgress + " picks=" + picks.length + " (" + ms + "ms)");
  }
  picks.sort((a, b) => (a.overallPickNumber ?? 0) - (b.overallPickNumber ?? 0));
  for (const p of picks) {
    const k = p.overallPickNumber ?? p.roundId + "." + p.roundPickNumber;
    if (seen.has(k)) continue;
    seen.add(k);
    log("PICK #" + k + " r" + p.roundId + "." + p.roundPickNumber + " team=" + p.teamId + " player=" + p.playerId + " auto=" + (p.autoDraftTypeId ?? "-"));
  }
}

log("polling " + url.replace(/leagues\/\d+/, "leagues/<id>") + " every 2s, cookies=" + (hasCookies ? "yes" : "NO") + " (Ctrl+C to stop)");
await tick();
setInterval(tick, 2000);

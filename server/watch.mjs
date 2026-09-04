// Live draft watcher: joins the ESPN draft wire directly (no browser), resolves
// every pick against the cached player table, prints it the instant it lands,
// and logs raw server frames to spike/out/watch-<league>.log. Reconnects with a
// fresh token if the socket drops.
// Usage: node server/watch.mjs [leagueId] [--seconds N]   (cookies from .env)
import { appendFileSync, mkdirSync } from "node:fs";
import { loadEnv } from "../scripts/env.mjs";
import { connectDraft, draftToken, joinUrl } from "./draftwire.mjs";

const env = loadEnv();
const args = process.argv.slice(2);
const leagueId = args.find((a) => /^\d+$/.test(a)) || env.ESPN_LEAGUE_ID;
const secIdx = args.indexOf("--seconds");
const maxSeconds = secIdx >= 0 ? Number(args[secIdx + 1]) : 0;
const cookie = "SWID=" + env.ESPN_SWID + "; espn_s2=" + env.ESPN_S2;
const H = { accept: "application/json", cookie };
const base = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026";
const POS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" };
const NFL = { 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WSH", 29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU" };

mkdirSync("spike/out", { recursive: true });
const logFile = "spike/out/watch-" + leagueId + ".log";
const ts = () => new Date().toISOString();
const say = (line) => console.log(ts().slice(11, 23) + "  " + line);
const raw = (line) => appendFileSync(logFile, ts() + " " + line + "\n");

// League + player table, loaded once.
const t0 = Date.now();
const [league, players] = await Promise.all([
  fetch(base + "/segments/0/leagues/" + leagueId + "?view=mTeam&view=mSettings", { headers: H }).then((r) => r.json()),
  fetch(base + "/players?scoringPeriodId=0&view=kona_player_info", {
    headers: { ...H, "x-fantasy-filter": JSON.stringify({ players: { limit: 1500, sortPercOwned: { sortPriority: 1, sortAsc: false } } }) },
  }).then((r) => r.json()),
]);
const teams = new Map((league.teams ?? []).map((t) => [t.id, (t.name ?? ((t.location ?? "") + " " + (t.nickname ?? ""))).trim()]));
const byId = new Map(players.map((p) => [p.id, p]));
const mine = (league.teams ?? []).find((t) => (t.owners ?? []).includes(env.ESPN_SWID));
if (!mine) {
  console.error("This SWID owns no team in league " + leagueId);
  process.exit(1);
}
say(`league "${league.settings?.name}" · ${teams.size} teams · ${byId.size} players · my team #${mine.id} · loaded in ${Date.now() - t0}ms`);

const name = (pid) => {
  const p = byId.get(pid);
  return p ? `${p.fullName} (${POS[p.defaultPositionId] ?? "?"}, ${NFL[p.proTeamId] ?? p.proTeamId})` : "player " + pid;
};
const team = (tid) => teams.get(tid) ?? "team " + tid;

let picks = 0;
let onClockSince = 0;
let lastClockSay = 0;
let attempt = 0;
let conn = null;
let stopped = false;

async function connect() {
  attempt++;
  const token = await draftToken({ leagueId, teamId: mine.id, cookie });
  const url = joinUrl({ leagueId, teamId: mine.id, swid: env.ESPN_SWID, token });
  say(`connecting (attempt ${attempt})…`);
  conn = connectDraft({
    url,
    onEvent: (kind, detail) => {
      raw("EVENT " + kind + " " + detail);
      if (kind === "open") say("connected — waiting for frames");
      if (kind === "error") say("socket error: " + detail);
      if (kind === "close") {
        say("socket closed: " + detail);
        if (!stopped) setTimeout(connect, Math.min(1000 * attempt, 5000));
      }
    },
    onFrame: (f) => {
      raw("RECV " + (f.cmd === "INIT" ? "INIT <" + f.bytes.length + " bytes>" : f.raw));
      switch (f.cmd) {
        case "INIT":
          say(`INIT ${f.bytes.length} bytes (room snapshot)`);
          break;
        case "JOINED":
          say(`joined as ${team(f.teamId)}`);
          break;
        case "SELECTING":
          onClockSince = Date.now();
          say(`on the clock: ${team(f.teamId)} (${(f.clockMs / 1000).toFixed(0)}s)`);
          break;
        case "SELECTED": {
          picks++;
          const think = onClockSince ? ((Date.now() - onClockSince) / 1000).toFixed(1) + "s" : "";
          say(`PICK ${String(picks).padStart(3)}  ${team(f.teamId).padEnd(28)} → ${name(f.playerId).padEnd(34)} ${think}`);
          onClockSince = 0;
          break;
        }
        case "CLOCK":
          if (Date.now() - lastClockSay > 30000) {
            lastClockSay = Date.now();
            say(`clock ${(f.msLeft / 1000).toFixed(0)}s · ${team(f.teamId)} up`);
          }
          break;
        case "STATE":
          say(`STATE ${f.state}` + (f.state === 2 ? " — draft complete" : ""));
          break;
        case "AUTODRAFT":
          say(`autopick ${f.on ? "ON" : "off"}: ${team(f.teamId)}`);
          break;
        case "TOKEN":
        case "AUTOSUGGEST":
        case "PONG":
          break;
        default:
          say(`frame: ${f.raw.slice(0, 120)}`);
      }
    },
  });
}

await connect();
if (maxSeconds > 0) {
  setTimeout(() => {
    stopped = true;
    say(`stopping after ${maxSeconds}s · ${picks} picks seen · raw frames in ${logFile}`);
    conn?.close();
    setTimeout(() => process.exit(0), 500);
  }, maxSeconds * 1000);
}
process.on("SIGINT", () => {
  stopped = true;
  conn?.close();
  process.exit(0);
});

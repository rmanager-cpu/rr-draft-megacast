// Replay tonight's draft-room WebSocket frames the way the megacast would
// consume them: SELECTED <teamId> <playerId> ... -> "Team took Player (POS, NFL)".
// Names come from a player table fetched ONCE (cached before draft night in the
// real build); team names from the league. Prints wire time, time-on-clock,
// and the resolved pick. Usage: node scripts/spike-replay.mjs [leagueId]
import { readFileSync } from "node:fs";
import { loadEnv } from "./env.mjs";

const env = loadEnv();
const leagueId = process.argv[2] || env.ESPN_LEAGUE_ID;
const cookie = env.ESPN_SWID && env.ESPN_S2 ? "SWID=" + env.ESPN_SWID + "; espn_s2=" + env.ESPN_S2 : undefined;
const H = { accept: "application/json", ...(cookie ? { cookie } : {}) };
const base = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026";
const POS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" };
const NFL = { 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WSH", 29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU" };

const t0 = Date.now();
const [league, players] = await Promise.all([
  fetch(base + "/segments/0/leagues/" + leagueId + "?view=mTeam", { headers: H }).then((r) => r.json()),
  fetch(base + "/players?scoringPeriodId=0&view=kona_player_info", {
    headers: { ...H, "x-fantasy-filter": JSON.stringify({ players: { limit: 1500, sortPercOwned: { sortPriority: 1, sortAsc: false } } }) },
  }).then((r) => r.json()),
]);
const teams = new Map((league.teams ?? []).map((t) => [t.id, (t.name ?? ((t.location ?? "") + " " + (t.nickname ?? ""))).trim()]));
const byId = new Map(players.map((p) => [p.id, p]));
console.log("player table: " + byId.size + " players, " + teams.size + " teams, loaded in " + (Date.now() - t0) + "ms (cached ahead of time in the real build)\n");

const lines = readFileSync("spike/out/ws-frames.log", "utf8").split(/\r?\n/);
let onClockSince = null;
let n = 0;
for (const line of lines) {
  const m = line.match(/^(\S+) p\d+ RECV (SELECTING|SELECTED) (\d+) (\d+)/);
  if (!m) continue;
  if (!line.includes("league-" + leagueId) && !lines.length) continue;
  const [, ts, kind, teamId, arg] = m;
  if (kind === "SELECTING") {
    onClockSince = Date.parse(ts);
    continue;
  }
  const t = Date.parse(ts);
  const p = byId.get(Number(arg));
  const who = p ? p.fullName + " (" + (POS[p.defaultPositionId] ?? "?") + ", " + (NFL[p.proTeamId] ?? p.proTeamId) + ")" : "player " + arg;
  const clock = onClockSince ? ((t - onClockSince) / 1000).toFixed(1) + "s on the clock" : "";
  n++;
  console.log(ts.slice(11, 23) + "  " + String(n).padStart(3) + "  " + (teams.get(Number(teamId)) ?? "team " + teamId).padEnd(28) + " → " + who.padEnd(34) + " " + clock);
  onClockSince = null;
}
console.log("\n" + n + " picks resolved from the wire. Resolution cost per pick: a Map lookup.");

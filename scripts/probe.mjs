// Can we read this league's draft room? Ask, without joining anything.
//
//   npm run probe -- <leagueId>            safe: settings and token only
//   npm run probe -- <leagueId> --connect  also opens the room and reads it
//
// The plain form touches nothing. It reads the league and asks whether the room
// will issue a token. Run it against the REAL league whenever you like: it
// cannot start, alter, or consume a draft.
//
// --connect actually opens the draft-room socket, waits for the room snapshot,
// prints what it found, and disconnects. Use that on a mock lobby, or on the
// real league once the room is open on the night, which is what the show does
// anyway.

import { connectDraft, draftToken, joinUrl } from "../server/draftwire.mjs";
import { decodeInit } from "../server/initdecode.mjs";
import { fetchLeague } from "../server/league.mjs";
import { loadEnv } from "./env.mjs";

const args = process.argv.slice(2);
const leagueId = args.find((a) => /^\d+$/.test(a));
const connect = args.includes("--connect");
const env = loadEnv();
const season = Number(env.ESPN_SEASON || 2026);
const say = (label, value) => console.log("  " + String(label).padEnd(22) + value);

async function main() {
  if (!leagueId) {
    console.error("usage: npm run probe -- <leagueId> [--connect]");
    return 1;
  }
  if (!env.ESPN_SWID || !env.ESPN_S2) {
    console.error("no cookies in .env - the draft room cannot be read without them");
    return 1;
  }
  const cookie = "SWID=" + env.ESPN_SWID + "; espn_s2=" + env.ESPN_S2;

  console.log("");
  console.log("league " + leagueId);
  let league;
  try {
    league = await fetchLeague({ season, leagueId, cookie });
  } catch (e) {
    console.error("  cannot read the league: " + e.message);
    console.error("  401 means the cookies are stale. 404 means the id is wrong, or the league is gone.");
    return 1;
  }

  say("name", league.name);
  say("teams", league.size + " (" + league.teams.length + " listed)");
  say("draft", (league.draftType || "?") + (league.draftDate ? " on " + new Date(league.draftDate).toLocaleString() : ", not scheduled"));
  say("seconds per pick", league.secondsPerPick || "?");
  say("rounds", league.rounds || "?");
  say("keepers", league.keeperCount || 0);
  say("order", league.pickOrder.length ? "set" : "not set yet");
  say("status", "drafted=" + league.drafted + "   in progress=" + league.inProgress);

  const mine = league.teams.find((t) => (t.owners || []).includes(env.ESPN_SWID));
  if (!mine) {
    console.log("");
    console.log("  This account owns no team here, so it cannot join the draft room.");
    console.log("  Add it as a co-manager on one of the teams, then run this again.");
    return 1;
  }
  say("your team", "#" + mine.id + "   " + mine.name);

  // The token endpoint is the gate. If it answers, the wire will work.
  let token;
  try {
    token = await draftToken({ leagueId, teamId: mine.id, cookie, season });
    say("room token", "issued (" + token.length + " characters" + (token.includes(":") ? ", already composite" : "") + ")");
  } catch (e) {
    say("room token", "refused - " + e.message);
    console.log("");
    console.log("  A 404 here usually just means the draft room is not open yet.");
    console.log("  That is expected until shortly before the draft.");
    return 0;
  }

  if (!connect) {
    console.log("");
    console.log("  Everything the show needs is in place.");
    console.log("  Pass --connect to open the room and read it.");
    return 0;
  }

  console.log("");
  console.log("  opening the draft room...");
  const url = joinUrl({ leagueId, teamId: mine.id, swid: env.ESPN_SWID, token });
  let sawInit = false;
  let picks = 0;

  const conn = connectDraft({
    url,
    onEvent: (kind, detail) => console.log("  " + kind + ": " + detail),
    onFrame: (f) => {
      if (f.cmd === "INIT" && !sawInit) {
        sawInit = true;
        const r = decodeInit(f.bytes, { leagueId: Number(leagueId) });
        if (!r.ok) {
          console.log("  room snapshot: could not be read (" + r.reason + ")");
          return;
        }
        const made = r.records.filter((x) => x.playerId !== null).length;
        console.log("  room snapshot: " + r.teams + " teams, " + r.rounds + " rounds, " + r.total + " picks, " + made + " already made");
        console.log("  first round order: " + r.records.slice(0, r.teams).map((x) => x.teamId).join(" "));
      }
      if (f.cmd === "SELECTED") {
        picks++;
        console.log("  pick: team " + f.teamId + " took player " + f.playerId);
      }
      if (f.cmd === "STATE") console.log("  state: " + f.state + (f.state === 2 ? " (draft complete)" : ""));
    },
  });

  const seconds = 45;
  console.log("  listening for " + seconds + " seconds");
  console.log("");
  await new Promise((r) => setTimeout(r, seconds * 1000));
  conn.close();

  console.log("");
  console.log("  " + (sawInit ? "The room snapshot decoded." : "No room snapshot arrived.") + "  " + picks + " picks seen.");
  console.log("  " + (sawInit ? "The wire works on this league." : "Check the cookies, and that the room is actually open."));
  return sawInit ? 0 : 1;
}

process.exitCode = await main();

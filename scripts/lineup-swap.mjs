// Swap two players' lineup slots on the team these cookies manage.
//
//   npm run swap -- "Jefferson" "McConkey"          shows what would move, sends nothing
//   npm run swap -- "Jefferson" "McConkey" --yes    sends it, then reads the roster back
//
// The write is unproven (see server/lineup.mjs), so this always reads first, says
// exactly what will change, and only reports success once a fresh read shows it.

import { loadEnv, requireLeague } from "./env.mjs";
import { fetchMyRoster, planSwap, submitSwap, slotLabel } from "../server/lineup.mjs";

const args = process.argv.slice(2);
const yes = args.includes("--yes");
const names = args.filter((a) => !a.startsWith("--"));
if (names.length !== 2) {
  console.error('usage: npm run swap -- "<player>" "<player>" [--yes]');
  process.exit(1);
}

const env = loadEnv();
const { id: leagueId, season } = requireLeague(env);
if (!env.ESPN_SWID || !env.ESPN_S2 || env.ESPN_S2 === "replace_me") {
  console.error("ESPN_SWID and ESPN_S2 are not set. Changing a lineup needs a member's cookies.");
  process.exit(1);
}
const swid = env.ESPN_SWID;
const cookie = "SWID=" + swid + "; espn_s2=" + env.ESPN_S2;

const roster = await fetchMyRoster({ season, leagueId, cookie, swid });
console.log(`${roster.teamName} (team #${roster.teamId}), scoring period ${roster.scoringPeriodId}`);

const plan = planSwap(roster.entries, names[0], names[1]);
if (!plan.ok) {
  console.error("Not swapping: " + plan.reason);
  process.exit(1);
}
const { a, b } = plan;
console.log(`  ${a.name}: ${slotLabel(a.slot)} -> ${slotLabel(b.slot)}`);
console.log(`  ${b.name}: ${slotLabel(b.slot)} -> ${slotLabel(a.slot)}`);

if (!yes) {
  console.log("Nothing sent. Add --yes to make this change.");
  process.exit(0);
}

const res = await submitSwap({ season, leagueId, cookie, swid, teamId: roster.teamId, scoringPeriodId: roster.scoringPeriodId, items: plan.items });
console.log(`ESPN answered HTTP ${res.status}${res.detail ? " " + res.detail : ""}`);

const after = await fetchMyRoster({ season, leagueId, cookie, swid });
const slotNow = (p) => after.entries.find((e) => e.playerId === p.playerId)?.slot;
const moved = slotNow(a) === b.slot && slotNow(b) === a.slot;
console.log(`  ${a.name} is now at ${slotLabel(slotNow(a))}`);
console.log(`  ${b.name} is now at ${slotLabel(slotNow(b))}`);
console.log(moved ? "Swapped. The write path works." : "The roster did not change. The write did not take.");
process.exit(moved ? 0 : 1);

// The commissioner list, straight from ESPN: draft settings, order, keepers,
// teams to managers, and whether the room hands out a token yet.
//   node scripts/league-info.mjs [leagueId]      (cookies from .env)
//
// npm run probe covers the go/no-go question. This one is for the detail you
// need to fill in the show: who manages which team, and how the draft is set up.

import { loadEnv } from "./env.mjs";

const env = loadEnv();
const id = process.argv[2] || env.ESPN_LEAGUE_ID;
const cookie = env.ESPN_SWID && env.ESPN_S2 ? "SWID=" + env.ESPN_SWID + "; espn_s2=" + env.ESPN_S2 : undefined;
const H = { accept: "application/json", ...(cookie ? { cookie } : {}) };
const season = Number(env.ESPN_SEASON || 2026);
const base =
  "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/" + season + "/segments/0/leagues/" + id;

const PT = (ms) =>
  new Date(ms).toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "full", timeStyle: "short" });
const SLOT = { 0: "QB", 2: "RB", 4: "WR", 6: "TE", 16: "D/ST", 17: "K", 20: "Bench", 21: "IR", 23: "FLEX", 7: "OP", 3: "RB/WR", 5: "WR/TE" };

async function main() {
  const r = await fetch(base + "?view=mSettings&view=mTeam&view=mStatus&view=mDraftDetail", { headers: H });
  if (!r.ok) {
    console.error(
      "HTTP " +
        r.status +
        (r.status === 401 ? "  cookies are stale - sign in again and copy fresh ones into .env" : "") +
        (r.status === 404 ? "  wrong id, or the league is gone. Practice drafts are deleted when they finish." : ""),
    );
    return 1;
  }
  const j = await r.json();
  const s = j.settings ?? {};
  const ds = s.draftSettings ?? {};
  const members = new Map((j.members ?? []).map((m) => [m.id, m]));
  const teamName = (t) => (t.name ?? ((t.location ?? "") + " " + (t.nickname ?? ""))).trim();
  const who = (t) =>
    (t.owners ?? [])
      .map((o) => {
        const m = members.get(o);
        if (!m) return o;
        return ((m.firstName ?? "") + " " + (m.lastName ?? "")).trim() || m.displayName || o;
      })
      .join(" + ") || "- no manager -";

  const slots = s.rosterSettings?.lineupSlotCounts ?? {};
  const rounds = Object.entries(slots)
    .filter(([k, v]) => v > 0 && Number(k) !== 21)
    .reduce((a, [, v]) => a + v, 0);
  const slotLine = Object.entries(slots)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => (SLOT[k] ?? "slot" + k) + " x" + v)
    .join("   ");

  console.log("LEAGUE     " + s.name + "   (id " + id + ")   " + s.size + " teams, joined " + j.status?.teamsJoined + ", full=" + j.status?.isFull);
  console.log("DRAFT      " + (ds.type ?? "?") + "   " + (ds.date ? PT(ds.date) + " PT" : "NOT SCHEDULED") + "   " + ds.timePerSelection + "s per pick   order: " + ds.orderType);
  console.log("ROUNDS     " + rounds + "   (" + slotLine + ")");
  console.log("KEEPERS    " + (ds.keeperCount ?? 0));
  console.log("ORDER      " + (Array.isArray(ds.pickOrder) && ds.pickOrder.length ? ds.pickOrder.join(", ") : "not set"));
  console.log(
    "STATUS     drafted=" + j.draftDetail?.drafted + "   inProgress=" + j.draftDetail?.inProgress + "   prefilled picks=" + (j.draftDetail?.picks ?? []).filter((p) => (p.playerId ?? -1) > 0).length,
  );
  console.log("");
  console.log("TEAMS (draft slot -> team -> manager)");
  const order = Array.isArray(ds.pickOrder) && ds.pickOrder.length ? ds.pickOrder : (j.teams ?? []).map((t) => t.id);
  order.forEach((tid, i) => {
    const t = (j.teams ?? []).find((x) => x.id === tid);
    if (!t) return;
    const mine = env.ESPN_SWID && (t.owners ?? []).includes(env.ESPN_SWID) ? "   <- you" : "";
    console.log("  " + String(i + 1).padStart(2) + ".  #" + String(t.id).padEnd(4) + teamName(t).padEnd(32) + who(t) + mine);
  });
  const lm = [...members.values()]
    .filter((m) => m.isLeagueManager)
    .map((m) => ((m.firstName ?? "") + " " + (m.lastName ?? "")).trim() || m.displayName);
  console.log("LM         " + (lm.join(", ") || "?"));

  // Does the room hand out a token yet? A 404 before draft night is expected.
  const mine = (j.teams ?? []).find((t) => env.ESPN_SWID && (t.owners ?? []).includes(env.ESPN_SWID));
  if (!mine) {
    console.log("");
    console.log("(this account owns no team here, so it cannot join the draft room)");
    return 0;
  }
  const rs = await fetch(base + "/teams/" + mine.id + "/draftSecurity", { headers: H });
  let shape = "";
  try {
    const t = await rs.text();
    shape = t.length > 80 ? t.slice(0, 40) + "...(" + t.length + " chars)" : t;
  } catch {}
  console.log("");
  console.log("draftSecurity for team #" + mine.id + ": HTTP " + rs.status + "   " + (rs.ok ? "token issued (" + shape.trim().length + " characters)" : shape));
  return 0;
}

process.exitCode = await main();

// League metadata: who the teams are, who manages them, and how the draft is set
// up. Cached to disk, because on draft night ESPN being slow must not stop the
// server from starting - it starts, says why it is waiting, and fills in later.

import { readJsonSync, writeAtomicSync } from "./persist.mjs";

const BASE = (season, leagueId) =>
  `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;

const SLOT_LABEL = { 0: "QB", 2: "RB", 4: "WR", 6: "TE", 16: "D/ST", 17: "K", 20: "Bench", 21: "IR", 23: "FLEX" };

export async function fetchLeague({ season, leagueId, cookie, timeoutMs = 10000 }) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(BASE(season, leagueId) + "?view=mSettings&view=mTeam&view=mStatus&view=mDraftDetail", {
      signal: ac.signal,
      headers: { accept: "application/json", ...(cookie ? { cookie } : {}) },
    });
    if (!r.ok) throw new Error("league HTTP " + r.status);
    return shape(await r.json(), leagueId);
  } finally {
    clearTimeout(t);
  }
}

function shape(j, leagueId) {
  const s = j.settings ?? {};
  const ds = s.draftSettings ?? {};
  const members = new Map((j.members ?? []).map((m) => [m.id, m]));
  const managerOf = (t) =>
    (t.owners ?? [])
      .map((o) => {
        const m = members.get(o);
        if (!m) return "";
        return ((m.firstName ?? "") + " " + (m.lastName ?? "")).trim() || m.displayName || "";
      })
      .filter(Boolean)
      .join(" + ");

  const slots = s.rosterSettings?.lineupSlotCounts ?? {};
  const rounds = Object.entries(slots)
    .filter(([k, v]) => v > 0 && Number(k) !== 21)
    .reduce((a, [, v]) => a + v, 0);

  return {
    leagueId: Number(leagueId),
    name: s.name ?? "",
    size: s.size ?? (j.teams ?? []).length,
    rounds,
    rosterSlots: Object.entries(slots)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => (SLOT_LABEL[k] ?? "slot" + k) + " x" + v)
      .join(", "),
    draftType: ds.type ?? "",
    draftDate: ds.date ?? 0,
    secondsPerPick: ds.timePerSelection ?? 0,
    orderType: ds.orderType ?? "",
    keeperCount: ds.keeperCount ?? 0,
    pickOrder: Array.isArray(ds.pickOrder) ? ds.pickOrder : [],
    drafted: !!j.draftDetail?.drafted,
    inProgress: !!j.draftDetail?.inProgress,
    teams: (j.teams ?? []).map((t) => ({
      id: t.id,
      name: (t.name ?? ((t.location ?? "") + " " + (t.nickname ?? ""))).trim(),
      abbrev: t.abbrev ?? "",
      manager: managerOf(t),
      owners: t.owners ?? [],
    })),
  };
}

/** Placeholder league, so replay and synthetic runs have names to draw. */
export function placeholderLeague({ leagueId, teams = 12, rounds = 16, name = "Replay League" }) {
  return {
    leagueId: Number(leagueId) || 0,
    name,
    size: teams,
    rounds,
    rosterSlots: "",
    draftType: "SNAKE",
    draftDate: 0,
    secondsPerPick: 90,
    orderType: "MANUAL",
    keeperCount: 0,
    pickOrder: Array.from({ length: teams }, (_, i) => i + 1),
    drafted: false,
    inProgress: false,
    placeholder: true,
    teams: Array.from({ length: teams }, (_, i) => ({
      id: i + 1,
      name: "Team " + (i + 1),
      abbrev: "T" + (i + 1),
      manager: "Manager " + (i + 1),
      owners: [],
    })),
  };
}

export async function loadLeague({
  season = 2026,
  leagueId,
  cookie,
  cacheFile = "data/league.json",
  onInfo = () => {},
  onWarn = () => {},
  allowPlaceholder = false,
  placeholder = {},
} = {}) {
  if (!leagueId && allowPlaceholder) return placeholderLeague({ leagueId: 0, ...placeholder });
  try {
    const league = await fetchLeague({ season, leagueId, cookie });
    writeAtomicSync(cacheFile, { fetchedAt: new Date().toISOString(), league }, { onWarn });
    onInfo(`league "${league.name}" - ${league.size} teams, ${league.rounds} rounds`);
    return league;
  } catch (e) {
    const cached = readJsonSync(cacheFile);
    if (cached?.league?.leagueId === Number(leagueId)) {
      onWarn(`league: ESPN unreachable (${e.message}); using the cached copy`);
      return cached.league;
    }
    if (allowPlaceholder) {
      onWarn(`league: ESPN unreachable (${e.message}); drawing placeholder teams`);
      return placeholderLeague({ leagueId, ...placeholder });
    }
    throw e;
  }
}

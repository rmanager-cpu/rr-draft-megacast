// Lineup: read a team's roster and swap two players' slots.
//
// The read side is the same v3 league API the show already uses. The write side
// is new and UNPROVEN: it is the request the ESPN website sends when you drag a
// player between slots, a ROSTER transaction posted to lm-api-writes. Until one
// swap has gone through on the real league, treat it as a guess that is easy to
// check, not as a known endpoint.
//
// planSwap is pure, so the refusals are tested without a network. Never log what
// we send: the request carries the member's cookies.

const READS = (season, leagueId) =>
  `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
const WRITES = (season, leagueId) =>
  `https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}/transactions/`;

export const SLOT_LABEL = { 0: "QB", 2: "RB", 4: "WR", 6: "TE", 16: "D/ST", 17: "K", 20: "Bench", 21: "IR", 23: "FLEX" };
export const slotLabel = (id) => SLOT_LABEL[id] ?? "slot " + id;

/** The roster of the team this member manages, plus the current scoring period. */
export async function fetchMyRoster({ season, leagueId, cookie, swid, timeoutMs = 10000 }) {
  const r = await fetch(READS(season, leagueId) + "?view=mRoster&view=mTeam&view=mStatus", {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json", cookie },
  });
  if (!r.ok) throw new Error("roster HTTP " + r.status);
  const j = await r.json();
  const team = (j.teams ?? []).find((t) => (t.owners ?? []).includes(swid));
  if (!team) throw new Error("these cookies manage no team in league " + leagueId);
  const period = j.scoringPeriodId ?? j.status?.latestScoringPeriod;
  const entries = (team.roster?.entries ?? []).map((e) => ({
    playerId: e.playerId,
    slot: e.lineupSlotId,
    name: e.playerPoolEntry?.player?.fullName ?? String(e.playerId),
    eligible: e.playerPoolEntry?.player?.eligibleSlots ?? [],
    locked: Boolean(e.playerPoolEntry?.lineupLocked),
  }));
  const name = (team.name ?? ((team.location ?? "") + " " + (team.nickname ?? ""))).trim();
  return { teamId: team.id, teamName: name, scoringPeriodId: period, entries };
}

/**
 * Decide whether two players can trade slots, and if so what to send. Returns
 * { ok: true, a, b, items } or { ok: false, reason }. Names match on a
 * case-insensitive substring and must each match exactly one rostered player.
 */
export function planSwap(entries, nameA, nameB) {
  const find = (q) => {
    const hits = entries.filter((e) => e.name.toLowerCase().includes(q.toLowerCase()));
    if (hits.length === 1) return { hit: hits[0] };
    if (!hits.length) return { reason: `nobody on this roster matches "${q}"` };
    return { reason: `"${q}" matches ${hits.length} players: ${hits.map((h) => h.name).join(", ")}` };
  };
  const fa = find(nameA);
  if (fa.reason) return { ok: false, reason: fa.reason };
  const fb = find(nameB);
  if (fb.reason) return { ok: false, reason: fb.reason };
  const a = fa.hit;
  const b = fb.hit;
  if (a.playerId === b.playerId) return { ok: false, reason: "both names match the same player, " + a.name };
  if (a.slot === b.slot) {
    return { ok: false, reason: `${a.name} and ${b.name} are both at ${slotLabel(a.slot)}, so swapping them changes nothing` };
  }
  for (const p of [a, b]) {
    if (p.locked) return { ok: false, reason: `${p.name} is locked: his game has started` };
  }
  if (!a.eligible.includes(b.slot)) return { ok: false, reason: `${a.name} cannot play ${slotLabel(b.slot)}` };
  if (!b.eligible.includes(a.slot)) return { ok: false, reason: `${b.name} cannot play ${slotLabel(a.slot)}` };
  const items = [
    { playerId: a.playerId, type: "LINEUP", fromLineupSlotId: a.slot, toLineupSlotId: b.slot },
    { playerId: b.playerId, type: "LINEUP", fromLineupSlotId: b.slot, toLineupSlotId: a.slot },
  ];
  return { ok: true, a, b, items };
}

/** Send the swap. Returns { ok, status, detail } and never echoes the request. */
export async function submitSwap({ season, leagueId, cookie, swid, teamId, scoringPeriodId, items, timeoutMs = 15000 }) {
  const r = await fetch(WRITES(season, leagueId), {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json", "content-type": "application/json", cookie },
    body: JSON.stringify({
      isLeagueManager: false,
      teamId,
      type: "ROSTER",
      memberId: swid,
      scoringPeriodId,
      executionType: "EXECUTE",
      items,
    }),
  });
  let detail = "";
  try {
    const j = await r.json();
    detail = [j.status, j.type, j.message, j.messages?.join?.("; ")].filter(Boolean).join(" ");
  } catch {}
  return { ok: r.ok, status: r.status, detail };
}

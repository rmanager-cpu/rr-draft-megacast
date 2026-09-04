// The player table: one fetch, cached to disk, then a Map lookup per pick.
//
// Anonymous access works for this endpoint, so it is the one thing that does not
// need cookies. It is cached because on draft night the network is a liability,
// not a dependency: a stale table still names every player correctly.
//
// view=players_wl is paged to 50 and is the wrong endpoint. kona_player_info with
// an explicit limit returns the whole thing in about two seconds.

import { readJsonSync, writeAtomicSync } from "./persist.mjs";

const POS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" };
const NFL = {
  0: "FA", 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET",
  9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN",
  17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC",
  25: "SF", 26: "SEA", 27: "TB", 28: "WSH", 29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
};

export const positionOf = (id) => POS[id] ?? "?";
export const proTeamOf = (id) => NFL[id] ?? String(id ?? "");

const URL_FOR = (season) =>
  `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/players?scoringPeriodId=0&view=kona_player_info`;

const FILTER = JSON.stringify({ players: { limit: 2000, sortPercOwned: { sortPriority: 1, sortAsc: false } } });

/** Fetch the table from ESPN. Returns the trimmed rows we actually use. */
export async function fetchPlayers({ season, cookie, timeoutMs = 20000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(URL_FOR(season), {
      signal: ac.signal,
      headers: { accept: "application/json", "x-fantasy-filter": FILTER, ...(cookie ? { cookie } : {}) },
    });
    if (!r.ok) throw new Error("players HTTP " + r.status);
    const raw = await r.json();
    if (!Array.isArray(raw)) throw new Error("players payload was not a list");
    return raw.map(trim);
  } finally {
    clearTimeout(t);
  }
}

function trim(p) {
  const out = {
    id: p.id,
    name: p.fullName,
    pos: positionOf(p.defaultPositionId),
    proTeam: proTeamOf(p.proTeamId),
  };
  // ADP is what orders the highlight catalog and feeds "steal or reach".
  const adp = p.ownership?.averageDraftPosition;
  if (Number.isFinite(adp) && adp > 0) out.adp = Math.round(adp * 10) / 10;
  if (p.seasonOutlook) out.outlook = String(p.seasonOutlook).slice(0, 600);
  return out;
}

/**
 * Load the table, preferring a fresh cache, then the network, then a stale cache.
 * Never throws: a show that cannot name a player still has to put him on the board.
 */
export async function loadPlayers({
  season = 2026,
  cacheFile = "data/players.json",
  maxAgeHours = 24,
  cookie,
  onInfo = () => {},
  onWarn = () => {},
} = {}) {
  const cached = readJsonSync(cacheFile);
  const ageHours = cached?.fetchedAt ? (Date.now() - Date.parse(cached.fetchedAt)) / 3600000 : Infinity;

  if (cached?.players?.length && ageHours < maxAgeHours) {
    onInfo(`players: ${cached.players.length} from cache, ${ageHours.toFixed(1)}h old`);
    return index(cached.players, { source: "cache", ageHours });
  }

  try {
    const players = await fetchPlayers({ season, cookie });
    writeAtomicSync(cacheFile, { fetchedAt: new Date().toISOString(), season, players }, { onWarn });
    onInfo(`players: ${players.length} from ESPN, cached`);
    return index(players, { source: "network", ageHours: 0 });
  } catch (e) {
    if (cached?.players?.length) {
      onWarn(`players: ESPN unreachable (${e.message}); using a cache ${ageHours.toFixed(1)}h old`);
      return index(cached.players, { source: "stale-cache", ageHours });
    }
    onWarn(`players: no table available (${e.message}); picks will show ids`);
    return index([], { source: "none", ageHours: Infinity });
  }
}

function index(players, meta) {
  const byId = new Map(players.map((p) => [p.id, p]));
  const byAdp = players.filter((p) => p.adp).sort((a, b) => a.adp - b.adp);
  return {
    ...meta,
    size: players.length,
    all: players,
    byAdp,
    get(id) {
      return byId.get(id) ?? null;
    },
    name(id) {
      return byId.get(id)?.name ?? "Player " + id;
    },
    /** Loose lookup for the emergency manual-pick field. */
    search(text, limit = 5) {
      const q = String(text).toLowerCase().replace(/[^a-z ]/g, "").trim();
      if (!q) return [];
      const exact = players.filter((p) => p.name.toLowerCase() === q);
      if (exact.length === 1) return exact;
      const starts = players.filter((p) => p.name.toLowerCase().startsWith(q));
      const has = players.filter((p) => p.name.toLowerCase().includes(q));
      return [...new Set([...exact, ...starts, ...has])].slice(0, limit);
    },
  };
}

const SUFFIXES = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v"]);
const PARTICLES = new Set(["st.", "st", "van", "von", "de", "del", "della", "der", "la", "le", "di", "da", "dos"]);

/**
 * Split a name the way a broadcast graphic needs it. "James Cook III" is Cook,
 * not III, and "Texans D/ST" leads with Texans. Getting this wrong puts the
 * word "III" across a television in 21-point bold.
 */
export function splitName(full, pos) {
  const name = String(full ?? "").trim();
  if (!name) return { first: "", last: "", suffix: "" };
  if (pos === "D/ST") return { first: "", last: name.replace(/\s*D\/ST\s*$/i, "").trim() || name, suffix: "" };

  const parts = name.split(/\s+/);
  let suffix = "";
  if (parts.length > 2 && SUFFIXES.has(parts[parts.length - 1].toLowerCase())) suffix = parts.pop();
  if (parts.length === 1) return { first: "", last: parts[0], suffix };
  // Particles belong to the surname: Amon-Ra St. Brown is a St. Brown.
  let last = parts.pop();
  while (parts.length > 1 && PARTICLES.has(parts[parts.length - 1].toLowerCase())) last = parts.pop() + " " + last;
  return { first: parts.join(" "), last, suffix };
}

// The show. One process: reads the draft, keeps the board, feeds the TVs.
//
//   node server/main.mjs --source replay --speed 1        the recorded 8/29 draft
//   node server/main.mjs --source replay --step           one pick at a time
//   node server/main.mjs --source live                    the real thing
//
// Boot order matters. The HTTP server comes up before any network call, so that
// if ESPN is slow at a quarter to seven the operator sees on /status exactly what
// is being waited on, instead of a blank window.

import { loadEnv } from "../scripts/env.mjs";
import { createBus } from "./bus.mjs";
import { createHttp } from "./http.mjs";
import { createSse } from "./sse.mjs";
import { createState } from "./state.mjs";
import { createReconciler } from "./reconcile.mjs";
import { createFrameHandler } from "./pipeline.mjs";
import { createReplaySource } from "./src-replay.mjs";
import { loadPlayers, splitName } from "./players.mjs";
import { loadLeague, placeholderLeague } from "./league.mjs";
import { createReveal } from "./reveal.mjs";
import { createHeadshots } from "./headshots.mjs";
import { readJsonSync } from "./persist.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf("--" + name);
  if (i < 0) return fallback;
  const next = args[i + 1];
  return next && !next.startsWith("--") ? next : true;
};
const has = (name) => args.includes("--" + name);

const env = loadEnv();
const SEASON = Number(env.ESPN_SEASON || 2026);
const PORT = Number(flag("port", 7788));
const HOST = String(flag("host", "127.0.0.1"));
const SOURCE = String(flag("source", "replay"));
const SPEED = Number(flag("speed", 1));

const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(ts(), ...a);

const bus = createBus({ onError: (e, ev) => log("bus handler failed on", ev + ":", e.message) });

let league = placeholderLeague({ leagueId: 0, teams: 12, rounds: 16, name: "starting up" });
let players = null;
let reconciler = null;
let source = null;

const state = createState({
  season: SEASON,
  leagueId: Number(env.ESPN_LEAGUE_ID || 0),
  bus,
  onWarn: (w) => log("persist:", w),
});
state.apply((s) => {
  s.source = SOURCE;
  s.simulated = SOURCE !== "live";
});

const sse = createSse({ state });
const showConfig = readJsonSync("data/show.config.json", {}) ?? {};
const headshots = createHeadshots({ onWarn: (w) => log("headshots:", w) });

// TV 2. The server owns the queue and the clock; the browser just plays what it
// is told and holds until the deadline it was given.
const reveal = createReveal({
  config: showConfig.reveal ?? {},
  onReveal: (e) => {
    state.touch((s) => {
      s.reveal.current = { pick: e.pick, mode: e.mode, endsAt: e.endsAt };
      s.reveal.queueDepth = e.queueDepth;
      s.reveal.revealed = reveal.revealed();
    });
    sse.send("reveal", { ...e, serverTime: Date.now() });
    bus.emit("reveal:start", e);
  },
  onCut: (e) => sse.send("revealcut", e),
  onDone: (e) => {
    state.touch((s) => {
      s.reveal.current = null;
      s.reveal.queueDepth = reveal.depth();
    });
    sse.send("revealdone", e);
  },
  onCatchup: (e) => sse.send("catchup", e),
});

// ------------------------------------------------------------- card building

function cardFor(pick) {
  const p = players?.get(pick.playerId);
  const team = league.teams.find((t) => t.id === pick.teamId);
  const full = p?.name ?? "Player " + pick.playerId;
  const parts = splitName(full, p?.pos);
  return {
    pick: pick.pick,
    round: pick.round,
    slotInRound: pick.slotInRound,
    teamId: pick.teamId,
    teamName: team?.name ?? "Team " + pick.teamId,
    manager: team?.manager ?? "",
    playerId: pick.playerId,
    name: full,
    firstName: parts.first,
    lastName: parts.last,
    suffix: parts.suffix,
    pos: p?.pos ?? "?",
    proTeam: p?.proTeam ?? "",
    adp: p?.adp ?? null,
    source: pick.source,
    isKeeper: pick.source === "keeper",
  };
}

/** Everything a freshly opened or reloaded TV needs to draw the whole show. */
function hello() {
  const s = state.state;
  return {
    serverTime: Date.now(),
    version: state.version,
    league: { name: league.name, teams: league.teams, rounds: s.draft.rounds || league.rounds },
    phase: s.phase,
    connection: s.connection,
    onClock: s.onClock,
    order: Array.from(s.draft.order ?? []),
    picks: s.picks.map(cardFor),
    gaps: s.gaps,
    counters: s.counters,
    launch: s.launch,
    reveal: reveal.current() ? { ...reveal.current(), queueDepth: reveal.depth() } : null,
    simulated: s.simulated,
    source: s.source,
  };
}

// -------------------------------------------------------------- wire handling

function startReconciler(room) {
  reconciler = createReconciler({
    season: SEASON,
    leagueId: room.leagueId,
    teamCount: room.teams,
    rounds: room.rounds,
    onWarn: (w) => {
      log("reconcile:", w);
      state.warn(w);
    },
    onGap: (picks) => {
      log("gap: missed picks", picks.join(", "));
      state.adoptReconciler(reconciler);
      sse.send("gap", { picks, version: state.version });
    },
    onCorrection: ({ pick, was, now }) => {
      log("correction at pick " + pick + ": " + was.playerId + " -> " + now.playerId);
      state.adoptReconciler(reconciler);
      sse.send("correction", { pick, was: cardFor(was), now: cardFor(now), version: state.version });
    },
    onPick: (list, opts) => {
      const catchup = !!(opts && opts.catchup);
      state.adoptReconciler(reconciler);
      state.recordPicks(list);
      for (const p of list) {
        const card = cardFor(p);
        log("PICK " + String(p.pick).padStart(3) + "  R" + p.round + "  " + card.teamName + " -> " + card.name + " (" + card.pos + " " + card.proTeam + ")");
        sse.send("preload", { playerId: p.playerId, proTeam: card.proTeam });
        sse.send("pick", { ...card, catchup, version: state.version });
        bus.emit("pick", { pick: p, card, catchup });
      }
      // A batch learned at once is a reconnect filling in what we missed. Showing
      // them one by one would put the studio minutes behind the room.
      if (catchup && list.length > 1) reveal.enqueueCatchup(list.map(cardFor));
      else for (const p of list) reveal.enqueue(cardFor(p));
      if (reconciler.complete) finish();
    },
  });
}

function finish() {
  if (state.state.phase === "complete") return;
  state.apply((s) => (s.phase = "complete"));
  sse.send("status", { phase: "complete", version: state.version });
  bus.emit("complete", {});
}

const handleFrame = createFrameHandler({
  getReconciler: () => reconciler,
  leagueId: 0,
  isPreDraft: () => SOURCE === "live" && !league.inProgress && !league.drafted,
  onWarn: (w) => {
    log("warn:", w);
    state.warn(w);
    sse.send("status", { warning: w, version: state.version });
  },
  onRoomSnapshot: (room) => {
    if (reconciler) return;
    // The room itself says how many teams and how many rounds this draft has.
    if (league.placeholder) {
      league = placeholderLeague({
        leagueId: room.leagueId,
        teams: room.teams,
        rounds: room.rounds,
        name: "Replay League",
      });
    }
    state.apply((s) => {
      s.leagueId = room.leagueId;
      s.leagueName = league.name;
      s.draft.teamCount = room.teams;
      s.draft.rounds = room.rounds;
      s.draft.teams = league.teams;
      if (s.phase === "boot") s.phase = "pre";
    });
    startReconciler(room);
  },
  onSelecting: ({ teamId, clockMs }) => {
    state.touch((s) => (s.onClock = { teamId, msLeft: clockMs, at: Date.now() }));
    sse.send("onclock", { teamId, version: state.version });
    bus.emit("onclock", { teamId });
  },
  onClock: ({ teamId, msLeft }) => {
    state.touch((s) => (s.onClock = { teamId, msLeft, at: Date.now() }));
    sse.send("clock", { teamId, msLeft }, { volatile: true });
  },
  onState: (n) => {
    log("wire STATE " + n + (n === 2 ? " - draft complete" : ""));
    if (n === 2) finish();
  },
});

// -------------------------------------------------------------------- routes

const routes = {
  "GET /events": ({ req, res, url }) => {
    sse.attach(req, res, { display: url.searchParams.get("display") ?? "ops", hello });
  },
  "GET /img/headshot/:id": (ctx) => headshots.serve(ctx),
  "GET /api/state": ({ json }) => json(200, hello()),
  "GET /api/health": ({ json }) =>
    json(200, {
      ok: true,
      version: state.version,
      phase: state.state.phase,
      connection: state.state.connection,
      committed: state.state.counters.committed,
      uptimeSec: Math.round(process.uptime()),
      displays: sse.counts(),
    }),
  "POST /api/register": ({ body, json }) => {
    const display = String(body.display ?? "");
    state.apply((s) => {
      s.launch.displays[display] = {
        at: Date.now(),
        screen: body.screen ?? "",
        fullscreen: !!body.fullscreen,
        audioArmed: !!body.audioArmed,
      };
    });
    log("display registered:", display, body.screen ?? "");
    return json(200, { ok: true, version: state.version });
  },
  "GET /api/ack": ({ url, json }) => {
    const display = url.searchParams.get("display") ?? "";
    const v = Number(url.searchParams.get("v") ?? 0);
    state.touch((s) => {
      const d = s.launch.displays[display];
      if (d) {
        d.lastSeen = Date.now();
        d.acked = v;
      }
    });
    return json(200, { ok: true, version: state.version });
  },
  "POST /api/pick": ({ body, json }) => {
    if (!reconciler) return json(409, { ok: false, reason: "the draft has not started" });
    const teamId = Number(body.teamId);
    let playerId = Number(body.playerId);
    if (!playerId && body.playerName) {
      const hits = players ? players.search(body.playerName) : [];
      if (hits.length !== 1) return json(409, { ok: false, reason: "which one?", candidates: hits });
      playerId = hits[0].id;
    }
    const res = reconciler.manualPick({ teamId, playerId });
    if (res.ok) log("MANUAL pick entered: team " + teamId + " -> " + (players ? players.name(playerId) : playerId));
    return json(res.ok ? 200 : 409, res);
  },
  "POST /api/dev/speed": ({ body, json }) => {
    if (!source || !source.simulated) return json(403, { ok: false });
    source.setSpeed(Number(body.speed ?? 1));
    return json(200, { ok: true });
  },
  "POST /api/dev/step": ({ body, json }) => {
    if (!source || !source.simulated) return json(403, { ok: false });
    const n = Number(body.picks ?? 1);
    for (let i = 0; i < n; i++) source.stepPick();
    return json(200, { ok: true, position: source.position });
  },
};

const { server } = createHttp({ routes, onError: (e) => log("http:", e.message) });

// ---------------------------------------------------------------------- boot

// A port already in use at boot is fatal and must say so plainly. The catch-all
// handlers below are for keeping a running show alive, not for hiding a server
// that never started - that way lies verifying against yesterday's process.
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error("port " + PORT + " is already in use - another show server is running. Stop it, or pass --port.");
    process.exit(1);
  }
  console.error("server error:", e.message);
  process.exit(1);
});

server.listen(PORT, HOST, async () => {
  log("show server on http://" + HOST + ":" + PORT + "   board /board   studio /studio   ops /status");

  players = await loadPlayers({ season: SEASON, onInfo: log, onWarn: (w) => log("warn:", w) });

  if (SOURCE === "live") {
    league = await loadLeague({
      season: SEASON,
      leagueId: env.ESPN_LEAGUE_ID,
      cookie: "SWID=" + env.ESPN_SWID + "; espn_s2=" + env.ESPN_S2,
      onInfo: log,
      onWarn: (w) => log("warn:", w),
      allowPlaceholder: true,
    });
    state.apply((s) => {
      s.leagueName = league.name;
      s.draft.secondsPerPick = league.secondsPerPick;
      s.draft.keeperCount = league.keeperCount;
      s.draft.teams = league.teams;
    });
    log("the live wire is not attached in this build yet - use --source replay");
    return;
  }

  source = createReplaySource({
    speed: SPEED,
    step: has("step"),
    from: Number(flag("from", 0)),
    onFrame: handleFrame,
    onEvent: (kind, detail) => {
      log("wire " + kind + ": " + detail);
      state.touch((s) => {
        if (kind === "open") s.connection.status = "connected";
        if (kind === "close") s.connection.status = "reconnecting";
        s.connection.detail = String(detail);
        s.connection.since = Date.now();
        s.connection.lastFrameAt = Date.now();
      });
      sse.send("status", { connection: state.state.connection, version: state.version });
    },
  });
  if (has("drop-at")) {
    source.injectFault("drop", { atPick: Number(flag("drop-at", 45)), picks: Number(flag("drop-picks", 8)) });
    log("fault armed: going dark for " + Number(flag("drop-picks", 8)) + " picks at pick " + Number(flag("drop-at", 45)));
  }
  await source.start();
});

process.on("unhandledRejection", (e) => log("unhandled rejection:", (e && e.message) || e));
process.on("uncaughtException", (e) => log("uncaught exception:", (e && e.message) || e));
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log("shutting down");
    try {
      state.save();
      if (source) source.close();
      sse.close();
    } finally {
      process.exit(0);
    }
  });
}

// The show. One process: reads the draft, keeps the board, feeds the TVs.
//
//   node server/main.mjs --source replay --speed 1        the recorded 8/29 draft
//   node server/main.mjs --source replay --step           one pick at a time
//   node server/main.mjs --source live                    the real thing
//
// Boot order matters. The HTTP server comes up before any network call, so that
// if ESPN is slow at a quarter to seven the operator sees on /status exactly what
// is being waited on, instead of a blank window.

import { readFileSync } from "node:fs";
import { loadEnv } from "../scripts/env.mjs";
import { createBus } from "./bus.mjs";
import { createHttp } from "./http.mjs";
import { createSse } from "./sse.mjs";
import { createState } from "./state.mjs";
import { createReconciler } from "./reconcile.mjs";
import { createFrameHandler } from "./pipeline.mjs";
import { createReplaySource } from "./src-replay.mjs";
import { createLiveSource } from "./src-live.mjs";
import { createSynthSource } from "./src-synth.mjs";
import { createRoomSource } from "./src-room.mjs";
import { loadPlayers, splitName } from "./players.mjs";
import { loadLeague, placeholderLeague } from "./league.mjs";
import { createReveal } from "./reveal.mjs";
import { createHeadshots } from "./headshots.mjs";
import { CLIP_DIR, createHighlights, isVideoName, localClip, localClipCount } from "./highlights.mjs";
import { createWriteStream, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { createReadStream, rmSync, statSync } from "node:fs";
import { ensureDir } from "./persist.mjs";
import { readJsonSync } from "./persist.mjs";
import { createLaunch, registerCoreChecks } from "./launch.mjs";
import { createAudio, KIND } from "./audio.mjs";
import { createBooth } from "./booth.mjs";
import { createInterjectPolicy } from "./interject-policy.mjs";
import { createWriter } from "./booth-writer.mjs";
import { createVoice } from "./booth-voice.mjs";

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
// A practice draft inside the home league may run under its own id. Pointing the
// show at one should not mean editing .env and forgetting to change it back.
const LEAGUE_ID = Number(flag("league", env.ESPN_LEAGUE_ID || 0));

const NL = String.fromCharCode(10);
const SEP = NL + NL + "---" + NL + NL;

function readTextOr(path, fallback) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fallback;
  }
}

const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(ts(), ...a);

const bus = createBus({ onError: (e, ev) => log("bus handler failed on", ev + ":", e.message) });

let league = placeholderLeague({ leagueId: 0, teams: 12, rounds: 16, name: "starting up" });
let restored = null;
let players = null;
let reconciler = null;
let source = null;

const state = createState({
  season: SEASON,
  leagueId: LEAGUE_ID,
  bus,
  onWarn: (w) => log("persist:", w),
});
state.apply((s) => {
  s.source = SOURCE;
  s.simulated = SOURCE !== "live";
});

if (!has("fresh")) {
  const saved = state.restore();
  if (saved?.picks?.length) {
    restored = {
      season: saved.season,
      leagueId: saved.leagueId,
      teamCount: saved.draft.teamCount,
      rounds: saved.draft.rounds,
      order: saved.draft.order,
      picks: saved.picks,
      counters: saved.counters,
      orderSource: "restored",
    };
    state.apply((s) => {
      s.leagueId = saved.leagueId;
      s.leagueName = saved.leagueName;
      s.draft = saved.draft;
      s.picks = saved.picks;
      s.gaps = saved.gaps ?? [];
      s.counters = saved.counters;
      s.phase = saved.phase === "complete" ? "complete" : "pre";
    });
    log("restored " + saved.picks.length + " picks from the last run");
  }
}

const sse = createSse({ state });
const showConfig = readJsonSync("data/show.config.json", {}) ?? {};
const launch = createLaunch({ state, sse, onInfo: log });

// One speaker. Nothing overlaps, a recap is never interrupted, and a browser
// that never reports back cannot leave the channel wedged for the rest of the
// draft - every line has a deadline after which the channel frees itself.
const audio = createAudio({
  onPlay: (item) => {
    log("say [" + item.kind + "] " + String(item.text).slice(0, 90));
    sse.send("say", { id: item.id, kind: item.kind, text: item.text, audioUrl: item.audioUrl });
  },
  onDropped: (item) => log("dropped [" + item.kind + "] " + item.reason),
});

const writer = createWriter({
  apiKey: env.ANTHROPIC_API_KEY,
  // The booth knows two things: how it behaves, and who these people are.
  bible: [readTextOr("data/bible.md", ""), readTextOr("data/lore.md", "")].filter(Boolean).join(SEP),
  onWarn: (w) => { log("warn:", w); state.warn(w); },
  onInfo: log,
});
const voice = createVoice({
  apiKey: env.ELEVENLABS_API_KEY,
  voices: Object.fromEntries(Object.entries(showConfig.voices ?? {}).filter(([k, v]) => k !== "_" && v)),
  onWarn: (w) => log("warn:", w),
});
const playerNotes = readJsonSync("data/player-notes.json", {}) ?? {};
const loreText = readTextOr("data/lore.md", "");
const booth = createBooth({
  audio,
  writer,
  voice,
  config: showConfig,
  getLeague: () => league,
  notesFor: (id) => playerNotes[String(id)] ?? "",
  lore: loreText,
  onWarn: (w) => { log("booth:", w); state.warn(w); },
  onInfo: log,
});
const headshots = createHeadshots({ onWarn: (w) => log("headshots:", w) });
const highlights = createHighlights({ onWarn: (w) => log("highlights:", w), onInfo: log });

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
reveal.setContentProvider((card) => highlights.contentFor(card));

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
    buildId: state.buildId,
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

      // The speaker follows the board, and never the other way round.
      if (!catchup) {
        for (const p of list) {
          const card = cardFor(p);
          booth.callPick(card).catch((e) => log("booth call:", e.message));
          maybeInterject(card);
        }
      }
      checkRoundBoundary();
      if (reconciler.complete) finish();
    },
  });
}

// ------------------------------------------------------------- booth schedule
//
// Quiet during picks, talking at the round boundaries. The recap is the show, so
// it is never interrupted and it is allowed to take its time; a pick landing
// mid-recap still reveals on the TVs with its call suppressed, and the next
// recap covers it.

const recapRounds = new Set(showConfig.recapAfterRounds ?? [1, 2, 4, 6, 8, 10, 12, 14, 16]);
const recapped = new Set();

function checkRoundBoundary() {
  if (!reconciler) return;
  const snap = reconciler.snapshot();
  const perRound = snap.teamCount;
  if (!perRound) return;
  const done = snap.picks.length;
  const completeRounds = Math.floor(done / perRound);
  for (let r = 1; r <= completeRounds; r++) {
    if (recapped.has(r) || !recapRounds.has(r)) continue;
    // Only recap a round we have every pick for; a gap means wait for the heal.
    const picks = snap.picks.filter((p) => p.round === r);
    if (picks.length !== perRound) continue;
    recapped.add(r);
    const isFinal = completeRounds === snap.rounds && r === snap.rounds;
    const seconds = r <= 2 ? showConfig.recapSeconds?.early ?? 70 : showConfig.recapSeconds?.later ?? 100;
    log("booth: recap after round " + r + (isFinal ? " (final)" : ""));
    booth
      .recap({ picks: picks.map(cardFor), round: r, isFinal, seconds })
      .catch((e) => log("booth recap:", e.message));
  }
}

const interjectPolicy = createInterjectPolicy({ config: showConfig.interjections ?? {} });
const bitsPlayed = new Set();

function bitFor(teamId) {
  if (!reconciler) return null;
  const pick = reconciler.cursor;
  const snap = reconciler.snapshot();
  if (!snap.teamCount) return null;
  const round = Math.ceil(pick / snap.teamCount);
  const team = league.teams.find((t) => t.id === teamId);
  if (!team) return null;
  const key = teamId + ":" + round;
  if (bitsPlayed.has(key)) return null;

  const bit = (showConfig.bits ?? []).find(
    (b) =>
      b &&
      b.text &&
      Number(b.round) === round &&
      String(b.manager || "").toLowerCase() === String(team.manager || "").toLowerCase(),
  );
  if (!bit) return null;
  bitsPlayed.add(key);
  return bit;
}

/** A live reaction. Perishable, capped, and dropped rather than said late. */
function maybeInterject(card) {
  const context = runContext(card);
  const verdict = interjectPolicy.decide(card, context, { talkingOver: audio.talkingOver });
  if (!verdict.go) return;
  interjectPolicy.spent(card);
  booth.interject(card, context).then(
    (r) => {
      if (!r || !r.queued) log("interjection dropped: " + ((r && r.reason) || "unknown"));
    },
    (e) => log("booth interject:", e.message),
  );
}

/** How many of the last few picks were the same position. */
function runContext(card) {
  const snap = reconciler?.snapshot();
  if (!snap) return { runLength: 0 };
  const recent = snap.picks.slice(-6, -1).map(cardFor);
  let runLength = 1;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].pos !== card.pos) break;
    runLength++;
  }
  const firstOfPosition = !snap.picks.slice(0, -1).map(cardFor).some((c) => c.pos === card.pos);
  return { runLength, firstOfPosition };
}

function finish() {
  if (state.state.phase === "complete") return;
  state.apply((s) => (s.phase = "complete"));
  sse.send("status", { phase: "complete", version: state.version });
  bus.emit("complete", {});

  const snap = reconciler?.snapshot();
  if (!snap || !snap.picks.length) return;
  log("booth: final recap");
  booth
    .recap({ picks: snap.picks.slice(-snap.teamCount).map(cardFor), round: snap.rounds, isFinal: true, seconds: 120 })
    .catch((e) => log("booth final:", e.message));
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
    if (restored && restored.leagueId === room.leagueId && restored.picks.length) {
      reconciler.restore(restored);
      log("carried " + restored.picks.length + " picks across the restart");
      restored = null;
    }
  },
  onSelecting: ({ teamId, clockMs }) => {
    state.touch((s) => (s.onClock = { teamId, msLeft: clockMs, at: Date.now() }));
    sse.send("onclock", { teamId, version: state.version });
    bus.emit("onclock", { teamId });

    const bit = bitFor(teamId);
    if (bit) {
      log("bit for " + bit.manager + ", round " + bit.round);
      booth
        .say(KIND.BIT, bit.text, { meta: { manager: bit.manager, round: bit.round } })
        .catch((e) => log("bit:", e.message));
    }
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

// Video, from this disk, with range support. Range matters: without it the
// browser downloads from the beginning before it can seek, which is the whole
// latency problem we moved to local files to avoid.
const CLIP_MIME = { ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/mp4" };

function serveClip(req, res, file) {
  if (!existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  const size = statSync(file).size;
  const type = CLIP_MIME[extname(file).toLowerCase()] ?? "video/mp4";
  const range = req.headers.range;
  if (range) {
    const spec = String(range).split("=")[1] || "";
    const dash = spec.indexOf("-");
    const from = dash > 0 ? spec.slice(0, dash).trim() : spec.trim();
    const to = dash >= 0 ? spec.slice(dash + 1).trim() : "";
    const start = from ? Number(from) : 0;
    const end = to ? Number(to) : size - 1;
    if (start >= size) {
      res.writeHead(416, { "Content-Range": "bytes */" + size });
      return res.end();
    }
    res.writeHead(206, {
      "Content-Type": type,
      "Content-Range": "bytes " + start + "-" + end + "/" + size,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Cache-Control": "max-age=86400",
    });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": size,
    "Accept-Ranges": "bytes",
    "Cache-Control": "max-age=86400",
  });
  return createReadStream(file).pipe(res);
}
// -------------------------------------------------------------------- routes

function wireEvent(kind, detail) {
  log("wire " + kind + ": " + detail);
  state.touch((s) => {
    if (kind === "open") {
      s.connection.status = "connected";
      s.connection.attempts = 0;
    }
    if (kind === "close") s.connection.status = "reconnecting";
    if (kind === "error") s.connection.attempts = (s.connection.attempts || 0) + 1;
    s.connection.detail = String(detail);
    s.connection.since = Date.now();
    s.connection.lastFrameAt = Date.now();
  });
  sse.send("status", { connection: state.state.connection, version: state.version });
}

const routes = {
  "GET /events": ({ req, res, url }) => {
    sse.attach(req, res, { display: url.searchParams.get("display") ?? "ops", hello });
  },
  "GET /img/headshot/:id": (ctx) => headshots.serve(ctx),
  "GET /audio/:name": ({ res, params }) => serveStatic(res, "../data/audio/cache/" + params.name),
  "POST /api/audio-done": ({ body, json }) => {
    audio.done(String(body.id ?? ""));
    return json(200, { ok: true });
  },
  "GET /api/checks": async ({ json }) => json(200, await launch.evaluate()),
  "GET /api/catalog": ({ url, json }) => {
    const limit = Number(url.searchParams.get("limit") ?? 120);
    const rows = (players?.byAdp ?? []).slice(0, limit).map((p) => ({
      playerId: p.id,
      name: p.name,
      pos: p.pos,
      proTeam: p.proTeam,
      adp: p.adp,
      clip: highlights.all[String(p.id)] ?? null,
      local: !!localClip(p.id),
    }));
    return json(200, { total: players?.byAdp?.length ?? 0, withClips: highlights.size, rows });
  },
  "POST /api/catalog": ({ body, json }) => {
    const res = highlights.set(Number(body.playerId), {
      videoId: body.url ?? body.videoId,
      start: body.start,
      ceilingMs: body.ceilingMs,
      title: body.title,
      note: body.note,
    });
    return json(res.ok ? 200 : 400, res);
  },
  "POST /api/catalog/remove": ({ body, json }) => json(200, highlights.remove(Number(body.playerId))),
  "POST /api/catalog/preflight": async ({ json }) => json(200, await highlights.preflight()),

  // A video file, straight to disk. Streamed rather than buffered, because a
  // highlight is megabytes and there is no reason for it to pass through memory.
  "RAW POST /api/clip/:playerId": ({ req, res, params, json }) => {
    const playerId = Number(params.playerId);
    // Percent-encoded by the browser, because a header cannot carry anything
    // outside Latin-1 and filenames routinely do.
    let name = String(req.headers["x-filename"] ?? "clip.mp4");
    try {
      name = decodeURIComponent(name);
    } catch {}
    if (!playerId || !isVideoName(name)) return json(400, { ok: false, reason: "not a video file" });
    ensureDir(CLIP_DIR);
    const dest = join(CLIP_DIR, String(playerId) + extname(name).toLowerCase());
    const out = createWriteStream(dest);
    req.pipe(out);
    out.on("finish", () => {
      const local = localClip(playerId);
      log("clip saved: " + (local ? local.name + "  " + Math.round(local.bytes / 1024) + " KB" : dest));
      json(200, { ok: true, bytes: local ? local.bytes : 0 });
    });
    out.on("error", (e) => json(500, { ok: false, reason: e.message }));
  },

  // Served from this disk, with range support so the browser can seek instantly.
  "GET /clip/:name": ({ req, res, params }) => {
    const name = String(params.name);
    if (!isVideoName(name) || name.includes("..")) {
      res.writeHead(404);
      return res.end();
    }
    return serveClip(req, res, join(CLIP_DIR, name));
  },
  "POST /api/clip/remove": ({ body, json }) => {
    const local = localClip(Number(body.playerId));
    if (local) rmSync(local.file, { force: true });
    return json(200, { ok: true });
  },
  "POST /api/launch": async ({ body, json }) => {
    const gate = await launch.evaluate();
    if (!gate.ready && !body.force) return json(409, { ok: false, reason: "not all checks are green", checks: gate.checks });
    const res = launch.launch({ force: !!body.force });
    if (res.ok) booth.open().catch((e) => log("booth open:", e.message));
    return json(200, res);
  },
  "POST /api/audio-test": ({ json }) => {
    sse.send("say", { text: "River Ranch draft booth. Testing, one, two.", test: true });
    return json(200, { ok: true });
  },
  "POST /api/audio-confirm": ({ body, json }) => {
    state.apply((s) => (s.launch.audioConfirmed = body.heard !== false));
    return json(200, { ok: true });
  },
  "POST /api/resync": ({ json }) => {
    // Force a reconnect so a fresh room snapshot heals whatever we are missing.
    if (!source) return json(409, { ok: false, reason: "no source" });
    if (source.simulated) return json(409, { ok: false, reason: "the replay source reconnects on its own schedule" });
    source.close();
    source.start().catch((e) => log("resync failed:", e.message));
    return json(200, { ok: true });
  },
  "GET /api/state": ({ json }) => json(200, hello()),
  "GET /api/health": ({ json }) =>
    json(200, {
      ok: true,
      version: state.version,
      phase: state.state.phase,
      connection: state.state.connection,
      committed: state.state.counters.committed,
      uptimeSec: Math.round(process.uptime()),
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
      audio: audio.counts(),
      reveal: { depth: reveal.depth(), revealed: reveal.revealed() },
      booth: booth.stats(),
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
    state.touch((s) => {
      const d = s.launch.displays[display];
      if (!d) return;
      d.lastSeen = Date.now();
      d.acked = Number(url.searchParams.get("v") ?? 0);
      d.build = url.searchParams.get("build") ?? "";
    });
    return json(200, { ok: true, version: state.version, buildId: state.buildId });
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

const { server, serveStatic } = createHttp({ routes, onError: (e) => log("http:", e.message) });

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

  players = await loadPlayers({
    season: SEASON,
    // An individual-defensive-player league would set this in the show config.
    draftable: showConfig.draftablePositions,
    onInfo: log,
    onWarn: (w) => log("warn:", w),
  });
  registerCoreChecks(launch, { state, getSource: () => source, players });
  launch.registerCheck("catalog", {
    label: "Highlight catalogue",
    blocking: false,
    run: () => {
      const local = localClipCount();
      if (!highlights.size && !local) return { ok: true, na: true, detail: "no clips - every pick gets its card" };
      if (local) return { ok: true, detail: local + " clips on this disk" + (highlights.size ? ", " + highlights.size + " catalogued" : "") };
      const stale = Object.values(highlights.all).filter((c) => c.videoId && !c.disabled && !c.verifiedAt).length;
      if (stale) return { ok: false, detail: stale + " clips unverified - run the preflight on /curate" };
      return { ok: true, detail: highlights.size + " clips verified" };
    },
  });

  if (SOURCE === "live") {
    league = await loadLeague({
      season: SEASON,
      leagueId: LEAGUE_ID,
      cookie: "SWID=" + env.ESPN_SWID + "; espn_s2=" + env.ESPN_S2,
      excludeOwner: env.ESPN_SWID,
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
    const mine = league.teams.find((t) => (t.owners || []).includes(env.ESPN_SWID));
    if (!mine) {
      log("this ESPN account owns no team in league " + LEAGUE_ID + " - it must be a member to join the draft room");
      state.warn("the watcher account owns no team in this league");
      return;
    }
    log("joining the draft room as team #" + mine.id + " (" + mine.name + ")");
    source = createLiveSource({
      leagueId: LEAGUE_ID,
      teamId: mine.id,
      swid: env.ESPN_SWID,
      cookie: "SWID=" + env.ESPN_SWID + "; espn_s2=" + env.ESPN_S2,
      season: SEASON,
      onFrame: handleFrame,
      onEvent: wireEvent,
      onRtt: (ms) => state.touch((s) => (s.connection.rttMs = ms)),
      onContested: (why) => {
        log("CONTESTED: " + why);
        state.warn(why);
        state.touch((s) => (s.connection.contested = true));
        sse.send("status", { connection: state.state.connection, warning: why, version: state.version });
      },
    });
    state.apply((s) => (s.source = source.name));
    await source.start();
    return;
  }

  // Read the draft room over the shoulder of the browser showing it. One
  // connection exists and we listen to it, so nothing can be evicted.
  if (SOURCE === "room") {
    league = await loadLeague({
      season: SEASON,
      leagueId: LEAGUE_ID,
      cookie: "SWID=" + env.ESPN_SWID + "; espn_s2=" + env.ESPN_S2,
      excludeOwner: env.ESPN_SWID,
      onInfo: log,
      onWarn: (w) => log("warn:", w),
      allowPlaceholder: true,
    });
    const mine = league.teams.find((t) => (t.owners || []).includes(env.ESPN_SWID));
    const teamId = Number(flag("team", mine ? mine.id : 0));
    if (!teamId) {
      log("no team to open the draft room as. Pass --team <id>.");
      state.warn("no team to open the draft room as");
      return;
    }
    state.apply((s) => {
      s.leagueName = league.name;
      s.draft.secondsPerPick = league.secondsPerPick;
      s.draft.keeperCount = league.keeperCount;
      s.draft.teams = league.teams;
    });
    source = createRoomSource({
      leagueId: LEAGUE_ID,
      teamId,
      swid: env.ESPN_SWID,
      season: SEASON,
      onFrame: handleFrame,
      onEvent: wireEvent,
    });
    state.apply((s) => (s.source = source.name));
    await source.start();
    return;
  }

  if (SOURCE === "synth") {
    source = createSynthSource({
      teams: Number(flag("teams", 12)),
      rounds: Number(flag("rounds", 16)),
      seed: Number(flag("seed", 7)),
      keepers: Number(flag("keepers", 0)),
      speed: SPEED,
      pool: (players?.byAdp ?? []).map((p) => p.id),
      onFrame: handleFrame,
      onEvent: wireEvent,
    });
    if (has("drop-at")) {
      source.injectFault("drop", { atPick: Number(flag("drop-at", 45)), picks: Number(flag("drop-picks", 8)) });
      log("fault armed: going dark for " + Number(flag("drop-picks", 8)) + " picks at pick " + Number(flag("drop-at", 45)));
    }
    state.apply((s) => (s.source = source.name));
    await source.start();
    return;
  }

  source = createReplaySource({
    speed: SPEED,
    step: has("step"),
    from: Number(flag("from", 0)),
    onFrame: handleFrame,
    onEvent: wireEvent,
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

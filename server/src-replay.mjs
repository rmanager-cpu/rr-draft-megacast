// Replays the 8/29 capture as if it were live.
//
// This is what makes the rest of the show buildable. Live ESPN drafts are not
// available on demand, so every source - live, replay, synthetic - emits the
// exact frame objects parseFrame() produces, including a real INIT carrying
// real bytes. Replay therefore exercises byte-for-byte the same code path as
// draft night, INIT decoding included. There is no simulator-only branch in
// the reconciler for a bug to hide behind.
//
// The whole server boots and runs from these fixtures with the network unplugged.

import { readFileSync } from "node:fs";
import { parseFrame } from "./draftwire.mjs";
import { decodeInit, decodeInitPayload, encodeInitFrameArgs } from "./initdecode.mjs";

const fixture = (n) => readFileSync(new URL("../test/fixtures/" + n, import.meta.url), "utf8");

export function createReplaySource({
  initFile = "init-snake.txt",
  timelineFile = "timeline-snake.txt",
  speed = 1,
  from = 0,
  step = false,
  onFrame = () => {},
  onEvent = () => {},
} = {}) {
  const initRaw = fixture(initFile).trim();
  const decoded = decodeInit(decodeInitPayload(initRaw).bytes, {});
  if (!decoded.ok) throw new Error("replay fixture INIT will not decode: " + decoded.reason);

  const timeline = fixture(timelineFile)
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const sp = line.indexOf(" ");
      return { at: Date.parse(line.slice(0, sp)), text: line.slice(sp + 1) };
    })
    .filter((f) => Number.isFinite(f.at));

  // Picks already in the opening snapshot; the wire continues from there.
  const preFilled = decoded.records.filter((r) => r.playerId !== null).length;

  let i = 0;
  let rate = speed;
  let paused = step;
  let timer = null;
  let closed = false;
  let dark = null;
  let drop = null;
  let picksSeen = 0;

  if (from > 0) {
    let seen = 0;
    while (i < timeline.length && seen < from) {
      if (timeline[i].text.startsWith("SELECTED")) seen++;
      i++;
    }
  }

  function deliver(text) {
    if (closed) return;
    try {
      const frame = parseFrame(text);
      if (frame.cmd === "SELECTED") picksSeen++;
      onFrame(frame);
    } catch (e) {
      onEvent("error", "replay parse: " + e.message);
    }
  }

  /** Every pick the wire has produced up to the current position, in order. */
  function wirePicksSoFar() {
    const made = [];
    for (let k = 0; k < i; k++) {
      const t = timeline[k].text;
      if (!t.startsWith("SELECTED")) continue;
      const a = t.split(/\s+/);
      made.push({ playerId: +a[2], slot: +a[3] });
    }
    return made;
  }

  /** A real INIT reflecting everything picked so far - what a reconnect gets. */
  function emitSnapshot(label) {
    const made = wirePicksSoFar();
    const records = decoded.records.map((r) => {
      if (r.pick <= preFilled) return r;
      const m = made[r.pick - preFilled - 1];
      return m ? { ...r, playerId: m.playerId, slot: m.slot } : { ...r, playerId: null, slot: 0 };
    });
    onEvent("info", `${label}: room snapshot carries ${preFilled + made.length} picks`);
    deliver("INIT " + encodeInitFrameArgs(records, decoded.leagueId));
  }

  // One gate for every frame, whichever path delivered it. A dropout swallows
  // frames here, and coming back emits a fresh room snapshot - which is exactly
  // how recovery works on the night. Returns true if a pick was delivered.
  function feed(text) {
    const isPick = text.startsWith("SELECTED");
    if (drop && !dark && isPick && picksSeen + 1 >= drop.atPick) {
      dark = drop.picks ? { left: drop.picks } : { until: Date.now() + (drop.ms ?? 0) / Math.max(rate, 0.001) };
      onEvent("close", "1006 simulated dropout");
    }
    if (dark) {
      const stillDark = dark.until ? Date.now() < dark.until : dark.left > 0;
      if (stillDark) {
        if (isPick) {
          picksSeen++;
          if (!dark.until) dark.left--;
        }
        return false;
      }
      dark = null;
      drop = null;
      onEvent("open", "replay reconnected");
      emitSnapshot("reconnect");
    }
    deliver(text);
    return isPick;
  }

  function schedule() {
    if (closed || paused || i >= timeline.length) return;
    const now = timeline[i].at;
    const prev = i > 0 ? timeline[i - 1].at : now;
    const wait = rate <= 0 ? 0 : Math.max(0, (now - prev) / rate);
    timer = setTimeout(() => {
      if (closed) return;
      feed(timeline[i++].text);
      schedule();
    }, wait);
  }

  return {
    name: `replay:${timelineFile}${from ? "#from" + from : ""}`,
    simulated: true,
    meta: {
      source: "replay",
      leagueId: decoded.leagueId,
      teams: decoded.teams,
      rounds: decoded.rounds,
      frames: timeline.length,
    },
    async start() {
      onEvent("open", `replay started at ${rate}x`);
      deliver("INIT " + initRaw);
      if (!paused) schedule();
    },
    close() {
      closed = true;
      clearTimeout(timer);
      onEvent("close", "replay closed");
    },
    /** Advance n frames by hand - the step-through dev loop. */
    step(n = 1) {
      for (let k = 0; k < n && i < timeline.length; k++) feed(timeline[i++].text);
    },
    /** Advance to the next pick, playing the clock ticks in between. */
    stepPick() {
      while (i < timeline.length) if (feed(timeline[i++].text)) return true;
      return false;
    },
    pause() {
      paused = true;
      clearTimeout(timer);
    },
    resume() {
      if (!paused) return;
      paused = false;
      schedule();
    },
    setSpeed(x) {
      rate = Math.max(0, Number(x) || 1);
    },
    injectFault(kind, opts = {}) {
      // Give either picks (deterministic) or ms (real-time replay).
      if (kind === "drop") drop = { atPick: opts.atPick ?? 45, picks: opts.picks ?? 0, ms: opts.ms ?? 30000 };
    },
    get position() {
      return { frame: i, of: timeline.length, picks: picksSeen };
    },
    get exhausted() {
      return i >= timeline.length;
    },
  };
}

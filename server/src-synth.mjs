// A whole draft, invented.
//
// The recorded capture is ten teams over sixteen minutes. The real thing is
// twelve teams over about two hours, and the pieces that only break at length -
// memory, the reveal queue draining, the recap schedule, a reconnect at pick 45
// - need a draft that shape. This makes one, deterministically, so a failing
// soak can be replayed exactly.
//
// It emits the same frames as the live wire, INIT included, so it exercises the
// same code path rather than a simulator-only shortcut.

import { parseFrame } from "./draftwire.mjs";
import { encodeInitFrameArgs } from "./initdecode.mjs";

/** Small deterministic generator, so --seed reproduces a run exactly. */
function rng(seed) {
  let x = (seed | 0) || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 100000) / 100000;
  };
}

export function createSynthSource({
  leagueId = 999999,
  teams = 12,
  rounds = 16,
  seed = 7,
  pool = [],
  secondsPerPick = 90,
  speed = 1,
  autoTeams = [2, 5, 9],
  keepers = 0,
  onFrame = () => {},
  onEvent = () => {},
} = {}) {
  const total = teams * rounds;
  const rand = rng(seed);
  const order = new Int32Array(total + 1);
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < teams; i++) {
      const t = r % 2 === 0 ? i + 1 : teams - i;
      order[r * teams + i + 1] = t;
    }
  }

  // Draft roughly in draft-position order, with enough noise to make runs and
  // reaches happen on their own.
  const available = pool.length ? [...pool] : Array.from({ length: total + 60 }, (_, i) => 100000 + i);
  const takeNext = () => {
    const window = Math.min(available.length, 6);
    const idx = Math.floor(rand() * window);
    return available.splice(idx, 1)[0];
  };

  const records = [];
  for (let p = 1; p <= total; p++) records.push({ pick: p, teamId: order[p], playerId: null, slot: 0 });
  for (let k = 0; k < keepers; k++) records[k].playerId = takeNext();

  let timer = null;
  let closed = false;
  let paused = false;
  let cursor = keepers + 1;
  let drop = null;
  let dark = null;
  const scale = (ms) => Math.max(0, ms / Math.max(speed, 0.001));

  const deliver = (text) => {
    if (closed) return;
    try {
      onFrame(parseFrame(text));
    } catch (e) {
      onEvent("error", "synth: " + e.message);
    }
  };

  function snapshot(label) {
    onEvent("info", `${label}: room snapshot carries ${records.filter((r) => r.playerId !== null).length} picks`);
    deliver("INIT " + encodeInitFrameArgs(records, leagueId));
  }

  function thinkMs(teamId) {
    if (autoTeams.includes(teamId)) return 1300;
    return 3000 + Math.floor(rand() * (secondsPerPick * 1000 - 4000));
  }

  function step() {
    if (closed || paused) return;
    if (cursor > total) {
      deliver("STATE 2");
      onEvent("info", "synth: draft complete");
      return;
    }
    const teamId = order[cursor];
    const think = thinkMs(teamId);

    if (drop && !dark && cursor >= drop.atPick) {
      dark = { left: drop.picks };
      onEvent("close", "1006 simulated dropout");
    }

    if (!dark) deliver(`SELECTING ${teamId} ${secondsPerPick * 1000}`);

    // A clock tick every five seconds, as the real room sends.
    const ticks = Math.min(6, Math.floor(think / 5000));
    for (let i = 1; i <= ticks; i++) {
      setTimeout(() => {
        if (!closed && !dark) deliver(`CLOCK 6 ${secondsPerPick * 1000 - i * 5000} ${teamId}`);
      }, scale(i * 5000));
    }

    timer = setTimeout(() => {
      if (closed) return;
      const playerId = takeNext();
      const slot = 1 + Math.floor(rand() * 9);
      records[cursor - 1].playerId = playerId;
      records[cursor - 1].slot = slot;

      if (dark) {
        dark.left--;
        if (dark.left <= 0) {
          dark = null;
          drop = null;
          onEvent("open", "synth reconnected");
          snapshot("reconnect");
        }
      } else {
        deliver(`SELECTED ${teamId} ${playerId} ${slot}`);
      }
      cursor++;
      step();
    }, scale(think));
  }

  return {
    name: `synth ${teams}x${rounds} seed=${seed}`,
    simulated: true,
    meta: { source: "synth", leagueId, teams, rounds, total },
    async start() {
      onEvent("open", `synthetic draft, ${teams} teams, ${rounds} rounds, ${speed}x`);
      snapshot("open");
      step();
    },
    close() {
      closed = true;
      clearTimeout(timer);
      onEvent("close", "synth closed");
    },
    pause() {
      paused = true;
      clearTimeout(timer);
    },
    resume() {
      if (!paused) return;
      paused = false;
      step();
    },
    setSpeed() {},
    stepPick() {},
    injectFault(kind, opts = {}) {
      if (kind === "drop") drop = { atPick: opts.atPick ?? 45, picks: opts.picks ?? 8 };
    },
    get position() {
      return { pick: cursor - 1, of: total };
    },
  };
}

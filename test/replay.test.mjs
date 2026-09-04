// The replay source driving the real reconciler: the same path draft night takes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createReplaySource } from "../server/src-replay.mjs";
import { createFrameHandler } from "../server/pipeline.mjs";
import { createReconciler } from "../server/reconcile.mjs";

const LEAGUE = 1814994619;

function rig({ fault, speed, step = true } = {}) {
  const warnings = [];
  const events = [];
  const states = [];
  const picked = [];
  let reconciler = null;

  const handler = createFrameHandler({
    getReconciler: () => reconciler,
    leagueId: LEAGUE,
    onWarn: (w) => warnings.push(w),
    onState: (s) => states.push(s),
    onRoomSnapshot: (room) => {
      // How many teams and how many rounds comes from the room itself.
      reconciler ||= createReconciler({
        season: 2026,
        leagueId: LEAGUE,
        teamCount: room.teams,
        rounds: room.rounds,
        clock: () => 0,
        onWarn: (w) => warnings.push(w),
        onPick: (list) => picked.push(...list),
      });
    },
  });

  const source = createReplaySource({
    step,
    speed,
    onEvent: (kind, detail) => events.push(kind + " " + detail),
    onFrame: handler,
  });
  if (fault) source.injectFault("drop", fault);
  return {
    source,
    warnings,
    events,
    states,
    picked,
    get reconciler() {
      return reconciler;
    },
  };
}

test("replaying the capture rebuilds the whole draft", async () => {
  const r = rig();
  await r.source.start();
  while (r.source.stepPick());
  r.source.step(80); // drain the trailing clock and state frames

  const s = r.reconciler.snapshot();
  assert.equal(s.counters.committed, 160);
  assert.equal(s.gaps.length, 0);
  assert.equal(s.counters.suspects, 0);
  assert.equal(s.counters.duplicates, 0);
  assert.equal(s.complete, true);
  assert.equal(new Set(s.picks.map((p) => p.playerId)).size, 160);
  assert.deepEqual(r.states, [2], "the wire announced the draft complete");
  assert.deepEqual(r.warnings, []);
});

test("a dropout mid-draft heals on reconnect, with nothing lost", async () => {
  const r = rig({ fault: { atPick: 45, picks: 9 } });
  await r.source.start();
  while (r.source.stepPick());
  r.source.step(80);

  const s = r.reconciler.snapshot();
  assert.ok(r.events.some((e) => e.startsWith("close 1006")), "the dropout happened");
  assert.ok(r.events.some((e) => e.includes("reconnect: room snapshot")), "a fresh room snapshot arrived");
  assert.equal(s.counters.committed, 160, "every pick is on the board");
  assert.equal(s.gaps.length, 0, "the hole closed");
  assert.equal(new Set(s.picks.map((p) => p.playerId)).size, 160);
  for (let i = 0; i < 160; i++) {
    assert.equal(s.picks[i].pick, i + 1);
    assert.equal(s.picks[i].teamId, s.order[i + 1]);
  }
});

test("replay runs on its own clock when asked", async () => {
  const r = rig({ step: false, speed: 100000 });
  await r.source.start();
  await new Promise((res) => setTimeout(res, 500));
  r.source.close();
  // Node clamps every setTimeout to at least a millisecond, so a 729-frame
  // timeline cannot finish faster than ~0.7s no matter the speed multiplier.
  // All this needs to prove is that frames flow without being stepped by hand.
  assert.ok(r.picked.length > 5, "picks arrived without being stepped, got " + r.picked.length);
});

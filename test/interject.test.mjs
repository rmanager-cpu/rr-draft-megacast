// A booth that reacts to everything is worse than one that reacts to nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInterjectPolicy } from "../server/interject-policy.mjs";

const card = (over = {}) => ({ pick: 20, round: 2, pos: "RB", adp: 20, ...over });

function rig(config = {}) {
  let now = 0;
  const p = createInterjectPolicy({ config, clock: () => now });
  return { p, tick: (ms) => (now += ms), at: () => now };
}

test("an ordinary pick gets nothing said about it", () => {
  const { p } = rig();
  const d = p.decide(card());
  assert.equal(d.go, false);
  assert.match(d.reason, /nothing happened/);
});

test("a player falling well past his draft position is worth a word", () => {
  const { p } = rig();
  assert.equal(p.decide(card({ adp: 40, pick: 20 })).go, true);
});

test("so is a big reach, and a run, and a kicker taken far too early", () => {
  const { p } = rig();
  assert.equal(p.decide(card({ adp: 20, pick: 40 })).go, true);
  assert.equal(p.decide(card({ adp: null }), { runLength: 4 }).go, true);
  assert.equal(p.decide(card({ pos: "K", adp: null, round: 5 })).go, true);
});

test("a kicker in the last round is normal, not a story", () => {
  const { p } = rig();
  assert.equal(p.decide(card({ pos: "K", adp: null, round: 15 })).go, false);
});

test("nothing is said over a recap", () => {
  const { p } = rig();
  const d = p.decide(card({ adp: 40 }), {}, { talkingOver: true });
  assert.equal(d.go, false);
  assert.match(d.reason, /mid-recap/);
});

test("two reactions a round, and no more", () => {
  const { p, tick } = rig({ maxPerRound: 2, cooldownSeconds: 0 });
  for (let i = 0; i < 2; i++) {
    const c = card({ adp: 40, pick: 20 + i });
    assert.equal(p.decide(c).go, true);
    p.spent(c);
    tick(1000);
  }
  const third = p.decide(card({ adp: 40, pick: 25 }));
  assert.equal(third.go, false);
  assert.match(third.reason, /twice this round/);
});

test("the cap is per round, so a new round starts fresh", () => {
  const { p, tick } = rig({ maxPerRound: 1, cooldownSeconds: 0 });
  const first = card({ adp: 40, round: 2 });
  p.decide(first);
  p.spent(first);
  assert.equal(p.decide(card({ adp: 40, round: 2 })).go, false);
  tick(1000);
  assert.equal(p.decide(card({ adp: 40, round: 3 })).go, true);
});

test("the cooldown keeps two reactions from landing on top of each other", () => {
  const { p, tick } = rig({ maxPerRound: 5, cooldownSeconds: 90 });
  const first = card({ adp: 40 });
  p.decide(first);
  p.spent(first);
  tick(30000);
  assert.match(p.decide(card({ adp: 40, pick: 21 })).reason, /cooldown/);
  tick(61000);
  assert.equal(p.decide(card({ adp: 40, pick: 22 })).go, true);
});

test("a reaction that never went out does not use up the allowance", () => {
  const { p } = rig({ maxPerRound: 1, cooldownSeconds: 0 });
  p.decide(card({ adp: 40 })); // considered, but the writer was late
  assert.equal(p.decide(card({ adp: 40, pick: 21 })).go, true, "still allowed");
});

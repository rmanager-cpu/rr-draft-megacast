// A lineup swap goes to the real league, so every refusal is decided before any
// request is made, and is checked here without a network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planSwap } from "../server/lineup.mjs";

const WR = 4, FLEX = 23, BENCH = 20, QB = 0;
const roster = [
  { playerId: 4262921, name: "Justin Jefferson", slot: WR, eligible: [3, 4, 5, 23, 20, 21], locked: false },
  { playerId: 4610523, name: "Ladd McConkey", slot: FLEX, eligible: [3, 4, 5, 23, 20, 21], locked: false },
  { playerId: 1, name: "Jalen Hurts", slot: QB, eligible: [0, 7, 20, 21], locked: false },
  { playerId: 2, name: "Justin Herbert", slot: BENCH, eligible: [0, 7, 20, 21], locked: false },
];

test("a WR and a FLEX trade slots", () => {
  const p = planSwap(roster, "jefferson", "McConkey");
  assert.equal(p.ok, true);
  assert.deepEqual(p.items, [
    { playerId: 4262921, type: "LINEUP", fromLineupSlotId: WR, toLineupSlotId: FLEX },
    { playerId: 4610523, type: "LINEUP", fromLineupSlotId: FLEX, toLineupSlotId: WR },
  ]);
});

test("two players in the same kind of slot is refused as a no-op", () => {
  const both = roster.map((e) => (e.name === "Ladd McConkey" ? { ...e, slot: WR } : e));
  const p = planSwap(both, "Jefferson", "McConkey");
  assert.equal(p.ok, false);
  assert.match(p.reason, /changes nothing/);
});

test("a locked player is never moved", () => {
  const locked = roster.map((e) => (e.name === "Ladd McConkey" ? { ...e, locked: true } : e));
  assert.match(planSwap(locked, "Jefferson", "McConkey").reason, /locked/);
});

test("a player who cannot play the other slot is refused", () => {
  assert.match(planSwap(roster, "Jefferson", "Herbert").reason, /cannot play/);
});

test("an ambiguous or missing name is refused", () => {
  assert.match(planSwap(roster, "Justin", "McConkey").reason, /matches 2 players/);
  assert.match(planSwap(roster, "Chase", "McConkey").reason, /nobody/);
});

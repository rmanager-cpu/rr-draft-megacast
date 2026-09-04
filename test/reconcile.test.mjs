// The reconciler against the real 8/29 draft: one INIT snapshot carrying round
// one, then the 150 picks that actually came over the wire. If this passes, the
// board is right for a draft that genuinely happened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeInit, decodeInitPayload } from "../server/initdecode.mjs";
import { createReconciler, pickKey, snakeOrder } from "../server/reconcile.mjs";

const fixture = (n) => readFileSync(new URL("./fixtures/" + n, import.meta.url), "utf8");
const SEASON = 2026;
const LEAGUE = 1814994619;

function roomSnapshot() {
  const { bytes } = decodeInitPayload(fixture("init-snake.txt"));
  const r = decodeInit(bytes, { leagueId: LEAGUE });
  assert.equal(r.ok, true, r.reason);
  return r;
}

function wirePicks() {
  return fixture("selected-snake.txt")
    .trim()
    .split(/\r?\n/)
    .map((l) => {
      const a = l.split(/\s+/);
      return { teamId: Number(a[1]), playerId: Number(a[2]), slot: Number(a[3]) };
    });
}

function build(extra = {}) {
  const room = roomSnapshot();
  const r = createReconciler({
    season: SEASON,
    leagueId: LEAGUE,
    teamCount: room.teams,
    rounds: room.rounds,
    clock: () => 0,
    ...extra,
  });
  return { r, room };
}

test("snakeOrder reverses every other round", () => {
  const o = snakeOrder([1, 2, 3, 4], 3);
  assert.deepEqual(Array.from(o.slice(1, 5)), [1, 2, 3, 4]);
  assert.deepEqual(Array.from(o.slice(5, 9)), [4, 3, 2, 1]);
  assert.deepEqual(Array.from(o.slice(9, 13)), [1, 2, 3, 4]);
});

test("the whole 8/29 draft reconciles to 160 correct picks", () => {
  const { r, room } = build();
  r.adoptInit(room.records);
  assert.equal(r.snapshot().counters.committed, 10, "round one comes from the room");

  for (const p of wirePicks()) r.onSelected(p);

  const s = r.snapshot();
  assert.equal(s.counters.committed, 160);
  assert.equal(s.picks.length, 160);
  assert.equal(s.gaps.length, 0, "no gaps");
  assert.equal(s.counters.duplicates, 0);
  assert.equal(s.counters.suspects, 0, "every pick fitted the order");
  assert.equal(s.complete, true);

  // Every slot filled exactly once, in order, by the right team.
  for (let i = 0; i < 160; i++) {
    const p = s.picks[i];
    assert.equal(p.pick, i + 1);
    assert.equal(p.round, Math.ceil((i + 1) / 10));
    assert.equal(p.teamId, s.order[i + 1]);
    assert.equal(p.key, pickKey(SEASON, LEAGUE, i + 1));
  }
  assert.equal(new Set(s.picks.map((p) => p.playerId)).size, 160, "nobody drafted twice");
  assert.equal(s.picks.filter((p) => p.source === "init").length, 10);
  assert.equal(s.picks.filter((p) => p.source === "wire").length, 150);
});

test("a replayed frame is ignored, not double-counted", () => {
  const { r, room } = build();
  r.adoptInit(room.records);
  const picks = wirePicks();
  r.onSelected(picks[0]);
  r.onSelected(picks[0]); // the reconnect overlap case
  for (const p of picks.slice(1)) r.onSelected(p);
  const s = r.snapshot();
  assert.equal(s.counters.duplicates, 1);
  assert.equal(s.counters.committed, 160);
  assert.equal(s.gaps.length, 0);
});

test("picks in the room we already have change nothing", () => {
  const { r, room } = build();
  r.adoptInit(room.records);
  const before = r.snapshot();
  r.adoptInit(room.records); // every reconnect does exactly this
  const after = r.snapshot();
  assert.deepEqual(after.picks, before.picks);
  assert.equal(after.counters.corrections, 0);
});

test("a disconnection opens gaps, and the next room snapshot heals them", () => {
  const gapsSeen = [];
  let resyncs = 0;
  const { r, room } = build({
    onGap: (g) => gapsSeen.push(...g),
    onResyncNeeded: () => resyncs++,
  });
  r.adoptInit(room.records);

  const picks = wirePicks();
  // Miss picks 21 through 28 entirely, as a 40-second dropout would.
  const missedIdx = new Set([10, 11, 12, 13, 14, 15, 16, 17]);
  picks.forEach((p, i) => {
    if (!missedIdx.has(i)) r.onSelected(p);
  });

  let s = r.snapshot();
  assert.equal(s.gaps.length, 8, "the hole is recorded, not papered over");
  assert.deepEqual(s.gaps, [21, 22, 23, 24, 25, 26, 27, 28]);
  assert.equal(s.counters.committed, 152);
  assert.ok(resyncs > 0, "a resync was demanded");
  assert.deepEqual(gapsSeen.sort((a, b) => a - b), [21, 22, 23, 24, 25, 26, 27, 28]);

  // Reconnect: a fresh room snapshot carrying everything picked so far.
  const healed = room.records.map((rec) => {
    const idx = rec.pick - 11;
    if (rec.pick <= 10) return rec;
    if (rec.pick > 160) return rec;
    const wire = picks[idx];
    return wire ? { ...rec, playerId: wire.playerId, slot: wire.slot } : rec;
  });
  r.adoptInit(healed);

  s = r.snapshot();
  assert.equal(s.gaps.length, 0, "the hole is filled");
  assert.equal(s.counters.committed, 160);
  assert.equal(new Set(s.picks.map((p) => p.playerId)).size, 160);
  for (let i = 0; i < 160; i++) assert.equal(s.picks[i].pick, i + 1);
});

test("a pick from the wrong team lands in that team's own slot", () => {
  const { r, room } = build();
  r.adoptInit(room.records);
  const picks = wirePicks();
  // Pick 11 belongs to team 10 (round 2 reverses). Hand it team 9's pick first,
  // which is pick 12 - as if we had missed one frame.
  assert.equal(picks[0].teamId, 10);
  assert.equal(picks[1].teamId, 9);
  r.onSelected(picks[1]);
  const s = r.snapshot();
  const placed = s.picks.find((p) => p.playerId === picks[1].playerId);
  assert.equal(placed.pick, 12, "it went to team 9's slot, not the next free one");
  assert.equal(placed.teamId, 9);
  assert.deepEqual(s.gaps, [11], "pick 11 is marked missing rather than mis-attributed");
});

test("keepers land on the board and are marked as keepers", () => {
  const { r, room } = build();
  const withKeepers = room.records.map((rec) =>
    rec.pick <= 3 ? { ...rec, playerId: 900000 + rec.pick } : { ...rec, playerId: null },
  );
  r.adoptInit(withKeepers, { phase: "pre" });
  const s = r.snapshot();
  assert.equal(s.counters.committed, 3);
  assert.ok(s.picks.every((p) => p.source === "keeper"));
});

test("the room overrules a pick we placed wrongly", () => {
  const corrections = [];
  const { r, room } = build({ onCorrection: (c) => corrections.push(c) });
  r.adoptInit(room.records);
  r.onSelected({ teamId: 10, playerId: 111111, slot: 1 }); // a player who was never drafted
  assert.equal(r.snapshot().picks.find((p) => p.pick === 11).playerId, 111111);

  const truth = room.records.map((rec) => (rec.pick === 11 ? { ...rec, playerId: 222222 } : rec));
  r.adoptInit(truth);

  const s = r.snapshot();
  assert.equal(s.picks.find((p) => p.pick === 11).playerId, 222222);
  assert.equal(s.counters.corrections, 1);
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].pick, 11);
});

test("the emergency field places a pick in that team's next open slot", () => {
  const { r, room } = build();
  r.adoptInit(room.records);
  const res = r.manualPick({ teamId: 10, playerId: 777777 });
  assert.equal(res.ok, true);
  assert.equal(res.pick.pick, 11);
  assert.equal(res.pick.source, "manual");
  assert.equal(r.manualPick({ teamId: 10, playerId: 777777 }).ok, false, "no drafting the same player twice");
});

test("state survives a restart", () => {
  const { r, room } = build();
  r.adoptInit(room.records);
  for (const p of wirePicks().slice(0, 40)) r.onSelected(p);
  const saved = JSON.parse(JSON.stringify(r.snapshot()));

  const { r: r2 } = build();
  assert.equal(r2.restore(saved), true);
  for (const p of wirePicks().slice(40)) r2.onSelected(p);

  const s = r2.snapshot();
  assert.equal(s.counters.committed, 160);
  assert.equal(s.gaps.length, 0);
  assert.equal(new Set(s.picks.map((p) => p.playerId)).size, 160);
});

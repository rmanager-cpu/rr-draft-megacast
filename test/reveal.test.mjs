// The reveal queue on a fake clock. The invariant under test is that a card on
// screen only ever gets shorter, never longer, never below its floor, and that
// no pick is ever silently dropped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createReveal, DEFAULT_REVEAL } from "../server/reveal.mjs";

function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    /** Advance time, firing anything due, in order. */
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let nextId = null;
        let nextAt = Infinity;
        for (const [id, t] of timers) if (t.at <= end && t.at < nextAt) ((nextAt = t.at), (nextId = id));
        if (nextId === null) break;
        const t = timers.get(nextId);
        timers.delete(nextId);
        now = t.at;
        t.fn();
      }
      now = end;
    },
  };
}

const card = (pick, extra = {}) => ({
  pick,
  name: "Player " + pick,
  lastName: "P" + pick,
  teamName: "Team",
  pos: "RB",
  ...extra,
});

function rig(config = {}) {
  const clock = fakeClock();
  const reveals = [];
  const cuts = [];
  const dones = [];
  const catchups = [];
  const r = createReveal({
    clock,
    config,
    onReveal: (e) => reveals.push(e),
    onCut: (e) => cuts.push(e),
    onDone: (e) => dones.push(e),
    onCatchup: (e) => catchups.push(e),
  });
  return { clock, r, reveals, cuts, dones, catchups };
}

test("a lone pick gets the full eighteen seconds", () => {
  const { clock, r, reveals } = rig();
  r.enqueue(card(1));
  assert.equal(reveals.length, 1);
  assert.equal(reveals[0].mode, "full");
  const t = DEFAULT_REVEAL.full;
  assert.equal(reveals[0].endsAt - reveals[0].startsAt, t.stingMs + t.cardInMs + t.dwellMs);
  assert.equal(t.stingMs + t.cardInMs + t.dwellMs + t.outMs, 18000, "the full reveal is 18s end to end");
  clock.advance(30000);
  assert.equal(r.depth(), 0);
});

test("modes step down as picks stack up", () => {
  const { clock, r, reveals, cuts } = rig();
  for (let i = 1; i <= 6; i++) r.enqueue(card(i));

  // The first pick arrived to an empty queue, so it began as a full reveal and
  // was cut short as the rest landed. That is the design: what is already on
  // screen gets shortened rather than restarted.
  assert.equal(reveals[0].mode, "full");
  assert.ok(cuts.length > 0, "and it was cut");

  for (let i = 0; i < 6; i++) clock.advance(20000);
  assert.deepEqual(
    reveals.map((x) => x.mode),
    ["full", "card", "card", "short", "short", "full"],
    "deep queue means cards only; as it drains the reveals get their time back",
  );
});

test("a waiting pick shortens the card on screen, but never below the floor", () => {
  const { clock, r, reveals, cuts } = rig();
  r.enqueue(card(1));
  const first = reveals[0];
  clock.advance(100); // barely into the sting
  r.enqueue(card(2));
  assert.equal(cuts.length, 1, "the reveal on screen was cut short");
  const cut = cuts[0];
  assert.ok(cut.endsAt < first.endsAt, "it got shorter");
  assert.ok(cut.endsAt >= first.startsAt + DEFAULT_REVEAL.full.stingMs + DEFAULT_REVEAL.full.cardInMs + DEFAULT_REVEAL.minOnScreenMs,
    "the card still stays up for its minimum");
});

test("a deadline never grows", () => {
  const { clock, r, reveals, cuts } = rig();
  r.enqueue(card(1));
  clock.advance(200);
  r.enqueue(card(2));
  const afterFirstCut = cuts[0].endsAt;
  r.enqueue(card(3));
  r.enqueue(card(4));
  const last = cuts[cuts.length - 1].endsAt;
  assert.ok(last <= afterFirstCut, "more pressure never buys more time");
  assert.ok(reveals[0].endsAt >= afterFirstCut);
});

test("a burst of twelve picks reveals every single one", () => {
  const { clock, r, reveals, dones } = rig();
  for (let i = 1; i <= 12; i++) r.enqueue(card(i));
  clock.advance(5 * 60 * 1000);
  assert.equal(reveals.length, 12, "every pick got a card");
  assert.equal(dones.length, 12);
  assert.deepEqual(reveals.map((x) => x.pick), Array.from({ length: 12 }, (_, i) => i + 1), "and in order");
  assert.equal(r.depth(), 0);
});

test("keepers go to the board, never to the reveal", () => {
  const { r, reveals } = rig();
  r.enqueue(card(1, { isKeeper: true }));
  r.enqueue(card(2));
  assert.equal(reveals.length, 1);
  assert.equal(reveals[0].pick, 2);
});

test("catching up shows a strip and then the newest pick, not a backlog", () => {
  const { r, reveals, catchups } = rig();
  r.enqueueCatchup([card(21), card(22), card(23), card(24)]);
  assert.equal(catchups.length, 1);
  assert.equal(catchups[0].from, 21);
  assert.equal(catchups[0].to, 23);
  assert.equal(reveals.length, 1);
  assert.equal(reveals[0].pick, 24, "the newest is what the room is actually looking at");
});

test("catching up can be configured to reveal everything instead", () => {
  const { clock, r, reveals } = rig({ catchupMode: "all" });
  r.enqueueCatchup([card(21), card(22), card(23)]);
  clock.advance(60000);
  assert.equal(reveals.length, 3);
});

test("a highlight that throws cannot take the reveal down with it", () => {
  const { r, reveals } = rig();
  r.setContentProvider(() => {
    throw new Error("catalog exploded");
  });
  r.enqueue(card(1));
  assert.equal(reveals.length, 1);
  assert.equal(reveals[0].content, null, "it falls back to the card, which is the design");
});

test("the current reveal can be handed to a TV that just reloaded", () => {
  const { clock, r } = rig();
  r.enqueue(card(7));
  clock.advance(3000);
  const cur = r.current();
  assert.equal(cur.pick, 7);
  assert.ok(cur.endsAt > clock.now(), "with the time it has left");
});

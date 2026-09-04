// One speaker. The rules that matter are that a recap is never interrupted, a
// reaction that arrives late is dropped rather than played out of time, and the
// channel can never wedge - a silent speaker for the rest of the draft would be
// worse than any single missed line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAudio, KIND } from "../server/audio.mjs";

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
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let pick = null;
        let at = Infinity;
        for (const [id, t] of timers) if (t.at <= end && t.at < at) ((at = t.at), (pick = id));
        if (pick === null) break;
        const t = timers.get(pick);
        timers.delete(pick);
        now = t.at;
        t.fn();
      }
      now = end;
    },
  };
}

function rig(opts = {}) {
  const clock = fakeClock();
  const played = [];
  const dropped = [];
  const a = createAudio({ clock, onPlay: (i) => played.push(i), onDropped: (i) => dropped.push(i), ...opts });
  return { clock, a, played, dropped };
}

test("one thing plays at a time, in the order it was asked for", () => {
  const { clock, a, played } = rig();
  a.enqueue({ kind: KIND.NAME, text: "one two three" });
  a.enqueue({ kind: KIND.NAME, text: "four five six" });
  assert.equal(played.length, 1, "the second waits");
  a.done(played[0].id);
  assert.equal(played.length, 2);
  a.done(played[1].id);
  assert.equal(a.current, null);
  clock.advance(1000);
});

test("a pick call landing mid-recap is suppressed, not queued behind it", () => {
  const { a, played, dropped } = rig();
  a.enqueue({ kind: KIND.RECAP, text: "a long look back at the first round" });
  const r = a.enqueue({ kind: KIND.NAME, text: "Bijan Robinson" });
  assert.equal(r.queued, false);
  assert.equal(r.reason, "suppressed");
  assert.equal(played.length, 1);
  assert.equal(played[0].kind, KIND.RECAP);
  assert.equal(dropped[0].reason, "recap in progress");
  assert.equal(a.talkingOver, true, "the caller knows to suppress the sting too");
});

test("a recap is never interrupted by anything", () => {
  const { a, played } = rig();
  a.enqueue({ kind: KIND.RECAP, text: "round one in review" });
  a.enqueue({ kind: KIND.FINAL, text: "that is the draft" });
  a.enqueue({ kind: KIND.BIT, text: "an inside joke" });
  assert.equal(played.length, 1);
  assert.equal(played[0].kind, KIND.RECAP, "still the recap");
});

test("a reaction is dropped rather than played late", () => {
  const { a, played, dropped } = rig();
  a.enqueue({ kind: KIND.NAME, text: "a pick call" });
  const r = a.enqueue({ kind: KIND.INTERJECT, text: "what a steal" });
  assert.equal(r.queued, false);
  assert.equal(dropped.at(-1).reason, "channel busy");
  assert.equal(played.length, 1);
});

test("a reaction that waits too long expires instead of surfacing", () => {
  const { clock, a, played, dropped } = rig();
  a.enqueue({ kind: KIND.RECAP, text: "one two three four five" });
  const recap = played[0];
  clock.advance(12000);
  // Nothing else is queued, so a reaction may enqueue - but it is already stale.
  a.done(recap.id);
  const r = a.enqueue({ kind: KIND.INTERJECT, text: "a reach", expiresAt: clock.now() - 1 });
  assert.equal(r.queued, true, "it was accepted");
  assert.equal(played.length, 1, "but never played");
  assert.equal(dropped.at(-1).reason, "too late to matter");
});

test("higher-value lines go first when several are waiting", () => {
  const { a, played } = rig();
  a.enqueue({ kind: KIND.NAME, text: "blocking the channel" });
  const first = played[0];
  a.enqueue({ kind: KIND.NAME, text: "a pick call" });
  a.enqueue({ kind: KIND.RECAP, text: "the round in review" });
  a.done(first.id);
  assert.equal(played[1].kind, KIND.RECAP, "the recap outranks a pick call");
});

test("a browser that never reports back cannot wedge the speaker", () => {
  const { clock, a, played } = rig({ graceMs: 3000 });
  a.enqueue({ kind: KIND.NAME, text: "one two three" });
  a.enqueue({ kind: KIND.NAME, text: "four five six" });
  assert.equal(played.length, 1);
  clock.advance(60000); // the studio never says it finished
  assert.equal(played.length, 2, "the channel freed itself and moved on");
  assert.ok(a.counts().timedOut >= 1);
});

test("a stale done from an old line does not cut off the current one", () => {
  const { a, played } = rig();
  a.enqueue({ kind: KIND.NAME, text: "one" });
  const first = played[0];
  a.done(first.id);
  a.enqueue({ kind: KIND.RECAP, text: "two" });
  const second = played[1];
  assert.equal(a.done(first.id), false, "an old id is ignored");
  assert.equal(a.current.id, second.id);
});

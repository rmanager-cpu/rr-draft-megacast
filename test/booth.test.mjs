// The booth's own logic, without a model or a network anywhere near it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBooth, interestOf, pickCall, writtenRecap } from "../server/booth.mjs";
import { createAudio, KIND } from "../server/audio.mjs";

const card = (over = {}) => ({
  pick: 13,
  round: 2,
  slotInRound: 3,
  name: "Justin Jefferson",
  firstName: "Justin",
  lastName: "Jefferson",
  pos: "WR",
  proTeam: "MIN",
  teamName: "Team 8",
  manager: "Dave",
  adp: 12.6,
  playerId: 1,
  ...over,
});

test("the deterministic call reads as speech, in each configured style", () => {
  assert.equal(pickCall(card(), { style: "sting" }), "");
  assert.equal(pickCall(card(), { style: "sting+name" }), "Justin Jefferson, wide receiver.");
  assert.equal(
    pickCall(card(), { style: "call" }),
    "With pick 13, Team 8 takes Justin Jefferson, wide receiver, MIN.",
  );
});

test("a defense is called by its city, not its player name", () => {
  const d = card({ name: "Texans D/ST", lastName: "Texans", pos: "D/ST" });
  assert.equal(pickCall(d, { style: "sting+name" }), "Team 8 takes the Texans defense.");
});

test("value and reach are what make a pick interesting", () => {
  assert.ok(interestOf(card({ adp: 40, pick: 13 })).reasons.includes("value"));
  assert.ok(interestOf(card({ adp: 12, pick: 40 })).reasons.includes("reach"));
  assert.equal(interestOf(card({ adp: 13, pick: 13 })).score, 0, "a pick at its ADP is not a story");
});

test("a kicker in the third round is always a story", () => {
  const k = interestOf(card({ pos: "K", round: 3, adp: null }));
  assert.ok(k.score > 0);
  assert.ok(k.reasons.some((r) => r.includes("early")));
});

test("a position run counts as interesting", () => {
  const r = interestOf(card({ adp: null }), { runLength: 4 });
  assert.ok(r.reasons.includes("run"));
});

test("the written recap needs no model and still says something", () => {
  const picks = [card(), card({ pick: 14, name: "Bijan Robinson", lastName: "Robinson", adp: 2.4 })];
  const text = writtenRecap(picks, { round: 2, interesting: [{ card: picks[1], reasons: ["value"] }] });
  assert.match(text, /round 2/);
  assert.match(text, /Bijan Robinson/);
  assert.doesNotMatch(text, /Justin Jefferson/, "a pick nobody would remark on is not read back");
});

test("with no writer at all, a pick is still called", async () => {
  const said = [];
  const audio = createAudio({ onPlay: (i) => said.push(i) });
  const booth = createBooth({ audio, writer: null, voice: null, config: { pickAudio: "call" } });
  await booth.callPick(card());
  assert.equal(said.length, 1);
  assert.equal(said[0].kind, KIND.NAME);
  assert.match(said[0].text, /Justin Jefferson/);
});

test("a writer that invents a number never reaches the speaker", async () => {
  const said = [];
  const warnings = [];
  const audio = createAudio({ onPlay: (i) => said.push(i) });
  const booth = createBooth({
    audio,
    writer: { available: true, line: async () => "Jefferson put up 1809 yards last year." },
    config: { interjections: { dropIfLaterThanSeconds: 10 } },
    onWarn: (w) => warnings.push(w),
  });
  const r = await booth.interject(card(), {});
  assert.equal(r.queued, false);
  assert.equal(r.reason, "failed checks");
  assert.equal(said.length, 0, "nothing was spoken");
  assert.match(warnings.join(" "), /1809/);
});

test("a writer that stays inside the packet does reach the speaker", async () => {
  const said = [];
  const audio = createAudio({ onPlay: (i) => said.push(i) });
  const booth = createBooth({
    audio,
    writer: { available: true, line: async () => "Justin Jefferson at pick 13, right on the number." },
    config: {},
  });
  const r = await booth.interject(card(), {});
  assert.equal(r.queued, true);
  assert.equal(said[0].kind, KIND.INTERJECT);
});

test("a writer that hangs costs a reaction, not the show", async () => {
  const audio = createAudio();
  const booth = createBooth({
    audio,
    writer: { available: true, line: async () => null },
    config: {},
  });
  const r = await booth.interject(card(), {});
  assert.equal(r.queued, false);
  assert.match(r.reason, /late or empty/);
});

test("a rejected recap falls back to the written one rather than silence", async () => {
  const said = [];
  const audio = createAudio({ onPlay: (i) => said.push(i) });
  const booth = createBooth({
    audio,
    writer: { available: true, recap: async () => "Jefferson was traded to Dallas in March." },
    config: {},
  });
  await booth.recap({ picks: [card()], round: 2 });
  assert.equal(said.length, 1);
  assert.match(said[0].text, /round 2/, "the written recap went out instead");
  assert.doesNotMatch(said[0].text, /traded/);
});

test("what the lore file says, the booth may say", async () => {
  const said = [];
  const audio = createAudio({ onPlay: (i) => said.push(i) });
  const booth = createBooth({
    audio,
    lore: "Dave Hoff has finished last twice, in 2019 and 2023. The trophy is the Golden Cleat.",
    writer: { available: true, line: async () => "Second Golden Cleat since 2019 if he keeps this up." },
    config: {},
  });
  const r = await booth.interject(card(), {});
  assert.equal(r.queued, true, "a fact from the lore file passed the checks");
  assert.match(said[0].text, /Golden Cleat/);
});

test("what the lore file does not say is still refused", async () => {
  const said = [];
  const warnings = [];
  const audio = createAudio({ onPlay: (i) => said.push(i) });
  const booth = createBooth({
    audio,
    lore: "Dave Hoff has finished last twice.",
    writer: { available: true, line: async () => "He won it all in 2021 with the Silver Boot." },
    onWarn: (w) => warnings.push(w),
    config: {},
  });
  const r = await booth.interject(card(), {});
  assert.equal(r.queued, false);
  assert.equal(said.length, 0);
});

test("a scripted finale is split by speaker, loosely, and continuation lines stay put", async () => {
  const { parseScript } = await import("../server/booth.mjs");
  const text = [
    "**WARREN:** That is the draft.",
    "ALLISON: Sixteen rounds",
    "and nobody died.",
    "Model7: I am still here.",
    "ELDRIN - no colon, so this continues Model 7",
    "PRODUCER: never a speaker",
  ].join("\n");
  const lines = parseScript(text, ["Warren", "Allison", "Eldrin", "Model 7"]);
  assert.deepEqual(
    lines.map((l) => [l.speaker, l.text]),
    [
      ["Warren", "That is the draft."],
      ["Allison", "Sixteen rounds and nobody died."],
      ["Model 7", "I am still here. ELDRIN - no colon, so this continues Model 7 PRODUCER: never a speaker"],
    ],
  );
});

test("the written finale needs no writer and tells the draft's stories", async () => {
  const { writtenFinale } = await import("../server/booth.mjs");
  const card = (pick, name, teamName, adp) => ({ pick, name, teamName, adp, pos: "RB", round: 1 });
  const picks = [card(3, "A. Value", "Team 1", 20), card(4, "B. Reach", "Team 2", 30)];
  const text = writtenFinale(picks, { interesting: [{ card: picks[0], reasons: ["value"] }, { card: picks[1], reasons: ["reach"] }] });
  assert.match(text, /That is the draft/);
  assert.match(text, /A\. Value was still there at 3/);
  assert.match(text, /Team 2 went early on B\. Reach/);
  assert.match(text, /Good night/);
});

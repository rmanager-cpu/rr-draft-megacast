// The guard between the model and the speaker. Every one of these is a thing a
// language model will cheerfully say about a real person in a real room.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLine, pickPacket } from "../server/booth-checks.mjs";

const packet = pickPacket({
  card: {
    pick: 13,
    round: 2,
    slotInRound: 3,
    name: "Justin Jefferson",
    pos: "WR",
    proTeam: "MIN",
    teamName: "Team 8",
    manager: "Dave Hoffman",
    adp: 12.6,
  },
  league: { teams: [{ name: "Team 8", manager: "Dave Hoffman" }] },
});

test("a line built only from the packet passes", () => {
  const r = checkLine("Justin Jefferson to Dave Hoffman at pick 13. Right where the board said.", packet);
  assert.equal(r.ok, true, r.problems.join("; "));
});

test("a number nobody handed it is refused", () => {
  const r = checkLine("Jefferson had 1809 yards last season.", packet);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /1809/);
});

test("a name nobody handed it is refused", () => {
  const r = checkLine("Dave took Jefferson over Malik Nabers there.", packet);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /Nabers/);
});

test("an invented injury is refused outright", () => {
  const r = checkLine("Jefferson is coming back from a hamstring injury.", packet);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /injury/);
});

test("the same claim passes when the note actually says so", () => {
  const withNote = { ...packet, notes: "Missed time in 2025 with a hamstring injury." };
  const r = checkLine("Jefferson is back from that hamstring injury.", withNote);
  assert.equal(r.ok, true, r.problems.join("; "));
});

test("trades, suspensions and releases are all refused", () => {
  for (const line of [
    "Jefferson was traded in the spring.",
    "He is facing a suspension.",
    "Minnesota cut him loose.",
    "There is talk he might retire.",
  ]) {
    assert.equal(checkLine(line, packet).ok, false, line);
  }
});

test("the packet's own numbers are allowed", () => {
  assert.equal(checkLine("Pick 13, round 2, and an ADP of 12.6.", packet).ok, true);
});

test("an empty or oversized line is refused", () => {
  assert.equal(checkLine("", packet).ok, false);
  assert.equal(checkLine("Jefferson. ".repeat(200), packet).ok, false);
});

test("ordinary sentences are not mistaken for names", () => {
  const r = checkLine("There it is. Jefferson to Dave Hoffman. Nobody is surprised.", packet);
  assert.equal(r.ok, true, r.problems.join("; "));
});

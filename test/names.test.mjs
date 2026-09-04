// Names on a television. Getting this wrong puts the word "III" across a screen
// in 21-point bold, so it is worth a test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitName } from "../server/players.mjs";

test("a suffix is never mistaken for a surname", () => {
  assert.deepEqual(splitName("James Cook III", "RB"), { first: "James", last: "Cook", suffix: "III" });
  assert.deepEqual(splitName("Marvin Harrison Jr.", "WR"), { first: "Marvin", last: "Harrison", suffix: "Jr." });
  assert.deepEqual(splitName("Deebo Samuel Sr.", "WR"), { first: "Deebo", last: "Samuel", suffix: "Sr." });
});

test("a particle stays with the surname", () => {
  assert.deepEqual(splitName("Amon-Ra St. Brown", "WR"), { first: "Amon-Ra", last: "St. Brown", suffix: "" });
});

test("a defense leads with the city, not the position", () => {
  assert.deepEqual(splitName("Texans D/ST", "D/ST"), { first: "", last: "Texans", suffix: "" });
  assert.deepEqual(splitName("49ers D/ST", "D/ST"), { first: "", last: "49ers", suffix: "" });
});

test("ordinary and awkward names survive", () => {
  assert.deepEqual(splitName("Puka Nacua", "WR"), { first: "Puka", last: "Nacua", suffix: "" });
  assert.deepEqual(splitName("Ja'Marr Chase", "WR"), { first: "Ja'Marr", last: "Chase", suffix: "" });
  assert.deepEqual(splitName("Cher", "WR"), { first: "", last: "Cher", suffix: "" });
  assert.deepEqual(splitName("", "WR"), { first: "", last: "", suffix: "" });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { toSeconds, videoIdFrom } from "../server/highlights.mjs";

test("a link in any of the shapes people paste yields the video id", () => {
  const id = "dQw4w9WgXcQ";
  for (const form of [
    "https://www.youtube.com/watch?v=" + id,
    "https://www.youtube.com/watch?v=" + id + "&t=42s",
    "https://youtu.be/" + id + "?t=30",
    "https://www.youtube.com/embed/" + id,
    "https://www.youtube.com/shorts/" + id,
    id,
    "  " + id + "  ",
  ]) {
    assert.equal(videoIdFrom(form), id, form);
  }
});

test("anything that is not a link is refused rather than guessed at", () => {
  for (const junk of ["", "not a link", "https://example.com/video", null, undefined]) {
    assert.equal(videoIdFrom(junk), null, String(junk));
  }
});

test("a start time can be typed the way a person would say it", () => {
  assert.equal(toSeconds("83"), 83);
  assert.equal(toSeconds("1:23"), 83);
  assert.equal(toSeconds("2m5s"), 125);
  assert.equal(toSeconds(""), 0);
});

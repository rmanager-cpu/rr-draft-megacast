// The INIT decoder against the two real blobs captured on 8/29.
// Fixtures are the frame arguments verbatim; no network, no spike/ directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeInit, decodeInitPayload, orderFromRecords, encodeInitRecords } from "../server/initdecode.mjs";

test("metadata resembling two picks does not hide the full room snapshot", () => {
  const metadata = encodeInitRecords([
    { pick: 1, teamId: 0, playerId: 12 },
    { pick: 2, teamId: 4430807, playerId: 16 },
  ], 2);
  const { bytes } = decodeInitPayload(fixture("init-snake.txt"));
  const result = decodeInit(Buffer.concat([metadata, bytes]));
  assert.equal(result.ok, true);
  assert.equal(result.leagueId, SNAKE);
  assert.equal(result.total, 160);
});

const fixture = (n) => readFileSync(new URL("./fixtures/" + n, import.meta.url), "utf8");

const AUCTION = 1979635407;
const SNAKE = 1814994619;

// Round 1 of the snake mock, read out of the blob and confirmed against the
// 150 SELECTED frames that followed: no overlap, and 10 + 150 = 160.
const ROUND_ONE = [4362628, 4430807, 4426515, 4429795, 4242335, 4430878, 4374302, 3117251, 4379399, 4429160];

test("payload splits real base64 from the filler chunk", () => {
  const { bytes, padding } = decodeInitPayload(fixture("init-snake.txt"));
  assert.equal(padding.length, 1, "one chunk should be discarded as filler");
  assert.equal(padding[0], 2048, "the filler chunk is 2048 characters");
  assert.equal(bytes.length, 13964);
});

test("snake blob decodes to a full 10x16 board", () => {
  const { bytes } = decodeInitPayload(fixture("init-snake.txt"));
  const r = decodeInit(bytes, { leagueId: SNAKE });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.leagueId, SNAKE);
  assert.equal(r.teams, 10);
  assert.equal(r.rounds, 16);
  assert.equal(r.total, 160);
  assert.equal(r.records.length, 160);
  assert.deepEqual(
    r.records.map((x) => x.pick),
    Array.from({ length: 160 }, (_, i) => i + 1),
  );
});

test("snake blob carries round one and nothing else", () => {
  const { bytes } = decodeInitPayload(fixture("init-snake.txt"));
  const { records } = decodeInit(bytes, { leagueId: SNAKE });
  const filled = records.filter((x) => x.playerId !== null);
  assert.equal(filled.length, 10);
  assert.deepEqual(filled.map((x) => x.playerId), ROUND_ONE);
  assert.deepEqual(filled.map((x) => x.pick), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(filled.map((x) => x.teamId), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("the picks in the blob are disjoint from the picks on the wire", () => {
  const { bytes } = decodeInitPayload(fixture("init-snake.txt"));
  const { records } = decodeInit(bytes, { leagueId: SNAKE });
  const fromInit = records.filter((x) => x.playerId !== null).map((x) => x.playerId);
  const fromWire = fixture("selected-snake.txt")
    .trim()
    .split(/\r?\n/)
    .map((l) => Number(l.split(/\s+/)[2]));
  assert.equal(fromWire.length, 150);
  assert.equal(fromInit.filter((id) => fromWire.includes(id)).length, 0, "no player is drafted twice");
  assert.equal(new Set([...fromInit, ...fromWire]).size, 160, "together they are the whole draft");
});

test("the draft order off the wire really does snake", () => {
  const { bytes } = decodeInitPayload(fixture("init-snake.txt"));
  const { records, teams } = decodeInit(bytes, { leagueId: SNAKE });
  const order = orderFromRecords(records);
  for (let round = 1; round <= 16; round++) {
    const row = [];
    for (let i = 1; i <= teams; i++) row.push(order[(round - 1) * teams + i]);
    const expected = round % 2 === 1 ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] : [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    assert.deepEqual(row, expected, "round " + round);
  }
});

test("auction blob decodes with nothing sold and a non-snake order", () => {
  const { bytes } = decodeInitPayload(fixture("init-auction.txt"));
  const r = decodeInit(bytes, { leagueId: AUCTION });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.total, 160);
  assert.equal(r.records.filter((x) => x.playerId !== null).length, 0);
  // Auction nomination order repeats rather than reversing.
  const first = r.records.slice(0, 10).map((x) => x.teamId);
  const second = r.records.slice(10, 20).map((x) => x.teamId);
  assert.deepEqual(first, second);
  assert.deepEqual(first, [9, 8, 6, 3, 1, 10, 7, 5, 2, 4]);
});

test("a league id that does not match is refused, not guessed at", () => {
  const { bytes } = decodeInitPayload(fixture("init-snake.txt"));
  const r = decodeInit(bytes, { leagueId: 12345 });
  assert.equal(r.ok, false);
});

test("corrupted payloads fail closed", () => {
  assert.equal(decodeInit(Buffer.alloc(0), { leagueId: SNAKE }).ok, false);
  assert.equal(decodeInit(Buffer.alloc(200), { leagueId: SNAKE }).ok, false);
  const { bytes } = decodeInitPayload(fixture("init-snake.txt"));
  const truncated = bytes.subarray(0, 2200); // past record 1, not past record 2
  assert.equal(decodeInit(truncated, { leagueId: SNAKE }).ok, false);
});

test("a real D/ST id is a pick, not an empty slot", () => {
  // Only exactly -1 means empty. Every D/ST has a negative id and must survive.
  const buf = Buffer.alloc(45 * 4);
  const write = (k, teamId, pick, playerId) => {
    const o = k * 45;
    buf.writeInt32BE(3, o);
    buf.writeInt32BE(SNAKE, o + 4);
    buf.writeInt32BE(teamId, o + 8);
    buf.writeInt32BE(pick, o + 12);
    buf.writeInt32BE(playerId, o + 16);
    buf.writeInt32BE(0, o + 20);
  };
  write(0, 1, 1, -16027); // Seattle D/ST
  write(1, 2, 2, -1); // genuinely empty
  write(2, 2, 3, 4362628);
  write(3, 1, 4, -1);
  const r = decodeInit(buf, { leagueId: SNAKE });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.records[0].playerId, -16027, "D/ST must not be read as empty");
  assert.equal(r.records[1].playerId, null);
});

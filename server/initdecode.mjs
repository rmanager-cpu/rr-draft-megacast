// The INIT frame carries the whole room: every pick slot, in order, with whoever
// has already been taken. It is the reason a reconnect can heal a gap exactly.
//
// Wire shape:  INIT <base64> <padding>
// The second chunk is literal '#' filler, not base64. Node's base64 decoder throws
// invalid characters away silently, so concatenating the chunks happens to work
// today and would break the day ESPN sends two real chunks. We split explicitly.
//
// Payload: a header we don't need, then `teams * rounds` fixed-width records:
//   +0  int32BE  3          record tag
//   +4  int32BE  leagueId
//   +8  int32BE  teamId     who owns this pick
//   +12 int32BE  pick       overall pick number, 1..total, strictly sequential
//   +16 int32BE  playerId   -1 when the pick has not been made
//   +20 int32BE  slot       lineup slot, 0 when not made
//
// Verified against two captured blobs (docs/SPIKE-RESULTS.md): a 10-team auction
// with nothing sold, and a 10-team snake caught 7s after round 1. In the snake
// blob the ten filled records are exactly round 1, and they do not overlap the
// 150 picks that later arrived as SELECTED frames. 10 + 150 = 160.
//
// Offsets are DISCOVERED, never hardcoded. If anything looks off we return
// { ok: false } and the caller falls back. A wrong board is worse than no board.

const TAG = 3;
const MIN_FIELDS = 24; // bytes we actually read out of each record
const EMPTY = -1; // the "not yet picked" sentinel. Note: real playerIds CAN be
// negative - every D/ST is (e.g. -16027). Only exactly -1 means empty.

/** Split an INIT frame's argument text into real payload bytes and discarded filler. */
export function decodeInitPayload(rest) {
  const chunks = String(rest).trim().split(/\s+/).filter(Boolean);
  const bufs = [];
  const padding = [];
  for (const c of chunks) {
    if (/^[A-Za-z0-9+/]+=*$/.test(c) && c.length > 64) bufs.push(Buffer.from(c, "base64"));
    else padding.push(c.length);
  }
  return { bytes: Buffer.concat(bufs), padding };
}

/**
 * Decode the room snapshot.
 * @returns {{ok:true, leagueId:number, teams:number, rounds:number, total:number,
 *            records:Array<{pick:number,teamId:number,playerId:number|null,slot:number}>}}
 *        | {ok:false, reason:string}
 */
export function decodeInit(bytes, { leagueId } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 64) return fail("payload too small");
  const i32 = (o) => bytes.readInt32BE(o);
  const fits = (o) => o >= 0 && o + MIN_FIELDS <= bytes.length;

  // Find record 1: the tag, a plausible league id, and pick number 1.
  let first = -1;
  let league = 0;
  for (let o = 0; fits(o); o++) {
    if (i32(o) !== TAG || i32(o + 12) !== 1) continue;
    const lid = i32(o + 4);
    if (lid <= 0) continue;
    if (leagueId && lid !== Number(leagueId)) continue;
    first = o;
    league = lid;
    break;
  }
  if (first < 0) return fail("no record with pick 1");

  // Find record 2 to learn the stride, rather than assuming one.
  let second = -1;
  for (let o = first + 8; fits(o); o++) {
    if (i32(o) === TAG && i32(o + 4) === league && i32(o + 12) === 2) {
      second = o;
      break;
    }
  }
  if (second < 0) return fail("no record with pick 2");
  const stride = second - first;
  if (stride < MIN_FIELDS || stride > 512) return fail("implausible stride " + stride);

  // Walk while the tag, league and pick sequence all hold.
  const records = [];
  for (let k = 0; ; k++) {
    const o = first + k * stride;
    if (!fits(o)) break;
    if (i32(o) !== TAG || i32(o + 4) !== league || i32(o + 12) !== k + 1) break;
    const playerId = i32(o + 16);
    records.push({
      pick: k + 1,
      teamId: i32(o + 8),
      playerId: playerId === EMPTY ? null : playerId,
      slot: i32(o + 20),
    });
  }
  if (records.length < 2) return fail("record array did not continue");

  const teamIds = new Set(records.map((r) => r.teamId));
  const teams = teamIds.size;
  if (teams < 2) return fail("only " + teams + " distinct team");
  if (records.length % teams !== 0) return fail(records.length + " records is not a multiple of " + teams + " teams");
  const rounds = records.length / teams;

  // Every team must own exactly one pick per round. This is the check that
  // catches a misread stride that still happens to walk cleanly.
  for (let r = 0; r < rounds; r++) {
    const row = records.slice(r * teams, (r + 1) * teams);
    if (new Set(row.map((x) => x.teamId)).size !== teams) return fail("round " + (r + 1) + " does not use each team once");
  }

  return { ok: true, leagueId: league, teams, rounds, total: records.length, records };
}

function fail(reason) {
  return { ok: false, reason };
}

/** Draft order as a pick-indexed array (index 0 unused), from decoded records. */
export function orderFromRecords(records) {
  const order = new Int32Array(records.length + 1);
  for (const r of records) order[r.pick] = r.teamId;
  return order;
}
